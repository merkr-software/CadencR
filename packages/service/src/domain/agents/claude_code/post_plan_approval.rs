use super::auto_mode::auto_mode_support;
use super::ClaudeCodeAdapter;

impl ClaudeCodeAdapter {
    /// Whether the active model can run Claude's classifier-backed `auto`
    /// mode (Sonnet 4.6+ / Opus 4.6+). See [`auto_mode_support`]; unknown
    /// counts as unsupported.
    pub(super) fn model_supports_auto(&self, model_id: &str) -> bool {
        let Ok(models) = self.models_cell().read() else {
            return false;
        };
        auto_mode_support(&models, model_id).unwrap_or(false)
    }
}

#[cfg(test)]
mod tests {
    use super::super::test_support::{model_with_auto, new_test_adapter, seed_models};
    use crate::domain::agents::adapter::AgentRuntimeAdapter;
    use crate::domain::agents::runtime::ModelCatalogEntry;

    #[test]
    fn post_plan_approval_mode_returns_auto_when_model_supports_it() {
        let adapter = new_test_adapter();
        seed_models(
            &adapter,
            vec![model_with_auto("claude-sonnet-4-6", Some(true))],
        );
        assert_eq!(
            adapter.post_plan_approval_mode_wire(Some("claude-sonnet-4-6")),
            "auto"
        );
    }

    #[test]
    fn post_plan_approval_mode_falls_back_to_accept_edits_when_model_does_not_support_auto() {
        let adapter = new_test_adapter();
        seed_models(
            &adapter,
            vec![model_with_auto("claude-sonnet-4-5", Some(false))],
        );
        assert_eq!(
            adapter.post_plan_approval_mode_wire(Some("claude-sonnet-4-5")),
            "acceptEdits"
        );
    }

    #[test]
    fn post_plan_approval_mode_trusts_modern_aliases_when_catalog_advertises_auto_elsewhere() {
        // Reproduces the real CLI shape we saw in the wild: only the
        // `default` row carries `supportsAutoMode: true`; the `sonnet` /
        // `opus` aliases ship with the flag unset even though they
        // resolve to auto-capable models at runtime.
        let adapter = new_test_adapter();
        seed_models(
            &adapter,
            vec![
                model_with_auto("default", Some(true)),
                model_with_auto("sonnet", None),
                model_with_auto("opus", None),
                model_with_auto("haiku", None),
            ],
        );
        assert_eq!(adapter.post_plan_approval_mode_wire(Some("sonnet")), "auto");
        assert_eq!(adapter.post_plan_approval_mode_wire(Some("opus")), "auto");
        assert_eq!(
            adapter.post_plan_approval_mode_wire(Some("default")),
            "auto"
        );
    }

    #[test]
    fn post_plan_approval_mode_matches_live_cli_catalog_shape_for_sonnet_alias() {
        // Regression: production hit `target_mode="acceptEdits"` for a
        // session running model="sonnet" because the live CLI catalog
        // ships the alias rows without `supportsAutoMode`. The shape
        // below is taken verbatim from the SDK's live-CLI mock at
        // `claude-agent-sdk-rs/src/query.rs::supported_models_extracts_models_from_control_response`
        // — if that wire format ever changes, this test catches it
        // before the bug returns.
        let adapter = new_test_adapter();
        seed_models(
            &adapter,
            vec![
                ModelCatalogEntry {
                    id: "default".to_string(),
                    label: "Default (recommended)".to_string(),
                    description: Some("Opus 4.7 with 1M context".to_string()),
                    supports_effort: Some(true),
                    supported_effort_levels: Some(vec![
                        "low".to_string(),
                        "medium".to_string(),
                        "high".to_string(),
                        "xhigh".to_string(),
                        "max".to_string(),
                    ]),
                    default_effort_level: None,
                    supports_adaptive_thinking: Some(true),
                    supports_fast_mode: None,
                    supports_auto_mode: Some(true),
                },
                ModelCatalogEntry {
                    id: "sonnet".to_string(),
                    label: "Sonnet".to_string(),
                    description: Some("Sonnet 4.6".to_string()),
                    supports_effort: None,
                    supported_effort_levels: None,
                    default_effort_level: None,
                    supports_adaptive_thinking: None,
                    supports_fast_mode: None,
                    supports_auto_mode: None,
                },
                ModelCatalogEntry {
                    id: "haiku".to_string(),
                    label: "Haiku".to_string(),
                    description: Some("Haiku 4.5".to_string()),
                    supports_effort: None,
                    supported_effort_levels: None,
                    default_effort_level: None,
                    supports_adaptive_thinking: None,
                    supports_fast_mode: None,
                    supports_auto_mode: None,
                },
            ],
        );
        assert_eq!(
            adapter.post_plan_approval_mode_wire(Some("sonnet")),
            "auto",
            "sonnet alias must resolve to `auto` post-plan-approval — \
             this is the production regression"
        );
        assert_eq!(
            adapter.post_plan_approval_mode_wire(Some("default")),
            "auto"
        );
        assert_eq!(
            adapter.post_plan_approval_mode_wire(Some("haiku")),
            "acceptEdits",
            "haiku 4.5 doesn't support auto mode"
        );
    }

    #[test]
    fn post_plan_approval_mode_does_not_trust_haiku_alias() {
        // Haiku 4.5 doesn't support the classifier-backed mode — the alias
        // must NOT be trusted into `auto` even when the catalog has
        // auto-capable peers.
        let adapter = new_test_adapter();
        seed_models(
            &adapter,
            vec![
                model_with_auto("default", Some(true)),
                model_with_auto("haiku", None),
            ],
        );
        assert_eq!(
            adapter.post_plan_approval_mode_wire(Some("haiku")),
            "acceptEdits"
        );
    }

    #[test]
    fn post_plan_approval_mode_does_not_trust_aliases_when_cli_lacks_auto_support() {
        // Older CLI catalog where no model advertises auto: the alias
        // shouldn't be promoted to `auto` since the CLI itself wouldn't
        // honor it.
        let adapter = new_test_adapter();
        seed_models(
            &adapter,
            vec![
                model_with_auto("default", None),
                model_with_auto("sonnet", None),
            ],
        );
        assert_eq!(
            adapter.post_plan_approval_mode_wire(Some("sonnet")),
            "acceptEdits"
        );
    }

    #[test]
    fn post_plan_approval_mode_respects_explicit_false_on_alias_row() {
        // If the CLI ever sets `supports_auto_mode: false` explicitly on
        // an alias, that wins over the alias-trust fallback.
        let adapter = new_test_adapter();
        seed_models(
            &adapter,
            vec![
                model_with_auto("default", Some(true)),
                model_with_auto("sonnet", Some(false)),
            ],
        );
        assert_eq!(
            adapter.post_plan_approval_mode_wire(Some("sonnet")),
            "acceptEdits"
        );
    }

    #[test]
    fn post_plan_approval_mode_falls_back_for_unknown_model_id() {
        let adapter = new_test_adapter();
        seed_models(
            &adapter,
            vec![model_with_auto("claude-sonnet-4-6", Some(true))],
        );
        assert_eq!(
            adapter.post_plan_approval_mode_wire(Some("not-a-real-model")),
            "acceptEdits"
        );
    }

    #[test]
    fn post_plan_approval_mode_falls_back_when_no_model_provided() {
        let adapter = new_test_adapter();
        seed_models(
            &adapter,
            vec![model_with_auto("claude-sonnet-4-6", Some(true))],
        );
        assert_eq!(adapter.post_plan_approval_mode_wire(None), "acceptEdits");
    }

    #[test]
    fn post_plan_approval_fallback_recovers_auto_to_accept_edits() {
        // When the CLI rejects `auto` (Sonnet 4.5 et al), the orchestrator
        // should try `acceptEdits` instead — the user still leaves plan
        // mode without a permission prompt on every edit.
        let adapter = new_test_adapter();
        assert_eq!(
            adapter
                .post_plan_approval_fallback_mode_wire("auto")
                .as_deref(),
            Some("acceptEdits")
        );
    }

    #[test]
    fn post_plan_approval_fallback_has_no_recovery_for_other_modes() {
        // Only the `auto`-specific catalog optimism is recoverable today;
        // a rejection of `acceptEdits` or `default` is a real CLI failure
        // and should propagate to the user via the standard error envelope.
        let adapter = new_test_adapter();
        assert_eq!(
            adapter.post_plan_approval_fallback_mode_wire("acceptEdits"),
            None
        );
        assert_eq!(
            adapter.post_plan_approval_fallback_mode_wire("default"),
            None
        );
        assert_eq!(adapter.post_plan_approval_fallback_mode_wire("plan"), None);
    }
}
