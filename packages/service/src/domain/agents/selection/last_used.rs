//! The workspace-level session selection is "the pair the user last prompted
//! with", not a configured default: every user-typed prompt records its
//! provider/model here, so the next new conversation — in any project — starts
//! on it.

use std::collections::BTreeMap;

use crate::domain::agents::runtime::{model_setting_key, runtime_setting_key};
use crate::domain::settings_store;
use crate::error::AppError;

/// Record `provider_id`/`model_id` as the last-used session selection. A `None`
/// model (the session follows its provider's own default, e.g. an inherited
/// profile config) clears the stored model rather than leaving another pick
/// behind. The pair is compared against one snapshot and written in a single
/// batch, so a steady conversation never touches the file and a switch is one
/// write (one watcher event). An unreadable file is left alone: the settings UI
/// already reports it, and a write would be refused anyway.
pub async fn remember_session_selection(
    provider_id: &str,
    model_id: Option<&str>,
) -> Result<(), AppError> {
    let Some(current) = settings_store::global_snapshot() else {
        return Ok(());
    };
    let provider_key = runtime_setting_key("session");
    let model_key = model_setting_key("session");
    let model_id = model_id.unwrap_or("");
    let unchanged = current.get(&provider_key).map(String::as_str) == Some(provider_id)
        && current.get(&model_key).map(String::as_str).unwrap_or("") == model_id;
    if unchanged {
        return Ok(());
    }
    settings_store::global_set_many(&BTreeMap::from([
        (provider_key, Some(provider_id.to_string())),
        (model_key, Some(model_id.to_string())),
    ]))
    .await
    .map(drop)
}

#[cfg(test)]
mod tests {
    use super::remember_session_selection;
    use crate::domain::settings_store;

    #[tokio::test]
    async fn records_the_prompted_pair_as_the_workspace_selection() {
        remember_session_selection("claude_code", Some("opus"))
            .await
            .unwrap();
        assert_eq!(
            settings_store::global_get("agent_runtime_session").as_deref(),
            Some("claude_code")
        );
        assert_eq!(
            settings_store::global_get("model_session").as_deref(),
            Some("opus")
        );
    }

    #[tokio::test]
    async fn a_provider_default_model_clears_the_previous_pick() {
        remember_session_selection("claude_code", Some("opus"))
            .await
            .unwrap();
        remember_session_selection("codex", None).await.unwrap();
        assert_eq!(
            settings_store::global_get("agent_runtime_session").as_deref(),
            Some("codex")
        );
        assert_eq!(settings_store::global_get_nonempty("model_session"), None);
    }
}
