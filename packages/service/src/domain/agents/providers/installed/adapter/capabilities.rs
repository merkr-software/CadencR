//! Provider-declared host capabilities projected onto the adapter trait.
//!
//! Each answer is data from the provider executable (its `models` mode maps,
//! its `host-integration` declaration); nothing here branches on identity.

use std::borrow::Cow;
use std::path::Path;

use serde_json::{json, Value};

use crate::domain::agents::adapter::{
    default_prompt_attachment_block, RuntimeCompactionStrategy, RuntimeError,
    RuntimePromptAttachment,
};
use crate::domain::settings_allowlist::provider_access_mode_setting_key;

use super::super::host_integration::HostIntegration;
use super::super::model_discovery::ProviderModeMap;

/// Matches the trait default for providers without a mapped mode.
const FALLBACK_PERMISSION_MODE_WIRE: &str = "acceptEdits";

pub(super) fn worktree_config_paths(integration: &HostIntegration) -> Vec<Cow<'static, str>> {
    integration
        .worktree_config_paths
        .iter()
        .cloned()
        .map(Cow::Owned)
        .collect()
}

pub(super) async fn copy_worktree_config(
    label: &str,
    integration: &HostIntegration,
    source: &Path,
    target: &Path,
) -> Result<(), RuntimeError> {
    let paths = worktree_config_paths(integration);
    if paths.is_empty() {
        return Ok(());
    }
    crate::domain::agents::config_migration::copy_provider_config_paths(
        label, source, target, &paths,
    )
    .await
}

pub(super) fn compaction_strategy(
    integration: &HostIntegration,
) -> Option<RuntimeCompactionStrategy> {
    integration
        .compact_command
        .as_ref()
        .map(|_| RuntimeCompactionStrategy::LiveRuntime)
}

pub(super) fn default_permission_mode_wire(modes: &ProviderModeMap) -> Cow<'static, str> {
    modes
        .primary_mode()
        .map(|mode| Cow::Owned(mode.host_id.clone()))
        .unwrap_or(Cow::Borrowed(FALLBACK_PERMISSION_MODE_WIRE))
}

pub(super) fn access_mode_setting_key(
    provider_id: &str,
    modes: &ProviderModeMap,
) -> Option<Cow<'static, str>> {
    (!modes.access_modes.is_empty())
        .then(|| Cow::Owned(provider_access_mode_setting_key(provider_id)))
}

/// Documents (PDFs) become a standard ACP embedded `resource` with a base64
/// `blob`; the runtime refuses it unless the agent advertised
/// `promptCapabilities.embeddedContext`. Text attachments stay inline text.
pub(super) fn prompt_attachment_block(attachment: &RuntimePromptAttachment<'_>) -> Value {
    if attachment.kind != Some("document") {
        return default_prompt_attachment_block(attachment);
    }
    json!({
        "type": "resource",
        "resource": {
            "uri": format!("file:///attachments/{}", attachment.file_name.replace('/', "_")),
            "mimeType": attachment.mime_type,
            "blob": attachment.base64,
        }
    })
}

#[cfg(test)]
mod tests {
    use super::{access_mode_setting_key, default_permission_mode_wire, prompt_attachment_block};
    use crate::domain::agents::adapter::RuntimePromptAttachment;
    use crate::domain::agents::providers::installed::model_discovery::ProviderModeMap;

    #[test]
    fn documents_become_embedded_resources_and_text_stays_inline() {
        let pdf = prompt_attachment_block(&RuntimePromptAttachment {
            base64: "JVBERi0=",
            mime_type: "application/pdf",
            file_name: "spec/v1.pdf",
            kind: Some("document"),
        });
        assert_eq!(pdf["type"], "resource");
        assert_eq!(pdf["resource"]["mimeType"], "application/pdf");
        assert_eq!(pdf["resource"]["blob"], "JVBERi0=");
        assert_eq!(pdf["resource"]["uri"], "file:///attachments/spec_v1.pdf");

        let text = prompt_attachment_block(&RuntimePromptAttachment {
            base64: "aGk=",
            mime_type: "text/plain",
            file_name: "notes.txt",
            kind: Some("text"),
        });
        assert_eq!(text["type"], "text");
        assert!(text["text"].as_str().unwrap().contains("hi"));
    }

    #[test]
    fn providers_without_mapped_modes_keep_the_host_defaults() {
        let modes = ProviderModeMap::default();
        assert_eq!(default_permission_mode_wire(&modes), "acceptEdits");
        assert!(access_mode_setting_key("acme", &modes).is_none());
    }
}
