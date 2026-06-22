use serde::{Deserialize, Serialize};
use utoipa::ToSchema;

pub use crate::domain::agents::runtime::ProviderSettings as FeatureProviderSettings;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, ToSchema, sqlx::Type)]
#[serde(rename_all = "lowercase")]
#[sqlx(type_name = "TEXT", rename_all = "lowercase")]
pub enum FeatureStatus {
    Active,
    Archived,
}

impl FeatureStatus {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Active => "active",
            Self::Archived => "archived",
        }
    }
}

#[derive(Debug, Serialize, sqlx::FromRow, ToSchema)]
pub struct Feature {
    pub id: i64,
    pub project_id: i64,
    pub title: String,
    /// Feature archive state. Only `active` and `archived` are valid.
    pub status: FeatureStatus,
    #[serde(rename = "type")]
    pub type_: String,
    pub label: Option<String>,
    pub model_session: Option<String>,
    pub created_at: String,
    /// Whether the conversation is pinned to the top of the sidebar.
    pub is_pinned: bool,
}

#[derive(Debug, Deserialize, ToSchema)]
pub struct CreateFeatureRequest {
    pub project_id: i64,
    pub title: Option<String>,
    #[serde(rename = "type")]
    pub type_: Option<String>,
    /// One of `"new"`, `"reuse"`, `"skip"`. When `"reuse"`, `reuse_branch`
    /// must be set. Persisted to `feature_settings.worktree_mode` before the
    /// `ensure_worktree` background task is spawned.
    pub worktree_mode: Option<String>,
    /// Branch name to attach to when `worktree_mode == "reuse"`. Validated as
    /// non-empty and non-flag-prefixed in the handler.
    pub reuse_branch: Option<String>,
}

#[derive(Debug, Deserialize, ToSchema)]
pub struct UpdateTitleRequest {
    pub title: String,
}

#[derive(Debug, Deserialize, ToSchema)]
pub struct UpdateStatusRequest {
    pub status: FeatureStatus,
}

#[derive(Debug, Deserialize, ToSchema)]
pub struct UpdateLabelRequest {
    pub label: Option<String>,
}

#[derive(Debug, Deserialize, ToSchema)]
pub struct UpdatePinnedRequest {
    pub pinned: bool,
}

#[derive(Debug, Serialize, ToSchema)]
pub struct IsEmptyResponse {
    pub empty: bool,
}

#[derive(Debug, Serialize, ToSchema)]
pub struct FeatureActivity {
    pub feature_id: i64,
    pub shell_count: i64,
}

#[derive(Debug, Serialize, ToSchema)]
pub struct WorkingDirResponse {
    pub path: Option<String>,
}

#[derive(Debug, Serialize, ToSchema)]
pub struct CreateFeatureResponse {
    pub id: i64,
}

#[derive(Debug, Serialize, Deserialize, ToSchema)]
pub struct FeatureSetting {
    pub key: String,
    pub value: String,
}

#[derive(Debug, Deserialize, ToSchema)]
pub struct SetFeatureSettingRequest {
    pub key: String,
    pub value: String,
}

/// Per-feature model overrides. ws-session uses `session`.
#[derive(Debug, Serialize, ToSchema)]
pub struct FeatureModelSettings {
    pub session: String,
}

#[derive(Debug, Deserialize, ToSchema)]
pub struct SetFeatureModelSettingRequest {
    pub model_type: String,
    pub model: String,
}

#[derive(Debug, Deserialize, ToSchema)]
pub struct SetFeatureProviderSettingRequest {
    pub provider_type: String,
    pub provider: String,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_feature_serde_roundtrip() {
        let feature = Feature {
            id: 1,
            project_id: 2,
            title: "Test Feature".to_string(),
            status: FeatureStatus::Active,
            type_: "ws-session".to_string(),
            label: Some("Review".to_string()),
            model_session: Some("claude-session".to_string()),
            created_at: "2024-01-01T00:00:00".to_string(),
            is_pinned: false,
        };

        let json = serde_json::to_string(&feature).unwrap();
        assert!(json.contains(r#""type""#));
        let deserialized: serde_json::Value = serde_json::from_str(&json).unwrap();
        assert_eq!(deserialized["type"], "ws-session");
        assert_eq!(deserialized["title"], "Test Feature");
        assert_eq!(deserialized["label"], "Review");
    }

    #[test]
    fn test_feature_setting_serde_roundtrip() {
        let setting = FeatureSetting {
            key: "instructions".to_string(),
            value: "do this".to_string(),
        };
        let json = serde_json::to_string(&setting).unwrap();
        let back: FeatureSetting = serde_json::from_str(&json).unwrap();
        assert_eq!(back.key, "instructions");
        assert_eq!(back.value, "do this");
    }

    #[test]
    fn test_feature_model_settings_serde_roundtrip() {
        let settings = FeatureModelSettings {
            session: "claude-session".to_string(),
        };
        let json = serde_json::to_string(&settings).unwrap();
        let val: serde_json::Value = serde_json::from_str(&json).unwrap();
        assert_eq!(val["session"], "claude-session");
    }

    #[test]
    fn test_create_feature_request_serde() {
        let json = r#"{"project_id": 1, "title": "My Feature", "type": "ws-session"}"#;
        let req: CreateFeatureRequest = serde_json::from_str(json).unwrap();
        assert_eq!(req.project_id, 1);
        assert_eq!(req.title.as_deref(), Some("My Feature"));
        assert_eq!(req.type_.as_deref(), Some("ws-session"));
        assert!(req.worktree_mode.is_none());
        assert!(req.reuse_branch.is_none());
    }

    #[test]
    fn test_create_feature_request_serde_with_worktree_fields() {
        let json = r#"{
            "project_id": 1,
            "title": "Feat",
            "type": "ws-session",
            "worktree_mode": "reuse",
            "reuse_branch": "feat/existing"
        }"#;
        let req: CreateFeatureRequest = serde_json::from_str(json).unwrap();
        assert_eq!(req.worktree_mode.as_deref(), Some("reuse"));
        assert_eq!(req.reuse_branch.as_deref(), Some("feat/existing"));
    }

    #[test]
    fn test_update_title_request_serde() {
        let json = r#"{"title": "New Title"}"#;
        let req: UpdateTitleRequest = serde_json::from_str(json).unwrap();
        assert_eq!(req.title, "New Title");
    }

    #[test]
    fn test_set_feature_setting_request_serde() {
        let json = r#"{"key": "instructions", "value": "do this"}"#;
        let req: SetFeatureSettingRequest = serde_json::from_str(json).unwrap();
        assert_eq!(req.key, "instructions");
        assert_eq!(req.value, "do this");
    }

    #[test]
    fn test_set_feature_model_setting_request_serde() {
        let json = r#"{"model_type": "session", "model": "claude-3"}"#;
        let req: SetFeatureModelSettingRequest = serde_json::from_str(json).unwrap();
        assert_eq!(req.model_type, "session");
        assert_eq!(req.model, "claude-3");
    }

    #[test]
    fn test_create_feature_request_minimal() {
        let json = r#"{"project_id": 1}"#;
        let req: CreateFeatureRequest = serde_json::from_str(json).unwrap();
        assert_eq!(req.project_id, 1);
        assert!(req.title.is_none());
        assert!(req.type_.is_none());
    }

    #[test]
    fn test_create_feature_response_serde() {
        let resp = CreateFeatureResponse { id: 42 };
        let json = serde_json::to_string(&resp).unwrap();
        let val: serde_json::Value = serde_json::from_str(&json).unwrap();
        assert_eq!(val["id"], 42);
    }

    #[test]
    fn test_working_dir_response_serde() {
        let resp = WorkingDirResponse {
            path: Some("/tmp/dir".to_string()),
        };
        let json = serde_json::to_string(&resp).unwrap();
        let val: serde_json::Value = serde_json::from_str(&json).unwrap();
        assert_eq!(val["path"], "/tmp/dir");
    }
}
