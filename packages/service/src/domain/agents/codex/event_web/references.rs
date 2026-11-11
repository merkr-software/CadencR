use std::collections::{HashMap, HashSet, VecDeque};

use serde_json::Value;

#[derive(Default)]
pub(in crate::domain::agents::codex) struct WebEventState {
    reference_urls: HashMap<String, String>,
    web_call_ids: HashSet<String>,
    pending: VecDeque<PendingWebInvocation>,
}

struct PendingWebInvocation {
    has_search: bool,
    urls: Vec<String>,
}

impl WebEventState {
    pub(super) fn record_call(&mut self, item: &Value) {
        let Some(input) = item.get("input").and_then(Value::as_str) else {
            return;
        };
        if !input.contains("tools.web__run") {
            return;
        }
        let Some(call_id) = item.get("call_id").and_then(Value::as_str) else {
            return;
        };
        self.web_call_ids.insert(call_id.to_string());
        let urls = open_references(input)
            .into_iter()
            .filter_map(|reference| {
                if reference.starts_with("http://") || reference.starts_with("https://") {
                    Some(reference)
                } else {
                    self.reference_urls.get(&reference).cloned()
                }
            })
            .collect();
        self.pending.push_back(PendingWebInvocation {
            has_search: contains_key(input, "search_query"),
            urls,
        });
    }

    pub(super) fn record_output(&mut self, item: &Value) {
        let Some(call_id) = item.get("call_id").and_then(Value::as_str) else {
            return;
        };
        if !self.web_call_ids.remove(call_id) {
            return;
        }
        visit_strings(item.get("output"), &mut |text| {
            record_reference_urls(text, &mut self.reference_urls);
        });
    }

    pub(super) fn take_url(&mut self, is_search: bool) -> Option<String> {
        let position = self
            .pending
            .iter()
            .position(|invocation| invocation.has_search == is_search)?;
        self.pending.remove(position)?.urls.into_iter().next()
    }
}

fn open_references(input: &str) -> Vec<String> {
    let Some(open_start) = key_value_start(input, "open") else {
        return Vec::new();
    };
    let open = &input[open_start..];
    let end = open
        .find("],")
        .or_else(|| open.find(']'))
        .unwrap_or(open.len());
    extract_quoted_values(&open[..end], "ref_id")
}

fn contains_key(input: &str, key: &str) -> bool {
    key_value_start(input, key).is_some()
}

fn key_value_start(input: &str, key: &str) -> Option<usize> {
    input.match_indices(key).find_map(|(position, _)| {
        let before = input[..position].chars().next_back();
        if before.is_some_and(|character| character.is_alphanumeric() || character == '_') {
            return None;
        }
        let mut end = position + key.len();
        if let Some(quote @ ('\'' | '"')) = before {
            if !input[end..].starts_with(quote) {
                return None;
            }
            end += quote.len_utf8();
        }
        let tail = input[end..].trim_start();
        tail.strip_prefix(':')
            .map(|value| input.len() - value.len())
    })
}

fn extract_quoted_values(input: &str, key: &str) -> Vec<String> {
    let mut values = Vec::new();
    let mut remaining = input;
    while let Some(start) = key_value_start(remaining, key) {
        let value = remaining[start..].trim_start();
        let Some(quote) = value
            .chars()
            .next()
            .filter(|quote| matches!(quote, '\'' | '"'))
        else {
            break;
        };
        let value = &value[quote.len_utf8()..];
        let Some(end) = value.find(quote) else {
            break;
        };
        values.push(value[..end].to_string());
        remaining = &value[end + quote.len_utf8()..];
    }
    values
}

fn visit_strings(value: Option<&Value>, visit: &mut impl FnMut(&str)) {
    match value {
        Some(Value::String(text)) => visit(text),
        Some(Value::Array(values)) => {
            for value in values {
                visit_strings(Some(value), visit);
            }
        }
        Some(Value::Object(values)) => {
            for value in values.values() {
                visit_strings(Some(value), visit);
            }
        }
        _ => {}
    }
}

fn record_reference_urls(text: &str, references: &mut HashMap<String, String>) {
    let mut pending_url = None;
    for line in text.lines() {
        if let Some(url) = url_in_line(line) {
            pending_url = Some(url.to_string());
        }
        let Some(reference) = citation_reference(line) else {
            continue;
        };
        if let Some(url) = pending_url.take() {
            references.insert(reference.to_string(), url);
        }
    }
}

fn url_in_line(line: &str) -> Option<&str> {
    let start = line.rfind("(http")? + 1;
    let end = line[start..].find(')')? + start;
    Some(&line[start..end])
}

fn citation_reference(line: &str) -> Option<&str> {
    let start = line.find("cite")? + "cite".len();
    let end = line[start..].find('')? + start;
    Some(&line[start..end])
}
