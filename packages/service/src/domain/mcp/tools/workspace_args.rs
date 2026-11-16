//! Argument parsing and SQL filter helpers shared by the workspace MCP tools.

use sqlx::{QueryBuilder, Sqlite};

const DEFAULT_LIMIT: i64 = 25;
const MAX_LIMIT: i64 = 50;
const DEFAULT_SNIPPET_CHARS: i64 = 400;
const MAX_SNIPPET_CHARS: i64 = 2_000;

pub(super) fn limit_from_args(args: &serde_json::Value) -> i64 {
    args.get("limit")
        .and_then(serde_json::Value::as_i64)
        .unwrap_or(DEFAULT_LIMIT)
        .clamp(1, MAX_LIMIT)
}

pub(super) fn snippet_chars_from_args(args: &serde_json::Value) -> i64 {
    args.get("snippet_chars")
        .and_then(serde_json::Value::as_i64)
        .unwrap_or(DEFAULT_SNIPPET_CHARS)
        .clamp(1, MAX_SNIPPET_CHARS)
}

pub(super) fn i64_array(args: &serde_json::Value, key: &str) -> Vec<i64> {
    args.get(key)
        .and_then(serde_json::Value::as_array)
        .map(|values| {
            values
                .iter()
                .filter_map(serde_json::Value::as_i64)
                .collect()
        })
        .unwrap_or_default()
}

pub(super) fn string_array(args: &serde_json::Value, key: &str) -> Vec<String> {
    args.get(key)
        .and_then(serde_json::Value::as_array)
        .map(|values| {
            values
                .iter()
                .filter_map(serde_json::Value::as_str)
                .map(ToString::to_string)
                .collect()
        })
        .unwrap_or_default()
}

pub(super) fn trimmed_string(args: &serde_json::Value, key: &str) -> Option<String> {
    args.get(key)
        .and_then(serde_json::Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(ToString::to_string)
}

pub(super) fn cursor_before_message_id(args: &serde_json::Value) -> Option<i64> {
    args.get("cursor")
        .and_then(|cursor| cursor.get("before_message_id"))
        .and_then(serde_json::Value::as_i64)
}

pub(super) fn push_i64_filter(builder: &mut QueryBuilder<Sqlite>, column: &str, values: &[i64]) {
    if values.is_empty() {
        return;
    }
    builder.push(" AND ").push(column).push(" IN (");
    for (index, value) in values.iter().enumerate() {
        if index > 0 {
            builder.push(", ");
        }
        builder.push_bind(*value);
    }
    builder.push(")");
}

pub(super) fn push_string_filter(
    builder: &mut QueryBuilder<Sqlite>,
    column: &str,
    values: &[String],
) {
    if values.is_empty() {
        return;
    }
    builder.push(" AND ").push(column).push(" IN (");
    for (index, value) in values.iter().enumerate() {
        if index > 0 {
            builder.push(", ");
        }
        builder.push_bind(value.clone());
    }
    builder.push(")");
}
