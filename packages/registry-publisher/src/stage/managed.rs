use std::path::Path;

use serde_json::Value;

use super::acquisition::{stage_plan_with_policy, StagingPolicy};
use super::{StageReceipt, MAX_MANAGED_BYTES};
use crate::{Downloader, PublisherError};

pub(crate) fn stage_managed(
    plan: Value,
    directory: &Path,
    downloader: &impl Downloader,
) -> Result<StageReceipt, PublisherError> {
    stage_managed_with_budget(plan, directory, downloader, MAX_MANAGED_BYTES)
}

fn stage_managed_with_budget(
    plan: Value,
    directory: &Path,
    downloader: &impl Downloader,
    max_total_bytes: u64,
) -> Result<StageReceipt, PublisherError> {
    stage_plan_with_policy(
        directory,
        plan,
        downloader,
        StagingPolicy::Managed { max_total_bytes },
    )
}

#[cfg(test)]
mod tests {
    use std::sync::Mutex;

    use serde_json::json;
    use sha2::{Digest as _, Sha256};

    use super::*;
    use crate::stage::LOCK;
    use crate::{DownloadRequest, Downloaded};

    struct FixtureDownloader {
        bytes: Vec<u8>,
        calls: Mutex<Vec<(String, u64)>>,
        dishonest: bool,
    }

    impl Downloader for FixtureDownloader {
        fn download(&self, request: DownloadRequest<'_>) -> Result<Downloaded, PublisherError> {
            self.calls
                .lock()
                .unwrap()
                .push((request.url.to_string(), request.max_bytes));
            std::fs::write(&request.output, &self.bytes).unwrap();
            Ok(Downloaded {
                sha256: request.sha256.to_string(),
                size: self.bytes.len() as u64 + u64::from(self.dishonest),
            })
        }
    }

    fn plan(bytes: &[u8]) -> Value {
        json!({
            "targets": [{
                "asset": "provider.tgz",
                "source_url": "https://author.invalid/provider.tgz",
                "destination_url": "https://registry.invalid/provider.tgz",
                "sha256": crate::hex(&Sha256::digest(bytes)),
            }]
        })
    }

    #[test]
    fn shared_source_downloads_each_managed_destination_and_preserves_plan() {
        let root = tempfile::tempdir().unwrap();
        let digest = crate::hex(&Sha256::digest(b"archive"));
        let plan = json!({"targets": [
            {"asset":"one.tgz","source_url":"shared","destination_url":"managed-one","sha256":digest},
            {"asset":"two.tgz","source_url":"shared","destination_url":"managed-two","sha256":digest}
        ]});
        let downloader = FixtureDownloader {
            bytes: b"archive".to_vec(),
            calls: Mutex::new(Vec::new()),
            dishonest: false,
        };
        let receipt = stage_managed(plan.clone(), root.path(), &downloader).unwrap();
        assert_eq!(receipt.plan, plan);
        assert_eq!(
            downloader
                .calls
                .into_inner()
                .unwrap()
                .into_iter()
                .map(|call| call.0)
                .collect::<Vec<_>>(),
            ["managed-one", "managed-two"]
        );
    }

    #[test]
    fn validates_every_retained_target_before_downloading() {
        let root = tempfile::tempdir().unwrap();
        let first = crate::hex(&Sha256::digest(b"missing"));
        let second = crate::hex(&Sha256::digest(b"expected"));
        let plan = json!({"targets": [
            {"asset":"missing.tgz","source_url":"source","destination_url":"destination","sha256":first},
            {"asset":"retained.tgz","source_url":"source","destination_url":"destination","sha256":second}
        ]});
        std::fs::write(root.path().join("retained.tgz"), b"conflict").unwrap();
        let downloader = FixtureDownloader {
            bytes: b"missing".to_vec(),
            calls: Mutex::new(Vec::new()),
            dishonest: false,
        };
        assert!(stage_managed(plan, root.path(), &downloader).is_err());
        assert!(downloader.calls.into_inner().unwrap().is_empty());
    }

    #[test]
    fn dishonest_success_is_removed_without_publishing() {
        let root = tempfile::tempdir().unwrap();
        let downloader = FixtureDownloader {
            bytes: b"archive".to_vec(),
            calls: Mutex::new(Vec::new()),
            dishonest: true,
        };
        assert!(stage_managed(plan(b"archive"), root.path(), &downloader).is_err());
        assert!(!root.path().join("provider.tgz").exists());
        let names = std::fs::read_dir(root.path())
            .unwrap()
            .map(|entry| entry.unwrap().file_name())
            .collect::<Vec<_>>();
        assert!(names.is_empty(), "left staging files: {names:?}");
    }

    #[test]
    fn retained_bytes_bound_downloads_and_fail_before_download_when_over_budget() {
        let digest = crate::hex(&Sha256::digest(b"four"));
        let input = json!({"targets": [
            {"asset":"one","source_url":"source","destination_url":"one","sha256":digest},
            {"asset":"two","source_url":"source","destination_url":"two","sha256":digest}
        ]});
        for (budget, succeeds, limits) in [(8, true, vec![4]), (7, false, vec![3])] {
            let root = tempfile::tempdir().unwrap();
            std::fs::write(root.path().join("one"), b"four").unwrap();
            let downloader = FixtureDownloader {
                bytes: b"four".to_vec(),
                calls: Mutex::new(Vec::new()),
                dishonest: false,
            };
            let result = stage_managed_with_budget(input.clone(), root.path(), &downloader, budget);
            assert_eq!(result.is_ok(), succeeds);
            assert_eq!(
                downloader
                    .calls
                    .into_inner()
                    .unwrap()
                    .into_iter()
                    .map(|call| call.1)
                    .collect::<Vec<_>>(),
                limits
            );
            assert_eq!(root.path().join("two").exists(), succeeds);
            assert!(!std::fs::read_dir(root.path()).unwrap().any(|entry| entry
                .unwrap()
                .file_name()
                .to_string_lossy()
                .ends_with(".part")));
        }
        let root = tempfile::tempdir().unwrap();
        std::fs::write(root.path().join("one"), b"four").unwrap();
        let downloader = FixtureDownloader {
            bytes: b"four".to_vec(),
            calls: Mutex::new(Vec::new()),
            dishonest: false,
        };
        assert!(stage_managed_with_budget(input, root.path(), &downloader, 3).is_err());
        assert!(downloader.calls.into_inner().unwrap().is_empty());
    }

    #[cfg(unix)]
    #[test]
    fn retained_symlink_and_foreign_lock_are_preserved() {
        use std::os::unix::fs::symlink;

        let root = tempfile::tempdir().unwrap();
        let foreign = root.path().join("foreign");
        std::fs::write(&foreign, b"archive").unwrap();
        symlink(&foreign, root.path().join("provider.tgz")).unwrap();
        let downloader = FixtureDownloader {
            bytes: b"archive".to_vec(),
            calls: Mutex::new(Vec::new()),
            dishonest: false,
        };
        assert!(stage_managed(plan(b"archive"), root.path(), &downloader).is_err());
        assert!(root.path().join("provider.tgz").is_symlink());
        assert_eq!(std::fs::read(&foreign).unwrap(), b"archive");

        std::fs::remove_file(root.path().join("provider.tgz")).unwrap();
        std::fs::write(root.path().join(LOCK), b"foreign lock").unwrap();
        assert!(stage_managed(plan(b"archive"), root.path(), &downloader).is_err());
        assert_eq!(
            std::fs::read(root.path().join(LOCK)).unwrap(),
            b"foreign lock"
        );
        assert!(downloader.calls.into_inner().unwrap().is_empty());
    }
}
