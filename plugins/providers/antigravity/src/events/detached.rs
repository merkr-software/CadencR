//! After finishing a prompt, agy can wake to stream another reply (for
//! example, when a subagent finishes). Agy reports usage after each model
//! step, before any tool calls belonging to that step.

use std::collections::{HashMap, HashSet};
use std::time::Duration;

use serde_json::{json, Value};
use tokio::time::Instant;

use super::{is_terminal_tool_status, session_update};

const QUIET_WINDOW: Duration = Duration::from_secs(1);

#[derive(Default)]
pub(super) struct Replies {
    requests: HashMap<String, PendingRequest>,
    post_turn: HashMap<String, Reply>,
}

enum PendingRequest {
    Prompt(String),
    Restore(String),
}

impl PendingRequest {
    fn session(&self) -> &str {
        match self {
            Self::Prompt(session) | Self::Restore(session) => session,
        }
    }
}

#[derive(Default)]
struct Reply {
    phase: Phase,
    tools: HashSet<String>,
    last_usage: Option<Usage>,
}

#[derive(Default)]
enum Phase {
    #[default]
    AwaitingContent,
    Streaming,
    ToolStep,
    Closing(Completion),
}

#[derive(Clone, Copy, PartialEq, Eq)]
struct Usage {
    used: u64,
    size: u64,
}

struct Completion {
    deadline: Instant,
    usage: Usage,
    cancelled: bool,
}

impl Replies {
    pub(super) fn observe_request(&mut self, message: &Value) {
        let method = message.get("method").and_then(Value::as_str);
        if method == Some("$/cancel_request") {
            if let Some(id) = message.pointer("/params/requestId") {
                self.requests.remove(&id.to_string());
            }
            return;
        }
        let Some(session) = message.pointer("/params/sessionId").and_then(Value::as_str) else {
            return;
        };
        match method {
            Some("session/cancel") => {
                if let Some(Phase::Closing(completion)) = self
                    .post_turn
                    .get_mut(session)
                    .map(|reply| &mut reply.phase)
                {
                    // The native prompt has already ended. Deliver the boundary
                    // so the host can finish the interrupted detached turn.
                    completion.cancelled = true;
                    completion.deadline = Instant::now();
                } else {
                    self.clear(session);
                }
            }
            Some("session/close") => self.clear(session),
            Some("session/prompt" | "session/load" | "session/resume") => {
                let Some(id) = message
                    .get("id")
                    .filter(|id| id.is_string() || id.is_number())
                else {
                    return;
                };
                let request = if method == Some("session/prompt") {
                    self.post_turn.remove(session);
                    PendingRequest::Prompt(session.to_owned())
                } else {
                    self.clear(session);
                    PendingRequest::Restore(session.to_owned())
                };
                self.requests.insert(id.to_string(), request);
            }
            _ => {}
        }
    }

    pub(super) fn observe_response(&mut self, message: &Value) -> Option<String> {
        let Some(PendingRequest::Prompt(session)) = message
            .get("id")
            .and_then(|id| self.requests.remove(&id.to_string()))
        else {
            return None;
        };
        if message
            .pointer("/result/stopReason")
            .and_then(Value::as_str)
            == Some("end_turn")
            && !self
                .requests
                .values()
                .any(|request| request.session() == session)
        {
            self.post_turn.insert(session.clone(), Reply::default());
            return Some(session);
        }
        None
    }

    pub(super) fn has_boundary(&self, session: &str) -> bool {
        self.post_turn
            .get(session)
            .is_some_and(|reply| !matches!(reply.phase, Phase::AwaitingContent))
            || self
                .requests
                .values()
                .any(|request| request.session() == session)
    }

    pub(super) fn observe_update(&mut self, message: &Value, now: impl FnOnce() -> Instant) {
        let Some(reply) = message
            .pointer("/params/sessionId")
            .and_then(Value::as_str)
            .and_then(|session| self.post_turn.get_mut(session))
        else {
            return;
        };
        if matches!(&reply.phase, Phase::Closing(completion) if completion.cancelled) {
            return;
        }
        let Some(update) = message.pointer("/params/update") else {
            return;
        };
        match update.get("sessionUpdate").and_then(Value::as_str) {
            Some("agent_message_chunk" | "agent_thought_chunk") if has_text(update) => {
                // The model advanced beyond the earlier tool step. Its tools
                // can continue in the background without holding this reply.
                reply.tools.clear();
                reply.phase = Phase::Streaming;
            }
            Some(kind @ ("tool_call" | "tool_call_update")) => reply.observe_tool(update, kind),
            Some("usage_update") => reply.observe_usage(update, now),
            _ => {}
        }
    }

    pub(super) fn next_deadline(&self) -> Option<Instant> {
        self.post_turn
            .values()
            .filter_map(|reply| match &reply.phase {
                Phase::Closing(completion) => Some(completion.deadline),
                _ => None,
            })
            .min()
    }

    pub(super) fn take_completed(&mut self, now: Instant) -> Option<Value> {
        let (frame, cancelled) = self.post_turn.iter_mut().find_map(|(session, reply)| {
            let Phase::Closing(completion) = &reply.phase else { return None };
            if completion.deadline > now {
                return None;
            }
            let frame = session_update(session, json!({
                "sessionUpdate": "usage_update", "used": completion.usage.used, "size": completion.usage.size,
                "_meta": {"cadencr": {"detachedReplyEnded": true}}
            }));
            let cancelled = completion.cancelled.then(|| session.clone());
            *reply = Reply::default();
            Some((frame, cancelled))
        })?;
        if let Some(session) = cancelled {
            self.post_turn.remove(&session);
        }
        Some(frame)
    }

    fn clear(&mut self, session: &str) {
        self.post_turn.remove(session);
        self.requests
            .retain(|_, request| request.session() != session);
    }
}

impl Reply {
    fn observe_tool(&mut self, update: &Value, kind: &str) {
        if matches!(self.phase, Phase::AwaitingContent) {
            return;
        }
        if let Some(call) = update["toolCallId"].as_str() {
            if kind == "tool_call_update" && !self.tools.contains(call) {
                // Updates from already completed or detached steps cannot
                // reopen them or change a fresh usage deadline.
                return;
            }
            let status = update["status"].as_str();
            if is_terminal_tool_status(status) {
                self.tools.remove(call);
            } else {
                self.tools.insert(call.to_owned());
            }
        }
        self.phase = Phase::ToolStep;
    }

    fn observe_usage(&mut self, update: &Value, now: impl FnOnce() -> Instant) {
        if matches!(self.phase, Phase::AwaitingContent) {
            return;
        }
        let (Some(used), Some(size)) = (update["used"].as_u64(), update["size"].as_u64()) else {
            return;
        };
        let usage = Usage { used, size };
        let changed = self.last_usage.replace(usage) != Some(usage);
        if !self.tools.is_empty()
            || (!changed && matches!(self.phase, Phase::ToolStep | Phase::Closing(_)))
        {
            return;
        }
        self.phase = Phase::Closing(Completion {
            deadline: now() + QUIET_WINDOW,
            usage,
            cancelled: false,
        });
    }
}

fn has_text(update: &Value) -> bool {
    update.pointer("/content/type").and_then(Value::as_str) == Some("text")
        && update
            .pointer("/content/text")
            .and_then(Value::as_str)
            .is_some_and(|text| !text.is_empty())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::events::EventMapper;

    fn request(method: &str, id: Value, session: &str) -> Value {
        json!({"jsonrpc":"2.0","method":method,"id":id,"params":{"sessionId":session}})
    }

    fn result(id: Value) -> Value {
        json!({"jsonrpc":"2.0","id":id,"result":{"stopReason":"end_turn","usage":{"inputTokens":12218,"outputTokens":390,"totalTokens":20088}}})
    }

    fn chunk(session: &str, text: &str) -> Value {
        session_update(
            session,
            json!({"sessionUpdate":"agent_message_chunk","content":{"type":"text","text":text}}),
        )
    }

    fn usage(session: &str, used: u64) -> Value {
        session_update(
            session,
            json!({"sessionUpdate":"usage_update","used":used,"size":1048576}),
        )
    }

    fn marker(frame: &Value) -> Option<&Value> {
        frame.pointer("/params/update/_meta/cadencr/detachedReplyEnded")
    }

    fn unchanged(mapper: &mut EventMapper, frame: Value) {
        let mut mapped = frame.clone();
        mapper.map_agent(&mut mapped);
        assert_eq!(mapped, frame);
    }

    fn complete(mapper: &mut EventMapper) -> Value {
        let deadline = mapper.detached_reply_deadline().expect("reply candidate");
        assert!(mapper
            .take_completed_detached_reply(deadline - Duration::from_millis(1))
            .is_none());
        mapper.take_completed_detached_reply(deadline).unwrap()
    }

    #[test]
    fn forwards_native_usage_and_emits_one_marker_after_each_quiet_reply() {
        let mut mapper = EventMapper::default();
        let prompt = request("session/prompt", json!(3), "s");
        let mut mapped = prompt.clone();
        mapper.map_host(&mut mapped);
        assert_eq!(mapped, prompt);
        unchanged(&mut mapper, chunk("s", "Launched a child agent. Waiting."));
        unchanged(&mut mapper, usage("s", 10278));
        unchanged(&mut mapper, result(json!(3)));
        unchanged(&mut mapper, usage("s", 10278));
        unchanged(
            &mut mapper,
            chunk("s", "\n\nThe child agent completed and replied:\n"),
        );
        unchanged(&mut mapper, chunk("s", "> `Cadencr fixture`\n"));

        let mut native = usage("s", 10506);
        native["params"]["update"]["_meta"] =
            json!({"antigravity":{"native":1},"cadencr":{"keep":true}});
        unchanged(&mut mapper, native.clone());
        let deadline = mapper.detached_reply_deadline().unwrap();
        unchanged(&mut mapper, native.clone());
        unchanged(&mut mapper, chunk("s", ""));
        assert_eq!(mapper.detached_reply_deadline(), Some(deadline));
        let mut expected = usage("s", 10506);
        expected["params"]["update"]["_meta"] = json!({"cadencr":{"detachedReplyEnded":true}});
        assert_eq!(complete(&mut mapper), expected);
        unchanged(&mut mapper, native);
        assert_eq!(mapper.detached_reply_deadline(), None);

        unchanged(&mut mapper, chunk("s", "Another detached reply"));
        unchanged(&mut mapper, usage("s", 10600));
        let completed = complete(&mut mapper);
        assert_eq!(marker(&completed), Some(&json!(true)));
    }

    #[test]
    fn tool_and_chunk_activity_invalidate_an_intermediate_usage_snapshot() {
        for continuation in ["tool_call", "tool_call_update"] {
            let mut replies = Replies::default();
            let start = Instant::now();
            replies.observe_request(&request("session/prompt", json!(3), "s"));
            replies.observe_response(&result(json!(3)));
            replies.observe_update(&chunk("s", "Checking the source first"), || start);
            replies.observe_update(&usage("s", 100), || start);
            replies.observe_update(
                &session_update("s", json!({"sessionUpdate": continuation})),
                || start + Duration::from_millis(5),
            );
            replies.observe_update(&usage("s", 100), || start + Duration::from_millis(10));
            let next_step = start + Duration::from_secs(4);
            assert!(replies.take_completed(next_step).is_none());

            replies.observe_update(&chunk("s", "The result is"), || next_step);
            replies.observe_update(&usage("s", 200), || next_step);
            replies.observe_update(&chunk("s", " ready"), || {
                next_step + Duration::from_millis(50)
            });
            assert!(replies.take_completed(next_step + QUIET_WINDOW).is_none());
            let final_step = next_step + Duration::from_millis(80);
            replies.observe_update(&usage("s", 205), || final_step);
            let corrected = final_step + Duration::from_millis(100);
            replies.observe_update(&usage("s", 206), || corrected);
            assert!(replies.take_completed(final_step + QUIET_WINDOW).is_none());
            let end = replies.take_completed(corrected + QUIET_WINDOW).unwrap();
            assert_eq!(marker(&end), Some(&json!(true)));
            assert_eq!(end["params"]["update"]["used"], 206);
        }
    }

    #[test]
    fn current_reply_tools_need_to_finish_before_a_fresh_usage_can_close_the_reply() {
        let mut replies = Replies::default();
        let start = Instant::now();
        let tool = |id, kind, status| {
            session_update(
                "s",
                json!({"sessionUpdate":kind,"toolCallId":id,"status":status}),
            )
        };
        replies.observe_request(&request("session/prompt", json!(3), "s"));
        replies.observe_response(&result(json!(3)));
        replies.observe_update(&chunk("s", "Checking first"), || start);
        replies.observe_update(&usage("s", 100), || start);
        for id in ["read-1", "read-2"] {
            replies.observe_update(&tool(id, "tool_call", "in_progress"), || start);
        }
        replies.observe_update(&tool("read-1", "tool_call_update", "completed"), || start);
        replies.observe_update(&usage("s", 105), || start);
        assert!(replies.take_completed(start + QUIET_WINDOW).is_none());

        replies.observe_update(&tool("read-2", "tool_call_update", "completed"), || start);
        replies.observe_update(&usage("s", 105), || start);
        assert!(replies.take_completed(start + QUIET_WINDOW).is_none());

        replies.observe_update(&usage("s", 110), || start);
        replies.observe_update(&tool("read-2", "tool_call_update", "completed"), || start);
        let end = replies.take_completed(start + QUIET_WINDOW).unwrap();
        assert_eq!(marker(&end), Some(&json!(true)));
        assert_eq!(end["params"]["update"]["used"], 110);
    }

    #[test]
    fn concurrent_sessions_and_same_session_prompts_keep_separate_boundaries() {
        let mut mapper = EventMapper::default();
        mapper.map_host(&mut request("session/prompt", json!(3), "first"));
        mapper.map_host(&mut request("session/prompt", json!("3"), "second"));
        mapper.map_host(&mut request("session/prompt", json!(4), "second"));
        unchanged(&mut mapper, result(json!(3)));
        unchanged(&mut mapper, result(json!("3")));
        unchanged(&mut mapper, chunk("first", "Late first-session reply"));
        unchanged(&mut mapper, chunk("second", "Second prompt still active"));
        unchanged(&mut mapper, usage("second", 2000));
        unchanged(&mut mapper, usage("first", 1000));
        let completed = complete(&mut mapper);
        assert_eq!(completed["params"]["sessionId"], "first");
        assert_eq!(marker(&completed), Some(&json!(true)));
        unchanged(&mut mapper, result(json!(4)));
        unchanged(&mut mapper, usage("second", 2001));
        assert_eq!(mapper.detached_reply_deadline(), None);
    }

    #[test]
    fn host_requests_and_prompt_errors_do_not_leave_an_old_completion_armed() {
        let mut mapper = EventMapper::default();
        unchanged(&mut mapper, chunk("s", "Initial transcript"));
        unchanged(&mut mapper, usage("s", 100));
        for (index, method) in [
            "session/load",
            "session/resume",
            "session/close",
            "session/prompt",
        ]
        .into_iter()
        .enumerate()
        {
            let mut mapper = EventMapper::default();
            let id = json!(index);
            mapper.map_host(&mut request("session/prompt", id.clone(), "s"));
            unchanged(&mut mapper, result(id));
            unchanged(&mut mapper, chunk("s", "Detached reply"));
            unchanged(&mut mapper, usage("s", 200));
            assert!(mapper.detached_reply_deadline().is_some());
            mapper.map_host(&mut request(method, json!(10 + index), "s"));
            unchanged(&mut mapper, chunk("s", "History or stopped content"));
            unchanged(&mut mapper, usage("s", 100));
            assert_eq!(mapper.detached_reply_deadline(), None);
        }
        mapper.map_host(&mut request("session/prompt", json!(20), "s"));
        mapper.map_host(
            &mut json!({"jsonrpc":"2.0","method":"$/cancel_request","params":{"requestId":20}}),
        );
        unchanged(&mut mapper, result(json!(20)));
        unchanged(&mut mapper, chunk("s", "Late update after cancellation"));
        unchanged(&mut mapper, usage("s", 100));

        mapper.map_host(&mut request("session/prompt", json!(21), "s"));
        unchanged(
            &mut mapper,
            json!({"jsonrpc":"2.0","id":21,"error":{"code":-32603,"message":"Request failed"}}),
        );
        unchanged(&mut mapper, chunk("s", "Late update after error"));
        unchanged(&mut mapper, usage("s", 100));
        assert_eq!(mapper.detached_reply_deadline(), None);
    }

    #[test]
    fn cancelling_a_detached_reply_finishes_it_even_if_native_updates_follow() {
        let mut mapper = EventMapper::default();
        mapper.map_host(&mut request("session/prompt", json!(3), "s"));
        unchanged(&mut mapper, result(json!(3)));
        unchanged(&mut mapper, chunk("s", "Detached reply"));
        unchanged(&mut mapper, usage("s", 200));
        let original = mapper.detached_reply_deadline().unwrap();
        mapper.map_host(&mut request("session/cancel", Value::Null, "s"));
        unchanged(&mut mapper, chunk("s", "Trailing reply"));
        let deadline = mapper.detached_reply_deadline().unwrap();
        assert!(deadline < original);
        let end = mapper.take_completed_detached_reply(deadline).unwrap();
        assert_eq!(marker(&end), Some(&json!(true)));
        unchanged(&mut mapper, chunk("s", "Late chunk after cancel"));
        unchanged(&mut mapper, usage("s", 201));
        assert_eq!(mapper.detached_reply_deadline(), None);
    }
}
