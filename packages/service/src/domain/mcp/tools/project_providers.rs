use serde_json::json;

use crate::domain::agents::providers::{
    provider_alias_metadata, provider_aliases, provider_catalog_entries_live_for_cwd,
    valid_provider_ids,
};
use crate::domain::agents::runtime::{ModelCatalogEntry, ProviderCatalogEntry};
use crate::domain::mcp::context::McpContext;

pub async fn list_agent_providers(ctx: &McpContext) -> Result<serde_json::Value, String> {
    let cwd = super::project::current_project_path(ctx).await?;
    let catalogs =
        provider_catalog_entries_live_for_cwd(&ctx.read_pool, Some(cwd.as_path()), None).await;

    Ok(json!({
        "valid_provider_ids": valid_provider_ids(),
        "providers": catalogs.into_iter().map(provider_doc).collect::<Vec<_>>(),
        "aliases": provider_aliases()
            .into_iter()
            .map(|(provider, aliases)| json!({ "provider": provider, "aliases": aliases }))
            .collect::<Vec<_>>(),
        "spawn_tip": "Use canonical provider/model ids in project_spawn_session. Set thinking_level to one of the selected model's thinking_levels. When omitted, CadencR reuses that provider/model pair's last user-selected level, then its default_thinking_level; if the CLI advertises no default, the field stays unset so the CLI applies its native default."
    }))
}

fn provider_doc(catalog: ProviderCatalogEntry) -> serde_json::Value {
    let metadata = provider_alias_metadata(&catalog.id);
    let aliases = metadata
        .as_ref()
        .map(|metadata| {
            metadata
                .aliases
                .iter()
                .map(ToString::to_string)
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();
    let model_guidance = metadata
        .map(|metadata| metadata.model_guidance.into_owned())
        .unwrap_or_else(|| "Use model ids from this provider's catalog.".to_string());
    let common_models = catalog
        .models
        .iter()
        .map(|model| model.id.clone())
        .collect::<Vec<_>>();
    let models = catalog.models.iter().map(model_doc).collect::<Vec<_>>();

    json!({
        "id": catalog.id,
        "label": catalog.label,
        "status": catalog.status,
        "status_message": catalog.status_message,
        "aliases": aliases,
        "model_guidance": model_guidance,
        "common_models": common_models,
        "models": models,
        "default_model": catalog.default_model,
    })
}

fn model_doc(model: &ModelCatalogEntry) -> serde_json::Value {
    json!({
        "id": model.id,
        "label": model.label,
        "supports_thinking": model.supports_effort,
        "thinking_levels": model.supported_effort_levels,
        "default_thinking_level": model.default_effort_level,
    })
}

#[cfg(test)]
mod tests {
    use super::provider_doc;
    use crate::domain::agents::runtime::{ModelCatalogEntry, ProviderCatalogEntry, ProviderStatus};

    #[test]
    fn provider_doc_exposes_model_advertised_thinking_levels() {
        let catalog = ProviderCatalogEntry {
            id: "codex_cli".to_string(),
            label: "Codex".to_string(),
            icon_data: None,
            status: ProviderStatus::Available,
            status_message: None,
            models: vec![ModelCatalogEntry {
                id: "gpt-future".to_string(),
                label: "GPT Future".to_string(),
                description: None,
                supports_effort: Some(true),
                supported_effort_levels: Some(vec!["low".to_string(), "future-deep".to_string()]),
                default_effort_level: Some("low".to_string()),
                supports_adaptive_thinking: None,
                supports_fast_mode: None,
                supports_auto_mode: None,
            }],
            modes: Vec::new(),
            access_modes: Vec::new(),
            default_model: Some("gpt-future".to_string()),
        };

        let doc = provider_doc(catalog);

        assert_eq!(doc["models"][0]["id"], "gpt-future");
        assert_eq!(doc["models"][0]["supports_thinking"], true);
        assert_eq!(doc["models"][0]["thinking_levels"][1], "future-deep");
        assert_eq!(doc["models"][0]["default_thinking_level"], "low");
    }

    #[test]
    fn provider_doc_preserves_unknown_thinking_capabilities() {
        let catalog = ProviderCatalogEntry {
            id: "custom".to_string(),
            label: "Custom".to_string(),
            icon_data: None,
            status: ProviderStatus::Available,
            status_message: None,
            models: vec![ModelCatalogEntry::alias("custom-model", "Custom Model")],
            modes: Vec::new(),
            access_modes: Vec::new(),
            default_model: Some("custom-model".to_string()),
        };

        let doc = provider_doc(catalog);

        assert!(doc["models"][0]["supports_thinking"].is_null());
        assert!(doc["models"][0]["thinking_levels"].is_null());
    }
}
