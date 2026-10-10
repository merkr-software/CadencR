use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::sync::OnceLock;

use axum::http::StatusCode;
use serde_json::Map;
use sqlx::SqlitePool;

use crate::domain::agents::providers::installed::descriptor::{
    validate_provider_id, AcpAgentEntry, HostInstallationSpec, LocalAssetsSpec,
    LocalExecutableSpec, ProviderDescriptor, SUPPORTED_SCHEMA_VERSION,
};
use crate::domain::agents::providers::installed::{descriptors_dir, lifecycle};
use crate::domain::agents::providers::provider_registry;
use crate::domain::agents::providers::registry::{
    builtin_provider_identifiers, provider_identifier_key,
};
use crate::domain::{features, projects, settings_store};
use crate::error::AppError;
use crate::shared::git_cli::{run_git, run_git_output_with_env, run_git_with_env};

use super::models::{CreateProviderWorkspaceRequest, ProviderWorkspace};
use super::scaffold;

mod import;
mod ownership;

const MAX_DISPLAY_NAME_LENGTH: usize = 80;
const WORKSPACES_DIR: &str = "provider-workspaces";
const PROVIDER_VERSION: &str = "0.1.0";
const WORKSPACE_ALREADY_EXISTS: &str = "PROVIDER_WORKSPACE_ALREADY_EXISTS";
const COMMIT_IDENTITY: [(&str, &str); 4] = [
    ("GIT_AUTHOR_NAME", "Cadencr"),
    ("GIT_AUTHOR_EMAIL", "providers@cadencr.local"),
    ("GIT_COMMITTER_NAME", "Cadencr"),
    ("GIT_COMMITTER_EMAIL", "providers@cadencr.local"),
];

pub(super) async fn create(
    pool: &SqlitePool,
    request: &CreateProviderWorkspaceRequest,
) -> Result<ProviderWorkspace, AppError> {
    let roots = WorkspaceRoots {
        workspaces: settings_store::dir::sibling_dir(WORKSPACES_DIR),
        descriptors: descriptors_dir(),
    };
    create_with_roots(pool, request, &roots).await
}

struct WorkspaceRoots {
    workspaces: PathBuf,
    descriptors: PathBuf,
}

async fn create_with_roots(
    pool: &SqlitePool,
    request: &CreateProviderWorkspaceRequest,
    roots: &WorkspaceRoots,
) -> Result<ProviderWorkspace, AppError> {
    let _guard = creation_lock().lock().await;
    let provider_id = request.provider_id.trim();
    validate_provider_id(provider_id).map_err(|error| {
        AppError::coded(StatusCode::BAD_REQUEST, error.code.as_str(), error.message)
    })?;
    let display_name = validate_display_name(&request.display_name)?;
    let active_provider_ids = provider_registry().provider_ids();
    let provider_key = provider_identifier_key(provider_id);
    let imported_directory = match request.directory.as_deref() {
        Some(directory) => {
            Some(import::validate_directory(directory, provider_binary_name()).await?)
        }
        None => None,
    };
    let importing = imported_directory.is_some();
    let resumable_directory = if imported_directory.is_some() {
        None
    } else {
        resumable_workspace_directory(&roots.workspaces, provider_id)?
    };
    let expected_directory = imported_directory
        .as_deref()
        .or(resumable_directory.as_deref());
    ownership::ensure_provider_identity_path(pool, provider_id, expected_directory).await?;
    if builtin_provider_identifiers()
        .iter()
        .any(|builtin| provider_identifier_key(builtin) == provider_key)
    {
        lifecycle::ensure_descriptor_id_available(
            &roots.descriptors,
            provider_id,
            &active_provider_ids,
        )?;
    }
    if expected_directory.is_none() {
        // New/unowned paths cannot be recovery attempts. Reject reserved and
        // externally installed identities before creating any filesystem entry.
        lifecycle::ensure_descriptor_id_available(
            &roots.descriptors,
            provider_id,
            &active_provider_ids,
        )?;
    }
    let directory = match imported_directory.as_ref() {
        Some(directory) => directory.clone(),
        None => ensure_workspace_directory(&roots.workspaces, provider_id)?,
    };
    let relative_executable = PathBuf::from("bin").join(provider_binary_name());
    let cwd = directory.to_string_lossy().into_owned();
    let executable = directory.join(&relative_executable);
    let expected_descriptor = descriptor(provider_id, &display_name, &directory, &executable);
    let owned_project_id =
        ownership::existing_owned_project_id(pool, &cwd, provider_id, !importing).await?;
    let owned_retry = owned_project_id.is_some()
        && descriptor_matches(&roots.descriptors, provider_id, &expected_descriptor)?;
    if expected_directory.is_some() && !owned_retry {
        lifecycle::ensure_descriptor_id_available(
            &roots.descriptors,
            provider_id,
            &active_provider_ids,
        )?;
    }

    if !importing {
        scaffold::write(&directory, provider_id, &display_name, &relative_executable)?;
        ensure_repository(&directory).await?;
    }

    let (project_id, feature_id) =
        ensure_project_and_feature(pool, owned_project_id, &display_name, &cwd, provider_id)
            .await?;
    // Publish the restart-gated descriptor last. Every earlier step is
    // idempotent, so an interrupted request can be retried without leaving an
    // identity that permanently blocks its own workspace.
    if !owned_retry {
        lifecycle::install_descriptor(
            &roots.descriptors,
            expected_descriptor,
            &active_provider_ids,
        )
        .await?;
    }

    Ok(ProviderWorkspace {
        project_id,
        feature_id,
    })
}

fn resumable_workspace_directory(
    root: &Path,
    provider_id: &str,
) -> Result<Option<PathBuf>, AppError> {
    let Ok(root) = std::fs::canonicalize(root) else {
        return Ok(None);
    };
    let directory = root.join(provider_id);
    if !directory.is_dir() || directory.is_symlink() {
        return Ok(None);
    }
    Ok(scaffold::can_resume(&directory, provider_id)?.then_some(directory))
}

fn descriptor_matches(
    directory: &Path,
    provider_id: &str,
    expected: &ProviderDescriptor,
) -> Result<bool, AppError> {
    let path = lifecycle::descriptor_path(directory, provider_id)?;
    if !path.is_file() {
        return Ok(false);
    }
    let actual: serde_json::Value = match std::fs::read(&path)
        .ok()
        .and_then(|bytes| serde_json::from_slice(&bytes).ok())
    {
        Some(actual) => actual,
        None => return Ok(false),
    };
    let expected = serde_json::to_value(expected).map_err(|error| {
        AppError::Internal(format!("failed to compare provider descriptor: {error}"))
    })?;
    Ok(actual == expected)
}

fn creation_lock() -> &'static tokio::sync::Mutex<()> {
    static LOCK: OnceLock<tokio::sync::Mutex<()>> = OnceLock::new();
    LOCK.get_or_init(|| tokio::sync::Mutex::new(()))
}

fn validate_display_name(value: &str) -> Result<String, AppError> {
    let value = value.trim();
    if value.is_empty() || value.chars().count() > MAX_DISPLAY_NAME_LENGTH {
        return Err(AppError::coded(
            StatusCode::BAD_REQUEST,
            "INVALID_PROVIDER_DISPLAY_NAME",
            format!("display name must contain 1 to {MAX_DISPLAY_NAME_LENGTH} characters"),
        ));
    }
    if value.chars().any(char::is_control) {
        return Err(AppError::coded(
            StatusCode::BAD_REQUEST,
            "INVALID_PROVIDER_DISPLAY_NAME",
            "display name must not contain control characters",
        ));
    }
    if value.contains(['/', '\\']) || value.contains("..") {
        return Err(AppError::coded(
            StatusCode::BAD_REQUEST,
            "INVALID_PROVIDER_DISPLAY_NAME",
            "display name must not contain path separators or '..'",
        ));
    }
    Ok(value.to_string())
}

fn ensure_workspace_directory(root: &Path, provider_id: &str) -> Result<PathBuf, AppError> {
    std::fs::create_dir_all(root).map_err(|error| {
        AppError::Internal(format!("failed to create provider workspace root: {error}"))
    })?;
    let root = std::fs::canonicalize(root).map_err(|error| {
        AppError::Internal(format!(
            "failed to resolve provider workspace root: {error}"
        ))
    })?;
    let directory = root.join(provider_id);
    match std::fs::create_dir(&directory) {
        Ok(()) => Ok(directory),
        Err(error)
            if error.kind() == std::io::ErrorKind::AlreadyExists
                && directory.is_dir()
                && !directory.is_symlink()
                && scaffold::can_resume(&directory, provider_id)? =>
        {
            Ok(directory)
        }
        Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => Err(AppError::coded(
            StatusCode::CONFLICT,
            WORKSPACE_ALREADY_EXISTS,
            format!("a provider workspace already exists for {provider_id:?}"),
        )),
        Err(error) => Err(AppError::Internal(format!(
            "failed to create provider workspace: {error}"
        ))),
    }
}

async fn ensure_repository(directory: &Path) -> Result<(), AppError> {
    if !directory.join(".git").exists() {
        run_git(&["init", "-q", "-b", "main"], directory).await?;
    }
    let head = run_git_output_with_env(&["rev-parse", "--verify", "HEAD"], directory, &[]).await?;
    if head.status.success() {
        return Ok(());
    }
    run_git(&["add", "-A"], directory).await?;
    run_git_with_env(
        &[
            "-c",
            "commit.gpgsign=false",
            "commit",
            "-qm",
            "Start provider connector",
        ],
        directory,
        &COMMIT_IDENTITY,
    )
    .await?;
    Ok(())
}

async fn ensure_project_and_feature(
    pool: &SqlitePool,
    existing_project_id: Option<i64>,
    display_name: &str,
    cwd: &str,
    provider_id: &str,
) -> Result<(i64, i64), AppError> {
    let project_id = match existing_project_id {
        Some(id) => id,
        None => {
            projects::service::create_author_project()
                .pool(pool)
                .name(&format!("Provider: {display_name}"))
                .path(cwd)
                .authoring_target(projects::models::ProjectAuthoringTarget::Provider)
                .plugin_id(provider_id)
                .call()
                .await?
                .id
        }
    };
    let feature_id: Option<i64> = sqlx::query_scalar(
        "SELECT id FROM features WHERE project_id = ? AND type = 'ws-session' ORDER BY id LIMIT 1",
    )
    .bind(project_id)
    .fetch_optional(pool)
    .await?;
    let feature_id = match feature_id {
        Some(id) => id,
        None => {
            features::service::create_feature_with_worktree(
                pool,
                project_id,
                Some(format!("Build {display_name} provider")),
                Some("ws-session".to_string()),
                None,
                None,
                None,
            )
            .await?
            .id
        }
    };
    Ok((project_id, feature_id))
}

fn descriptor(
    provider_id: &str,
    display_name: &str,
    directory: &Path,
    executable: &Path,
) -> ProviderDescriptor {
    ProviderDescriptor {
        schema_version: SUPPORTED_SCHEMA_VERSION,
        agent: AcpAgentEntry {
            id: provider_id.to_string(),
            name: display_name.to_string(),
            version: PROVIDER_VERSION.to_string(),
            description: format!("Developer-built {display_name} connector for Cadencr"),
            repository: None,
            website: None,
            authors: Vec::new(),
            license: None,
            // ACP Registry repositories own a root `icon.svg`. Keep that
            // portable relative reference; the host asset root below resolves
            // and inlines it without exposing a filesystem path to the UI.
            icon: Some("icon.svg".to_string()),
            distribution: None,
            extra: Map::new(),
        },
        installation: HostInstallationSpec {
            enabled: true,
            executable: Some(LocalExecutableSpec {
                command: executable.to_string_lossy().into_owned(),
                args: Vec::new(),
                env: BTreeMap::new(),
            }),
            assets: Some(LocalAssetsSpec {
                directory: directory.to_string_lossy().into_owned(),
            }),
        },
    }
}

fn provider_binary_name() -> &'static str {
    if cfg!(windows) {
        "provider.exe"
    } else {
        "provider"
    }
}

#[cfg(test)]
mod tests {
    use super::{
        create_with_roots, descriptor, provider_binary_name, validate_display_name,
        CreateProviderWorkspaceRequest, WorkspaceRoots,
    };
    use crate::domain::agents::providers::installed::descriptor::ProviderDescriptor;
    use crate::shared::git_cli::run_git;
    use sqlx::SqlitePool;
    use std::path::Path;
    use tempfile::TempDir;

    #[cfg(unix)]
    use std::os::unix::fs::PermissionsExt;

    #[test]
    fn descriptor_points_at_the_stable_build_output() {
        let descriptor = descriptor(
            "pi-connector",
            "Pi",
            Path::new("/tmp/pi"),
            Path::new("/tmp/pi/bin/provider"),
        );
        let executable = descriptor.installation.executable.unwrap();
        assert_eq!(executable.command, "/tmp/pi/bin/provider");
        assert_eq!(descriptor.agent.icon.as_deref(), Some("icon.svg"));
        assert_eq!(
            descriptor
                .installation
                .assets
                .as_ref()
                .map(|assets| assets.directory.as_str()),
            Some("/tmp/pi")
        );
        assert!(descriptor.agent.distribution.is_none());
        assert!(descriptor.agent.extra.is_empty());
    }

    #[test]
    fn display_names_are_bounded_and_single_line() {
        assert_eq!(validate_display_name("  Pi  ").unwrap(), "Pi");
        assert!(validate_display_name("").is_err());
        assert!(validate_display_name("Pi\nAgent").is_err());
        assert!(validate_display_name("Pi/Agent").is_err());
        assert!(validate_display_name("Pi..Agent").is_err());
        assert!(validate_display_name(&"x".repeat(81)).is_err());
    }

    #[tokio::test]
    async fn creates_an_ordinary_clean_project_and_local_descriptor() {
        let pool = test_pool().await;
        let temp = TempDir::new().unwrap();
        let roots = roots(&temp);
        let created = create_with_roots(
            &pool,
            &request("workspace-test-provider", "Workspace Test", None),
            &roots,
        )
        .await
        .unwrap();
        let directory =
            std::fs::canonicalize(roots.workspaces.join("workspace-test-provider")).unwrap();
        let executable = directory.join("bin").join(provider_binary_name());

        assert!(directory.join("README.md").is_file());
        assert!(directory.join("INSTRUCTION.md").is_file());
        assert!(directory.join(".git").is_dir());
        assert!(run_git(&["status", "--porcelain"], &directory)
            .await
            .unwrap()
            .trim()
            .is_empty());

        let project_marker: (String, Option<String>, Option<String>) =
            sqlx::query_as("SELECT kind, authoring_target, plugin_id FROM projects WHERE id = ?")
                .bind(created.project_id)
                .fetch_one(&pool)
                .await
                .unwrap();
        let feature: (String, i64) = sqlx::query_as(
            "SELECT type, (SELECT COUNT(*) FROM feature_settings WHERE feature_id = features.id) \
             FROM features WHERE id = ?",
        )
        .bind(created.feature_id)
        .fetch_one(&pool)
        .await
        .unwrap();
        assert_eq!(
            project_marker,
            (
                "user".to_string(),
                Some("provider".to_string()),
                Some("workspace-test-provider".to_string())
            )
        );
        assert_eq!(feature, ("ws-session".to_string(), 0));
        let repeated = create_with_roots(
            &pool,
            &request("workspace-test-provider", "Workspace Test", None),
            &roots,
        )
        .await
        .unwrap();
        assert_eq!(
            (repeated.project_id, repeated.feature_id),
            (created.project_id, created.feature_id)
        );

        let saved: ProviderDescriptor = serde_json::from_str(
            &std::fs::read_to_string(roots.descriptors.join("workspace-test-provider.json"))
                .unwrap(),
        )
        .unwrap();
        assert_eq!(
            saved.installation.executable.unwrap().command,
            executable.to_string_lossy()
        );
        assert!(!executable.exists());
    }

    #[tokio::test]
    async fn imports_an_existing_connector_without_changing_its_source() {
        let pool = test_pool().await;
        let temp = TempDir::new().unwrap();
        let roots = roots(&temp);
        let directory = existing_connector(&temp, "source").await;
        let original_status = git_status(&directory).await;
        let original_files = snapshot_files(&directory);

        let created = create_with_roots(
            &pool,
            &request(
                "imported-provider",
                "Imported",
                Some(directory.to_str().unwrap()),
            ),
            &roots,
        )
        .await
        .unwrap();

        let project: (String, String, Option<String>, Option<String>) = sqlx::query_as(
            "SELECT kind, path, authoring_target, plugin_id FROM projects WHERE id = ?",
        )
        .bind(created.project_id)
        .fetch_one(&pool)
        .await
        .unwrap();
        assert_eq!(project.0, "user");
        assert_eq!(project.1, directory.to_string_lossy());
        assert_eq!(project.2.as_deref(), Some("provider"));
        assert_eq!(project.3.as_deref(), Some("imported-provider"));
        assert_eq!(snapshot_files(&directory), original_files);
        assert_eq!(git_status(&directory).await, original_status);
        assert!(!directory.join("INSTRUCTION.md").exists());

        let repeated = create_with_roots(
            &pool,
            &request(
                "imported-provider",
                "Imported",
                Some(directory.to_str().unwrap()),
            ),
            &roots,
        )
        .await
        .unwrap();
        assert_eq!(repeated.project_id, created.project_id);
        assert_eq!(repeated.feature_id, created.feature_id);
    }

    #[tokio::test]
    async fn import_preserves_tracked_untracked_files_and_git_metadata() {
        let pool = test_pool().await;
        let temp = TempDir::new().unwrap();
        let roots = roots(&temp);
        let directory = existing_connector(&temp, "committed-source").await;
        run_git(&["add", "."], &directory).await.unwrap();
        run_git(
            &[
                "-c",
                "user.name=QA",
                "-c",
                "user.email=qa@example.test",
                "-c",
                "commit.gpgsign=false",
                "commit",
                "-qm",
                "fixture",
            ],
            &directory,
        )
        .await
        .unwrap();
        std::fs::write(directory.join("README.md"), "uncommitted edits").unwrap();
        std::fs::write(directory.join("local-only.txt"), "untracked source").unwrap();
        let before = snapshot_files(&directory);
        let request = request("preserved-import", "Preserved", directory.to_str());
        create_with_roots(&pool, &request, &roots).await.unwrap();
        assert_snapshot_unchanged(&directory, &before, "import");
        create_with_roots(&pool, &request, &roots).await.unwrap();
        assert_snapshot_unchanged(&directory, &before, "retry");
    }

    #[tokio::test]
    async fn import_rejects_invalid_paths_and_connectors() {
        let pool = test_pool().await;
        let temp = TempDir::new().unwrap();
        let roots = roots(&temp);
        assert!(create_with_roots(
            &pool,
            &request("relative-provider", "Relative", Some("relative")),
            &roots
        )
        .await
        .is_err());

        let not_git = temp.path().join("not-git");
        std::fs::create_dir(&not_git).unwrap();
        assert!(create_with_roots(
            &pool,
            &request(
                "not-git-provider",
                "Not Git",
                Some(not_git.to_str().unwrap())
            ),
            &roots,
        )
        .await
        .is_err());

        let missing = existing_repository(&temp, "missing").await;
        assert!(create_with_roots(
            &pool,
            &request(
                "missing-provider",
                "Missing",
                Some(missing.to_str().unwrap())
            ),
            &roots,
        )
        .await
        .is_err());

        #[cfg(unix)]
        {
            let non_executable = existing_repository(&temp, "non-executable").await;
            let binary = non_executable.join("bin/provider");
            std::fs::create_dir_all(binary.parent().unwrap()).unwrap();
            std::fs::write(&binary, "connector").unwrap();
            assert!(create_with_roots(
                &pool,
                &request(
                    "non-executable-provider",
                    "Non executable",
                    Some(non_executable.to_str().unwrap()),
                ),
                &roots,
            )
            .await
            .is_err());
        }
        let projects: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM projects")
            .fetch_one(&pool)
            .await
            .unwrap();
        assert_eq!(projects, 0);
    }

    #[tokio::test]
    async fn import_rejects_project_and_identity_collisions() {
        let pool = test_pool().await;
        let temp = TempDir::new().unwrap();
        let roots = roots(&temp);
        let directory = existing_connector(&temp, "collision").await;
        let cwd = directory.to_string_lossy().into_owned();
        crate::domain::projects::service::create_project(&pool, "Existing", &cwd)
            .await
            .unwrap();
        assert!(create_with_roots(
            &pool,
            &request("collision-provider", "Collision", Some(&cwd)),
            &roots
        )
        .await
        .is_err());

        let other = existing_connector(&temp, "other").await;
        let project = crate::domain::projects::service::create_project(
            &pool,
            "Claimed identity",
            &other.to_string_lossy(),
        )
        .await
        .unwrap();
        sqlx::query(
            "UPDATE projects SET authoring_target = 'provider', plugin_id = 'claimed-import' WHERE id = ?",
        )
        .bind(project.id)
        .execute(&pool)
        .await
        .unwrap();
        let candidate = existing_connector(&temp, "candidate").await;
        assert!(create_with_roots(
            &pool,
            &request(
                "claimed-import",
                "Claimed",
                Some(candidate.to_str().unwrap()),
            ),
            &roots,
        )
        .await
        .is_err());
        assert!(!roots.descriptors.join("claimed-import.json").exists());
    }

    #[tokio::test]
    async fn reserved_ids_are_refused_before_a_workspace_is_created() {
        let pool = test_pool().await;
        let temp = TempDir::new().unwrap();
        let roots = roots(&temp);
        assert!(
            create_with_roots(&pool, &request("claude", "Claude impostor", None), &roots)
                .await
                .is_err()
        );
        assert!(!roots.workspaces.join("claude").exists());
    }

    #[tokio::test]
    async fn a_forged_owned_workspace_cannot_claim_a_builtin_id() {
        let pool = test_pool().await;
        let temp = TempDir::new().unwrap();
        let roots = roots(&temp);
        let directory = roots.workspaces.join("claude");
        std::fs::create_dir_all(&directory).unwrap();
        std::fs::write(directory.join(".cadencr-provider-workspace"), "claude").unwrap();
        let cwd = std::fs::canonicalize(&directory)
            .unwrap()
            .to_string_lossy()
            .into_owned();
        let project = crate::domain::projects::service::create_project(
            &pool,
            "Provider: Forged Claude",
            &cwd,
        )
        .await
        .unwrap();
        sqlx::query(
            "UPDATE projects SET authoring_target = 'provider', plugin_id = 'claude' WHERE id = ?",
        )
        .bind(project.id)
        .execute(&pool)
        .await
        .unwrap();
        std::fs::create_dir_all(&roots.descriptors).unwrap();
        let forged = descriptor(
            "claude",
            "Forged Claude",
            &directory,
            &directory.join("bin").join(provider_binary_name()),
        );
        std::fs::write(
            roots.descriptors.join("claude.json"),
            serde_json::to_vec_pretty(&forged).unwrap(),
        )
        .unwrap();

        assert!(
            create_with_roots(&pool, &request("claude", "Forged Claude", None), &roots)
                .await
                .is_err()
        );
    }

    #[tokio::test]
    async fn retries_an_interrupted_workspace_without_duplicate_database_rows() {
        let pool = test_pool().await;
        let temp = TempDir::new().unwrap();
        let roots = roots(&temp);
        let directory = roots.workspaces.join("retry-provider");
        std::fs::create_dir_all(&directory).unwrap();
        let cwd = std::fs::canonicalize(&directory)
            .unwrap()
            .to_string_lossy()
            .into_owned();
        let project =
            crate::domain::projects::service::create_project(&pool, "Provider: Retry", &cwd)
                .await
                .unwrap();

        let created = create_with_roots(&pool, &request("retry-provider", "Retry", None), &roots)
            .await
            .unwrap();
        assert_eq!(created.project_id, project.id);
        let project_count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM projects WHERE path = ?")
            .bind(&cwd)
            .fetch_one(&pool)
            .await
            .unwrap();
        let feature_count: i64 =
            sqlx::query_scalar("SELECT COUNT(*) FROM features WHERE project_id = ?")
                .bind(project.id)
                .fetch_one(&pool)
                .await
                .unwrap();
        assert_eq!((project_count, feature_count), (1, 1));
        let marker: (Option<String>, Option<String>) =
            sqlx::query_as("SELECT authoring_target, plugin_id FROM projects WHERE id = ?")
                .bind(project.id)
                .fetch_one(&pool)
                .await
                .unwrap();
        assert_eq!(
            marker,
            (None, None),
            "legacy projects must not be backfilled"
        );
        let repeated = create_with_roots(&pool, &request("retry-provider", "Retry", None), &roots)
            .await
            .unwrap();
        assert_eq!(
            (repeated.project_id, repeated.feature_id),
            (created.project_id, created.feature_id)
        );
    }

    #[tokio::test]
    async fn retries_a_matching_marked_provider_project() {
        let pool = test_pool().await;
        let temp = TempDir::new().unwrap();
        let roots = roots(&temp);
        let directory = roots.workspaces.join("marked-provider");
        std::fs::create_dir_all(&directory).unwrap();
        let cwd = std::fs::canonicalize(&directory)
            .unwrap()
            .to_string_lossy()
            .into_owned();
        let project =
            crate::domain::projects::service::create_project(&pool, "Provider: Marked", &cwd)
                .await
                .unwrap();
        sqlx::query(
            "UPDATE projects SET authoring_target = 'provider', plugin_id = 'marked-provider' \
             WHERE id = ?",
        )
        .bind(project.id)
        .execute(&pool)
        .await
        .unwrap();

        let created = create_with_roots(&pool, &request("marked-provider", "Marked", None), &roots)
            .await
            .unwrap();
        assert_eq!(created.project_id, project.id);
    }

    #[tokio::test]
    async fn refuses_a_project_marked_for_another_authoring_identity() {
        let pool = test_pool().await;
        let temp = TempDir::new().unwrap();
        let roots = roots(&temp);
        let directory = roots.workspaces.join("conflicted-provider");
        std::fs::create_dir_all(&directory).unwrap();
        let cwd = std::fs::canonicalize(&directory)
            .unwrap()
            .to_string_lossy()
            .into_owned();
        let project =
            crate::domain::projects::service::create_project(&pool, "Provider: Conflicted", &cwd)
                .await
                .unwrap();
        sqlx::query(
            "UPDATE projects SET authoring_target = 'theme', plugin_id = 'other-theme' WHERE id = ?",
        )
        .bind(project.id)
        .execute(&pool)
        .await
        .unwrap();

        assert!(create_with_roots(
            &pool,
            &request("conflicted-provider", "Conflicted", None),
            &roots
        )
        .await
        .is_err());
        let marker: (Option<String>, Option<String>) =
            sqlx::query_as("SELECT authoring_target, plugin_id FROM projects WHERE id = ?")
                .bind(project.id)
                .fetch_one(&pool)
                .await
                .unwrap();
        assert_eq!(
            marker,
            (Some("theme".to_string()), Some("other-theme".to_string()))
        );
        assert!(!roots.descriptors.join("conflicted-provider.json").exists());
    }

    #[tokio::test]
    async fn refuses_a_provider_identity_owned_at_another_path_before_scaffolding() {
        let pool = test_pool().await;
        let temp = TempDir::new().unwrap();
        let roots = roots(&temp);
        let other_directory = temp.path().join("other-project");
        std::fs::create_dir_all(&other_directory).unwrap();
        let other_cwd = std::fs::canonicalize(&other_directory)
            .unwrap()
            .to_string_lossy()
            .into_owned();
        let project = crate::domain::projects::service::create_project(
            &pool,
            "Other provider project",
            &other_cwd,
        )
        .await
        .unwrap();
        sqlx::query(
            "UPDATE projects SET authoring_target = 'provider', plugin_id = 'claimed-provider' \
             WHERE id = ?",
        )
        .bind(project.id)
        .execute(&pool)
        .await
        .unwrap();

        assert!(
            create_with_roots(&pool, &request("claimed-provider", "Claimed", None), &roots)
                .await
                .is_err()
        );
        assert!(!roots.workspaces.join("claimed-provider").exists());
        assert!(!roots.descriptors.join("claimed-provider.json").exists());
    }

    #[tokio::test]
    async fn refuses_an_unowned_existing_directory() {
        let pool = test_pool().await;
        let temp = TempDir::new().unwrap();
        let roots = roots(&temp);
        let directory = roots.workspaces.join("occupied-provider");
        std::fs::create_dir_all(&directory).unwrap();
        std::fs::write(directory.join("user-file.txt"), "keep me").unwrap();

        assert!(create_with_roots(
            &pool,
            &request("occupied-provider", "Occupied", None),
            &roots
        )
        .await
        .is_err());
        assert_eq!(
            std::fs::read_to_string(directory.join("user-file.txt")).unwrap(),
            "keep me"
        );
    }

    #[tokio::test]
    async fn refuses_to_adopt_an_unrelated_installed_descriptor() {
        let pool = test_pool().await;
        let temp = TempDir::new().unwrap();
        let roots = roots(&temp);
        std::fs::create_dir_all(&roots.descriptors).unwrap();
        let external = descriptor(
            "external-provider",
            "External",
            Path::new("/tmp/external-provider"),
            Path::new("/tmp/external-provider/bin/provider"),
        );
        let descriptor_path = roots.descriptors.join("external-provider.json");
        let original = serde_json::to_vec_pretty(&external).unwrap();
        std::fs::write(&descriptor_path, &original).unwrap();

        assert!(create_with_roots(
            &pool,
            &request("external-provider", "External", None),
            &roots
        )
        .await
        .is_err());
        assert_eq!(std::fs::read(descriptor_path).unwrap(), original);
        let projects: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM projects")
            .fetch_one(&pool)
            .await
            .unwrap();
        assert_eq!(projects, 0);
    }

    fn roots(temp: &TempDir) -> WorkspaceRoots {
        WorkspaceRoots {
            workspaces: temp.path().join("provider-workspaces"),
            descriptors: temp.path().join("providers"),
        }
    }

    fn request(
        provider_id: &str,
        display_name: &str,
        directory: Option<&str>,
    ) -> CreateProviderWorkspaceRequest {
        CreateProviderWorkspaceRequest {
            provider_id: provider_id.to_string(),
            display_name: display_name.to_string(),
            directory: directory.map(str::to_string),
        }
    }

    async fn existing_repository(temp: &TempDir, name: &str) -> std::path::PathBuf {
        let directory = temp.path().join(name);
        std::fs::create_dir(&directory).unwrap();
        run_git(&["init", "-q", "-b", "main"], &directory)
            .await
            .unwrap();
        // Detached auto-maintenance after fixture commits races with snapshots
        // of .git, creating and removing objects/maintenance.lock.
        run_git(
            &["config", "--local", "maintenance.auto", "false"],
            &directory,
        )
        .await
        .unwrap();
        std::fs::canonicalize(directory).unwrap()
    }

    async fn existing_connector(temp: &TempDir, name: &str) -> std::path::PathBuf {
        let directory = existing_repository(temp, name).await;
        std::fs::write(directory.join("README.md"), "user-owned source").unwrap();
        let binary = directory.join("bin").join(provider_binary_name());
        std::fs::create_dir_all(binary.parent().unwrap()).unwrap();
        std::fs::write(&binary, "connector").unwrap();
        #[cfg(unix)]
        std::fs::set_permissions(&binary, std::fs::Permissions::from_mode(0o755)).unwrap();
        directory
    }

    async fn git_status(directory: &Path) -> String {
        let output = crate::shared::git_cli::run_git_output_with_env(
            &["status", "--porcelain", "--untracked-files=all"],
            directory,
            &[],
        )
        .await
        .unwrap();
        String::from_utf8(output.stdout).unwrap()
    }

    type FileSnapshot = std::collections::BTreeMap<std::path::PathBuf, (Vec<u8>, u32)>;

    fn assert_snapshot_unchanged(root: &Path, before: &FileSnapshot, phase: &str) {
        let after = snapshot_files(root);
        let changed: std::collections::BTreeSet<_> = before
            .keys()
            .chain(after.keys())
            .filter(|path| before.get(*path) != after.get(*path))
            .collect();
        // Git object bytes make assert_eq!'s full map dump exceed CI log limits.
        // Keep the same content/mode comparison, reporting only affected paths.
        assert!(
            changed.is_empty(),
            "{phase} changed {} paths: {:?}",
            changed.len(),
            changed.iter().take(20).collect::<Vec<_>>()
        );
    }

    fn snapshot_files(root: &Path) -> FileSnapshot {
        fn visit(
            root: &Path,
            directory: &Path,
            files: &mut std::collections::BTreeMap<std::path::PathBuf, (Vec<u8>, u32)>,
        ) {
            for entry in std::fs::read_dir(directory).unwrap() {
                let path = entry.unwrap().path();
                let metadata = std::fs::symlink_metadata(&path).unwrap();
                #[cfg(unix)]
                let mode = metadata.permissions().mode();
                #[cfg(not(unix))]
                let mode = u32::from(metadata.permissions().readonly());
                let content = if metadata.is_dir() {
                    visit(root, &path, files);
                    Vec::new()
                } else {
                    assert!(
                        metadata.is_file(),
                        "fixture contains an unexpected special file"
                    );
                    std::fs::read(&path).unwrap()
                };
                files.insert(
                    path.strip_prefix(root).unwrap().to_path_buf(),
                    (content, mode),
                );
            }
        }
        let mut files = std::collections::BTreeMap::new();
        visit(root, root, &mut files);
        files
    }

    async fn test_pool() -> SqlitePool {
        let pool = SqlitePool::connect("sqlite::memory:").await.unwrap();
        crate::shared::migrate::run_migrations(
            &crate::shared::migrate::MigrationContext::pool_only(&pool),
        )
        .await
        .unwrap();
        pool
    }
}
