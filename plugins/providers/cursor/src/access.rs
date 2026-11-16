//! Connector-owned access mode: a synthetic `access` select config option.
//!
//! Cursor ACP exposes approval/sandbox behavior only as launch flags, not as
//! session config options. The connector therefore advertises its own select
//! option and maps it onto `agent` flags; a change that flips the sandbox flag
//! restarts the child and restores the session through `session/load`.
//!
//! The option carries `_meta.cadencr.role = "access_mode"` and each value its
//! host access mode (`_meta.cadencr.accessMode`), in the cold `models` catalog
//! and in every live snapshot alike, so Cadencr drives it as its access chip.

use std::ffi::OsString;

use cadencr_provider_sdk::meta::{
    access_mode_meta, access_mode_role_meta, merge_meta, AccessMode as HostAccessMode,
};
use serde_json::{json, Value};

pub const ACCESS_CONFIG_ID: &str = "access";

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub enum AccessMode {
    #[default]
    Default,
    FullAccess,
    AutoReview,
}

const ALL: [AccessMode; 3] = [
    AccessMode::Default,
    AccessMode::FullAccess,
    AccessMode::AutoReview,
];

impl AccessMode {
    pub fn from_value(value: &str) -> Option<Self> {
        ALL.into_iter().find(|mode| mode.value() == value)
    }

    pub fn value(self) -> &'static str {
        match self {
            Self::Default => "default",
            Self::FullAccess => "full_access",
            Self::AutoReview => "auto_review",
        }
    }

    fn host_mode(self) -> HostAccessMode {
        match self {
            Self::Default => HostAccessMode::Default,
            Self::FullAccess => HostAccessMode::FullAccess,
            Self::AutoReview => HostAccessMode::AutoReview,
        }
    }

    pub fn label(self) -> &'static str {
        match self {
            Self::Default => "Default",
            Self::FullAccess => "Full Access",
            Self::AutoReview => "Auto Review",
        }
    }

    fn description(self) -> &'static str {
        match self {
            Self::Default => "Enables Cursor's sandbox and uses its configured approval rules. Explicitly allowed calls run and unmatched calls ask for approval.",
            Self::FullAccess => "Starts Cursor with Run Everything enabled and disables the sandbox. Commands run without approval unless an explicit deny rule blocks them.",
            Self::AutoReview => "Sandbox stays enabled. Ordinary shell allowlist misses are preflight-approved; MCP calls and explicit safety-policy requests still ask for approval.",
        }
    }

    /// `agent` arguments for this mode, ending with the `acp` subcommand.
    /// Keep in lockstep with [`Self::launches_sandboxless`].
    pub fn launch_args(self) -> Vec<OsString> {
        let args: &[&str] = match self {
            Self::FullAccess => &["--force", "--sandbox", "disabled", "acp"],
            Self::AutoReview => &["--auto-review", "--sandbox", "enabled", "acp"],
            Self::Default => &["--sandbox", "enabled", "acp"],
        };
        args.iter().map(OsString::from).collect()
    }

    fn launches_sandboxless(self) -> bool {
        match self {
            Self::FullAccess => true,
            Self::Default | Self::AutoReview => false,
        }
    }

    /// Default <-> Auto Review keep the sandbox launch flag; the Auto Review
    /// preflight runs inside the connector, so those switch in place. Only a
    /// change into or out of Full access needs a new `agent` process.
    pub fn change_needs_restart(self, to: Self) -> bool {
        self.launches_sandboxless() != to.launches_sandboxless()
    }

    pub fn config_option(self) -> Value {
        let options: Vec<Value> = ALL
            .into_iter()
            .map(|mode| {
                let mut entry = json!({
                    "value": mode.value(),
                    "name": mode.label(),
                    "description": mode.description(),
                });
                if let Some(object) = entry.as_object_mut() {
                    merge_meta(object, access_mode_meta(mode.host_mode()));
                }
                entry
            })
            .collect();
        let mut option = json!({
            "id": ACCESS_CONFIG_ID,
            "name": "Access",
            "description": "How much Cursor may do without asking. Switching into or out of Full Access restarts Cursor and reloads the conversation.",
            "type": "select",
            "currentValue": self.value(),
            "options": options,
        });
        if let Some(object) = option.as_object_mut() {
            merge_meta(object, access_mode_role_meta());
        }
        option
    }
}

#[cfg(test)]
mod tests {
    use super::AccessMode;
    use agent_client_protocol::schema::v1::SessionConfigOption;
    use std::ffi::OsString;

    fn args(values: &[&str]) -> Vec<OsString> {
        values.iter().map(OsString::from).collect()
    }

    #[test]
    fn maps_access_modes_to_cursor_cli_flags() {
        assert_eq!(
            AccessMode::Default.launch_args(),
            args(&["--sandbox", "enabled", "acp"])
        );
        assert_eq!(
            AccessMode::FullAccess.launch_args(),
            args(&["--force", "--sandbox", "disabled", "acp"])
        );
        assert_eq!(
            AccessMode::AutoReview.launch_args(),
            args(&["--auto-review", "--sandbox", "enabled", "acp"])
        );
    }

    #[test]
    fn only_sandbox_flips_need_a_restart() {
        use AccessMode::{AutoReview, Default, FullAccess};
        assert!(!Default.change_needs_restart(AutoReview));
        assert!(!AutoReview.change_needs_restart(Default));
        assert!(AutoReview.change_needs_restart(FullAccess));
        assert!(FullAccess.change_needs_restart(Default));
        assert!(!FullAccess.change_needs_restart(FullAccess));
    }

    #[test]
    fn synthetic_option_is_a_valid_acp_select() {
        let option: SessionConfigOption =
            serde_json::from_value(AccessMode::AutoReview.config_option()).unwrap();
        assert_eq!(option.id.0.as_ref(), "access");
        let value = AccessMode::AutoReview.config_option();
        assert_eq!(value["currentValue"], "auto_review");
        assert_eq!(value["options"][1]["name"], "Full Access");
        assert_eq!(value["_meta"]["cadencr"]["role"], "access_mode");
        let host_ids: Vec<&str> = value["options"]
            .as_array()
            .unwrap()
            .iter()
            .map(|entry| entry["_meta"]["cadencr"]["accessMode"].as_str().unwrap())
            .collect();
        assert_eq!(host_ids, ["default", "fullAccess", "autoReview"]);
        assert_eq!(
            AccessMode::from_value("full_access"),
            Some(AccessMode::FullAccess)
        );
        assert_eq!(AccessMode::from_value("fullAccess"), None);
    }
}
