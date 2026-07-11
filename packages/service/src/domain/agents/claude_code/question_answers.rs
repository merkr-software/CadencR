use serde_json::Value;

use crate::domain::agents::adapter::RuntimeToolPermissionResult;
use crate::domain::ws_session::question_answers::{extract_answer_lists, extract_question_labels};

pub(crate) fn normalize_result(result: RuntimeToolPermissionResult) -> RuntimeToolPermissionResult {
    match result {
        RuntimeToolPermissionResult::Allow {
            updated_input,
            updated_permissions,
            tool_use_id,
        } => RuntimeToolPermissionResult::Allow {
            updated_input: normalize_for_claude(updated_input),
            updated_permissions,
            tool_use_id,
        },
        denied => denied,
    }
}

/// Claude's `AskUserQuestion` callback requires a record keyed by question
/// text. Other providers keep the structured answer arrays supplied by the
/// control API and normalize them in their own adapters.
pub(super) fn normalize_for_claude(mut input: Value) -> Value {
    let labels = extract_question_labels(&input);
    let Some(answers) = extract_answer_lists(&input) else {
        return input;
    };
    if labels.len() != answers.len() {
        return input;
    }
    let normalized = labels
        .into_iter()
        .zip(answers)
        .map(|(question, selected)| (question, Value::String(selected.join(", "))))
        .collect();
    if let Some(object) = input.as_object_mut() {
        object.insert("answers".into(), Value::Object(normalized));
    }
    input
}

#[cfg(test)]
mod tests {
    use super::normalize_for_claude;
    use serde_json::json;

    #[test]
    fn wraps_single_string_answer_in_question_record() {
        let input = json!({
            "questions": [{"question": "Choose a path?"}],
            "answers": "Question path"
        });

        assert_eq!(
            normalize_for_claude(input)["answers"],
            json!({"Choose a path?": "Question path"})
        );
    }

    #[test]
    fn joins_multiselect_only_at_claude_boundary() {
        let input = json!({
            "questions": [{"question": "Choose paths?"}],
            "answers": [["Alpha", "Beta"]]
        });

        assert_eq!(
            normalize_for_claude(input)["answers"],
            json!({"Choose paths?": "Alpha, Beta"})
        );
    }
}
