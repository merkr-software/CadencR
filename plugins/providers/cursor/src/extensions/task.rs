//! Sub-agent facts for Cursor's task tool (`taskToolCall`, mapped to `Agent`).
//!
//! cursor-agent 2026.10.22 reports a finished task as a `completed`
//! `tool_call_update` whatever happened, with `rawOutput`
//! `{durationMs, isBackground}` on success or `{error}` on failure, then sends
//! a `cursor/task` notification `{toolCallId, description, prompt,
//! subagentType, model, agentId, durationMs}` where `subagentType` is a known
//! type string, `"unspecified"`, or `{custom: name}`. Cadencr's generic ACP
//! sub-agent carrier reads `Agent` tool calls: launch facts from `rawInput`,
//! the terminal state from the ACP status.
//!
//! Background launches: `rawInput` of the launching call carries no
//! background flag; Cursor only reveals it as `rawOutput.isBackground: true`
//! on that call's `completed` update, which then gets
//! `_meta.cadencr.subagent = {background: true}` so Cadencr keeps the
//! sub-agent running past the call and the turn. Its end arrives as Cursor's
//! `subagent_state_update`, translated in `subagents.rs`.

use cadencr_provider_sdk::meta::{merge_meta, subagent_background_meta};
use serde_json::{json, Map, Value};

/// `rawInput` for the `Agent` carrier, in the keys Cadencr's tracker reads.
pub fn task_input(params: &Value) -> Value {
    let mut input = Map::new();
    for key in ["description", "prompt", "model", "agentId", "durationMs"] {
        if let Some(value) = params.get(key).filter(|value| !value.is_null()) {
            input.insert(key.to_string(), value.clone());
        }
    }
    if let Some(kind) = subagent_type(params.get("subagentType")) {
        input.insert("subagentType".to_string(), json!(kind));
    }
    Value::Object(input)
}

/// `"explore"`, `{custom: "reviewer"}` → the agent's name; `"unspecified"`
/// names none.
pub fn subagent_type(value: Option<&Value>) -> Option<String> {
    let value = value?;
    let name = value
        .as_str()
        .or_else(|| value.get("custom").and_then(Value::as_str))?
        .trim();
    (!name.is_empty() && name != "unspecified").then(|| name.to_string())
}

/// Repair the terminal update of an `Agent` call: Cursor reports failures as
/// `completed` with `rawOutput.error`, which the generic carrier only treats
/// as a failure under ACP status `failed`. A background launch is marked with
/// `_meta.cadencr.subagent.background` (and keeps `rawInput.isBackground`).
pub fn repair_agent_completion(update: &mut Map<String, Value>) {
    if update.get("status").and_then(Value::as_str) != Some("completed") {
        return;
    }
    let raw_output = update.get("rawOutput").cloned().unwrap_or(Value::Null);
    if raw_output
        .get("error")
        .is_some_and(|error| !error.is_null())
    {
        update.insert("status".to_string(), json!("failed"));
        return;
    }
    if raw_output.get("isBackground").and_then(Value::as_bool) == Some(true) {
        let input = update
            .entry("rawInput")
            .or_insert_with(|| Value::Object(Map::new()));
        if let Some(input) = input.as_object_mut() {
            input.insert("isBackground".to_string(), json!(true));
        }
        merge_meta(update, subagent_background_meta());
    }
}

#[cfg(test)]
mod tests {
    use super::{repair_agent_completion, subagent_type, task_input};
    use serde_json::{json, Map, Value};

    fn update(value: Value) -> Map<String, Value> {
        value.as_object().unwrap().clone()
    }

    #[test]
    fn task_notification_describes_the_run() {
        let input = task_input(&json!({
            "toolCallId": "tool-task-1",
            "description": "Explore auth",
            "prompt": "Map the auth flow",
            "subagentType": { "custom": "reviewer" },
            "model": "composer-2.5",
            "agentId": "agent-7f3",
            "durationMs": 1200
        }));
        assert_eq!(input["subagentType"], "reviewer");
        assert_eq!(input["model"], "composer-2.5");
        assert_eq!(input["agentId"], "agent-7f3");
        assert_eq!(input["durationMs"], 1200);
        assert!(task_input(&json!({ "subagentType": "unspecified" }))
            .get("subagentType")
            .is_none());
    }

    #[test]
    fn subagent_type_names_known_custom_and_unspecified() {
        assert_eq!(
            subagent_type(Some(&json!("explore"))).as_deref(),
            Some("explore")
        );
        assert_eq!(
            subagent_type(Some(&json!({ "custom": "qa" }))).as_deref(),
            Some("qa")
        );
        assert_eq!(subagent_type(Some(&json!("unspecified"))), None);
        assert_eq!(subagent_type(None), None);
    }

    #[test]
    fn error_output_fails_despite_the_completed_status() {
        let mut failed = update(json!({
            "status": "completed",
            "rawOutput": { "error": "Subagent hit the usage limit" }
        }));
        repair_agent_completion(&mut failed);
        assert_eq!(failed["status"], "failed");

        let mut done = update(json!({ "status": "completed", "rawOutput": { "durationMs": 42 } }));
        repair_agent_completion(&mut done);
        assert_eq!(done["status"], "completed");
        assert!(done.get("rawInput").is_none());

        let mut background = update(json!({
            "status": "completed",
            "rawOutput": { "isBackground": true }
        }));
        repair_agent_completion(&mut background);
        assert_eq!(background["rawInput"]["isBackground"], true);
        assert_eq!(
            background["_meta"]["cadencr"]["subagent"],
            json!({ "background": true })
        );
        assert!(done.get("_meta").is_none());

        let mut running = update(json!({ "status": "in_progress", "rawOutput": { "error": "x" } }));
        repair_agent_completion(&mut running);
        assert_eq!(running["status"], "in_progress");
    }
}
