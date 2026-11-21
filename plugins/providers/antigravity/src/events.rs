//! Translate Antigravity's tool payloads at the ACP boundary.
//!
//! Standard session notifications and responses retain their original order
//! and identifiers. The relay owns transport and session configuration.

mod detached;
mod mcp;
mod permissions;
mod questions;
mod tools;

use std::collections::HashMap;

use serde_json::Value;

use self::questions::Question;

#[derive(Default)]
pub(crate) struct EventMapper {
    detached: detached::Replies,
    mcp: mcp::SessionServers,
    questions: HashMap<String, Question>,
}

impl EventMapper {
    pub(crate) fn map_agent(&mut self, message: &mut Value) {
        match message.get("method").and_then(Value::as_str) {
            Some("session/update") => {
                self.detached.decorate_update(message);
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
                self.detached.observe_response(message);
                self.mcp.observe_response(message);
            }
            _ => {}
        }
    }

    pub(crate) fn map_host(&mut self, message: &mut Value) {
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
