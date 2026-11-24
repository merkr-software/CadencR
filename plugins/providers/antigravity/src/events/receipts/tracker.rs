//! Tail the root session's native `transcript_full.jsonl` while tracked prompts
//! are awaiting delivery.

use std::borrow::Cow;
use std::collections::HashMap;
use std::fs::File;
use std::ops::Range;
use std::path::PathBuf;

use serde::Deserialize;
use serde_json::Value;

use super::{ObservedUserInput, ReceiptOperation};
use crate::events::subagents::{parent_transcript, read_exact_at, JournalCursor, SeekOutcome};

const USER_REQUEST_OPEN: &str = "<USER_REQUEST>";
const USER_REQUEST_CLOSE: &str = "</USER_REQUEST>";
const USER_REQUEST_CLOSE_META_LF: &str = "</USER_REQUEST>\n<ADDITIONAL_METADATA>";
const USER_REQUEST_CLOSE_META_CRLF: &str = "</USER_REQUEST>\r\n<ADDITIONAL_METADATA>";
const OVERSIZED_EDGE_BYTES: usize = 4 * 1024;
const USER_INPUT_MARKER: &[u8] = b"USER_INPUT";
const USER_EXPLICIT_MARKER: &[u8] = b"USER_EXPLICIT";

struct TranscriptUserInput {
    step_index: u64,
    content: String,
    truncated: bool,
}

#[derive(Deserialize)]
struct UserInputRow<'a> {
    step_index: u64,
    #[serde(borrow)]
    source: Cow<'a, str>,
    #[serde(rename = "type", borrow)]
    kind: Cow<'a, str>,
    #[serde(borrow)]
    status: Cow<'a, str>,
    #[serde(default)]
    content: Option<String>,
}

impl UserInputRow<'_> {
    fn into_transcript_input(self, truncated: bool) -> Option<TranscriptUserInput> {
        if self.source != "USER_EXPLICIT" || self.kind != "USER_INPUT" || self.status != "DONE" {
            return None;
        }
        Some(TranscriptUserInput {
            step_index: self.step_index,
            content: self.content.unwrap_or_default(),
            truncated,
        })
    }
}

pub(crate) struct ReceiptTracker {
    brain: Option<PathBuf>,
    sessions: HashMap<String, WatchedSession>,
}

#[derive(Default)]
struct WatchedSession {
    cursor: JournalCursor,
    watch_id: u64,
    watching: bool,
    pending_baseline: Option<u64>,
    last_step_index: Option<u64>,
}

impl ReceiptTracker {
    pub(crate) fn with_brain(brain: Option<PathBuf>) -> Self {
        Self {
            brain,
            sessions: HashMap::new(),
        }
    }

    pub(crate) fn is_watching(&self) -> bool {
        self.sessions.values().any(|session| session.watching)
    }

    /// Apply queued receipt lifecycle transitions in memory without filesystem I/O.
    /// Returns `true` when at least one session started or refreshed watching and
    /// remains watching after the batch completes.
    pub(crate) fn apply_operations(&mut self, operations: Vec<ReceiptOperation>) -> bool {
        if self.brain.is_none() {
            return false;
        }
        let mut woke = false;
        for operation in operations {
            match operation {
                ReceiptOperation::Watch {
                    session,
                    watch_id,
                    baseline_len,
                } => {
                    let watched = self.sessions.entry(session).or_default();
                    watched.watching = true;
                    watched.watch_id = watch_id;
                    if let Some(len) = baseline_len {
                        watched.pending_baseline = Some(len);
                    }
                    woke = true;
                }
                ReceiptOperation::Stop(session) => {
                    if let Some(watched) = self.sessions.get_mut(&session) {
                        // Preserve any unconsumed pending_baseline so a later steer in the
                        // same turn still seeks past prior history rather than reading from 0.
                        watched.watching = false;
                    }
                }
                ReceiptOperation::Closed(session) => {
                    self.sessions.remove(&session);
                }
            }
        }
        woke && self.is_watching()
    }

    pub(crate) fn poll_watched(&mut self) -> Vec<ObservedUserInput> {
        let Some(brain) = self.brain.as_deref() else {
            return Vec::new();
        };
        let mut observed = Vec::new();
        for (session_id, session) in &mut self.sessions {
            if !session.watching {
                continue;
            }
            let Some(path) = parent_transcript(brain, session_id) else {
                continue;
            };
            if let Some(len) = session.pending_baseline.take() {
                session.last_step_index = match session.cursor.seek_to_offset(&path, len) {
                    SeekOutcome::Positioned(step) => step.or(session.last_step_index),
                    SeekOutcome::Reset => None,
                };
            }
            let rows = session.cursor.read_filtered(
                &path,
                oversized_mentions_user_input,
                parse_user_input_line,
                parse_projected_user_input,
            );
            for row in rows {
                if session
                    .last_step_index
                    .is_some_and(|last| row.step_index <= last)
                {
                    continue;
                }
                session.last_step_index = Some(row.step_index);
                let text = extract_user_request_text(&row.content, row.truncated).to_owned();
                observed.push(ObservedUserInput {
                    session: session_id.clone(),
                    watch_id: session.watch_id,
                    text,
                    truncated: row.truncated,
                });
            }
        }
        observed
    }

    #[cfg(test)]
    pub(super) fn poll(&mut self, operations: Vec<ReceiptOperation>) -> Vec<ObservedUserInput> {
        self.apply_operations(operations);
        self.poll_watched()
    }

    #[cfg(test)]
    pub(super) fn tracked_session_count(&self) -> usize {
        self.sessions.len()
    }
}

fn parse_user_input_line(line: &[u8]) -> Option<TranscriptUserInput> {
    if !contains_bytes(line, USER_INPUT_MARKER) || !contains_bytes(line, USER_EXPLICIT_MARKER) {
        return None;
    }
    serde_json::from_slice::<UserInputRow<'_>>(line)
        .ok()?
        .into_transcript_input(false)
}

fn parse_projected_user_input(value: Value, truncated: bool) -> Option<TranscriptUserInput> {
    UserInputRow::deserialize(&value)
        .ok()?
        .into_transcript_input(truncated)
}

fn oversized_mentions_user_input(file: &mut File, range: Range<u64>) -> bool {
    let len = range.end.saturating_sub(range.start);
    let head_len = (len as usize).min(OVERSIZED_EDGE_BYTES);
    let mut buf = [0u8; OVERSIZED_EDGE_BYTES];
    let mut has_input = false;
    let mut has_explicit = false;
    if read_exact_at(file, range.start, &mut buf[..head_len]) {
        has_input = contains_bytes(&buf[..head_len], USER_INPUT_MARKER);
        has_explicit = contains_bytes(&buf[..head_len], USER_EXPLICIT_MARKER);
        if has_input && has_explicit {
            return true;
        }
    }
    if len <= OVERSIZED_EDGE_BYTES as u64 {
        return false;
    }
    let tail_start = range.end - OVERSIZED_EDGE_BYTES as u64;
    if read_exact_at(file, tail_start, &mut buf) {
        has_input |= contains_bytes(&buf, USER_INPUT_MARKER);
        has_explicit |= contains_bytes(&buf, USER_EXPLICIT_MARKER);
    }
    has_input && has_explicit
}

fn contains_bytes(haystack: &[u8], needle: &[u8]) -> bool {
    haystack
        .windows(needle.len())
        .any(|window| window == needle)
}

/// Extract the raw user prompt from Antigravity's `<USER_REQUEST>` wrapper.
/// Truncated oversized prefixes skip closing-tag stripping so literal
/// `</USER_REQUEST>` lines inside the prompt prefix are never cut short.
pub(super) fn extract_user_request_text(content: &str, truncated: bool) -> &str {
    let body = content
        .strip_prefix(USER_REQUEST_OPEN)
        .map(|rest| {
            rest.strip_prefix("\r\n")
                .or_else(|| rest.strip_prefix('\n'))
                .unwrap_or(rest)
        })
        .unwrap_or(content);
    if truncated {
        return body;
    }
    if let Some((request, _)) = body
        .rsplit_once(USER_REQUEST_CLOSE_META_LF)
        .or_else(|| body.rsplit_once(USER_REQUEST_CLOSE_META_CRLF))
        .or_else(|| body.rsplit_once(USER_REQUEST_CLOSE))
    {
        return request
            .strip_suffix("\r\n")
            .or_else(|| request.strip_suffix('\n'))
            .unwrap_or(request);
    }
    body
}
