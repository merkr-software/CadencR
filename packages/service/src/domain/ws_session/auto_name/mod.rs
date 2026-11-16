use crate::domain::ws_session::protocol::WsSessionEvent;

use std::path::PathBuf;

use axum::extract::ws::Message;
use regex_lite::Regex;
use serde_json::Value;
use sqlx::SqlitePool;
use tokio::sync::mpsc;
use tracing::{debug, error, info, warn};

use crate::domain::agents::adapter::{RuntimePermissionMode, RuntimePurpose, RuntimeSpawnConfig};
use crate::domain::agents::providers::runtime_adapter;
use crate::domain::features::repository::update_generated_title;
use crate::domain::features::title::GeneratedTitlePolicy;
use crate::error::AppError;

use super::protocol::{
    FeatureAutoNamingPayload, FeatureRenamedPayload, FeatureUpdatedPayload, WsEnvelope,
};

mod drain;
use drain::{drain_text, report_close_error, truncate_for_log};
mod prompt;
use prompt::{build_prompt, resolve_system_prompt, NAME_END, NAME_START};
pub use prompt::{AUTO_NAME_USER_PROMPT_PREFIX, DEFAULT_AUTO_NAME_SYSTEM_PROMPT};
mod title_state;
pub use title_state::has_default_title;

/// Send a `feature.updated` envelope over the given WebSocket sender.
fn send_feature_updated(
    senders: &[mpsc::UnboundedSender<Message>],
    feature_id: i64,
    changed: &[&str],
) {
    let payload = FeatureUpdatedPayload {
        feature_id,
        changed: changed.iter().map(|s| s.to_string()).collect(),
    };
    let envelope = WsEnvelope::new(
        "feature",
        "updated",
        serde_json::to_value(&payload).unwrap(),
    );
    let json: String = envelope.into();
    send_to_all(senders, json);
}

/// Send a `feature.autonaming` envelope so the frontend can toggle the
/// title-skeleton while naming is in flight.
fn send_autonaming(senders: &[mpsc::UnboundedSender<Message>], feature_id: i64, in_progress: bool) {
    let payload = FeatureAutoNamingPayload {
        feature_id,
        in_progress,
    };
    let envelope = WsEnvelope::session_event(&WsSessionEvent::FeatureAutonaming(payload.clone()))
        .expect("session event payload should serialize");
    let json: String = envelope.into();
    send_to_all(senders, json);
}

fn send_to_all(senders: &[mpsc::UnboundedSender<Message>], json: String) {
    for sender in senders {
        let _ = sender.send(Message::Text(json.clone().into()));
    }
}

/// Fetch the most recent user message content for the given feature.
/// Returns `None` if no user message exists.
pub async fn get_last_user_message(
    pool: &SqlitePool,
    feature_id: i64,
) -> Result<Option<String>, AppError> {
    let row: Option<(String,)> = sqlx::query_as(
        "SELECT m.content FROM agent_messages m
         JOIN agent_sessions s ON s.id = m.session_id
         WHERE s.feature_id = ? AND m.message_type = 'user_message'
         ORDER BY m.id DESC LIMIT 1",
    )
    .bind(feature_id)
    .fetch_optional(pool)
    .await?;
    Ok(row.map(|(content,)| content))
}

/// Auto-name a feature using the user-selected provider + model.
///
/// Emits `feature.autonaming { in_progress: true }` before spawning and
/// `in_progress: false` on every exit path so the UI skeleton resolves even
/// on failure. Returns the generated name, or `None` if naming failed.
pub async fn auto_name_feature(
    pool: SqlitePool,
    feature_id: i64,
    user_input: String,
    cwd: String,
    ws_sender: mpsc::UnboundedSender<Message>,
) -> Option<String> {
    auto_name_feature_with_policy(
        pool,
        feature_id,
        user_input,
        cwd,
        vec![ws_sender],
        GeneratedTitlePolicy::PreserveManualTitle,
    )
    .await
}

pub async fn force_auto_name_feature_for_senders(
    pool: SqlitePool,
    feature_id: i64,
    user_input: String,
    cwd: String,
    ws_senders: Vec<mpsc::UnboundedSender<Message>>,
) -> Option<String> {
    auto_name_feature_with_policy(
        pool,
        feature_id,
        user_input,
        cwd,
        ws_senders,
        GeneratedTitlePolicy::ReplaceManualTitle,
    )
    .await
}

async fn auto_name_feature_with_policy(
    pool: SqlitePool,
    feature_id: i64,
    user_input: String,
    cwd: String,
    ws_senders: Vec<mpsc::UnboundedSender<Message>>,
    title_policy: GeneratedTitlePolicy,
) -> Option<String> {
    send_autonaming(&ws_senders, feature_id, true);
    let result = run_auto_name(
        &pool,
        feature_id,
        user_input,
        cwd,
        &ws_senders,
        title_policy,
    )
    .await;
    send_autonaming(&ws_senders, feature_id, false);
    result
}

async fn run_auto_name(
    pool: &SqlitePool,
    feature_id: i64,
    user_input: String,
    cwd: String,
    ws_senders: &[mpsc::UnboundedSender<Message>],
    title_policy: GeneratedTitlePolicy,
) -> Option<String> {
    info!(feature_id, "auto-name: starting");
    // Same resolution the settings UI displays, so the auto-naming row never
    // shows a provider/model the spawn would not actually use.
    let selection = match crate::domain::agents::resolve_selection(
        pool,
        Some(std::path::Path::new(&cwd)),
        "auto_name",
        None,
        None,
    )
    .await
    {
        Ok(selection) => selection,
        Err(error) => {
            error!(feature_id, %error, "auto-name: no usable provider/model");
            return None;
        }
    };
    let provider_id = selection.provider_id;
    let model_id = selection.model_id;

    debug!(
        feature_id,
        provider = %provider_id,
        model = %model_id,
        cwd = %cwd,
        "auto-name: resolved settings"
    );

    let adapter = match runtime_adapter(&provider_id) {
        Some(a) => a,
        None => {
            error!(
                feature_id,
                provider = %provider_id,
                "auto-name: no adapter registered for configured provider"
            );
            return None;
        }
    };

    let system_prompt = resolve_system_prompt();
    let prompt = build_prompt(&user_input, &system_prompt);
    let config = match build_spawn_config(adapter.as_adapter(), &model_id, &cwd, system_prompt)
        .await
    {
        Ok(config) => config,
        Err(error) => {
            error!(feature_id, provider = %provider_id, %error, "auto-name: profile resolution failed");
            return None;
        }
    };
    debug!(
        feature_id,
        prompt_len = prompt.len(),
        "auto-name: dispatching prompt to adapter"
    );

    let session = match adapter.spawn(Value::String(prompt), config).await {
        Ok(s) => s,
        Err(e) => {
            error!(feature_id, error = %e, "auto-name: adapter spawn failed");
            return None;
        }
    };

    let accumulated_text = match drain_text(feature_id, &provider_id, session).await {
        Ok(text) => text,
        Err(error) => {
            report_close_error(ws_senders, error);
            return None;
        }
    };
    debug!(
        feature_id,
        text_len = accumulated_text.len(),
        "auto-name: stream drain finished"
    );

    let name = extract_name(&accumulated_text);
    if name.is_empty() {
        warn!(
            feature_id,
            text_len = accumulated_text.len(),
            raw = %truncate_for_log(&accumulated_text, 200),
            "auto-name: empty name extracted from stream text"
        );
        return None;
    }
    debug!(feature_id, name = %name, "auto-name: extracted name, updating DB");

    match update_generated_title(pool, feature_id, &name, title_policy).await {
        Ok(false) => {
            info!(
                feature_id,
                "auto-name: skipped generated title because the feature was manually renamed"
            );
            return None;
        }
        Ok(true) => {}
        Err(error) => {
            error!(feature_id, %error, "auto-name: DB update failed");
            return None;
        }
    }

    let payload = FeatureRenamedPayload {
        feature_id,
        title: name.clone(),
    };
    let envelope = WsEnvelope::session_event(&WsSessionEvent::FeatureRenamed(payload.clone()))
        .expect("session event payload should serialize");
    let json: String = envelope.into();
    send_to_all(ws_senders, json);
    send_feature_updated(ws_senders, feature_id, &["title"]);

    info!(
        feature_id,
        provider = %provider_id,
        model = %model_id,
        name = %name,
        "auto-named feature"
    );
    Some(name)
}

async fn build_spawn_config(
    adapter: &dyn crate::domain::agents::adapter::AgentRuntimeAdapter,
    model_id: &str,
    cwd: &str,
    system_prompt: String,
) -> Result<RuntimeSpawnConfig, crate::domain::agents::adapter::RuntimeError> {
    let resolved_profile = adapter
        .resolve_profile(None, std::path::Path::new(cwd))
        .await?;
    let env = resolved_profile
        .as_ref()
        .map(|profile| profile.env.clone())
        .filter(|env| !env.is_empty())
        .or_else(|| adapter.environment_for_new_session());
    // Auto-naming is a tiny "produce 3-7 words" task — extended thinking adds
    // latency and is a known silent-failure mode here: the 30s drain deadline
    // (drain::AUTO_NAME_DEADLINE) can fire mid-thinking before any text block
    // is emitted, leaving `accumulated_text` empty and the feature stuck on
    // its default "Session N" title. Force thinking off regardless of the
    // user's per-model preference for the naming spawn only.

    Ok(RuntimeSpawnConfig {
        cwd: PathBuf::from(cwd),
        permission_mode: Some(RuntimePermissionMode::Plan),
        access_mode: None,
        model: Some(model_id.to_string()),
        thinking_effort: None,
        fast_mode: false,
        system_prompt: Some(system_prompt),
        purpose: Some(RuntimePurpose::AutoName),
        resume_session_id: None,
        allow_bypass_permissions: false,
        mcp_servers: None,
        permission_handler: None,
        env,
        profile: resolved_profile
            .as_ref()
            .map(|profile| profile.identity.clone())
            .or_else(|| adapter.profile_name_for_new_session()),
        env_unset: resolved_profile
            .as_ref()
            .map(|profile| profile.env_unset.clone())
            .unwrap_or_default(),
        overrides: crate::domain::agents::adapter::RuntimeConfigOverrides {
            model: Some(model_id.to_string()),
            thinking_effort: None,
            fast_mode: Some(false),
        },
        profile_revision: resolved_profile
            .as_ref()
            .map(|profile| profile.revision.clone()),
        profile_state_identity: resolved_profile.and_then(|profile| profile.state_identity),
    })
}

fn extract_name(accumulated_text: &str) -> String {
    let re = Regex::new(&format!(
        "{}(.+?){}",
        regex_lite::escape(NAME_START),
        regex_lite::escape(NAME_END)
    ))
    .unwrap();
    let raw_name = match re.captures(accumulated_text) {
        Some(caps) => caps.get(1).unwrap().as_str().to_string(),
        None => accumulated_text.to_string(),
    };
    raw_name
        .trim()
        .trim_matches(|c| c == '"' || c == '\'')
        .to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn extract_name_pulls_from_delimiters() {
        let text = "noise __FEATURE_NAME_START__Fix Login Bug__FEATURE_NAME_END__ trailing";
        assert_eq!(extract_name(text), "Fix Login Bug");
    }

    #[test]
    fn extract_name_falls_back_to_trimmed_text() {
        assert_eq!(extract_name("  \"Add Dark Mode\"  "), "Add Dark Mode");
    }

    #[test]
    fn extract_name_returns_empty_for_whitespace() {
        assert_eq!(extract_name("   "), "");
    }

    #[test]
    fn truncate_for_log_clamps_at_char_boundary() {
        // 'é' is a 2-byte UTF-8 char; truncation must not split it.
        let input = "héllo world";
        assert_eq!(truncate_for_log(input, 100), input);
        let truncated = truncate_for_log(input, 3);
        assert!(truncated.ends_with('…'));
        assert!(truncated.is_char_boundary(truncated.len() - '…'.len_utf8()));
    }
}
