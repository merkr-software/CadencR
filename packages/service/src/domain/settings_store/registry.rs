//! In-code defaults and value validators for constrained settings.
//!
//! Only keys with a constrained value shape (booleans, enums, numbers) get a
//! spec here. Free-form keys (model ids, CLI paths, theme ids, hex colors,
//! shell commands, draft text) are intentionally absent: they're validated only
//! for being known (via the allowlist) and otherwise kept verbatim. This keeps
//! validation from ever rejecting a legitimately free value.
//!
//! `default` is the value substituted at read time when a value fails its
//! validator (super-defensive: a bad value never breaks the app). `None` means
//! "treat an invalid value as unset" and let the consumer's own fallback apply.

/// The shape a setting's string value must take.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ValueKind {
    /// `"true"` or `"false"`.
    Bool,
    /// One of a fixed set of strings.
    Enum(&'static [&'static str]),
    /// Parses as a number.
    Number,
}

#[derive(Clone, Copy, Debug)]
pub struct SettingSpec {
    pub kind: ValueKind,
    pub default: Option<&'static str>,
}

impl SettingSpec {
    const fn new(kind: ValueKind, default: Option<&'static str>) -> Self {
        Self { kind, default }
    }

    /// Whether `value` satisfies this spec's kind.
    pub fn is_valid(&self, value: &str) -> bool {
        match self.kind {
            ValueKind::Bool => value == "true" || value == "false",
            ValueKind::Enum(allowed) => allowed.contains(&value),
            ValueKind::Number => value.trim().parse::<f64>().is_ok(),
        }
    }
}

const BOOL: ValueKind = ValueKind::Bool;
const NUMBER: ValueKind = ValueKind::Number;

/// Validators for the Phase-4 editor tooling keys. Shared between the workspace
/// (global default) and project scopes so a value valid at one scope is valid
/// at the other. Returns `None` for keys not in this set.
fn editor_tooling_spec(key: &str) -> Option<SettingSpec> {
    let spec = match key {
        "editor_typescript_server" => SettingSpec::new(
            ValueKind::Enum(&["typescript-language-server", "tsgo"]),
            Some("typescript-language-server"),
        ),
        "editor_linter" => SettingSpec::new(
            ValueKind::Enum(&["off", "eslint", "biome", "oxlint"]),
            Some("off"),
        ),
        "editor_formatter" => SettingSpec::new(
            ValueKind::Enum(&["off", "biome", "oxfmt", "prettier"]),
            Some("off"),
        ),
        "editor_format_on_save" => SettingSpec::new(BOOL, Some("false")),
        _ => return None,
    };
    Some(spec)
}

/// Spec for a workspace/global key, or `None` for free-form keys.
pub fn workspace_spec(key: &str) -> Option<SettingSpec> {
    if let Some(spec) = editor_tooling_spec(key) {
        return Some(spec);
    }
    let spec = match key {
        // Booleans default to "false" — the historical "unset == off" behavior.
        "editor_vim_mode"
        | "editor_git_blame"
        | "sidebar_collapsed"
        | "sidebar_right_collapsed"
        | "editor_sidebar_collapsed"
        | "git_sidebar_collapsed"
        | "theme_follow_system"
        | "claude_bypass_permissions_enabled"
        | "codex_full_access_enabled"
        | "onboarding_intro_shown" => SettingSpec::new(BOOL, Some("false")),
        // These default on.
        "editor_auto_save"
        | "animations_enabled"
        | "browser_mcp_enabled"
        | "project_mcp_enabled" => SettingSpec::new(BOOL, Some("true")),
        "workspace_mcp_enabled" => SettingSpec::new(BOOL, Some("true")),
        "workspace_mcp_max_result_chars" => SettingSpec::new(NUMBER, Some("100000")),
        // Enums (mirrors the frontend option sets).
        "notification_mode" => SettingSpec::new(
            ValueKind::Enum(&["native", "in_app", "off"]),
            Some("native"),
        ),
        "browser_default_mode" => {
            SettingSpec::new(ValueKind::Enum(&["normal", "private"]), Some("normal"))
        }
        "editor_file_tree_icon_set" => SettingSpec::new(
            ValueKind::Enum(&["minimal", "standard", "complete"]),
            Some("standard"),
        ),
        "agent_stream_verbosity_mode" => SettingSpec::new(
            ValueKind::Enum(&["maximal", "auto_collapse", "collapsed", "compact"]),
            None,
        ),
        // Numbers — invalid input falls through to the consumer's own default.
        "sidebar_left_width"
        | "editor_max_tabs"
        | "zoom_global"
        | "zoom_mobile"
        | "unified_agents_per_row" => SettingSpec::new(NUMBER, None),
        _ => return None,
    };
    Some(spec)
}

/// Spec for a project key, or `None` for free-form keys.
pub fn project_spec(key: &str) -> Option<SettingSpec> {
    if let Some(spec) = editor_tooling_spec(key) {
        return Some(spec);
    }
    match key {
        "default_worktree_mode" => Some(SettingSpec::new(
            ValueKind::Enum(&["new", "reuse", "skip"]),
            None,
        )),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn bool_spec_validates() {
        let spec = workspace_spec("editor_auto_save").unwrap();
        assert!(spec.is_valid("true"));
        assert!(spec.is_valid("false"));
        assert!(!spec.is_valid("yes"));
        assert_eq!(spec.default, Some("true"));
    }

    #[test]
    fn mcp_setting_defaults_enable_agent_mcp_tools_by_default() {
        assert_eq!(
            workspace_spec("project_mcp_enabled").unwrap().default,
            Some("true")
        );
        assert_eq!(
            workspace_spec("workspace_mcp_enabled").unwrap().default,
            Some("true")
        );
        assert_eq!(
            workspace_spec("workspace_mcp_max_result_chars")
                .unwrap()
                .default,
            Some("100000")
        );
        assert!(workspace_spec("project_mcp_allow_spawn").is_none());
        assert!(workspace_spec("project_mcp_allow_send_message").is_none());
    }

    #[test]
    fn enum_spec_validates() {
        let spec = workspace_spec("notification_mode").unwrap();
        assert!(spec.is_valid("native"));
        assert!(!spec.is_valid("loud"));
    }

    #[test]
    fn number_spec_validates() {
        let spec = workspace_spec("zoom_global").unwrap();
        assert!(spec.is_valid("1.25"));
        assert!(!spec.is_valid("big"));
    }

    #[test]
    fn free_form_keys_have_no_spec() {
        assert!(workspace_spec("theme_current").is_none());
        assert!(workspace_spec("claude_cli_path").is_none());
        assert!(project_spec("branch_prefix").is_none());
        assert!(project_spec("setup_worktree").is_none());
    }

    #[test]
    fn project_enum_spec_validates() {
        let spec = project_spec("default_worktree_mode").unwrap();
        assert!(spec.is_valid("new"));
        assert!(!spec.is_valid("clone"));
    }

    #[test]
    fn editor_tooling_specs_present_at_both_scopes() {
        for key in [
            "editor_typescript_server",
            "editor_linter",
            "editor_formatter",
            "editor_format_on_save",
        ] {
            assert!(
                workspace_spec(key).is_some(),
                "{key} missing workspace spec"
            );
            assert!(project_spec(key).is_some(), "{key} missing project spec");
        }
    }

    #[test]
    fn editor_tooling_enums_validate_and_default() {
        let ts = project_spec("editor_typescript_server").unwrap();
        assert!(ts.is_valid("tsgo"));
        assert!(ts.is_valid("typescript-language-server"));
        assert!(!ts.is_valid("flow"));
        assert_eq!(ts.default, Some("typescript-language-server"));

        let linter = project_spec("editor_linter").unwrap();
        assert!(linter.is_valid("off"));
        assert!(linter.is_valid("biome"));
        assert!(!linter.is_valid("tslint"));
        assert_eq!(linter.default, Some("off"));

        let fmt = project_spec("editor_formatter").unwrap();
        assert!(fmt.is_valid("prettier"));
        assert!(!fmt.is_valid("eslint"));
        assert_eq!(fmt.default, Some("off"));

        let fos = project_spec("editor_format_on_save").unwrap();
        assert!(fos.is_valid("true"));
        assert!(!fos.is_valid("yes"));
        assert_eq!(fos.default, Some("false"));
    }
}
