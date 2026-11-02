//! `config_option_update` notification handler.
//!
//! ACP agents announce authoritative model / thinking-effort changes via
//! a `session/update` whose `sessionUpdate == "config_option_update"`. The
//! current ACP v1 payload carries the complete authoritative `configOptions`
//! list. The older `configOption: { name, value }` shape remains accepted for
//! compatibility with agent builds predating that contract.
//!
//! Two halves:
//! - `map_config_option_update` (sync) is called from the event-mapper to
//!   produce the public `RuntimeEvent` (a benign `Other` so observers see
//!   the raw envelope without leaking provider shape upstream).
//! - `mirror_config_snapshot` (async) projects known categories into the
//!   legacy model/effort locks while generic callers read the full snapshot.
//! - `mirror_legacy_config_update` keeps the older single-option shape alive.

use std::sync::Arc;

use tokio::sync::RwLock;

use crate::domain::agents::adapter::{
    RuntimeEvent, RuntimeEventKind, RuntimeEventMetadata, RuntimeSessionConfigKind,
    RuntimeSessionConfigSnapshot, RuntimeSessionConfigValue,
};

use super::thought_level::is_thought_level_config_name;

/// Build the `RuntimeEvent` for a `config_option_update` notification.
///
/// We intentionally surface a `RuntimeEventKind::Other` rather than inventing
/// a typed variant: today no consumer cares about the structured value, and
/// adding a new public kind would force every other adapter to opt in.
pub fn map_config_option_update(metadata: RuntimeEventMetadata) -> RuntimeEvent {
    RuntimeEvent::new(metadata, RuntimeEventKind::Other)
}

/// Unrecognised option names are logged at `debug` and ignored. Explicit
/// `null` values clear the corresponding override. Skips the write if the
/// value is already current — this fires on every `session/update` and we
/// don't want to take the writer lock for a no-op.
pub async fn mirror_legacy_config_update(
    config_id: &str,
    value: Option<&RuntimeSessionConfigValue>,
    current_model: &Arc<RwLock<Option<String>>>,
    current_effort: &Arc<RwLock<Option<String>>>,
) {
    if config_id == "model" {
        if let Some(next) = legacy_select_value(value) {
            write_if_changed(current_model, next).await;
        }
        return;
    }
    if is_thought_level_config_name(config_id) {
        if let Some(next) = legacy_select_value(value) {
            write_if_changed(current_effort, next).await;
        }
        return;
    }
    tracing::debug!(option = config_id, "ignoring unknown config_option_update");
}

fn legacy_select_value(value: Option<&RuntimeSessionConfigValue>) -> Option<Option<String>> {
    match value {
        Some(RuntimeSessionConfigValue::Select(value)) => Some(Some(value.clone())),
        None => Some(None),
        Some(RuntimeSessionConfigValue::Boolean(_)) => None,
    }
}

/// Mirror every known legacy field from a complete authoritative snapshot.
pub async fn mirror_config_snapshot(
    snapshot: &RuntimeSessionConfigSnapshot,
    current_model: &Arc<RwLock<Option<String>>>,
    current_effort: &Arc<RwLock<Option<String>>>,
) {
    for option in &snapshot.options {
        let RuntimeSessionConfigKind::Select { current_value, .. } = &option.kind else {
            continue;
        };
        match option.category.as_deref() {
            Some("model") => write_if_changed(current_model, Some(current_value.clone())).await,
            Some("thought_level") => {
                write_if_changed(current_effort, Some(current_value.clone())).await
            }
            _ if is_thought_level_config_name(&option.id) => {
                write_if_changed(current_effort, Some(current_value.clone())).await
            }
            _ => {}
        }
    }
}

/// Take the writer lock only when the new value differs. Hot-path
/// `session/update` notifications often re-assert the same model/effort
/// per chunk; skipping the write keeps the dispatcher off the writer.
pub(super) async fn write_if_changed(slot: &Arc<RwLock<Option<String>>>, next: Option<String>) {
    if slot.read().await.as_deref() == next.as_deref() {
        return;
    }
    *slot.write().await = next;
}

#[cfg(test)]
mod tests {
    use super::{map_config_option_update, mirror_legacy_config_update};
    use crate::domain::agents::adapter::{RuntimeEventMetadata, RuntimeSessionConfigValue};
    use serde_json::json;
    use std::sync::Arc;
    use tokio::sync::RwLock;

    fn metadata() -> RuntimeEventMetadata {
        RuntimeEventMetadata {
            session_id: Some("s-1".into()),
            usage: None,
            context_window: None,
            raw: json!({}),
        }
    }

    #[test]
    fn map_emits_a_benign_other_event() {
        let event = map_config_option_update(metadata());
        // It's not an init / assistant / result event — it's the
        // catch-all so observers can inspect raw if they want.
        assert!(event.init().is_none());
        assert!(event.assistant_message().is_none());
        assert!(!event.is_result());
    }

    #[tokio::test]
    async fn model_update_writes_current_model() {
        let model = Arc::new(RwLock::new(Some("old".to_string())));
        let effort = Arc::new(RwLock::new(None));
        let value = RuntimeSessionConfigValue::Select("anthropic/claude-4.7".to_string());
        mirror_legacy_config_update("model", Some(&value), &model, &effort).await;
        assert_eq!(model.read().await.as_deref(), Some("anthropic/claude-4.7"));
        assert!(effort.read().await.is_none());
    }

    #[tokio::test]
    async fn thinking_effort_update_writes_effort() {
        let model = Arc::new(RwLock::new(None));
        let effort = Arc::new(RwLock::new(None));
        let value = RuntimeSessionConfigValue::Select("high".to_string());
        mirror_legacy_config_update("thinkingEffort", Some(&value), &model, &effort).await;
        assert_eq!(effort.read().await.as_deref(), Some("high"));
    }

    #[tokio::test]
    async fn null_thinking_effort_clears_local_value() {
        let model = Arc::new(RwLock::new(None));
        let effort = Arc::new(RwLock::new(Some("high".to_string())));
        mirror_legacy_config_update("thinkingEffort", None, &model, &effort).await;
        assert!(effort.read().await.is_none());
    }

    #[tokio::test]
    async fn unknown_option_is_ignored() {
        let model = Arc::new(RwLock::new(Some("keep".to_string())));
        let effort = Arc::new(RwLock::new(Some("medium".to_string())));
        let value = RuntimeSessionConfigValue::Boolean(true);
        mirror_legacy_config_update("exotic", Some(&value), &model, &effort).await;
        assert_eq!(model.read().await.as_deref(), Some("keep"));
        assert_eq!(effort.read().await.as_deref(), Some("medium"));
    }
}
