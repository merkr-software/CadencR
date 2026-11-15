//! What custom tabs ran, so the user can see it (`docs/CUSTOM_TABS.md` §4.6).
//!
//! Every `exec.run` a tab asks for — run, refused or failed — is recorded per
//! tab and conversation, newest first, in memory only. The renderer shows it
//! in the tab's **Activity** dialog; nothing here is ever sent to a tab.

use std::borrow::Cow;
use std::collections::{HashMap, VecDeque};
use std::sync::{Arc, Mutex, MutexGuard};

use serde::Serialize;
use utoipa::ToSchema;

/// Records kept per tab and conversation.
pub const MAX_RECORDS: usize = 50;
/// Characters of a command's arguments kept in its record, all arguments
/// together: a request may carry far more (`exec::MAX_ARGS_BYTES`).
pub const MAX_RECORDED_ARGS_CHARS: usize = 1024;
/// Characters of a program name kept, in its record and its logs: a request
/// is recorded before its name is checked (a valid one has at most 64).
pub const MAX_RECORDED_PROGRAM_CHARS: usize = 128;
/// Characters of a refusal or failure message kept in its record.
const MAX_RECORDED_ERROR_CHARS: usize = 1024;

/// How one requested command ended.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, ToSchema)]
#[serde(rename_all = "snake_case")]
pub enum PluginTabExecOutcome {
    /// It ran to completion; see `exit_code`.
    Exited,
    /// Not in the tab's `commands`, or refused before it started.
    Refused,
    /// It ran past its timeout and was killed.
    TimedOut,
    /// It could not start, or its output was too large.
    Failed,
}

/// One command a tab asked Cadencr to run.
#[derive(Debug, Clone, Serialize, ToSchema)]
pub struct PluginTabExecRecord {
    pub program: String,
    /// At most [`MAX_RECORDED_ARGS_CHARS`] characters; a cut argument ends
    /// with `…` and the ones after it are left out.
    pub args: Vec<String>,
    /// RFC 3339.
    pub started_at: String,
    pub duration_ms: u64,
    pub outcome: PluginTabExecOutcome,
    pub exit_code: Option<i32>,
    /// Why it was refused or failed.
    pub error: Option<String>,
}

/// Recent commands per `(plugin, feature)`.
type ActivityByTab = HashMap<(String, i64), VecDeque<PluginTabExecRecord>>;

/// The recent commands of every tab, keyed by `(plugin, feature)`. Cheap to clone.
#[derive(Clone, Default)]
pub struct ActivityLog {
    inner: Arc<Mutex<ActivityByTab>>,
}

impl ActivityLog {
    pub fn record(&self, plugin_id: &str, feature_id: i64, mut record: PluginTabExecRecord) {
        record.args = bounded(std::mem::take(&mut record.args));
        if let Cow::Owned(program) = cut(&record.program, MAX_RECORDED_PROGRAM_CHARS) {
            record.program = program;
        }
        if let Some(Cow::Owned(error)) = record
            .error
            .as_deref()
            .map(|error| cut(error, MAX_RECORDED_ERROR_CHARS))
        {
            record.error = Some(error);
        }
        let mut log = self.lock();
        let records = log.entry((plugin_id.to_string(), feature_id)).or_default();
        records.push_front(record);
        records.truncate(MAX_RECORDS);
    }

    /// Newest first.
    pub fn recent(&self, plugin_id: &str, feature_id: i64) -> Vec<PluginTabExecRecord> {
        self.lock()
            .get(&(plugin_id.to_string(), feature_id))
            .map(|records| records.iter().cloned().collect())
            .unwrap_or_default()
    }

    fn lock(&self) -> MutexGuard<'_, HashMap<(String, i64), VecDeque<PluginTabExecRecord>>> {
        // Each operation is one push/truncate or read: a panic mid-way leaves
        // the map usable.
        self.inner
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }
}

/// `text`'s first `max` characters and `…`, when it has more.
pub fn cut(text: &str, max: usize) -> Cow<'_, str> {
    match text.char_indices().nth(max) {
        Some((end, _)) => Cow::Owned(format!("{}…", &text[..end])),
        None => Cow::Borrowed(text),
    }
}

fn bounded(args: Vec<String>) -> Vec<String> {
    let mut budget = MAX_RECORDED_ARGS_CHARS;
    let mut kept = Vec::new();
    for arg in args {
        let chars = arg.chars().count();
        if chars > budget {
            kept.push(arg.chars().take(budget).collect::<String>() + "…");
            break;
        }
        budget -= chars;
        kept.push(arg);
    }
    kept
}

#[cfg(test)]
mod tests {
    use super::*;

    fn record(program: &str) -> PluginTabExecRecord {
        PluginTabExecRecord {
            program: program.into(),
            args: vec![],
            started_at: "2026-10-18T00:00:00Z".into(),
            duration_ms: 1,
            outcome: PluginTabExecOutcome::Exited,
            exit_code: Some(0),
            error: None,
        }
    }

    #[test]
    fn keeps_the_newest_records_per_tab_and_feature() {
        let log = ActivityLog::default();
        for n in 0..(MAX_RECORDS + 5) {
            log.record("graph", 1, record(&format!("p{n}")));
        }
        log.record("graph", 2, record("other"));
        let recent = log.recent("graph", 1);
        assert_eq!(recent.len(), MAX_RECORDS);
        assert_eq!(recent[0].program, format!("p{}", MAX_RECORDS + 4));
        assert_eq!(log.recent("graph", 2).len(), 1);
        assert!(log.recent("other", 1).is_empty());
    }

    #[test]
    fn records_keep_a_bounded_command_line() {
        let log = ActivityLog::default();
        let mut long = record("git");
        long.args = vec![
            "log".into(),
            "x".repeat(MAX_RECORDED_ARGS_CHARS),
            "dropped".into(),
        ];
        log.record("graph", 1, long);
        let args = &log.recent("graph", 1)[0].args;
        assert_eq!(args.len(), 2);
        assert_eq!(args[0], "log");
        assert_eq!(args[1].chars().count(), MAX_RECORDED_ARGS_CHARS - 3 + 1);
        assert!(args[1].ends_with('…'));
        let mut huge = record(&"p".repeat(10_000));
        huge.error = Some("e".repeat(10_000));
        log.record("graph", 1, huge);
        let kept = &log.recent("graph", 1)[0];
        assert_eq!(kept.program.chars().count(), MAX_RECORDED_PROGRAM_CHARS + 1);
        assert_eq!(
            kept.error.as_ref().unwrap().chars().count(),
            MAX_RECORDED_ERROR_CHARS + 1
        );
        assert_eq!(cut("git", 3), "git");
    }
}
