use serde_json::Value;

pub fn extract_answer_lists(updated_input: &Value) -> Option<Vec<Vec<String>>> {
    let answers = updated_input.get("answers")?;

    if let Some(answer) = answers.as_str() {
        return Some(vec![vec![answer.to_string()]]);
    }

    if let Some(items) = answers.as_array() {
        let parsed = items
            .iter()
            .map(|item| match item {
                Value::Array(values) => values
                    .iter()
                    .filter_map(Value::as_str)
                    .map(ToOwned::to_owned)
                    .collect::<Vec<String>>(),
                Value::String(value) => vec![value.to_string()],
                _ => Vec::new(),
            })
            .collect::<Vec<Vec<String>>>();
        return Some(parsed);
    }

    let object = answers.as_object()?;

    // Canonical SDK shape (`AskUserQuestionOutput`): keys are the question
    // texts, values are the (comma-separated) answer strings. We preserve
    // question order by walking `extract_question_labels` first.
    let labels = extract_question_labels(updated_input);
    if labels.iter().any(|label| object.contains_key(label)) {
        let by_text = labels
            .iter()
            .map(|label| match object.get(label) {
                Some(Value::String(answer)) => vec![answer.to_string()],
                Some(Value::Array(values)) => values
                    .iter()
                    .filter_map(Value::as_str)
                    .map(ToOwned::to_owned)
                    .collect::<Vec<String>>(),
                _ => Vec::new(),
            })
            .collect::<Vec<Vec<String>>>();
        return Some(by_text);
    }

    // Legacy shape (pre-`AskUserQuestionOutput`): integer-keyed object map.
    let mut indexed = object
        .iter()
        .filter_map(|(key, value)| {
            let index = key.parse::<usize>().ok()?;
            let answer_group = match value {
                Value::String(answer) => vec![answer.to_string()],
                Value::Array(values) => values
                    .iter()
                    .filter_map(Value::as_str)
                    .map(ToOwned::to_owned)
                    .collect::<Vec<String>>(),
                _ => Vec::new(),
            };
            Some((index, answer_group))
        })
        .collect::<Vec<(usize, Vec<String>)>>();
    indexed.sort_by_key(|(index, _)| *index);
    Some(indexed.into_iter().map(|(_, answers)| answers).collect())
}

pub fn format_answers_plain_text(updated_input: &Value) -> Option<String> {
    let answers = extract_answer_lists(updated_input)?;
    let questions = extract_question_labels(updated_input);

    let formatted = answers
        .iter()
        .enumerate()
        .map(|(index, answer_group)| {
            let question = questions
                .get(index)
                .cloned()
                .unwrap_or_else(|| format!("Question {}", index + 1));
            let answer = answer_group.join(", ");
            format!("{question}\nAnswer: {answer}")
        })
        .collect::<Vec<String>>()
        .join("\n\n");

    Some(formatted)
}

#[allow(dead_code)]
pub fn format_answers_markdown(updated_input: &Value) -> Option<String> {
    let answers = extract_answer_lists(updated_input)?;
    let questions = extract_question_labels(updated_input);

    let formatted = answers
        .iter()
        .enumerate()
        .map(|(index, answer_group)| {
            let question = questions
                .get(index)
                .cloned()
                .unwrap_or_else(|| format!("Question {}", index + 1));
            format!("*{question}*\n\n**{}**", answer_group.join("\n"))
        })
        .collect::<Vec<String>>()
        .join("\n\n\n\n");

    Some(formatted)
}

pub(crate) fn extract_question_labels(updated_input: &Value) -> Vec<String> {
    updated_input
        .get("questions")
        .and_then(Value::as_array)
        .map(|items| {
            items
                .iter()
                .filter_map(|item| item.get("question").and_then(Value::as_str))
                .map(ToOwned::to_owned)
                .collect::<Vec<String>>()
        })
        .filter(|items| !items.is_empty())
        .or_else(|| {
            updated_input
                .get("question")
                .and_then(Value::as_str)
                .map(|question| vec![question.to_string()])
        })
        .unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::{extract_answer_lists, format_answers_markdown, format_answers_plain_text};
    use serde_json::json;

    #[test]
    fn extracts_structured_answer_arrays() {
        let updated_input = json!({
            "questions": [
                { "question": "First?" },
                { "question": "Second?" }
            ],
            "answers": [
                ["Alpha"],
                ["Beta", "Gamma"]
            ]
        });

        assert_eq!(
            extract_answer_lists(&updated_input),
            Some(vec![
                vec!["Alpha".to_string()],
                vec!["Beta".to_string(), "Gamma".to_string()],
            ])
        );
    }

    #[test]
    fn extracts_legacy_object_answers() {
        let updated_input = json!({
            "question": "Only?",
            "answers": { "0": "Legacy answer" }
        });

        assert_eq!(
            extract_answer_lists(&updated_input),
            Some(vec![vec!["Legacy answer".to_string()]])
        );
    }

    #[test]
    fn extracts_single_string_answer() {
        let updated_input = json!({"answers": "Question path"});

        assert_eq!(
            extract_answer_lists(&updated_input),
            Some(vec![vec!["Question path".to_string()]])
        );
    }

    #[test]
    fn extracts_question_text_keyed_answers() {
        // Canonical Anthropic SDK shape: answers is a map keyed by question
        // text (multi-select values are comma-separated strings).
        let updated_input = json!({
            "questions": [
                { "question": "First?" },
                { "question": "Second?" }
            ],
            "answers": {
                "First?": "Alpha",
                "Second?": "Beta, Gamma"
            }
        });

        assert_eq!(
            extract_answer_lists(&updated_input),
            Some(vec![
                vec!["Alpha".to_string()],
                vec!["Beta, Gamma".to_string()],
            ])
        );
    }

    #[test]
    fn formats_answers_for_persistence_and_display() {
        let updated_input = json!({
            "questions": [
                { "question": "First?" },
                { "question": "Second?" }
            ],
            "answers": [
                ["Alpha"],
                ["Beta", "Gamma"]
            ]
        });

        assert_eq!(
            format_answers_plain_text(&updated_input).as_deref(),
            Some("First?\nAnswer: Alpha\n\nSecond?\nAnswer: Beta, Gamma")
        );
        assert_eq!(
            format_answers_markdown(&updated_input).as_deref(),
            Some("*First?*\n\n**Alpha**\n\n\n\n*Second?*\n\n**Beta\nGamma**")
        );
    }
}
