use std::path::Path;

use crate::github::discovery::DiscoveryClient;
use crate::github::ReleaseClient;
use crate::mirror::artifacts::{combine_cleanup, OwnedDirectory};
use crate::{DownloadRequest, Downloader, PublisherError};

pub(super) fn validate_remote_catalog(
    client: &(impl DiscoveryClient + ReleaseClient),
    snapshot: &cadencr_registry_core::CatalogSnapshot,
    release_id: u64,
) -> Result<(), PublisherError> {
    let release = client
        .find_release(snapshot.tag())?
        .ok_or_else(|| PublisherError::new("catalog release is missing"))?;
    crate::catalog_publish::validate_release(&release, snapshot, Some(release_id), Some(false))?;
    crate::promote::verify_exact_tag(
        client,
        snapshot.tag(),
        snapshot.registry_commit(),
        "before discovery advancement",
    )?;
    crate::mirror::artifacts::validated_named_asset(
        client.list_assets(release_id)?,
        crate::catalog_publish::ASSET,
        snapshot.size() as u64,
        snapshot.expected_url(),
    )?;
    Ok(())
}

pub(super) fn verify_public_catalog(
    snapshot: &cadencr_registry_core::CatalogSnapshot,
    directory: &Path,
    downloader: &impl Downloader,
) -> Result<(), PublisherError> {
    verify_download(
        snapshot.expected_url(),
        snapshot.sha256(),
        snapshot.size() as u64,
        directory,
        ".discovery-catalog-",
        downloader,
        "public catalog",
    )
}

#[bon::builder]
pub(super) fn verify_raw(
    snapshot: &cadencr_registry_core::CatalogSnapshot,
    branch: &str,
    directory: &Path,
    downloader: &impl crate::download::DiscoveryReader,
    revalidate: &impl Fn(std::time::Instant) -> Result<(), PublisherError>,
    pacing: &crate::convergence::ReadBack,
) -> Result<(), PublisherError> {
    let url = cadencr_registry_core::discovery_url(snapshot.repository(), branch)?;
    crate::public_read::verify_public_object()
        .url(&url)
        .file_name(cadencr_registry_core::DISCOVERY_FILENAME)
        .sha256(snapshot.sha256())
        .size(snapshot.size() as u64)
        .max_bytes(cadencr_registry_core::MAX_DISCOVERY_BYTES as u64)
        .maybe_previous_sha256(snapshot.previous_sha256())
        .directory(directory)
        .downloader(downloader)
        .revalidate(revalidate)
        .pacing(pacing)
        .call()
}
fn verify_download(
    url: &str,
    sha256: &str,
    size: u64,
    directory: &Path,
    prefix: &str,
    downloader: &impl Downloader,
    label: &str,
) -> Result<(), PublisherError> {
    let temporary = OwnedDirectory::create(directory, prefix)?;
    let result = downloader
        .download(DownloadRequest {
            url,
            sha256,
            output: temporary
                .path()
                .join(cadencr_registry_core::DISCOVERY_FILENAME),
            max_bytes: size,
        })
        .and_then(|actual| {
            if actual.size == size && actual.sha256 == sha256 {
                Ok(())
            } else {
                Err(PublisherError::new(format!(
                    "{label} size or digest does not match"
                )))
            }
        });
    combine_cleanup(result, temporary.remove())
}
#[cfg(test)]
mod tests {
    use std::cell::Cell;
    use std::time::{Duration, Instant};

    use super::*;
    use crate::download::{DiscoveryObservation, DiscoveryReader};

    struct Reader<'a> {
        bytes: &'a [u8],
        calls: Cell<usize>,
        delay: Duration,
        replace_directory: bool,
    }
    impl DiscoveryReader for Reader<'_> {
        fn observe(
            &self,
            request: DownloadRequest<'_>,
            previous: Option<&str>,
            remaining: Duration,
        ) -> Result<DiscoveryObservation, PublisherError> {
            use sha2::{Digest as _, Sha256};
            self.calls.set(self.calls.get() + 1);
            assert!(!remaining.is_zero());
            assert!(remaining <= Duration::from_secs(1));
            std::thread::sleep(self.delay);
            if self.replace_directory {
                let parent = request.output.parent().unwrap();
                std::fs::rename(parent, parent.with_extension("displaced")).unwrap();
                std::fs::create_dir(parent).unwrap();
            }
            std::fs::write(&request.output, self.bytes).unwrap();
            crate::download::discovery::classify(
                crate::Downloaded {
                    sha256: crate::hex(&Sha256::digest(self.bytes)),
                    size: self.bytes.len() as u64,
                },
                Some(self.bytes.len() as u64),
                request.sha256,
                previous,
            )
        }
    }

    #[test]
    fn deadline_covers_backoff_guard_and_body_and_cleanup_failure_is_terminal() {
        let (value, _) = super::super::fixture::setup_baseline();
        let previous = std::fs::read(value.directory.join("previous.json")).unwrap();
        for mode in ["zero", "body", "guard", "persistent", "cleanup"] {
            let reader = Reader {
                bytes: if mode == "body" {
                    value.snapshot.canonical_envelope()
                } else {
                    &previous
                },
                calls: Cell::new(0),
                delay: if mode == "body" {
                    Duration::from_millis(400)
                } else {
                    Duration::ZERO
                },
                replace_directory: mode == "cleanup",
            };
            let guards = Cell::new(0);
            let guard = |_deadline: Instant| {
                guards.set(guards.get() + 1);
                if mode == "guard" {
                    std::thread::sleep(Duration::from_millis(400));
                }
                Ok(())
            };
            // Only the guard mode leaves room for a second read; in every
            // other mode the pause outlasts the budget and nothing is waited.
            let pacing = crate::convergence::ReadBack::builder()
                .budget(if mode == "zero" {
                    Duration::ZERO
                } else {
                    Duration::from_millis(250)
                })
                .pause(Duration::from_millis(if mode == "guard" {
                    10
                } else {
                    300
                }))
                .attempts(24)
                .clock(Instant::now)
                .wait(|_| {})
                .build();
            let started = Instant::now();
            let result = verify_raw()
                .snapshot(&value.snapshot)
                .branch("main")
                .directory(&value.directory)
                .downloader(&reader)
                .revalidate(&guard)
                .pacing(&pacing)
                .call();
            assert!(result.is_err(), "{mode}");
            if mode == "persistent" {
                assert_eq!(
                    result.unwrap_err().to_string(),
                    "public discovery: convergence read budget exhausted"
                );
            } else if mode == "cleanup" {
                assert!(result.unwrap_err().to_string().contains("identity changed"));
            }
            assert_eq!(reader.calls.get(), usize::from(mode != "zero"), "{mode}");
            assert_eq!(guards.get(), usize::from(mode == "guard"), "{mode}");
            assert!(started.elapsed() < Duration::from_secs(2));
            if mode != "cleanup" {
                assert!(!std::fs::read_dir(&value.directory)
                    .unwrap()
                    .any(|entry| entry
                        .unwrap()
                        .file_name()
                        .to_string_lossy()
                        .starts_with(".discovery-public-")));
            }
        }
    }
    #[test]
    fn stale_previous_raw_converges_to_candidate_without_second_cas() {
        use super::super::fixture::Sequence;
        let (value, _) = super::super::fixture::setup_baseline();
        let previous = std::fs::read(value.directory.join("previous.json")).unwrap();
        value.client.set_discovery_head(previous.clone());
        let raw = Sequence {
            bodies: [
                vec![previous.clone(); 6],
                vec![value.snapshot.canonical_envelope().into()],
            ]
            .concat(),
            calls: Cell::new(0),
        };
        let first = super::super::lifecycle::advance_with(
            &value.snapshot,
            &value.manifest,
            &value.directory,
            "main",
            &value.client,
            &value.downloader,
            &raw,
        )
        .unwrap();
        assert_eq!(raw.calls.get(), 7);
        assert_eq!(value.client.discovery_counts().1, 1);
        let receipt_bytes =
            std::fs::read(value.directory.join(super::super::receipt::RECEIPT)).unwrap();
        raw.calls.set(0);
        let replay = super::super::lifecycle::advance_with(
            &value.snapshot,
            &value.manifest,
            &value.directory,
            "main",
            &value.client,
            &value.downloader,
            &raw,
        )
        .unwrap();
        assert_eq!(first, replay);
        assert_eq!(raw.calls.get(), 7);
        assert_eq!(value.client.discovery_counts().1, 1);
        assert_eq!(
            std::fs::read(value.directory.join(super::super::receipt::RECEIPT)).unwrap(),
            receipt_bytes
        );
    }

    #[test]
    fn the_raw_read_back_outwaits_a_five_minute_cdn_cache_then_fails_closed() {
        use super::super::fixture::Sequence;
        for (stale, converges) in [(40, true), (1000, false)] {
            let (value, _) = super::super::fixture::setup_baseline();
            let previous = std::fs::read(value.directory.join("previous.json")).unwrap();
            value.client.set_discovery_head(previous.clone());
            let mut bodies = vec![previous; stale];
            bodies.push(value.snapshot.canonical_envelope().into());
            let raw = Sequence {
                bodies,
                calls: Cell::new(0),
            };
            let result = super::super::lifecycle::advance_with(
                &value.snapshot,
                &value.manifest,
                &value.directory,
                "main",
                &value.client,
                &value.downloader,
                &raw,
            );
            if converges {
                result.unwrap();
                assert_eq!(raw.calls.get(), 41);
            } else {
                assert_eq!(
                    result.unwrap_err().to_string(),
                    "public discovery: convergence read budget exhausted"
                );
                assert_eq!(raw.calls.get(), 45, "the public attempt cap");
                assert!(!value
                    .directory
                    .join(super::super::receipt::RECEIPT)
                    .exists());
            }
            assert_eq!(value.client.discovery_counts().1, 1);
        }
    }

    #[test]
    fn only_previous_bytes_can_delay_verification_and_never_skip_guards() {
        use super::super::fixture::Sequence;
        for mode in "tamper bootstrap drift late_drift expiry expiry_after".split_whitespace() {
            let (value, _) = if mode == "bootstrap" {
                super::super::fixture::setup()
            } else {
                super::super::fixture::setup_baseline()
            };
            let previous = if mode == "bootstrap" {
                b"unknown".to_vec()
            } else {
                std::fs::read(value.directory.join("previous.json")).unwrap()
            };
            if mode != "bootstrap" {
                value.client.set_discovery_head(previous.clone());
            }
            if mode == "drift" || mode == "late_drift" {
                value
                    .client
                    .drift_discovery_at(if mode == "late_drift" { 8 } else { 4 });
            }
            let first = if mode == "tamper" {
                b"tampered".to_vec()
            } else {
                previous
            };
            let mut bodies = vec![first; if mode == "late_drift" { 6 } else { 1 }];
            bodies.push(value.snapshot.canonical_envelope().into());
            let raw = Sequence {
                bodies,
                calls: Cell::new(0),
            };
            let fresh_calls = Cell::new(0);
            let fresh = || {
                fresh_calls.set(fresh_calls.get() + 1);
                if (mode == "expiry" && fresh_calls.get() == 3)
                    || (mode == "expiry_after" && fresh_calls.get() == 4)
                {
                    Err(PublisherError::new("expired"))
                } else {
                    Ok(())
                }
            };
            assert!(
                super::super::lifecycle::advance_with_freshness()
                    .snapshot(&value.snapshot)
                    .manifest(&value.manifest)
                    .directory(&value.directory)
                    .branch("main")
                    .client(&value.client)
                    .catalog_downloader(&value.downloader)
                    .discovery_downloader(&raw)
                    .freshness(&fresh)
                    .pacing(&crate::convergence::ReadBack::production())
                    .public_pacing(&crate::convergence::VirtualClock::new().public_read_back())
                    .call()
                    .is_err(),
                "{mode}"
            );
            assert_eq!(
                raw.calls.get(),
                if mode == "late_drift" { 5 } else { 1 },
                "{mode}"
            );
            assert_eq!(value.client.discovery_counts().1, 1);
            assert!(!value
                .directory
                .join(super::super::receipt::RECEIPT)
                .exists());
            assert!(!std::fs::read_dir(&value.directory)
                .unwrap()
                .any(|entry| entry
                    .unwrap()
                    .file_name()
                    .to_string_lossy()
                    .starts_with(".discovery-public-")));
        }
    }
}
