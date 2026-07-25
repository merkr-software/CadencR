//! The prompt-command catalog over HTTP.
//!
//! `commands.get` answers the same question over the WebSocket, but only a
//! surface that owns a session can ask it. Anything that composes a prompt
//! without one — the schedule editor being the first — needs `/` and `$`
//! completions too, and a prompt written without them is a second-class prompt.
//!
//! What is missing here on purpose is the refresh probe: the WS handler follows
//! its first reply with a `commands.updated` push once the adapter re-resolves
//! its catalog. A one-shot request has nowhere to push to, so this answers from
//! the same resolver without that second pass — which is what the picker
//! renders first in either case.

use axum::extract::{Query, State};
use axum::routing::get;
use axum::{Json, Router};
use serde::Deserialize;
use utoipa::ToSchema;

use crate::app_state::AppState;
use crate::domain::agents::runtime_adapter;
use crate::error::AppError;

use super::handler::commands::to_payload_commands;
use super::protocol::{PromptCommandPolicyPayload, SlashCommandPayload};
use super::slash_commands::resolve_commands;

#[derive(Debug, Deserialize)]
pub struct PromptCommandsQuery {
    /// Directory the catalog is resolved in — project-local commands and skills
    /// live in the repo, so the same provider answers differently per project.
    cwd: String,
    provider: String,
}

#[derive(Debug, serde::Serialize, ToSchema)]
pub struct PromptCommandsResponse {
    pub commands: Vec<SlashCommandPayload>,
    /// Which trigger characters mean what for this provider — `$` for skills on
    /// Codex, `/` everywhere on Claude, and so on.
    pub prompt_command_policy: PromptCommandPolicyPayload,
}

#[utoipa::path(
    get,
    path = "/api/prompt-commands",
    params(
        ("cwd" = String, Query, description = "Directory to resolve project-local commands and skills in"),
        ("provider" = String, Query, description = "Runtime provider id"),
    ),
    responses((status = 200, body = PromptCommandsResponse))
)]
pub async fn get_prompt_commands(
    State(_state): State<AppState>,
    Query(query): Query<PromptCommandsQuery>,
) -> Result<Json<PromptCommandsResponse>, AppError> {
    let provider = query.provider.trim();
    if provider.is_empty() {
        return Err(AppError::BadRequest("provider is required".into()));
    }
    Ok(Json(PromptCommandsResponse {
        commands: to_payload_commands(resolve_commands(&query.cwd, provider).await),
        prompt_command_policy: runtime_adapter(provider)
            .map(|adapter| adapter.prompt_command_policy())
            .unwrap_or_default()
            .into(),
    }))
}

pub fn prompt_commands_router() -> Router<AppState> {
    Router::new().route("/api/prompt-commands", get(get_prompt_commands))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::domain::ws_session::protocol::SkillReferenceTriggerPayload;

    #[tokio::test]
    async fn a_blank_provider_is_a_bad_request_rather_than_an_empty_catalog() {
        let state =
            AppState::with_pool(sqlx::SqlitePool::connect("sqlite::memory:").await.unwrap());
        let error = get_prompt_commands(
            State(state),
            Query(PromptCommandsQuery {
                cwd: "/tmp".into(),
                provider: "  ".into(),
            }),
        )
        .await
        .unwrap_err();
        assert!(matches!(error, AppError::BadRequest(_)), "{error:?}");
    }

    /// The policy is the whole reason the editor can offer `$skill` on Codex and
    /// not on Claude, so it has to ride along with the catalog.
    #[tokio::test]
    async fn the_response_carries_the_providers_trigger_policy() {
        let temp = tempfile::TempDir::new().unwrap();
        let state =
            AppState::with_pool(sqlx::SqlitePool::connect("sqlite::memory:").await.unwrap());
        let response = get_prompt_commands(
            State(state),
            Query(PromptCommandsQuery {
                cwd: temp.path().to_string_lossy().into_owned(),
                provider: crate::domain::agents::codex::PROVIDER_ID.into(),
            }),
        )
        .await
        .unwrap();

        assert_eq!(
            response.0.prompt_command_policy.skill_reference_trigger,
            SkillReferenceTriggerPayload::Dollar
        );
    }
}
