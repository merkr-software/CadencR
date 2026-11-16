//! `cursor/ask_question` ⇄ Cadencr's `AskUserQuestion` drawer.
//!
//! Cadencr answers the connector's `session/request_permission` with the
//! drawer's updated input in `_meta.updatedInput`:
//! `{answers: {<question text>: "<label>, <label>"}, structured_answers:
//! [{selectedOptionIds: [...]}]}`. This module maps that back onto Cursor's
//! `answered` / `skipped` / `cancelled` schema.

use serde_json::{json, Map, Value};

use super::HostDecision;

pub const SUBMIT_OPTION_ID: &str = "submit";
const FREEFORM_OPTION_ID: &str = "__freeform_other__";

pub fn tool_input(params: &Value) -> Value {
    let questions = params
        .get("questions")
        .and_then(Value::as_array)
        .map(|questions| questions.iter().map(question_input).collect::<Vec<_>>())
        .unwrap_or_default();
    json!({ "questions": questions, "title": params.get("title") })
}

pub fn title(params: &Value) -> String {
    params
        .get("title")
        .and_then(Value::as_str)
        .filter(|title| !title.trim().is_empty())
        .unwrap_or("Question")
        .to_string()
}

fn question_input(question: &Value) -> Value {
    let options = question
        .get("options")
        .and_then(Value::as_array)
        .map(|options| {
            options
                .iter()
                .map(|option| {
                    json!({
                        "label": option.get("label").and_then(Value::as_str).unwrap_or(""),
                        "id": option.get("id"),
                    })
                })
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();
    json!({
        "question": question.get("prompt").and_then(Value::as_str).unwrap_or(""),
        "id": question.get("id"),
        "options": options,
        "multiSelect": question.get("allowMultiple").and_then(Value::as_bool).unwrap_or(false),
    })
}

pub fn response(params: &Value, decision: &HostDecision) -> Value {
    if !decision.approved {
        // Cursor's docs mention `cancelled`; an interactive Reject maps to
        // `skipped` with an optional reason so Composer can continue.
        let explicit_cancel = decision.feedback.as_deref().is_some_and(|feedback| {
            feedback.eq_ignore_ascii_case("cancelled") || feedback.eq_ignore_ascii_case("cancel")
        });
        let outcome = if decision.cancelled || explicit_cancel {
            "cancelled"
        } else {
            "skipped"
        };
        return json!({
            "outcome": {
                "outcome": outcome,
                "reason": decision.feedback.as_deref().unwrap_or("Question skipped by user"),
            }
        });
    }
    let answers = decision
        .updated_input
        .as_ref()
        .map(|input| selected_answers(params, input))
        .unwrap_or_default();
    json!({ "outcome": { "outcome": "answered", "answers": answers } })
}

fn selected_answers(params: &Value, updated_input: &Value) -> Vec<Value> {
    let answers = updated_input.get("answers").and_then(Value::as_object);
    let structured = updated_input
        .get("structured_answers")
        .and_then(Value::as_array);
    params
        .get("questions")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .enumerate()
        .map(|(index, question)| {
            answer_for_question(
                question,
                answers,
                structured.and_then(|items| items.get(index)),
            )
        })
        .collect()
}

fn answer_for_question(
    question: &Value,
    answers: Option<&Map<String, Value>>,
    structured: Option<&Value>,
) -> Value {
    let prompt = question.get("prompt").and_then(Value::as_str).unwrap_or("");
    let question_id = question.get("id").and_then(Value::as_str).unwrap_or(prompt);
    let options = question
        .get("options")
        .and_then(Value::as_array)
        .map(Vec::as_slice)
        .unwrap_or_default();
    let answer_text = answers
        .and_then(|answers| answers.get(prompt))
        .and_then(Value::as_str);
    let structured_ids = structured
        .and_then(|answer| answer.get("selectedOptionIds"))
        .and_then(Value::as_array)
        .map(|ids| {
            ids.iter()
                .filter_map(Value::as_str)
                .map(ToOwned::to_owned)
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();
    let selected = if !structured_ids.is_empty() {
        structured_ids
    } else {
        answer_text
            .map(|answer| selected_option_ids(options, answer))
            .unwrap_or_default()
    };
    let free_text = answer_text
        .filter(|answer| selected.is_empty() || option_id_for_label(options, answer).is_none());
    let mut payload = json!({ "questionId": question_id, "selectedOptionIds": selected });
    // Preserve free-text / "Other" answers through Cursor's freeform option.
    if let Some(free_text) = free_text {
        payload["freeformText"] = json!(free_text);
        if selected.is_empty() {
            payload["selectedOptionIds"] = json!([FREEFORM_OPTION_ID]);
        }
    }
    payload
}

fn selected_option_ids(options: &[Value], answer: &str) -> Vec<String> {
    if let Some(id) = option_id_for_label(options, answer) {
        return vec![id];
    }
    answer
        .split(", ")
        .filter(|label| !label.is_empty())
        .filter_map(|label| option_id_for_label(options, label))
        .collect()
}

fn option_id_for_label(options: &[Value], label: &str) -> Option<String> {
    options.iter().find_map(|option| {
        (option.get("label").and_then(Value::as_str) == Some(label))
            .then(|| {
                option
                    .get("id")
                    .and_then(Value::as_str)
                    .map(ToOwned::to_owned)
            })
            .flatten()
    })
}

#[cfg(test)]
mod tests {
    use super::{response, title, tool_input};
    use crate::extensions::HostDecision;
    use serde_json::{json, Value};

    fn answered(updated_input: Value) -> HostDecision {
        HostDecision {
            approved: true,
            updated_input: Some(updated_input),
            ..HostDecision::default()
        }
    }

    fn mode_question() -> Value {
        json!({
            "title": "Pick",
            "questions": [{
                "id": "q1",
                "prompt": "Which mode?",
                "allowMultiple": true,
                "options": [
                    { "id": "agent", "label": "Agent" },
                    { "id": "plan", "label": "Plan" }
                ]
            }]
        })
    }

    #[test]
    fn converts_question_shape_and_maps_labels_back_to_ids() {
        let params = mode_question();
        let input = tool_input(&params);
        assert_eq!(input["questions"][0]["question"], "Which mode?");
        assert_eq!(input["questions"][0]["id"], "q1");
        assert_eq!(input["questions"][0]["multiSelect"], true);
        assert_eq!(input["questions"][0]["options"][1]["id"], "plan");
        assert_eq!(title(&params), "Pick");
        let payload = response(
            &params,
            &answered(json!({
                "answers": { "Which mode?": "Plan" },
                "structured_answers": [{ "questionId": "q1", "selectedOptionIds": ["plan"] }]
            })),
        );
        assert_eq!(payload["outcome"]["outcome"], "answered");
        assert_eq!(payload["outcome"]["answers"][0]["questionId"], "q1");
        assert_eq!(
            payload["outcome"]["answers"][0]["selectedOptionIds"],
            json!(["plan"])
        );
        assert!(payload["outcome"]["answers"][0]
            .get("freeformText")
            .is_none());
    }

    #[test]
    fn multi_select_labels_map_without_structured_answers() {
        let payload = response(
            &mode_question(),
            &answered(json!({ "answers": { "Which mode?": "Agent, Plan" } })),
        );
        assert_eq!(
            payload["outcome"]["answers"][0]["selectedOptionIds"],
            json!(["agent", "plan"])
        );
    }

    #[test]
    fn empty_structured_answers_fall_back_to_free_text() {
        let params = json!({
            "questions": [{
                "id": "q1",
                "prompt": "Anything else?",
                "options": [{ "id": "yes", "label": "Yes" }]
            }]
        });
        let payload = response(
            &params,
            &answered(json!({
                "answers": { "Anything else?": "custom note" },
                "structured_answers": [{ "questionId": "q1", "selectedOptionIds": [] }]
            })),
        );
        assert_eq!(
            payload["outcome"]["answers"][0]["selectedOptionIds"],
            json!(["__freeform_other__"])
        );
        assert_eq!(
            payload["outcome"]["answers"][0]["freeformText"],
            "custom note"
        );
    }

    #[test]
    fn rejection_and_cancellation_use_cursor_outcomes() {
        let skipped = response(
            &mode_question(),
            &HostDecision {
                feedback: Some("later".into()),
                ..HostDecision::default()
            },
        );
        assert_eq!(skipped["outcome"]["outcome"], "skipped");
        assert_eq!(skipped["outcome"]["reason"], "later");
        let cancel_feedback = response(
            &mode_question(),
            &HostDecision {
                feedback: Some("Cancel".into()),
                ..HostDecision::default()
            },
        );
        assert_eq!(cancel_feedback["outcome"]["outcome"], "cancelled");
        let cancelled = response(
            &mode_question(),
            &HostDecision {
                cancelled: true,
                ..HostDecision::default()
            },
        );
        assert_eq!(cancelled["outcome"]["outcome"], "cancelled");
        assert_eq!(cancelled["outcome"]["reason"], "Question skipped by user");
    }
}
