//! Parse an oversized JSONL record with serde, retaining only journal metadata.
mod evidence;
mod strings;

use std::fs::File;
use std::io::{self, BufReader, Read, Seek, SeekFrom};
use std::ops::Range;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

use serde::de::{IgnoredAny, SeqAccess, Visitor};
use serde::{Deserialize, Deserializer, Serialize};
use serde_json::Value;
use tokio::sync::{oneshot, Semaphore};

use self::strings::CappedStrings;
use super::report::ReportEvidence;

const MAX_CALLS: usize = 128;
static DECODERS: Semaphore = Semaphore::const_new(4);

pub(super) struct ProjectedRow {
    pub(super) value: Value,
    pub(super) content_truncated: bool,
    pub(super) report: ReportEvidence,
}

impl ProjectedRow {
    pub(super) fn from_value(value: Value) -> Self {
        Self {
            report: ReportEvidence::from_value(&value),
            value,
            content_truncated: false,
        }
    }
}

pub(super) struct PendingRow {
    source: Option<(File, Range<u64>)>,
    result: Option<oneshot::Receiver<Option<ProjectedRow>>>,
    cancelled: Arc<AtomicBool>,
}

impl PendingRow {
    pub(super) fn new(file: File, range: Range<u64>) -> Self {
        Self {
            source: Some((file, range)),
            result: None,
            cancelled: Arc::default(),
        }
    }

    pub(super) fn poll(&mut self) -> Option<Option<ProjectedRow>> {
        if let Some(result) = self.result.as_mut() {
            return match result.try_recv() {
                Ok(row) => Some(row),
                Err(oneshot::error::TryRecvError::Closed) => Some(None),
                Err(oneshot::error::TryRecvError::Empty) => None,
            };
        }
        let permit = DECODERS.try_acquire().ok()?;
        let (file, range) = self.source.take()?;
        let (sender, result) = oneshot::channel();
        let cancelled = Arc::clone(&self.cancelled);
        self.result = Some(result);
        tokio::task::spawn_blocking(move || {
            let _permit = permit;
            let row = decode(file, range, cancelled);
            // The cursor can close while the decode is running.
            drop(sender.send(row));
        });
        None
    }
}

impl Drop for PendingRow {
    fn drop(&mut self) {
        self.cancelled.store(true, Ordering::Relaxed);
    }
}

fn decode(mut file: File, range: Range<u64>, cancelled: Arc<AtomicBool>) -> Option<ProjectedRow> {
    file.seek(SeekFrom::Start(range.start)).ok()?;
    let read = CancelRead {
        inner: file.take(range.end - range.start),
        cancelled,
    };
    let mut filtered = CappedStrings::new(BufReader::new(read));
    let row: JournalFields = serde_json::from_reader(&mut filtered).ok()?;
    let (reader, evidence) = filtered.into_parts();
    if !reader.buffer().is_empty() || reader.into_inner().inner.limit() != 0 {
        return None;
    }
    Some(ProjectedRow {
        value: serde_json::to_value(row).ok()?,
        content_truncated: evidence.content_truncated,
        report: evidence.report,
    })
}

struct CancelRead {
    inner: io::Take<File>,
    cancelled: Arc<AtomicBool>,
}

impl Read for CancelRead {
    fn read(&mut self, buf: &mut [u8]) -> io::Result<usize> {
        if self.cancelled.load(Ordering::Relaxed) {
            return Err(io::Error::other("Antigravity journal read cancelled"));
        }
        self.inner.read(buf)
    }
}

#[derive(Deserialize, Serialize)]
struct JournalFields {
    step_index: u64,
    source: String,
    #[serde(rename = "type")]
    kind: String,
    status: String,
    content: Option<String>,
    model: Option<String>,
    input_tokens: Option<u64>,
    output_tokens: Option<u64>,
    cache_read_tokens: Option<u64>,
    #[serde(default, deserialize_with = "tool_calls")]
    tool_calls: Option<Vec<ToolCall>>,
}

#[derive(Deserialize, Serialize)]
struct ToolCall {
    name: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    args: Option<ToolArguments>,
}

#[derive(Deserialize, Serialize)]
struct ToolArguments {
    #[serde(rename = "Recipient", skip_serializing_if = "Option::is_none")]
    recipient: Option<String>,
    #[serde(rename = "Message", skip_serializing_if = "Option::is_none")]
    message: Option<String>,
    #[serde(rename = "IsDaemon", skip_serializing_if = "Option::is_none")]
    is_daemon: Option<bool>,
    #[serde(rename = "CommandLine", skip_serializing_if = "Option::is_none")]
    command_line: Option<String>,
    #[serde(rename = "CronExpression", skip_serializing_if = "Option::is_none")]
    cron_expression: Option<String>,
}

fn tool_calls<'de, D: Deserializer<'de>>(de: D) -> Result<Option<Vec<ToolCall>>, D::Error> {
    struct Calls;

    impl<'de> Visitor<'de> for Calls {
        type Value = Option<Vec<ToolCall>>;

        fn expecting(&self, fmt: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
            fmt.write_str("a list of Antigravity tool calls")
        }

        fn visit_none<E: serde::de::Error>(self) -> Result<Self::Value, E> {
            Ok(None)
        }

        fn visit_some<D: Deserializer<'de>>(self, de: D) -> Result<Self::Value, D::Error> {
            de.deserialize_seq(self)
        }

        fn visit_seq<A: SeqAccess<'de>>(self, mut seq: A) -> Result<Self::Value, A::Error> {
            let mut calls = Vec::new();
            while calls.len() < MAX_CALLS {
                let Some(call) = seq.next_element()? else {
                    return Ok(Some(calls));
                };
                calls.push(call);
            }
            while seq.next_element::<IgnoredAny>()?.is_some() {}
            Ok(Some(calls))
        }
    }

    de.deserialize_option(Calls)
}

#[cfg(test)]
mod tests {
    use std::fs;

    use serde_json::json;

    use super::super::cursor::READ_BUDGET;
    use super::*;

    fn project(text: &str) -> Option<ProjectedRow> {
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join("transcript");
        fs::write(&path, text).unwrap();
        decode(
            File::open(path).unwrap(),
            0..text.len() as u64,
            Arc::default(),
        )
    }

    #[test]
    fn preserves_metadata_after_oversized_content_and_tool_arguments() {
        let text = format!(
            r#"{{"content": "Done {}","tool_calls":[{{"args":{{"Data":"{}"}},"name":"read_file"}}],"step_index":19,"source":"MODEL","type":"PLANNER_RESPONSE","status":"DONE","model":"test","input_tokens":12,"output_tokens":5}}"#,
            "🙂".repeat(READ_BUDGET / 4),
            "x".repeat(READ_BUDGET),
        );
        let record = project(&text).unwrap();
        assert!(record.content_truncated);
        assert_eq!(record.value["step_index"], 19);
        assert_eq!(record.value["output_tokens"], 5);
        assert_eq!(record.value["tool_calls"][0]["name"], "read_file");
        assert!(record.value["content"]
            .as_str()
            .unwrap()
            .starts_with("Done 🙂"));
    }

    #[test]
    fn matches_report_digests_across_escaped_and_unescaped_journal_strings() {
        let sender = "aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa";
        let message = "Passed 🙂\nLiteral </SYSTEM_MESSAGE> in the report";
        let mut sent = json!({
            "step_index":1,"source":"MODEL","type":"PLANNER_RESPONSE","status":"DONE",
            "tool_calls":[{"name":"send_message","args":{"Message":message}}]
        });
        let short = ProjectedRow::from_value(sent.clone());
        sent["ignored"] = json!({
            "data":"x".repeat(READ_BUDGET),
            "tool_calls":[{"args":{"Message":"A different report"}}]
        });
        let encoded = sent.to_string().replace('🙂', r"\ud83d\ude42");
        assert_eq!(project(&encoded).unwrap().report.sent, short.report.sent);

        let delivered = json!({
            "step_index":2,"source":"SYSTEM","type":"SYSTEM_MESSAGE","status":"DONE",
            "content":format!("<SYSTEM_MESSAGE>\n[Message] timestamp=t sender={sender} priority=high content=\u{2003}{message}\n</SYSTEM_MESSAGE>\t"),
            "ignored":"x".repeat(READ_BUDGET),
        });
        let encoded = delivered
            .to_string()
            .replace('<', r"\u003c")
            .replace('>', r"\u003e");
        let report = project(&encoded).unwrap().report.delivered.unwrap();
        assert_eq!(report.sender, sender);
        assert_eq!(Some(report.digest), short.report.sent);
    }

    #[test]
    fn rejects_invalid_json_after_the_visible_prefix() {
        let text = format!(
            r#"{{"step_index":19,"source":"MODEL","type":"PLANNER_RESPONSE","status":"DONE","content":"{}\x"}}"#,
            "x".repeat(READ_BUDGET)
        );
        assert!(project(&text).is_none());
        let malformed = format!(
            r#"{{"step_index":19,"source":"MODEL","type":"PLANNER_RESPONSE","status":"DONE","ignored": ["{}",]}}"#,
            "x".repeat(READ_BUDGET)
        );
        assert!(project(&malformed).is_none());
        let valid = format!(
            r#"{{"step_index":19,"source":"MODEL","type":"PLANNER_RESPONSE","status":"DONE","ignored":["{}"]}}"#,
            "x".repeat(READ_BUDGET)
        );
        assert_eq!(project(&valid).unwrap().value["status"], json!("DONE"));
    }

    #[test]
    fn limits_depth_even_in_unprojected_fields() {
        let text = format!(
            r#"{{"step_index":19,"source":"MODEL","type":"PLANNER_RESPONSE","status":"DONE","ignored":{}null{}}}"#,
            "[".repeat(256),
            "]".repeat(256),
        );
        assert!(project(&text).is_none());
    }
}
