use super::model_alias::resolve_model_alias;
use super::ClaudeCodeAdapter;
use crate::domain::agents::adapter::{RuntimePermissionMode, RuntimeSpawnConfig};
use crate::domain::agents::runtime::ModelCatalogEntry;

impl ClaudeCodeAdapter {
    /// The CLI accepts `--permission-mode auto` on a model without auto
    /// support and silently runs its manual `default` mode instead, so such a
    /// spawn goes out in `acceptEdits`. Reads the same profile-env catalog
    /// `spawn` resolves aliases against; without an explicit model (the CLI's
    /// `default`, which leads the auto-capable lineup) neither probes.
    pub(super) async fn auto_spawn_fallback(
        &self,
        config: &RuntimeSpawnConfig,
    ) -> Option<RuntimePermissionMode> {
        if config.permission_mode != Some(RuntimePermissionMode::Auto) {
            return None;
        }
        let model = config.model.as_deref()?;
        let catalog = self.load_models_with_env(config.env.clone()).await;
        lacks_auto(&catalog, model).then_some(RuntimePermissionMode::AcceptEdits)
    }
}

/// Whether the catalog says `model` (resolved the way `spawn` resolves it)
/// cannot run `auto`. A catalog that can't tell keeps `auto`.
fn lacks_auto(catalog: &[ModelCatalogEntry], model: &str) -> bool {
    auto_mode_support(catalog, &resolve_model_alias(model, catalog)) == Some(false)
}

/// Catalog verdict on `auto` for `model_id`; `None` when it can't tell (an
/// unlisted model, or no entry advertises auto at all — the static pre-probe
/// catalog or a CLI predating the mode).
///
/// Non-obvious: the CLI sets `supportsAutoMode: true` only on capable rows
/// and omits it elsewhere, so once any row advertises auto an unflagged row
/// means unsupported. Older CLIs flagged only `default` while `sonnet` /
/// `opus` resolved to capable models, so those aliases stay trusted; `haiku`
/// does not (it meant Haiku 4.5, which lacks auto).
pub(super) fn auto_mode_support(catalog: &[ModelCatalogEntry], model_id: &str) -> Option<bool> {
    let catalog_reports_auto = || catalog.iter().any(|m| m.supports_auto_mode == Some(true));
    match catalog.iter().find(|m| m.id == model_id) {
        Some(entry) if entry.supports_auto_mode.is_some() => entry.supports_auto_mode,
        _ if !catalog_reports_auto() => None,
        _ if matches!(model_id, "default" | "sonnet" | "opus") => Some(true),
        Some(_) => Some(false),
        None => None,
    }
}

#[cfg(test)]
mod tests {
    use super::super::catalog::fallback_models;
    use super::super::test_support::model_with_auto;
    use super::lacks_auto;
    use crate::domain::agents::runtime::ModelCatalogEntry;

    /// Live CLI shape: capable rows carry `supportsAutoMode: true` (today's
    /// bare `haiku` is Haiku 5.5) while Haiku 4.5 omits it.
    fn live_catalog() -> Vec<ModelCatalogEntry> {
        vec![
            model_with_auto("default", Some(true)),
            model_with_auto("haiku", Some(true)),
            model_with_auto("claude-haiku-4-5-20251001", None),
        ]
    }

    /// Bedrock shape: bare aliases are not rows; `spawn` maps them to the
    /// concrete id whose label is the family name.
    fn bedrock_catalog() -> Vec<ModelCatalogEntry> {
        let mut sonnet_45 = model_with_auto("us.anthropic.claude-sonnet-4-5", None);
        sonnet_45.label = "Sonnet".to_string();
        vec![
            model_with_auto("us.anthropic.claude-opus-4-7", Some(true)),
            sonnet_45,
        ]
    }

    #[test]
    fn a_listed_model_without_the_flag_lacks_auto() {
        assert!(lacks_auto(&live_catalog(), "claude-haiku-4-5-20251001"));
    }

    #[test]
    fn capable_models_keep_auto() {
        for model in ["haiku", "default"] {
            assert!(!lacks_auto(&live_catalog(), model), "{model}");
        }
    }

    #[test]
    fn aliases_are_judged_on_the_model_spawn_resolves_them_to() {
        // `sonnet` is not a Bedrock row; trusting it as a modern alias would
        // keep `auto` on what the CLI actually runs as Sonnet 4.5.
        assert!(lacks_auto(&bedrock_catalog(), "sonnet"));
    }

    #[test]
    fn a_catalog_that_cannot_tell_keeps_auto() {
        // Unlisted model, or the static pre-probe catalog where nothing
        // advertises auto: downgrading on a guess would override the user.
        assert!(!lacks_auto(&live_catalog(), "claude-sonnet-4-5"));
        assert!(!lacks_auto(&fallback_models(), "haiku"));
    }
}
