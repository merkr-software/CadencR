use std::borrow::Cow;

use super::adapter::RuntimePermissionMode;
use super::runtime_adapter;

/// Parse a permission mode string from the client into a PermissionMode enum value.
pub(crate) fn parse_permission_mode(mode: &str) -> RuntimePermissionMode {
    if let Some(agent_name) = super::opencode::agents::agent_name_from_mode_id(mode) {
        return RuntimePermissionMode::OpenCodeAgent(agent_name.to_string());
    }

    match mode {
        "acceptEdits" => RuntimePermissionMode::AcceptEdits,
        "bypassPermissions" => RuntimePermissionMode::BypassPermissions,
        "plan" => RuntimePermissionMode::Plan,
        "ask" => RuntimePermissionMode::Ask,
        "auto" => RuntimePermissionMode::Auto,
        "dontAsk" => RuntimePermissionMode::DontAsk,
        _ => RuntimePermissionMode::Default,
    }
}

pub(crate) fn permission_mode_wire(mode: &RuntimePermissionMode) -> String {
    match mode {
        RuntimePermissionMode::Default => "default".to_string(),
        RuntimePermissionMode::AcceptEdits => "acceptEdits".to_string(),
        RuntimePermissionMode::BypassPermissions => "bypassPermissions".to_string(),
        RuntimePermissionMode::Plan => "plan".to_string(),
        RuntimePermissionMode::Ask => "ask".to_string(),
        RuntimePermissionMode::Auto => "auto".to_string(),
        RuntimePermissionMode::DontAsk => "dontAsk".to_string(),
        RuntimePermissionMode::OpenCodeAgent(name) => {
            super::opencode::agents::mode_id_for_agent(name)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::{effective_permission_mode, parse_permission_mode, permission_mode_wire};
    use crate::domain::agents::adapter::RuntimePermissionMode;

    #[test]
    fn parses_opencode_agent_mode() {
        let mode = parse_permission_mode("opencodeAgent:documentor");
        assert_eq!(
            mode,
            RuntimePermissionMode::OpenCodeAgent("documentor".to_string())
        );
        assert_eq!(permission_mode_wire(&mode), "opencodeAgent:documentor");
    }

    #[test]
    fn parses_and_serializes_ask_mode() {
        let mode = parse_permission_mode("ask");
        assert_eq!(mode, RuntimePermissionMode::Ask);
        assert_eq!(permission_mode_wire(&mode), "ask");
    }

    #[test]
    fn effective_mode_filters_values_the_adapter_does_not_support() {
        assert_eq!(
            effective_permission_mode("cursor", Some("plan")),
            Some(RuntimePermissionMode::Plan)
        );
        assert_eq!(
            effective_permission_mode("cursor", Some("acceptEdits")),
            None
        );
    }
}

/// Whether a given runtime provider can run a given permission mode.
/// Dispatches to the adapter so the (provider, mode) matrix lives next to
/// each adapter's CLI-arg mapping rather than as a switch in shared code.
/// Mirrored on the frontend by `lib/provider-modes.ts`. Unknown providers
/// default to allowing the request — a new adapter must be wired into the
/// registry before its mode policy can be enforced anyway.
pub(crate) fn provider_supports_mode(provider: &str, mode: &RuntimePermissionMode) -> bool {
    runtime_adapter(provider)
        .map(|adapter| adapter.supports_permission_mode(mode))
        .unwrap_or(true)
}

/// Wire string the chip should land on after a session switches to this
/// provider. Mirrors `defaultEditModeFor` in `lib/provider-modes.ts`.
pub(crate) fn default_permission_mode_wire(provider: &str) -> Cow<'static, str> {
    runtime_adapter(provider)
        .map(|adapter| adapter.default_permission_mode_wire())
        .unwrap_or(Cow::Borrowed("acceptEdits"))
}

/// Parsed counterpart of [`default_permission_mode_wire`]. Use this from
/// runtime-spawn paths that need a `RuntimePermissionMode`; the wire variant
/// stays for DB persistence and `mode.changed` broadcasts.
pub(crate) fn default_permission_mode(provider: &str) -> RuntimePermissionMode {
    parse_permission_mode(&default_permission_mode_wire(provider))
}

/// Resolve the requested (or provider-default) permission mode only when the
/// active adapter actually supports it. Generic ACP providers negotiate
/// permissions at runtime and intentionally support no host-owned mode, so
/// carrying the shared `acceptEdits` fallback into their spawn config would
/// claim a capability they never advertised.
pub(crate) fn effective_permission_mode(
    provider: &str,
    requested: Option<&str>,
) -> Option<RuntimePermissionMode> {
    let mode = requested
        .map(parse_permission_mode)
        .unwrap_or_else(|| default_permission_mode(provider));
    provider_supports_mode(provider, &mode).then_some(mode)
}

/// Wire string the chip should land on after a plan is approved
/// (post-`ExitPlanMode`). Dispatches to the adapter so the per-provider
/// matrix lives next to the rest of each adapter's mode policy. Mirrored on
/// the frontend by `postPlanApprovalModeFor` in `lib/provider-modes.ts`.
pub(crate) fn post_plan_approval_mode_wire(
    provider: &str,
    model: Option<&str>,
) -> Cow<'static, str> {
    runtime_adapter(provider)
        .map(|adapter| adapter.post_plan_approval_mode_wire(model))
        .unwrap_or(Cow::Borrowed("acceptEdits"))
}

/// If the post-plan target mode was rejected by the CLI, return the
/// fallback wire string the orchestrator should retry with. `None` means
/// surface the original rejection.
pub(crate) fn post_plan_approval_fallback_mode_wire(
    provider: &str,
    failed_mode_wire: &str,
) -> Option<Cow<'static, str>> {
    runtime_adapter(provider)
        .and_then(|adapter| adapter.post_plan_approval_fallback_mode_wire(failed_mode_wire))
}
