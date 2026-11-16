use serde_json::Value;

use super::event_items::tool_item_with_input;
use super::event_state::IndexState;
use crate::domain::agents::adapter::RuntimeEvent;

mod references;
pub(super) use references::WebEventState;

pub(super) fn record_raw_web_item(item_type: &str, item: &Value, index_state: &mut IndexState) {
    match item_type {
        "custom_tool_call" => index_state.web_mut().record_call(item),
        "custom_tool_call_output" => index_state.web_mut().record_output(item),
        _ => {}
    }
}

pub(super) fn web_search_item(
    params: Value,
    completed: bool,
    index_state: &mut IndexState,
) -> Vec<RuntimeEvent> {
    // Codex starts web items with placeholder details (`query: ""`,
    // `action: null`) and only supplies the real query/action on completion.
    // Waiting prevents an empty WebSearch block from locking in both the
    // wrong input and, for openPage actions, the wrong canonical tool name.
    if !completed {
        return Vec::new();
    }
    let Some(item) = params.get("item") else {
        return Vec::new();
    };
    let name = web_tool_name(item);
    let mut input = web_search_input(item);
    let is_search = name == "WebSearch";
    if !is_search && input.get("url").is_none_or(Value::is_null) {
        if let Some(url) = index_state.web_mut().take_url(false) {
            input["url"] = Value::String(url);
        }
    } else {
        index_state.web_mut().take_url(is_search);
    }
    tool_item_with_input(params, name, input, completed, index_state)
}

fn web_tool_name(item: &Value) -> &'static str {
    match item
        .get("action")
        .and_then(|action| action.get("type"))
        .and_then(Value::as_str)
    {
        Some("search") | None => "WebSearch",
        // Codex reports page opens from search-result references as `other`
        // rather than `openPage`. Every non-search action operates on a page,
        // so present those as the provider-neutral WebFetch tool.
        Some(_) => "WebFetch",
    }
}

pub(super) fn web_search_input(item: &Value) -> Value {
    let mut input = serde_json::Map::new();
    if let Some(query) = item.get("query").cloned() {
        input.insert("query".to_string(), query);
    }
    if let Some(action) = item.get("action") {
        input.insert("action".to_string(), action.clone());
        promote_action_field(&mut input, action, "url");
        promote_action_field(&mut input, action, "query");
        promote_action_field(&mut input, action, "queries");
    }
    if let Some(status) = item.get("status").cloned() {
        input.insert("status".to_string(), status);
    }
    Value::Object(input)
}

fn promote_action_field(input: &mut serde_json::Map<String, Value>, action: &Value, field: &str) {
    if input.get(field).is_some_and(|value| !value.is_null()) {
        return;
    }
    if let Some(value) = action.get(field).cloned() {
        input.insert(field.to_string(), value);
    }
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::{record_raw_web_item, web_search_item};
    use crate::domain::agents::adapter::{RuntimeContentBlock, RuntimeEvent, RuntimeStreamEvent};
    use crate::domain::agents::codex::event_state::IndexState;

    fn tool_start(events: &[RuntimeEvent]) -> (&str, &serde_json::Value) {
        let Some(RuntimeStreamEvent::ContentBlockStart {
            block: RuntimeContentBlock::ToolUse { name, input, .. },
            ..
        }) = events.first().and_then(RuntimeEvent::stream_event)
        else {
            panic!("expected tool start");
        };
        (name, input)
    }

    #[test]
    fn open_page_is_a_web_fetch_with_promoted_url() {
        let mut indexes = IndexState::default();
        let events = web_search_item(
            json!({
                "threadId": "thread",
                "item": {
                    "type": "webSearch",
                    "id": "fetch",
                    "query": "https://example.com/docs",
                    "action": {
                        "type": "openPage",
                        "url": "https://example.com/docs"
                    }
                }
            }),
            true,
            &mut indexes,
        );

        let (name, input) = tool_start(&events);
        assert_eq!(name, "WebFetch");
        assert_eq!(input["url"], "https://example.com/docs");
    }

    #[test]
    fn search_preserves_multiple_queries() {
        let mut indexes = IndexState::default();
        let events = web_search_item(
            json!({
                "threadId": "thread",
                "item": {
                    "type": "webSearch",
                    "id": "search",
                    "query": "Codex web tools ...",
                    "action": {
                        "type": "search",
                        "queries": ["Codex web tools", "Codex web fetch"]
                    }
                }
            }),
            true,
            &mut indexes,
        );

        let (name, input) = tool_start(&events);
        assert_eq!(name, "WebSearch");
        assert_eq!(input["query"], "Codex web tools ...");
        assert_eq!(
            input["queries"],
            json!(["Codex web tools", "Codex web fetch"])
        );
    }

    #[test]
    fn opaque_page_action_is_a_web_fetch() {
        let mut indexes = IndexState::default();
        let events = web_search_item(
            json!({
                "threadId": "thread",
                "item": {
                    "type": "webSearch",
                    "id": "fetch",
                    "query": "'Latest release'",
                    "action": {
                        "type": "findInPage",
                        "url": null,
                        "pattern": "Latest release"
                    }
                }
            }),
            true,
            &mut indexes,
        );

        assert_eq!(tool_start(&events).0, "WebFetch");
    }

    #[test]
    fn opaque_page_action_resolves_url_from_prior_web_output() {
        let mut indexes = IndexState::default();
        record_raw_web_item(
            "custom_tool_call",
            &json!({
                "name": "exec",
                "call_id": "call_search",
                "input": "const r = await tools.web__run({search_query:[{q:\"release\"}]});"
            }),
            &mut indexes,
        );
        record_raw_web_item(
            "custom_tool_call_output",
            &json!({
                "call_id": "call_search",
                "output": [{
                    "type": "input_text",
                    "text": "Releases (https://example.com/releases)\nciteturn0search1"
                }]
            }),
            &mut indexes,
        );
        record_raw_web_item(
            "custom_tool_call_output",
            &json!({
                "call_id": "unrelated_call",
                "output": "Wrong (https://wrong.example)\nciteturn0search1"
            }),
            &mut indexes,
        );
        web_search_item(
            json!({
                "threadId": "thread",
                "item": {
                    "type": "webSearch",
                    "id": "search",
                    "query": "release",
                    "action": { "type": "search", "query": "release" }
                }
            }),
            true,
            &mut indexes,
        );
        record_raw_web_item(
            "custom_tool_call",
            &json!({
                "name": "exec",
                "call_id": "call_fetch",
                "input": "const r = await tools.web__run({'open' : [{'ref_id' : 'turn0search1'}]});"
            }),
            &mut indexes,
        );

        let events = web_search_item(
            json!({
                "threadId": "thread",
                "item": {
                    "type": "webSearch",
                    "id": "fetch",
                    "query": "'Latest release'",
                    "action": {
                        "type": "findInPage",
                        "url": null,
                        "pattern": "Latest release"
                    }
                }
            }),
            true,
            &mut indexes,
        );

        let (name, input) = tool_start(&events);
        assert_eq!(name, "WebFetch");
        assert_eq!(input["url"], "https://example.com/releases");
    }

    #[test]
    fn start_waits_for_completed_query_and_action() {
        let mut indexes = IndexState::default();
        let events = web_search_item(
            json!({
                "threadId": "thread",
                "item": {
                    "type": "webSearch",
                    "id": "search",
                    "query": "",
                    "action": null
                }
            }),
            false,
            &mut indexes,
        );

        assert!(events.is_empty());
    }
}
