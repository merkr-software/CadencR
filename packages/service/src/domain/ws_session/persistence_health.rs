use crate::domain::ws_session::protocol::WsSessionEvent;
use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};

use axum::extract::ws::Message;
use tokio::sync::{mpsc, Mutex};

use super::protocol::{PersistenceStatusState, SessionPersistenceStatusPayload, WsEnvelope};
use super::sender_registry::WsFeatureSenderRegistry;

struct SessionHealth {
    feature_id: i64,
    reader_id: Option<u64>,
    payload: SessionPersistenceStatusPayload,
}

/// One latest transition per affected existing session, with no event history.
/// Warnings and proven recoveries survive reader/socket replacement until deletion.
/// An absent entry is unknown, never proof of recovery after a service restart.
#[derive(Default)]
pub struct SessionPersistenceHealth {
    next_reader: AtomicU64,
    sessions: Mutex<HashMap<i64, SessionHealth>>,
}

impl SessionPersistenceHealth {
    pub(crate) fn reader_id(&self) -> u64 {
        self.next_reader.fetch_add(1, Ordering::Relaxed)
    }

    /// Serialize the snapshot send with live publication so reconnect cannot
    /// overwrite a newer transition with a previously captured warning.
    pub(crate) async fn replay(&self, session_id: i64, sender: &mpsc::UnboundedSender<Message>) {
        let sessions = self.sessions.lock().await;
        if let Some(entry) = sessions.get(&session_id) {
            let _ = sender.send(status_message(entry.payload.clone()));
        }
    }

    #[allow(clippy::too_many_arguments)]
    pub(crate) async fn publish(
        &self,
        session_id: i64,
        feature_id: i64,
        reader_id: u64,
        payload: SessionPersistenceStatusPayload,
        read_pool: &sqlx::SqlitePool,
        senders: &WsFeatureSenderRegistry,
        sender: &mpsc::UnboundedSender<Message>,
    ) {
        let mut sessions = self.sessions.lock().await;
        // A superseded reader may finish after session/feature deletion. Keep
        // the existence check under the same lock as deletion's forget call.
        // If storage itself is unavailable, preserve the warning: that failure
        // is precisely what the status is telling the user about.
        if matches!(
            sqlx::query_scalar::<_, bool>(
                "SELECT EXISTS(SELECT 1 FROM agent_sessions WHERE id = ?)"
            )
            .bind(session_id)
            .fetch_one(read_pool)
            .await,
            Ok(false)
        ) {
            sessions.remove(&session_id);
            return;
        }
        if let Some(payload) = update(&mut sessions, session_id, feature_id, reader_id, payload) {
            senders
                .send_and_mirror(feature_id, sender, status_message(payload))
                .await;
        }
    }

    pub(crate) async fn forget_session(&self, session_id: i64) {
        self.sessions.lock().await.remove(&session_id);
    }

    pub(crate) async fn forget_feature(&self, feature_id: i64) {
        self.sessions
            .lock()
            .await
            .retain(|_, entry| entry.feature_id != feature_id);
    }
}

fn status_message(payload: SessionPersistenceStatusPayload) -> Message {
    // This payload contains only a unit enum and a string, so serialization is infallible.
    let envelope = WsEnvelope::session_event(&WsSessionEvent::PersistenceStatus(payload))
        .expect("transcript health payload is serializable");
    Message::Text(String::from(envelope).into())
}

fn update(
    sessions: &mut HashMap<i64, SessionHealth>,
    session_id: i64,
    feature_id: i64,
    reader_id: u64,
    mut payload: SessionPersistenceStatusPayload,
) -> Option<SessionPersistenceStatusPayload> {
    let existing = sessions.get(&session_id);
    if payload.status == PersistenceStatusState::Recovered {
        // A new runtime cannot prove that an older runtime's missing transcript
        // was repaired. Only the producer holding that exact damaged state can.
        if existing.is_none_or(|entry| entry.reader_id != Some(reader_id)) {
            return None;
        }
        if existing.is_some_and(|entry| entry.payload.status == PersistenceStatusState::Recovered) {
            return None;
        }
        sessions.insert(
            session_id,
            SessionHealth {
                feature_id,
                reader_id: Some(reader_id),
                payload: payload.clone(),
            },
        );
        return Some(payload);
    }
    let owner = match existing {
        Some(entry)
            if entry.reader_id != Some(reader_id)
                && entry.payload.status != PersistenceStatusState::Recovered =>
        {
            // Conflicting reader lifetimes cannot provide a complete recovery
            // proof. Coalesce their damage into one retained session warning.
            payload.status = PersistenceStatusState::Failed;
            payload.message = PersistenceStatusState::Failed.message().into();
            None
        }
        _ => Some(reader_id),
    };
    let changed = existing.is_none_or(|entry| entry.payload.status != payload.status);
    sessions.insert(
        session_id,
        SessionHealth {
            feature_id,
            reader_id: owner,
            payload: payload.clone(),
        },
    );
    changed.then_some(payload)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn payload(status: PersistenceStatusState) -> SessionPersistenceStatusPayload {
        SessionPersistenceStatusPayload {
            status,
            message: format!("{status:?}"),
        }
    }

    #[tokio::test]
    async fn reconnect_replays_warning_and_proven_recovery() {
        let registry = SessionPersistenceHealth::default();
        let (sender, mut receiver) = mpsc::unbounded_channel();
        registry.replay(1, &sender).await;
        assert!(
            receiver.try_recv().is_err(),
            "unknown health must not imply recovery"
        );
        update(
            &mut *registry.sessions.lock().await,
            1,
            2,
            3,
            payload(PersistenceStatusState::Degraded),
        );
        registry.replay(1, &sender).await;
        let Message::Text(text) = receiver.recv().await.unwrap() else {
            panic!("expected status")
        };
        let envelope: WsEnvelope = serde_json::from_str(&text).unwrap();
        assert_eq!(envelope.action, "persistence_status");
        assert_eq!(envelope.payload["status"], "degraded");
        update(
            &mut *registry.sessions.lock().await,
            1,
            2,
            3,
            payload(PersistenceStatusState::Recovered),
        );
        assert_eq!(registry.sessions.lock().await.len(), 1);
        registry.replay(1, &sender).await;
        let Message::Text(text) = receiver.recv().await.unwrap() else {
            panic!("expected status")
        };
        let envelope: WsEnvelope = serde_json::from_str(&text).unwrap();
        assert_eq!(envelope.payload["status"], "recovered");
    }

    #[test]
    fn unrelated_reader_cannot_clear_missing_history() {
        let mut entries = HashMap::new();
        update(
            &mut entries,
            1,
            2,
            3,
            payload(PersistenceStatusState::Failed),
        );
        assert!(update(
            &mut entries,
            1,
            2,
            4,
            payload(PersistenceStatusState::Recovered)
        )
        .is_none());
        assert_eq!(entries[&1].payload.status, PersistenceStatusState::Failed);
        update(
            &mut entries,
            1,
            2,
            4,
            payload(PersistenceStatusState::Degraded),
        );
        assert!(update(
            &mut entries,
            1,
            2,
            4,
            payload(PersistenceStatusState::Recovered)
        )
        .is_none());
        assert_eq!(entries.len(), 1);
    }

    #[tokio::test]
    async fn publication_mirrors_to_other_viewers_and_ignores_deleted_sessions() {
        let pool = sqlx::sqlite::SqlitePoolOptions::new()
            .max_connections(1)
            .connect("sqlite::memory:")
            .await
            .unwrap();
        sqlx::query("CREATE TABLE agent_sessions (id INTEGER PRIMARY KEY)")
            .execute(&pool)
            .await
            .unwrap();
        sqlx::query("INSERT INTO agent_sessions (id) VALUES (1)")
            .execute(&pool)
            .await
            .unwrap();
        let registry = SessionPersistenceHealth::default();
        let senders = WsFeatureSenderRegistry::new();
        let (owner, mut owner_rx) = mpsc::unbounded_channel();
        let (viewer, mut viewer_rx) = mpsc::unbounded_channel();
        senders.register(2, owner.clone()).await;
        senders.register(2, viewer).await;
        for id in [1, 9] {
            registry
                .publish(
                    id,
                    2,
                    3,
                    payload(PersistenceStatusState::Degraded),
                    &pool,
                    &senders,
                    &owner,
                )
                .await;
        }
        assert!(matches!(owner_rx.try_recv(), Ok(Message::Text(_))));
        assert!(matches!(viewer_rx.try_recv(), Ok(Message::Text(_))));
        assert!(owner_rx.try_recv().is_err());
        assert!(viewer_rx.try_recv().is_err());
        let entries = registry.sessions.lock().await;
        assert_eq!(entries.len(), 1);
        assert!(entries.contains_key(&1));
    }

    #[tokio::test]
    async fn deletion_removes_only_its_session_or_feature() {
        let registry = SessionPersistenceHealth::default();
        for (id, feature) in [(1, 10), (2, 10), (3, 11)] {
            update(
                &mut *registry.sessions.lock().await,
                id,
                feature,
                1,
                payload(PersistenceStatusState::Failed),
            );
        }
        registry.forget_session(1).await;
        registry.forget_feature(10).await;
        let entries = registry.sessions.lock().await;
        assert_eq!(entries.len(), 1);
        assert!(entries.contains_key(&3));
    }
}
