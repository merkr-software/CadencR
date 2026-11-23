//! OpenCode 2.x questions: `elicitation/create` forms ⇄ the host's
//! `AskUserQuestion` permission request.
//!
//! OpenCode asks through an ACP form elicitation whose schema has one property
//! per question (`q0`, `q1`, … with `oneOf` choices or `items.anyOf` for
//! multi-select) and an optional `<key>_custom` free-text property. The host
//! opens its question drawer for a `session/request_permission` named
//! `AskUserQuestion` and answers with `_meta.updatedInput.answers`, keyed by
//! question text (see `docs/PROVIDER_SPEC/INSTALLED_ACP_PROVIDERS.md`).

use serde_json::{json, Map, Value};

use crate::domain::ws_session::question_answers::extract_answer_lists;

pub(super) const ANSWER_OPTION_ID: &str = "answer";
const DECLINE_OPTION_ID: &str = "decline";
const CUSTOM_SUFFIX: &str = "_custom";
/// The prefix of the permission ids the wire mints for elicitations.
pub(super) const REQUEST_ID_PREFIX: &str = "cadencr-opencode-elicitation-";

#[derive(Debug, Clone, PartialEq)]
pub(super) struct QuestionField {
    key: String,
    question: String,
    header: String,
    multi_select: bool,
    /// `(label shown, value OpenCode expects)`.
    choices: Vec<(String, String)>,
    custom_key: Option<String>,
}

/// An elicitation waiting for the user's answer.
#[derive(Debug, Clone, PartialEq)]
pub(super) struct PendingQuestion {
    pub(super) agent_request_id: Value,
    fields: Vec<QuestionField>,
}

/// The questions of a form elicitation, or `None` for one the drawer cannot
/// show (no question property, or not a form).
pub(super) fn parse_form(params: &Value) -> Option<Vec<QuestionField>> {
    if params.get("mode").and_then(Value::as_str) != Some("form") {
        return None;
    }
    let properties = params
        .pointer("/requestedSchema/properties")
        .and_then(Value::as_object)?;
    let fields: Vec<QuestionField> = properties
        .iter()
        .filter(|(key, _)| !key.ends_with(CUSTOM_SUFFIX))
        .map(|(key, schema)| field(key, schema, properties))
        .collect();
    (!fields.is_empty()).then_some(fields)
}

fn field(key: &str, schema: &Value, properties: &Map<String, Value>) -> QuestionField {
    let text = |name: &str| schema.get(name).and_then(Value::as_str).map(str::to_owned);
    let multi_select = schema.get("type").and_then(Value::as_str) == Some("array");
    let options = if multi_select {
        schema.pointer("/items/anyOf")
    } else {
        schema.get("oneOf")
    };
    let choices = options
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(|option| {
            let value = option.get("const")?.as_str()?.to_owned();
            let label = option
                .get("title")
                .and_then(Value::as_str)
                .map_or_else(|| value.clone(), str::to_owned);
            Some((label, value))
        })
        .collect();
    let custom_key = format!("{key}{CUSTOM_SUFFIX}");
    QuestionField {
        key: key.to_owned(),
        question: text("description")
            .or_else(|| text("title"))
            .unwrap_or_else(|| key.to_owned()),
        header: text("title").unwrap_or_default(),
        multi_select,
        choices,
        custom_key: properties.contains_key(&custom_key).then_some(custom_key),
    }
}

/// The `AskUserQuestion` permission request standing for an elicitation.
pub(super) fn permission_request(
    request_id: &str,
    params: &Value,
    fields: &[QuestionField],
    tool_call_id: &str,
) -> Value {
    let questions: Vec<Value> = fields
        .iter()
        .map(|field| {
            let mut question = json!({
                "question": field.question,
                "header": field.header,
                "multiSelect": field.multi_select,
                "options": field
                    .choices
                    .iter()
                    .map(|(label, _)| json!({ "label": label }))
                    .collect::<Vec<_>>(),
            });
            if field.custom_key.is_none() && !field.choices.is_empty() {
                question["allowCustomAnswer"] = Value::Bool(false);
            }
            question
        })
        .collect();
    json!({
        "jsonrpc": "2.0",
        "id": request_id,
        "method": "session/request_permission",
        "params": {
            "sessionId": params.get("sessionId").cloned().unwrap_or(Value::Null),
            "toolCall": {
                "toolCallId": tool_call_id,
                "name": "AskUserQuestion",
                "title": params.get("message").and_then(Value::as_str).unwrap_or("Question"),
                "kind": "other",
                "status": "pending",
                "rawInput": { "questions": questions },
            },
            "options": [
                { "optionId": ANSWER_OPTION_ID, "name": "Answer", "kind": "allow_once" },
                { "optionId": DECLINE_OPTION_ID, "name": "Decline", "kind": "reject_once" },
            ],
        },
    })
}

impl PendingQuestion {
    pub(super) fn new(agent_request_id: Value, fields: Vec<QuestionField>) -> Self {
        Self {
            agent_request_id,
            fields,
        }
    }

    /// The elicitation response for the host's permission response (a
    /// JSON-RPC `result`, or `None` when it answered with an error).
    pub(super) fn response(&self, result: Option<&Value>) -> Value {
        let result = match result {
            Some(result) => self.elicitation_result(result),
            None => json!({ "action": "cancel" }),
        };
        json!({ "jsonrpc": "2.0", "id": self.agent_request_id, "result": result })
    }

    fn elicitation_result(&self, result: &Value) -> Value {
        let outcome = result.pointer("/outcome/outcome").and_then(Value::as_str);
        let option = result.pointer("/outcome/optionId").and_then(Value::as_str);
        if outcome == Some("cancelled") {
            return json!({ "action": "cancel" });
        }
        let answers = result.pointer("/_meta/updatedInput/answers");
        match (option, answers) {
            (Some(ANSWER_OPTION_ID), Some(answers)) => json!({
                "action": "accept",
                "content": self.content(answers),
            }),
            _ => json!({ "action": "decline" }),
        }
    }

    /// The form content for the host's answers, decoded as for every other
    /// `AskUserQuestion` (keyed by question text, by index, or a list).
    fn content(&self, answers: &Value) -> Value {
        let questions: Vec<Value> = self
            .fields
            .iter()
            .map(|field| json!({ "question": field.question }))
            .collect();
        let lists = extract_answer_lists(&json!({ "questions": questions, "answers": answers }))
            .unwrap_or_default();
        let mut content = Map::new();
        for (field, answers) in self.fields.iter().zip(lists) {
            field.answer_into(&answers, &mut content);
        }
        Value::Object(content)
    }
}

impl QuestionField {
    fn value_for(&self, label: &str) -> Option<&str> {
        self.choices
            .iter()
            .find(|(choice, _)| choice == label)
            .map(|(_, value)| value.as_str())
    }

    /// Choices go under the field key; text matching no choice goes under the
    /// custom key when the form has one, and is dropped otherwise.
    fn answer_into(&self, answers: &[String], content: &mut Map<String, Value>) {
        let pieces: Vec<&str> = answers
            .iter()
            .flat_map(|answer| {
                if self.multi_select {
                    answer.split(", ").map(str::trim).collect()
                } else {
                    vec![answer.trim()]
                }
            })
            .collect();
        let mut chosen = Vec::new();
        let mut custom = Vec::new();
        for piece in pieces.into_iter().filter(|piece| !piece.is_empty()) {
            match self.value_for(piece) {
                Some(value) => chosen.push(Value::String(value.to_owned())),
                None if self.choices.is_empty() && !self.multi_select => {
                    chosen.push(Value::String(piece.to_owned()));
                }
                None => custom.push(piece),
            }
        }
        if self.multi_select {
            if !chosen.is_empty() {
                content.insert(self.key.clone(), Value::Array(chosen));
            }
        } else if let Some(value) = chosen.into_iter().next() {
            content.insert(self.key.clone(), value);
        }
        if let (Some(custom_key), false) = (&self.custom_key, custom.is_empty()) {
            content.insert(custom_key.clone(), Value::String(custom.join(", ")));
        }
    }
}

#[cfg(test)]
mod tests {
    use super::{parse_form, permission_request, PendingQuestion};
    use serde_json::{json, Value};

    fn color_form() -> Value {
        json!({
            "mode": "form",
            "sessionId": "ses_1",
            "toolCallId": "toolu_q",
            "message": "Questions",
            "requestedSchema": {
                "type": "object",
                "properties": {
                    "q0": {
                        "type": "string",
                        "title": "Color",
                        "description": "Which color?",
                        "oneOf": [
                            { "const": "Red", "title": "Red" },
                            { "const": "Blue", "title": "Blue" }
                        ]
                    },
                    "q0_custom": { "type": "string" },
                    "q1": {
                        "type": "array",
                        "title": "Fruits",
                        "description": "Which fruits?",
                        "items": { "anyOf": [
                            { "const": "apple", "title": "Apple" },
                            { "const": "pear", "title": "Pear" }
                        ] }
                    }
                }
            }
        })
    }

    fn answered(answers: Value) -> Value {
        json!({
            "outcome": { "outcome": "selected", "optionId": "answer" },
            "_meta": { "updatedInput": { "answers": answers } }
        })
    }

    #[test]
    fn a_form_becomes_an_ask_user_question_request() {
        let params = color_form();
        let fields = parse_form(&params).unwrap();
        let request = permission_request(
            "cadencr-opencode-elicitation-0",
            &params,
            &fields,
            "toolu_q",
        );
        let tool_call = &request["params"]["toolCall"];
        assert_eq!(request["method"], "session/request_permission");
        assert_eq!(request["params"]["sessionId"], "ses_1");
        assert_eq!(tool_call["name"], "AskUserQuestion");
        assert_eq!(tool_call["toolCallId"], "toolu_q");
        let questions = tool_call["rawInput"]["questions"].as_array().unwrap();
        assert_eq!(questions[0]["question"], "Which color?");
        assert_eq!(
            questions[0]["options"],
            json!([{"label": "Red"}, {"label": "Blue"}])
        );
        assert!(questions[0].get("allowCustomAnswer").is_none());
        assert_eq!(questions[1]["multiSelect"], true);
        assert_eq!(questions[1]["allowCustomAnswer"], false);
    }

    #[test]
    fn answers_map_back_to_form_values_and_custom_text() {
        let fields = parse_form(&color_form()).unwrap();
        let pending = PendingQuestion::new(json!(4), fields);
        let response = pending.response(Some(&answered(json!({
            "Which color?": "Green",
            "Which fruits?": "Apple, Pear"
        }))));
        assert_eq!(response["id"], 4);
        assert_eq!(
            response["result"],
            json!({
                "action": "accept",
                "content": { "q0_custom": "Green", "q1": ["apple", "pear"] }
            })
        );
        let response = pending.response(Some(&answered(json!({ "Which color?": "Blue" }))));
        assert_eq!(response["result"]["content"], json!({ "q0": "Blue" }));
        let listed = pending.response(Some(&answered(
            json!({ "Which fruits?": ["Apple", "Pear"] }),
        )));
        assert_eq!(
            listed["result"]["content"],
            json!({ "q1": ["apple", "pear"] })
        );
    }

    #[test]
    fn a_refusal_declines_and_a_dismissal_or_error_cancels() {
        let pending = PendingQuestion::new(json!("e1"), parse_form(&color_form()).unwrap());
        let refused = json!({ "outcome": { "outcome": "selected", "optionId": "decline" } });
        assert_eq!(
            pending.response(Some(&refused))["result"]["action"],
            "decline"
        );
        let dismissed = json!({ "outcome": { "outcome": "cancelled" } });
        assert_eq!(
            pending.response(Some(&dismissed))["result"]["action"],
            "cancel"
        );
        assert_eq!(pending.response(None)["result"]["action"], "cancel");
    }

    #[test]
    fn a_free_text_question_keeps_the_typed_text() {
        let params = json!({
            "mode": "form",
            "requestedSchema": { "properties": { "q0": { "type": "string", "title": "Name" } } }
        });
        let pending = PendingQuestion::new(json!(1), parse_form(&params).unwrap());
        let response = pending.response(Some(&answered(json!({ "Name": "Ada" }))));
        assert_eq!(response["result"]["content"], json!({ "q0": "Ada" }));
    }

    #[test]
    fn non_form_elicitations_are_not_questions() {
        assert!(parse_form(&json!({ "mode": "url", "url": "https://x" })).is_none());
        assert!(
            parse_form(&json!({ "mode": "form", "requestedSchema": { "properties": {} } }))
                .is_none()
        );
    }
}
