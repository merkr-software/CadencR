//! What the `*_get_settings` / `*_update_settings` MCP tools let an agent see
//! and change: the keys the settings UI writes (the HTTP allowlists), minus the
//! few that would let an agent widen its own reach, with every value checked
//! against the registry before anything is written.

use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::domain::settings::thinking_effort_model_key;
use crate::domain::settings_allowlist::{
    PROJECT_ALLOWED_KEYS, SIDEBAR_DISPLAY_KEYS, WORKSPACE_ALLOWED_KEYS,
};
use crate::domain::settings_store::registry::ValueKind;
use crate::domain::settings_store::Scope;

/// Keys the settings UI writes but an agent may not: they lift approval gates
/// (permission modes), swap the agent CLI that every future turn runs, route
/// API credentials (Codex profiles, forge hosts), or expose this machine to the
/// network (remote access). `setup_worktree` stays writable: it is the point of
/// the tools, and its output shows in each worktree's setup log.
const AGENT_PROTECTED_KEYS: &[&str] = &[
    "claude_bypass_permissions_enabled",
    "codex_full_access_enabled",
    "codex_permission_mode",
    "cursor_access_mode",
    "claude_cli_path",
    "codex_cli_path",
    "opencode_cli_path",
    "codex_profiles",
    crate::domain::git::forge::FORGE_HOSTS_SETTING,
    crate::remote::REMOTE_ENABLED_SETTING,
    crate::remote::REMOTE_TUNNEL_HOST_SETTING,
];

#[derive(Clone, Copy, Debug, Deserialize, Serialize)]
#[serde(rename_all = "snake_case")]
pub(super) enum SettingsScope {
    Global,
    Project,
}

impl SettingsScope {
    fn store_scope(self) -> Scope {
        match self {
            Self::Global => Scope::Workspace,
            Self::Project => Scope::Project,
        }
    }

    fn label(self) -> &'static str {
        match self {
            Self::Global => "global",
            Self::Project => "project",
        }
    }

    fn is_key_known(self, key: &str) -> bool {
        self.store_scope().is_key_known(key)
    }
}

/// Keys an agent may change in one scope, with the value shape the registry
/// enforces, plus the dynamic key families it can't enumerate.
#[derive(Debug, Serialize)]
pub(super) struct Catalog {
    keys: Vec<CatalogEntry>,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    patterns: Vec<KeyPattern>,
}

#[derive(Debug, Serialize)]
struct CatalogEntry {
    key: &'static str,
    #[serde(rename = "type")]
    kind: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    allowed: Option<&'static [&'static str]>,
    #[serde(skip_serializing_if = "Option::is_none")]
    min: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    max: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    default: Option<&'static str>,
}

#[derive(Debug, Serialize)]
struct KeyPattern {
    pattern: String,
    description: &'static str,
}

fn is_agent_protected(key: &str) -> bool {
    AGENT_PROTECTED_KEYS.contains(&key)
}

/// The catalog for `scope`, narrowed to `only` when it names keys. Keys without
/// a registry spec are free-form strings (commands, ids, colors, JSON-encoded
/// arrays/maps).
pub(super) fn catalog(scope: SettingsScope, only: &[String]) -> Catalog {
    let (keys, extra): (&[&'static str], &[&'static str]) = match scope {
        SettingsScope::Global => (WORKSPACE_ALLOWED_KEYS, SIDEBAR_DISPLAY_KEYS),
        SettingsScope::Project => (PROJECT_ALLOWED_KEYS, &[]),
    };
    let keys = keys
        .iter()
        .chain(extra)
        .filter(|key| !is_agent_protected(key))
        .filter(|key| only.is_empty() || only.iter().any(|wanted| wanted == *key))
        .map(|key| catalog_entry(scope.store_scope(), key))
        .collect();
    let patterns = match scope {
        SettingsScope::Global if only.is_empty() => vec![KeyPattern {
            pattern: thinking_effort_model_key("<provider_id>", "<model_id>"),
            description: "Last-used thinking level for one provider/model pair (a thinking_levels value from project_list_agent_providers).",
        }],
        _ => Vec::new(),
    };
    Catalog { keys, patterns }
}

fn catalog_entry(scope: Scope, key: &'static str) -> CatalogEntry {
    let spec = scope.spec(key);
    let (kind, allowed, min, max) = match spec.map(|spec| spec.kind) {
        Some(ValueKind::Bool) => ("boolean", None, None, None),
        Some(ValueKind::Enum(values)) => ("enum", Some(values), None, None),
        Some(ValueKind::Number) => ("number", None, None, None),
        Some(ValueKind::IntegerRange { min, max }) => ("integer", None, Some(min), Some(max)),
        Some(ValueKind::IdList(values)) => ("list", Some(values), None, None),
        None => ("string", None, None, None),
    };
    CatalogEntry {
        key,
        kind,
        allowed,
        min,
        max,
        default: spec.and_then(|spec| spec.default),
    }
}

/// Refuse a read naming keys the scope doesn't have, so a typo isn't mistaken
/// for "unset, the default applies".
pub(super) fn check_known_keys(scope: SettingsScope, keys: &[String]) -> Result<(), String> {
    let unknown: Vec<&str> = keys
        .iter()
        .map(String::as_str)
        .filter(|key| !scope.is_key_known(key))
        .collect();
    if unknown.is_empty() {
        Ok(())
    } else {
        Err(format!(
            "unknown {} setting(s): {}; read the catalog with include_catalog=true",
            scope.label(),
            unknown.join(", ")
        ))
    }
}

/// Turn the agent's `values` object into store writes (`None` removes the key
/// so its default applies again). All-or-nothing: every problem is reported at
/// once and nothing is written unless every entry is acceptable.
pub(super) fn validate_updates(
    scope: SettingsScope,
    values: &serde_json::Map<String, Value>,
) -> Result<BTreeMap<String, Option<String>>, String> {
    if values.is_empty() {
        return Err("values must contain at least one setting".into());
    }
    let mut updates = BTreeMap::new();
    let mut problems = Vec::new();
    for (key, raw) in values {
        match validate_entry(scope, key, raw) {
            Ok(value) => {
                updates.insert(key.clone(), value);
            }
            Err(problem) => problems.push(format!("{key}: {problem}")),
        }
    }
    if problems.is_empty() {
        Ok(updates)
    } else {
        Err(format!("No setting was changed. {}", problems.join("; ")))
    }
}

fn validate_entry(scope: SettingsScope, key: &str, raw: &Value) -> Result<Option<String>, String> {
    if !scope.is_key_known(key) {
        return Err(format!(
            "unknown {} setting; read the catalog with include_catalog=true",
            scope.label()
        ));
    }
    if is_agent_protected(key) {
        return Err("only the user can change this setting, in CadencR's settings".into());
    }
    let Some(value) = coerce_value(raw) else {
        return Ok(None);
    };
    match scope.store_scope().spec(key) {
        Some(spec) if !spec.is_valid(&value) => Err(format!(
            "invalid value {value:?} ({}); pass null to reset it to its default",
            expected_shape(spec.kind)
        )),
        _ => Ok(Some(value)),
    }
}

/// Settings are stored as strings. Agents naturally send booleans and numbers,
/// and JSON-valued keys (arrays/maps) are stored JSON-encoded — accept each.
fn coerce_value(raw: &Value) -> Option<String> {
    match raw {
        Value::Null => None,
        Value::String(value) => Some(value.clone()),
        Value::Bool(_) | Value::Number(_) | Value::Array(_) | Value::Object(_) => {
            Some(raw.to_string())
        }
    }
}

fn expected_shape(kind: ValueKind) -> String {
    match kind {
        ValueKind::Bool => "expected true or false".into(),
        ValueKind::Enum(values) => format!("expected one of {}", values.join(", ")),
        ValueKind::Number => "expected a number".into(),
        ValueKind::IntegerRange { min, max } => format!("expected an integer from {min} to {max}"),
        ValueKind::IdList(values) => format!(
            "expected a comma-separated list of distinct values among {}",
            values.join(", ")
        ),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn values(value: Value) -> serde_json::Map<String, Value> {
        value.as_object().unwrap().clone()
    }

    #[test]
    fn project_updates_accept_the_worktree_setup_command() {
        let updates = validate_updates(
            SettingsScope::Project,
            &values(json!({
                "setup_worktree": "pnpm install\npnpm dev:configure-worktree",
                "branch_prefix": "feature/",
                "default_worktree_mode": "new"
            })),
        )
        .unwrap();
        assert_eq!(
            updates["setup_worktree"].as_deref(),
            Some("pnpm install\npnpm dev:configure-worktree")
        );
        assert_eq!(updates["default_worktree_mode"].as_deref(), Some("new"));
    }

    #[test]
    fn booleans_numbers_null_and_json_values_are_coerced() {
        let updates = validate_updates(
            SettingsScope::Global,
            &values(json!({
                "editor_auto_save": false,
                "retention_compact_archived_days": 14,
                "theme_current": null,
                "favorite_models": ["claude_code:opus"]
            })),
        )
        .unwrap();
        assert_eq!(updates["editor_auto_save"].as_deref(), Some("false"));
        assert_eq!(
            updates["retention_compact_archived_days"].as_deref(),
            Some("14")
        );
        assert_eq!(updates["theme_current"], None);
        assert_eq!(
            updates["favorite_models"].as_deref(),
            Some(r#"["claude_code:opus"]"#)
        );
    }

    #[test]
    fn one_bad_entry_rejects_the_whole_batch_and_names_every_problem() {
        let error = validate_updates(
            SettingsScope::Global,
            &values(json!({
                "theme_current": "tokyo-night",
                "notification_mode": "loud",
                "made_up_key": "x",
                "retention_compact_archived_days": 999
            })),
        )
        .unwrap_err();
        assert!(error.starts_with("No setting was changed."), "{error}");
        assert!(
            error.contains("notification_mode: invalid value"),
            "{error}"
        );
        assert!(error.contains("native, in_app, notch, off"), "{error}");
        assert!(
            error.contains("made_up_key: unknown global setting"),
            "{error}"
        );
        assert!(error.contains("from 1 to 365"), "{error}");
        assert!(!error.contains("theme_current"), "{error}");
    }

    #[test]
    fn scope_decides_which_keys_exist() {
        let error = validate_updates(
            SettingsScope::Global,
            &values(json!({ "setup_worktree": "pnpm install" })),
        )
        .unwrap_err();
        assert!(error.contains("unknown global setting"), "{error}");
        assert!(validate_updates(
            SettingsScope::Project,
            &values(json!({ "theme_current": "x" }))
        )
        .is_err());
    }

    #[test]
    fn privilege_and_credential_keys_stay_user_only() {
        for key in AGENT_PROTECTED_KEYS {
            assert!(
                Scope::Workspace.is_key_known(key),
                "{key} should be a real global key"
            );
            let error = validate_updates(SettingsScope::Global, &values(json!({ *key: "true" })))
                .unwrap_err();
            assert!(error.contains("only the user"), "{key}: {error}");
        }
    }

    #[test]
    fn empty_values_are_refused() {
        assert!(validate_updates(SettingsScope::Global, &serde_json::Map::new()).is_err());
    }

    #[test]
    fn catalog_describes_value_shapes_without_user_only_keys() {
        let global = serde_json::to_value(catalog(SettingsScope::Global, &[])).unwrap();
        let entry = |key: &str| {
            global["keys"]
                .as_array()
                .unwrap()
                .iter()
                .find(|entry| entry["key"] == key)
                .cloned()
        };
        assert_eq!(entry("editor_auto_save").unwrap()["type"], "boolean");
        assert_eq!(entry("editor_auto_save").unwrap()["default"], "true");
        assert_eq!(entry("notification_mode").unwrap()["allowed"][0], "native");
        assert_eq!(
            entry("retention_compact_archived_days").unwrap()["max"],
            365
        );
        assert_eq!(entry("theme_current").unwrap()["type"], "string");
        assert!(entry("sidebar_density").is_some());
        assert!(entry("claude_bypass_permissions_enabled").is_none());
        assert_eq!(
            global["patterns"][0]["pattern"],
            "thinking_effort_model_<provider_id>_<model_id>"
        );

        let project = serde_json::to_value(catalog(SettingsScope::Project, &[])).unwrap();
        assert!(project["keys"]
            .as_array()
            .unwrap()
            .iter()
            .any(|entry| entry["key"] == "setup_worktree"));
        assert!(project.get("patterns").is_none());
    }

    #[test]
    fn a_keyed_read_narrows_the_catalog() {
        let narrowed = serde_json::to_value(catalog(
            SettingsScope::Global,
            &["theme_current".to_string(), "editor_auto_save".to_string()],
        ))
        .unwrap();
        assert_eq!(narrowed["keys"].as_array().unwrap().len(), 2);
        assert!(narrowed.get("patterns").is_none());
    }

    #[test]
    fn reads_refuse_keys_the_scope_does_not_have() {
        assert!(check_known_keys(SettingsScope::Project, &["setup_worktree".into()]).is_ok());
        let error = check_known_keys(
            SettingsScope::Project,
            &["setup_worktre".into(), "theme_current".into()],
        )
        .unwrap_err();
        assert!(error.contains("setup_worktre, theme_current"), "{error}");
    }
}
