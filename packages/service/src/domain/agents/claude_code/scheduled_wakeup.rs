//! Detecting Claude Code's `ScheduleWakeup` tool call.
//!
//! The agent can end its turn after asking the CLI to re-invoke it later (a
//! safety net while it waits on long work, or a self-paced loop). That timer
//! lives in the CLI process: closing the runtime before it fires drops the
//! wake-up and the agent never resumes. The wire carries no dedicated signal,
//! only the tool call itself, so the delay is read from its input. Conforms to
//! `.claude/rules/inline-rust-tests.md`.

use std::time::Duration;

use serde_json::Value;

use crate::domain::agents::adapter::{RuntimeContentBlock, RuntimeEvent, ScheduledWakeup};

const TOOL_NAME: &str = "ScheduleWakeup";
/// The CLI clamps the requested delay to this range.
const MIN_DELAY_SECS: u64 = 60;
const MAX_DELAY_SECS: u64 = 3600;
/// The CLI fires on the next whole minute after the delay (1500 s requested at
/// 10:05:17 fired at 10:31:00), so allow up to a minute past it.
const MINUTE_ALIGNMENT: Duration = Duration::from_secs(60);

/// The wake-up a top-level `ScheduleWakeup` call asks for, if this event is
/// one. Sub-agents can't schedule a wake-up of the main agent.
pub(super) fn scheduled_wakeup(event: &RuntimeEvent) -> Option<ScheduledWakeup> {
    if event.parent_tool_use_id().is_some() {
        return None;
    }
    event
        .assistant_message()?
        .content
        .iter()
        .rev()
        .find_map(|block| match block {
            RuntimeContentBlock::ToolUse { id, name, input } if name == TOOL_NAME => {
                Some(wakeup_from_input(id, input))
            }
            _ => None,
        })
}

fn wakeup_from_input(tool_use_id: &str, input: &Value) -> ScheduledWakeup {
    if input.get("stop").and_then(Value::as_bool) == Some(true) {
        return ScheduledWakeup::Cancelled;
    }
    // A missing or unreadable delay is held for the longest the CLI allows:
    // keeping an idle runtime a little longer is harmless, losing the
    // wake-up is not.
    let delay = input
        .get("delaySeconds")
        .and_then(Value::as_f64)
        .map_or(MAX_DELAY_SECS, |secs| secs.max(0.0).ceil() as u64)
        .clamp(MIN_DELAY_SECS, MAX_DELAY_SECS);
    ScheduledWakeup::Scheduled {
        tool_use_id: tool_use_id.to_string(),
        due_in: Duration::from_secs(delay) + MINUTE_ALIGNMENT,
    }
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;
    use crate::domain::agents::adapter::{
        RuntimeAssistantMessage, RuntimeEventKind, RuntimeEventMetadata,
    };

    fn assistant(content: Vec<RuntimeContentBlock>, parent: Option<&str>) -> RuntimeEvent {
        RuntimeEvent::new(
            RuntimeEventMetadata::default(),
            RuntimeEventKind::AssistantMessage {
                message: RuntimeAssistantMessage {
                    model: None,
                    content,
                },
                parent_tool_use_id: parent.map(ToOwned::to_owned),
            },
        )
    }

    fn tool_use(name: &str, input: Value) -> RuntimeContentBlock {
        RuntimeContentBlock::ToolUse {
            id: "toolu_wake".into(),
            name: name.into(),
            input,
        }
    }

    fn due_in(secs: u64) -> ScheduledWakeup {
        ScheduledWakeup::Scheduled {
            tool_use_id: "toolu_wake".into(),
            due_in: Duration::from_secs(secs),
        }
    }

    #[test]
    fn schedule_wakeup_holds_its_delay_plus_minute_alignment() {
        // Real input shape from the production session that lost its wake-up.
        let event = assistant(
            vec![tool_use(
                TOOL_NAME,
                json!({ "delaySeconds": 1500, "noop": false, "prompt": "p", "reason": "r" }),
            )],
            None,
        );
        assert_eq!(scheduled_wakeup(&event), Some(due_in(1560)));
    }

    #[test]
    fn delay_is_clamped_like_the_cli_does() {
        let short = assistant(
            vec![tool_use(TOOL_NAME, json!({ "delaySeconds": 5 }))],
            None,
        );
        let long = assistant(
            vec![tool_use(TOOL_NAME, json!({ "delaySeconds": 99999 }))],
            None,
        );
        assert_eq!(scheduled_wakeup(&short), Some(due_in(120)));
        assert_eq!(scheduled_wakeup(&long), Some(due_in(3660)));
    }

    #[test]
    fn a_missing_delay_holds_for_the_longest_allowed() {
        let event = assistant(vec![tool_use(TOOL_NAME, json!({ "prompt": "p" }))], None);
        assert_eq!(scheduled_wakeup(&event), Some(due_in(3660)));
    }

    #[test]
    fn stop_cancels_the_pending_wakeup() {
        let event = assistant(vec![tool_use(TOOL_NAME, json!({ "stop": true }))], None);
        assert_eq!(scheduled_wakeup(&event), Some(ScheduledWakeup::Cancelled));
    }

    #[test]
    fn other_tools_and_subagent_calls_are_ignored() {
        let bash = assistant(vec![tool_use("Bash", json!({ "command": "ls" }))], None);
        let nested = assistant(
            vec![tool_use(TOOL_NAME, json!({ "delaySeconds": 60 }))],
            Some("toolu_parent"),
        );
        assert_eq!(scheduled_wakeup(&bash), None);
        assert_eq!(scheduled_wakeup(&nested), None);
    }
}
