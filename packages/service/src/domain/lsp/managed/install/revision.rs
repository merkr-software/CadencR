use super::{invalid, io, platform, shared_catalog, storage, AppError, InstallLspRequest};
use crate::domain::agents::providers::installed::managed::trust::ManagedTrustStore;
use std::path::Path;
#[bon::builder]
pub(super) fn commit(
    root: &Path,
    body: InstallLspRequest,
    index: crate::domain::themes::managed::models::SignedMixedCatalog,
    bytes: Vec<u8>,
    update: bool,
    trust: &ManagedTrustStore,
) -> Result<(), AppError> {
    shared_catalog::verify(&index, trust, false)?;
    let package = shared_catalog::resolve_kind(&index, &body.lsp_id, &body.version, "lsp")?;
    let target = cadencr_registry_core::signed_lsp_target(&package, platform()).map_err(invalid)?;
    crate::domain::lsp::managed::policy::require_install(&body.lsp_id, &body.version, &target)?;
    let files =
        cadencr_registry_core::read_lsp_archive(&bytes, platform(), &target).map_err(invalid)?;
    let pointer = storage::Pointer {
        version: body.version.clone(),
        sha256: target.sha256.clone(),
    };
    if storage::owner(root, &body.lsp_id)?
        .join("active.json")
        .try_exists()
        .map_err(invalid)?
    {
        let current = storage::pointer(root, &body.lsp_id)?;
        if current.sha256 != pointer.sha256 && !update {
            return Err(AppError::coded(
                axum::http::StatusCode::CONFLICT,
                "LSP_ALREADY_INSTALLED",
                "LSP already installed; use update",
            ));
        }
    } else if update {
        return Err(AppError::NotFound(format!(
            "LSP {} is not installed",
            body.lsp_id
        )));
    }
    storage::secure(root)?;
    let mut builder = tempfile::Builder::new();
    builder.prefix(".stage-");
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt as _;
        builder.permissions(std::fs::Permissions::from_mode(0o700));
    }
    let stage = builder.tempdir_in(root).map_err(invalid)?;
    write_payload(root, stage.path(), files, &target)?;
    storage::write_archive(stage.path(), &bytes)?;
    let receipt = storage::Receipt {
        index,
        id: body.lsp_id.clone(),
        version: body.version,
    };
    crate::shared::atomic_file::write_atomic_private(
        &stage.path().join("receipt.json"),
        &serde_json::to_string(&receipt).map_err(invalid)?,
    )?;
    let destination = storage::revision(root, &body.lsp_id, &pointer)?;
    io::with_root(root.to_path_buf(), || {
        io::secure(
            destination
                .parent()
                .ok_or_else(|| invalid("LSP revision has no parent"))?,
        )
    })?;
    if !destination.try_exists().map_err(invalid)? {
        std::fs::rename(stage.path(), &destination).map_err(invalid)?;
    }
    storage::read_revision_trusted(root, &body.lsp_id, &pointer, trust)?;
    storage::activate(root, &body.lsp_id, &pointer)
}
fn write_payload(
    root: &Path,
    stage: &Path,
    files: std::collections::BTreeMap<String, Vec<u8>>,
    target: &cadencr_registry_core::LspTarget,
) -> Result<(), AppError> {
    for (name, contents) in files {
        let path = stage.join("payload").join(&name);
        if let Some(parent) = path.parent() {
            io::with_root(root.to_path_buf(), || io::secure(parent))?;
        }
        std::fs::write(&path, contents).map_err(invalid)?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt as _;
            let mode = if name == target.entry
                && target.runtime == cadencr_registry_core::LspRuntime::Native
            {
                0o700
            } else {
                0o600
            };
            std::fs::set_permissions(&path, std::fs::Permissions::from_mode(mode))
                .map_err(invalid)?;
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::super::remove_from;
    use super::*;
    use crate::domain::themes::managed::models::SignedMixedCatalog;
    use base64::Engine as _;
    use ed25519_dalek::Signer as _;
    use serde_json::json;
    struct Harness {
        _temp: tempfile::TempDir,
        root: std::path::PathBuf,
        index: SignedMixedCatalog,
        trust: ManagedTrustStore,
        archives: Vec<Vec<u8>>,
    }
    impl Harness {
        fn new() -> Self {
            let temp = tempfile::tempdir().unwrap();
            let root = temp.path().join("installed");
            let mut packages = Vec::new();
            let mut archives = Vec::new();
            for version in ["1.0.0", "2.0.0"] {
                let source = temp.path().join(version);
                std::fs::create_dir(&source).unwrap();
                std::fs::write(source.join("server.cjs"),"process.stdin.on('data',()=>process.stdout.write(require('./lazy.cjs')));setInterval(()=>{},1000)").unwrap();
                std::fs::write(
                    source.join("lazy.cjs"),
                    format!("module.exports='{version}';"),
                )
                .unwrap();
                std::fs::write(source.join("receipt.json"), "payload receipt").unwrap();
                std::fs::write(source.join("archive.tar.gz"), "payload archive").unwrap();
                let output = temp.path().join(format!("{version}.tar.gz"));
                let packed = cadencr_registry_core::pack_lsp(
                    cadencr_registry_core::PackLspRequest::builder()
                        .directory(&source)
                        .target(platform())
                        .entry("server.cjs")
                        .runtime(cadencr_registry_core::LspRuntime::Node)
                        .output(&output)
                        .build(),
                )
                .unwrap();
                archives.push(std::fs::read(&output).unwrap());
                packages.push(json!({"kind":"lsp","package":{
                    "lsp":{"id":"fixture","name":"Fixture","description":"Prepared fixture server","version":version,
                        "repository":"https://github.com/acme/lsp","license":"MIT","protocol_version":1,
                        "languages":[{"id":"fixturelang","extensions":["fixture"],"filenames":[]}],
                        "root_markers":["fixture.json"],"role":"general","args":[],"initialization_options":{"fixture":version},
                        "distribution":{"binary":{(platform()):{"archive":format!("https://github.com/acme/lsp/releases/download/v{version}/bundle.tar.gz"),"sha256":packed.sha256,"size":packed.size,"entry":packed.entry,"entry_sha256":packed.entry_sha256,"entry_size":packed.entry_size,"runtime":"node"}}}},
                    "host":{"publisher":"acme","compatibility":{"min_app_version":"0.1.0"}}
                }}));
            }
            let (mut index, trust) = shared_catalog::tests::signed();
            index.signed.packages = packages;
            index.signature.value = base64::engine::general_purpose::STANDARD.encode(
                ed25519_dalek::SigningKey::from_bytes(&[19; 32])
                    .sign(&cadencr_registry_core::canonical_json_bytes(
                        &serde_json::to_value(&index.signed).unwrap(),
                    ))
                    .to_bytes(),
            );
            Self {
                _temp: temp,
                root,
                index,
                trust,
                archives,
            }
        }
        fn install(&self, n: usize, update: bool) -> Result<(), AppError> {
            commit()
                .root(&self.root)
                .body(InstallLspRequest {
                    lsp_id: "fixture".into(),
                    version: format!("{}.0.0", n + 1),
                })
                .index(self.index.clone())
                .bytes(self.archives[n].clone())
                .update(update)
                .trust(&self.trust)
                .call()
        }
        fn read(
            &self,
        ) -> (
            crate::domain::lsp::probe::ServerProbe,
            cadencr_registry_core::LspTarget,
        ) {
            let pointer = storage::pointer(&self.root, "fixture").unwrap();
            storage::read_revision_trusted(&self.root, "fixture", &pointer, &self.trust).unwrap()
        }
    }
    #[tokio::test(flavor = "current_thread")]
    async fn signed_install_update_remove_retains_lazy_dependencies_and_initialization_metadata() {
        use tokio::io::{AsyncReadExt as _, AsyncWriteExt as _};
        let fixture = Harness::new();
        let _policy =
            crate::domain::lsp::managed::policy::tests::configure(&fixture.root, json!([]));
        fixture.install(0, false).unwrap();
        fixture.install(0, false).unwrap();
        assert_eq!(storage::ids(&fixture.root).unwrap(), ["fixture"]);
        let (probe, _) = fixture.read();
        assert_eq!(probe.initialization_options, json!({"fixture":"1.0.0"}));
        assert_eq!(probe.root_markers, ["fixture.json"]);
        let inventory = storage::inventory_trusted(&fixture.root, &fixture.trust).unwrap();
        let resolved = crate::domain::lsp::selection::resolve(
            "fixturelang",
            &Default::default(),
            &Default::default(),
            inventory,
        )
        .unwrap();
        assert_eq!(resolved.servers[0].lsp_id, "fixture");
        let nested = fixture.root.join("project/src");
        std::fs::create_dir_all(&nested).unwrap();
        std::fs::write(fixture.root.join("project/fixture.json"), "{}").unwrap();
        let markers = probe
            .root_markers
            .iter()
            .map(String::as_str)
            .collect::<Vec<_>>();
        assert_eq!(
            crate::domain::lsp::root::nearest_root(&fixture.root, &nested, &markers),
            fixture.root.join("project")
        );
        let pointer = storage::pointer(&fixture.root, "fixture").unwrap();
        let revision = storage::revision(&fixture.root, "fixture", &pointer).unwrap();
        assert_eq!(
            std::fs::read_to_string(revision.join("payload/receipt.json")).unwrap(),
            "payload receipt"
        );
        let archive = revision.join("archive.tar.gz");
        let retained = revision.join("archive.retained");
        std::fs::rename(&archive, &retained).unwrap();
        assert_eq!(
            storage::inventory_trusted(&fixture.root, &fixture.trust).unwrap()[0]
                .version
                .as_deref(),
            Some("1.0.0")
        );
        assert!(
            storage::read_revision_trusted(&fixture.root, "fixture", &pointer, &fixture.trust)
                .is_err()
        );
        std::fs::rename(retained, archive).unwrap();
        let spec = crate::domain::lsp::spawn::ServerSpec {
            command: crate::domain::lsp::spawn::node().await.unwrap(),
            args: vec![probe.path.unwrap()],
            display_name: "fixture".into(),
            managed_revision: None,
        };
        let mut child = crate::domain::lsp::spawn::spawn_server(&spec, &fixture.root).unwrap();
        fixture.install(1, true).unwrap();
        assert_eq!(fixture.read().0.version.as_deref(), Some("2.0.0"));
        remove_from(&fixture.root, "fixture").unwrap();
        assert!(storage::ids(&fixture.root).unwrap().is_empty());
        assert!(storage::removed(&fixture.root, "fixture"));
        child
            .stdin
            .as_mut()
            .unwrap()
            .write_all(b"load lazy dependency")
            .await
            .unwrap();
        let mut output = [0; 5];
        tokio::time::timeout(
            std::time::Duration::from_secs(5),
            child.stdout.as_mut().unwrap().read_exact(&mut output),
        )
        .await
        .unwrap()
        .unwrap();
        assert_eq!(&output, b"1.0.0");
        child.kill().await.unwrap();
        fixture.install(0, false).unwrap();
        assert_eq!(fixture.read().0.version.as_deref(), Some("1.0.0"));
    }
    #[test]
    fn failed_retained_revision_or_archive_verification_never_changes_the_active_pointer() {
        let fixture = Harness::new();
        let _policy =
            crate::domain::lsp::managed::policy::tests::configure(&fixture.root, json!([]));
        fixture.install(0, false).unwrap();
        let old = storage::pointer(&fixture.root, "fixture").unwrap();
        let old_dir = storage::revision(&fixture.root, "fixture", &old).unwrap();
        fixture.install(1, true).unwrap();
        let active = std::fs::read(fixture.root.join("fixture/active.json")).unwrap();
        std::fs::write(old_dir.join("payload/lazy.cjs"), "module.exports='hacked'").unwrap();
        assert!(fixture.install(0, true).is_err());
        assert_eq!(
            std::fs::read(fixture.root.join("fixture/active.json")).unwrap(),
            active
        );
        let mut bytes = fixture.archives[0].clone();
        bytes[0] ^= 1;
        let result = commit()
            .root(&fixture.root)
            .body(InstallLspRequest {
                lsp_id: "fixture".into(),
                version: "1.0.0".into(),
            })
            .index(fixture.index.clone())
            .bytes(bytes)
            .update(true)
            .trust(&fixture.trust)
            .call();
        assert!(result.is_err());
        assert_eq!(
            std::fs::read(fixture.root.join("fixture/active.json")).unwrap(),
            active
        );
    }
    #[test]
    fn signed_revocation_refuses_install_before_any_revision_is_active() {
        let fixture = Harness::new();
        let _policy = crate::domain::lsp::managed::policy::tests::configure(
            &fixture.root,
            json!([{"lsp_id":"fixture","reason":"revoked fixture"}]),
        );
        assert!(matches!(
            fixture.install(0, false),
            Err(AppError::Coded {
                code: "LSP_BLOCKED",
                ..
            })
        ));
        assert!(storage::ids(&fixture.root).unwrap().is_empty());
    }
    #[test]
    fn unsigned_payload_additions_and_symlinks_are_rejected_at_launch() {
        let fixture = Harness::new();
        let _policy =
            crate::domain::lsp::managed::policy::tests::configure(&fixture.root, json!([]));
        fixture.install(0, false).unwrap();
        let pointer = storage::pointer(&fixture.root, "fixture").unwrap();
        let directory = storage::revision(&fixture.root, "fixture", &pointer).unwrap();
        let package = directory.join("payload/package.json");
        std::fs::write(&package, "{\"type\":\"module\"}").unwrap();
        assert!(
            storage::read_revision_trusted(&fixture.root, "fixture", &pointer, &fixture.trust)
                .is_err()
        );
        std::fs::remove_file(package).unwrap();
        assert!(
            storage::read_revision_trusted(&fixture.root, "fixture", &pointer, &fixture.trust)
                .is_ok()
        );
        #[cfg(unix)]
        {
            std::os::unix::fs::symlink(
                directory.join("payload/lazy.cjs"),
                directory.join("payload/unsigned.cjs"),
            )
            .unwrap();
            assert!(storage::read_revision_trusted(
                &fixture.root,
                "fixture",
                &pointer,
                &fixture.trust
            )
            .is_err());
        }
    }
    #[test]
    fn reservation_pins_the_original_revision_and_rechecks_revocations_before_connect() {
        let fixture = Harness::new();
        let policy =
            crate::domain::lsp::managed::policy::tests::configure(&fixture.root, json!([]));
        fixture.install(0, false).unwrap();
        let pointer = storage::pointer(&fixture.root, "fixture").unwrap();
        let proof = crate::domain::lsp::spawn::ManagedRevision {
            root: fixture.root.clone(),
            id: "fixture".into(),
            receipt_sha256: storage::receipt_digest(&fixture.root, "fixture", &pointer).unwrap(),
            pointer,
        };
        fixture.install(1, true).unwrap();
        crate::domain::lsp::spawn::verify_reserved(&proof, &fixture.trust).unwrap();
        assert_eq!(proof.pointer.version, "1.0.0");
        drop(policy);
        let _blocked = crate::domain::lsp::managed::policy::tests::configure(
            &fixture.root,
            json!([{"lsp_id":"fixture","reason":"revoked after reservation"}]),
        );
        assert!(matches!(
            crate::domain::lsp::spawn::verify_reserved(&proof, &fixture.trust),
            Err(AppError::Coded {
                code: "LSP_BLOCKED",
                ..
            })
        ));
    }
}
