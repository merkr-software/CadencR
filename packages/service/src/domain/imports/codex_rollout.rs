use std::ffi::OsString;
use std::path::{Path, PathBuf};

use serde_json::Value;

use super::types::{truncate_title, ImportedConversation, ImportedMessage};
use crate::domain::agents::codex::function_tool_name as codex_function_tool_name;

pub(crate) fn codex_sessions_dir() -> Option<PathBuf> {
    resolve_codex_sessions_dir(std::env::var_os("CODEX_HOME"), dirs::home_dir())
}

fn resolve_codex_sessions_dir(
    codex_home: Option<OsString>,
    home: Option<PathBuf>,
) -> Option<PathBuf> {
    codex_home
        .filter(|value| !value.is_empty())
        .map(PathBuf::from)
        .map(|path| path.join("sessions"))
        .or_else(|| home.map(|path| path.join(".codex").join("sessions")))
}

pub(crate) fn list_rollout_files(root: &Path) -> std::io::Result<Vec<PathBuf>> {
    let mut out = Vec::new();
    collect_rollouts(root, &mut out)?;
    out.sort();
    Ok(out)
}

pub fn list_project_conversations(
    project_path: &str,
) -> std::io::Result<Vec<ImportedConversation>> {
    let Some(root) = codex_sessions_dir() else {
        return Ok(Vec::new());
    };
    let files = list_rollout_files(&root)?;
    let mut out = Vec::new();
    for file in files {
        match parse_codex_rollout_file(&file, project_path) {
            Ok(Some(conv)) => out.push(conv),
            Ok(None) => {}
            Err(err) => tracing::warn!(
                file = %file.display(),
                error = %err,
                "failed to parse Codex rollout — skipping"
            ),
        }
    }
    out.sort_by(|a, b| b.modified_at.cmp(&a.modified_at));
    Ok(out)
}

pub fn load_project_conversation_by_id(
    project_path: &str,
    source_session_id: &str,
) -> std::io::Result<Option<ImportedConversation>> {
    let Some(root) = codex_sessions_dir() else {
        return Ok(None);
    };
    for file in list_rollout_files(&root)? {
        let Some(conv) = parse_codex_rollout_file(&file, project_path)? else {
            continue;
        };
        if conv.source_session_id == source_session_id {
            return Ok(Some(conv));
        }
    }
    Ok(None)
}

pub fn parse_codex_rollout_file(
    path: &Path,
    project_path: &str,
) -> std::io::Result<Option<ImportedConversation>> {
    let raw = std::fs::read_to_string(path)?;
    let mut source_session_id: Option<String> = None;
    let mut cwd: Option<String> = None;
    let mut first_user_text: Option<String> = None;
    let mut messages = Vec::new();
    let mut first_timestamp: Option<String> = None;
    let mut last_timestamp: Option<String> = None;
    let mut model: Option<String> = None;

    for line in raw.lines() {
        let trimmed = line.trim();
        if trimmed.is_empty() {
            continue;
        }
        let value: Value = match serde_json::from_str(trimmed) {
            Ok(value) => value,
            Err(err) => {
                tracing::warn!(file = %path.display(), error = %err, "skipping malformed Codex rollout line");
                continue;
            }
        };
        let ts = value
            .get("timestamp")
            .and_then(Value::as_str)
            .map(ToOwned::to_owned);
        if let Some(ts) = &ts {
            if first_timestamp.is_none() {
                first_timestamp = Some(ts.clone());
            }
            last_timestamp = Some(ts.clone());
        }

        let line_type = value.get("type").and_then(Value::as_str).unwrap_or("");
        let payload = envelope_payload(&value);
        if line_type == "turn_context" {
            model = string_field(payload, &["model"]).or(model);
            continue;
        }
        if line_type == "session_meta" || item_type(payload) == Some("session_meta") {
            let meta = payload.get("meta").unwrap_or(payload);
            if is_cadencr_feature_naming_session(meta) {
                return Ok(None);
            }
            source_session_id = string_field(meta, &["id", "session_id"]).or(source_session_id);
            cwd = string_field(meta, &["cwd"]).or(cwd);
            continue;
        }

        parse_rollout_payload(
            rollout_item_payload(payload),
            ts.as_deref(),
            &mut messages,
            &mut first_user_text,
        );
    }

    if cwd.as_deref() != Some(project_path) || messages.is_empty() {
        return Ok(None);
    }
    let source_session_id = source_session_id.unwrap_or_else(|| fallback_id_from_path(path));
    let title = first_user_text
        .map(|text| truncate_title(&text))
        .unwrap_or_else(|| {
            let prefix: String = source_session_id.chars().take(8).collect();
            format!("Codex session {prefix}")
        });
    Ok(Some(ImportedConversation {
        source_session_id,
        title,
        model,
        started_at: first_timestamp.clone(),
        modified_at: last_timestamp.or(first_timestamp),
        messages,
    }))
}

fn collect_rollouts(dir: &Path, out: &mut Vec<PathBuf>) -> std::io::Result<()> {
    let entries = match std::fs::read_dir(dir) {
        Ok(entries) => entries,
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Err(err) => return Err(err),
    };
    for entry in entries {
        let entry = entry?;
        let file_type = entry.file_type()?;
        if file_type.is_symlink() {
            continue;
        }
        let path = entry.path();
        if file_type.is_dir() {
            collect_rollouts(&path, out)?;
        } else if file_type.is_file()
            && path
                .file_name()
                .and_then(|name| name.to_str())
                .is_some_and(|name| name.starts_with("rollout-") && name.ends_with(".jsonl"))
        {
            out.push(path);
        }
    }
    Ok(())
}

fn parse_rollout_payload(
    payload: &Value,
    timestamp: Option<&str>,
    messages: &mut Vec<ImportedMessage>,
    first_user_text: &mut Option<String>,
) {
    match item_type(payload) {
        Some("message") => parse_message_item(payload, timestamp, messages, first_user_text),
        Some("reasoning") => parse_reasoning_item(payload, timestamp, messages),
        Some("function_call") => parse_function_call(payload, timestamp, messages),
        Some("function_call_output") => parse_function_output(payload, timestamp, messages),
        _ => {}
    }
}

fn envelope_payload(value: &Value) -> &Value {
    value
        .get("payload")
        .or_else(|| value.get("item"))
        .unwrap_or(&Value::Null)
}

fn rollout_item_payload(payload: &Value) -> &Value {
    payload.get("item").unwrap_or(payload)
}

fn parse_message_item(
    item: &Value,
    timestamp: Option<&str>,
    messages: &mut Vec<ImportedMessage>,
    first_user_text: &mut Option<String>,
) {
    let role = item
        .get("role")
        .and_then(Value::as_str)
        .unwrap_or("assistant");
    if !matches!(role, "assistant" | "user") {
        return;
    }
    let Some(content) = item.get("content").and_then(Value::as_array) else {
        return;
    };
    for block in content {
        let Some(text) = text_from_content_block(block) else {
            continue;
        };
        if role == "user" && is_codex_internal_user_text(&text) {
            continue;
        }
        if role == "user" && first_user_text.is_none() && !text.trim().is_empty() {
            *first_user_text = Some(text.clone());
        }
        messages.push(ImportedMessage {
            role: role.to_string(),
            content: text,
            message_type: "text".to_string(),
            tool_name: None,
            tool_use_id: None,
            model: None,
            created_at: timestamp.map(ToOwned::to_owned),
        });
    }
}

fn is_cadencr_feature_naming_session(meta: &Value) -> bool {
    meta.get("base_instructions")
        .and_then(|base| base.get("text"))
        .and_then(Value::as_str)
        .is_some_and(|text| text.contains("You are a feature naming assistant"))
}

fn is_codex_internal_user_text(text: &str) -> bool {
    let trimmed = text.trim_start();
    trimmed.starts_with("# AGENTS.md instructions for ")
        || trimmed.starts_with("<environment_context>")
        || trimmed.starts_with("Now name this session. User's first message:")
}

fn parse_reasoning_item(
    item: &Value,
    timestamp: Option<&str>,
    messages: &mut Vec<ImportedMessage>,
) {
    let text = item
        .get("summary")
        .and_then(Value::as_array)
        .map(|parts| {
            parts
                .iter()
                .filter_map(text_from_content_block)
                .collect::<Vec<_>>()
                .join("\n")
        })
        .filter(|text| !text.trim().is_empty())
        .or_else(|| string_field(item, &["text", "content"]));
    let Some(text) = text else {
        return;
    };
    messages.push(ImportedMessage {
        role: "assistant".to_string(),
        content: text,
        message_type: "thinking".to_string(),
        tool_name: None,
        tool_use_id: None,
        model: None,
        created_at: timestamp.map(ToOwned::to_owned),
    });
}

fn parse_function_call(item: &Value, timestamp: Option<&str>, messages: &mut Vec<ImportedMessage>) {
    let tool_use_id = string_field(item, &["call_id", "callId", "id"]);
    let tool_name = item
        .get("name")
        .and_then(Value::as_str)
        .filter(|name| !name.is_empty())
        .map(|_| codex_function_tool_name(item));
    let content = item
        .get("arguments")
        .and_then(Value::as_str)
        .map(ToOwned::to_owned)
        .or_else(|| item.get("arguments").map(Value::to_string))
        .unwrap_or_default();
    messages.push(ImportedMessage {
        role: "assistant".to_string(),
        content,
        message_type: "tool_call".to_string(),
        tool_name,
        tool_use_id,
        model: None,
        created_at: timestamp.map(ToOwned::to_owned),
    });
}

fn parse_function_output(
    item: &Value,
    timestamp: Option<&str>,
    messages: &mut Vec<ImportedMessage>,
) {
    let content = item
        .get("output")
        .and_then(Value::as_str)
        .map(ToOwned::to_owned)
        .or_else(|| item.get("output").map(Value::to_string))
        .unwrap_or_default();
    messages.push(ImportedMessage {
        role: "tool".to_string(),
        content,
        message_type: "tool_result".to_string(),
        tool_name: None,
        tool_use_id: string_field(item, &["call_id", "callId", "id"]),
        model: None,
        created_at: timestamp.map(ToOwned::to_owned),
    });
}

fn text_from_content_block(block: &Value) -> Option<String> {
    string_field(block, &["text", "content"])
}

fn item_type(value: &Value) -> Option<&str> {
    value.get("type").and_then(Value::as_str)
}

fn string_field(value: &Value, keys: &[&str]) -> Option<String> {
    keys.iter()
        .find_map(|key| value.get(*key).and_then(Value::as_str))
        .map(ToOwned::to_owned)
}

fn fallback_id_from_path(path: &Path) -> String {
    path.file_stem()
        .and_then(|stem| stem.to_str())
        .unwrap_or("codex")
        .trim_start_matches("rollout-")
        .to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn blank_codex_home_falls_back_to_the_user_home() {
        assert_eq!(
            resolve_codex_sessions_dir(Some(OsString::new()), Some(PathBuf::from("/home/cadencr"))),
            Some(PathBuf::from("/home/cadencr/.codex/sessions"))
        );
    }

    fn write_rollout(lines: &[&str]) -> tempfile::NamedTempFile {
        let file = tempfile::NamedTempFile::new().unwrap();
        std::fs::write(file.path(), lines.join("\n")).unwrap();
        file
    }

    fn import(file: &tempfile::NamedTempFile) -> ImportedConversation {
        let parsed = parse_codex_rollout_file(file.path(), "/repo").unwrap();
        parsed.unwrap()
    }

    #[test]
    fn parse_codex_rollout_filters_by_session_meta_cwd_and_extracts_messages() {
        let file = write_rollout(&[
            r#"{"timestamp":"2026-05-27T12:00:00.000Z","type":"session_meta","payload":{"id":"codex-1","cwd":"/repo","model_provider":"openai"}}"#,
            r#"{"timestamp":"2026-05-27T12:00:00.500Z","type":"turn_context","payload":{"model":"gpt-5.5"}}"#,
            r#"{"timestamp":"2026-05-27T12:00:01.000Z","type":"response_item","payload":{"type":"message","role":"user","content":[{"type":"input_text","text":"Build import"}]}}"#,
            r#"{"timestamp":"2026-05-27T12:00:02.000Z","type":"response_item","payload":{"type":"reasoning","summary":[{"type":"summary_text","text":"Think"}]}}"#,
            r#"{"timestamp":"2026-05-27T12:00:03.000Z","type":"response_item","item":{"item":{"type":"message","role":"assistant","content":[{"type":"output_text","text":"Done"}]}}}"#,
            r#"{"timestamp":"2026-05-27T12:00:04.000Z","type":"response_item","payload":{"type":"function_call","call_id":"call-1","name":"shell","arguments":"{\"cmd\":\"ls\"}"}}"#,
            r#"{"timestamp":"2026-05-27T12:00:05.000Z","type":"response_item","payload":{"type":"function_call_output","call_id":"call-1","output":"ok"}}"#,
        ]);
        let conv = import(&file);
        assert_eq!(conv.source_session_id, "codex-1");
        assert_eq!(conv.title, "Build import");
        assert_eq!(conv.model.as_deref(), Some("gpt-5.5"));
        assert_eq!(conv.messages.len(), 5);
        assert_eq!(conv.messages[3].tool_name.as_deref(), Some("Bash"));
        assert_eq!(conv.messages[4].tool_use_id.as_deref(), Some("call-1"));
    }

    #[test]
    fn parse_codex_rollout_titles_from_first_real_user_prompt() {
        let file = write_rollout(&[
            r#"{"timestamp":"2026-05-27T12:00:00.000Z","type":"session_meta","payload":{"id":"codex-3","cwd":"/repo"}}"#,
            r##"{"timestamp":"2026-05-27T12:00:01.000Z","type":"response_item","payload":{"type":"message","role":"user","content":[{"type":"input_text","text":"# AGENTS.md instructions for /repo\n\n<INSTRUCTIONS>Rules</INSTRUCTIONS>"},{"type":"input_text","text":"<environment_context>\n  <cwd>/repo</cwd>\n</environment_context>"}]}}"##,
            r#"{"timestamp":"2026-05-27T12:00:02.000Z","type":"response_item","payload":{"type":"message","role":"user","content":[{"type":"input_text","text":"Fix permission prompts"}]}}"#,
        ]);
        let conv = import(&file);
        assert_eq!(conv.title, "Fix permission prompts");
        assert_eq!(conv.messages.len(), 1);
        assert_eq!(conv.messages[0].content, "Fix permission prompts");
    }

    #[test]
    fn parse_codex_rollout_skips_cadencr_feature_naming_sessions() {
        let file = write_rollout(&[
            r#"{"timestamp":"2026-05-27T12:00:00.000Z","type":"session_meta","payload":{"id":"codex-4","cwd":"/repo","base_instructions":{"text":"You are a feature naming assistant."}}}"#,
            r#"{"timestamp":"2026-05-27T12:00:01.000Z","type":"response_item","payload":{"type":"message","role":"user","content":[{"type":"input_text","text":"Now name this session. User's first message: \"Fix permission prompts\"."}]}}"#,
        ]);
        assert!(parse_codex_rollout_file(file.path(), "/repo")
            .unwrap()
            .is_none());
    }
}
