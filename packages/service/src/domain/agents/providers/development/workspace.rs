use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::sync::OnceLock;

use axum::http::StatusCode;
use serde_json::Map;
use sqlx::SqlitePool;

use crate::domain::agents::providers::installed::descriptor::{
    validate_provider_id, AcpAgentEntry, HostInstallationSpec, LocalExecutableSpec,
    ProviderDescriptor, SUPPORTED_SCHEMA_VERSION,
};
use crate::domain::agents::providers::installed::{descriptors_dir, lifecycle};
use crate::domain::agents::providers::provider_registry;
use crate::domain::{features, projects, settings_store};
use crate::error::AppError;
use crate::shared::git_cli::{run_git, run_git_output_with_env, run_git_with_env};

use super::models::ProviderWorkspace;
use super::scaffold;

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
    provider_id: &str,
    display_name: &str,
) -> Result<ProviderWorkspace, AppError> {
    let roots = WorkspaceRoots {
        workspaces: settings_store::dir::sibling_dir(WORKSPACES_DIR),
        descriptors: descriptors_dir(),
    };
    create_with_roots(pool, provider_id, display_name, &roots).await
}

struct WorkspaceRoots {
    workspaces: PathBuf,
    descriptors: PathBuf,
}

async fn create_with_roots(
    pool: &SqlitePool,
    provider_id: &str,
    display_name: &str,
    roots: &WorkspaceRoots,
) -> Result<ProviderWorkspace, AppError> {
    let _guard = creation_lock().lock().await;
    let provider_id = provider_id.trim();
    validate_provider_id(provider_id).map_err(|error| {
        AppError::coded(StatusCode::BAD_REQUEST, error.code.as_str(), error.message)
    })?;
    let display_name = validate_display_name(display_name)?;
    let active_provider_ids = provider_registry().provider_ids();
    lifecycle::ensure_descriptor_id_available(
        &roots.descriptors,
        provider_id,
        &active_provider_ids,
    )?;
    let directory = ensure_workspace_directory(&roots.workspaces, provider_id)?;
    let relative_executable = PathBuf::from("bin").join(provider_binary_name());

    scaffold::write(&directory, provider_id, &display_name, &relative_executable)?;
    ensure_repository(&directory).await?;

    let cwd = directory.to_string_lossy().into_owned();
    let executable = directory.join(relative_executable);
    let (project_id, feature_id) = ensure_project_and_feature(pool, &display_name, &cwd).await?;
    // Publish the restart-gated descriptor last. Every earlier step is
    // idempotent, so an interrupted request can be retried without leaving an
    // identity that permanently blocks its own workspace.
    lifecycle::install_descriptor(
        &roots.descriptors,
        descriptor(provider_id, &display_name, &executable),
        &active_provider_ids,
    )
    .await?;

    Ok(ProviderWorkspace {
        project_id,
        feature_id,
    })
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
    std::fs::create_dir_all(&root).map_err(|error| {
        AppError::Internal(format!("failed to create provider workspace root: {error}"))
    })?;
    let root = std::fs::canonicalize(&root).map_err(|error| {
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
    display_name: &str,
    cwd: &str,
) -> Result<(i64, i64), AppError> {
    let project_id: Option<i64> =
        sqlx::query_scalar("SELECT id FROM projects WHERE path = ? AND kind = 'user'")
            .bind(cwd)
            .fetch_optional(pool)
            .await?;
    let project_id = match project_id {
        Some(id) => id,
        None => {
            projects::service::create_project(pool, &format!("Provider: {display_name}"), cwd)
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

fn descriptor(provider_id: &str, display_name: &str, executable: &Path) -> ProviderDescriptor {
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
            icon: None,
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
        create_with_roots, descriptor, provider_binary_name, validate_display_name, WorkspaceRoots,
    };
    use crate::domain::agents::providers::installed::descriptor::ProviderDescriptor;
    use crate::shared::git_cli::run_git;
    use sqlx::SqlitePool;
    use std::path::Path;
    use tempfile::TempDir;

    #[test]
    fn descriptor_points_at_the_stable_build_output() {
        let descriptor = descriptor("pi-connector", "Pi", Path::new("/tmp/pi/bin/provider"));
        let executable = descriptor.installation.executable.unwrap();
        assert_eq!(executable.command, "/tmp/pi/bin/provider");
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
        let created = create_with_roots(&pool, "workspace-test-provider", "Workspace Test", &roots)
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

        let kind: String = sqlx::query_scalar("SELECT kind FROM projects WHERE id = ?")
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
        assert_eq!(kind, "user");
        assert_eq!(feature, ("ws-session".to_string(), 0));

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
    async fn reserved_ids_are_refused_before_a_workspace_is_created() {
        let pool = test_pool().await;
        let temp = TempDir::new().unwrap();
        let roots = roots(&temp);
        assert!(
            create_with_roots(&pool, "claude", "Claude impostor", &roots)
                .await
                .is_err()
        );
        assert!(!roots.workspaces.join("claude").exists());
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

        let created = create_with_roots(&pool, "retry-provider", "Retry", &roots)
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
    }

    #[tokio::test]
    async fn refuses_an_unowned_existing_directory() {
        let pool = test_pool().await;
        let temp = TempDir::new().unwrap();
        let roots = roots(&temp);
        let directory = roots.workspaces.join("occupied-provider");
        std::fs::create_dir_all(&directory).unwrap();
        std::fs::write(directory.join("user-file.txt"), "keep me").unwrap();

        assert!(
            create_with_roots(&pool, "occupied-provider", "Occupied", &roots)
                .await
                .is_err()
        );
        assert_eq!(
            std::fs::read_to_string(directory.join("user-file.txt")).unwrap(),
            "keep me"
        );
    }

    fn roots(temp: &TempDir) -> WorkspaceRoots {
        WorkspaceRoots {
            workspaces: temp.path().join("provider-workspaces"),
            descriptors: temp.path().join("providers"),
        }
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
