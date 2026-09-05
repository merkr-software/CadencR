//! Atomic desired activation state and retained managed-provider history.

use std::path::Path;

use serde::{Deserialize, Serialize};

use super::receipt::ManagedRevision;
use crate::error::AppError;
use crate::shared::atomic_file;

pub const MANAGED_STATE_SCHEMA_VERSION: u32 = 1;

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct ManagedActiveRevision {
    pub revision: ManagedRevision,
    pub enabled: bool,
}

#[derive(Debug, Clone, Copy, Deserialize, Serialize, PartialEq, Eq, utoipa::ToSchema)]
#[serde(rename_all = "snake_case")]
pub enum ManagedHistoryAction {
    Installed,
    Updated,
    RolledBack,
    Enabled,
    Disabled,
    Removed,
}

#[derive(Debug, Clone, Deserialize, Serialize, utoipa::ToSchema)]
#[serde(deny_unknown_fields)]
pub struct ManagedHistoryEntry {
    pub sequence: u64,
    pub action: ManagedHistoryAction,
    pub version: Option<String>,
    pub digest: Option<String>,
    pub previous_version: Option<String>,
    pub previous_digest: Option<String>,
    pub occurred_at: String,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct ManagedProviderState {
    pub schema_version: u32,
    pub provider_id: String,
    pub active: Option<ManagedActiveRevision>,
    pub history: Vec<ManagedHistoryEntry>,
}

impl ManagedProviderState {
    pub fn empty(provider_id: impl Into<String>) -> Self {
        Self {
            schema_version: MANAGED_STATE_SCHEMA_VERSION,
            provider_id: provider_id.into(),
            active: None,
            history: Vec::new(),
        }
    }

    pub fn transition(
        &mut self,
        action: ManagedHistoryAction,
        active: Option<ManagedActiveRevision>,
    ) {
        let previous = self.active.as_ref().map(|active| &active.revision);
        let next = active.as_ref().map(|active| &active.revision);
        self.history.push(ManagedHistoryEntry {
            sequence: self
                .history
                .last()
                .map_or(1, |entry| entry.sequence.saturating_add(1)),
            action,
            version: next.map(|revision| revision.version.clone()),
            digest: next.map(|revision| revision.digest.clone()),
            previous_version: previous.map(|revision| revision.version.clone()),
            previous_digest: previous.map(|revision| revision.digest.clone()),
            occurred_at: chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true),
        });
        self.active = active;
    }
}

pub fn read_state(path: &Path, provider_id: &str) -> Result<ManagedProviderState, AppError> {
    match std::fs::read(path) {
        Ok(bytes) => {
            let state: ManagedProviderState = serde_json::from_slice(&bytes).map_err(|error| {
                state_error(format!("parse managed state {}: {error}", path.display()))
            })?;
            if state.schema_version != MANAGED_STATE_SCHEMA_VERSION
                || state.provider_id != provider_id
            {
                return Err(state_error(format!(
                    "managed state {} has mismatched schema or provider id",
                    path.display()
                )));
            }
            Ok(state)
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            Ok(ManagedProviderState::empty(provider_id))
        }
        Err(error) => Err(state_error(format!(
            "read managed state {}: {error}",
            path.display()
        ))),
    }
}

pub fn write_state(path: &Path, state: &ManagedProviderState) -> Result<(), AppError> {
    let mut json = serde_json::to_string_pretty(state)
        .map_err(|error| AppError::Internal(format!("serialize managed state: {error}")))?;
    json.push('\n');
    atomic_file::write_atomic_private(path, &json)
}

fn state_error(message: impl Into<String>) -> AppError {
    AppError::coded(
        axum::http::StatusCode::CONFLICT,
        "MANAGED_STATE_INVALID",
        message,
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    fn active(version: &str, digest: &str, enabled: bool) -> ManagedActiveRevision {
        ManagedActiveRevision {
            revision: ManagedRevision {
                version: version.into(),
                digest: digest.into(),
            },
            enabled,
        }
    }

    #[test]
    fn transitions_keep_monotonic_retained_history() {
        let mut state = ManagedProviderState::empty("acme-agent");
        state.transition(
            ManagedHistoryAction::Installed,
            Some(active("1.0.0", "aaa", true)),
        );
        state.transition(
            ManagedHistoryAction::Updated,
            Some(active("2.0.0", "bbb", true)),
        );
        state.transition(ManagedHistoryAction::Removed, None);
        assert_eq!(state.history.len(), 3);
        assert_eq!(state.history[2].sequence, 3);
        assert_eq!(state.history[1].previous_version.as_deref(), Some("1.0.0"));
        assert!(state.active.is_none());
    }

    #[test]
    fn state_round_trips_atomically() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("state.json");
        let mut state = ManagedProviderState::empty("acme-agent");
        state.transition(
            ManagedHistoryAction::Installed,
            Some(active("1.0.0", "aaa", true)),
        );
        write_state(&path, &state).unwrap();
        let loaded = read_state(&path, "acme-agent").unwrap();
        assert_eq!(loaded.active.unwrap().revision.version, "1.0.0");
        assert_eq!(loaded.history.len(), 1);
    }
}
