use crate::{Downloader, PublisherError, StageRequest};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest as _, Sha256};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{SystemTime, UNIX_EPOCH};
mod acquisition;
mod managed;
pub(crate) use managed::stage_managed;
pub(crate) const RECEIPT: &str = "staging-receipt.json";
const LOCK: &str = ".stage.lock";
const MAX_TARGETS: usize = 6;
pub(crate) const MAX_ARCHIVE_BYTES: u64 = 256 * 1024 * 1024;
pub(crate) const MAX_MANAGED_BYTES: u64 = 1024 * 1024 * 1024;
static NONCE: AtomicU64 = AtomicU64::new(0);
/// One immutable staged artifact.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct StageArtifact {
    pub asset: String,
    pub sha256: String,
    pub size: u64,
}
/// Immutable receipt recording the verified artifacts in a publication plan.
#[derive(Debug, Clone, PartialEq, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct StageReceipt {
    pub schema_version: u64,
    pub plan: Value,
    pub artifacts: Vec<StageArtifact>,
}
#[derive(Debug, Deserialize)]
pub(crate) struct Target {
    /// `tab`, `theme`, `backend-<platform>`, or a provider platform.
    #[serde(default)]
    pub(crate) target: String,
    pub(crate) asset: String,
    pub(crate) source_url: String,
    pub(crate) destination_url: String,
    pub(crate) sha256: String,
}
pub(crate) fn stage(
    request: StageRequest<'_>,
    downloader: &impl Downloader,
) -> Result<StageReceipt, PublisherError> {
    let plan = cadencr_registry_core::create_publication_plan_from_file(
        request.submission,
        request.repository,
    )?;
    stage_plan(request.directory, plan, downloader)
}

pub(crate) fn stage_loaded(
    submission: &Value,
    repository: &str,
    directory: &Path,
    downloader: &impl Downloader,
) -> Result<StageReceipt, PublisherError> {
    let plan = cadencr_registry_core::create_publication_plan(submission, repository)?;
    stage_plan(directory, plan, downloader)
}

fn stage_plan(
    directory: &Path,
    plan: Value,
    downloader: &impl Downloader,
) -> Result<StageReceipt, PublisherError> {
    acquisition::stage_plan_with_policy(
        directory,
        plan,
        downloader,
        acquisition::StagingPolicy::Source,
    )
}

fn parse_targets(plan: &Value) -> Result<Vec<Target>, PublisherError> {
    let targets = plan
        .get("targets")
        .cloned()
        .ok_or_else(|| PublisherError::new("publication plan targets are missing"))?;
    let targets: Vec<Target> = serde_json::from_value(targets)
        .map_err(|_| PublisherError::new("publication plan targets are invalid"))?;
    // A plugin release carries each member's targets.
    let maximum = if plan
        .pointer("/mirrored_package/kind")
        .and_then(Value::as_str)
        == Some(cadencr_registry_core::PLUGIN_KIND)
    {
        MAX_TARGETS * cadencr_registry_core::MAX_PLUGIN_MEMBERS
    } else {
        MAX_TARGETS
    };
    if targets.len() > maximum {
        return Err(PublisherError::new(format!(
            "publication exceeds {maximum} targets"
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
    use crate::artifact::finish_target;
    use crate::fs::Identity;
    use crate::{DownloadRequest, Downloaded};
    use serde_json::json;
    use std::collections::HashMap;
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
        assert_eq!(
            serde_json::from_slice::<serde_json::Value>(&std::fs::read(&input).unwrap()).unwrap(),
            serde_json::from_str::<serde_json::Value>(include_str!(
                "../tests/fixtures/legacy-v1/stage-submission.json"
            ))
            .unwrap()
        );
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

        assert_eq!(
            std::fs::read(output.join(RECEIPT)).unwrap(),
            include_bytes!("../tests/fixtures/legacy-v1/stage-receipt.json")
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
            target: "asset".into(),
            asset: "asset".into(),
            source_url: "unused".into(),
            destination_url: "unused".into(),
            sha256: digest.clone(),
        };
        let downloaded = crate::Downloaded {
            sha256: digest,
            size: 3,
        };
        assert!(finish_target(
            &target,
            &partial,
            identity,
            &final_path,
            downloaded,
            MAX_ARCHIVE_BYTES,
        )
        .is_err());
        assert!(!final_path.exists());
        assert_eq!(std::fs::read(&partial).unwrap(), b"foreign");
    }
    #[test]
    fn plugin_publication_verifies_each_member_archive_by_its_kind() {
        let root = tempfile::tempdir().unwrap();
        let tab = root.path().join("tab");
        std::fs::create_dir_all(tab.join("dist")).unwrap();
        std::fs::write(tab.join("tab.json"),r#"{"schema_version":1,"kind":"tab","id":"aurora-tab","name":"Aurora","version":"1.0.0","api_version":1,"entry":"dist/index.html"}"#).unwrap();
        std::fs::write(tab.join("dist/index.html"), "<html>Aurora</html>").unwrap();
        let theme = root.path().join("theme");
        std::fs::create_dir_all(&theme).unwrap();
        std::fs::write(
            theme.join("theme.json"),
            include_str!("../../../plugins/themes/ember/theme.json"),
        )
        .unwrap();
        let packed_tab = cadencr_registry_core::pack_tab(
            cadencr_registry_core::PackTabRequest::builder()
                .directory(&tab)
                .output(&root.path().join("tab.tar.gz"))
                .build(),
        )
        .unwrap();
        let packed_theme =
            cadencr_registry_core::pack_theme(cadencr_registry_core::PackThemeRequest {
                directory: &theme,
                output: &root.path().join("theme.tar.gz"),
            })
            .unwrap();
        let downloader = FixtureDownloader {
            bodies: HashMap::from([
                (
                    packed_tab.sha256.clone(),
                    std::fs::read(&packed_tab.archive).unwrap(),
                ),
                (
                    packed_theme.sha256.clone(),
                    std::fs::read(&packed_theme.archive).unwrap(),
                ),
            ]),
            calls: Mutex::new(Vec::new()),
            fail_at: None,
        };
        let repository = "https://github.com/acme/aurora";
        let release = format!("{repository}/releases/download/v1.0.0");
        let host = json!({"publisher":"acme","compatibility":{"min_app_version":"0.1.0"}});
        let tab_member = json!({"kind":"tab","package":{"tab":{"id":"aurora-tab","name":"Aurora","description":"Tab","version":"1.0.0","api_version":1,"license":"MIT","repository":repository,"distribution":{"archive":format!("{release}/tab.tar.gz"),"sha256":packed_tab.sha256}},"host":host}});
        let theme_member = json!({"kind":"theme","package":{"theme":{"id":"aurora-theme","name":"Aurora","description":"Theme","version":"1.0.0","document_version":1,"license":"MIT","repository":repository,"distribution":{"archive":format!("{release}/theme.tar.gz"),"sha256":packed_theme.sha256}},"host":host}});
        let mut submission = json!({"schema_version":2,"package":{"kind":"plugin","package":{
            "plugin":{"id":"aurora","name":"Aurora","description":"Theme and tab","version":"1.0.0","repository":repository,"license":"MIT"},
            "host":host,"contributes":[tab_member, theme_member]}},
            "source":{"repository":repository,"commit":"a".repeat(40),"tag":"v1.0.0"},"changelog":"Release"});
        let receipt = stage_loaded(
            &submission,
            "cadencr/registry",
            &root.path().join("first"),
            &downloader,
        )
        .unwrap();
        let assets = receipt
            .artifacts
            .iter()
            .map(|artifact| artifact.asset.as_str())
            .collect::<Vec<_>>();
        assert_eq!(
            assets,
            [
                "tab-aurora-tab-tab.tar.gz",
                "theme-aurora-theme-theme.tar.gz"
            ]
        );
        // The theme archive cannot stand in for the tab member's web archive.
        let contributes = &mut submission["package"]["package"]["contributes"];
        contributes[0]["package"]["tab"]["distribution"]["sha256"] = json!(packed_theme.sha256);
        assert!(stage_loaded(
            &submission,
            "cadencr/registry",
            &root.path().join("second"),
            &downloader
        )
        .is_err());
    }
    #[test]
    fn tab_publication_stages_normalized_assets_and_rejects_identity_swaps() {
        let root = tempfile::tempdir().unwrap();
        let stage = root.path().join("payload");
        std::fs::create_dir_all(stage.join("dist")).unwrap();
        std::fs::write(stage.join("tab.json"),r#"{"schema_version":1,"kind":"tab","id":"graph","name":"Graph","version":"1.0.0","api_version":1,"entry":"dist/index.html"}"#).unwrap();
        std::fs::write(stage.join("dist/index.html"), "<html>Graph</html>").unwrap();
        let packed = cadencr_registry_core::pack_tab(
            cadencr_registry_core::PackTabRequest::builder()
                .directory(&stage)
                .output(&root.path().join("tab.tar.gz"))
                .build(),
        )
        .unwrap();
        let body = std::fs::read(&packed.archive).unwrap();
        let downloader = FixtureDownloader {
            bodies: HashMap::from([(packed.sha256.clone(), body)]),
            calls: Mutex::new(Vec::new()),
            fail_at: None,
        };
        let mut submission = json!({"schema_version":2,"package":{"kind":"tab","package":{"tab":{"id":"graph","name":"Graph","description":"Graph","version":"1.0.0","api_version":1,"license":"MIT","repository":"https://github.com/acme/tabs","distribution":{"archive":"https://github.com/acme/tabs/releases/download/v1.0.0/tab.tar.gz","sha256":packed.sha256}},"host":{"publisher":"acme","compatibility":{"min_app_version":"0.1.0"}}}},"source":{"repository":"https://github.com/acme/tabs","commit":"a".repeat(40),"tag":"v1.0.0"},"changelog":"Release"});
        let receipt = stage_loaded(
            &submission,
            "cadencr/registry",
            &root.path().join("first"),
            &downloader,
        )
        .unwrap();
        assert_eq!(receipt.artifacts[0].asset, "tab.tar.gz");
        assert_eq!(receipt.plan["mirrored_package"]["kind"], "tab");
        submission["package"]["package"]["tab"]["id"] = json!("impostor");
        assert!(stage_loaded(
            &submission,
            "cadencr/registry",
            &root.path().join("second"),
            &downloader
        )
        .is_err());
    }

    #[cfg(unix)]
    #[test]
    fn backend_tab_publication_verifies_each_target_by_kind() {
        use std::os::unix::fs::PermissionsExt as _;
        let root = tempfile::tempdir().unwrap();
        let manifest = json!({"schema_version":1,"kind":"tab","id":"ports","name":"Ports",
            "version":"1.0.0","api_version":1,"entry":"dist/index.html",
            "backend":{"protocol":1,"reasoning":"Lists ports.","binary":{"linux-x86_64":"bin/ports"}}});
        let author = root.path().join("author");
        let stage = root.path().join("payload");
        for folder in [&author, &stage] {
            std::fs::create_dir_all(folder.join("dist")).unwrap();
            std::fs::write(folder.join("tab.json"), manifest.to_string()).unwrap();
            std::fs::write(folder.join("dist/index.html"), "<html>Ports</html>").unwrap();
        }
        std::fs::create_dir_all(author.join("bin")).unwrap();
        std::fs::write(
            author.join("bin/ports"),
            cadencr_plugin_core::tab::test_support::native_executable(
                cadencr_plugin_core::tab::TabPlatform::LinuxX86_64,
            ),
        )
        .unwrap();
        std::fs::set_permissions(
            author.join("bin/ports"),
            std::fs::Permissions::from_mode(0o755),
        )
        .unwrap();
        let web = cadencr_registry_core::pack_tab(
            cadencr_registry_core::PackTabRequest::builder()
                .directory(&stage)
                .output(&root.path().join("tab.tar.gz"))
                .build(),
        )
        .unwrap();
        let backend = cadencr_registry_core::pack_tab_backend(
            cadencr_registry_core::PackTabBackendRequest::builder()
                .directory(&author)
                .target(cadencr_plugin_core::tab::TabPlatform::LinuxX86_64)
                .output(&root.path().join("tab-backend-linux-x86_64.tar.gz"))
                .build(),
        )
        .unwrap();
        let downloader = FixtureDownloader {
            bodies: HashMap::from([
                (web.sha256.clone(), std::fs::read(&web.archive).unwrap()),
                (
                    backend.sha256.clone(),
                    std::fs::read(&backend.archive).unwrap(),
                ),
            ]),
            calls: Mutex::new(Vec::new()),
            fail_at: None,
        };
        let release = "https://github.com/acme/ports/releases/download/v1.0.0";
        let submission = json!({"schema_version":2,"package":{"kind":"tab","package":{"tab":{
            "id":"ports","name":"Ports","description":"Ports","version":"1.0.0","api_version":1,
            "license":"MIT","repository":"https://github.com/acme/ports",
            "backend":{"protocol":1,"reasoning":"Lists ports."},
            "distribution":{"archive":format!("{release}/tab.tar.gz"),"sha256":web.sha256,
                "binary":{"linux-x86_64":{"archive":format!("{release}/tab-backend-linux-x86_64.tar.gz"),
                    "sha256":backend.sha256,"size":backend.size,"cmd":backend.cmd,
                    "executable_sha256":backend.executable_sha256,"executable_size":backend.executable_size}}}},
            "host":{"publisher":"acme","compatibility":{"min_app_version":"0.1.0"}}}},
            "source":{"repository":"https://github.com/acme/ports","commit":"a".repeat(40),"tag":"v1.0.0"},
            "changelog":"Release"});
        let receipt = stage_loaded(
            &submission,
            "cadencr/registry",
            &root.path().join("first"),
            &downloader,
        )
        .unwrap();
        let assets: Vec<&str> = receipt.artifacts.iter().map(|a| a.asset.as_str()).collect();
        assert_eq!(
            assets,
            [
                "tab.tar.gz",
                &format!("backend-linux-x86_64-{}.tar.gz", backend.sha256)
            ]
        );
        // A signed executable digest the archive does not hold fails staging.
        let mut tampered = submission.clone();
        tampered["package"]["package"]["tab"]["distribution"]["binary"]["linux-x86_64"]
            ["executable_sha256"] = json!("0".repeat(64));
        let error = stage_loaded(
            &tampered,
            "cadencr/registry",
            &root.path().join("second"),
            &downloader,
        )
        .unwrap_err();
        assert!(error.to_string().contains("executable"), "{error}");
    }
}
