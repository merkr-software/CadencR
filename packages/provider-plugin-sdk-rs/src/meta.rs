//! `_meta.cadencr` conventions a connector attaches to standard ACP objects.
//!
//! - A `category: "mode"` select value carrying [`permission_mode_meta`] becomes
//!   one of the host's permission modes (value order = cycle order; the first
//!   mapped value is the primary edit mode).
//! - A select option carrying [`access_mode_role_meta`] is the provider's access
//!   control; its values map through [`access_mode_meta`].
//! - A sub-agent `tool_call` / `tool_call_update` carries [`subagent_background_meta`]
//!   when it keeps running after its launching call returns, and a later update
//!   of the same `toolCallId` carries [`subagent_status_meta`] when it ends.
//! - An `available_commands_update` entry carries [`slash_command_kind_meta`]
//!   when it is a skill, so the live list groups like `slash-commands` output.
//!
//! Each helper returns an ACP [`Meta`] object (`{"cadencr": {…}}`) usable as the
//! `meta` of typed ACP structs, or merged into raw JSON with [`merge_meta`].

use agent_client_protocol::schema::v1::Meta;
use serde_json::{json, Map, Value};

use crate::SlashCommandKind;

pub const CADENCR_META_KEY: &str = "cadencr";
/// Option-level `_meta.cadencr.role` of the access-mode select.
pub const ACCESS_MODE_ROLE: &str = "access_mode";

/// Host permission-mode wire ids.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PermissionMode {
    Default,
    AcceptEdits,
    Plan,
    Ask,
    Auto,
    BypassPermissions,
    DontAsk,
}

impl PermissionMode {
    pub fn wire_id(self) -> &'static str {
        match self {
            Self::Default => "default",
            Self::AcceptEdits => "acceptEdits",
            Self::Plan => "plan",
            Self::Ask => "ask",
            Self::Auto => "auto",
            Self::BypassPermissions => "bypassPermissions",
            Self::DontAsk => "dontAsk",
        }
    }
}

/// Theme colors supported by the host's permission-mode controls.
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "lowercase")]
pub enum ModeAccent {
    Blue,
    Green,
    Yellow,
    Violet,
}

/// Host access-mode wire ids.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AccessMode {
    Default,
    FullAccess,
    AutoReview,
}

impl AccessMode {
    pub fn wire_id(self) -> &'static str {
        match self {
            Self::Default => "default",
            Self::FullAccess => "fullAccess",
            Self::AutoReview => "autoReview",
        }
    }
}

/// Terminal state of a background sub-agent.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SubagentStatus {
    Completed,
    Failed,
    Cancelled,
}

impl SubagentStatus {
    pub fn wire_id(self) -> &'static str {
        match self {
            Self::Completed => "completed",
            Self::Failed => "failed",
            Self::Cancelled => "cancelled",
        }
    }
}

fn cadencr(fields: Value) -> Meta {
    let mut meta = Map::new();
    meta.insert(CADENCR_META_KEY.to_string(), fields);
    meta
}

/// `{"cadencr": {"permissionMode": <wire id>}}` for a mode select value.
pub fn permission_mode_meta(mode: PermissionMode) -> Meta {
    cadencr(json!({ "permissionMode": mode.wire_id() }))
}

/// A permission mode with a host theme accent.
pub fn permission_mode_meta_with_accent(mode: PermissionMode, accent: ModeAccent) -> Meta {
    let mut meta = permission_mode_meta(mode);
    meta[CADENCR_META_KEY]["modeAccent"] = json!(accent);
    meta
}

/// `{"cadencr": {"accessMode": <wire id>}}` for an access select value.
pub fn access_mode_meta(mode: AccessMode) -> Meta {
    cadencr(json!({ "accessMode": mode.wire_id() }))
}

/// `{"cadencr": {"role": "access_mode"}}` for the access select option itself.
pub fn access_mode_role_meta() -> Meta {
    cadencr(json!({ "role": ACCESS_MODE_ROLE }))
}

/// Keep a session working after a real turn result, or release that hold.
pub fn background_work_meta(pending: bool) -> Meta {
    cadencr(json!({ "backgroundWorkPending": pending }))
}

/// `{"cadencr": {"subagent": {"background": true}}}` for the launching call.
pub fn subagent_background_meta() -> Meta {
    cadencr(json!({ "subagent": { "background": true } }))
}

/// `{"cadencr": {"subagent": {"status", "summary"?}}}` ending a background run.
pub fn subagent_status_meta(status: SubagentStatus, summary: Option<&str>) -> Meta {
    subagent_update_meta()
        .status(status)
        .maybe_summary(summary)
        .call()
}

/// A detached carrier's progress or terminal signal. Counts are cumulative for
/// this child. Report the model observed on the child when it is available.
#[bon::builder]
pub fn subagent_update_meta(
    status: Option<SubagentStatus>,
    summary: Option<&str>,
    resolved_model: Option<&str>,
    total_tokens: Option<u64>,
) -> Meta {
    let mut subagent = json!({});
    if let Some(status) = status {
        subagent["status"] = json!(status.wire_id());
    }
    if let Some(model) = resolved_model {
        subagent["resolvedModel"] = json!(model);
    }
    if let Some(tokens) = total_tokens {
        subagent["totalTokens"] = json!(tokens);
    }
    if let Some(summary) = summary {
        subagent["summary"] = json!(summary);
    }
    cadencr(json!({ "subagent": subagent }))
}

/// `{"cadencr": {"kind": "skill" | "command"}}` for an ACP `AvailableCommand`.
pub fn slash_command_kind_meta(kind: SlashCommandKind) -> Meta {
    cadencr(json!({ "kind": kind.wire_id() }))
}

/// Merge `meta` into `object["_meta"]`, keeping keys already there. Top-level
/// namespaces (`cadencr`, the agent's own) merge one level deep, so existing
/// `_meta.cadencr.*` keys survive unless `meta` sets the same key.
pub fn merge_meta(object: &mut Map<String, Value>, meta: Meta) {
    let target = object
        .entry("_meta")
        .or_insert_with(|| Value::Object(Map::new()));
    if !target.is_object() {
        *target = Value::Object(Map::new());
    }
    let Some(target) = target.as_object_mut() else {
        return;
    };
    for (namespace, fields) in meta {
        match (target.get_mut(&namespace), fields) {
            (Some(Value::Object(existing)), Value::Object(fields)) => existing.extend(fields),
            (_, fields) => {
                target.insert(namespace, fields);
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::{
        access_mode_meta, access_mode_role_meta, merge_meta, permission_mode_meta,
        slash_command_kind_meta, subagent_background_meta, subagent_status_meta, AccessMode,
        PermissionMode, SubagentStatus,
    };
    use agent_client_protocol::schema::v1::SessionConfigSelectOption;
    use serde_json::{json, Value};

    #[test]
    fn builds_the_wire_shapes() {
        assert_eq!(
            Value::Object(permission_mode_meta(PermissionMode::AcceptEdits)),
            json!({ "cadencr": { "permissionMode": "acceptEdits" } })
        );
        assert_eq!(
            Value::Object(access_mode_meta(AccessMode::FullAccess)),
            json!({ "cadencr": { "accessMode": "fullAccess" } })
        );
        assert_eq!(
            Value::Object(access_mode_role_meta()),
            json!({ "cadencr": { "role": "access_mode" } })
        );
        assert_eq!(
            Value::Object(subagent_background_meta()),
            json!({ "cadencr": { "subagent": { "background": true } } })
        );
        assert_eq!(
            Value::Object(subagent_status_meta(SubagentStatus::Failed, Some("limit"))),
            json!({ "cadencr": { "subagent": { "status": "failed", "summary": "limit" } } })
        );
        assert_eq!(
            Value::Object(slash_command_kind_meta(crate::SlashCommandKind::Skill)),
            json!({ "cadencr": { "kind": "skill" } })
        );
        assert_eq!(
            Value::Object(
                super::subagent_update_meta()
                    .resolved_model("native")
                    .total_tokens(0)
                    .call()
            ),
            json!({ "cadencr": { "subagent": { "resolvedModel": "native", "totalTokens": 0 } } })
        );
        let typed = SessionConfigSelectOption::new("plan", "Plan")
            .meta(permission_mode_meta(PermissionMode::Plan));
        assert_eq!(
            serde_json::to_value(typed).unwrap()["_meta"]["cadencr"]["permissionMode"],
            "plan"
        );
    }

    #[test]
    fn merge_keeps_existing_namespaces_and_keys() {
        let mut object = json!({ "_meta": { "cursor": { "x": 1 }, "cadencr": { "keep": true } } })
            .as_object()
            .unwrap()
            .clone();
        merge_meta(&mut object, subagent_background_meta());
        assert_eq!(
            object["_meta"],
            json!({
                "cursor": { "x": 1 },
                "cadencr": { "keep": true, "subagent": { "background": true } }
            })
        );
        let mut bare = serde_json::Map::new();
        merge_meta(&mut bare, access_mode_role_meta());
        assert_eq!(bare["_meta"]["cadencr"]["role"], "access_mode");
    }
}
