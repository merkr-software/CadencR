//! Schemas for the settings tools both orchestration servers advertise:
//! `project_*_settings` (current project + global) and `workspace_*_settings`
//! (any project by id + global).

use serde_json::{json, Value};

use crate::domain::mcp::settings_tool::SettingsTool;

const PROJECT_GET: &str = "Read CadencR settings: this project's (scope \"project\", the default: worktree setup commands, branch prefix, default worktree mode, color, editor tooling) or the global ones shared by every project (scope \"global\": theme, editor, git, notifications, sidebar, browser, agent defaults). Returns the stored values — an absent key uses its default — and the settings file path. Pass include_catalog=true to list the keys you can change with their type, allowed values, and default.";

const PROJECT_UPDATE: &str = "Change CadencR settings for this project (scope \"project\") or globally for every project (scope \"global\"), exactly as the settings UI does; open windows update live. Pass values as {key: value}; null removes a key so its default applies again. Every entry is checked first: one unknown key or invalid value rejects the whole call and nothing changes. setup_worktree holds the shell commands (one per line) CadencR runs in each new worktree of the project. Permission bypass modes, agent CLI paths, credential routing (codex_profiles, forge_hosts), and remote access stay user-only. Read the current values first and tell the user what you changed.";

const WORKSPACE_GET: &str = "Read CadencR's global settings (scope \"global\", the default) or any registered project's settings (scope \"project\" with a project_id from workspace_list_projects): worktree setup commands, branch prefix, editor tooling, theme, notifications, sidebar, agent defaults. Returns the stored values — an absent key uses its default — and the settings file path. Pass include_catalog=true to list the keys you can change with their type, allowed values, and default.";

const WORKSPACE_UPDATE: &str = "Change CadencR's global settings (scope \"global\") or any registered project's settings (scope \"project\" with a project_id from workspace_list_projects), exactly as the settings UI does; open windows update live. Pass values as {key: value}; null removes a key so its default applies again. Every entry is checked first: one unknown key or invalid value rejects the whole call and nothing changes. setup_worktree holds the shell commands (one per line) CadencR runs in each new worktree of that project. Permission bypass modes, agent CLI paths, credential routing (codex_profiles, forge_hosts), and remote access stay user-only. Read the current values first and tell the user what you changed.";

pub(super) fn get_description(tool: SettingsTool) -> &'static str {
    match tool {
        SettingsTool::Project => PROJECT_GET,
        SettingsTool::Workspace => WORKSPACE_GET,
    }
}

pub(super) fn update_description(tool: SettingsTool) -> &'static str {
    match tool {
        SettingsTool::Project => PROJECT_UPDATE,
        SettingsTool::Workspace => WORKSPACE_UPDATE,
    }
}

pub(super) fn get_schema(tool: SettingsTool) -> Value {
    with_project_id(
        tool,
        json!({
            "type": "object",
            "properties": {
                "scope": scope_property(Some(tool.default_read_scope())),
                "keys": {
                    "type": "array",
                    "items": { "type": "string" },
                    "description": "Only return these keys (null when unset) and, with include_catalog, only their catalog entries. Omit to return every stored value."
                },
                "include_catalog": {
                    "type": "boolean",
                    "default": false,
                    "description": "Also return the catalog of keys you can change in this scope: type, allowed values or range, and default."
                }
            }
        }),
    )
}

pub(super) fn update_schema(tool: SettingsTool) -> Value {
    with_project_id(
        tool,
        json!({
            "type": "object",
            "properties": {
                "scope": scope_property(None),
                "values": {
                    "type": "object",
                    "minProperties": 1,
                    "additionalProperties": true,
                    "description": "Settings to change, as {key: value}. Values are stored as strings: booleans and numbers are converted, arrays/objects are JSON-encoded, and null removes the key so its default applies. Example: {\"setup_worktree\": \"pnpm install\", \"branch_prefix\": \"feature/\"}."
                }
            },
            "required": ["scope", "values"]
        }),
    )
}

fn with_project_id(tool: SettingsTool, mut schema: Value) -> Value {
    if tool.allows_cross_project() {
        schema["properties"]["project_id"] = json!({
            "type": "number",
            "description": "Project whose settings to use when scope is \"project\" (an id from workspace_list_projects). Omit for scope \"global\"."
        });
    }
    schema
}

fn scope_property(default: Option<&str>) -> Value {
    let mut scope = json!({
        "type": "string",
        "enum": ["project", "global"],
        "description": "\"project\" targets one project's settings document; \"global\" targets the settings shared by every project."
    });
    if let Some(default) = default {
        scope["default"] = json!(default);
    }
    scope
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_default_to_each_servers_natural_scope() {
        assert_eq!(
            get_schema(SettingsTool::Project)["properties"]["scope"]["default"],
            "project"
        );
        assert_eq!(
            get_schema(SettingsTool::Workspace)["properties"]["scope"]["default"],
            "global"
        );
    }

    #[test]
    fn only_workspace_tools_take_a_project_id() {
        for schema in [
            get_schema(SettingsTool::Project),
            update_schema(SettingsTool::Project),
        ] {
            assert!(schema["properties"].get("project_id").is_none());
        }
        for schema in [
            get_schema(SettingsTool::Workspace),
            update_schema(SettingsTool::Workspace),
        ] {
            assert_eq!(schema["properties"]["project_id"]["type"], "number");
        }
    }

    #[test]
    fn updates_require_an_explicit_scope_and_values() {
        for tool in [SettingsTool::Project, SettingsTool::Workspace] {
            let schema = update_schema(tool);
            assert_eq!(schema["required"], json!(["scope", "values"]));
            assert!(schema["properties"]["scope"].get("default").is_none());
            assert_eq!(schema["properties"]["values"]["type"], "object");
            assert!(update_description(tool).contains("setup_worktree"));
            assert!(update_description(tool).contains("user-only"));
        }
    }
}
