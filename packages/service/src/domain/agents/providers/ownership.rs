use crate::domain::agents::runtime::ProviderCatalogEntry;

pub(super) fn resolve_catalog_provider(
    provider_id: String,
    model: &str,
    catalogs: &[ProviderCatalogEntry],
) -> String {
    let mut unique_owner = None;
    for owner in catalogs
        .iter()
        .filter(|provider| provider.models.iter().any(|entry| entry.id == model))
        .map(|provider| provider.id.as_str())
    {
        if owner == provider_id.as_str() {
            return provider_id;
        }
        if unique_owner.replace(owner).is_some() {
            return provider_id;
        }
    }
    unique_owner.map_or(provider_id, ToOwned::to_owned)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::domain::agents::runtime::{ModelCatalogEntry, ProviderStatus};

    fn catalog(id: &str, models: &[&str]) -> ProviderCatalogEntry {
        ProviderCatalogEntry {
            id: id.to_string(),
            label: id.to_string(),
            icon_data: None,
            status: ProviderStatus::Available,
            status_message: None,
            models: models
                .iter()
                .map(|model| ModelCatalogEntry::alias(*model, *model))
                .collect(),
            modes: Vec::new(),
            access_modes: Vec::new(),
            default_model: None,
        }
    }

    #[test]
    fn selected_catalog_owner_wins_for_ambiguous_model_ids() {
        let catalogs = vec![
            catalog("claude_code", &["gpt-5.6-sol"]),
            catalog("codex_cli", &["gpt-5.6-sol"]),
        ];
        assert_eq!(
            resolve_catalog_provider("claude_code".to_string(), "gpt-5.6-sol", &catalogs),
            "claude_code"
        );
        assert_eq!(
            resolve_catalog_provider("codex_cli".to_string(), "gpt-5.6-sol", &catalogs),
            "codex_cli"
        );
    }

    #[test]
    fn unique_catalog_owner_supports_legacy_model_only_selections() {
        let catalogs = vec![
            catalog("claude_code", &["opus"]),
            catalog("opencode", &["openai/gpt-5.4"]),
        ];
        assert_eq!(
            resolve_catalog_provider("claude_code".to_string(), "openai/gpt-5.4", &catalogs),
            "opencode"
        );
    }

    #[test]
    fn unknown_or_multiply_owned_models_preserve_selected_provider() {
        let catalogs = vec![
            catalog("opencode", &["shared/model"]),
            catalog("codex_cli", &["shared/model"]),
        ];
        assert_eq!(
            resolve_catalog_provider("claude_code".to_string(), "shared/model", &catalogs),
            "claude_code"
        );
        assert_eq!(
            resolve_catalog_provider("claude_code".to_string(), "unknown", &catalogs),
            "claude_code"
        );
    }
}
