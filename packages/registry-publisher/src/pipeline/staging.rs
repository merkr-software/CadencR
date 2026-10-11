use super::{PipelineClient, PreparedPipeline};
use crate::{DownloadRequest, Downloaded, Downloader, PublisherError};
use std::cell::Cell;

pub(super) fn stage_all(
    prepared: &PreparedPipeline,
    client: &impl PipelineClient,
    downloader: &impl Downloader,
) -> Result<Vec<bool>, PublisherError> {
    let mut published = Vec::new();
    // Determine every baseline's public state before any source acquisition.
    for entry in &prepared.entries {
        let release = client.find_release(entry.tag())?;
        let public = release.as_ref().is_some_and(|release| !release.draft);
        let binding = crate::binding::build_publication_prebinding(
            &entry.plan,
            &prepared.request.repository,
            &entry.registry_commit,
        )?;
        let prior = crate::recover::local::prebound_receipts(
            &entry.directory,
            &binding,
            &prepared.request.repository,
            &entry.registry_commit,
        )?;
        let historical = prior
            .mirror
            .as_ref()
            .is_some_and(|receipt| receipt.status == "published_recovered")
            || super::state::exists(&entry.directory.join(crate::binding::PUBLICATION_RECEIPT))?;
        if (entry.require_published || historical) && !public {
            return Err(PublisherError::new(
                "verified baseline publication is missing or draft",
            ));
        }
        if let Some(release) = release.filter(|_| public) {
            let binding = crate::binding::build_publication_prebinding(
                &entry.plan,
                &prepared.request.repository,
                &entry.registry_commit,
            )?;
            crate::mirror::release::validate_bound_release(
                &release,
                entry.tag(),
                &entry.registry_commit,
                &binding.body,
            )?;
            crate::promote::verify_exact_tag(
                client,
                entry.tag(),
                &entry.registry_commit,
                "before managed restoration",
            )?;
        }
        published.push(public);
    }
    let retained = retained_bytes(prepared)?;
    let remaining = Cell::new(crate::stage::MAX_MANAGED_BYTES - retained);
    for (entry, public) in prepared.entries.iter().zip(&published) {
        let bounded = Budget {
            inner: downloader,
            remaining: &remaining,
            directory: &entry.directory,
        };
        if *public {
            let submission = entry.submission_file();
            let request = crate::RestoreRequest::builder()
                .submission(&submission)
                .repository(&prepared.request.repository)
                .registry_commit(&entry.registry_commit)
                .expected_release_tag(entry.tag())
                .directory(&entry.directory)
                .token("")
                .build();
            let local = crate::restore::preflight(&request)?;
            crate::restore::restore(request, local, client, &bounded)?;
        } else {
            crate::stage::stage_loaded(
                &entry.submission,
                &prepared.request.repository,
                &entry.directory,
                &bounded,
            )?;
        }
        // Restoration also independently reads public proof. The retention
        // limit is specifically archive staging, not cumulative verification I/O.
        let actual = retained_bytes(prepared)?;
        remaining.set(crate::stage::MAX_MANAGED_BYTES - actual);
    }
    Ok(published)
}

pub(super) fn retained_bytes(prepared: &PreparedPipeline) -> Result<u64, PublisherError> {
    let mut total = 0_u64;
    for entry in &prepared.entries {
        for target in entry.plan["targets"].as_array().expect("validated targets") {
            let name = target["asset"].as_str().expect("validated asset");
            let path = entry.directory.join(name);
            if !super::state::exists(&path)? {
                continue;
            }
            let metadata = std::fs::symlink_metadata(&path)
                .map_err(|e| PublisherError::io("inspect retained archive", e))?;
            if metadata.file_type().is_symlink()
                || !metadata.is_file()
                || metadata.len() > crate::stage::MAX_ARCHIVE_BYTES
            {
                return Err(PublisherError::new(
                    "pipeline retained archive must be a bounded regular file",
                ));
            }
            total = total
                .checked_add(metadata.len())
                .ok_or_else(|| PublisherError::new("pipeline staging budget overflow"))?;
            if total > crate::stage::MAX_MANAGED_BYTES {
                return Err(PublisherError::new("pipeline archives exceed 1 GiB"));
            }
        }
    }
    Ok(total)
}

struct Budget<'a, D> {
    inner: &'a D,
    remaining: &'a Cell<u64>,
    directory: &'a std::path::Path,
}
impl<D: Downloader> Downloader for Budget<'_, D> {
    fn download(&self, mut request: DownloadRequest<'_>) -> Result<Downloaded, PublisherError> {
        // Only retained archives consume staging capacity. Plan/public-proof
        // verification uses separately bounded operations and transient files.
        let archive = request.output.parent() == Some(self.directory)
            && request
                .output
                .extension()
                .is_some_and(|extension| extension == "part");
        if archive {
            request.max_bytes = request.max_bytes.min(self.remaining.get());
        }
        let limit = request.max_bytes;
        let value = self.inner.download(request)?;
        if value.size > limit {
            return Err(PublisherError::new(
                "pipeline source exceeds remaining staging budget",
            ));
        }
        if archive {
            self.remaining.set(self.remaining.get() - value.size);
        }
        Ok(value)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    struct Download {
        limit: Cell<u64>,
        size: u64,
    }
    impl Downloader for Download {
        fn download(&self, request: DownloadRequest<'_>) -> Result<Downloaded, PublisherError> {
            self.limit.set(request.max_bytes);
            Ok(Downloaded {
                size: self.size,
                sha256: "a".repeat(64),
            })
        }
    }
    #[test]
    fn shared_archive_cap_accepts_exact_limit_rejects_overrun_and_does_not_charge_proof_reads() {
        let remaining = Cell::new(5);
        let inner = Download {
            limit: Cell::new(0),
            size: 5,
        };
        let directory = std::path::Path::new("/stage");
        let budget = Budget {
            inner: &inner,
            remaining: &remaining,
            directory,
        };
        let request = || DownloadRequest {
            url: "https://github.com/acme/archive",
            sha256: "a",
            output: directory.join(".archive.nonce.part"),
            max_bytes: 256 * 1024 * 1024,
        };
        budget.download(request()).unwrap();
        assert_eq!(inner.limit.get(), 5);
        assert_eq!(remaining.get(), 0);
        assert!(budget.download(request()).is_err());
        assert_eq!(inner.limit.get(), 0);
        let proof = DownloadRequest {
            output: directory.join("temporary/proof"),
            max_bytes: 5,
            ..request()
        };
        budget.download(proof).unwrap();
        assert_eq!(remaining.get(), 0);
    }
}
