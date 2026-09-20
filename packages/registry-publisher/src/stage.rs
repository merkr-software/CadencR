use crate::artifact::{artifact_from_verified, finish_target};
use crate::fs::{ensure_directory, hash_regular, remove_owned, Identity, OwnedLock};
use crate::receipt::{publish_receipt, validate_existing_receipt};
use crate::{DownloadRequest, Downloader, PublisherError, StageRequest};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest as _, Sha256};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{SystemTime, UNIX_EPOCH};
pub(crate) const RECEIPT: &str = "staging-receipt.json";
const LOCK: &str = ".stage.lock";
const MAX_TARGETS: usize = 6;
pub(crate) const MAX_ARCHIVE_BYTES: u64 = 256 * 1024 * 1024;
static NONCE: AtomicU64 = AtomicU64::new(0);
/// One immutable staged artifact.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize, Serialize)]
pub struct StageArtifact {
    pub asset: String,
    pub sha256: String,
    pub size: u64,
}
/// Immutable receipt recording the verified artifacts in a publication plan.
#[derive(Debug, Clone, PartialEq, Deserialize, Serialize)]
pub struct StageReceipt {
    pub schema_version: u64,
    pub plan: Value,
    pub artifacts: Vec<StageArtifact>,
}
#[derive(Debug, Deserialize)]
pub(crate) struct Target {
    pub(crate) asset: String,
    pub(crate) source_url: String,
    pub(crate) sha256: String,
}
pub(crate) fn stage(
    request: StageRequest<'_>,
    downloader: &impl Downloader,
) -> Result<StageReceipt, PublisherError> {
    let plan = cadencr_registry_core::create_publication_plan_from_file(
        request.submission,
        request.repository,
    )
    .map_err(|error| PublisherError::new(error.to_string()))?;
    let targets = parse_targets(&plan)?;
    ensure_directory(request.directory)?;
    let lock = OwnedLock::acquire(&request.directory.join(LOCK))?;
    let result = stage_locked(request.directory, plan, targets, downloader);
    match result {
        Ok(receipt) => {
            lock.release(None)?;
            Ok(receipt)
        }
        Err(error) => {
            lock.release(Some(error))?;
            unreachable!("release returns the primary error")
        }
    }
}
fn stage_locked(
    directory: &Path,
    plan: Value,
    targets: Vec<Target>,
    downloader: &impl Downloader,
) -> Result<StageReceipt, PublisherError> {
    validate_existing_receipt(directory, &plan)?;
    let mut artifacts = Vec::with_capacity(targets.len());
    for target in targets {
        artifacts.push(stage_target(directory, &target, downloader)?);
    }
    let receipt = StageReceipt {
        schema_version: 1,
        plan,
        artifacts,
    };
    publish_receipt(directory, &receipt)?;
    Ok(receipt)
}
fn parse_targets(plan: &Value) -> Result<Vec<Target>, PublisherError> {
    let targets = plan
        .get("targets")
        .cloned()
        .ok_or_else(|| PublisherError::new("publication plan targets are missing"))?;
    let targets: Vec<Target> = serde_json::from_value(targets)
        .map_err(|_| PublisherError::new("publication plan targets are invalid"))?;
    if targets.len() > MAX_TARGETS {
        return Err(PublisherError::new(format!(
            "publication exceeds {MAX_TARGETS} targets"
        )));
    }
    for target in &targets {
        safe_asset_name(&target.asset)?;
    }
    Ok(targets)
}
fn safe_asset_name(value: &str) -> Result<(), PublisherError> {
    if value.is_empty()
        || Path::new(value).file_name().and_then(|name| name.to_str()) != Some(value)
        || matches!(value, "." | "..")
    {
        return Err(PublisherError::new(
            "publication target asset path is unsafe",
        ));
    }
    Ok(())
}
fn stage_target(
    directory: &Path,
    target: &Target,
    downloader: &impl Downloader,
) -> Result<StageArtifact, PublisherError> {
    let final_path = directory.join(&target.asset);
    match std::fs::symlink_metadata(&final_path) {
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
        Err(error) => return Err(PublisherError::io("inspect existing asset", error)),
        Ok(_) => {
            return artifact_from_verified(
                target,
                hash_regular(&final_path, MAX_ARCHIVE_BYTES, "existing asset")?,
            )
        }
    }
    let partial = partial_path(directory, &target.asset);
    let downloaded = downloader.download(DownloadRequest {
        url: &target.source_url,
        sha256: &target.sha256,
        output: partial.clone(),
        max_bytes: MAX_ARCHIVE_BYTES,
    })?;
    let identity = Identity::from_metadata(
        &std::fs::symlink_metadata(&partial)
            .map_err(|error| PublisherError::io("inspect downloaded asset", error))?,
    );
    let result = finish_target(target, &partial, identity, &final_path, downloaded);
    let cleanup = remove_owned(&partial, identity);
    match (result, cleanup) {
        (Ok(artifact), Ok(())) => Ok(artifact),
        (Ok(_), Err(error)) if error.kind() == std::io::ErrorKind::NotFound => {
            Err(PublisherError::new("owned staging partial disappeared"))
        }
        (Ok(_), Err(error)) => Err(PublisherError::io("remove staging partial", error)),
        (Err(primary), Ok(())) => Err(primary),
        (Err(primary), Err(error)) if error.kind() == std::io::ErrorKind::NotFound => Err(primary),
        (Err(primary), Err(_)) => Err(PublisherError::cleanup(primary, 1)),
    }
}

pub(crate) fn partial_path(directory: &Path, name: &str) -> PathBuf {
    let sequence = NONCE.fetch_add(1, Ordering::Relaxed);
    let time = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_nanos();
    let digest = Sha256::digest(format!("{}:{sequence}:{time}", std::process::id()));
    directory.join(format!(".{name}.{}.part", &crate::hex(&digest)[..24]))
}
#[cfg(test)]
mod tests {
    use super::*;
    use crate::{DownloadRequest, Downloaded};
    use serde_json::json;
    use std::collections::HashMap;
    use std::process::Command;
    use std::sync::Mutex;
    use tempfile::TempDir;
    struct FixtureDownloader {
        bodies: HashMap<String, Vec<u8>>,
        calls: Mutex<Vec<String>>,
        fail_at: Option<usize>,
    }
    impl Downloader for FixtureDownloader {
        fn download(&self, request: DownloadRequest<'_>) -> Result<Downloaded, PublisherError> {
            let mut calls = self.calls.lock().unwrap();
            calls.push(request.sha256.to_string());
            if self.fail_at == Some(calls.len()) {
                return Err(PublisherError::new("injected download failure"));
            }
            let bytes = self.bodies.get(request.sha256).unwrap();
            std::fs::write(&request.output, bytes).unwrap();
            Ok(Downloaded {
                sha256: request.sha256.to_string(),
                size: bytes.len() as u64,
            })
        }
    }
    fn fixture(contents: &[&[u8]]) -> (TempDir, PathBuf, FixtureDownloader) {
        let root = tempfile::tempdir().unwrap();
        let repository = "https://github.com/acme/provider";
        let names = ["darwin-aarch64", "linux-x86_64"];
        let mut bodies = HashMap::new();
        let binary = contents
            .iter()
            .enumerate()
            .map(|(index, bytes)| {
                let digest = crate::hex(&Sha256::digest(bytes));
                bodies.insert(digest.clone(), bytes.to_vec());
                (
                    names[index].to_string(),
                    json!({
                        "archive": format!("{repository}/releases/download/v1/a{index}.tgz"),
                        "cmd": "bin/provider",
                        "sha256": digest,
                    }),
                )
            })
            .collect::<serde_json::Map<_, _>>();
        let submission = json!({
            "schema_version": 1,
            "package": {
                "agent": {
                    "id": "acme-agent", "name": "Acme", "version": "1.0.0",
                    "description": "Agent", "license": "MIT", "repository": repository,
                    "distribution": { "binary": binary },
                },
                "host": {
                    "publisher": "acme",
                    "compatibility": { "min_app_version": "0.12.0" },
                    "assets": { "icon": "icon.svg", "readme": "README.md", "license": "LICENSE" },
                },
            },
            "source": { "repository": repository, "commit": "a".repeat(40), "tag": "v1" },
            "changelog": "Release",
        });
        let input = root.path().join("submission.json");
        std::fs::write(&input, serde_json::to_vec(&submission).unwrap()).unwrap();
        (
            root,
            input,
            FixtureDownloader {
                bodies,
                calls: Mutex::new(Vec::new()),
                fail_at: None,
            },
        )
    }

    fn request<'a>(input: &'a Path, output: &'a Path) -> StageRequest<'a> {
        StageRequest::builder()
            .submission(input)
            .repository("cadencr/registry")
            .directory(output)
            .build()
    }

    #[test]
    fn stages_replays_and_matches_javascript_receipt_bytes() {
        let (root, input, downloader) = fixture(&[b"one", b"two"]);
        let output = root.path().join("rust");
        let first = stage(request(&input, &output), &downloader).unwrap();
        assert_eq!(first.artifacts.len(), 2);
        assert_eq!(downloader.calls.lock().unwrap().len(), 2);
        stage(
            request(&input, &output),
            &FixtureDownloader {
                bodies: HashMap::new(),
                calls: Mutex::new(Vec::new()),
                fail_at: Some(1),
            },
        )
        .unwrap();

        let js_output = root.path().join("javascript");
        let script = format!(
            "import fs from 'node:fs/promises'; import {{stagePublication}} from '{}';\
             const s=JSON.parse(await fs.readFile(process.argv[1]));\
             await stagePublication(s,'cadencr/registry',process.argv[2],{{download:async(o)=>{{\
             const b=new Map([['{}','one'],['{}','two']]).get(o.sha256);\
             await fs.writeFile(o.outputPath,b,{{flag:'wx',mode:0o600}});\
             return {{sha256:o.sha256,size:Buffer.byteLength(b)}};}}}});",
            Path::new(env!("CARGO_MANIFEST_DIR"))
                .join("../../tooling/marketplace-registry/scripts/publication/stage.mjs")
                .display(),
            crate::hex(&Sha256::digest(b"one")),
            crate::hex(&Sha256::digest(b"two")),
        );
        let status = Command::new("node")
            .args(["--input-type=module", "-e", &script])
            .arg(&input)
            .arg(&js_output)
            .status()
            .expect("Node is required for the JavaScript staging oracle");
        assert!(status.success());
        assert_eq!(
            std::fs::read(output.join(RECEIPT)).unwrap(),
            std::fs::read(js_output.join(RECEIPT)).unwrap()
        );
    }

    #[test]
    fn resumes_only_missing_target_and_preserves_foreign_lock() {
        let (root, input, mut downloader) = fixture(&[b"one", b"two"]);
        let output = root.path().join("stage");
        downloader.fail_at = Some(2);
        assert!(stage(request(&input, &output), &downloader).is_err());
        downloader.fail_at = None;
        stage(request(&input, &output), &downloader).unwrap();
        assert_eq!(downloader.calls.lock().unwrap().len(), 3);

        std::fs::write(output.join(LOCK), "foreign").unwrap();
        assert!(stage(request(&input, &output), &downloader)
            .unwrap_err()
            .to_string()
            .contains("already locked"));
        assert_eq!(
            std::fs::read_to_string(output.join(LOCK)).unwrap(),
            "foreign"
        );
    }

    #[test]
    fn partial_inode_replacement_never_publishes_or_deletes_foreign_bytes() {
        let root = tempfile::tempdir().unwrap();
        let partial = root.path().join("partial");
        let final_path = root.path().join("asset");
        std::fs::write(&partial, b"one").unwrap();
        let identity = Identity::from_metadata(&std::fs::symlink_metadata(&partial).unwrap());
        std::fs::remove_file(&partial).unwrap();
        std::fs::write(&partial, b"foreign").unwrap();
        let digest = crate::hex(&Sha256::digest(b"one"));
        let target = Target {
            asset: "asset".into(),
            source_url: "unused".into(),
            sha256: digest.clone(),
        };
        let downloaded = crate::Downloaded {
            sha256: digest,
            size: 3,
        };
        assert!(finish_target(&target, &partial, identity, &final_path, downloaded).is_err());
        assert!(!final_path.exists());
        assert_eq!(std::fs::read(&partial).unwrap(), b"foreign");
    }
}
