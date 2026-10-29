//! The virtual skill catalog over HTTP, for the composer's skill wizard.
//!
//! The slash menu only needs a name and a one-line hint, which ride the
//! prompt-command catalog. The wizard shown once a skill sits in the prompt
//! needs the rest — the full description and what can be configured — and
//! that is static, so it is served once rather than on every catalog push.

use axum::routing::get;
use axum::{Json, Router};
use serde::Serialize;
use utoipa::ToSchema;

use super::{OrchestrationSkill, SkillWorktree, ORCHESTRATION_SKILLS};
use crate::app_state::AppState;

#[derive(Debug, Serialize, ToSchema)]
pub struct VirtualSkillParametersPayload {
    /// Provider, model, thinking level and permission mode are configurable.
    pub agent: bool,
    /// Offered worktree placements; the first is the default. Shown as a choice
    /// only when there are at least two.
    pub worktrees: Vec<SkillWorktree>,
}

#[derive(Debug, Serialize, ToSchema)]
pub struct VirtualSkillPayload {
    /// The namespaced command, e.g. `cadencr:review`.
    pub command: String,
    pub description: String,
    pub details: String,
    pub argument_hint: Option<String>,
    pub parameters: VirtualSkillParametersPayload,
}

impl From<&OrchestrationSkill> for VirtualSkillPayload {
    fn from(skill: &OrchestrationSkill) -> Self {
        Self {
            command: skill.command(),
            description: skill.description.to_string(),
            details: skill.details.to_string(),
            argument_hint: skill.argument_hint.map(str::to_string),
            parameters: VirtualSkillParametersPayload {
                agent: skill.parameters.agent,
                worktrees: skill.parameters.worktrees.to_vec(),
            },
        }
    }
}

#[utoipa::path(
    get,
    path = "/api/virtual-skills",
    responses((status = 200, body = Vec<VirtualSkillPayload>))
)]
pub async fn list_virtual_skills() -> Json<Vec<VirtualSkillPayload>> {
    Json(ORCHESTRATION_SKILLS.iter().map(Into::into).collect())
}

pub fn virtual_skills_router() -> Router<AppState> {
    Router::new().route("/api/virtual-skills", get(list_virtual_skills))
}

#[cfg(test)]
mod tests {
    use super::list_virtual_skills;

    #[tokio::test]
    async fn lists_every_skill_with_its_parameters() {
        let skills = list_virtual_skills().await.0;
        let review = skills
            .iter()
            .find(|skill| skill.command == "cadencr:review")
            .unwrap();
        assert!(review.parameters.agent);
        assert_eq!(review.parameters.worktrees.len(), 3);
        assert_eq!(
            serde_json::to_value(&review.parameters.worktrees).unwrap(),
            serde_json::json!(["same", "new", "project"])
        );
        let status = skills
            .iter()
            .find(|skill| skill.command == "cadencr:status")
            .unwrap();
        assert!(!status.parameters.agent);
        assert!(status.parameters.worktrees.is_empty());
    }
}
