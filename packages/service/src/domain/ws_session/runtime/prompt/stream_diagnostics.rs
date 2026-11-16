//! Per-stream wire-tap diagnostics (issue #78).
//!
//! Every silent-stop investigation so far began with "we have no idea what
//! the CLI actually sent". This keeps a bounded ring buffer of the raw
//! provider events a stream reader saw and, when a turn ends abnormally,
//! dumps the tail to a file under `~/.cadencr/diagnostics/` so the surfaced
//! error can point at concrete evidence instead of asking the user to
//! reproduce with logging enabled. Conforms to
//! `.claude/rules/inline-rust-tests.md`.

use std::collections::VecDeque;
use std::path::PathBuf;

use anyhow::Result;

/// Bounded tail of raw events kept per stream reader.
const MAX_EVENTS: usize = 200;
/// Cap per recorded event so one huge payload can't dominate the buffer.
const MAX_EVENT_CHARS: usize = 2000;

pub(in crate::domain::ws_session) struct StreamDiagnostics {
    events: VecDeque<String>,
}

impl StreamDiagnostics {
    pub(in crate::domain::ws_session) fn new() -> Self {
        Self {
            events: VecDeque::with_capacity(MAX_EVENTS),
        }
    }

    /// Record one raw provider event (newest last, oldest evicted). Called for
    /// every streamed event, so the common (small) payload must stay cheap:
    /// byte length ≥ char count for UTF-8, so the O(1) `len()` guard skips the
    /// O(n) char scan unless the payload actually exceeds the cap.
    pub(in crate::domain::ws_session) fn record(&mut self, raw: &serde_json::Value) {
        let serialized = raw.to_string();
        let entry: String =
            if serialized.len() > MAX_EVENT_CHARS && serialized.chars().count() > MAX_EVENT_CHARS {
                let mut truncated: String = serialized.chars().take(MAX_EVENT_CHARS).collect();
                truncated.push_str("… (truncated)");
                truncated
            } else {
                serialized
            };
        if self.events.len() == MAX_EVENTS {
            self.events.pop_front();
        }
        self.events.push_back(entry);
    }

    /// Write the recorded tail to a diagnostics file and return its path.
    /// Returns an `Err` when writing fails so the caller can note that in the
    /// surfaced session error instead of swallowing it — surfacing the original
    /// agent error must never *depend* on this file, but a failed dump is still
    /// a failure the user should hear about.
    ///
    /// The dump contains raw provider events (user prompts, tool inputs), so the
    /// directory and file are created owner-only (`0700`/`0600` on Unix) — under
    /// the common `umask 022` a plain write would be world-readable.
    pub(in crate::domain::ws_session) fn dump(
        &self,
        db_session_id: i64,
        reason: &str,
        error_detail: Option<&str>,
    ) -> Result<PathBuf> {
        let dir = diagnostics_dir();
        crate::remote::secure_fs::create_dir_owner_only(&dir)?;
        let timestamp = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_secs())
            .unwrap_or(0);
        let path = dir.join(format!("session-{db_session_id}-{timestamp}.log"));

        let mut content = format!(
            "Cadencr agent-stream diagnostics\nsession: {db_session_id}\nreason: {reason}\n"
        );
        if let Some(detail) = error_detail {
            content.push_str(&format!("error: {detail}\n"));
        }
        content.push_str(&format!(
            "--- last {} provider events (newest last) ---\n",
            self.events.len()
        ));
        for event in &self.events {
            content.push_str(event);
            content.push('\n');
        }

        // `write_secret` creates the file `0600` from the first byte (no
        // world-readable window under the default umask).
        crate::remote::secure_fs::write_secret(&path, content.as_bytes())?;
        Ok(path)
    }
}

/// `~/.cadencr/diagnostics` in production (sibling of the settings dir); an
/// isolated per-test dir in test builds via the settings-dir test override.
fn diagnostics_dir() -> PathBuf {
    crate::domain::settings_store::dir::cache_sibling_dir("diagnostics")
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::{StreamDiagnostics, MAX_EVENTS};

    #[test]
    fn record_keeps_only_the_newest_events() {
        let mut diagnostics = StreamDiagnostics::new();
        for i in 0..(MAX_EVENTS + 10) {
            diagnostics.record(&json!({ "type": "stream_event", "n": i }));
        }
        assert_eq!(diagnostics.events.len(), MAX_EVENTS);
        assert!(
            diagnostics
                .events
                .back()
                .unwrap()
                .contains(&format!("\"n\":{}", MAX_EVENTS + 9)),
            "newest event must be kept"
        );
        assert!(
            diagnostics.events.front().unwrap().contains("\"n\":10"),
            "oldest events must be evicted"
        );
    }

    #[test]
    fn record_truncates_oversized_events() {
        let mut diagnostics = StreamDiagnostics::new();
        diagnostics.record(&json!({ "type": "assistant", "text": "x".repeat(10_000) }));
        let entry = diagnostics.events.front().unwrap();
        assert!(entry.chars().count() < 3000);
        assert!(entry.ends_with("… (truncated)"));
    }

    #[test]
    fn dump_writes_reason_error_and_events() {
        let mut diagnostics = StreamDiagnostics::new();
        diagnostics.record(&json!({ "type": "stream_event", "marker": "evt-1" }));
        let path = diagnostics
            .dump(42, "AGENT_STOPPED", Some("boom"))
            .expect("dump must write");
        let content = std::fs::read_to_string(&path).expect("dump file readable");
        assert!(content.contains("session: 42"));
        assert!(content.contains("reason: AGENT_STOPPED"));
        assert!(content.contains("error: boom"));
        assert!(content.contains("evt-1"));
    }
}
