use serde_json::{json, Value};

use crate::domain::schedules::condition::{DEFAULT_TIMEOUT_SECONDS, MAX_TIMEOUT_SECONDS};
use crate::domain::schedules::recurrence::MIN_INTERVAL_SECONDS;

pub(super) fn description(name: &str) -> &'static str {
    match name {
        "project_create_schedule" => "Schedule a prompt to be sent back into this conversation later — once, every N seconds, or daily/weekly/monthly at a local time. Add a condition to only send it when a shell command fails (non-zero exit): the command runs in this conversation's working copy at every evaluation, and its output is appended to the prompt. While this conversation's agent is working or waiting on the user, evaluations are skipped. The user sees, edits, pauses, and deletes the schedule in CadencR's Schedules view; tell them what you scheduled. Change or remove it later with project_update_schedule / project_delete_schedule.",
        "project_list_schedules" => "List the schedules that deliver into this conversation — whether you or the user created them — with their id, rule, condition, paused/completed state, next run, and last run/check outcome. Use it to find the schedule_id for project_update_schedule or project_delete_schedule.",
        "project_update_schedule" => "Change a schedule that delivers into this conversation. Only the fields you pass change; everything else is kept. Pass enabled=false to pause it and enabled=true to resume it. The next run stays where it is unless you pass a new recurrence, which is planned from now; run history is kept. Tell the user what you changed.",
        "project_delete_schedule" => "Permanently delete a schedule that delivers into this conversation, e.g. once the condition it was watching is fixed for good or the user asks to stop it. Prefer project_update_schedule with enabled=false to pause instead. Tell the user what you deleted.",
        _ => "Manage schedules that deliver into this conversation.",
    }
}

pub(super) fn schema(name: &str) -> Value {
    match name {
        "project_create_schedule" => create_schema(),
        "project_update_schedule" => update_schema(),
        "project_delete_schedule" => json!({
            "type": "object",
            "properties": { "schedule_id": schedule_id_property() },
            "required": ["schedule_id"]
        }),
        _ => json!({ "type": "object", "properties": {} }),
    }
}

/// Flat on purpose, like `project_spawn_session`: a `oneOf` per recurrence
/// kind would be more precise, but MCP clients generate far worse arguments
/// for unions than for one object with documented, kind-specific fields. The
/// save path rejects fields that don't match the kind.
fn create_schema() -> Value {
    json!({
        "type": "object",
        "properties": {
            "prompt": { "type": "string", "description": "The message delivered to this conversation when the schedule fires. Write it as instructions to your future self: the conversation history is still there, but say what to check and do." },
            "name": { "type": "string", "description": "Short label shown in the Schedules list. Optional; defaults to the prompt's first line." },
            "recurrence": recurrence_schema(
                "When the schedule fires (or, with a condition, when the command is evaluated).",
                "the user's machine timezone",
            ),
            "condition": condition_schema("Optional gate: only deliver when this command exits non-zero. Omit to always deliver."),
            "model": { "type": "string", "description": "Optional model for the scheduled turn; defaults to the conversation's current model." },
            "thinking_level": { "type": "string", "description": "Optional thinking level for the scheduled turn." },
            "permission_mode": { "type": "string", "description": "Optional collaboration mode for the scheduled turn (e.g. default, plan)." }
        },
        "required": ["prompt", "recurrence"]
    })
}

/// Patch semantics: an absent field keeps its stored value. Clearing is spelled
/// explicitly (`remove_condition`, an empty pin) rather than with `null`,
/// which several MCP clients can't express in a typed schema.
fn update_schema() -> Value {
    json!({
        "type": "object",
        "properties": {
            "schedule_id": schedule_id_property(),
            "prompt": { "type": "string", "description": "New message delivered when the schedule fires." },
            "name": { "type": "string", "description": "New label for the Schedules list. Pass an empty string to fall back to the prompt's first line." },
            "recurrence": recurrence_schema(
                "Replacement rule, given whole (kind plus its fields); it is not merged with the current one. Omit to keep the current rule.",
                "the current rule's timezone",
            ),
            "condition": condition_schema("Replacement gate: only deliver when this command exits non-zero. Omit to keep the current one."),
            "remove_condition": { "type": "boolean", "description": "true removes the condition so the schedule always delivers. Cannot be combined with condition." },
            "enabled": { "type": "boolean", "description": "false pauses the schedule, true resumes it. Omit to leave its paused/active state alone." },
            "model": { "type": "string", "description": "Model for the scheduled turn. Pass an empty string to go back to the conversation's current model." },
            "thinking_level": { "type": "string", "description": "Thinking level for the scheduled turn. Pass an empty string to clear it." },
            "permission_mode": { "type": "string", "description": "Collaboration mode for the scheduled turn (e.g. default, plan). Pass an empty string to clear it." }
        },
        "required": ["schedule_id"]
    })
}

fn schedule_id_property() -> Value {
    json!({ "type": "number", "description": "Id of a schedule that delivers into this conversation, from project_create_schedule or project_list_schedules." })
}

/// `timezone_default` says what an omitted `timezone` falls back to.
fn recurrence_schema(description: &str, timezone_default: &str) -> Value {
    json!({
        "type": "object",
        "description": description,
        "properties": {
            "kind": { "type": "string", "enum": ["once", "interval", "daily", "weekly", "monthly"], "description": "once needs run_at; interval needs interval_seconds; daily needs time_of_day; weekly needs time_of_day and weekdays; monthly needs time_of_day and day_of_month." },
            "run_at": { "type": "string", "description": "once only: future ISO-8601 instant with offset, e.g. 2026-10-17T09:00:00+02:00." },
            "interval_seconds": { "type": "number", "description": format!("interval only: seconds between runs, at least {MIN_INTERVAL_SECONDS}.") },
            "time_of_day": { "type": "string", "description": "daily/weekly/monthly: local wall-clock time as HH:MM (24h)." },
            "weekdays": { "type": "array", "items": { "type": "number" }, "description": "weekly only: ISO weekdays, 1 = Monday .. 7 = Sunday." },
            "day_of_month": { "type": "number", "description": "monthly only: 1-31, clamped to shorter months' last day." },
            "timezone": { "type": "string", "description": format!("IANA zone time_of_day is read in. Omit to use {timezone_default}.") }
        },
        "required": ["kind"]
    })
}

fn condition_schema(description: &str) -> Value {
    json!({
        "type": "object",
        "description": description,
        "properties": {
            "command": { "type": "string", "description": "Shell command run through the user's login shell in this conversation's working directory, e.g. `pnpm test` or `curl -fsS http://localhost:3000/health`. Must be non-interactive." },
            "timeout_seconds": { "type": "number", "description": format!("Seconds before the evaluation is abandoned and reported as an error (1-{MAX_TIMEOUT_SECONDS}, default {DEFAULT_TIMEOUT_SECONDS}).") }
        },
        "required": ["command"]
    })
}
