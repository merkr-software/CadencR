//! Resolve bare Claude model aliases to the concrete catalog id the active
//! profile advertises.
//!
//! Claude Code accepts both bare aliases (`sonnet`, `opus`, `haiku`) and
//! concrete model ids. Under the default Anthropic backend the alias *is* the
//! catalog id and resolves to the latest model. Under Bedrock/Vertex the
//! catalog instead exposes concrete ids (e.g. `us.anthropic.claude-sonnet-4-6`
//! labelled "Sonnet"), and the CLI pins the bare alias to a *legacy* version
//! (`sonnet` → Sonnet 4.5). The interactive CLI picker sends the concrete id;
//! Cadencr historically stored the bare alias, so Bedrock sessions silently ran
//! the legacy model.
//!
//! Mapping a stored alias to the same concrete id the picker would use makes
//! sessions match the CLI without relying on `ANTHROPIC_DEFAULT_*` overrides.

use crate::domain::agents::runtime::ModelCatalogEntry;

/// Translate a requested model id against the active profile's catalog.
///
/// - Ids already present in the catalog (concrete ids, or aliases the backend
///   honours like `haiku`/`default` under Bedrock) are returned unchanged.
/// - A bare family alias (`sonnet`/`opus`/`haiku`, optionally with the `[1m]`
///   suffix) first uses its advertised lowercase id, if present. Otherwise it
///   is mapped to the catalog entry whose
///   label is the canonical family name ("Sonnet", "Opus", "Haiku", or
///   "<Family> (1M context)").
/// - Anything else (custom gateway ids, unknown values) is returned unchanged
///   so the CLI can resolve it.
pub(super) fn resolve_model_alias(model: &str, catalog: &[ModelCatalogEntry]) -> String {
    // The alias is already something the backend's catalog exposes verbatim
    // (a concrete id, or an alias it honours) — nothing to rewrite.
    if catalog.iter().any(|entry| entry.id == model) {
        return model.to_string();
    }

    let normalized_model = model.to_ascii_lowercase();
    let (base, wants_1m) = match normalized_model.strip_suffix("[1m]") {
        Some(base) => (base, true),
        None => (normalized_model.as_str(), false),
    };
    let family = match base {
        "sonnet" => "Sonnet",
        "opus" => "Opus",
        "haiku" => "Haiku",
        // Not a family alias (e.g. `default`, a concrete id, or a custom model):
        // leave it for the CLI to resolve.
        _ => return model.to_string(),
    };
    // A family alias can be advertised with a versioned or descriptive label.
    // Normalize its id before relying on the catalog's display label.
    if normalized_model != model && catalog.iter().any(|entry| entry.id == normalized_model) {
        return normalized_model;
    }
    let target_label = if wants_1m {
        format!("{family} (1M context)")
    } else {
        family.to_string()
    };

    catalog
        .iter()
        .find(|entry| entry.label.eq_ignore_ascii_case(&target_label))
        .map(|entry| entry.id.clone())
        .unwrap_or_else(|| model.to_string())
}

#[cfg(test)]
mod tests {
    use super::resolve_model_alias;
    use crate::domain::agents::runtime::ModelCatalogEntry;

    /// Catalog shape the CLI returns under a Bedrock profile: concrete ids with
    /// canonical family labels, plus legacy rows and the `haiku`/`default`
    /// aliases it still exposes verbatim.
    fn bedrock_catalog() -> Vec<ModelCatalogEntry> {
        vec![
            ModelCatalogEntry::alias("default", "Default"),
            ModelCatalogEntry::alias("us.anthropic.claude-sonnet-4-6", "Sonnet"),
            ModelCatalogEntry::alias("us.anthropic.claude-sonnet-4-6[1m]", "Sonnet (1M context)"),
            ModelCatalogEntry::alias("us.anthropic.claude-opus-4-8", "Opus"),
            ModelCatalogEntry::alias("us.anthropic.claude-opus-4-8[1m]", "Opus (1M context)"),
            ModelCatalogEntry::alias("us.anthropic.claude-opus-4-7", "Opus 4.7"),
            ModelCatalogEntry::alias("haiku", "Haiku"),
        ]
    }

    #[test]
    fn maps_bare_sonnet_to_concrete_bedrock_id() {
        assert_eq!(
            resolve_model_alias("sonnet", &bedrock_catalog()),
            "us.anthropic.claude-sonnet-4-6"
        );
    }

    #[test]
    fn maps_sonnet_1m_alias_to_concrete_1m_id() {
        assert_eq!(
            resolve_model_alias("sonnet[1m]", &bedrock_catalog()),
            "us.anthropic.claude-sonnet-4-6[1m]"
        );
    }

    #[test]
    fn maps_bare_opus_to_primary_not_legacy_row() {
        // "Opus" must win over "Opus 4.7"/"Opus 4.1" legacy rows.
        assert_eq!(
            resolve_model_alias("opus", &bedrock_catalog()),
            "us.anthropic.claude-opus-4-8"
        );
    }

    #[test]
    fn maps_family_alias_case_insensitively() {
        assert_eq!(
            resolve_model_alias("Sonnet", &bedrock_catalog()),
            "us.anthropic.claude-sonnet-4-6"
        );
        assert_eq!(
            resolve_model_alias("SONNET[1M]", &bedrock_catalog()),
            "us.anthropic.claude-sonnet-4-6[1m]"
        );
    }

    #[test]
    fn keeps_haiku_when_catalog_exposes_it_as_an_id() {
        // Bedrock still ships `haiku` as a real catalog id → no rewrite.
        assert_eq!(resolve_model_alias("haiku", &bedrock_catalog()), "haiku");
    }

    #[test]
    fn passes_concrete_id_through_unchanged() {
        assert_eq!(
            resolve_model_alias("us.anthropic.claude-opus-4-7", &bedrock_catalog()),
            "us.anthropic.claude-opus-4-7"
        );
    }

    #[test]
    fn keeps_default_entry_unchanged() {
        assert_eq!(
            resolve_model_alias("default", &bedrock_catalog()),
            "default"
        );
    }

    #[test]
    fn keeps_alias_when_backend_exposes_aliases_directly() {
        // Default Anthropic catalog: the alias *is* the id, so this is a no-op.
        let catalog = vec![
            ModelCatalogEntry::alias("default", "Default (recommended)"),
            ModelCatalogEntry::alias("sonnet", "Sonnet"),
            ModelCatalogEntry::alias("haiku", "Haiku"),
        ];
        assert_eq!(resolve_model_alias("sonnet", &catalog), "sonnet");
    }

    #[test]
    fn normalizes_advertised_family_aliases_independently_of_their_labels() {
        let catalog = vec![
            ModelCatalogEntry::alias("opus", "Opus 5 (recommended)"),
            ModelCatalogEntry::alias("sonnet[1m]", "Sonnet 5 (1M context)"),
            ModelCatalogEntry::alias("haiku", "Haiku 4.5"),
        ];
        for (requested, expected) in [
            ("Opus", "opus"),
            ("SONNET[1M]", "sonnet[1m]"),
            ("HAIKU", "haiku"),
        ] {
            assert_eq!(resolve_model_alias(requested, &catalog), expected);
        }
    }

    #[test]
    fn preserves_case_for_custom_model_ids() {
        let catalog = vec![ModelCatalogEntry::alias("custom-model", "Custom")];
        assert_eq!(
            resolve_model_alias("Custom-Model", &catalog),
            "Custom-Model"
        );
    }

    #[test]
    fn keeps_unknown_or_custom_model_unchanged() {
        assert_eq!(
            resolve_model_alias("my-gateway/custom-model", &bedrock_catalog()),
            "my-gateway/custom-model"
        );
    }

    #[test]
    fn keeps_alias_when_no_matching_family_label_present() {
        // Catalog with no "Sonnet" label can't be mapped → leave for the CLI.
        let catalog = vec![ModelCatalogEntry::alias(
            "us.anthropic.claude-opus-4-8",
            "Opus",
        )];
        assert_eq!(resolve_model_alias("sonnet", &catalog), "sonnet");
    }
}
