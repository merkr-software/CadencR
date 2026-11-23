//! Track root commands and dispatched children across real ACP turn boundaries.
use std::collections::{HashMap, VecDeque};
mod session;
use session::Session;

use cadencr_provider_sdk::meta::{background_work_meta, merge_meta};
use serde_json::{json, Value};
use tokio::time::Instant;

use super::detached::{EndedPrompt, Replies};
use super::{is_terminal_tool_status, session_update};

#[derive(Default)]
pub(super) struct Working {
    sessions: HashMap<String, Session>,
    resets: VecDeque<String>,
}

impl Working {
    pub(super) fn observe_request(&mut self, frame: &Value, generation: Option<u64>) {
        let params = &frame["params"];
        let Some(id) = params["sessionId"].as_str() else {
            return;
        };
        match frame["method"].as_str() {
            Some("session/prompt") if let Some(generation) = generation => {
                self.sessions
                    .entry(id.to_owned())
                    .or_default()
                    .begin_prompt(generation);
            }
            Some("session/cancel" | "session/close" | "session/load" | "session/resume")
                if self
                    .sessions
                    .remove(id)
                    .is_some_and(|session| session.announced) =>
            {
                self.resets.push_back(id.to_owned());
            }
            _ => {}
        }
    }

    /// Returns true for activity unrelated to the reply's current tool step.
    pub(super) fn observe_update(&mut self, frame: &Value) -> bool {
        let params = &frame["params"];
        params["sessionId"]
            .as_str()
            .and_then(|id| self.sessions.get_mut(id))
            .is_some_and(|session| session.observe_update(&params["update"]))
    }

    pub(super) fn observe_child(&mut self, frame: &Value, parent_acted: bool) {
        let Some((id, call, update)) = root_tool(frame) else {
            return;
        };
        if is_terminal_tool_status(
            update
                .pointer("/_meta/cadencr/subagent/status")
                .and_then(Value::as_str),
        ) {
            if let Some(session) = self.sessions.get_mut(id) {
                session.remove_child(call, !parent_acted);
            }
        }
    }

    pub(super) fn forget_child(&mut self, id: &str, call: &str) {
        let Some(session) = self.sessions.get_mut(id) else {
            return;
        };
        session.remove_child(call, false);
    }

    pub(super) fn decorate_boundary(&mut self, id: &str, body: &mut Value) {
        let Some(session) = self.sessions.get_mut(id) else {
            return;
        };
        let pending = session.boundary();
        Self::announce(session, pending, body);
    }

    pub(super) fn end_prompt(
        &mut self,
        ended: &EndedPrompt,
        result: Option<&mut Value>,
        success: bool,
    ) -> bool {
        let Some(session) = self.sessions.get_mut(&ended.session) else {
            return false;
        };
        session.end_prompt(ended, success);
        let pending = session.has_tasks() || session.wake_until.is_some();
        if let Some(body) = result {
            Self::announce(session, pending, body);
        }
        session.announced
    }

    fn announce(session: &mut Session, pending: bool, body: &mut Value) {
        if pending || session.announced {
            if let Some(body) = body.as_object_mut() {
                merge_meta(body, background_work_meta(pending));
                session.announced = pending;
            }
        }
    }

    fn releasable(&self, replies: &Replies, now: Instant) -> Option<&str> {
        self.sessions.iter().find_map(|(id, session)| {
            (session.announced
                && !session.has_tasks()
                && session.wake_until.is_none_or(|deadline| now >= deadline)
                && !replies.has_boundary(id))
            .then_some(id.as_str())
        })
    }

    pub(super) fn wake_deadline(&self, replies: &Replies) -> Option<Instant> {
        self.sessions
            .iter()
            .filter(|(id, session)| {
                session.announced && !session.has_tasks() && !replies.has_boundary(id)
            })
            .filter_map(|(_, session)| session.wake_until)
            .min()
    }

    pub(super) fn has_releases(&self, replies: &Replies) -> bool {
        !self.resets.is_empty() || self.releasable(replies, Instant::now()).is_some()
    }

    pub(super) fn take_finished(&mut self, replies: &Replies, now: Instant) -> Option<Value> {
        while let Some(id) = self.resets.pop_front() {
            if !self.sessions.contains_key(&id) {
                return Some(finished(&id));
            }
        }
        let id = self.releasable(replies, now)?.to_owned();
        let session = self.sessions.get_mut(&id)?;
        session.announced = false;
        session.wake_until = None;
        Some(finished(&id))
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
    use std::time::Duration;
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
        mapper.observe_child(&mut session_update(SESSION,json!({"sessionUpdate":"tool_call_update","toolCallId":"child","_meta":{"cadencr":{"subagent":{"status":"completed"}}}})));
        assert!(mapper.take_finished_work().is_none());
        let timeout = mapper.next_deadline().unwrap();
        assert_eq!(
            mapper.working.take_finished(&mapper.detached, timeout),
            Some(finished(SESSION))
        );
        assert!(mapper.take_finished_work().is_none());
    }

    #[test]
    fn a_consumed_child_report_neither_arms_a_second_wake_nor_clears_a_siblings_hold() {
        use crate::events::subagents::PARENT_ACTED;

        for other_child_awaits_wake in [false, true] {
            let mut mapper = EventMapper::default();
            prompt(&mut mapper, 1);
            for id in ["answered", "unanswered"]
                .into_iter()
                .take(1 + usize::from(other_child_awaits_wake))
            {
                tool(
                    &mut mapper,
                    id,
                    "tool_call",
                    "invoke_subagent",
                    "in_progress",
                );
                tool(&mut mapper, id, "tool_call_update", "", "completed");
            }
            assert_eq!(result(&mut mapper, 1), true);
            mapper.map_agent(&mut session_update(SESSION, json!({"sessionUpdate":"agent_message_chunk","content":{"type":"text","text":"Received the first child report"}})));
            mapper.map_agent(&mut session_update(
                SESSION,
                json!({"sessionUpdate":"usage_update","used":5,"size":100}),
            ));
            let boundary = mapper
                .take_completed_detached_reply(Instant::now() + Duration::from_secs(2))
                .unwrap();
            assert_eq!(
                boundary.pointer("/params/update/_meta/cadencr/backgroundWorkPending"),
                Some(&Value::Bool(true))
            );

            let child_end = |id| {
                session_update(
                    SESSION,
                    json!({"sessionUpdate":"tool_call_update","toolCallId":id,"_meta":{"cadencr":{"subagent":{"status":"completed"}}}}),
                )
            };
            if other_child_awaits_wake {
                mapper.observe_child(&mut child_end("unanswered"));
            }
            let mut answered = child_end("answered");
            answered[PARENT_ACTED] = json!(true);
            mapper.observe_child(&mut answered);
            assert!(answered.get(PARENT_ACTED).is_none());
            assert_eq!(
                mapper.take_finished_work(),
                (!other_child_awaits_wake).then(|| finished(SESSION))
            );
        }
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
        assert!(
            !mapper.has_work_release(),
            "the pending boundary owns the release"
        );
        assert!(mapper.take_finished_work().is_none());
        let end = mapper.take_completed_detached_reply(deadline).unwrap();
        assert_eq!(
            end["params"]["update"]["_meta"]["cadencr"],
            json!({"detachedReplyEnded":true,"backgroundWorkPending":true})
        );
        assert!(mapper.take_finished_work().is_none());
        mapper.map_agent(&mut session_update(SESSION, json!({
            "sessionUpdate":"agent_thought_chunk","content":{"type":"text","text":"The command returned."}
        })));
        mapper.map_agent(&mut session_update(
            SESSION,
            json!({"sessionUpdate":"usage_update","used":7,"size":100}),
        ));
        let end = mapper
            .take_completed_detached_reply(mapper.detached_reply_deadline().unwrap())
            .unwrap();
        assert_eq!(
            end["params"]["update"]["_meta"]["cadencr"]["backgroundWorkPending"],
            false
        );
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
        assert!(
            !mapper.has_work_release(),
            "the pending boundary owns the release"
        );
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
        assert!(mapper.take_finished_work().is_none());
        let timeout = mapper.next_deadline().unwrap();
        assert!(mapper
            .working
            .take_finished(&mapper.detached, timeout - Duration::from_millis(1))
            .is_none());
        assert_eq!(
            mapper.working.take_finished(&mapper.detached, timeout),
            Some(finished(SESSION))
        );
    }

    #[test]
    fn a_rejected_steer_keeps_the_first_commands_continuation() {
        for request_cancelled in [false, true] {
            let mut mapper = EventMapper::default();
            prompt(&mut mapper, 1);
            tool(
                &mut mapper,
                "original",
                "tool_call",
                "run_command",
                "in_progress",
            );
            prompt(&mut mapper, 2);
            assert_eq!(result(&mut mapper, 1), true);
            if request_cancelled {
                mapper.map_host(&mut json!({"method":"$/cancel_request","params":{"requestId":2}}));
            } else {
                mapper.map_agent(&mut json!({"id":2,"error":{"code":-32603,"message":"rejected"}}));
            }
            assert!(mapper.take_finished_work().is_none());
            tool(&mut mapper, "original", "tool_call_update", "", "completed");
            assert!(mapper.take_finished_work().is_none());
            mapper.map_agent(&mut session_update(SESSION, json!({"sessionUpdate":"agent_message_chunk","content":{"type":"text","text":"The command returned."}})));
            mapper.map_agent(&mut session_update(
                SESSION,
                json!({"sessionUpdate":"usage_update","used":7,"size":100}),
            ));
            let end = mapper
                .take_completed_detached_reply(mapper.detached_reply_deadline().unwrap())
                .unwrap();
            assert_eq!(
                end["params"]["update"]["_meta"]["cadencr"],
                json!({"detachedReplyEnded":true,"backgroundWorkPending":false})
            );
        }
    }

    #[test]
    fn a_command_finishing_inside_steered_text_keeps_its_own_wake() {
        let mut mapper = EventMapper::default();
        prompt(&mut mapper, 1);
        tool(
            &mut mapper,
            "original",
            "tool_call",
            "run_command",
            "in_progress",
        );
        prompt(&mut mapper, 2);
        result(&mut mapper, 1);
        let text = |t| {
            session_update(
                SESSION,
                json!({"sessionUpdate":"agent_message_chunk","content":{"type":"text","text":t}}),
            )
        };
        mapper.map_agent(&mut text("I'm "));
        tool(&mut mapper, "original", "tool_call_update", "", "completed");
        mapper.map_agent(&mut text("working on the new request."));
        assert_eq!(result(&mut mapper, 2), true);
        assert!(mapper.take_finished_work().is_none());
        mapper.map_agent(&mut text("Original command succeeded."));
        mapper.map_agent(&mut session_update(
            SESSION,
            json!({"sessionUpdate":"usage_update","used":8,"size":100}),
        ));
        let end = mapper
            .take_completed_detached_reply(mapper.detached_reply_deadline().unwrap())
            .unwrap();
        assert_eq!(
            end["params"]["update"]["_meta"]["cadencr"]["backgroundWorkPending"],
            false
        );
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
