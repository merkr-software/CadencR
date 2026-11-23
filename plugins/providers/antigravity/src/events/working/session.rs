//! Native task ownership and the handoff from a finished task to its model wake.
use std::collections::HashMap;
use std::time::Duration;

use serde_json::Value;
use tokio::time::Instant;

use super::super::{detached::is_model_content, is_terminal_tool_status, tools::call_name};

// ACP has no "generation started" event. Bound only the silence after the task
// finishes. Time spent running the task or streaming its reply has no deadline.
const WAKE_TIMEOUT: Duration = Duration::from_secs(60);

#[derive(Default)]
pub(super) struct Session {
    calls: HashMap<String, Call>,
    pub(super) announced: bool,
    pub(super) wake_until: Option<Instant>,
    model_streaming: bool,
    active_prompt: Option<u64>,
    wake_consumer: Option<u64>,
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum Kind {
    CurrentTask,
    BackgroundTask,
    Child,
    Daemon,
}

#[derive(Clone, Copy)]
struct Call {
    kind: Kind,
    // An explicit new prompt takes over the continuation of older work.
    inherited_by_prompt: Option<u64>,
    owner: Option<u64>,
}

impl Session {
    pub(super) fn begin_prompt(&mut self, generation: u64) {
        self.active_prompt = Some(generation);
        // Only the native generation boundary ends streaming. A host steer can
        // arrive between two chunks of the same sentence.
        if self.model_streaming {
            return;
        }
        if self.wake_until.is_some() {
            self.wake_consumer = Some(generation);
        }
        for call in self.calls.values_mut() {
            call.inherited_by_prompt = Some(generation);
        }
    }

    pub(super) fn end_prompt(
        &mut self,
        ended: &super::super::detached::EndedPrompt,
        success: bool,
    ) {
        let owner = Some(ended.generation);
        self.active_prompt = ended.remaining;
        self.calls.retain(|_, call| {
            if call.inherited_by_prompt == owner {
                call.inherited_by_prompt = None;
            }
            if call.kind == Kind::CurrentTask && call.owner == owner {
                if !success {
                    return false;
                }
                call.kind = Kind::BackgroundTask;
            }
            true
        });
        if self.wake_consumer == owner {
            if success {
                self.wake_until = None;
            }
            self.wake_consumer = None;
        }
        if ended.remaining.is_none() {
            self.model_streaming = false;
        }
    }

    pub(super) fn observe_update(&mut self, update: &Value) -> bool {
        if is_model_content(update) {
            if !self.model_streaming {
                self.wake_until = None;
                self.wake_consumer = None;
                for call in self.calls.values_mut() {
                    call.inherited_by_prompt = None;
                }
            }
            self.model_streaming = true;
            self.detach_tasks();
            return false;
        }
        match update["sessionUpdate"].as_str() {
            Some("usage_update") => self.model_streaming = false,
            Some("tool_call" | "tool_call_update") if !update["parentToolCallId"].is_string() => {
                if let Some(id) = update["toolCallId"].as_str() {
                    return self.observe_tool(id, update);
                }
            }
            _ => {}
        }
        false
    }

    fn observe_tool(&mut self, id: &str, update: &Value) -> bool {
        let terminal = is_terminal_tool_status(update["status"].as_str());
        if let Some(call) = self.calls.get_mut(id) {
            // ACP can provide the arguments on a later update of the same call.
            if call.kind != Kind::Child && is_daemon(update) {
                call.kind = Kind::Daemon;
            }
            let call = *call;
            if terminal && call.kind != Kind::Child {
                self.calls.remove(id);
                if call.kind == Kind::BackgroundTask
                    || (call.kind == Kind::CurrentTask && call.owner != self.active_prompt)
                {
                    self.expect_wake(call);
                }
            }
            return matches!(call.kind, Kind::Child | Kind::BackgroundTask);
        }
        let kind =
            if update.pointer("/_meta/cadencr/subagent/background") == Some(&Value::Bool(true)) {
                Kind::Child
            } else if !terminal {
                match update.as_object().and_then(call_name) {
                    Some("schedule" | "run_command") => {
                        if is_daemon(update) {
                            Kind::Daemon
                        } else {
                            Kind::CurrentTask
                        }
                    }
                    _ => return false,
                }
            } else {
                return false;
            };
        self.calls.insert(
            id.to_owned(),
            Call {
                kind,
                inherited_by_prompt: None,
                owner: self.active_prompt,
            },
        );
        false
    }

    pub(super) fn remove_child(&mut self, id: &str, expect_wake: bool) {
        if self
            .calls
            .get(id)
            .is_some_and(|call| call.kind == Kind::Child)
        {
            if let Some(call) = self.calls.remove(id) {
                if expect_wake {
                    self.expect_wake(call);
                }
            }
        }
    }

    fn expect_wake(&mut self, call: Call) {
        // A prompt may consume work inherited before its first generation.
        // Preserve a wake if any completion still needs a fresh model step.
        if self.wake_until.is_none() {
            self.wake_consumer = call.inherited_by_prompt;
        } else if self.wake_consumer != call.inherited_by_prompt {
            self.wake_consumer = None;
        }
        self.wake_until = Some(Instant::now() + WAKE_TIMEOUT);
    }

    pub(super) fn has_tasks(&self) -> bool {
        self.calls.values().any(|call| call.kind != Kind::Daemon)
    }

    pub(super) fn boundary(&mut self) -> bool {
        self.model_streaming = false;
        self.detach_tasks();
        for call in self.calls.values_mut() {
            call.inherited_by_prompt = None;
        }
        self.has_tasks() || self.wake_until.is_some()
    }

    fn detach_tasks(&mut self) {
        for call in self.calls.values_mut() {
            if call.kind == Kind::CurrentTask {
                call.kind = Kind::BackgroundTask;
            }
        }
    }
}

fn is_daemon(update: &Value) -> bool {
    update
        .pointer("/rawInput/IsDaemon")
        .or_else(|| update.pointer("/args/IsDaemon"))
        == Some(&Value::Bool(true))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn chunk(text: &str) -> Value {
        json!({"sessionUpdate":"agent_message_chunk","content":{"type":"text","text":text}})
    }

    fn task(id: &str, kind: &str, status: &str) -> Value {
        json!({"sessionUpdate":kind,"toolCallId":id,"name":"run_command","status":status})
    }

    #[test]
    fn a_task_returning_mid_sentence_waits_for_the_next_model_step() {
        let mut state = Session::default();
        state.begin_prompt(1);
        state.observe_update(&task("bash", "tool_call", "in_progress"));
        state.observe_update(&chunk("Still "));
        state.observe_update(&task("bash", "tool_call_update", "completed"));
        state.observe_update(&chunk("waiting."));
        assert!(state.boundary(), "the receipt must carry the model wake");
        state.observe_update(&chunk(""));
        state.observe_update(&json!({"sessionUpdate":"usage_update","used":4,"size":200}));
        assert!(state.wake_until.is_some());
        state.observe_update(&chunk("The command returned."));
        assert!(!state.boundary());
    }

    #[test]
    fn admitting_a_steer_during_text_does_not_consume_a_later_command_result() {
        let mut state = Session::default();
        state.begin_prompt(1);
        state.observe_update(&task("bash", "tool_call", "in_progress"));
        state.observe_update(&chunk("Still "));
        state.begin_prompt(2);
        state.observe_update(&task("bash", "tool_call_update", "completed"));
        state.observe_update(&chunk("waiting."));
        assert!(state.boundary());
        state.observe_update(&chunk("The command returned."));
        assert!(!state.boundary());
    }

    #[test]
    fn explicit_daemons_do_not_pin_the_turn_and_partial_updates_keep_the_launch_intent() {
        for parameter in ["args", "rawInput"] {
            let mut state = Session::default();
            let mut launch = task("daemon", "tool_call", "in_progress");
            launch[parameter] = json!({"IsDaemon":true});
            state.observe_update(&launch);
            state.observe_update(&task("daemon", "tool_call_update", "in_progress"));
            state.observe_update(&chunk("The service is up."));
            assert!(!state.boundary());
            state.observe_update(&task("ordinary", "tool_call", "in_progress"));
            state.observe_update(&task("daemon", "tool_call_update", "completed"));
            assert!(state.boundary());
            assert!(
                state.wake_until.is_none(),
                "the daemon exit schedules no wake"
            );
        }
    }

    #[test]
    fn late_daemon_arguments_discharge_only_the_corresponding_task() {
        let mut state = Session::default();
        state.observe_update(&task("timer", "tool_call", "in_progress"));
        state.observe_update(&json!({"sessionUpdate":"tool_call","toolCallId":"cron","name":"schedule","status":"in_progress"}));
        assert!(state.boundary());
        state.observe_update(&json!({"sessionUpdate":"tool_call_update","toolCallId":"cron","args":{"IsDaemon":true}}));
        assert!(state.has_tasks());
        state.observe_update(&json!({"sessionUpdate":"tool_call_update","toolCallId":"timer","rawInput":{"IsDaemon":true}}));
        assert!(!state.boundary());
        assert!(state.wake_until.is_none());
    }
}
