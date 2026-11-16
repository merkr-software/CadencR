//! Mode and access-mode selectors in the `models` output.
//!
//! Besides the mandatory model selector, a provider's `models` output may
//! carry two optional select options whose values map onto host modes:
//!
//! - the option with ACP `category: "mode"`; each value may carry
//!   `_meta.cadencr.permissionMode` (a host permission-mode wire id);
//! - the option whose option-level `_meta.cadencr.role` is `"access_mode"`;
//!   each value may carry `_meta.cadencr.accessMode` (a host access-mode id).
//!
//! Values without a recognized mapping are not shown by the host, so a newer
//! connector can map a host id this build does not know without breaking the
//! catalog. Value order is cycle order; the first mapped mode is the
//! provider's primary edit mode. See `docs/PROVIDER_SPEC/PROVIDER_PACKAGE.md`.

use agent_client_protocol::schema::v1::{
    SessionConfigKind, SessionConfigOption, SessionConfigOptionCategory, SessionConfigSelectOption,
};
use serde_json::Value;

use super::{flatten_options, ModelDiscoveryError};
use crate::domain::agents::adapter::{
    access_mode_wire, parse_access_mode_wire, RuntimeAccessMode, RuntimePermissionMode,
};
use crate::domain::agents::permission_modes::{parse_permission_mode, permission_mode_wire};
use crate::domain::agents::runtime::ProviderModeCatalogEntry;

/// Host permission-mode wire ids a connector may map a mode value onto.
pub const HOST_PERMISSION_MODES: &[&str] = &[
    "default",
    "acceptEdits",
    "plan",
    "ask",
    "auto",
    "bypassPermissions",
    "dontAsk",
];

/// The option-level `_meta.cadencr.role` that marks the access-mode selector.
pub const ACCESS_MODE_ROLE: &str = "access_mode";

/// One provider value mapped onto a host mode id.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MappedMode {
    /// Host wire id (`plan`, `fullAccess`, ...).
    pub host_id: String,
    /// The provider's own select value.
    pub value: String,
    pub label: String,
    pub description: Option<String>,
}

impl MappedMode {
    fn catalog_entry(&self) -> ProviderModeCatalogEntry {
        ProviderModeCatalogEntry {
            id: self.host_id.clone(),
            label: self.label.clone(),
            description: self.description.clone(),
        }
    }
}

/// Every host mode a provider's `models` output maps, in cycle order.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct ProviderModeMap {
    pub mode_config_id: Option<String>,
    pub modes: Vec<MappedMode>,
    pub access_config_id: Option<String>,
    pub access_modes: Vec<MappedMode>,
}

impl ProviderModeMap {
    pub fn parse(options: &[SessionConfigOption]) -> Result<Self, ModelDiscoveryError> {
        let mode_option = options
            .iter()
            .find(|option| matches!(option.category, Some(SessionConfigOptionCategory::Mode)));
        let access_option = options
            .iter()
            .find(|option| option_role(option) == Some(ACCESS_MODE_ROLE));
        let (mode_config_id, modes) = match mode_option {
            Some(option) => mapped(option, "permissionMode", is_host_permission_mode)?,
            None => (None, Vec::new()),
        };
        let (access_config_id, access_modes) = match access_option {
            Some(option) => mapped(option, "accessMode", |id| {
                parse_access_mode_wire(id).is_some()
            })?,
            None => (None, Vec::new()),
        };
        Ok(Self {
            mode_config_id,
            modes,
            access_config_id,
            access_modes,
        })
    }

    pub fn mode_for(&self, mode: &RuntimePermissionMode) -> Option<&MappedMode> {
        let wire = permission_mode_wire(mode);
        self.modes.iter().find(|entry| entry.host_id == wire)
    }

    pub fn permission_mode_for_value(&self, value: &str) -> Option<RuntimePermissionMode> {
        self.modes
            .iter()
            .find(|entry| entry.value == value)
            .map(|entry| parse_permission_mode(&entry.host_id))
    }

    pub fn access_mode_for(&self, mode: &RuntimeAccessMode) -> Option<&MappedMode> {
        let wire = access_mode_wire(mode);
        self.access_modes.iter().find(|entry| entry.host_id == wire)
    }

    /// The provider's primary edit mode: its first mapped mode.
    pub fn primary_mode(&self) -> Option<&MappedMode> {
        self.modes.first()
    }

    pub fn mode_catalog(&self) -> Vec<ProviderModeCatalogEntry> {
        self.modes.iter().map(MappedMode::catalog_entry).collect()
    }

    pub fn access_mode_catalog(&self) -> Vec<ProviderModeCatalogEntry> {
        self.access_modes
            .iter()
            .map(MappedMode::catalog_entry)
            .collect()
    }
}

fn is_host_permission_mode(id: &str) -> bool {
    HOST_PERMISSION_MODES.contains(&id)
}

/// `_meta.cadencr.role` on a config option.
pub fn option_role(option: &SessionConfigOption) -> Option<&str> {
    option
        .meta
        .as_ref()
        .and_then(|meta| meta.get("cadencr"))
        .and_then(|cadencr| cadencr.get("role"))
        .and_then(Value::as_str)
}

fn mapped(
    option: &SessionConfigOption,
    key: &str,
    known: impl Fn(&str) -> bool,
) -> Result<(Option<String>, Vec<MappedMode>), ModelDiscoveryError> {
    let SessionConfigKind::Select(select) = &option.kind else {
        return Err(ModelDiscoveryError::new(format!(
            "provider option `{}` maps host modes but is not a select option",
            option.id.0
        )));
    };
    let mut modes: Vec<MappedMode> = Vec::new();
    for choice in flatten_options(&select.options)? {
        let Some(host_id) = value_mapping(choice, key) else {
            continue;
        };
        if !known(host_id) {
            tracing::debug!(
                host_id,
                "ignoring provider mode mapped onto an unknown host id"
            );
            continue;
        }
        if modes.iter().any(|entry| entry.host_id == host_id) {
            continue;
        }
        modes.push(MappedMode {
            host_id: host_id.to_string(),
            value: choice.value.0.to_string(),
            label: choice.name.clone(),
            description: choice.description.clone(),
        });
    }
    let config_id = (!modes.is_empty()).then(|| option.id.0.to_string());
    Ok((config_id, modes))
}

fn value_mapping<'a>(choice: &'a SessionConfigSelectOption, key: &str) -> Option<&'a str> {
    choice.meta.as_ref()?.get("cadencr")?.get(key)?.as_str()
}

#[cfg(test)]
mod tests {
    use super::ProviderModeMap;
    use crate::domain::agents::adapter::{RuntimeAccessMode, RuntimePermissionMode};
    use agent_client_protocol::schema::v1::SessionConfigOption;
    use serde_json::json;

    fn options(value: serde_json::Value) -> Vec<SessionConfigOption> {
        serde_json::from_value(value).unwrap()
    }

    fn mode_value(value: &str, host: Option<&str>) -> serde_json::Value {
        match host {
            Some(host) => json!({ "value": value, "name": value.to_uppercase(),
                "_meta": { "cadencr": { "permissionMode": host } } }),
            None => json!({ "value": value, "name": value.to_uppercase() }),
        }
    }

    #[test]
    fn maps_mode_and_access_selectors_in_order() {
        let parsed = ProviderModeMap::parse(&options(json!([
            { "id": "model", "name": "Model", "category": "model", "type": "select",
              "currentValue": "m", "options": [{ "value": "m", "name": "M" }] },
            { "id": "mode", "name": "Mode", "category": "mode", "type": "select",
              "currentValue": "agent", "options": [
                mode_value("agent", Some("default")),
                mode_value("hidden", None),
                mode_value("future", Some("someFutureMode")),
                mode_value("plan", Some("plan")),
                mode_value("again", Some("plan")),
                mode_value("ask", Some("ask")),
            ] },
            { "id": "sandbox", "name": "Sandbox", "type": "select", "currentValue": "on",
              "_meta": { "cadencr": { "role": "access_mode" } },
              "options": [
                { "value": "on", "name": "Sandboxed", "description": "Asks first",
                  "_meta": { "cadencr": { "accessMode": "default" } } },
                { "value": "off", "name": "Full", "_meta": { "cadencr": { "accessMode": "fullAccess" } } },
                { "value": "odd", "name": "Odd", "_meta": { "cadencr": { "accessMode": "nope" } } }
            ] }
        ])))
        .unwrap();
        assert_eq!(parsed.mode_config_id.as_deref(), Some("mode"));
        let ids: Vec<_> = parsed.modes.iter().map(|m| m.host_id.as_str()).collect();
        assert_eq!(ids, ["default", "plan", "ask"]);
        assert_eq!(parsed.primary_mode().unwrap().value, "agent");
        assert_eq!(
            parsed.mode_for(&RuntimePermissionMode::Plan).unwrap().value,
            "plan"
        );
        assert!(parsed.mode_for(&RuntimePermissionMode::Auto).is_none());
        assert_eq!(
            parsed.permission_mode_for_value("ask"),
            Some(RuntimePermissionMode::Ask)
        );
        assert_eq!(parsed.access_config_id.as_deref(), Some("sandbox"));
        assert_eq!(
            parsed
                .access_mode_for(&RuntimeAccessMode::FullAccess)
                .unwrap()
                .value,
            "off"
        );
        assert!(parsed
            .access_mode_for(&RuntimeAccessMode::AutoReview)
            .is_none());
        let catalog = parsed.access_mode_catalog();
        assert_eq!(catalog[0].label, "Sandboxed");
        assert_eq!(catalog[0].description.as_deref(), Some("Asks first"));
        assert_eq!(parsed.mode_catalog()[1].label, "PLAN");
    }

    #[test]
    fn outputs_without_mapped_modes_map_nothing() {
        let parsed = ProviderModeMap::parse(&options(json!([
            { "id": "mode", "name": "Mode", "category": "mode", "type": "select",
              "currentValue": "a", "options": [mode_value("a", None)] }
        ])))
        .unwrap();
        assert_eq!(parsed, ProviderModeMap::default());
    }

    #[test]
    fn a_mapped_boolean_option_is_rejected() {
        let error = ProviderModeMap::parse(&options(json!([
            { "id": "sandbox", "name": "Sandbox", "type": "boolean", "currentValue": true,
              "_meta": { "cadencr": { "role": "access_mode" } } }
        ])))
        .unwrap_err();
        assert!(error.to_string().contains("not a select"), "{error}");
    }
}
