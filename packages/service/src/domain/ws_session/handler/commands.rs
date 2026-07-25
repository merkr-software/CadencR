use axum::extract::ws::Message;
use tracing::warn;

use crate::domain::agents::adapter::{
    RuntimePromptCommandPlacement, RuntimePromptCommandPolicy, RuntimeSkillReferenceTrigger,
};
use crate::domain::agents::runtime_adapter;
use crate::domain::ws_session::slash_commands::SlashCommandKind;

use super::super::protocol::*;
use super::{send_error, WsSender};

impl From<SlashCommandKind> for SlashCommandKindPayload {
    fn from(kind: SlashCommandKind) -> Self {
        match kind {
            SlashCommandKind::Command => Self::Command,
            SlashCommandKind::Skill => Self::Skill,
            SlashCommandKind::Cadencr => Self::Cadencr,
        }
    }
}

impl From<RuntimePromptCommandPolicy> for PromptCommandPolicyPayload {
    fn from(policy: RuntimePromptCommandPolicy) -> Self {
        Self {
            slash_command_placement: match policy.slash_command_placement {
                RuntimePromptCommandPlacement::PromptStart => {
                    PromptCommandPlacementPayload::PromptStart
                }
                RuntimePromptCommandPlacement::Anywhere => PromptCommandPlacementPayload::Anywhere,
            },
            skill_reference_trigger: match policy.skill_reference_trigger {
                RuntimeSkillReferenceTrigger::Slash => SkillReferenceTriggerPayload::Slash,
                RuntimeSkillReferenceTrigger::Dollar => SkillReferenceTriggerPayload::Dollar,
            },
            user_shell: policy.user_shell,
        }
    }
}

/// Handle commands domain actions.
pub(super) async fn handle_commands_action(envelope: WsEnvelope, sender: &WsSender) {
    match envelope.action.as_str() {
        "get" => handle_commands_get(envelope, sender).await,
        unknown => {
            let err = WsEnvelope::reply(
                &envelope.id,
                "commands",
                "error",
                serde_json::to_value(SessionErrorPayload {
                    code: "UNKNOWN_ACTION".into(),
                    message: format!("Unknown commands action: {unknown}"),
                    ..Default::default()
                })
                .unwrap(),
            );
            let _ = sender.send(Message::Text(String::from(err).into()));
        }
    }
}

/// Handle commands.get: fetch available slash commands for a given cwd.
///
/// Resolves commands for the requested provider and working directory.
async fn handle_commands_get(envelope: WsEnvelope, sender: &WsSender) {
    let payload: CommandsGetPayload = match serde_json::from_value(envelope.payload.clone()) {
        Ok(p) => p,
        Err(e) => {
            send_error(
                sender,
                &envelope.id,
                "INVALID_PAYLOAD",
                &format!("Invalid commands.get payload: {e}"),
            );
            return;
        }
    };

    let provider = payload.provider.trim();
    if provider.is_empty() {
        send_error(
            sender,
            &envelope.id,
            "INVALID_PAYLOAD",
            "Invalid commands.get payload: provider is required",
        );
        return;
    }

    // Two-stage response. First, send the cached snapshot immediately
    // with `refreshing: true` so the FE picker renders instantly and
    // shows a small "updating" indicator. Then, if the adapter
    // supports a true re-resolve, spawn an ephemeral probe and push
    // the fresh catalog via `commands.updated` when it lands. If
    // there's no adapter, or the adapter has no probe (default impl),
    // we just reply with `refreshing: false`.
    let cached = super::super::slash_commands::resolve_commands(&payload.cwd, provider).await;
    let cached_payload_commands = to_payload_commands(cached);

    let adapter = runtime_adapter(provider);
    let refreshing = adapter
        .as_ref()
        .map(|adapter| adapter.supports_runtime_slash_command_refresh())
        .unwrap_or(false);

    let reply = WsEnvelope::reply(
        &envelope.id,
        "commands",
        "list",
        serde_json::to_value(CommandsListPayload {
            commands: cached_payload_commands,
            prompt_command_policy: adapter
                .as_ref()
                .map(|adapter| adapter.prompt_command_policy())
                .unwrap_or_default()
                .into(),
            refreshing,
        })
        .unwrap(),
    );
    let _ = sender.send(Message::Text(String::from(reply).into()));

    if let Some(adapter) = adapter.filter(|a| a.supports_runtime_slash_command_refresh()) {
        let cwd = payload.cwd.clone();
        let provider = provider.to_string();
        let sender = sender.clone();
        tokio::spawn(async move {
            if let Err(error) = adapter.refresh_runtime_slash_commands(&cwd).await {
                warn!(
                    cwd,
                    provider,
                    error = %error,
                    "slash-command refresh probe failed; FE keeps cached snapshot"
                );
                return;
            }
            // Re-resolve through the shared resolver so built-ins
            // (e.g. `/compact`) stay merged on top of the refreshed
            // adapter catalog.
            let merged = super::super::slash_commands::resolve_commands(&cwd, &provider).await;
            let merged_payload = to_payload_commands(merged);
            let env = WsEnvelope::new(
                "commands",
                "updated",
                serde_json::to_value(CommandsUpdatedPayload {
                    commands: merged_payload,
                })
                .unwrap(),
            );
            let _ = sender.send(Message::Text(String::from(env).into()));
        });
    }
}

pub(in crate::domain::ws_session) fn to_payload_commands(
    commands: Vec<super::super::slash_commands::SlashCommand>,
) -> Vec<SlashCommandPayload> {
    commands
        .into_iter()
        .map(|command| SlashCommandPayload {
            name: command.name,
            description: command.description,
            kind: command.kind.into(),
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use axum::extract::ws::Message;
    use tokio::sync::mpsc;

    use crate::domain::ws_session::protocol::{
        CommandsListPayload, PromptCommandPlacementPayload, SkillReferenceTriggerPayload,
        SlashCommandKindPayload,
    };
    use crate::domain::ws_session::slash_commands::{SlashCommand, SlashCommandKind};

    use super::{handle_commands_get, to_payload_commands, SessionErrorPayload, WsEnvelope};

    fn sender() -> (
        mpsc::UnboundedSender<Message>,
        mpsc::UnboundedReceiver<Message>,
    ) {
        mpsc::unbounded_channel()
    }

    fn envelope(payload: serde_json::Value) -> WsEnvelope {
        WsEnvelope {
            id: "commands-test".to_string(),
            domain: "commands".to_string(),
            action: "get".to_string(),
            r#ref: None,
            payload,
        }
    }

    fn recv_error(rx: &mut mpsc::UnboundedReceiver<Message>) -> SessionErrorPayload {
        let Message::Text(text) = rx.try_recv().expect("expected error message") else {
            panic!("expected text message");
        };
        let reply: WsEnvelope = serde_json::from_str(&text).unwrap();
        assert_eq!(reply.action, "error");
        serde_json::from_value(reply.payload).unwrap()
    }

    #[tokio::test]
    async fn commands_get_requires_provider() {
        let (tx, mut rx) = sender();
        handle_commands_get(envelope(serde_json::json!({ "cwd": "/repo" })), &tx).await;

        let payload = recv_error(&mut rx);
        assert_eq!(payload.code, "INVALID_PAYLOAD");
        assert!(payload.message.contains("provider"));
    }

    #[tokio::test]
    async fn commands_get_rejects_blank_provider() {
        let (tx, mut rx) = sender();
        handle_commands_get(
            envelope(serde_json::json!({ "cwd": "/repo", "provider": " " })),
            &tx,
        )
        .await;

        let payload = recv_error(&mut rx);
        assert_eq!(payload.code, "INVALID_PAYLOAD");
        assert!(payload.message.contains("provider is required"));
    }

    #[tokio::test]
    async fn commands_get_advertises_refreshing_for_opencode() {
        // OpenCode opts into runtime-slash-command refresh. The cached
        // reply must carry `refreshing: true` so the FE shows a
        // spinner while the background ACP probe runs.
        let temp = tempfile::TempDir::new().unwrap();
        let (tx, mut rx) = sender();
        handle_commands_get(
            envelope(serde_json::json!({
                "cwd": temp.path().to_str().unwrap(),
                "provider": crate::domain::agents::opencode::PROVIDER_ID
            })),
            &tx,
        )
        .await;

        let Message::Text(text) = rx.try_recv().expect("expected commands reply") else {
            panic!("expected text message");
        };
        let reply: WsEnvelope = serde_json::from_str(&text).unwrap();
        let payload: CommandsListPayload = serde_json::from_value(reply.payload).unwrap();
        assert!(
            payload.refreshing,
            "opencode should advertise refreshing=true"
        );
        assert_eq!(
            payload.prompt_command_policy.slash_command_placement,
            PromptCommandPlacementPayload::PromptStart
        );
        assert_eq!(
            payload.prompt_command_policy.skill_reference_trigger,
            SkillReferenceTriggerPayload::Slash
        );
        assert!(payload.prompt_command_policy.user_shell);
    }

    #[tokio::test]
    async fn commands_get_does_not_advertise_refreshing_for_non_refresh_providers() {
        // Codex doesn't opt into refresh, so `refreshing` stays false
        // and no background task is spawned.
        let temp = tempfile::TempDir::new().unwrap();
        std::fs::create_dir_all(temp.path().join(".git")).unwrap();
        let (tx, mut rx) = sender();
        handle_commands_get(
            envelope(serde_json::json!({
                "cwd": temp.path().to_str().unwrap(),
                "provider": crate::domain::agents::codex::PROVIDER_ID
            })),
            &tx,
        )
        .await;

        let Message::Text(text) = rx.try_recv().expect("expected commands reply") else {
            panic!("expected text message");
        };
        let reply: WsEnvelope = serde_json::from_str(&text).unwrap();
        let payload: CommandsListPayload = serde_json::from_value(reply.payload).unwrap();
        assert!(
            !payload.refreshing,
            "codex should not advertise refreshing=true"
        );
        assert_eq!(
            payload.prompt_command_policy.slash_command_placement,
            PromptCommandPlacementPayload::PromptStart
        );
        assert_eq!(
            payload.prompt_command_policy.skill_reference_trigger,
            SkillReferenceTriggerPayload::Dollar
        );
        assert!(payload.prompt_command_policy.user_shell);
    }

    #[test]
    fn commands_payload_preserves_command_kind() {
        let payload = to_payload_commands(vec![SlashCommand {
            name: "finish-job".to_string(),
            description: Some("Finish safely".to_string()),
            kind: SlashCommandKind::Skill,
        }]);

        assert_eq!(payload.len(), 1);
        assert!(matches!(payload[0].kind, SlashCommandKindPayload::Skill));
    }
}
