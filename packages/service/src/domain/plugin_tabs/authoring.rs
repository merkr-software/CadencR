//! **Settings → Custom tabs → Create** (`docs/CUSTOM_TABS.md` §8).
//!
//! 1. Derive a unique id from the name, create `<tabs>/<id>/`, write the
//!    scaffold, `git init` and commit it. A failure here removes the folder
//!    this request created, so no half-built tab is left behind.
//! 2. Record consent for the scaffold's permissions.
//! 3. Create the authoring project and its conversation (`workspace::ensure_for`).
//! 4. Enable the tab for that project, so the author sees it working before
//!    writing a line.
//!
//! The folder outlives a failure in steps 2–4: the error names the retry
//! (`POST /api/plugin-tabs/{id}/workspace`, [`open`]) instead of pretending
//! the whole setup is atomic. Step 2 marks the setup pending until step 4 (or
//! any later availability choice) settles it, so the retry can tell an
//! interrupted creation from a folder copied in by hand or a tab the user
//! switched back to Inherit.

use std::collections::HashSet;
use std::path::{Path, PathBuf};

use axum::http::StatusCode;
use cadencr_plugin_core::tab::{is_valid_tab_id, validate_manifest, TabManifest, RESERVED_IDS};
use sqlx::SqlitePool;

use super::models::{CreatePluginTabRequest, PluginTabWorkspace};
use super::scaffold::{self, ScaffoldInput};
use super::workspace::{self, COMMIT_EMAIL, INITIAL_COMMIT_MESSAGE};
use super::{consent, enablement, paths, registry};
use crate::error::AppError;
use crate::shared::git_cli::ensure_repository_with_initial_commit;
use crate::shared::slug::slugify;

const FALLBACK_ID: &str = "custom-tab";
const MAX_ATTEMPTS: usize = 1000;

pub async fn create(
    pool: &SqlitePool,
    request: &CreatePluginTabRequest,
) -> Result<PluginTabWorkspace, AppError> {
    let name = request.name.trim();
    let description = request.description.as_deref().map(str::trim);
    let base = base_id(name);
    // The request is checked by the very rules the folder will be: a name or
    // description the manifest would reject never becomes a folder. The id is
    // ours and claimed below (`self` becomes `self-2`), so a placeholder that is
    // always valid stands in for it.
    check_manifest(&ScaffoldInput {
        id: FALLBACK_ID,
        name,
        description,
    })?;
    let root = paths::tabs_dir();
    crate::remote::secure_fs::create_dir_owner_only(&root).map_err(|error| {
        AppError::internal(format!("cannot create the custom tabs folder: {error}"))
    })?;
    let (id, dir) = claim_folder(pool, &root, &base, name).await?;
    let input = ScaffoldInput {
        id: &id,
        name,
        description,
    };
    if let Err(error) = populate(&dir, &input).await {
        return Err(discard(&dir, error).await);
    }
    finish(pool, &id).await.map_err(|error| {
        AppError::coded(
            StatusCode::CONFLICT,
            "PLUGIN_TAB_PROJECT_SETUP_FAILED",
            format!(
                "custom tab `{id}` was created at {}, but its project could not be prepared: {error}. \
                 Retry with POST /api/plugin-tabs/{id}/workspace",
                dir.display()
            ),
        )
    })
}

fn base_id(name: &str) -> String {
    let slug = slugify(name);
    if is_valid_tab_id(&slug) {
        slug
    } else {
        FALLBACK_ID.to_string()
    }
}

fn check_manifest(input: &ScaffoldInput<'_>) -> Result<(), AppError> {
    let manifest: TabManifest =
        serde_json::from_str(&scaffold::manifest(input)).map_err(|error| {
            AppError::internal(format!("the scaffold manifest is invalid: {error}"))
        })?;
    let findings = validate_manifest(&manifest);
    if findings.is_valid() {
        Ok(())
    } else {
        Err(invalid(findings.describe_errors()))
    }
}

async fn populate(dir: &Path, input: &ScaffoldInput<'_>) -> Result<(), AppError> {
    scaffold::write(dir, input).await?;
    ensure_repository_with_initial_commit(dir, COMMIT_EMAIL, INITIAL_COMMIT_MESSAGE).await
}

/// Remove a folder this request created and could not finish, reporting a
/// removal that failed too rather than leaving it unexplained.
async fn discard(dir: &Path, error: AppError) -> AppError {
    match tokio::fs::remove_dir_all(dir).await {
        Ok(()) => error,
        Err(cleanup) => AppError::internal(format!(
            "{error}; the partial custom tab folder {} could not be removed: {cleanup}",
            dir.display()
        )),
    }
}

async fn finish(pool: &SqlitePool, id: &str) -> Result<PluginTabWorkspace, AppError> {
    let tab = registry::get(id).await?;
    let (_, hash) = tab.require_valid()?;
    consent::record_for_setup(pool, id, &hash).await?;
    let workspace = workspace::ensure_for(pool, &tab).await?;
    enablement::set(pool, &tab, Some(workspace.project_id), Some(true)).await?;
    Ok(workspace)
}

/// The tab's authoring project, created if missing ("Open project"), and the
/// retry of a creation that failed after consent ("Retry setup"): a tab whose
/// setup is still pending at its current permissions is turned on in its
/// project, as creation would have. A folder copied in by hand never had a
/// pending setup, and one the user already chose for keeps that choice, so
/// opening either enables nothing.
pub async fn open(pool: &SqlitePool, id: &str) -> Result<PluginTabWorkspace, AppError> {
    let tab = registry::get(id).await?;
    let workspace = workspace::ensure_for(pool, &tab).await?;
    let Ok((_, hash)) = tab.require_valid() else {
        return Ok(workspace);
    };
    if consent::setup_pending(pool, id, &hash).await? {
        enablement::set(pool, &tab, Some(workspace.project_id), Some(true)).await?;
    }
    Ok(workspace)
}

/// Create the first free `<base>`, `<base>-2`, … folder. `create_dir` (not
/// `create_dir_all`) is the claim: it fails when the folder exists, so two
/// concurrent creations can never share one. Ids an authoring project already
/// owns are skipped too, even if their folder was removed by hand.
async fn claim_folder(
    pool: &SqlitePool,
    root: &Path,
    base: &str,
    name: &str,
) -> Result<(String, PathBuf), AppError> {
    let owned = owned_ids(pool, base).await?;
    for attempt in 1..=MAX_ATTEMPTS {
        let id = if attempt == 1 {
            base.to_string()
        } else {
            format!("{base}-{attempt}")
        };
        if RESERVED_IDS.contains(&id.as_str())
            || owned.contains(&id)
            || super::managed::storage::directory(&super::managed::storage::root(), &id)?.is_some()
        {
            continue;
        }
        let dir = root.join(&id);
        match tokio::fs::create_dir(&dir).await {
            Ok(()) => return Ok((id, dir)),
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => continue,
            Err(error) => {
                return Err(AppError::internal(format!(
                    "cannot create {}: {error}",
                    dir.display()
                )))
            }
        }
    }
    Err(invalid(format!(
        "too many custom tabs are named like `{name}`"
    )))
}

/// The ids among `<base>` and `<base>-…` that a tab authoring project owns.
async fn owned_ids(pool: &SqlitePool, base: &str) -> Result<HashSet<String>, AppError> {
    let rows: Vec<String> = sqlx::query_scalar(
        "SELECT plugin_id FROM projects WHERE authoring_target = 'tab' \
         AND (plugin_id = ? OR substr(plugin_id, 1, ?) = ?)",
    )
    .bind(base)
    .bind(base.len() as i64 + 1)
    .bind(format!("{base}-"))
    .fetch_all(pool)
    .await?;
    Ok(rows.into_iter().collect())
}

fn invalid(message: String) -> AppError {
    AppError::coded(StatusCode::BAD_REQUEST, "PLUGIN_TAB_NAME_INVALID", message)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::domain::plugin_tabs::test_support::{pool, write_tab};
    use crate::shared::git_cli::run_git;

    fn request(name: &str) -> CreatePluginTabRequest {
        CreatePluginTabRequest {
            name: name.into(),
            description: Some("Graphs things".into()),
        }
    }

    #[tokio::test]
    async fn creates_a_committed_enabled_tab_with_its_project() {
        let pool = pool().await;
        let workspace = create(&pool, &request("Changed Files")).await.unwrap();
        assert_eq!(workspace.plugin_id, "changed-files");
        let dir = Path::new(&workspace.dir);
        assert!(dir.join("tab.json").is_file());
        assert!(dir.join("vendor/cadencr-tab-sdk.tgz").is_file());
        let log = run_git(&["log", "--oneline"], dir).await.unwrap();
        assert!(log.contains("New custom tab"), "{log}");
        let status = run_git(&["status", "--porcelain"], dir).await.unwrap();
        assert!(
            status.trim().is_empty(),
            "scaffold fully committed: {status}"
        );
        assert!(
            enablement::effective(&pool, "changed-files", workspace.project_id)
                .await
                .unwrap()
        );
        let tab = registry::get("changed-files").await.unwrap();
        let other = enablement::resolve(&pool, &tab, None).await.unwrap();
        assert_eq!(other.global, None, "enabled for its own project only");
    }

    #[tokio::test]
    async fn opening_finishes_an_interrupted_creation_only() {
        let pool = pool().await;
        // Creation consented, then failed before its project existed.
        write_tab("half", serde_json::json!({}));
        let half = registry::get("half").await.unwrap();
        consent::record_for_setup(&pool, "half", &half.require_valid().unwrap().1)
            .await
            .unwrap();
        let workspace = open(&pool, "half").await.unwrap();
        assert!(enablement::effective(&pool, "half", workspace.project_id)
            .await
            .unwrap());
        // A folder copied in by hand: its project opens, the tab stays off.
        write_tab("copied", serde_json::json!({}));
        let copied = open(&pool, "copied").await.unwrap();
        assert!(!enablement::effective(&pool, "copied", copied.project_id)
            .await
            .unwrap());
        // Consented by hand later: still not a creation to finish.
        let copied_tab = registry::get("copied").await.unwrap();
        consent::record(&pool, "copied", &copied_tab.require_valid().unwrap().1)
            .await
            .unwrap();
        open(&pool, "copied").await.unwrap();
        assert!(!enablement::effective(&pool, "copied", copied.project_id)
            .await
            .unwrap());
    }

    #[tokio::test]
    async fn opening_keeps_an_inherit_choice_made_after_creation() {
        let pool = pool().await;
        let workspace = create(&pool, &request("Inherited")).await.unwrap();
        let tab = registry::get("inherited").await.unwrap();
        // Inherit with no global switch: the last enablement row goes away.
        enablement::set(&pool, &tab, Some(workspace.project_id), None)
            .await
            .unwrap();
        open(&pool, "inherited").await.unwrap();
        let resolved = enablement::resolve(&pool, &tab, Some(workspace.project_id))
            .await
            .unwrap();
        assert_eq!((resolved.global, resolved.project), (None, None));
        assert!(!resolved.effective);
    }

    #[tokio::test]
    async fn ids_are_unique_and_never_reserved() {
        let pool = pool().await;
        let first = create(&pool, &request("Graph")).await.unwrap();
        let second = create(&pool, &request("graph")).await.unwrap();
        assert_eq!(
            (first.plugin_id.as_str(), second.plugin_id.as_str()),
            ("graph", "graph-2")
        );
        assert_ne!(first.project_id, second.project_id);
        assert_eq!(
            create(&pool, &request("Self")).await.unwrap().plugin_id,
            "self-2"
        );
        assert_eq!(
            create(&pool, &request("!!!")).await.unwrap().plugin_id,
            FALLBACK_ID
        );
        assert!(matches!(
            create(&pool, &request("  ")).await,
            Err(AppError::Coded {
                code: "PLUGIN_TAB_NAME_INVALID",
                ..
            })
        ));
    }

    #[tokio::test]
    async fn long_names_dedupe_into_valid_project_ids() {
        let pool = pool().await;
        let name = "a".repeat(60);
        let first = create(&pool, &request(&name)).await.unwrap();
        let second = create(&pool, &request(&name)).await.unwrap();
        assert_eq!(first.plugin_id, "a".repeat(50));
        assert_eq!(second.plugin_id, format!("{}-2", "a".repeat(50)));
        assert_ne!(first.project_id, second.project_id);
        let too_long = CreatePluginTabRequest {
            name: "Graph".into(),
            description: Some("d".repeat(281)),
        };
        assert!(matches!(
            create(&pool, &too_long).await,
            Err(AppError::Coded {
                code: "PLUGIN_TAB_NAME_INVALID",
                ..
            })
        ));
        assert!(!paths::tabs_dir().join("graph").exists());
    }

    #[tokio::test]
    async fn discarding_removes_the_partial_folder_and_keeps_the_error() {
        let root = tempfile::tempdir().unwrap();
        let dir = root.path().join("half");
        std::fs::create_dir_all(dir.join("src")).unwrap();
        std::fs::write(dir.join("tab.json"), "{}").unwrap();
        let error = discard(&dir, AppError::internal("disk full")).await;
        assert!(matches!(error, AppError::Internal(message) if message == "disk full"));
        assert!(!dir.exists());
    }

    #[tokio::test]
    async fn a_failed_project_setup_keeps_the_folder_and_names_the_retry() {
        let pool = pool().await;
        // An unrelated project already owns the folder the tab will get.
        std::fs::create_dir_all(paths::tabs_dir()).unwrap();
        let taken = paths::tabs_dir().canonicalize().unwrap().join("retained");
        sqlx::query("INSERT INTO projects (id, name, path) VALUES (77, 'Mine', ?)")
            .bind(taken.to_string_lossy().to_string())
            .execute(&pool)
            .await
            .unwrap();
        let error = create(&pool, &request("Retained")).await.unwrap_err();
        let AppError::Coded { code, message, .. } = error else {
            panic!("expected a coded error");
        };
        assert_eq!(code, "PLUGIN_TAB_PROJECT_SETUP_FAILED");
        assert!(
            message.contains("/api/plugin-tabs/retained/workspace"),
            "{message}"
        );
        assert!(paths::tabs_dir().join("retained/tab.json").is_file());
        sqlx::query("DELETE FROM projects WHERE id = 77")
            .execute(&pool)
            .await
            .unwrap();
        // "Retry setup" finishes the creation: the tab ends up on in its project.
        let retried = open(&pool, "retained").await.unwrap();
        assert_eq!(retried.plugin_id, "retained");
        assert!(enablement::effective(&pool, "retained", retried.project_id)
            .await
            .unwrap());
    }
}
