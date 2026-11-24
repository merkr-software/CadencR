//! Translate Antigravity's tool payloads at the ACP boundary.
//!
//! Standard session notifications and responses retain their original order
//! and identifiers. The relay owns transport and session configuration.

mod detached;
mod mcp;
mod permissions;
mod questions;
mod receipts;
mod subagents;
mod tools;
mod working;

use std::collections::HashMap;
use std::path::PathBuf;

use serde_json::{json, Value};
use tokio::time::Instant;

use self::questions::Question;
pub(crate) use self::receipts::{ObservedUserInput, ReceiptOperation, ReceiptTracker};
pub(crate) use self::subagents::{native_brain, SubagentOperation, SubagentTracker};

#[derive(Default)]
pub(crate) struct EventMapper {
    detached: detached::Replies,
    working: working::Working,
    mcp: mcp::SessionServers,
    questions: HashMap<String, Question>,
    receipts: receipts::PromptReceipts,
    subagents: subagents::Subagents,
}

impl EventMapper {
    pub(crate) fn new(brain: Option<PathBuf>) -> Self {
        Self {
            receipts: receipts::PromptReceipts::with_brain(brain),
            ..Self::default()
        }
    }

    pub(crate) fn map_agent(&mut self, message: &mut Value) {
        match message.get("method").and_then(Value::as_str) {
            Some("session/update") => {
                self.subagents.observe_update(message);
                self.receipts.observe_update(message);
                if !self.working.observe_update(message) {
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
                self.receipts.observe_response(message);
                match self.detached.observe_response(message) {
                    Some(detached::PromptEnd::Completed(ended)) => {
                        self.working
                            .end_prompt(&ended, message.get_mut("result"), true);
                    }
                    Some(detached::PromptEnd::Interrupted(ended)) => {
                        self.interrupt_request(&ended, message.get_mut("result"));
                    }
                    None => {}
                }
            }
            _ => {}
        }
    }

    pub(crate) fn map_host(&mut self, message: &mut Value) {
        self.subagents.observe_request(message);
        self.receipts.observe_request(message);
        if message["method"] == "$/cancel_request" {
            if let Some(ended) = message
                .pointer("/params/requestId")
                .and_then(|id| self.detached.remove_prompt(id))
            {
                self.interrupt_request(&ended, None);
            }
        } else {
            let generation = self.detached.observe_request(message);
            self.working.observe_request(message, generation);
        }
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

    fn interrupt_request(&mut self, ended: &detached::EndedPrompt, result: Option<&mut Value>) {
        if self.working.end_prompt(ended, result, false) {
            self.detached.allow_detached(&ended.session);
        }
    }

    pub(crate) fn take_subagent_operations(&mut self) -> Vec<SubagentOperation> {
        self.subagents.take_operations()
    }

    pub(crate) fn take_receipt_operations(&mut self) -> Vec<ReceiptOperation> {
        self.receipts.take_operations()
    }

    pub(crate) fn observe_user_input(&mut self, input: ObservedUserInput) -> Option<Value> {
        self.receipts.observe_user_input(input)
    }

    pub(crate) fn can_forward_subagent(&self, frame: &Value) -> bool {
        self.subagents.can_forward(frame)
    }

    pub(crate) fn detached_reply_deadline(&self) -> Option<Instant> {
        self.detached.next_deadline()
    }

    pub(crate) fn next_deadline(&self) -> Option<Instant> {
        self.detached_reply_deadline()
            .into_iter()
            .chain(self.working.wake_deadline(&self.detached))
            .min()
    }

    pub(crate) fn take_completed_detached_reply(&mut self, now: Instant) -> Option<Value> {
        let mut frame = self.detached.take_completed(now)?;
        let session = frame.pointer("/params/sessionId")?.as_str()?.to_owned();
        self.working
            .decorate_boundary(&session, &mut frame["params"]["update"]);
        Some(frame)
    }

    pub(crate) fn take_finished_work(&mut self) -> Option<Value> {
        self.working.take_finished(&self.detached, Instant::now())
    }

    pub(crate) fn has_work_release(&self) -> bool {
        self.working.has_releases(&self.detached)
    }

    pub(crate) fn observe_child(&mut self, frame: &mut Value) {
        let parent_acted = frame
            .as_object_mut()
            .and_then(|object| object.remove(subagents::PARENT_ACTED))
            .is_some_and(|value| value == Value::Bool(true));
        self.working.observe_child(frame, parent_acted);
        let names = self.mcp.for_params(frame.get("params"));
        if let Some(update) = frame.pointer_mut("/params/update") {
            // Nested launches remain child actions, not additional root agent cards.
            if !update
                .as_object()
                .and_then(tools::call_name)
                .is_some_and(tools::is_subagent_launch)
            {
                tools::normalize_update(update, names);
            }
        }
    }

    pub(crate) fn forget_child(&mut self, session: &str, carrier: &str) {
        self.working.forget_child(session, carrier);
    }

    fn map_permission(&mut self, message: &mut Value) {
        let id = request_id(message.get("id"));
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

fn request_id(id: Option<&Value>) -> Option<String> {
    id.filter(|id| id.is_string() || id.is_number())
        .map(Value::to_string)
}

fn validated_session_id(message: &Value) -> Option<&str> {
    message
        .pointer("/params/sessionId")
        .and_then(Value::as_str)
        .filter(|id| subagents::uuid_segment(id))
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
    fn aborted_prompts_discard_current_commands_and_preserve_earlier_background_work() {
        let prompt = |id| json!({"id":id,"method":"session/prompt","params":{"sessionId":"root"}});
        let command = |id, status| {
            session_update(
                "root",
                json!({
                    "sessionUpdate":if status == "completed" { "tool_call_update" } else { "tool_call" },
                    "toolCallId":id, "name":"run_command","status":status
                }),
            )
        };
        for ending in [
            json!({"id":2,"error":{"code":-32603,"message":"failed"}}),
            json!({"id":2,"result":{"stopReason":"max_tokens"}}),
            json!({"id":2,"result":{"stopReason":"cancelled"}}),
            json!({"method":"$/cancel_request","params":{"requestId":2}}),
        ] {
            for settled_before_error in [true, false] {
                let mut mapper = EventMapper::default();
                mapper.map_host(&mut prompt(1));
                mapper.map_agent(&mut command("previous", "in_progress"));
                let mut boundary = json!({"id":1, "result":{"stopReason":"end_turn"}});
                mapper.map_agent(&mut boundary);
                assert_eq!(
                    boundary["result"]["_meta"]["cadencr"]["backgroundWorkPending"],
                    true
                );
                mapper.map_host(&mut prompt(2));
                if settled_before_error {
                    mapper.map_agent(&mut command("previous", "completed"));
                    assert!(mapper.take_finished_work().is_none());
                }
                mapper.map_agent(&mut command("interrupted", "in_progress"));
                let mut frame = ending.clone();
                if frame["method"] == "$/cancel_request" {
                    mapper.map_host(&mut frame);
                } else {
                    mapper.map_agent(&mut frame);
                }
                if frame.get("result").is_some() {
                    assert_eq!(
                        frame["result"]["stopReason"],
                        ending["result"]["stopReason"]
                    );
                    assert_eq!(
                        frame["result"]["_meta"]["cadencr"]["backgroundWorkPending"],
                        true
                    );
                } else {
                    assert_eq!(ending, frame);
                }
                if !settled_before_error {
                    assert!(mapper.take_finished_work().is_none());
                    mapper.map_agent(&mut command("previous", "completed"));
                }
                // Rejection cannot consume the earlier command's promised wake.
                assert!(mapper.take_finished_work().is_none());
                mapper.map_agent(&mut session_update("root", json!({"sessionUpdate":"agent_message_chunk","content":{"type":"text","text":"The prior task finished."}})));
                mapper.map_agent(&mut session_update(
                    "root",
                    json!({"sessionUpdate":"usage_update","used":17,"size":1024}),
                ));
                let release = mapper
                    .take_completed_detached_reply(mapper.detached_reply_deadline().unwrap())
                    .unwrap();
                assert_eq!(
                    release["params"]["update"]["_meta"]["cadencr"]["backgroundWorkPending"],
                    false
                );
                assert!(mapper.take_finished_work().is_none());
                mapper.map_host(&mut prompt(3));
                let mut next = json!({"id":3,"result":{"stopReason":"end_turn"}});
                mapper.map_agent(&mut next);
                assert!(next["result"].get("_meta").is_none());
            }
        }
    }

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
