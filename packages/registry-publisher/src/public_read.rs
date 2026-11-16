//! Public read-back of an object just written to a discovery branch, with the
//! bounded convergence rule shared by the catalog and the revocation policies.
use std::cell::Cell;
use std::path::Path;
use std::time::Instant;

use crate::convergence::{converge, Converged, ReadBack, Verdict};
use crate::download::{DiscoveryObservation, DiscoveryReader};
use crate::mirror::artifacts::{combine_cleanup, OwnedDirectory};
use crate::{DownloadRequest, PublisherError};

/// Read `url` until it serves exactly the candidate (`sha256`, `size`), taking
/// at most `max_bytes` of any body.
///
/// Raw CDN caches may keep serving the previous body for a while after the
/// write, so exactly the authenticated previous body (`previous_sha256`) is
/// retried within `pacing` until the budget ends; any other body is terminal.
/// Before each retry `revalidate` re-checks that the write is still the
/// authoritative state, so convergence can never mask a concurrent change or
/// an expiry.
#[bon::builder]
pub(crate) fn verify_public_object(
    url: &str,
    file_name: &str,
    sha256: &str,
    size: u64,
    max_bytes: u64,
    previous_sha256: Option<&str>,
    directory: &Path,
    downloader: &impl DiscoveryReader,
    revalidate: &impl Fn(Instant) -> Result<(), PublisherError>,
    pacing: &ReadBack,
) -> Result<(), PublisherError> {
    let reads = Cell::new(0_u32);
    let observe = |deadline: Instant| {
        if reads.replace(reads.get() + 1) > 0 {
            revalidate(deadline)?;
        }
        let remaining = deadline.saturating_duration_since((pacing.clock)());
        if remaining.is_zero() {
            return Err(exhausted());
        }
        let temporary = OwnedDirectory::create(directory, ".discovery-public-")?;
        let observed = downloader.observe(
            DownloadRequest {
                url,
                sha256,
                output: temporary.path().join(file_name),
                max_bytes,
            },
            previous_sha256,
            remaining,
        );
        let observed = combine_cleanup(observed, temporary.remove())?;
        if (pacing.clock)() >= deadline {
            return Err(exhausted());
        }
        Ok(observed)
    };
    let judge = |observed| match observed {
        DiscoveryObservation::Candidate(actual)
            if actual.size == size && actual.sha256 == sha256 =>
        {
            Ok(Verdict::Done(()))
        }
        DiscoveryObservation::Previous if previous_sha256.is_some() => Ok(Verdict::Stale),
        _ => Err(PublisherError::new(
            "public discovery: candidate size or digest does not match",
        )),
    };
    match converge(pacing, observe, judge)? {
        Converged::Done(()) => Ok(()),
        Converged::Stale(_) | Converged::Foreign => Err(exhausted()),
    }
}

fn exhausted() -> PublisherError {
    PublisherError::new("public discovery: convergence read budget exhausted")
}
