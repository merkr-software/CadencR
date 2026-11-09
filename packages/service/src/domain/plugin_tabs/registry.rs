//! The local tabs on disk: one validated folder report per `<tabs>/<id>/`.
//!
//! Stateless on purpose — every call rescans. Folders are few and small (the
//! manifest is bounded at 64 KiB, the icon at 32 KiB), and reading fresh means
//! an agent rewriting `tab.json` is reflected by the very next request with no
//! cache to invalidate. The watcher only tells clients *when* to ask.

use std::path::Path;

use axum::http::StatusCode;
use cadencr_plugin_core::tab::{
    inspect_signed_tab_folder, inspect_tab_folder, TabAccessLevel, TabFolderReport, TabManifest,
};

use super::managed::policy::PolicySnapshot;
use super::managed::storage::{ManagedFacts, RevisionLease};
use super::paths;
use crate::error::AppError;

mod current;
pub use current::{current_revision, CurrentRevision};

/// One custom tab folder as Cadencr sees it.
#[derive(Debug, Clone)]
pub struct LocalTab {
    /// The folder name, which a valid manifest's `id` equals.
    pub id: String,
    pub report: TabFolderReport,
    /// The verified marketplace revision `report` describes; `None` for a
    /// local tab or an unreadable revision.
    pub managed: Option<ManagedRevision>,
    /// A verified update staged beside it, awaiting the user's review.
    pub pending: Option<PendingTab>,
    /// Why Cadencr's signed revocation policy blocks this marketplace
    /// revision: it may not run (no grant, no backend), only be removed.
    pub blocked: Option<String>,
}

/// A verified marketplace revision, pinned on disk while this value lives:
/// it cannot be reclaimed under a reader or a running backend.
#[derive(Debug, Clone)]
pub struct ManagedRevision {
    /// Its signed facts, its backend binary among them.
    pub facts: ManagedFacts,
    pub lease: RevisionLease,
}

/// A staged marketplace update: what it would run once accepted.
#[derive(Debug, Clone)]
pub struct PendingTab {
    pub report: TabFolderReport,
    pub managed: ManagedRevision,
    /// Why the revocation policy blocks it: it cannot be accepted.
    pub blocked: Option<String>,
}

impl PendingTab {
    /// The hash accepting it records; `None` when its manifest is invalid.
    pub fn permissions_hash(&self) -> Option<String> {
        self.report.valid_manifest().map(|manifest| {
            manifest.permissions_hash_with_backend_digest(self.managed.facts.backend_digest())
        })
    }
}

/// The staged update a consent accepts.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AcceptedUpdate {
    /// Its revision directory name.
    pub revision: String,
    pub permissions_hash: String,
    /// How far the update reaches: what accepting it asks the user to trust.
    pub access_level: TabAccessLevel,
}

impl LocalTab {
    /// The staged update a consent for `submitted` accepts, when `submitted`
    /// is that update's (valid) permissions hash.
    pub fn pending_accepted_by(&self, submitted: &str) -> Option<AcceptedUpdate> {
        let pending = self.pending.as_ref()?;
        let manifest = pending.report.valid_manifest()?;
        let permissions_hash = pending.permissions_hash()?;
        (permissions_hash == submitted).then(|| AcceptedUpdate {
            revision: pending.managed.facts.revision.clone(),
            permissions_hash,
            access_level: manifest.access_level(),
        })
    }

    /// 403 `PLUGIN_TAB_BLOCKED` when the staged update is blocked.
    pub fn require_pending_not_blocked(&self) -> Result<(), AppError> {
        match self
            .pending
            .as_ref()
            .and_then(|pending| pending.blocked.as_ref())
        {
            Some(reason) => Err(super::managed::policy::blocked(&self.id, reason)),
            None => Ok(()),
        }
    }
}

impl LocalTab {
    /// The parsed manifest, even when it failed a rule.
    pub fn manifest(&self) -> Option<&TabManifest> {
        self.report.manifest.as_ref()
    }

    /// The manifest only when it passed every rule — the one a tab may run with.
    pub fn valid_manifest(&self) -> Option<&TabManifest> {
        self.report.valid_manifest()
    }

    /// Hash of the current permissions and origins (see `plugin-core::tab::hash`),
    /// a marketplace tab's signed backend digest included; `None` when
    /// `tab.json` could not be parsed.
    pub fn permissions_hash(&self) -> Option<String> {
        self.manifest()
            .map(|manifest| manifest.permissions_hash_with_backend_digest(self.backend_digest()))
    }

    fn backend_digest(&self) -> Option<&str> {
        self.facts().and_then(ManagedFacts::backend_digest)
    }

    /// A verified marketplace revision's signed facts.
    pub fn facts(&self) -> Option<&ManagedFacts> {
        self.managed.as_ref().map(|managed| &managed.facts)
    }

    /// Installed from the marketplace (under the managed root), not authored
    /// locally.
    pub fn is_managed(&self) -> bool {
        self.managed.is_some()
            || self
                .report
                .directory
                .starts_with(super::managed::storage::root())
    }

    /// The valid manifest and its hash: 403 `PLUGIN_TAB_BLOCKED` for a
    /// revision the revocation policy blocks, else 422 `PLUGIN_TAB_INVALID`
    /// for an invalid manifest. Every grant and backend path goes through it.
    pub fn require_valid(&self) -> Result<(&TabManifest, String), AppError> {
        if let Some(reason) = &self.blocked {
            return Err(super::managed::policy::blocked(&self.id, reason));
        }
        let manifest = self.valid_manifest().ok_or_else(|| {
            AppError::coded(
                StatusCode::UNPROCESSABLE_ENTITY,
                "PLUGIN_TAB_INVALID",
                format!(
                    "custom tab `{}` has an invalid tab.json: {}",
                    self.id,
                    self.report.findings.describe_errors()
                ),
            )
        })?;
        Ok((
            manifest,
            manifest.permissions_hash_with_backend_digest(self.backend_digest()),
        ))
    }

    /// A local tab with no marketplace facts.
    fn local(id: String, report: TabFolderReport) -> Self {
        Self {
            id,
            report,
            managed: None,
            pending: None,
            blocked: None,
        }
    }
}

/// Every tab folder, sorted by id. Dot-folders are skipped; anything else that
/// is a directory is listed, valid or not, so a broken tab is visible.
pub async fn list() -> Result<Vec<LocalTab>, AppError> {
    let root = paths::tabs_dir();
    let managed_root = super::managed::storage::root();
    // Read here: every tab is judged by one policy.
    let policy = super::managed::policy::current()?;
    tokio::task::spawn_blocking(move || {
        let mut tabs = scan(&root)?;
        for id in super::managed::storage::ids(&managed_root)? {
            if tabs.iter().any(|tab| tab.id == id) {
                continue;
            }
            let tab = match super::managed::storage::lease(&managed_root, &id) {
                Ok(None) => continue,
                Ok(Some(lease)) => match lease.read() {
                    Ok(revision) => managed_tab(&managed_root, &policy, id, lease, revision.facts),
                    Err(error) => {
                        let report = unavailable_report(lease.directory().to_owned(), error);
                        LocalTab::local(id, report)
                    }
                },
                Err(error) => {
                    let owner = super::managed::storage::owner(&managed_root, &id)?;
                    LocalTab::local(id, unavailable_report(owner, error))
                }
            };
            tabs.push(tab);
        }
        tabs.sort_by(|a, b| a.id.cmp(&b.id));
        Ok(tabs)
    })
    .await
    .map_err(|error| AppError::internal(format!("custom tab scan failed: {error}")))?
}

/// A verified marketplace revision, with its staged update if one verifies.
/// A staged update that does not is a warning on the installed tab.
fn managed_tab(
    root: &Path,
    policy: &PolicySnapshot,
    id: String,
    lease: RevisionLease,
    facts: ManagedFacts,
) -> LocalTab {
    let mut tab = installed_tab(policy, id, lease, facts);
    match pending_tab(root, policy, &tab.id) {
        Ok(pending) => tab.pending = pending,
        Err(error) => {
            tab.report
                .findings
                .warnings
                .push(cadencr_plugin_core::tab::TabIssue::document(
                    cadencr_plugin_core::tab::TabIssueCode::ManifestUnreadable,
                    format!("the staged update cannot be verified: {error}"),
                ))
        }
    }
    tab
}

/// A verified marketplace revision alone, its staged update unread.
fn installed_tab(
    policy: &PolicySnapshot,
    id: String,
    lease: RevisionLease,
    facts: ManagedFacts,
) -> LocalTab {
    let report = inspect_signed_tab_folder(lease.directory());
    let blocked = report
        .manifest
        .as_ref()
        .and_then(|manifest| policy.installed_blocked_reason(&id, &manifest.version, &facts));
    LocalTab {
        id,
        report,
        managed: Some(ManagedRevision { facts, lease }),
        pending: None,
        blocked,
    }
}

/// The verified update staged beside tab `id`, if any.
fn pending_tab(
    root: &Path,
    policy: &PolicySnapshot,
    id: &str,
) -> Result<Option<PendingTab>, AppError> {
    let Some(lease) = super::managed::storage::lease_pending(root, id)? else {
        return Ok(None);
    };
    let revision = lease.read()?;
    Ok(Some(PendingTab {
        blocked: policy.installed_blocked_reason(id, &revision.manifest.version, &revision.facts),
        report: inspect_signed_tab_folder(lease.directory()),
        managed: ManagedRevision {
            facts: revision.facts,
            lease,
        },
    }))
}

fn unavailable_report(directory: std::path::PathBuf, error: AppError) -> TabFolderReport {
    use cadencr_plugin_core::tab::{TabFindings, TabIssue, TabIssueCode};
    TabFolderReport {
        directory,
        manifest: None,
        icon_svg: None,
        entry_present: false,
        findings: TabFindings {
            errors: vec![TabIssue::document(
                TabIssueCode::ManifestUnreadable,
                error.to_string(),
            )],
            warnings: Vec::new(),
        },
    }
}

/// One tab by id, with its staged update; `PLUGIN_TAB_NOT_FOUND` when its
/// folder does not exist.
pub async fn get(id: &str) -> Result<LocalTab, AppError> {
    read(id, Staged::Read).await
}

/// [`get`] without the staged update: what a tab's own requests run with.
pub async fn get_installed(id: &str) -> Result<LocalTab, AppError> {
    read(id, Staged::Skip).await
}

/// Whether [`read`] looks at a marketplace tab's staged update.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Staged {
    Read,
    Skip,
}

async fn read(id: &str, staged: Staged) -> Result<LocalTab, AppError> {
    let local_root = paths::tabs_dir();
    let managed_root = super::managed::storage::root();
    let policy = super::managed::policy::current()?;
    let id = id.to_string();
    tokio::task::spawn_blocking(move || {
        let selected = paths::resolve_plugin_directory()
            .id(&id)
            .local_root(&local_root)
            .managed_root(&managed_root)
            .call()?;
        if let paths::PluginDirectory::Managed(lease) = selected {
            let facts = lease.read()?.facts;
            return Ok(match staged {
                Staged::Read => managed_tab(&managed_root, &policy, id, lease, facts),
                Staged::Skip => installed_tab(&policy, id, lease, facts),
            });
        }
        let dir = selected.directory();
        if !dir.is_dir() {
            return Err(not_found(&id));
        }
        Ok(LocalTab::local(id, inspect_tab_folder(dir)))
    })
    .await
    .map_err(|error| AppError::internal(format!("custom tab read failed: {error}")))?
}

pub fn not_found(id: &str) -> AppError {
    AppError::coded(
        StatusCode::NOT_FOUND,
        "PLUGIN_TAB_NOT_FOUND",
        format!("no custom tab `{id}`"),
    )
}

fn scan(root: &Path) -> Result<Vec<LocalTab>, AppError> {
    let entries = match std::fs::read_dir(root) {
        Ok(entries) => entries,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(error) => {
            return Err(AppError::internal(format!(
                "cannot read the custom tabs folder {}: {error}",
                root.display()
            )))
        }
    };
    let mut tabs = Vec::new();
    for entry in entries {
        let entry = entry.map_err(|error| {
            AppError::internal(format!("cannot read the custom tabs folder: {error}"))
        })?;
        let Some(id) = entry.file_name().to_str().map(str::to_string) else {
            continue;
        };
        if id.starts_with('.') || !entry.path().is_dir() {
            continue;
        }
        tabs.push(LocalTab::local(id, inspect_tab_folder(&entry.path())));
    }
    tabs.sort_by(|a, b| a.id.cmp(&b.id));
    Ok(tabs)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::domain::plugin_tabs::test_support::write_tab;

    #[tokio::test]
    async fn lists_valid_and_invalid_folders_and_skips_dot_folders() {
        assert!(
            list().await.unwrap().is_empty(),
            "missing root lists nothing"
        );
        write_tab("graph", serde_json::json!({}));
        write_tab("broken", serde_json::json!({"id": "other"}));
        std::fs::create_dir_all(paths::tabs_dir().join(".trash")).unwrap();
        std::fs::write(paths::tabs_dir().join("stray.txt"), "x").unwrap();
        let tabs = list().await.unwrap();
        let ids: Vec<&str> = tabs.iter().map(|tab| tab.id.as_str()).collect();
        assert_eq!(ids, ["broken", "graph"]);
        assert!(tabs[0].valid_manifest().is_none());
        assert!(tabs[0].require_valid().is_err());
        assert!(tabs[1].require_valid().is_ok());
    }

    #[tokio::test]
    async fn get_distinguishes_missing_from_invalid_ids() {
        write_tab("graph", serde_json::json!({}));
        assert_eq!(get("graph").await.unwrap().id, "graph");
        assert!(matches!(
            get("absent").await,
            Err(AppError::Coded {
                code: "PLUGIN_TAB_NOT_FOUND",
                ..
            })
        ));
        assert!(matches!(
            get("../graph").await,
            Err(AppError::Coded {
                code: "PLUGIN_TAB_ID_INVALID",
                ..
            })
        ));
    }
    #[tokio::test]
    async fn a_broken_marketplace_revision_does_not_hide_local_tabs() {
        write_tab("local", serde_json::json!({}));
        let root = super::super::managed::storage::root();
        let owner = super::super::managed::storage::owner(&root, "broken").unwrap();
        super::super::managed::storage::secure(&root, &owner).unwrap();
        super::super::managed::storage::write_file(
            &owner.join("active.json"),
            br#""invalid-revision""#,
        )
        .unwrap();
        let tabs = list().await.unwrap();
        assert_eq!(tabs.len(), 2);
        assert!(tabs
            .iter()
            .find(|tab| tab.id == "local")
            .unwrap()
            .valid_manifest()
            .is_some());
        let broken = tabs.iter().find(|tab| tab.id == "broken").unwrap();
        assert!(broken.valid_manifest().is_none());
        assert!(!broken.report.findings.errors.is_empty());
    }

    #[test]
    fn inspection_lease_keeps_the_selected_manifest_across_updates_and_removal() {
        use super::super::managed::storage::{self, fixtures::fixture_revision};
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().join("managed");
        let install = |revision| {
            let (receipt, archive, files, _) =
                fixture_revision(&temp.path().join(format!("fixture-{revision}")), revision);
            storage::commit(&root, &receipt, &archive, &files).unwrap();
        };
        install(0);
        let selected = storage::lease(&root, "graph").unwrap().unwrap();
        install(1);
        install(2);
        storage::deactivate(&root, "graph").unwrap();
        let report = inspect_tab_folder(selected.directory());
        assert_eq!(report.valid_manifest().unwrap().version, "1.0.0");
        let old = selected.directory().to_owned();
        drop(selected);
        install(3);
        assert!(!old.exists());
    }

    #[tokio::test]
    async fn a_marketplace_backend_tab_carries_its_signed_facts_and_staged_update() {
        use super::super::managed::storage::{self, fixtures::backend_fixture, Activation};
        use cadencr_plugin_core::tab::{test_support::native_executable, TabPlatform};
        let root = storage::root();
        let temp = tempfile::tempdir().unwrap();
        let version = |number: usize, extra: &[u8]| {
            let mut executable = native_executable(TabPlatform::current().unwrap());
            executable.extend_from_slice(extra);
            backend_fixture()
                .root(&temp.path().join(format!("v{number}")))
                .revision(number)
                .executable(executable)
                .call()
        };
        let (first, second) = (version(0, b"one"), version(1, b"two"));
        for (tab, activation) in [(&first, Activation::Activate), (&second, Activation::Stage)] {
            storage::commit_revision()
                .root(&root)
                .receipt(&tab.receipt)
                .archive(&tab.archive)
                .files(&tab.files)
                .backend(tab.payload())
                .activation(activation)
                .call()
                .unwrap();
        }
        let tab = get("graph").await.unwrap();
        assert!(tab.is_managed());
        let backend = tab.facts().unwrap().backend.as_ref().unwrap();
        assert_eq!(
            backend.executable_sha256,
            crate::domain::themes::managed::storage::digest(&first.executable)
        );
        let (manifest, current) = tab.require_valid().unwrap();
        assert_eq!(manifest.version, "1.0.0");
        assert_eq!(tab.permissions_hash().as_deref(), Some(current.as_str()));
        assert_ne!(
            current,
            manifest.permissions_hash(),
            "the signed digest is bound"
        );
        let staged = tab.pending.as_ref().unwrap();
        let staged_hash = staged.permissions_hash().unwrap();
        assert_eq!(staged.report.valid_manifest().unwrap().version, "1.0.1");
        assert_ne!(staged_hash, current, "a new binary is a new hash");
        assert_eq!(tab.pending_accepted_by(&current), None);
        let AcceptedUpdate {
            revision,
            permissions_hash: accepted,
            access_level,
        } = tab.pending_accepted_by(&staged_hash).unwrap();
        assert_eq!(accepted, staged_hash);
        assert_eq!(access_level, TabAccessLevel::Backend);
        // The listing sees the same tab.
        let listed = list().await.unwrap();
        assert_eq!(
            listed[0].pending.as_ref().unwrap().managed.facts.revision,
            revision
        );
        // Grants minted for the old hash go stale once it is promoted.
        let grants = super::super::grants::GrantStore::default();
        grants.mint(
            super::super::grants::GrantRequest::builder()
                .plugin_id("graph".into())
                .project_id(1)
                .feature_id(2)
                .scopes(vec![])
                .permissions_hash(current.clone())
                .build(),
        );
        drop((tab, listed));
        super::super::managed::service::promote_pending("graph".into(), revision)
            .await
            .unwrap();
        let promoted = get("graph").await.unwrap();
        let (manifest, hash) = promoted.require_valid().unwrap();
        assert_eq!(
            (manifest.version.as_str(), hash.as_str()),
            ("1.0.1", staged_hash.as_str())
        );
        assert!(promoted.pending.is_none());
        assert_eq!(grants.revoke_stale("graph", Some(&hash)), 1);
    }
}
