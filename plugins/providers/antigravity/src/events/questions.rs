use std::collections::HashSet;

use serde_json::{json, Value};

pub(super) struct Question {
    tool_call_id: String,
    text: String,
    choices: Vec<Choice>,
}

struct Choice {
    label: String,
    id: String,
}

impl Question {
    /// Some Antigravity ACP builds send native choices as permission options.
    /// The CLI also sends numbered text questions that continue in a later
    /// prompt. Those don't carry an interactive permission request.
    pub(super) fn from_permission(params: &Value) -> Option<Self> {
        let tool = params.get("toolCall")?;
        let tool_call_id = tool.get("toolCallId")?.as_str()?;
        if !tool_call_id.starts_with("interaction_") {
            return None;
        }
        let mut ids = HashSet::new();
        let choices = params
            .get("options")?
            .as_array()?
            .iter()
            .map(|option| choice(option, &mut ids))
            .collect::<Option<Vec<_>>>()?;
        if choices.is_empty() {
            return None;
        }
        let text = tool
            .get("title")
            .and_then(Value::as_str)
            .filter(|title| !title.trim().is_empty())
            .unwrap_or("Choose an option.");
        Some(Self {
            tool_call_id: tool_call_id.to_owned(),
            text: text.to_owned(),
            choices,
        })
    }

    pub(super) fn rewrite_permission(&self, params: &mut Value) {
        let options = self
            .choices
            .iter()
            .map(|choice| json!({"id":choice.id,"label":choice.label}))
            .collect::<Vec<_>>();
        let call = &mut params["toolCall"];
        call["name"] = json!("AskUserQuestion");
        call["toolName"] = json!("AskUserQuestion");
        call["rawInput"] = json!({"questions":[{
            "id":self.tool_call_id,
            "question":self.text,
            "options":options,
            "multiSelect":false,
            "allowCustomAnswer":false
        }]});
    }

    pub(super) fn native_response(&self, result: &Value) -> Value {
        let option_id = (result.pointer("/outcome/outcome").and_then(Value::as_str)
            == Some("selected"))
        .then(|| result.pointer("/_meta/updatedInput"))
        .flatten()
        .and_then(|input| self.answer(input));
        match option_id {
            Some(id) => json!({"outcome":{"outcome":"selected","optionId":id}}),
            None => json!({"outcome":{"outcome":"cancelled"}}),
        }
    }

    fn answer(&self, input: &Value) -> Option<&str> {
        if let Some(answers) = input.get("structured_answers") {
            let [answer] = answers.as_array()?.as_slice() else {
                return None;
            };
            if answer.get("questionId")?.as_str()? != self.tool_call_id {
                return None;
            }
            let [id] = answer.get("selectedOptionIds")?.as_array()?.as_slice() else {
                return None;
            };
            return self.choice_by_id(id.as_str()?);
        }
        let label = input.get("answers")?.get(&self.text)?.as_str()?;
        let mut matches = self.choices.iter().filter(|choice| choice.label == label);
        let first = matches.next()?;
        matches.next().is_none().then_some(first.id.as_str())
    }

    fn choice_by_id(&self, id: &str) -> Option<&str> {
        self.choices
            .iter()
            .find(|choice| choice.id == id)
            .map(|choice| choice.id.as_str())
    }
}

fn choice<'a>(option: &'a Value, ids: &mut HashSet<&'a str>) -> Option<Choice> {
    let id = option.get("optionId")?.as_str()?;
    if id.trim().is_empty() || !ids.insert(id) {
        return None;
    }
    let label = option
        .get("name")?
        .as_str()
        .filter(|label| !label.trim().is_empty())
        .unwrap_or(id);
    Some(Choice {
        label: label.to_owned(),
        id: id.to_owned(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn params() -> Value {
        json!({
            "sessionId":"s",
            "toolCall":{"toolCallId":"interaction_a","title":"Color?"},
            "options":[{"optionId":"red-id","name":"Red","kind":"allow_once"},{"optionId":"blue-id","name":"Blue","kind":"allow_once"}]
        })
    }

    #[test]
    fn verifies_the_native_ids_and_rejects_multiple_or_unknown_answers() {
        let question = Question::from_permission(&params()).unwrap();
        let result = |choice_ids: Value| {
            json!({"outcome":{"outcome":"selected","optionId":"red-id"},"_meta":{"updatedInput":{
                "answers":{"Color?":"Blue"},
                "structured_answers":[{"questionId":"interaction_a","selectedOptionIds":choice_ids}]
            }}})
        };
        assert_eq!(
            question.native_response(&result(json!(["blue-id"])))["outcome"]["optionId"],
            "blue-id"
        );
        for invalid in [json!([]), json!(["other"]), json!(["red-id", "blue-id"])] {
            assert_eq!(
                question.native_response(&result(invalid)),
                json!({"outcome":{"outcome":"cancelled"}})
            );
        }
    }

    #[test]
    fn duplicate_ids_and_ambiguous_legacy_labels_are_never_selected() {
        let mut params = params();
        params["options"][1]["optionId"] = json!("red-id");
        assert!(Question::from_permission(&params).is_none());
        params["options"][1]["optionId"] = json!("blue-id");
        params["options"][1]["name"] = json!("Red");
        let question = Question::from_permission(&params).unwrap();
        assert_eq!(
            question.native_response(&json!({"outcome":{"outcome":"selected"},"_meta":{"updatedInput":{"answers":{"Color?":"Red"}}}})),
            json!({"outcome":{"outcome":"cancelled"}})
        );
    }
}
