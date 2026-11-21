//! After finishing a prompt, agy can wake to stream another reply (for
//! example, when a subagent finishes). Its closing usage snapshot has no
//! corresponding prompt response to signal that the UI can go idle.

use std::collections::HashMap;

use cadencr_provider_sdk::meta::{merge_meta, CADENCR_META_KEY};
use serde_json::{json, Value};

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

enum Reply {
    AwaitingContent,
    Streaming,
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
            Some("session/cancel" | "session/close") => self.clear(session),
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

    pub(super) fn observe_response(&mut self, message: &Value) {
        let Some(PendingRequest::Prompt(session)) = message
            .get("id")
            .and_then(|id| self.requests.remove(&id.to_string()))
        else {
            return;
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
            self.post_turn.insert(session, Reply::AwaitingContent);
        }
    }

    pub(super) fn decorate_update(&mut self, message: &mut Value) {
        let Some(reply) = message
            .pointer("/params/sessionId")
            .and_then(Value::as_str)
            .and_then(|session| self.post_turn.get_mut(session))
        else {
            return;
        };
        let Some(update) = message.pointer_mut("/params/update") else {
            return;
        };
        match update.get("sessionUpdate").and_then(Value::as_str) {
            Some("agent_message_chunk" | "agent_thought_chunk") if has_text(update) => {
                *reply = Reply::Streaming;
            }
            Some("usage_update")
                if matches!(reply, Reply::Streaming)
                    && update.get("used").and_then(Value::as_u64).is_some()
                    && update.get("size").and_then(Value::as_u64).is_some() =>
            {
                if let Some(update) = update.as_object_mut() {
                    let meta = [(
                        CADENCR_META_KEY.to_owned(),
                        json!({"detachedReplyEnded":true}),
                    )]
                    .into_iter()
                    .collect();
                    merge_meta(update, meta);
                }
                *reply = Reply::AwaitingContent;
            }
            _ => {}
        }
    }

    fn clear(&mut self, session: &str) {
        self.post_turn.remove(session);
        self.requests
            .retain(|_, request| request.session() != session);
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

    fn update(session: &str, body: Value) -> Value {
        json!({"jsonrpc":"2.0","method":"session/update","params":{"sessionId":session,"update":body}})
    }

    fn chunk(session: &str, text: &str) -> Value {
        update(
            session,
            json!({"sessionUpdate":"agent_message_chunk","content":{"type":"text","text":text}}),
        )
    }

    fn usage(session: &str, used: u64) -> Value {
        update(
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

    #[test]
    fn marks_the_native_usage_after_a_late_reply_without_synthesizing_a_turn_result() {
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
        let mut expected = native.clone();
        expected["params"]["update"]["_meta"]["cadencr"]["detachedReplyEnded"] = json!(true);
        let mut mapped = native.clone();
        mapper.map_agent(&mut mapped);
        assert_eq!(mapped, expected);
        unchanged(&mut mapper, native);

        unchanged(&mut mapper, chunk("s", "Another detached reply"));
        let mut next = usage("s", 10600);
        mapper.map_agent(&mut next);
        assert_eq!(marker(&next), Some(&json!(true)));
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
        let mut first = usage("first", 1000);
        mapper.map_agent(&mut first);
        assert_eq!(marker(&first), Some(&json!(true)));
        unchanged(&mut mapper, result(json!(4)));
        unchanged(&mut mapper, usage("second", 2001));
    }

    #[test]
    fn restore_close_cancel_and_prompt_errors_do_not_trigger_a_boundary() {
        let mut mapper = EventMapper::default();
        unchanged(&mut mapper, chunk("s", "Initial transcript"));
        unchanged(&mut mapper, usage("s", 100));
        for (index, method) in [
            "session/load",
            "session/resume",
            "session/close",
            "session/cancel",
        ]
        .into_iter()
        .enumerate()
        {
            let id = json!(index);
            mapper.map_host(&mut request("session/prompt", id.clone(), "s"));
            unchanged(&mut mapper, result(id));
            mapper.map_host(&mut request(method, json!(10 + index), "s"));
            unchanged(&mut mapper, chunk("s", "History or stopped content"));
            unchanged(&mut mapper, usage("s", 100));
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
    }
}
