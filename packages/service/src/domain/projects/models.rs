use serde::{Deserialize, Serialize};
use utoipa::ToSchema;

pub use crate::domain::agents::runtime::ProviderSettings as ProjectProviderSettings;

/// Legacy `projects.kind` used by theme projects created before durable
/// authoring metadata. New theme projects remain `kind = 'user'` and use
/// [`ProjectAuthoringTarget::Theme`] plus `plugin_id`; this constant exists only
/// so old rows can still be found without reclassifying them.
pub const THEME_PROJECT_KIND: &str = "theme";

/// The plugin content authored by an otherwise ordinary user project.
#[derive(Debug, Clone, Copy, Deserialize, Serialize, PartialEq, Eq, ToSchema)]
#[serde(rename_all = "lowercase")]
pub enum ProjectAuthoringTarget {
    Theme,
    Provider,
}

impl ProjectAuthoringTarget {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Theme => "theme",
            Self::Provider => "provider",
        }
    }
}

impl TryFrom<&str> for ProjectAuthoringTarget {
    type Error = String;

    fn try_from(value: &str) -> Result<Self, Self::Error> {
        match value {
            "theme" => Ok(Self::Theme),
            "provider" => Ok(Self::Provider),
            _ => Err(format!("unknown project authoring target {value:?}")),
        }
    }
}

#[derive(Debug, Serialize, ToSchema)]
pub struct Project {
    pub id: i64,
    pub name: String,
    pub path: String,
    pub branch_prefix: Option<String>,
    pub created_at: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub authoring_target: Option<ProjectAuthoringTarget>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub plugin_id: Option<String>,
}

/// Result of read-only, local preparation checks for an authored provider.
#[derive(Debug, Serialize, ToSchema)]
pub struct PublicationReadinessResponse {
    pub project_id: i64,
    pub plugin_id: String,
    pub local_preparation: PublicationPreparationStatus,
    pub summary: String,
    pub checks: Vec<PublicationReadinessCheck>,
}

#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq, ToSchema)]
#[serde(rename_all = "snake_case")]
pub enum PublicationPreparationStatus {
    Prepared,
    Blocked,
}

#[derive(Debug, Serialize, ToSchema)]
pub struct PublicationReadinessCheck {
    pub id: String,
    pub label: String,
    pub status: PublicationCheckStatus,
    pub detail: String,
}

#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq, ToSchema)]
#[serde(rename_all = "snake_case")]
pub enum PublicationCheckStatus {
    Pass,
    Warning,
    Fail,
}

#[derive(Debug, Deserialize, ToSchema)]
pub struct CreateProjectRequest {
    pub name: String,
    pub path: String,
}

#[derive(Debug, Serialize, ToSchema)]
pub struct ProjectSetting {
    pub key: String,
    pub value: Option<String>,
}

#[derive(Debug, Deserialize, ToSchema)]
pub struct SetProjectSettingRequest {
    pub key: String,
    pub value: String,
}

#[derive(Debug, Serialize, ToSchema)]
pub struct ProjectModelSettings {
    pub session: String,
}

#[derive(Debug, Deserialize, ToSchema)]
pub struct SetProjectModelSettingRequest {
    pub model_type: String,
    pub model: String,
}

#[derive(Debug, Deserialize, ToSchema)]
pub struct SetProjectProviderSettingRequest {
    pub provider_type: String,
    pub provider: String,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_project_serde_roundtrip() {
        let project = Project {
            id: 1,
            name: "Test Project".to_string(),
            path: "/tmp/test".to_string(),
            branch_prefix: Some("feat/".to_string()),
            created_at: "2024-01-01T00:00:00".to_string(),
            authoring_target: None,
            plugin_id: None,
        };
        let json = serde_json::to_string(&project).unwrap();
        assert!(json.contains("Test Project"));
        assert!(json.contains("feat/"));
    }

    #[test]
    fn test_create_project_request_deserialize() {
        let json = r#"{"name": "My Project", "path": "/home/user/project"}"#;
        let req: CreateProjectRequest = serde_json::from_str(json).unwrap();
        assert_eq!(req.name, "My Project");
        assert_eq!(req.path, "/home/user/project");
    }

    #[test]
    fn test_set_project_setting_request_deserialize() {
        let json = r#"{"key": "branch_prefix", "value": "feature/"}"#;
        let req: SetProjectSettingRequest = serde_json::from_str(json).unwrap();
        assert_eq!(req.key, "branch_prefix");
        assert_eq!(req.value, "feature/");
    }

    #[test]
    fn test_set_project_model_setting_request_deserialize() {
        let json = r#"{"model_type": "session", "model": "claude-3-5-sonnet"}"#;
        let req: SetProjectModelSettingRequest = serde_json::from_str(json).unwrap();
        assert_eq!(req.model_type, "session");
        assert_eq!(req.model, "claude-3-5-sonnet");
    }
}
