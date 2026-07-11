use std::collections::HashMap;

use tokio::sync::Mutex;

use crate::domain::ws_session::persistence::{PendingUserInputKind, WsSessionPersistence};

const MAX_ENTRIES_PER_SESSION: usize = 16;

#[derive(Clone, Copy, Debug, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "snake_case")]
pub enum GateKind {
    Permission,
    Question,
    Plan,
}

impl GateKind {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Permission => "permission",
            Self::Question => "question",
            Self::Plan => "plan",
        }
    }

    pub(crate) fn from_pending(kind: PendingUserInputKind, tool_name: &str) -> Self {
        if tool_name == "ExitPlanMode" {
            Self::Plan
        } else if crate::domain::ws_session::protocol::is_question_tool(tool_name) {
            Self::Question
        } else {
            match kind {
                PendingUserInputKind::Permission => Self::Permission,
                PendingUserInputKind::Question => Self::Question,
            }
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq, serde::Serialize)]
pub struct PendingGate {
    pub request_id: String,
    pub kind: GateKind,
    pub payload: serde_json::Value,
}

#[derive(Debug, PartialEq, Eq)]
pub enum GateClaimError {
    Missing,
    RequestMismatch,
    AlreadyClaimed,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum GateState {
    Pending,
    Claimed,
    Resolved,
}

struct GateEntry {
    request_id: String,
    gate: Option<PendingGate>,
    state: GateState,
}

#[derive(Default)]
pub struct GateRegistry {
    gates: Mutex<HashMap<i64, Vec<GateEntry>>>,
}

impl GateRegistry {
    pub fn new() -> Self {
        Self::default()
    }

    pub async fn register(&self, session_id: i64, gate: PendingGate) {
        let mut gates = self.gates.lock().await;
        let entries = gates.entry(session_id).or_default();
        if let Some(entry) = entries
            .iter_mut()
            .find(|entry| entry.request_id == gate.request_id)
        {
            entry.request_id = gate.request_id.clone();
            entry.gate = Some(gate);
            if entry.state == GateState::Resolved {
                entry.state = GateState::Pending;
            }
        } else {
            entries.push(GateEntry {
                request_id: gate.request_id.clone(),
                gate: Some(gate),
                state: GateState::Pending,
            });
        }
        trim_entries(entries);
    }

    pub async fn ensure_loaded(
        &self,
        pool: &sqlx::SqlitePool,
        session_id: i64,
    ) -> Result<(), sqlx::Error> {
        if self.has_open(session_id).await {
            return Ok(());
        }
        let Some(row) = WsSessionPersistence::try_get_session_row(pool, session_id).await? else {
            return Ok(());
        };
        let Some((kind, payload)) = row.pending_gate_payload() else {
            return Ok(());
        };
        let tool_name = payload.tool_name.as_str();
        self.register(
            session_id,
            PendingGate {
                request_id: payload.request_id.clone(),
                kind: GateKind::from_pending(kind, tool_name),
                payload: serde_json::to_value(payload)
                    .map_err(|error| sqlx::Error::Encode(Box::new(error)))?,
            },
        )
        .await;
        Ok(())
    }

    pub async fn pending_all(&self, session_id: i64) -> Vec<PendingGate> {
        self.gates
            .lock()
            .await
            .get(&session_id)
            .map(|entries| {
                entries
                    .iter()
                    .filter(|entry| entry.state == GateState::Pending)
                    .filter_map(|entry| entry.gate.clone())
                    .collect()
            })
            .unwrap_or_default()
    }

    pub async fn latest_open(&self, session_id: i64) -> Option<PendingGate> {
        self.gates
            .lock()
            .await
            .get(&session_id)
            .and_then(|entries| {
                entries
                    .iter()
                    .rev()
                    .find(|entry| entry.state != GateState::Resolved)
            })
            .and_then(|entry| entry.gate.clone())
    }

    pub async fn find_pending(&self, session_id: i64, request_id: &str) -> Option<PendingGate> {
        self.gates
            .lock()
            .await
            .get(&session_id)
            .and_then(|entries| {
                entries.iter().find(|entry| {
                    entry.request_id == request_id && entry.state == GateState::Pending
                })
            })
            .and_then(|entry| entry.gate.clone())
    }

    pub async fn claim(&self, session_id: i64, request_id: &str) -> Result<(), GateClaimError> {
        let mut gates = self.gates.lock().await;
        let entries = gates.get_mut(&session_id).ok_or(GateClaimError::Missing)?;
        let entry = entries
            .iter_mut()
            .find(|entry| entry.request_id == request_id)
            .ok_or(GateClaimError::RequestMismatch)?;
        if entry.state != GateState::Pending {
            return Err(GateClaimError::AlreadyClaimed);
        }
        entry.state = GateState::Claimed;
        Ok(())
    }

    pub async fn release(&self, session_id: i64, request_id: &str) {
        let mut gates = self.gates.lock().await;
        if let Some(entry) = find_entry_mut(&mut gates, session_id, request_id) {
            if entry.state == GateState::Claimed {
                entry.state = GateState::Pending;
            }
        }
    }

    pub async fn complete(&self, session_id: i64, request_id: &str) {
        let mut gates = self.gates.lock().await;
        if let Some(entries) = gates.get_mut(&session_id) {
            if let Some(entry) = entries
                .iter_mut()
                .find(|entry| entry.request_id == request_id)
            {
                entry.state = GateState::Resolved;
                entry.gate = None;
            }
            trim_entries(entries);
        }
    }

    async fn has_open(&self, session_id: i64) -> bool {
        self.gates
            .lock()
            .await
            .get(&session_id)
            .is_some_and(|entries| {
                entries
                    .iter()
                    .any(|entry| entry.state != GateState::Resolved)
            })
    }
}

fn find_entry_mut<'a>(
    gates: &'a mut HashMap<i64, Vec<GateEntry>>,
    session_id: i64,
    request_id: &str,
) -> Option<&'a mut GateEntry> {
    gates
        .get_mut(&session_id)?
        .iter_mut()
        .find(|entry| entry.request_id == request_id)
}

fn trim_entries(entries: &mut Vec<GateEntry>) {
    while entries.len() > MAX_ENTRIES_PER_SESSION {
        let index = entries
            .iter()
            .position(|entry| entry.state == GateState::Resolved)
            .unwrap_or(0);
        entries.remove(index);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn gate(id: &str) -> PendingGate {
        PendingGate {
            request_id: id.into(),
            kind: GateKind::Permission,
            payload: serde_json::json!({"request_id": id}),
        }
    }

    #[tokio::test]
    async fn exactly_one_concurrent_claim_wins() {
        let registry = std::sync::Arc::new(GateRegistry::new());
        registry.register(7, gate("r1")).await;
        let (a, b) = tokio::join!(registry.claim(7, "r1"), registry.claim(7, "r1"));
        assert_eq!(usize::from(a.is_ok()) + usize::from(b.is_ok()), 1);
    }

    #[tokio::test]
    async fn stale_request_id_is_rejected() {
        let registry = GateRegistry::new();
        registry.register(7, gate("current")).await;
        assert_eq!(
            registry.claim(7, "stale").await,
            Err(GateClaimError::RequestMismatch)
        );
    }

    #[tokio::test]
    async fn completion_drops_payload_and_keeps_bounded_race_tombstone() {
        let registry = GateRegistry::new();
        registry.register(7, gate("r1")).await;
        registry.claim(7, "r1").await.unwrap();
        registry.complete(7, "r1").await;

        assert!(registry.pending_all(7).await.is_empty());
        assert_eq!(
            registry.claim(7, "r1").await,
            Err(GateClaimError::AlreadyClaimed)
        );
    }

    #[tokio::test]
    async fn registering_same_gate_does_not_reset_an_active_claim() {
        let registry = GateRegistry::new();
        registry.register(7, gate("r1")).await;
        registry.claim(7, "r1").await.unwrap();
        registry.register(7, gate("r1")).await;

        assert_eq!(
            registry.claim(7, "r1").await,
            Err(GateClaimError::AlreadyClaimed)
        );
    }
}
