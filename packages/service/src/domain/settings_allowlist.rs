//! Allowlists for HTTP settings-write endpoints.
//!
//! Each `PUT /api/{features,projects,workspace}/.../settings` route consults
//! the matching function here before delegating to the repository. An unknown
//! key returns 400 so a compromised agent can't write keys the server manages
//! on its own (e.g. `worktree_path`) or keys that are documented-intent RCE
//! (e.g. `setup_worktree` on the feature scope).
//!
//! The write path is the only enforcement point. Legacy DB rows with unknown
//! keys are harmless — reads still work, and if an old key is no longer
//! writable that just means the UI that used to write it has moved on.

mod keys;

use keys::WORKSPACE_MODEL_PREFIXES;
pub use keys::{FEATURE_ALLOWED_KEYS, PROJECT_ALLOWED_KEYS, WORKSPACE_ALLOWED_KEYS};

/// Whether `suffix` is a plausible `<provider>_<model-id>` identifier: non-empty
/// and free of whitespace and control characters.
fn is_model_suffix(suffix: &str) -> bool {
    !suffix.is_empty() && !suffix.chars().any(|c| c.is_whitespace() || c.is_control())
}

pub fn is_feature_key_allowed(key: &str) -> bool {
    FEATURE_ALLOWED_KEYS.contains(&key)
}

pub fn is_project_key_allowed(key: &str) -> bool {
    PROJECT_ALLOWED_KEYS.contains(&key)
}

pub fn is_workspace_key_allowed(key: &str) -> bool {
    if WORKSPACE_ALLOWED_KEYS.contains(&key) {
        return true;
    }
    WORKSPACE_MODEL_PREFIXES
        .iter()
        .any(|p| key.strip_prefix(p).is_some_and(is_model_suffix))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn rejects_unknown_feature_key() {
        assert!(!is_feature_key_allowed("setup_worktree"));
        assert!(!is_feature_key_allowed("worktree_path"));
        assert!(!is_feature_key_allowed("arbitrary_injected_key"));
        assert!(!is_feature_key_allowed("agent_autonomy"));
        assert!(!is_feature_key_allowed("parallel_execution"));
        assert!(!is_feature_key_allowed("model_qa"));
        assert!(!is_feature_key_allowed("agent_runtime_qa"));
    }
    #[test]
    fn accepts_known_feature_keys() {
        assert!(is_feature_key_allowed("skip_worktree"));
        assert!(is_feature_key_allowed("model_session"));
        assert!(is_feature_key_allowed("layout_state"));
        assert!(is_feature_key_allowed("draft_prompt"));
    }
    #[test]
    fn rejects_retired_bypass_acknowledged_key() {
        // `bypass_acknowledged` was the gate for an old bypass design. The
        // current design gates bypass solely on the workspace-scoped
        // `claude_bypass_permissions_enabled` capability, so the legacy key is
        // no longer read or writable at any scope.
        assert!(!is_feature_key_allowed("bypass_acknowledged"));
        assert!(!is_project_key_allowed("bypass_acknowledged"));
        assert!(!is_workspace_key_allowed("bypass_acknowledged"));
    }
    #[test]
    fn rejects_legacy_thinking_effort_keys_everywhere() {
        // Per-agent-type thinking effort settings were removed in favour of
        // per-model workspace defaults. Old keys should no longer be writable
        // at any scope.
        for k in [
            "thinking_effort_session",
            "thinking_effort_plan",
            "thinking_effort_qa",
            "thinking_effort_auto_name",
        ] {
            assert!(
                !is_feature_key_allowed(k),
                "{k} must be rejected on feature"
            );
            assert!(
                !is_project_key_allowed(k),
                "{k} must be rejected on project"
            );
            assert!(
                !is_workspace_key_allowed(k),
                "{k} must be rejected on workspace"
            );
        }
    }
    #[test]
    fn project_allows_setup_worktree_but_feature_does_not() {
        assert!(is_project_key_allowed("setup_worktree"));
        assert!(!is_feature_key_allowed("setup_worktree"));
    }
    #[test]
    fn feature_allows_git_workflow_keys() {
        // Mirror how `skip_worktree` is scoped: writable on feature only.
        for k in [
            "worktree_mode",
            "worktree_reuse_branch",
            "worktree_base_branch",
            "target_branch",
            "git_view_mode",
        ] {
            assert!(
                is_feature_key_allowed(k),
                "{k} should be allowed on feature"
            );
            assert!(
                !is_project_key_allowed(k),
                "{k} must be rejected on project"
            );
            assert!(
                !is_workspace_key_allowed(k),
                "{k} must be rejected on workspace"
            );
        }
    }
    #[test]
    fn editor_tooling_keys_allowed_on_project_and_workspace() {
        // Per-project tooling with a workspace-scoped global default fallback,
        // so the same keys must be writable at both scopes.
        for k in [
            "editor_typescript_server",
            "editor_linter",
            "editor_formatter",
            "editor_format_on_save",
        ] {
            assert!(
                is_project_key_allowed(k),
                "{k} should be allowed on project"
            );
            assert!(
                is_workspace_key_allowed(k),
                "{k} should be allowed on workspace (global default)"
            );
            assert!(
                !is_feature_key_allowed(k),
                "{k} must not be writable on feature"
            );
        }
    }

    #[test]
    fn project_allows_default_worktree_mode_only() {
        assert!(is_project_key_allowed("default_worktree_mode"));
        assert!(!is_feature_key_allowed("default_worktree_mode"));
        assert!(!is_workspace_key_allowed("default_worktree_mode"));
    }
    #[test]
    fn rejects_worktree_path_everywhere() {
        assert!(!is_feature_key_allowed("worktree_path"));
        assert!(!is_project_key_allowed("worktree_path"));
        assert!(!is_workspace_key_allowed("worktree_path"));
        assert!(!is_feature_key_allowed("worktree_branch"));
        assert!(!is_feature_key_allowed("worktree_setup_step"));
        assert!(!is_feature_key_allowed("worktree_setup_log"));
    }
    #[test]
    fn workspace_rejects_retired_per_device_ui_keys() {
        // `active_tab_*`, `editor_sidebar_visible_*`, and `lastOpenedFeature`
        // were per-device UI state; they now live in the frontend's
        // localStorage and are no longer writable at any scope.
        assert!(!is_workspace_key_allowed("editor_sidebar_visible_42"));
        assert!(!is_workspace_key_allowed("active_tab_7"));
        assert!(!is_workspace_key_allowed("lastOpenedFeature"));
    }
    #[test]
    fn workspace_rejects_unknown_static_key() {
        assert!(!is_workspace_key_allowed("arbitrary"));
    }
    #[test]
    fn workspace_accepts_theme_current() {
        // Theme picker writes the active theme id (see
        // packages/desktop/src/lib/themes/registry.ts). Workspace-scoped so it
        // mirrors every other UI-chrome setting.
        assert!(is_workspace_key_allowed("theme_current"));
        assert!(is_workspace_key_allowed("theme_follow_system"));
        assert!(is_workspace_key_allowed("theme_system_light"));
        assert!(is_workspace_key_allowed("theme_system_dark"));
    }
    #[test]
    fn workspace_accepts_per_model_thinking_effort_keys() {
        assert!(is_workspace_key_allowed(
            "thinking_effort_model_claude_code_claude-opus-4"
        ));
        assert!(is_workspace_key_allowed(
            "thinking_effort_model_claude_code_claude-sonnet-4-5"
        ));
        assert!(is_workspace_key_allowed("thinking_effort_model_opencode_x"));
        assert!(is_workspace_key_allowed(
            "thinking_effort_model_provider_model.v2"
        ));
        // OpenCode provider-scoped refs carry a `/`, and the `[1m]` 1M-context
        // suffix carries brackets — both are legitimate model ids and must be
        // accepted, not flagged as unrecognized settings.
        assert!(is_workspace_key_allowed(
            "thinking_effort_model_opencode_openai/gpt-5.4"
        ));
        assert!(is_workspace_key_allowed(
            "thinking_effort_model_claude_code_claude-fable-5[1m]"
        ));
        assert!(is_workspace_key_allowed(
            "thinking_effort_model_claude_code_us.anthropic.claude-sonnet-4-6[1m]"
        ));
        // Dynamically discovered ids: a `-mini` variant the catalog grew later
        // must be accepted without touching this file.
        assert!(is_workspace_key_allowed(
            "thinking_effort_model_opencode_openai/gpt-5.4-mini"
        ));
    }
    #[test]
    fn workspace_rejects_malformed_per_model_thinking_effort_keys() {
        // The suffix is an opaque model id (a JSON key, never a path/shell arg),
        // so we reject only what no real id contains: emptiness, whitespace, and
        // control characters.
        assert!(!is_workspace_key_allowed("thinking_effort_model_"));
        assert!(!is_workspace_key_allowed("thinking_effort_model_a b"));
        assert!(!is_workspace_key_allowed("thinking_effort_model_a\tb"));
        assert!(!is_workspace_key_allowed("thinking_effort_model_a\nb"));
    }
    #[test]
    fn workspace_accepts_remote_access_settings() {
        // Written internally via the settings store (crate::remote), so the
        // read-time validator must recognize them or it flags the user's own
        // settings.json keys as unrecognized.
        assert!(is_workspace_key_allowed("remote_access_enabled"));
        assert!(is_workspace_key_allowed("remote_tunnel_host"));
        assert!(!is_feature_key_allowed("remote_access_enabled"));
        assert!(!is_project_key_allowed("remote_access_enabled"));
    }
    #[test]
    fn workspace_accepts_notification_mode() {
        // Wired to packages/desktop/src/lib/notification-mode.ts —
        // the Settings → Notifications picker writes "native" / "in_app" / "off".
        // Without this, useDebouncedSetting toasts "Could not save setting".
        assert!(is_workspace_key_allowed("notification_mode"));
        assert!(!is_feature_key_allowed("notification_mode"));
        assert!(!is_project_key_allowed("notification_mode"));
    }
    #[test]
    fn workspace_accepts_ui_collapse_settings() {
        assert!(is_workspace_key_allowed("editor_sidebar_collapsed"));
        assert!(is_workspace_key_allowed("git_sidebar_collapsed"));
        assert!(is_workspace_key_allowed("unified_agents_per_row"));
    }
    #[test]
    fn workspace_accepts_per_device_zoom_keys() {
        // Desktop and mobile persist independent zoom levels under separate keys;
        // without both, the FE gets a BAD_REQUEST and zoom silently fails to save.
        assert!(is_workspace_key_allowed("zoom_global"));
        assert!(is_workspace_key_allowed("zoom_mobile"));
    }
    #[test]
    fn workspace_accepts_dangerous_mode_toggles() {
        // DangerousModeToggle persists these via useDebouncedSetting → PUT
        // /api/workspace/settings/{key}. Without these, the FE gets a
        // BAD_REQUEST and the toggle silently fails to enable.
        assert!(is_workspace_key_allowed(
            "claude_bypass_permissions_enabled"
        ));
        assert!(is_workspace_key_allowed("codex_full_access_enabled"));
        assert!(is_workspace_key_allowed("codex_permission_mode"));
    }
    #[test]
    fn workspace_accepts_onboarding_keys() {
        // Used by the first-run OnboardingOverlay to persist the current step
        // and the default agent provider chosen by the user.
        assert!(is_workspace_key_allowed("onboarding_step"));
        assert!(is_workspace_key_allowed("default_agent_provider"));
        assert!(is_workspace_key_allowed("onboarding_intro_shown"));
    }
    #[test]
    fn workspace_accepts_agent_stream_verbosity_mode() {
        // Persisted by the global Settings page → "Agent output verbosity"
        // picker via useDebouncedSetting. Without this, switching modes
        // returns 400 and the FE toast "Could not save setting".
        assert!(is_workspace_key_allowed("agent_stream_verbosity_mode"));
        assert!(!is_feature_key_allowed("agent_stream_verbosity_mode"));
        assert!(!is_project_key_allowed("agent_stream_verbosity_mode"));
    }
    #[test]
    fn workspace_accepts_animations_enabled() {
        // Master switch for fluid UI animations, persisted from the Welcome
        // onboarding step and the Settings → Appearance toggle.
        assert!(is_workspace_key_allowed("animations_enabled"));
        assert!(!is_feature_key_allowed("animations_enabled"));
        assert!(!is_project_key_allowed("animations_enabled"));
    }

    #[test]
    fn workspace_accepts_editor_file_tree_icon_set() {
        // The Settings → Appearance picker writes "minimal" / "standard" /
        // "complete" via useDebouncedSetting → PUT /api/workspace/settings/{key}.
        assert!(is_workspace_key_allowed("editor_file_tree_icon_set"));
        assert!(!is_feature_key_allowed("editor_file_tree_icon_set"));
        assert!(!is_project_key_allowed("editor_file_tree_icon_set"));
    }

    #[test]
    fn workspace_accepts_browser_settings() {
        assert!(is_workspace_key_allowed("browser_default_mode"));
        assert!(is_workspace_key_allowed("browser_mcp_enabled"));
        assert!(is_workspace_key_allowed("project_mcp_enabled"));
        assert!(is_workspace_key_allowed("workspace_mcp_enabled"));
        assert!(is_workspace_key_allowed("workspace_mcp_max_result_chars"));
        assert!(!is_workspace_key_allowed("project_mcp_allow_spawn"));
        assert!(!is_workspace_key_allowed("project_mcp_allow_send_message"));
        assert!(!is_feature_key_allowed("browser_mcp_enabled"));
        assert!(!is_project_key_allowed("browser_mcp_enabled"));
    }

    #[test]
    fn workspace_accepts_agent_defaults() {
        // These flow through the global Settings page + useDebouncedSetting.
        for k in [
            "model_session",
            "model_auto_name",
            "agent_runtime_session",
            "agent_runtime_auto_name",
            "sidebar_right_collapsed",
        ] {
            assert!(is_workspace_key_allowed(k), "{k} should be allowed");
        }
    }
}
