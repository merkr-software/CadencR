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
    generation: u64,
    requests: HashMap<String, PendingRequest>,
    post_turn: HashMap<String, Reply>,
}

pub(super) enum PromptEnd {
    Completed(EndedPrompt),
    Interrupted(EndedPrompt),
}

pub(super) struct EndedPrompt {
    pub(super) session: String,
    pub(super) generation: u64,
    pub(super) remaining: Option<u64>,
}

enum PendingRequest {
    Prompt(String, u64),
    Restore(String),
}

impl PendingRequest {
    fn session(&self) -> &str {
        match self {
            Self::Prompt(session, _) | Self::Restore(session) => session,
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
    cancelled: bool,
}

impl Replies {
    pub(super) fn observe_request(&mut self, message: &Value) -> Option<u64> {
        let method = message.get("method").and_then(Value::as_str);
        let session = message.pointer("/params/sessionId")?.as_str()?;
        match method {
            Some("session/cancel") => {
                if self.active_prompt(session).is_none() {
                    if let Some(reply) = self.post_turn.get_mut(session) {
                        if !matches!(reply.phase, Phase::AwaitingContent) {
                            reply.phase = Phase::Closing(Completion {
                                cancelled: true,
                                deadline: Instant::now(),
                            });
                            return None;
                        }
                    }
                }
                self.clear(session);
            }
            Some("session/close") => self.clear(session),
            Some("session/prompt" | "session/load" | "session/resume") => {
                let id = message
                    .get("id")
                    .filter(|id| id.is_string() || id.is_number())?;
                if method == Some("session/prompt") {
                    if self.active_prompt(session).is_none() {
                        self.post_turn.remove(session);
                    }
                    self.generation += 1;
                    self.requests.insert(
                        id.to_string(),
                        PendingRequest::Prompt(session.to_owned(), self.generation),
                    );
                    return Some(self.generation);
                }
                self.clear(session);
                self.requests
                    .insert(id.to_string(), PendingRequest::Restore(session.to_owned()));
            }
            _ => {}
        }
        None
    }

    fn active_prompt(&self, session: &str) -> Option<u64> {
        self.requests
            .values()
            .filter_map(|request| match request {
                PendingRequest::Prompt(id, generation) if id == session => Some(*generation),
                _ => None,
            })
            .max()
    }

    pub(super) fn remove_prompt(&mut self, id: &Value) -> Option<EndedPrompt> {
        let PendingRequest::Prompt(session, generation) = self.requests.remove(&id.to_string())?
        else {
            return None;
        };
        let remaining = self.active_prompt(&session);
        Some(EndedPrompt {
            session,
            generation,
            remaining,
        })
    }

    pub(super) fn allow_detached(&mut self, session: &str) {
        self.post_turn.entry(session.to_owned()).or_default();
    }

    pub(super) fn observe_response(&mut self, message: &Value) -> Option<PromptEnd> {
        let ended = self.remove_prompt(message.get("id")?)?;
        if message
            .pointer("/result/stopReason")
            .and_then(Value::as_str)
            == Some("end_turn")
        {
            self.allow_detached(&ended.session);
            Some(PromptEnd::Completed(ended))
        } else {
            Some(PromptEnd::Interrupted(ended))
        }
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
        let Some(session) = message.pointer("/params/sessionId").and_then(Value::as_str) else {
            return;
        };
        // A successful overlapping RPC permits a future wake. Its sibling's
        // stream is still part of a host prompt until that sibling settles.
        if !self.post_turn.contains_key(session) || self.active_prompt(session).is_some() {
            return;
        }
        let Some(reply) = self.post_turn.get_mut(session) else {
            return;
        };
        if matches!(&reply.phase, Phase::Closing(completion) if completion.cancelled) {
            return;
        }
        let Some(update) = message.pointer("/params/update") else {
            return;
        };
        match update.get("sessionUpdate").and_then(Value::as_str) {
            _ if is_model_content(update) => {
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
            let Phase::Closing(completion) = &reply.phase else {
                return None;
            };
            if completion.deadline > now {
                return None;
            }
            let mut update = match reply.last_usage {
                Some(usage) => {
                    json!({"sessionUpdate":"usage_update","used":usage.used,"size":usage.size})
                }
                None => json!({"sessionUpdate":"session_info_update"}),
            };
            update["_meta"] = json!({"cadencr":{"detachedReplyEnded":true}});
            let frame = session_update(session, update);
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
            cancelled: false,
        });
    }
}

pub(super) fn is_model_content(update: &Value) -> bool {
    matches!(
        update["sessionUpdate"].as_str(),
        Some("agent_message_chunk" | "agent_thought_chunk")
    ) && update.pointer("/content/type").and_then(Value::as_str) == Some("text")
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
    fn stop_before_the_first_usage_ends_the_wake_without_inventing_a_budget() {
        let mut mapper = EventMapper::default();
        mapper.map_host(&mut request("session/prompt", json!(3), "s"));
        unchanged(&mut mapper, result(json!(3)));
        unchanged(&mut mapper, chunk("s", "Detached reply"));
        mapper.map_host(&mut request("session/cancel", Value::Null, "s"));
        let end = mapper
            .take_completed_detached_reply(mapper.detached_reply_deadline().unwrap())
            .unwrap();
        assert_eq!(
            end["params"]["update"],
            json!({"sessionUpdate":"session_info_update",
            "_meta":{"cadencr":{"detachedReplyEnded":true}}})
        );
        assert!(mapper.next_deadline().is_none());
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
