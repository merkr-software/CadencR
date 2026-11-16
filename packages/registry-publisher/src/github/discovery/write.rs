//! The write discipline every file on a discovery branch follows, shared by
//! the catalog and the revocation policies: judge the head you read, write
//! once conditionally on that exact blob, and trust only a read-back of the
//! candidate itself.
use std::time::Instant;

use super::{DiscoveryHead, Observed};
use crate::convergence::{converge, Converged, ReadBack, Verdict};
use crate::PublisherError;

/// `head` holds exactly `candidate`.
pub(crate) fn require_candidate(
    head: Option<&DiscoveryHead>,
    candidate: &[u8],
    subject: &str,
) -> Result<(), PublisherError> {
    if head.is_some_and(|head| head.bytes == candidate) {
        Ok(())
    } else {
        Err(PublisherError::new(format!(
            "{subject} does not contain the candidate"
        )))
    }
}

/// The branch still holds what was assessed; `change` names the refusal.
pub(crate) fn require_same_head(
    expected: Option<&DiscoveryHead>,
    actual: Option<&DiscoveryHead>,
    change: &str,
) -> Result<(), PublisherError> {
    if expected == actual {
        Ok(())
    } else {
        Err(PublisherError::new(change))
    }
}

/// Read until the branch shows the candidate, shows a foreign state, or stays
/// exactly at `original` (the pre-write head, absent included) for the whole
/// budget.
fn converge_head(
    candidate: &[u8],
    original: Option<&DiscoveryHead>,
    pacing: &ReadBack,
    read: &impl Fn(Instant) -> Result<Observed, PublisherError>,
) -> Result<Converged<DiscoveryHead>, PublisherError> {
    converge(pacing, read, |observed| {
        Ok(match observed {
            Observed::Unchanged => Verdict::Stale,
            Observed::Head(Some(head)) if head.bytes == candidate => Verdict::Done(head),
            Observed::Head(head) if head.as_ref() != original => Verdict::Foreign,
            Observed::Head(_) => Verdict::Stale,
        })
    })
}

/// One conditional write. The write's own response is not trusted: only an
/// authenticated read-back of the candidate itself is success.
///
/// `original` is the head the write was conditioned on. After an accepted
/// write a read that still shows `original` is replication lag and is waited
/// out; any other state is a foreign writer and is refused. After a failed or
/// lost write there is one probe: the candidate means the write landed, and
/// anything else, a failed probe included, returns the write's own error.
/// `read` is told the deadline of the convergence and which head it can skip
/// fetching.
#[bon::builder]
pub(crate) fn set_or_reconcile(
    candidate: &[u8],
    subject: &str,
    #[builder(required)] original: Option<&DiscoveryHead>,
    pacing: &ReadBack,
    set: impl FnOnce() -> Result<(), PublisherError>,
    read: impl Fn(Instant) -> Result<Observed, PublisherError>,
) -> Result<DiscoveryHead, PublisherError> {
    match set() {
        Ok(()) => match converge_head(candidate, original, pacing, &read)? {
            Converged::Done(head) => Ok(head),
            Converged::Foreign => Err(PublisherError::new(format!(
                "{subject} was written, but the discovery branch now holds neither the \
                 candidate nor the previous state; refusing to continue"
            ))),
            Converged::Stale(reads) => Err(PublisherError::new(format!(
                "{subject} write was accepted but {reads} authenticated reads over {}s \
                 still returned the stale pre-write state ({}); re-run to verify once the \
                 write is visible",
                pacing.budget.as_secs(),
                original.map_or_else(
                    || "file absent".to_owned(),
                    |head| format!("blob {}", head.sha)
                ),
            ))),
        },
        Err(primary) => match read((pacing.clock)() + pacing.budget) {
            Ok(Observed::Head(Some(winner))) if winner.bytes == candidate => Ok(winner),
            _ => Err(primary),
        },
    }
}
