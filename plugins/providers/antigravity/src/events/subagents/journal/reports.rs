use std::collections::VecDeque;
use std::path::Path;

use super::{cursor::JournalCursor, projection::ProjectedRow, report::ReportDigest};

const MAX_REPORTS: usize = 128;

/// Evidence that a root generation followed delivery of a particular child's report.
#[derive(Default)]
pub(in crate::events::subagents) struct ParentReports {
    cursor: JournalCursor,
    messages: VecDeque<(String, ReportDigest, u64)>,
    latest_reply: Option<u64>,
}

impl ParentReports {
    pub(in crate::events::subagents) fn poll(&mut self, path: &Path) {
        for record in self.cursor.read(path) {
            self.observe(record);
        }
    }

    pub(in crate::events::subagents) fn has_backlog(&self) -> bool {
        self.cursor.has_backlog()
    }

    pub(super) fn messages_for(&self, child: &str) -> Vec<(ReportDigest, u64)> {
        self.messages
            .iter()
            .filter_map(|(sender, hash, step)| (sender == child).then_some((*hash, *step)))
            .collect()
    }

    pub(super) fn acted(&self, report: ReportDigest, messages: &[(ReportDigest, u64)]) -> bool {
        self.latest_reply.is_some_and(|reply| {
            messages
                .iter()
                .any(|&(hash, step)| hash == report && step < reply)
        })
    }

    fn observe(&mut self, record: ProjectedRow) {
        let row = &record.value;
        let Some(step) = row["step_index"].as_u64() else {
            return;
        };
        if row["status"] != "DONE" {
            return;
        }
        match (row["source"].as_str(), row["type"].as_str()) {
            (Some("SYSTEM"), Some("SYSTEM_MESSAGE")) => {
                let Some(report) = record.report.delivered else {
                    return;
                };
                if !self
                    .messages
                    .iter()
                    .any(|(id, _, index)| id == &report.sender && *index == step)
                {
                    if self.messages.len() == MAX_REPORTS {
                        self.messages.pop_front();
                    }
                    self.messages
                        .push_back((report.sender, report.digest, step));
                }
            }
            (Some("MODEL"), Some("PLANNER_RESPONSE"))
                if record.report.reply.is_some()
                    || row["tool_calls"]
                        .as_array()
                        .is_some_and(|calls| !calls.is_empty()) =>
            {
                self.latest_reply = self.latest_reply.max(Some(step));
            }
            _ => {}
        }
    }
}
