use std::path::PathBuf;

use axum::extract::ws::Message;
use regex_lite::Regex;
use serde_json::Value;
use sqlx::SqlitePool;
use tokio::sync::mpsc;
use tracing::{debug, error, info, warn};

use crate::domain::agents::adapter::{RuntimePermissionMode, RuntimeSpawnConfig};
use crate::domain::agents::providers::runtime_adapter;
use crate::error::AppError;

use super::protocol::{
    FeatureAutoNamingPayload, FeatureRenamedPayload, FeatureUpdatedPayload, WsEnvelope,
};

mod drain;
use drain::drain_text;

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
    let envelope = WsEnvelope::new(
        "session",
        "feature.autonaming",
        serde_json::to_value(&payload).unwrap(),
    );
    let json: String = envelope.into();
    send_to_all(senders, json);
}

fn send_to_all(senders: &[mpsc::UnboundedSender<Message>], json: String) {
    for sender in senders {
        let _ = sender.send(Message::Text(json.clone().into()));
    }
}

const AUTO_NAME_SYSTEM_PROMPT: &str = "You are a feature naming assistant. Your ONLY job is to output a short name (3-7 words) for a coding session. ALWAYS output a name, even if the input is vague — just pick a reasonable generic name. Examples: 'hi' → 'General Coding Session', 'fix the login bug' → 'Fix Login Bug', 'I want to add dark mode' → 'Add Dark Mode Support'.";

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

/// Check if a feature still has its default auto-generated title (e.g. "Session 3" or "Untitled Feature").
pub async fn has_default_title(pool: &SqlitePool, feature_id: i64) -> Result<bool, AppError> {
    let row: Option<(String,)> = sqlx::query_as("SELECT title FROM features WHERE id = ?")
        .bind(feature_id)
        .fetch_optional(pool)
        .await?;

    Ok(match row {
        Some((title,)) => is_default_title(&title),
        None => false,
    })
}

fn is_default_title(title: &str) -> bool {
    let re = Regex::new(r"(?i)^Session \d+$").unwrap();
    re.is_match(title) || title == "Untitled Feature"
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
    auto_name_feature_for_senders(pool, feature_id, user_input, cwd, vec![ws_sender]).await
}

pub async fn auto_name_feature_for_senders(
    pool: SqlitePool,
    feature_id: i64,
    user_input: String,
    cwd: String,
    ws_senders: Vec<mpsc::UnboundedSender<Message>>,
) -> Option<String> {
    send_autonaming(&ws_senders, feature_id, true);
    let result = run_auto_name(&pool, feature_id, user_input, cwd, &ws_senders).await;
    send_autonaming(&ws_senders, feature_id, false);
    result
}

async fn run_auto_name(
    pool: &SqlitePool,
    feature_id: i64,
    user_input: String,
    cwd: String,
    ws_senders: &[mpsc::UnboundedSender<Message>],
) -> Option<String> {
    info!(feature_id, "auto-name: starting");
    // Fetch provider + model concurrently — both are independent SQL reads.
    let (provider_settings_result, stored_model_result) = tokio::join!(
        crate::domain::workspace::repository::get_provider_settings(pool),
        crate::domain::workspace::repository::get_setting(pool, "model_auto_name"),
    );
    let provider_settings = match provider_settings_result {
        Ok(s) => s,
        Err(e) => {
            error!(feature_id, error = %e, "auto-name: failed to load provider settings");
            return None;
        }
    };
    let stored_model = match stored_model_result {
        Ok(v) => v,
        Err(e) => {
            error!(feature_id, error = %e, "auto-name: failed to load model setting");
            return None;
        }
    };
    let provider_id = provider_settings.auto_name;
    let model_id = match stored_model {
        Some(v) if !v.is_empty() => v,
        _ => crate::domain::agents::providers::provider_default_model(pool, &provider_id)
            .await
            .unwrap_or_default(),
    };

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

    let prompt = build_prompt(&user_input);
    let config = build_spawn_config(&provider_id, &model_id, &cwd);
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

    let accumulated_text = drain_text(feature_id, &provider_id, session).await;
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

    if let Err(e) = sqlx::query("UPDATE features SET title = ? WHERE id = ?")
        .bind(&name)
        .bind(feature_id)
        .execute(pool)
        .await
    {
        error!(feature_id, error = %e, "auto-name: DB update failed");
        return None;
    }

    let payload = FeatureRenamedPayload {
        feature_id,
        title: name.clone(),
    };
    let envelope = WsEnvelope::new(
        "session",
        "feature.renamed",
        serde_json::to_value(&payload).unwrap(),
    );
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

/// Clamp a string to `max` bytes at a char boundary for log output. Prevents
/// an OpenCode message with a long payload from flooding the log line.
pub(super) fn truncate_for_log(text: &str, max: usize) -> String {
    if text.len() <= max {
        return text.to_string();
    }
    let mut end = max;
    while end > 0 && !text.is_char_boundary(end) {
        end -= 1;
    }
    format!("{}…", &text[..end])
}

fn build_prompt(user_input: &str) -> String {
    let escaped_input = user_input.replace('"', "\\\"");
    format!(
        "Now name this session. User's first message: \"{escaped_input}\". Reply with ONLY: __FEATURE_NAME_START__<name>__FEATURE_NAME_END__"
    )
}

fn build_spawn_config(provider_id: &str, model_id: &str, cwd: &str) -> RuntimeSpawnConfig {
    // Provider-specific env injection lives co-located with the provider
    // module (claude_code::profiles) so generic code stays provider-neutral.
    let env = if provider_id == "claude_code" {
        crate::domain::agents::claude_code::profiles::resolve_active_profile_env().1
    } else {
        None
    };
    // Auto-naming is a tiny "produce 3-7 words" task — extended thinking adds
    // latency and is a known silent-failure mode here: the 30s drain deadline
    // (drain::AUTO_NAME_DEADLINE) can fire mid-thinking before any text block
    // is emitted, leaving `accumulated_text` empty and the feature stuck on
    // its default "Session N" title. Force thinking off regardless of the
    // user's per-model preference for the naming spawn only.

    RuntimeSpawnConfig {
        cwd: PathBuf::from(cwd),
        permission_mode: Some(RuntimePermissionMode::Plan),
        access_mode: None,
        model: Some(model_id.to_string()),
        thinking_effort: None,
        system_prompt: Some(AUTO_NAME_SYSTEM_PROMPT.to_string()),
        resume_session_id: None,
        allow_bypass_permissions: false,
        mcp_servers: None,
        permission_handler: None,
        env,
    }
}

fn extract_name(accumulated_text: &str) -> String {
    let re = Regex::new(r"__FEATURE_NAME_START__(.+?)__FEATURE_NAME_END__").unwrap();
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
    fn build_prompt_escapes_quotes() {
        let prompt = build_prompt("say \"hi\"");
        assert!(prompt.contains("\\\"hi\\\""));
        assert!(prompt.contains("__FEATURE_NAME_START__"));
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
