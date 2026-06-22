//! Static setting-key allowlists.

/// Keys writable via `PUT /api/features/{id}/settings`. Covers the real
/// columns on the `features` table plus a small set of EAV keys the frontend
/// writes into `feature_settings`.
pub const FEATURE_ALLOWED_KEYS: &[&str] = &[
    "model_session",
    "agent_runtime_session",
    "skip_worktree",
    "layout_state",
    "draft_prompt",
    // Git workflow (per-feature). `worktree_mode` selects how the worktree is
    // provisioned at feature creation: "new" (default), "reuse" (attach to an
    // existing branch / its worktree), or "skip". `worktree_reuse_branch`
    // carries the branch name when mode = "reuse". `worktree_base_branch`
    // (mode = "new" only) overrides the source branch the new worktree forks
    // from — defaults to the project's current HEAD when unset.
    // `target_branch` overrides the auto-detected compare target.
    // `git_view_mode` persists the Git tab segmented control: "uncommitted"
    // or "vs-target".
    "worktree_mode",
    "worktree_reuse_branch",
    "worktree_base_branch",
    "target_branch",
    "git_view_mode",
];

/// Keys writable via `PUT /api/projects/{id}/settings`.
pub const PROJECT_ALLOWED_KEYS: &[&str] = &[
    "model_session",
    "agent_runtime_session",
    "branch_prefix",
    "default_worktree_mode",
    "color",
    "setup_worktree",
    // Per-project editor tooling selection (Phase 4). Each falls back to the
    // workspace-scoped default when unset on the project (see the matching
    // entries in WORKSPACE_ALLOWED_KEYS). `editor_typescript_server` picks the
    // TS type checker; `editor_linter` picks an optional linter; `editor_formatter`
    // picks the format-on-save / format-command formatter; `editor_format_on_save`
    // toggles auto-format on save.
    "editor_typescript_server",
    "editor_linter",
    "editor_formatter",
    "editor_format_on_save",
];

/// Keys writable via `PUT /api/workspace/settings/{key}`.
pub const WORKSPACE_ALLOWED_KEYS: &[&str] = &[
    // Active Claude Code env profile name
    "claude_code_active_profile",
    // Onboarding-set CLI binary paths (consumed by `apply_binary_overrides_from_settings`).
    "claude_cli_path",
    "opencode_cli_path",
    "codex_cli_path",
    // Per-provider opt-in for the dangerous "skip every check" mode. The
    // Codex boolean remains writable for old clients; current clients use
    // `codex_permission_mode` instead.
    "claude_bypass_permissions_enabled",
    "codex_full_access_enabled",
    "codex_permission_mode",
    // UI chrome
    "sidebar_left_width",
    "sidebar_collapsed",
    "sidebar_right_collapsed",
    "loader_style",
    // UI zoom is kept per device type: desktop scales via the Electron native
    // zoom factor, mobile (remote browser/PWA) via CSS zoom — independent levels.
    "zoom_global",
    "zoom_mobile",
    "unified_agents_per_row",
    // Active theme (id from packages/desktop/src/lib/themes/registry.ts)
    "theme_current",
    // System-theme sync. When enabled, the frontend resolves the active theme
    // from the current OS appearance plus the two appearance-specific theme ids.
    "theme_follow_system",
    "theme_system_light",
    "theme_system_dark",
    // Editor preferences
    "editor_vim_mode",
    "editor_auto_save",
    "editor_git_blame",
    "editor_max_tabs",
    // Workspace-scoped DEFAULTS for the per-project editor tooling keys above.
    // A project without an explicit value inherits these (frontend resolves
    // project-then-workspace). Mirrored in PROJECT_ALLOWED_KEYS.
    "editor_typescript_server",
    "editor_linter",
    "editor_formatter",
    "editor_format_on_save",
    // File-tree icon set used by the editor's @pierre/trees-based file tree.
    // One of "minimal", "standard", or "complete" — defaulting to "standard"
    // when unset. Stored as a workspace setting because the choice is global,
    // not project- or feature-scoped.
    "editor_file_tree_icon_set",
    "editor_sidebar_collapsed",
    "git_sidebar_collapsed",
    "git_merge_mode",
    // Where agent-finished notifications appear: "native" (system banner),
    // "in_app" (Sonner toast inside Cadencr), or "off". Mirrors
    // NOTIFICATION_MODE_KEY in packages/desktop/src/lib/notification-mode.ts.
    "notification_mode",
    // Workspace-scope agent defaults. `auto_name` is global-only.
    "model_session",
    "model_auto_name",
    "agent_runtime_session",
    "agent_runtime_auto_name",
    // First-run onboarding overlay state.
    // `onboarding_step` is one of the values defined in
    // packages/desktop/src/lib/onboarding-step.ts; missing/unset is treated as
    // step "welcome" by the frontend so existing installs see the overlay
    // until they dismiss or complete it.
    // `default_agent_provider` is set during the onboarding's "pick agent"
    // step (provider id from the agent catalog).
    "onboarding_step",
    "default_agent_provider",
    // Master switch for fluid UI animations. When unset the frontend falls back
    // to the OS `prefers-reduced-motion` media query. Stored as "true" / "false".
    "animations_enabled",
    // Global agent stream verbosity. One of the AGENT_VERBOSITY_MODES values
    // in packages/desktop/src/lib/agent-verbosity.ts (currently "maximal" |
    // "auto_collapse" | "collapsed" | "compact"). The frontend is the source
    // of truth for the set; this allowlist only gates the write endpoint.
    "agent_stream_verbosity_mode",
    // Plays the welcome-step intro animation exactly once, on the very first
    // open of the onboarding overlay. Set to "true" by `WelcomeIntro` after
    // the animation completes (or the user clicks to skip).
    "onboarding_intro_shown",
    // Browser workspace preferences. `browser_default_mode` is "normal" or
    // "private" (see packages/desktop/src/lib/browser-settings.ts) and seeds
    // the Browser tab's first tab + toolbar toggle. `browser_mcp_enabled` is
    // "true"/"false" (default enabled) and gates whether the `cadencr-browser`
    // MCP is attached to agent turns — read in the session-prompt spawn path.
    "browser_default_mode",
    "browser_mcp_enabled",
    "project_mcp_enabled",
    "workspace_mcp_enabled",
    "workspace_mcp_max_result_chars",
    // Remote access (host UI). `remote_access_enabled` persists whether the
    // remote listener auto-starts at launch; `remote_tunnel_host` holds an
    // optional tunnel hostname (e.g. Tailscale) added to the Host/Origin
    // allowlist. Both are written via the settings store, so we reference the
    // canonical key constants to keep this allowlist in sync with their source.
    crate::remote::REMOTE_ENABLED_SETTING,
    crate::remote::REMOTE_TUNNEL_HOST_SETTING,
];

/// Prefixes whose suffix is a free-form `<provider>_<model-id>` identifier.
/// Models are discovered dynamically per provider, so the suffix can't be
/// enumerated — it carries whatever characters a provider's ids use: OpenCode
/// provider-scoped refs (`opencode_openai/gpt-5.4`, the `/`), the `[1m]`
/// 1M-context suffix (`claude_code_claude-fable-5[1m]`, the brackets), version
/// dots, and so on. The suffix is only ever a JSON object key whose value is a
/// constrained effort level — it never reaches a path or shell — so we accept
/// any non-empty suffix and reject only whitespace/control characters (which no
/// real model id contains) rather than maintaining a brittle character set.
pub(super) const WORKSPACE_MODEL_PREFIXES: &[&str] = &["thinking_effort_model_"];
