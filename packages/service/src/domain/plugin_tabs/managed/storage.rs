mod backend;
mod cache;
mod filesystem;
#[cfg(test)]
pub(in crate::domain::plugin_tabs) mod fixtures;
mod pending;
mod retention;
mod write;
use super::invalid;
use crate::{
    domain::marketplace::{catalog, models::SignedMixedCatalog, storage as io},
    error::AppError,
};
pub use backend::{revision_id, BackendPayload, InstalledBackend};
use cadencr_plugin_core::tab::{TabManifest, TabPlatform};
use cadencr_registry_core::SignedTabBackend;
use filesystem::check_directory;
pub use filesystem::{secure, write_file};
pub use pending::{discard_pending, lease_pending, pending_directory, promote_pending};
pub use retention::{lease, RevisionLease};
use serde::{Deserialize, Serialize};
use std::{
    collections::BTreeMap,
    path::{Path, PathBuf},
};
pub use write::commit_revision;

const LIMIT: usize = 32 * 1024 * 1024;
const MAX_ACTIVE_TABS: usize = 128;
/// The owner's pointer at its active revision (`pending.json` names a staged one).
const ACTIVE: &str = "active.json";
/// A revision's signed web archive, beside its payload folder.
const WEB_ARCHIVE: &str = "archive.tar.gz";
/// A revision's catalog proof: the signed index it was installed from.
const RECEIPT: &str = "receipt.json";
#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Receipt {
    pub index: SignedMixedCatalog,
    pub id: String,
    pub version: String,
    /// The platform whose backend binary this revision holds; absent for a
    /// UI-only tab (and every receipt written before tab backends).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub platform: Option<TabPlatform>,
}

/// What a verified managed revision is, beyond its manifest.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ManagedFacts {
    /// The revision directory name ([`revision_id`]).
    pub revision: String,
    /// SHA-256 of the signed web archive.
    pub archive_sha256: String,
    pub backend: Option<InstalledBackend>,
}
impl ManagedFacts {
    /// The signed executable digest consent binds (`None` without a backend).
    pub fn backend_digest(&self) -> Option<&str> {
        self.backend
            .as_ref()
            .map(|backend| backend.executable_sha256.as_str())
    }
}

/// A revision whose every byte was checked against its signed package.
#[derive(Debug, Clone)]
pub struct VerifiedRevision {
    pub manifest: TabManifest,
    pub facts: ManagedFacts,
}
impl VerifiedRevision {
    /// The hash consent is recorded against, the signed binary included.
    pub fn permissions_hash(&self) -> String {
        self.manifest
            .permissions_hash_with_backend_digest(self.facts.backend_digest())
    }
}

/// Whether a committed revision goes live or awaits review.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Activation {
    Activate,
    /// Beside the active revision, until the user accepts what it may run.
    Stage,
}

pub fn root() -> PathBuf {
    crate::domain::settings_store::dir::data_sibling_dir("plugins").join("managed-tabs")
}
pub fn owner(root: &Path, id: &str) -> Result<PathBuf, AppError> {
    if !cadencr_plugin_core::tab::is_valid_tab_id(id)
        || cadencr_plugin_core::tab::RESERVED_IDS.contains(&id)
    {
        return Err(invalid("invalid managed tab id"));
    }
    Ok(root.join(id))
}
pub fn directory(root: &Path, id: &str) -> Result<Option<PathBuf>, AppError> {
    pointer_directory(root, id, ACTIVE)
}
fn pointer_directory(root: &Path, id: &str, name: &str) -> Result<Option<PathBuf>, AppError> {
    let owner = owner(root, id)?;
    let pointer = owner.join(name);
    if !pointer.try_exists().map_err(invalid)? {
        return Ok(None);
    }
    check_directory(root, &owner)?;
    let revision: String =
        serde_json::from_slice(&io::regular(&pointer, 1024)?).map_err(invalid)?;
    if !is_revision(&revision) {
        return Err(invalid("invalid tab revision pointer"));
    }
    let dir = owner.join(revision).join(id);
    check_directory(root, &dir)?;
    Ok(Some(dir))
}
/// A revision directory name: a lowercase SHA-256.
fn is_revision(name: &str) -> bool {
    name.len() == 64
        && name
            .bytes()
            .all(|b| b.is_ascii_hexdigit() && !b.is_ascii_uppercase())
}
pub fn ids(root: &Path) -> Result<Vec<String>, AppError> {
    if !root.try_exists().map_err(invalid)? {
        return Ok(Vec::new());
    }
    check_directory(root, root)?;
    let mut ids = Vec::new();
    for entry in std::fs::read_dir(root).map_err(invalid)? {
        let id = entry
            .map_err(invalid)?
            .file_name()
            .to_string_lossy()
            .to_string();
        if id.starts_with('.') {
            continue;
        }
        match owner(root, &id)?.join(ACTIVE).symlink_metadata() {
            Ok(_) => ids.push(id),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(error) => return Err(invalid(error)),
        }
    }
    Ok(ids)
}
/// The active revision of `id`, verified.
pub fn read(root: &Path, id: &str) -> Result<VerifiedRevision, AppError> {
    let lease = lease(root, id)?.ok_or_else(|| invalid("managed tab is not installed"))?;
    lease.read()
}
/// The update staged beside `id`, verified, if one awaits review.
pub fn read_pending(root: &Path, id: &str) -> Result<Option<VerifiedRevision>, AppError> {
    lease_pending(root, id)?
        .map(|lease| lease.read())
        .transpose()
}

/// A revision as read back from disk, every byte checked against its proof.
pub(super) struct Trusted {
    pub files: BTreeMap<String, Vec<u8>>,
    pub revision: VerifiedRevision,
    /// `backend.tar.gz`, when the revision has a backend.
    pub backend_archive: Option<PathBuf>,
}
#[cfg(test)]
pub(super) fn read_trusted(
    root: &Path,
    id: &str,
    trust: &crate::domain::agents::providers::installed::managed::trust::ManagedTrustStore,
) -> Result<Trusted, AppError> {
    let dir = directory(root, id)?.ok_or_else(|| invalid("managed tab is not installed"))?;
    read_trusted_directory(root, id, &dir, trust)
}
pub(super) fn read_trusted_directory(
    root: &Path,
    id: &str,
    dir: &Path,
    trust: &crate::domain::agents::providers::installed::managed::trust::ManagedTrustStore,
) -> Result<Trusted, AppError> {
    check_directory(root, dir)?;
    let revision = dir.parent().ok_or_else(|| invalid("revision missing"))?;
    let receipt: Receipt =
        serde_json::from_slice(&io::regular(&revision.join(RECEIPT), LIMIT + 64 * 1024)?)
            .map_err(invalid)?;
    if receipt.id != id {
        return Err(invalid("tab receipt identity mismatch"));
    }
    catalog::verify(&receipt.index, trust, true)?;
    let package = catalog::resolve_kind(&receipt.index, id, &receipt.version, "tab")?;
    let archive = io::regular(&revision.join(WEB_ARCHIVE), LIMIT)?;
    let archive_sha256 = io::digest(&archive);
    if package["tab"]["distribution"]["sha256"].as_str() != Some(archive_sha256.as_str()) {
        return Err(invalid("tab archive checksum mismatch"));
    }
    let files = cadencr_registry_core::read_tab_archive_bytes(&archive).map_err(invalid)?;
    let (manifest, signed) = verify_package(&package, &files)?;
    let backend = backend::verify_installed(revision, dir, &receipt, signed.as_ref())?;
    let name = revision_id(
        &archive_sha256,
        backend
            .as_ref()
            .map(|backend| backend.archive_sha256.as_str()),
    );
    if revision.file_name().and_then(|name| name.to_str()) != Some(name.as_str()) {
        return Err(invalid("tab revision identity mismatch"));
    }
    for (name, bytes) in &files {
        if io::regular(&dir.join(name), LIMIT)? != *bytes {
            return Err(invalid("installed tab payload changed"));
        }
    }
    Ok(Trusted {
        files,
        backend_archive: backend.is_some().then(|| revision.join(backend::ARCHIVE)),
        revision: VerifiedRevision {
            manifest,
            facts: ManagedFacts {
                revision: name,
                archive_sha256,
                backend,
            },
        },
    })
}
/// The signed package's manifest, bound to its native backend if it ships one.
pub fn verify_package(
    package: &serde_json::Value,
    files: &BTreeMap<String, Vec<u8>>,
) -> Result<(TabManifest, Option<SignedTabBackend>), AppError> {
    cadencr_registry_core::validate_tab_package_binding(package, files).map_err(invalid)
}

#[cfg(test)]
pub use fixtures::commit;

fn validate_pointer(path: &Path) -> Result<(), AppError> {
    let pointer: String = serde_json::from_slice(&io::regular(path, 1024)?).map_err(invalid)?;
    if !is_revision(&pointer) {
        return Err(invalid(
            "invalid tab revision pointer; unknown file preserved",
        ));
    }
    Ok(())
}

/// Uninstall only the pointers and recognized, unleased managed artifacts.
pub fn deactivate(root: &Path, id: &str) -> Result<(), AppError> {
    let cell = retention::owner_state(root, id)?;
    let state = cell.lock().map_err(invalid)?;
    let owned = owner(root, id)?;
    check_directory(root, &owned)?;
    validate_pointer(&owned.join(ACTIVE))?;
    pending::clear(&owned)?;
    std::fs::remove_file(owned.join(ACTIVE)).map_err(invalid)?;
    retention::collect(root, id, &state)?;
    retention::remove_empty_owner(root, id, &cell)
}

#[cfg(test)]
pub(super) mod tests {
    use super::fixtures::{self, backend_fixture, fixture};
    use super::*;
    use crate::domain::plugin_tabs::test_support::error_code;
    use cadencr_plugin_core::tab::TabPlatform;

    #[test]
    fn signed_revisions_preserve_payload_and_reject_forged_bytes() {
        let temp = tempfile::tempdir().unwrap();
        let (receipt, archive, files, trust) = fixture(temp.path());
        let root = temp.path().join("managed");
        commit(&root, &receipt, &archive, &files).unwrap();
        let trusted = read_trusted(&root, "graph", &trust).unwrap();
        assert_eq!(trusted.files, files);
        assert_eq!(trusted.revision.manifest.permissions, ["git:read"]);
        assert_eq!(trusted.revision.facts.backend, None);
        assert_eq!(
            trusted.revision.facts.revision, trusted.revision.facts.archive_sha256,
            "a UI-only revision keeps its archive-digest name"
        );
        let dir = directory(&root, "graph").unwrap().unwrap();
        // Published read-only: tampering takes the user restoring write access.
        assert!(std::fs::write(dir.join("dist/index.html"), "tampered").is_err() || is_root());
        fixtures::unseal_tree(dir.parent().unwrap());
        crate::shared::atomic_file::write_atomic_private(&dir.join("dist/index.html"), "tampered")
            .unwrap();
        assert!(read_trusted(&root, "graph", &trust).is_err());
        assert!(
            commit(&root, &receipt, &archive, &files).is_err(),
            "retained corrupted revision cannot be activated"
        );
        crate::shared::atomic_file::write_atomic_private(
            &dir.join("dist/index.html"),
            "<html>Graph</html>",
        )
        .unwrap();
        let mut forged = receipt;
        forged.index.signed.packages[0]["package"]["tab"]["name"] = serde_json::json!("Impostor");
        crate::shared::atomic_file::write_atomic_private(
            &dir.parent().unwrap().join("receipt.json"),
            &serde_json::to_string(&forged).unwrap(),
        )
        .unwrap();
        assert!(read_trusted(&root, "graph", &trust).is_err());
    }

    #[test]
    fn runtime_identity_and_paths_cannot_be_rebound() {
        let temp = tempfile::tempdir().unwrap();
        let (receipt, archive, files, _) = fixture(temp.path());
        let mut package = receipt.index.signed.packages[0]["package"].clone();
        package["tab"]["version"] = serde_json::json!("2.0.0");
        assert!(verify_package(&package, &files).is_err());
        let root = temp.path().join("managed");
        commit(&root, &receipt, &archive, &files).unwrap();
        for id in ["../graph", "self", "grants", "A"] {
            assert!(directory(&root, id).is_err());
        }
        crate::shared::atomic_file::write_atomic_private(
            &root.join("graph/active.json"),
            r#""../escape""#,
        )
        .unwrap();
        assert!(directory(&root, "graph").is_err());
    }

    #[test]
    fn tab_archive_storage_uses_the_tab_budget_instead_of_the_theme_budget() {
        let temp = tempfile::tempdir().unwrap();
        let (receipt, _, files, _) = fixture(temp.path());
        let root = temp.path().join("managed");
        let archive = vec![0; 20 * 1024 * 1024 + 1];
        commit(&root, &receipt, &archive, &files).unwrap();
        let dir = directory(&root, "graph").unwrap().unwrap();
        assert_eq!(
            io::regular(&dir.parent().unwrap().join("archive.tar.gz"), LIMIT).unwrap(),
            archive
        );
        let too_large = vec![0; LIMIT + 1];
        assert!(commit(&root, &receipt, &too_large, &files).is_err());
        assert_eq!(directory(&root, "graph").unwrap().unwrap(), dir);
    }

    #[test]
    fn unknown_database_at_control_paths_is_never_removed_or_replaced() {
        let temp = tempfile::tempdir().unwrap();
        let (receipt, archive, files, _) = fixture(temp.path());
        let root = temp.path().join("managed");
        commit(&root, &receipt, &archive, &files).unwrap();
        let pointer = root.join("graph/active.json");
        let proof = directory(&root, "graph")
            .unwrap()
            .unwrap()
            .parent()
            .unwrap()
            .join("receipt.json");
        let database = b"SQLite format 3\0precious";
        fixtures::unseal_tree(proof.parent().unwrap());
        std::fs::write(&proof, database).unwrap();
        assert!(commit(&root, &receipt, &archive, &files).is_err());
        assert_eq!(std::fs::read(proof).unwrap(), database);
        std::fs::write(&pointer, database).unwrap();
        assert!(deactivate(&root, "graph").is_err());
        assert_eq!(std::fs::read(pointer).unwrap(), database);
    }

    #[test]
    fn full_revision_history_still_allows_reusing_authenticated_bytes() {
        let temp = tempfile::tempdir().unwrap();
        let (receipt, archive, files, trust) = fixture(temp.path());
        let root = temp.path().join("managed");
        commit(&root, &receipt, &archive, &files).unwrap();
        let owner = owner(&root, "graph").unwrap();
        for revision in 0..15 {
            secure(&root, &owner.join(format!("{revision:064x}"))).unwrap();
        }
        assert_eq!(std::fs::read_dir(owner).unwrap().count(), 17);
        commit(&root, &receipt, &archive, &files).unwrap();
        read_trusted(&root, "graph", &trust).unwrap();
        assert!(commit(&root, &receipt, b"another revision", &files).is_err());
        read_trusted(&root, "graph", &trust).unwrap();
    }

    #[test]
    fn capacity_counts_active_tabs_and_retained_history_remains_reusable() {
        let temp = tempfile::tempdir().unwrap();
        let (receipt, archive, files, trust) = fixture(temp.path());
        let root = temp.path().join("managed");
        for number in 0..MAX_ACTIVE_TABS {
            let owner = owner(&root, &format!("retained-{number}")).unwrap();
            secure(&root, &owner).unwrap();
            write_file(&owner.join("active.json"), br#""unreadable""#).unwrap();
        }
        assert!(commit(&root, &receipt, &archive, &files).is_err());
        assert!(!root.join("graph").exists());
        assert_eq!(ids(&root).unwrap().len(), MAX_ACTIVE_TABS);
        for number in 0..MAX_ACTIVE_TABS {
            std::fs::remove_file(root.join(format!("retained-{number}/active.json"))).unwrap();
        }
        assert!(ids(&root).unwrap().is_empty());
        commit(&root, &receipt, &archive, &files).unwrap();
        assert_eq!(ids(&root).unwrap(), ["graph"]);
        read_trusted(&root, "graph", &trust).unwrap();
    }

    /// Root ignores permission bits: sealing cannot be observed.
    fn is_root() -> bool {
        #[cfg(unix)]
        return unsafe { libc::geteuid() } == 0;
        #[cfg(not(unix))]
        false
    }

    #[cfg(unix)]
    fn mode(path: &Path) -> u32 {
        use std::os::unix::fs::PermissionsExt as _;
        std::fs::metadata(path).unwrap().permissions().mode() & 0o777
    }

    #[test]
    fn a_backend_revision_stores_this_platforms_executable_beside_its_archive() {
        let temp = tempfile::tempdir().unwrap();
        let tab = backend_fixture().root(temp.path()).call();
        let root = temp.path().join("managed");
        let package = catalog::resolve_kind(&tab.receipt.index, "graph", "1.0.0", "tab").unwrap();
        let (_, signed) = verify_package(&package, &tab.files).unwrap();
        assert!(signed.is_some());
        tab.commit(&root, Activation::Activate).unwrap();
        let trusted = read_trusted(&root, "graph", &tab.trust).unwrap();
        let backend = trusted.revision.facts.backend.clone().unwrap();
        assert_eq!(Some(backend.platform), TabPlatform::current());
        assert_eq!(backend.executable_sha256, io::digest(&tab.executable));
        assert_eq!(backend.archive_sha256, io::digest(&tab.backend_archive));
        assert_eq!(
            trusted.revision.facts.revision,
            revision_id(
                &io::digest(&tab.archive),
                Some(&io::digest(&tab.backend_archive))
            )
        );
        // Only this platform's binary: the manifest's other paths stay absent.
        let dir = directory(&root, "graph").unwrap().unwrap();
        let executable = dir.join(&tab.cmd);
        assert_eq!(std::fs::read(&executable).unwrap(), tab.executable);
        #[cfg(unix)]
        {
            // A published revision is read-only, its owner included.
            assert_eq!(mode(&executable), 0o500);
            assert_eq!(mode(&dir.parent().unwrap().join("backend.tar.gz")), 0o400);
            assert_eq!(mode(&dir.join("tab.json")), 0o400);
            assert_eq!(mode(&dir), 0o500);
            assert_eq!(mode(dir.parent().unwrap()), 0o500);
        }
        assert!(!trusted.files.contains_key(&tab.cmd), "never a web asset");
        assert_ne!(
            trusted.revision.permissions_hash(),
            trusted.revision.manifest.permissions_hash(),
            "consent binds the signed binary"
        );
        // The folder report accepts a revision holding only this platform's binary.
        let report = cadencr_plugin_core::tab::inspect_tab_folder(&dir);
        assert!(report.valid_manifest().is_some(), "{:?}", report.findings);
        assert!(report.findings.warnings.is_empty(), "{:?}", report.findings);
        // The stored archive is part of the proof; the executable's bytes are
        // checked at launch, its shape here.
        let archive = dir.parent().unwrap().join("backend.tar.gz");
        fixtures::unseal_tree(dir.parent().unwrap());
        std::fs::remove_file(&archive).unwrap();
        write_file(&archive, b"forged").unwrap();
        assert!(read_trusted(&root, "graph", &tab.trust).is_err());
    }

    #[test]
    fn a_backend_package_needs_its_bound_archive_and_receipt_platform() {
        let temp = tempfile::tempdir().unwrap();
        let tab = backend_fixture()
            .root(temp.path())
            .also(vec![fixtures::other_platform()])
            .call();
        let root = temp.path().join("managed");
        let commit = |receipt: &Receipt, backend: Option<BackendPayload<'_>>| {
            commit_revision()
                .root(&root)
                .receipt(receipt)
                .archive(&tab.archive)
                .files(&tab.files)
                .maybe_backend(backend)
                .activation(Activation::Activate)
                .call()
        };
        assert!(
            commit(&tab.receipt, None).is_err(),
            "the binary is required"
        );
        let ui_only = Receipt {
            platform: None,
            ..serde_json::from_value(serde_json::to_value(&tab.receipt).unwrap()).unwrap()
        };
        assert!(commit(&ui_only, Some(tab.payload())).is_err());
        assert!(directory(&root, "graph").unwrap().is_none());
        // A tab.json declaring a backend the signed entry lacks never binds.
        let package = catalog::resolve_kind(&tab.receipt.index, "graph", "1.0.0", "tab").unwrap();
        let mut unsigned = package.clone();
        unsigned["tab"].as_object_mut().unwrap().remove("backend");
        unsigned["tab"]["distribution"]
            .as_object_mut()
            .unwrap()
            .remove("binary");
        assert!(verify_package(&unsigned, &tab.files).is_err());
        let (plain, _, files, _) = fixture(&temp.path().join("plain"));
        let plain_package = catalog::resolve_kind(&plain.index, "graph", "1.0.0", "tab").unwrap();
        let mut smuggled = plain_package.clone();
        smuggled["tab"]["backend"] = package["tab"]["backend"].clone();
        smuggled["tab"]["distribution"]["binary"] =
            package["tab"]["distribution"]["binary"].clone();
        assert!(verify_package(&smuggled, &files).is_err());
        assert!(verify_package(&plain_package, &files).unwrap().1.is_none());
    }

    #[test]
    fn staged_updates_wait_beside_the_active_revision_until_promoted_or_discarded() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().join("managed");
        let revision = |number: usize| {
            fixtures::backend_revision(&temp.path().join(format!("fixture-{number}")), number)
        };
        let commit = |tab: &fixtures::BackendFixture, activation| tab.commit(&root, activation);
        let first = revision(0);
        assert!(
            commit(&first, Activation::Stage).is_err(),
            "nothing to stage beside"
        );
        commit(&first, Activation::Activate).unwrap();
        let active = directory(&root, "graph").unwrap().unwrap();
        let second = revision(1);
        commit(&second, Activation::Stage).unwrap();
        assert_eq!(directory(&root, "graph").unwrap().unwrap(), active);
        let staged = pending_directory(&root, "graph").unwrap().unwrap();
        assert_ne!(staged, active);
        let held = lease_pending(&root, "graph").unwrap().unwrap();
        let trusted =
            read_trusted_directory(&root, "graph", held.directory(), &first.trust).unwrap();
        assert_eq!(trusted.revision.manifest.version, "1.0.1");
        drop(held);
        // A stale review cannot promote whatever replaced it.
        let third = revision(2);
        commit(&third, Activation::Stage).unwrap();
        let name = |dir: &Path| {
            dir.parent()
                .unwrap()
                .file_name()
                .unwrap()
                .to_string_lossy()
                .into_owned()
        };
        assert_eq!(
            error_code(&promote_pending(&root, "graph", &name(&staged)).unwrap_err()),
            "MANAGED_TAB_UPDATE_CHANGED"
        );
        let staged = pending_directory(&root, "graph").unwrap().unwrap();
        promote_pending(&root, "graph", &name(&staged)).unwrap();
        assert_eq!(directory(&root, "graph").unwrap().unwrap(), staged);
        assert!(pending_directory(&root, "graph").unwrap().is_none());
        assert!(
            !active.exists(),
            "the unleased previous revision is reclaimed"
        );
        // Discard drops the staged revision and keeps the active one.
        commit(&revision(3), Activation::Stage).unwrap();
        let discarded = pending_directory(&root, "graph").unwrap().unwrap();
        discard_pending(&root, "graph").unwrap();
        assert!(!discarded.exists());
        assert_eq!(
            error_code(&discard_pending(&root, "graph").unwrap_err()),
            "MANAGED_TAB_UPDATE_NOT_FOUND"
        );
        // An activation supersedes a staged update; uninstall removes both.
        commit(&revision(4), Activation::Stage).unwrap();
        commit(&revision(5), Activation::Activate).unwrap();
        assert!(pending_directory(&root, "graph").unwrap().is_none());
        commit(&revision(6), Activation::Stage).unwrap();
        deactivate(&root, "graph").unwrap();
        assert!(!root.join("graph").exists());
    }
}
