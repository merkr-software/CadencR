//! Admitting downloaded bytes: verify them against the signed catalog, then
//! activate them, or stage them when they would run something the user has
//! not accepted yet.
use super::super::policy::{self, PolicySnapshot, PolicySubject};
use super::super::{
    invalid, require_host_target, storage, InstallManagedTabRequest, ManagedTabInventoryEntry,
};
use crate::domain::marketplace::models::SignedMixedCatalog;
use crate::{
    domain::marketplace::{catalog, storage as io},
    error::AppError,
};
use cadencr_plugin_core::tab::TabPlatform;
use cadencr_registry_core::SignedTabBackend;
use std::path::PathBuf;

/// One platform's verified backend, out of its signed archive.
struct Backend {
    platform: TabPlatform,
    archive: Vec<u8>,
    executable: Vec<u8>,
    cmd: String,
    archive_sha256: String,
    executable_sha256: String,
}

impl Backend {
    fn payload(&self) -> storage::BackendPayload<'_> {
        storage::BackendPayload {
            archive: &self.archive,
            archive_sha256: self.archive_sha256.clone(),
            executable: &self.executable,
            executable_sha256: self.executable_sha256.clone(),
            cmd: &self.cmd,
        }
    }
}

#[bon::builder]
pub(super) fn install_bytes(
    root: PathBuf,
    local: PathBuf,
    body: InstallManagedTabRequest,
    /// The verified catalog the revision is resolved from.
    index: &SignedMixedCatalog,
    bytes: Vec<u8>,
    backend_archive: Option<Vec<u8>>,
    update: bool,
    /// The permissions hash the user last accepted for this tab.
    consented: Option<String>,
) -> Result<ManagedTabInventoryEntry, AppError> {
    require_expected_state(&root, &local, &body.tab_id, update)?;
    let package = catalog::resolve_kind(index, &body.tab_id, &body.version, "tab")?;
    if package["tab"]["distribution"]["sha256"].as_str() != Some(io::digest(&bytes).as_str()) {
        return Err(invalid("tab archive SHA-256 mismatch"));
    }
    let files = cadencr_registry_core::read_tab_archive_bytes(&bytes).map_err(invalid)?;
    let (manifest, signed) = storage::verify_package(&package, &files)?;
    let backend = verify_backend(&body.tab_id, signed.as_ref(), backend_archive)?;
    let executable_sha256 = backend
        .as_ref()
        .map(|backend| backend.executable_sha256.as_str());
    // Checked again (in memory) in case the policy changed during the download.
    require_install(&*policy::current()?, &body, &package, executable_sha256)?;
    let hash = manifest.permissions_hash_with_backend_digest(executable_sha256);
    let Placement {
        active,
        replaced,
        stage,
    } = placement(&root, &body.tab_id, update, consented.as_deref(), &hash);
    storage::commit_revision()
        .root(&root)
        .receipt(&storage::Receipt {
            index: index.clone(),
            id: body.tab_id.clone(),
            version: body.version.clone(),
            platform: backend.as_ref().map(|backend| backend.platform),
        })
        .archive(&bytes)
        .files(&files)
        .maybe_backend(backend.as_ref().map(Backend::payload))
        .activation(if stage {
            storage::Activation::Stage
        } else {
            storage::Activation::Activate
        })
        .call()?;
    // Installing never grants consent or switches the tab on. The existing runtime
    // compares the new manifest's permissions hash before issuing a grant.
    if let Some(active) = active.filter(|_| stage) {
        return Ok(staged_entry(body.tab_id, active, body.version));
    }
    Ok(ManagedTabInventoryEntry {
        id: body.tab_id,
        version: body.version,
        name: manifest.name,
        error: replaced,
        pending_version: None,
        platform: backend.map(|backend| backend.platform),
        blocked: None,
    })
}

/// 400 `MANAGED_TAB_INVALID` when a local tab owns `id`, or when `update`
/// disagrees with whether a revision is installed.
fn require_expected_state(
    root: &std::path::Path,
    local: &std::path::Path,
    id: &str,
    update: bool,
) -> Result<(), AppError> {
    match local.symlink_metadata() {
        Ok(_) => {
            return Err(invalid(
                "an editable local tab already owns this id; its files were preserved",
            ))
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
        Err(error) => return Err(invalid(error)),
    }
    if storage::directory(root, id)?.is_some() != update {
        return Err(invalid(
            "tab installation state changed; reload before retrying",
        ));
    }
    Ok(())
}

/// Where a verified revision whose permissions hash is `hash` goes.
struct Placement {
    /// The revision an update replaces, when it still verifies.
    active: Option<storage::VerifiedRevision>,
    /// Why the previous revision was replaced without review.
    replaced: Option<String>,
    /// Staged beside `active` for review instead of activated.
    stage: bool,
}

fn placement(
    root: &std::path::Path,
    id: &str,
    update: bool,
    consented: Option<&str>,
    hash: &str,
) -> Placement {
    // An installed revision that no longer verifies has no accepted
    // permissions left to protect: the update repairs it (and says so).
    let (active, replaced) = match update.then(|| storage::read(root, id)) {
        Some(Ok(revision)) => (Some(revision), None),
        Some(Err(error)) => (
            None,
            Some(format!(
                "the previous revision no longer verified and was replaced: {error}"
            )),
        ),
        None => (None, None),
    };
    // Stage only what would widen an accepted tab: with no consent (or one
    // for a revision already replaced) there is nothing to protect, and the
    // user reviews the new hash before it runs anyway.
    let stage = active.as_ref().is_some_and(|active| {
        let accepted = active.permissions_hash();
        consented == Some(accepted.as_str()) && accepted != hash
    });
    Placement {
        active,
        replaced,
        stage,
    }
}

/// A staged update reports the revision still active, the update pending.
fn staged_entry(
    id: String,
    active: storage::VerifiedRevision,
    staged_version: String,
) -> ManagedTabInventoryEntry {
    let blocked = policy::current_blocked_reason(PolicySubject::installed(
        &id,
        &active.manifest.version,
        &active.facts,
    ));
    ManagedTabInventoryEntry {
        pending_version: Some(staged_version),
        ..ManagedTabInventoryEntry::from_revision(id, active, blocked)
    }
}

/// 409 `MANAGED_TAB_BLOCKED` when the policy blocks the signed revision
/// `body` names (this platform's binary included), 409
/// `MANAGED_TAB_POLICY_UNAVAILABLE` when a feed is configured but no fresh
/// policy vouches for it.
pub(super) fn require_install(
    policy: &PolicySnapshot,
    body: &InstallManagedTabRequest,
    package: &serde_json::Value,
    executable_sha256: Option<&str>,
) -> Result<(), AppError> {
    let subject = PolicySubject::signed(&body.tab_id, &body.version, package, executable_sha256)
        .ok_or_else(|| invalid("tab archive SHA-256 missing"))?;
    policy.require_install(subject)
}

/// The backend this host installs: the signed archive for its platform,
/// checked byte for byte (size, digest, one native executable at `cmd`).
fn verify_backend(
    id: &str,
    signed: Option<&SignedTabBackend>,
    archive: Option<Vec<u8>>,
) -> Result<Option<Backend>, AppError> {
    let Some(signed) = signed else {
        if archive.is_some() {
            return Err(invalid("the signed tab package ships no backend"));
        }
        return Ok(None);
    };
    let (platform, target) = require_host_target(id, signed)?;
    let archive = archive.ok_or_else(|| invalid("the tab's backend archive is missing"))?;
    let executable = cadencr_registry_core::read_tab_backend_archive(&archive, platform, target)
        .map_err(invalid)?;
    Ok(Some(Backend {
        platform,
        archive,
        executable,
        cmd: target.cmd.clone(),
        archive_sha256: target.sha256.clone(),
        executable_sha256: target.executable_sha256.clone(),
    }))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::domain::plugin_tabs::managed::storage::fixtures::{
        backend_fixture, backend_revision, fixture, merged, other_platform, BackendFixture,
    };

    struct Harness {
        temp: tempfile::TempDir,
        root: PathBuf,
        local: PathBuf,
    }
    #[bon::bon]
    impl Harness {
        fn new() -> Self {
            let temp = tempfile::tempdir().unwrap();
            Self {
                root: temp.path().join("managed"),
                local: temp.path().join("authors/graph"),
                temp,
            }
        }
        #[builder]
        fn install(
            &self,
            index: &SignedMixedCatalog,
            #[builder(default = "1.0.0")] version: &str,
            bytes: Vec<u8>,
            backend: Option<Vec<u8>>,
            #[builder(default)] update: bool,
            consented: Option<String>,
        ) -> Result<ManagedTabInventoryEntry, AppError> {
            io::with_root(self.temp.path().join("themes"), || {
                install_bytes()
                    .root(self.root.clone())
                    .local(self.local.clone())
                    .body(InstallManagedTabRequest {
                        tab_id: "graph".into(),
                        version: version.into(),
                    })
                    .index(index)
                    .bytes(bytes)
                    .maybe_backend_archive(backend)
                    .update(update)
                    .maybe_consented(consented)
                    .call()
            })
        }
    }

    fn code(result: Result<ManagedTabInventoryEntry, AppError>) -> &'static str {
        crate::domain::plugin_tabs::test_support::error_code(&result.unwrap_err())
    }

    #[test]
    fn installer_admits_signed_bytes_and_preserves_local_author_tabs() {
        let harness = Harness::new();
        let (receipt, archive, _, trust) = fixture(harness.temp.path());
        let call = |bytes: Vec<u8>, update: bool| {
            harness
                .install()
                .index(&receipt.index)
                .bytes(bytes)
                .update(update)
                .call()
        };
        assert!(call(b"tampered".to_vec(), false).is_err());
        assert!(storage::directory(&harness.root, "graph")
            .unwrap()
            .is_none());
        let installed = call(archive.clone(), false).unwrap();
        assert_eq!(
            (
                installed.version.as_str(),
                installed.platform,
                installed.pending_version
            ),
            ("1.0.0", None, None)
        );
        assert!(call(archive.clone(), false).is_err());
        assert!(call(archive.clone(), true).is_ok());
        storage::read_trusted(&harness.root, "graph", &trust).unwrap();
        std::fs::create_dir_all(&harness.local).unwrap();
        std::fs::write(harness.local.join("source.ts"), "author work").unwrap();
        assert!(call(archive, true).is_err());
        assert_eq!(
            std::fs::read_to_string(harness.local.join("source.ts")).unwrap(),
            "author work"
        );
    }

    #[test]
    fn the_revocation_policy_refuses_blocked_or_unvouched_installs() {
        use crate::domain::plugin_tabs::managed::policy::tests::{configure, expire_cache};
        let harness = Harness::new();
        let tab = backend_fixture().root(harness.temp.path()).call();
        let call = || {
            harness
                .install()
                .index(&tab.receipt.index)
                .bytes(tab.archive.clone())
                .backend(tab.backend_archive.clone())
                .call()
        };
        let digest = crate::domain::marketplace::storage::digest(&tab.executable);
        // This platform's binary is what is blocked.
        let _policy = configure(
            serde_json::json!([{"tab_id":"graph","executable_sha256":digest,"reason":"steals keys"}]),
        );
        let refused = call().unwrap_err();
        assert_eq!(
            crate::domain::plugin_tabs::test_support::error_code(&refused),
            "MANAGED_TAB_BLOCKED"
        );
        assert!(refused.to_string().contains("steals keys"));
        // A configured feed with only an expired policy vouches for nothing.
        expire_cache(serde_json::json!([]));
        assert_eq!(code(call()), "MANAGED_TAB_POLICY_UNAVAILABLE");
        assert!(storage::directory(&harness.root, "graph")
            .unwrap()
            .is_none());
    }

    #[test]
    fn a_backend_tab_installs_its_platform_binary_only_from_matching_bytes() {
        let harness = Harness::new();
        let tab = backend_fixture().root(harness.temp.path()).call();
        let call = |backend: Option<Vec<u8>>| {
            harness
                .install()
                .index(&tab.receipt.index)
                .bytes(tab.archive.clone())
                .maybe_backend(backend)
                .call()
        };
        assert!(call(None).is_err(), "the backend archive is required");
        let mut tampered = tab.backend_archive.clone();
        *tampered.last_mut().unwrap() ^= 1;
        assert!(call(Some(tampered)).is_err());
        assert!(call(Some(b"not gzip".to_vec())).is_err());
        assert!(storage::directory(&harness.root, "graph")
            .unwrap()
            .is_none());
        let installed = call(Some(tab.backend_archive.clone())).unwrap();
        assert_eq!(installed.platform, TabPlatform::current());
        let revision = storage::read_trusted(&harness.root, "graph", &tab.trust)
            .unwrap()
            .revision;
        let backend = revision.facts.backend.clone().unwrap();
        assert_eq!(backend.executable_sha256, io::digest(&tab.executable));
        let executable = storage::directory(&harness.root, "graph")
            .unwrap()
            .unwrap()
            .join(&backend.cmd);
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt as _;
            let mode = std::fs::metadata(&executable).unwrap().permissions().mode();
            assert_eq!(mode & 0o777, 0o500, "owner-only, executable, read-only");
        }
        // A UI-only package cannot smuggle a binary in.
        let ui = Harness::new();
        let (receipt, archive, _, _) = fixture(ui.temp.path());
        assert!(ui
            .install()
            .index(&receipt.index)
            .bytes(archive)
            .backend(tab.backend_archive.clone())
            .call()
            .is_err());
    }

    #[test]
    fn a_backend_without_this_platforms_binary_is_not_installed() {
        let harness = Harness::new();
        let elsewhere = other_platform();
        let tab = backend_fixture()
            .root(harness.temp.path())
            .platform(elsewhere)
            .call();
        let result = harness
            .install()
            .index(&tab.receipt.index)
            .bytes(tab.archive.clone())
            .backend(tab.backend_archive.clone())
            .call();
        let error = format!("{result:?}");
        assert_eq!(code(result), "MANAGED_TAB_PLATFORM_UNSUPPORTED");
        assert!(error.contains(elsewhere.as_str()), "{error}");
        assert!(!harness.root.join("graph").exists());
    }

    /// Two versions of a backend tab in one catalog, their binaries differing.
    fn two_versions(harness: &Harness) -> (SignedMixedCatalog, BackendFixture, BackendFixture) {
        let version = |number: usize| {
            backend_revision(&harness.temp.path().join(format!("v{number}")), number)
        };
        let (first, second) = (version(0), version(1));
        (
            merged(&[&first.receipt.index, &second.receipt.index]),
            first,
            second,
        )
    }

    #[test]
    fn an_update_that_runs_a_new_binary_is_staged_only_over_an_accepted_revision() {
        let harness = Harness::new();
        let (index, first, second) = two_versions(&harness);
        let install = |tab: &BackendFixture, version, update, consented: Option<String>| {
            harness
                .install()
                .index(&index)
                .version(version)
                .bytes(tab.archive.clone())
                .backend(tab.backend_archive.clone())
                .update(update)
                .maybe_consented(consented)
                .call()
        };
        install(&first, "1.0.0", false, None).unwrap();
        let accepted = storage::read(&harness.root, "graph")
            .unwrap()
            .permissions_hash();
        let active = storage::directory(&harness.root, "graph").unwrap();
        let staged = install(&second, "1.0.1", true, Some(accepted.clone())).unwrap();
        assert_eq!(
            (staged.version.as_str(), staged.pending_version.as_deref()),
            ("1.0.0", Some("1.0.1"))
        );
        assert_eq!(storage::directory(&harness.root, "graph").unwrap(), active);
        let staged_dir = storage::pending_directory(&harness.root, "graph")
            .unwrap()
            .unwrap();
        let pending =
            storage::read_trusted_directory(&harness.root, "graph", &staged_dir, &first.trust)
                .unwrap()
                .revision;
        assert_ne!(pending.permissions_hash(), accepted);
        // Re-offering the accepted bytes activates them and drops the stage.
        install(&first, "1.0.0", true, Some(accepted.clone())).unwrap();
        assert!(storage::pending_directory(&harness.root, "graph")
            .unwrap()
            .is_none());
        // Without an accepted revision to protect, an update goes live.
        let live = install(&second, "1.0.1", true, Some("other".into())).unwrap();
        assert_eq!(
            (live.version.as_str(), live.pending_version),
            ("1.0.1", None)
        );
        assert!(storage::pending_directory(&harness.root, "graph")
            .unwrap()
            .is_none());
    }

    /// Live-API QA seeding (no GitHub release needed): installs a signed
    /// backend tab `graph` into a service's plugins folder, then stages its
    /// updates, as `install` would after downloading. The service must be
    /// built trusting the fixture key (`CADENCR_MANAGED_PROVIDER_KEY_ID=tab-test`,
    /// `CADENCR_MANAGED_PROVIDER_PUBLIC_KEY_BASE64` = the key `seed` prints).
    ///
    /// `CADENCR_QA_TAB_PLUGINS=<settings-dir>/../plugins CADENCR_QA_TAB_STEP=seed`
    /// installs 1.0.0; `CADENCR_QA_TAB_STEP=update-1|update-2` offers 1.0.1 /
    /// 1.0.2 (each a different binary) with `CADENCR_QA_TAB_CONSENTED=<hash>`;
    /// `install-N` reinstalls version N after the tab was removed.
    #[test]
    #[ignore = "live QA seeding: run explicitly with the environment above"]
    fn qa_seed_marketplace_backend_tab() {
        use base64::Engine as _;
        let plugins = PathBuf::from(std::env::var("CADENCR_QA_TAB_PLUGINS").unwrap());
        let step = std::env::var("CADENCR_QA_TAB_STEP").unwrap();
        let work = plugins.parent().unwrap().join("qa-fixtures");
        let trust_key = ed25519_dalek::SigningKey::from_bytes(&[37; 32]);
        let call = |index: &SignedMixedCatalog, number: usize, update, consented| {
            io::with_root(plugins.join("managed-themes"), || {
                install_bytes()
                    .root(plugins.join("managed-tabs"))
                    .local(plugins.join("tabs/graph"))
                    .body(InstallManagedTabRequest {
                        tab_id: "graph".into(),
                        version: format!("1.0.{number}"),
                    })
                    .index(index)
                    .bytes(std::fs::read(work.join(format!("tab-{number}.tar.gz"))).unwrap())
                    .backend_archive(
                        std::fs::read(work.join(format!("backend-{number}.tar.gz"))).unwrap(),
                    )
                    .update(update)
                    .maybe_consented(consented)
                    .call()
                    .unwrap()
            })
        };
        if step == "seed" {
            std::fs::create_dir_all(&work).unwrap();
            let native = crate::domain::plugin_tabs::native_tab_backend::install(&work, "native");
            let native = std::fs::read(native).unwrap();
            let tabs: Vec<BackendFixture> = (0..3)
                .map(|number| {
                    let mut executable = native.clone();
                    executable.extend(std::iter::repeat_n(b'v', number));
                    backend_fixture()
                        .root(&work.join(format!("v{number}")))
                        .revision(number)
                        .executable(executable)
                        .call()
                })
                .collect();
            let indexes: Vec<&SignedMixedCatalog> =
                tabs.iter().map(|tab| &tab.receipt.index).collect();
            let index = merged(&indexes);
            std::fs::write(work.join("index.json"), serde_json::to_vec(&index).unwrap()).unwrap();
            for (number, tab) in tabs.iter().enumerate() {
                std::fs::write(work.join(format!("tab-{number}.tar.gz")), &tab.archive).unwrap();
                std::fs::write(
                    work.join(format!("backend-{number}.tar.gz")),
                    &tab.backend_archive,
                )
                .unwrap();
            }
            println!(
                "public key: {}",
                base64::engine::general_purpose::STANDARD
                    .encode(trust_key.verifying_key().to_bytes())
            );
            println!("{:?}", call(&index, 0, false, None));
            return;
        }
        // `install-N` reinstalls a seeded version after its removal.
        let (number, update) = match step.strip_prefix("install-") {
            Some(number) => (number, false),
            None => (step.strip_prefix("update-").unwrap(), true),
        };
        let index: SignedMixedCatalog =
            serde_json::from_slice(&std::fs::read(work.join("index.json")).unwrap()).unwrap();
        let consented = std::env::var("CADENCR_QA_TAB_CONSENTED").ok();
        println!(
            "{:?}",
            call(&index, number.parse().unwrap(), update, consented)
        );
    }
}
