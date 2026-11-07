use serde_json::{json, Value};

use super::event_items::stream_start_event;
use super::event_json::thread_id;
use super::event_state::IndexState;
use super::event_system::permission_request_event;
use super::server_request_method::CodexServerRequestMethod;
use crate::domain::agents::adapter::{
    RuntimeContentBlock, RuntimeError, RuntimeEvent, RuntimePermissionDecision,
    RuntimePermissionResponse,
};
use crate::domain::ws_session::question_answers::{
    extract_answer_lists, format_answers_plain_text,
};

mod queue;
pub(super) use queue::PendingAsyncQuestions;
const REQUEST_PREFIX: &str = "codex_async_question_";

pub(super) fn is_async_question(request_id: &str) -> bool {
    request_id.starts_with(REQUEST_PREFIX)
}

// Codex 0.164 emits request_user_input_async as agentMessage.questions,
// not as an item/tool/requestUserInput server request. Replies are ordinary
// user input: turn/steer while working, turn/start after completion.
pub(super) fn question_events(
    params: &Value,
    completed: bool,
    indexes: &mut IndexState,
) -> Vec<RuntimeEvent> {
    if !completed {
        return Vec::new();
    }
    let Some(item) = params.get("item") else {
        return Vec::new();
    };
    let Some(item_id) = item.get("id").and_then(Value::as_str) else {
        return Vec::new();
    };
    let Some(questions) = item.get("questions").and_then(Value::as_array) else {
        return Vec::new();
    };
    let questions: Vec<Value> = questions
        .iter()
        .filter_map(|question| {
            let title = question.get("title")?.as_str()?.trim();
            if title.is_empty() {
                return None;
            }
            Some(json!({ "question": title, "options": question.get("options") }))
        })
        .collect();
    if questions.is_empty() {
        return Vec::new();
    }
    let id = format!("{REQUEST_PREFIX}{item_id}");
    if indexes.has_index(&id) {
        return Vec::new();
    }
    let sid = thread_id(params);
    let input = json!({ "questions": questions });
    vec![
        stream_start_event(
            sid,
            indexes.index_for(&id),
            RuntimeContentBlock::ToolUse {
                id: id.clone(),
                name: "AskUserQuestion".into(),
                input: input.clone(),
            },
        ),
        permission_request_event(
            &json!(id),
            CodexServerRequestMethod::ToolUserInput,
            &json!({"threadId": sid, "itemId": id, "questions": input["questions"]}),
        ),
    ]
}

pub(super) fn request_id(event: &RuntimeEvent) -> Option<&str> {
    let raw = event.raw_json();
    if raw.get("type")?.as_str()? != "codex_permission_request" {
        return None;
    }
    raw.get("request_id")?
        .as_str()
        .filter(|id| is_async_question(id))
}

pub(super) fn answer_prompt(
    input: &Value,
    response: &RuntimePermissionResponse,
) -> Result<String, RuntimeError> {
    if response.decision == RuntimePermissionDecision::Deny {
        return Ok("The user dismissed the question without answering.".into());
    }
    let answers = response
        .updated_input
        .as_ref()
        .and_then(|input| input.get("answers"))
        .ok_or_else(|| RuntimeError::new("Missing answers for Codex question"))?;
    let mut input = input.clone();
    input["answers"] = answers.clone();
    let groups = extract_answer_lists(&input)
        .ok_or_else(|| RuntimeError::new("Invalid answers for Codex question"))?;
    let question_count = input["questions"].as_array().map_or(0, Vec::len);
    if groups.len() != question_count
        || groups.is_empty()
        || groups
            .iter()
            .any(|group| group.is_empty() || group.iter().any(|answer| answer.trim().is_empty()))
    {
        return Err(RuntimeError::new(
            "Every Codex question requires a non-empty answer",
        ));
    }
    format_answers_plain_text(&input)
        .ok_or_else(|| RuntimeError::new("Invalid answers for Codex question"))
}

#[cfg(test)]
mod tests {
    use super::super::events::notification_events;
    use super::*;

    #[test]
    fn completed_questions_create_one_canonical_form_and_pending_request() {
        let params = json!({"threadId":"thread", "item": {
            "id":"message", "type":"agentMessage", "text":"", "questions":[
                {"title":"Color?", "options":["Blue", "Green"]},
                {"title":"Why?"}
            ]
        }});
        let mut indexes = IndexState::default();
        assert!(question_events(&params, false, &mut indexes).is_empty());
        let events = notification_events("item/completed", params.clone(), None, &mut indexes);
        let pending = &events[1];
        let id = request_id(pending).unwrap();
        let input = &pending.raw_json()["tool_input"];
        assert_eq!(id, "codex_async_question_message");
        assert_eq!(events.len(), 2);
        assert_eq!(input["threadId"], "thread");
        assert_eq!(input["questions"][0]["question"], "Color?");
        assert_eq!(input["questions"][0]["options"], json!(["Blue", "Green"]));
        assert_eq!(input["questions"][1]["question"], "Why?");
        assert!(question_events(&params, true, &mut indexes).is_empty());
    }

    #[test]
    fn ordinary_messages_and_empty_questions_do_not_create_forms() {
        for questions in [Value::Null, json!([]), json!([{"title":" "}])] {
            let params = json!({"item":{"id":"message", "questions":questions}});
            assert!(question_events(&params, true, &mut IndexState::default()).is_empty());
        }
    }

    #[test]
    fn raw_acknowledgment_does_not_complete_the_question() {
        let mut indexes = IndexState::default();
        let call = json!({"threadId":"thread", "item":{
            "type":"function_call", "call_id":"call", "name":"request_user_input_async",
            "arguments":"{\"questions\":[{\"title\":\"Color?\"}]}"
        }});
        assert!(
            notification_events("rawResponseItem/completed", call, None, &mut indexes).is_empty()
        );
        let result = json!({"threadId":"thread", "item":{
            "type":"function_call_output", "call_id":"call", "output":"{\"accepted\":true}"
        }});
        assert!(
            notification_events("rawResponseItem/completed", result, None, &mut indexes).is_empty()
        );
    }

    #[test]
    fn namespaced_external_tools_are_not_suppressed_as_native_questions() {
        let events = notification_events(
            "rawResponseItem/completed",
            json!({
                "threadId":"thread", "item":{
                    "type":"function_call", "call_id":"external",
                    "namespace":"mcp__external", "name":"request_user_input_async", "arguments":"{}"
                }
            }),
            None,
            &mut IndexState::default(),
        );
        assert_eq!(events.len(), 1);
        assert!(events[0].stream_event().is_some());
        assert!(request_id(&events[0]).is_none());
    }

    #[test]
    fn malformed_or_incomplete_answers_are_rejected() {
        let input = json!({"questions":[{"question":"Color?"}]});
        for answers in [
            json!([null]),
            json!([[]]),
            json!([""]),
            json!(["  "]),
            json!([]),
            json!({}),
            json!(["Blue", "Extra"]),
            json!({"Color?":null}),
        ] {
            let response = RuntimePermissionResponse {
                request_id: "question".into(),
                decision: RuntimePermissionDecision::AllowOnce,
                option_id: None,
                feedback: None,
                updated_input: Some(json!({"answers":answers})),
            };
            assert!(answer_prompt(&input, &response).is_err(), "{answers}");
        }
    }

    #[test]
    fn answers_preserve_question_order_and_free_text() {
        let input = json!({"questions":[{"question":"Color?"},{"question":"Why?"}]});
        let mut response = RuntimePermissionResponse {
            request_id: "question".into(),
            decision: RuntimePermissionDecision::AllowOnce,
            option_id: None,
            feedback: None,
            updated_input: Some(json!({"answers":{"Why?":"My preference", "Color?":"Green"}})),
        };
        assert_eq!(
            answer_prompt(&input, &response).unwrap(),
            "Color?\nAnswer: Green\n\nWhy?\nAnswer: My preference"
        );
        response.updated_input = Some(json!({"answers":[["Blue"],["Other reason"]]}));
        assert_eq!(
            answer_prompt(&input, &response).unwrap(),
            "Color?\nAnswer: Blue\n\nWhy?\nAnswer: Other reason"
        );
        response.updated_input = None;
        assert!(answer_prompt(&input, &response).is_err());
        response.decision = RuntimePermissionDecision::Deny;
        assert!(answer_prompt(&input, &response)
            .unwrap()
            .contains("without answering"));
    }
}
