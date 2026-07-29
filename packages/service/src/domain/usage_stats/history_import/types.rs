use std::path::PathBuf;

use chrono::{DateTime, NaiveDate, Utc};

#[derive(Debug, Clone)]
pub struct SessionSource {
    pub session_id: i64,
    pub runtime_session_id: String,
    pub model_id: String,
    pub thinking_effort: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct HistoryEvent {
    pub session_id: i64,
    pub event_id: String,
    pub day: String,
    pub model_id: String,
    pub thinking_effort: String,
    pub input_tokens: u64,
    pub output_tokens: u64,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SessionCheckpoint {
    pub session_id: i64,
    pub input_tokens: u64,
    pub output_tokens: u64,
}

#[derive(Debug, Default)]
pub struct ImportBatch {
    pub events: Vec<HistoryEvent>,
    pub checkpoints: Vec<SessionCheckpoint>,
}

#[derive(Debug, Clone)]
pub struct ImportWindow {
    pub cutoff_at: DateTime<Utc>,
    pub start_day: NaiveDate,
}

impl ImportWindow {
    pub fn contains(&self, timestamp: DateTime<Utc>) -> bool {
        timestamp <= self.cutoff_at && timestamp.date_naive() >= self.start_day
    }
}

pub fn parse_timestamp(raw: &str) -> Option<DateTime<Utc>> {
    DateTime::parse_from_rfc3339(raw)
        .ok()
        .map(|timestamp| timestamp.with_timezone(&Utc))
}

#[derive(Debug, Clone)]
pub struct HistoryLocations {
    pub claude_projects_root: Option<PathBuf>,
    pub codex_sessions_root: Option<PathBuf>,
    pub opencode_databases: Vec<PathBuf>,
}

impl HistoryLocations {
    pub fn from_environment() -> Self {
        let home = dirs::home_dir();
        let claude_projects_root = home
            .as_ref()
            .map(|path| path.join(".claude").join("projects"));
        let codex_sessions_root = crate::domain::imports::codex_sessions_dir();
        let opencode_databases = home
            .as_ref()
            .map(|path| opencode_databases(&path.join(".local").join("share").join("opencode")))
            .unwrap_or_default();
        Self {
            claude_projects_root,
            codex_sessions_root,
            opencode_databases,
        }
    }
}

fn opencode_databases(directory: &std::path::Path) -> Vec<PathBuf> {
    let Ok(entries) = std::fs::read_dir(directory) else {
        return Vec::new();
    };
    entries
        .flatten()
        .map(|entry| entry.path())
        .filter(|path| {
            path.file_name()
                .and_then(|name| name.to_str())
                .is_some_and(|name| name.starts_with("opencode") && name.ends_with(".db"))
        })
        .collect()
}
