//! Track root commands and dispatched children across real ACP turn boundaries.
use std::collections::{HashMap, VecDeque};

use cadencr_provider_sdk::meta::{background_work_meta, merge_meta};
use serde_json::{json, Value};

use super::detached::Replies;
use super::tools::call_name;
use super::{is_terminal_tool_status, session_update};

#[derive(Default)]
pub(super) struct Working {
    sessions: HashMap<String, Session>,
    releases: VecDeque<Release>,
}

enum Release {
    Settled(String),
    Reset(String),
}

#[derive(Default)]
struct Session {
    calls: HashMap<String, Call>,
    announced: bool,
}

#[derive(Clone, Copy)]
enum Call {
    CurrentCommand,
    DetachedCommand,
    Child,
}

impl Working {
    pub(super) fn observe_request(&mut self, frame: &Value) {
        let params = &frame["params"];
        let Some(id) = params["sessionId"].as_str() else {
            return;
        };
        match frame["method"].as_str() {
            Some("session/prompt") => {
                self.sessions.entry(id.to_owned()).or_default();
            }
            Some("session/cancel" | "session/close" | "session/load" | "session/resume")
                if self
                    .sessions
                    .remove(id)
                    .is_some_and(|session| session.announced) =>
            {
                self.releases.push_back(Release::Reset(id.to_owned()));
            }
            _ => {}
        }
    }

    /// Returns true for activity unrelated to the reply's current tool step.
    pub(super) fn observe_tool(&mut self, frame: &Value) -> bool {
        let Some((id, call, update)) = root_tool(frame) else {
            return false;
        };
        let Some(session) = self.sessions.get_mut(id) else {
            return false;
        };
        let terminal = is_terminal_tool_status(update["status"].as_str());
        match session.calls.get(call).copied() {
            Some(Call::Child) => return true,
            Some(command @ (Call::CurrentCommand | Call::DetachedCommand)) if terminal => {
                session.calls.remove(call);
                if session.is_settled() {
                    self.releases.push_back(Release::Settled(id.to_owned()));
                }
                return matches!(command, Call::DetachedCommand);
            }
            Some(Call::DetachedCommand) => return true,
            Some(Call::CurrentCommand) => return false,
            None => {}
        }
        if update.pointer("/_meta/cadencr/subagent/background") == Some(&Value::Bool(true)) {
            session.calls.insert(call.to_owned(), Call::Child);
        } else if !terminal && update.as_object().and_then(call_name) == Some("run_command") {
            session.calls.insert(call.to_owned(), Call::CurrentCommand);
        }
        false
    }

    pub(super) fn observe_child(&mut self, frame: &Value) {
        let Some((id, call, update)) = root_tool(frame) else {
            return;
        };
        if is_terminal_tool_status(
            update
                .pointer("/_meta/cadencr/subagent/status")
                .and_then(Value::as_str),
        ) {
            self.forget_child(id, call);
        }
    }

    pub(super) fn forget_child(&mut self, id: &str, call: &str) {
        let Some(session) = self.sessions.get_mut(id) else {
            return;
        };
        if matches!(session.calls.get(call), Some(Call::Child)) {
            session.calls.remove(call);
            if session.is_settled() {
                self.releases.push_back(Release::Settled(id.to_owned()));
            }
        }
    }

    pub(super) fn decorate_boundary(&mut self, id: &str, body: &mut Value) {
        let Some(session) = self.sessions.get_mut(id) else {
            return;
        };
        let pending = !session.calls.is_empty();
        if pending || session.announced {
            if let Some(body) = body.as_object_mut() {
                merge_meta(body, background_work_meta(pending));
                session.announced = pending;
                for call in session.calls.values_mut() {
                    if matches!(call, Call::CurrentCommand) {
                        *call = Call::DetachedCommand;
                    }
                }
            }
        }
    }

    pub(super) fn has_releases(&self) -> bool {
        !self.releases.is_empty()
    }

    pub(super) fn take_finished(&mut self, replies: &Replies) -> Option<Value> {
        while let Some(release) = self.releases.pop_front() {
            match release {
                Release::Settled(id) => {
                    let Some(session) = self.sessions.get_mut(&id) else {
                        continue;
                    };
                    if session.is_settled() && !replies.has_boundary(&id) {
                        session.announced = false;
                        return Some(finished(&id));
                    }
                }
                Release::Reset(id) if !self.sessions.contains_key(&id) => {
                    return Some(finished(&id));
                }
                Release::Reset(_) => {}
            }
        }
        None
    }
}

impl Session {
    fn is_settled(&self) -> bool {
        self.announced && self.calls.is_empty()
    }
}

fn root_tool(frame: &Value) -> Option<(&str, &str, &Value)> {
    let id = frame.pointer("/params/sessionId")?.as_str()?;
    let update = frame.pointer("/params/update")?;
    if !matches!(
        update["sessionUpdate"].as_str(),
        Some("tool_call" | "tool_call_update")
    ) || update["parentToolCallId"].is_string()
    {
        return None;
    }
    Some((id, update["toolCallId"].as_str()?, update))
}

fn finished(session: &str) -> Value {
    session_update(
        session,
        json!({"sessionUpdate":"session_info_update","_meta":background_work_meta(false)}),
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::events::EventMapper;
    const SESSION: &str = "aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa";

    fn tool(mapper: &mut EventMapper, id: &str, kind: &str, name: &str, status: &str) {
        mapper.map_agent(&mut session_update(
            SESSION,
            json!({
                "sessionUpdate":kind,"toolCallId":id,"name":name,"status":status
            }),
        ));
    }

    fn prompt(mapper: &mut EventMapper, id: u64) {
        mapper.map_host(
            &mut json!({"method":"session/prompt","id":id,"params":{"sessionId":SESSION}}),
        );
    }

    fn result(mapper: &mut EventMapper, id: u64) -> Value {
        let mut frame = json!({"id":id,"result":{"stopReason":"end_turn","usage":{"totalTokens":20},"_meta":{"native":1}}});
        mapper.map_agent(&mut frame);
        assert_eq!(frame["result"]["usage"]["totalTokens"], 20);
        assert_eq!(frame["result"]["_meta"]["native"], 1);
        frame["result"]["_meta"]["cadencr"]["backgroundWorkPending"].clone()
    }

    #[test]
    fn a_real_prompt_ends_while_its_child_and_command_keep_the_session_working() {
        let mut mapper = EventMapper::default();
        prompt(&mut mapper, 1);
        tool(
            &mut mapper,
            "child",
            "tool_call",
            "invoke_subagent",
            "in_progress",
        );
        tool(&mut mapper, "child", "tool_call_update", "", "completed");
        tool(
            &mut mapper,
            "cmd",
            "tool_call",
            "run_command",
            "in_progress",
        );
        assert_eq!(result(&mut mapper, 1), true);
        assert!(mapper.take_finished_work().is_none());
        tool(&mut mapper, "cmd", "tool_call_update", "", "failed");
        assert!(mapper.take_finished_work().is_none());
        tool(&mut mapper, "child", "tool_call_update", "", "completed");
        assert!(mapper.take_finished_work().is_none());
        mapper.observe_child(&session_update(SESSION,json!({"sessionUpdate":"tool_call_update","toolCallId":"child","_meta":{"cadencr":{"subagent":{"status":"completed"}}}})));
        assert_eq!(mapper.take_finished_work(), Some(finished(SESSION)));
        assert!(mapper.take_finished_work().is_none());
    }

    #[test]
    fn missing_native_child_journals_release_the_hold_without_finishing_the_card() {
        use crate::events::SubagentTracker;
        use std::ffi::OsString;
        let mut mapper = EventMapper::default();
        prompt(&mut mapper, 1);
        tool(
            &mut mapper,
            "child",
            "tool_call",
            "invoke_subagent",
            "in_progress",
        );
        tool(&mut mapper, "child", "tool_call_update", "", "completed");
        assert_eq!(result(&mut mapper, 1), true);
        let mut tracker = SubagentTracker::new(&[OsString::from("--app-data-dir=../unknown")]);
        assert!(tracker.poll(mapper.take_subagent_operations()).is_empty());
        for (session, carrier) in tracker.unobserved.drain(..) {
            mapper.forget_child(&session, &carrier);
        }
        assert_eq!(mapper.take_finished_work(), Some(finished(SESSION)));
    }

    #[test]
    fn background_command_progress_and_repeated_completion_preserve_the_reply_deadline() {
        let mut mapper = EventMapper::default();
        prompt(&mut mapper, 2);
        tool(
            &mut mapper,
            "cmd",
            "tool_call",
            "run_command",
            "in_progress",
        );
        assert_eq!(result(&mut mapper, 2), true);
        mapper.map_agent(&mut session_update(
            SESSION,
            json!({"sessionUpdate":"agent_message_chunk","content":{"type":"text","text":"Done"}}),
        ));
        mapper.map_agent(&mut session_update(
            SESSION,
            json!({"sessionUpdate":"usage_update","used":5,"size":100}),
        ));
        let deadline = mapper.detached_reply_deadline().unwrap();
        tool(&mut mapper, "cmd", "tool_call_update", "", "in_progress");
        assert_eq!(mapper.detached_reply_deadline(), Some(deadline));
        tool(&mut mapper, "cmd", "tool_call_update", "", "completed");
        tool(&mut mapper, "cmd", "tool_call_update", "", "completed");
        assert_eq!(mapper.detached_reply_deadline(), Some(deadline));
        assert!(mapper.has_work_release());
        assert!(mapper.take_finished_work().is_none());
        let end = mapper.take_completed_detached_reply(deadline).unwrap();
        assert_eq!(
            end["params"]["update"]["_meta"]["cadencr"],
            json!({"detachedReplyEnded":true,"backgroundWorkPending":false})
        );
        assert!(mapper.take_finished_work().is_none());
    }

    #[test]
    fn a_new_prompt_carries_a_release_from_work_that_finished_during_the_request() {
        let mut mapper = EventMapper::default();
        prompt(&mut mapper, 1);
        tool(
            &mut mapper,
            "cmd",
            "tool_call",
            "run_command",
            "in_progress",
        );
        assert_eq!(result(&mut mapper, 1), true);

        prompt(&mut mapper, 2);
        tool(&mut mapper, "cmd", "tool_call_update", "", "completed");
        assert!(mapper.has_work_release());
        assert!(mapper.take_finished_work().is_none());
        assert_eq!(result(&mut mapper, 2), false);
        assert!(mapper.take_finished_work().is_none());
    }

    #[test]
    fn newer_model_text_can_finish_a_reply_while_an_earlier_tool_is_still_running() {
        let mut mapper = EventMapper::default();
        let chunk = |kind, text| {
            session_update(
                SESSION,
                json!({"sessionUpdate":kind,"content":{"type":"text","text":text}}),
            )
        };
        let usage = |used| {
            session_update(
                SESSION,
                json!({"sessionUpdate":"usage_update","used":used,"size":100}),
            )
        };
        prompt(&mut mapper, 1);
        assert!(result(&mut mapper, 1).is_null());
        mapper.map_agent(&mut chunk("agent_thought_chunk", "Checking status."));
        mapper.map_agent(&mut usage(5));
        tool(
            &mut mapper,
            "cmd",
            "tool_call",
            "run_command",
            "in_progress",
        );
        tool(&mut mapper, "read", "tool_call", "read_file", "in_progress");
        assert!(mapper.detached_reply_deadline().is_none());

        mapper.map_agent(&mut chunk("agent_message_chunk", "Waiting for Bash."));
        mapper.map_agent(&mut usage(6));
        let deadline = mapper.detached_reply_deadline().unwrap();
        tool(&mut mapper, "cmd", "tool_call_update", "", "in_progress");
        assert_eq!(mapper.detached_reply_deadline(), Some(deadline));
        let end = mapper.take_completed_detached_reply(deadline).unwrap();
        assert_eq!(
            end["params"]["update"]["_meta"]["cadencr"],
            json!({"detachedReplyEnded":true,"backgroundWorkPending":true})
        );

        tool(&mut mapper, "cmd", "tool_call_update", "", "completed");
        assert_eq!(mapper.take_finished_work(), Some(finished(SESSION)));
    }

    #[test]
    fn synchronous_commands_replay_and_cancel_do_not_leave_a_hold() {
        let mut mapper = EventMapper::default();
        tool(
            &mut mapper,
            "replay",
            "tool_call",
            "run_command",
            "in_progress",
        );
        prompt(&mut mapper, 3);
        tool(
            &mut mapper,
            "sync",
            "tool_call",
            "run_command",
            "in_progress",
        );
        tool(&mut mapper, "sync", "tool_call_update", "", "completed");
        assert!(result(&mut mapper, 3).is_null());
        prompt(&mut mapper, 4);
        tool(
            &mut mapper,
            "cmd",
            "tool_call",
            "run_command",
            "in_progress",
        );
        assert_eq!(result(&mut mapper, 4), true);
        mapper.map_host(&mut json!({"method":"session/cancel","params":{"sessionId":SESSION}}));
        assert_eq!(mapper.take_finished_work(), Some(finished(SESSION)));
        prompt(&mut mapper, 5);
        assert!(result(&mut mapper, 5).is_null());
    }
}
