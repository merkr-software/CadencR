use super::PersistedMessageRef;
use std::collections::HashMap;

#[derive(Debug)]
pub enum PersistedEventRef {
    Message(PersistedMessageRef),
    ToolResults(Vec<(String, i64)>),
    AssistantContent(Vec<(usize, i64)>),
}

/// Results are stamped individually: a single event can persist several rows.
pub fn raw_event_with_agent_message_id(
    raw: &serde_json::Value,
    persisted: Option<PersistedEventRef>,
) -> serde_json::Value {
    let mut value = raw.clone();
    match persisted {
        Some(PersistedEventRef::Message(message)) => {
            if let Some(object) = value.as_object_mut() {
                object.insert("agent_message_id".into(), message.id.into());
            }
        }
        Some(PersistedEventRef::AssistantContent(rows)) => {
            if let Some(items) = value
                .pointer_mut("/message/content")
                .and_then(|value| value.as_array_mut())
            {
                for (index, id) in rows {
                    if let Some(serde_json::Value::Object(item)) = items.get_mut(index) {
                        item.insert("agent_message_id".into(), id.into());
                    }
                }
            }
        }
        Some(PersistedEventRef::ToolResults(results)) => {
            let mut unique_ids = HashMap::new();
            for (tool_id, id) in results {
                unique_ids
                    .entry(tool_id)
                    .and_modify(|id| *id = None)
                    .or_insert(Some(id));
            }
            let Some(items) = value
                .pointer_mut("/message/content")
                .and_then(|v| v.as_array_mut())
            else {
                return value;
            };
            for item in items {
                if item["type"] != "tool_result" {
                    continue;
                }
                let Some(tool_id) = item["tool_use_id"].as_str() else {
                    continue;
                };
                // Never attach a plausible but ambiguous row identity.
                if let Some(Some(id)) = unique_ids.get(tool_id) {
                    item["agent_message_id"] = (*id).into();
                }
            }
        }
        None => {}
    }
    value
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn stamps_results_individually_and_rejects_ambiguous_ids() {
        let raw = json!({"type":"user", "message":{"content":[
            {"type":"tool_result","tool_use_id":"a","content":"first"},
            {"type":"tool_result","tool_use_id":"b","content":"second"},
            {"type":"tool_result","tool_use_id":"ambiguous","content":"third"}
        ]}});
        let stamped = raw_event_with_agent_message_id(
            &raw,
            Some(PersistedEventRef::ToolResults(vec![
                ("b".into(), 22),
                ("a".into(), 11),
                ("ambiguous".into(), 33),
                ("ambiguous".into(), 44),
            ])),
        );
        assert_eq!(stamped["message"]["content"][0]["agent_message_id"], 11);
        assert_eq!(stamped["message"]["content"][1]["agent_message_id"], 22);
        assert!(stamped["message"]["content"][2]["agent_message_id"].is_null());
        assert!(stamped["agent_message_id"].is_null());
    }
    #[test]
    fn full_assistant_repair_stamps_each_content_index_with_its_durable_row() {
        let raw = json!({"type":"assistant","message":{"content":[
            {"type":"thinking","thinking":"reason"},
            {"type":"tool_use","id":"tool"},
            {"type":"text","text":"answer"}
        ]}});
        let stamped = raw_event_with_agent_message_id(
            &raw,
            Some(PersistedEventRef::AssistantContent(vec![(2, 42), (0, 41)])),
        );
        assert_eq!(stamped["message"]["content"][0]["agent_message_id"], 41);
        assert!(stamped["message"]["content"][1]["agent_message_id"].is_null());
        assert_eq!(stamped["message"]["content"][2]["agent_message_id"], 42);
    }
}
