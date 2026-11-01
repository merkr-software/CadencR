//! Cursor's `mode` select (`agent`, `plan`, `ask`), mapped onto Cadencr's
//! permission modes through `_meta.cadencr.permissionMode`.
//!
//! The cold `models` catalog and every live `configOptions` snapshot present
//! the same values, names, descriptions and `_meta`, so the host's catalog
//! modes and the live option always agree. Value order is the host's cycle
//! order; `agent` comes first and is the primary edit mode.

use cadencr_provider_sdk::meta::{merge_meta, permission_mode_meta, PermissionMode};
use serde_json::{json, Value};

pub const MODE_CONFIG_ID: &str = "mode";

struct CursorMode {
    value: &'static str,
    permission_mode: PermissionMode,
    name: &'static str,
    description: &'static str,
}

const MODES: [CursorMode; 3] = [
    CursorMode {
        value: "agent",
        permission_mode: PermissionMode::Default,
        name: "Agent",
        description: "Cursor's default mode with full coding tools.",
    },
    CursorMode {
        value: "plan",
        permission_mode: PermissionMode::Plan,
        name: "Plan",
        description: "Read-only planning and design mode.",
    },
    CursorMode {
        value: "ask",
        permission_mode: PermissionMode::Ask,
        name: "Ask",
        description: "Read-only Q&A without edits or command execution.",
    },
];

fn known(value: &str) -> Option<&'static CursorMode> {
    MODES.iter().find(|mode| mode.value == value)
}

fn value_entry(mode: &CursorMode) -> Value {
    let mut entry = json!({
        "value": mode.value,
        "name": mode.name,
        "description": mode.description,
    });
    if let Some(object) = entry.as_object_mut() {
        merge_meta(object, permission_mode_meta(mode.permission_mode));
    }
    entry
}

/// The `mode` select of the cold `models` catalog (Cursor starts in `agent`).
pub fn catalog_option() -> Value {
    json!({
        "id": MODE_CONFIG_ID,
        "name": "Mode",
        "description": "Controls how the agent executes tasks",
        "category": "mode",
        "type": "select",
        "currentValue": MODES[0].value,
        "options": MODES.iter().map(value_entry).collect::<Vec<_>>(),
    })
}

/// Present Cursor's live `mode` option like the catalog: known values get the
/// catalog name, description and `_meta`; values Cadencr cannot map (a mode a
/// newer Cursor adds) pass through unmapped, which the host does not show.
pub fn decorate_live_option(option: &mut Value) {
    if option.get("id").and_then(Value::as_str) != Some(MODE_CONFIG_ID) {
        return;
    }
    let Some(values) = option.get_mut("options").and_then(Value::as_array_mut) else {
        return;
    };
    for entry in values {
        let Some(mode) = entry.get("value").and_then(Value::as_str).and_then(known) else {
            continue;
        };
        let Some(object) = entry.as_object_mut() else {
            continue;
        };
        object.insert("name".to_string(), json!(mode.name));
        object.insert("description".to_string(), json!(mode.description));
        merge_meta(object, permission_mode_meta(mode.permission_mode));
    }
}

#[cfg(test)]
mod tests {
    use super::{catalog_option, decorate_live_option};
    use agent_client_protocol::schema::v1::SessionConfigOption;
    use serde_json::json;

    #[test]
    fn catalog_maps_every_cursor_mode() {
        let option = catalog_option();
        let typed: SessionConfigOption = serde_json::from_value(option.clone()).unwrap();
        assert_eq!(typed.id.0.as_ref(), "mode");
        assert_eq!(option["category"], "mode");
        assert_eq!(option["currentValue"], "agent");
        let mapped: Vec<(&str, &str)> = option["options"]
            .as_array()
            .unwrap()
            .iter()
            .map(|entry| {
                (
                    entry["value"].as_str().unwrap(),
                    entry["_meta"]["cadencr"]["permissionMode"]
                        .as_str()
                        .unwrap(),
                )
            })
            .collect();
        assert_eq!(
            mapped,
            [("agent", "default"), ("plan", "plan"), ("ask", "ask")]
        );
    }

    #[test]
    fn live_option_matches_the_catalog_and_keeps_unknown_values() {
        let mut live = json!({
            "id": "mode", "name": "Mode", "category": "mode", "type": "select",
            "currentValue": "plan",
            "options": [
                { "value": "agent", "name": "Agent", "description": "Full agent capabilities" },
                { "value": "plan", "name": "Plan", "_meta": { "cursor": { "x": 1 } } },
                { "value": "ask", "name": "Ask" },
                { "value": "debug", "name": "Debug" }
            ]
        });
        decorate_live_option(&mut live);
        let catalog = catalog_option();
        for index in 0..3 {
            assert_eq!(
                live["options"][index]["_meta"]["cadencr"],
                catalog["options"][index]["_meta"]["cadencr"]
            );
            assert_eq!(
                live["options"][index]["description"],
                catalog["options"][index]["description"]
            );
        }
        assert_eq!(live["options"][1]["_meta"]["cursor"]["x"], 1);
        assert!(live["options"][3].get("_meta").is_none());
        assert_eq!(live["currentValue"], "plan");

        let mut other = json!({ "id": "access", "options": [{ "value": "agent" }] });
        decorate_live_option(&mut other);
        assert!(other["options"][0].get("_meta").is_none());
    }
}
