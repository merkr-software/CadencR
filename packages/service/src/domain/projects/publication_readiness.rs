mod files;
mod git;

use axum::http::StatusCode;
use sqlx::SqlitePool;
use std::path::PathBuf;

use super::models::{
    ProjectAuthoringTarget, PublicationCheckStatus as Status, PublicationPreparationStatus,
    PublicationReadinessCheck as Check, PublicationReadinessResponse,
};
use crate::domain::agents::providers::installed::descriptor::ACP_BINARY_TARGETS;
use crate::domain::agents::providers::installed::descriptors_dir;
use crate::error::AppError;

const UNSUPPORTED: &str = "PUBLICATION_UNSUPPORTED_PROJECT";

pub async fn inspect(
    pool: &SqlitePool,
    project_id: i64,
) -> Result<PublicationReadinessResponse, AppError> {
    let (root, plugin_id) = provider_project(pool, project_id).await?;
    // Resolve before spawn_blocking: test settings directories are thread-local.
    let descriptor_dir = descriptors_dir();
    let files_root = root.clone();
    let files_plugin_id = plugin_id.clone();
    let mut checks = tokio::task::spawn_blocking(move || {
        files::checks(&files_root, &files_plugin_id, &descriptor_dir)
    })
    .await
    .map_err(|error| AppError::Internal(format!("publication inspection task failed: {error}")))?;
    checks.extend(git::checks(&root).await);
    let blocked = checks.iter().any(|check| check.status == Status::Fail);
    let local_preparation = if blocked {
        PublicationPreparationStatus::Blocked
    } else {
        PublicationPreparationStatus::Prepared
    };
    let summary = if blocked {
        "Local provider preparation has blocking issues. Passing these checks still requires packaging, connector conformance, source-release, maintainer, and registry verification."
    } else {
        "No blocking local issues found. This is not release or publication approval: packaging, connector conformance, source-release, maintainer, and registry verification remain."
    };
    Ok(PublicationReadinessResponse {
        project_id,
        plugin_id,
        local_preparation,
        summary: summary.into(),
        checks,
        supported_package_targets: ACP_BINARY_TARGETS
            .iter()
            .map(|target| (*target).to_owned())
            .collect(),
    })
}

pub(super) async fn provider_project(
    pool: &SqlitePool,
    id: i64,
) -> Result<(PathBuf, String), AppError> {
    let row: Option<(String, Option<String>, Option<String>)> =
        sqlx::query_as("SELECT path, authoring_target, plugin_id FROM projects WHERE id = ?")
            .bind(id)
            .fetch_optional(pool)
            .await?;
    let (path, target, plugin_id) =
        row.ok_or_else(|| AppError::NotFound(format!("project {id} not found")))?;
    if target.as_deref() != Some(ProjectAuthoringTarget::Provider.as_str()) {
        return Err(AppError::coded(
            StatusCode::BAD_REQUEST,
            UNSUPPORTED,
            "publication readiness is supported only for authored provider projects",
        ));
    }
    let plugin_id = plugin_id.filter(|value| !value.is_empty()).ok_or_else(|| {
        AppError::coded(
            StatusCode::BAD_REQUEST,
            UNSUPPORTED,
            "authored provider project is missing its stable plugin id",
        )
    })?;
    let root = tokio::fs::canonicalize(path).await.map_err(|error| {
        AppError::BadRequest(format!("cannot resolve project {id} root: {error}"))
    })?;
    Ok((root, plugin_id))
}

fn pass(id: &str, label: &str, detail: &str) -> Check {
    check(id, label, Status::Pass, detail)
}
fn warning(id: &str, label: &str, detail: &str) -> Check {
    check(id, label, Status::Warning, detail)
}
fn fail(id: &str, label: &str, detail: &str) -> Check {
    check(id, label, Status::Fail, detail)
}
fn check(id: &str, label: &str, status: Status, detail: &str) -> Check {
    Check {
        id: id.into(),
        label: label.into(),
        status,
        detail: detail.into(),
    }
}

#[cfg(test)]
mod tests {
    use super::{inspect, provider_project};
    use crate::domain::agents::providers::installed::descriptors_dir;
    use crate::domain::projects::models::{
        PublicationCheckStatus as Status, PublicationPreparationStatus,
    };
    use crate::error::AppError;
    use sqlx::SqlitePool;
    use std::path::Path;
    use std::process::Command;

    async fn pool() -> SqlitePool {
        let pool = SqlitePool::connect("sqlite::memory:").await.unwrap();
        sqlx::query("CREATE TABLE projects (id INTEGER PRIMARY KEY, path TEXT NOT NULL, authoring_target TEXT, plugin_id TEXT)").execute(&pool).await.unwrap();
        pool
    }

    #[tokio::test]
    async fn project_gate_rejects_unknown_ordinary_theme_and_missing_identity() {
        let pool = pool().await;
        let root = tempfile::tempdir().unwrap();
        for (id, target, plugin) in [
            (1, None, None),
            (2, Some("theme"), Some("x")),
            (3, Some("provider"), None),
        ] {
            sqlx::query("INSERT INTO projects VALUES (?, ?, ?, ?)")
                .bind(id)
                .bind(root.path().to_str().unwrap())
                .bind(target)
                .bind(plugin)
                .execute(&pool)
                .await
                .unwrap();
        }
        assert!(matches!(
            provider_project(&pool, 99).await,
            Err(AppError::NotFound(_))
        ));
        for id in 1..=3 {
            assert!(matches!(
                provider_project(&pool, id).await,
                Err(AppError::Coded {
                    code: "PUBLICATION_UNSUPPORTED_PROJECT",
                    ..
                })
            ));
        }
    }

    #[tokio::test]
    async fn inspect_is_read_only_and_warning_only_results_are_prepared() {
        let pool = pool().await;
        let root_dir = tempfile::tempdir().unwrap();
        let root = root_dir.path().canonicalize().unwrap();
        std::fs::create_dir(root.join("bin")).unwrap();
        let executable = root.join(if cfg!(windows) {
            "bin/provider.exe"
        } else {
            "bin/provider"
        });
        std::fs::write(&executable, "provider sentinel").unwrap();
        make_executable(&executable);
        std::fs::write(root.join(".cadencr-provider-workspace"), "acme\n").unwrap();
        for asset in ["README.md", "LICENSE", "icon.svg"] {
            std::fs::write(root.join(asset), "asset").unwrap();
        }
        run_git(&root, &["init", "-q"]);
        run_git(&root, &["add", "."]);
        run_git(
            &root,
            &[
                "-c",
                "commit.gpgSign=false",
                "-c",
                "user.name=Test",
                "-c",
                "user.email=test@example.com",
                "commit",
                "-qm",
                "initial",
            ],
        );

        let descriptor_dir = descriptors_dir();
        std::fs::create_dir_all(&descriptor_dir).unwrap();
        let descriptor_path = descriptor_dir.join("acme.json");
        let descriptor = serde_json::json!({
            "schema_version": 1,
            "agent": { "id": "acme", "name": "Acme", "version": "1.0.0", "description": "ACP" },
            "installation": { "executable": { "command": executable } }
        });
        std::fs::write(&descriptor_path, serde_json::to_vec(&descriptor).unwrap()).unwrap();
        sqlx::query("INSERT INTO projects VALUES (7, ?, 'provider', 'acme')")
            .bind(root.to_str().unwrap())
            .execute(&pool)
            .await
            .unwrap();

        let before_descriptor = std::fs::read(&descriptor_path).unwrap();
        let before_head = git_output(&root, &["rev-parse", "HEAD"]);
        let response = inspect(&pool, 7).await.unwrap();
        assert_eq!(
            response.local_preparation,
            PublicationPreparationStatus::Prepared
        );
        assert!(response
            .summary
            .starts_with("No blocking local issues found"));
        assert!(response
            .checks
            .iter()
            .any(|check| check.status == Status::Warning));
        assert_eq!(std::fs::read(&descriptor_path).unwrap(), before_descriptor);
        assert_eq!(git_output(&root, &["rev-parse", "HEAD"]), before_head);
        assert!(git_output(&root, &["status", "--porcelain"]).is_empty());
        assert_eq!(
            std::fs::read_to_string(&executable).unwrap(),
            "provider sentinel"
        );
    }

    #[cfg(unix)]
    fn make_executable(path: &Path) {
        use std::os::unix::fs::PermissionsExt;
        let mut permissions = std::fs::metadata(path).unwrap().permissions();
        permissions.set_mode(0o755);
        std::fs::set_permissions(path, permissions).unwrap();
    }
    #[cfg(not(unix))]
    fn make_executable(_path: &Path) {}

    fn run_git(root: &Path, args: &[&str]) {
        assert!(Command::new("git")
            .args(args)
            .current_dir(root)
            .status()
            .unwrap()
            .success());
    }
    fn git_output(root: &Path, args: &[&str]) -> Vec<u8> {
        let output = Command::new("git")
            .args(args)
            .current_dir(root)
            .output()
            .unwrap();
        assert!(output.status.success());
        output.stdout
    }
}
