//! Translate Antigravity's tool payloads at the ACP boundary.
//!
//! Standard session notifications and responses retain their original order
//! and identifiers. The relay owns transport and session configuration.

mod detached;
mod mcp;
mod permissions;
mod questions;
mod subagents;
mod tools;
mod working;

use std::collections::HashMap;

use serde_json::{json, Value};
use tokio::time::Instant;

use self::questions::Question;
pub(crate) use self::subagents::{SubagentOperation, SubagentTracker};

#[derive(Default)]
pub(crate) struct EventMapper {
    detached: detached::Replies,
    working: working::Working,
    mcp: mcp::SessionServers,
    questions: HashMap<String, Question>,
    subagents: subagents::Subagents,
}

impl EventMapper {
    pub(crate) fn map_agent(&mut self, message: &mut Value) {
        match message.get("method").and_then(Value::as_str) {
            Some("session/update") => {
                self.subagents.observe_update(message);
                if !self.working.observe_tool(message) {
                    self.detached.observe_update(message, Instant::now);
                }
                let names = self.mcp.for_params(message.get("params"));
                if let Some(update) = message.pointer_mut("/params/update") {
                    tools::normalize_update(update, names);
                }
            }
            Some("session/request_permission") => self.map_permission(message),
            Some("$/cancel_request") => {
                if let Some(id) = message.pointer("/params/requestId") {
                    self.questions.remove(&id.to_string());
                }
            }
            None => {
                self.mcp.observe_response(message);
                if let Some(session) = self.detached.observe_response(message) {
                    self.working
                        .decorate_boundary(&session, &mut message["result"]);
                }
            }
            _ => {}
        }
    }

    pub(crate) fn map_host(&mut self, message: &mut Value) {
        self.working.observe_request(message);
        self.subagents.observe_request(message);
        self.detached.observe_request(message);
        self.mcp.observe_request(message);
        if message.get("method").is_none() {
            let question = message
                .get("id")
                .and_then(|id| self.questions.remove(&id.to_string()));
            if let (Some(question), Some(result)) = (question, message.get_mut("result")) {
                *result = question.native_response(result);
            }
        }
    }

    pub(crate) fn take_subagent_operations(&mut self) -> Vec<SubagentOperation> {
        self.subagents.take_operations()
    }

    pub(crate) fn can_forward_subagent(&self, frame: &Value) -> bool {
        self.subagents.can_forward(frame)
    }

    pub(crate) fn detached_reply_deadline(&self) -> Option<Instant> {
        self.detached.next_deadline()
    }

    pub(crate) fn take_completed_detached_reply(&mut self, now: Instant) -> Option<Value> {
        let mut frame = self.detached.take_completed(now)?;
        let session = frame.pointer("/params/sessionId")?.as_str()?.to_owned();
        self.working
            .decorate_boundary(&session, &mut frame["params"]["update"]);
        Some(frame)
    }

    pub(crate) fn take_finished_work(&mut self) -> Option<Value> {
        self.working.take_finished(&self.detached)
    }

    pub(crate) fn has_work_release(&self) -> bool {
        self.working.has_releases()
    }

    pub(crate) fn observe_child(&mut self, frame: &Value) {
        self.working.observe_child(frame);
    }

    pub(crate) fn forget_child(&mut self, session: &str, carrier: &str) {
        self.working.forget_child(session, carrier);
    }

    fn map_permission(&mut self, message: &mut Value) {
        let id = message
            .get("id")
            .filter(|id| id.is_string() || id.is_number())
            .map(Value::to_string);
        let Some(params) = message.get_mut("params") else {
            return;
        };
        if let (Some(id), Some(question)) = (id, Question::from_permission(params)) {
            question.rewrite_permission(params);
            self.questions.insert(id, question);
        } else {
            let names = self.mcp.for_params(Some(params));
            if let Some(call) = params.get_mut("toolCall") {
                tools::normalize_permission(call, names);
            }
            permissions::display_security_warnings(params);
        }
    }
}

fn is_terminal_tool_status(status: Option<&str>) -> bool {
    matches!(status, Some("completed" | "failed" | "cancelled"))
}

fn session_update(session: &str, update: Value) -> Value {
    json!({"jsonrpc":"2.0","method":"session/update","params":{"sessionId":session,"update":update}})
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    #[test]
    fn native_text_plan_usage_and_unknown_events_pass_through() {
        let mut mapper = EventMapper::default();
        for update in [
            json!({"sessionUpdate":"agent_message_chunk","content":{"type":"text","text":"hello"}}),
            json!({"sessionUpdate":"agent_thought_chunk","content":{"type":"text","text":"thought"}}),
            json!({"sessionUpdate":"usage_update","used":10,"size":100}),
            json!({"sessionUpdate":"plan","entries":[{"content":"Check","priority":"high","status":"pending"}]}),
            json!({"sessionUpdate":"_future","opaque":[1,2]}),
        ] {
            let frame = json!({"jsonrpc":"2.0","method":"session/update","params":{"sessionId":"s","update":update}});
            let mut mapped = frame.clone();
            mapper.map_agent(&mut mapped);
            assert_eq!(mapped, frame);
        }
        let response = json!({"jsonrpc":"2.0","id":"r","error":{"code":-32603,"message":"Failed to start","data":{"detail":1}}});
        let mut mapped = response.clone();
        mapper.map_agent(&mut mapped);
        assert_eq!(mapped, response);
    }

    #[test]
    fn ordinary_permissions_keep_the_native_request_id_and_choices() {
        let mut mapper = EventMapper::default();
        let request = json!({
            "jsonrpc":"2.0","id":"1","method":"session/request_permission","params":{
                "sessionId":"s","toolCall":{"name":"run_command","toolCallId":"call_1","status":"pending","rawInput":{"CommandLine":"printf fixture"}},
                "options":[{"kind":"allow_once","optionId":"allow","name":"Allow"},{"kind":"reject_once","optionId":"deny","name":"Deny"}]
            }
        });
        let mut mapped = request.clone();
        mapper.map_agent(&mut mapped);
        assert_eq!(mapped["id"], request["id"]);
        assert_eq!(mapped["params"]["options"], request["params"]["options"]);
        assert_eq!(mapped["params"]["toolCall"]["toolCallId"], "call_1");
        assert_eq!(mapped["params"]["toolCall"]["name"], "Bash");
        assert_eq!(
            mapped["params"]["toolCall"]["rawInput"]["command"],
            "printf fixture"
        );

        let reply = json!({"jsonrpc":"2.0","id":"1","result":{"outcome":{"outcome":"selected","optionId":"deny"}}});
        let mut mapped = reply.clone();
        mapper.map_host(&mut mapped);
        assert_eq!(mapped, reply);
    }

    #[test]
    fn only_a_real_permission_creates_a_fixed_choice_question() {
        let mut mapper = EventMapper::default();
        let notification = json!({"jsonrpc":"2.0","method":"session/update","params":{"sessionId":"s","update":{
            "sessionUpdate":"tool_call_update","toolCallId":"call_1","name":"ask_question",
            "title":"Run ask_question","status":"pending",
            "rawInput":{"questions":[{"question":"Color?","options":["Red","Blue"],"is_multi_select":false}]}
        }}});
        let mut mapped = notification.clone();
        mapper.map_agent(&mut mapped);
        assert_eq!(mapped, notification);

        let mut request = json!({"jsonrpc":"2.0","id":"1","method":"session/request_permission","params":{
            "sessionId":"s","toolCall":{"toolCallId":"interaction_1","title":"Color?","status":"pending"},
            "options":[{"kind":"allow_once","optionId":"r","name":"Red"},{"kind":"allow_once","optionId":"b","name":"Blue"}]
        }});
        mapper.map_agent(&mut request);
        assert_eq!(request["params"]["toolCall"]["name"], "AskUserQuestion");
        assert_eq!(
            request.pointer("/params/toolCall/rawInput/questions/0/allowCustomAnswer"),
            Some(&json!(false))
        );
        let unrelated = json!({"jsonrpc":"2.0","id":1,"result":{}});
        let mut mapped = unrelated.clone();
        mapper.map_host(&mut mapped);
        assert_eq!(mapped, unrelated);

        let mut response = json!({"jsonrpc":"2.0","id":"1","result":{
            "outcome":{"outcome":"selected","optionId":"r"},
            "_meta":{"updatedInput":{"structured_answers":[{"questionId":"interaction_1","selectedOptionIds":["b"]}]}}
        }});
        mapper.map_host(&mut response);
        assert_eq!(
            response,
            json!({"jsonrpc":"2.0","id":"1","result":{"outcome":{"outcome":"selected","optionId":"b"}}})
        );
    }
}
