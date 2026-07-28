use axum::extract::ws::Message;

use crate::domain::sessions::message_dispatch::{self, DispatchClaim};
use crate::domain::sessions::models::AgentMessageOrigin;
use crate::domain::sessions::user_messages::{
    canonical_user_message_uuid, PersistUserMessageError, PersistedUserMessage,
};
use crate::domain::ws_session::persistence::WsSessionPersistence;
use crate::domain::ws_session::protocol::{
    PromptSendPayload, UserMessageDeliveryState, UserMessagePayload, WsEnvelope,
};
use crate::domain::ws_session::sender_registry::WsFeatureSenderRegistry;

use super::super::WsSender;
use super::user_message_delivery::{CanonicalUserMessageOutcome, UserMessageDeliveryError};

#[derive(Debug)]
pub(super) enum PromptPersistenceOutcome {
    Replay,
    Dispatch {
        message: PersistedUserMessage,
        claim_token: String,
    },
    Dispatched(PersistedUserMessage),
}

impl PromptPersistenceOutcome {
    pub fn should_dispatch(&self) -> bool {
        matches!(self, Self::Replay | Self::Dispatch { .. })
    }

    pub fn message_id(&self) -> Option<i64> {
        match self {
            Self::Replay => None,
            Self::Dispatch { message, .. } | Self::Dispatched(message) => Some(message.id),
        }
    }

    pub fn inserted(&self) -> bool {
        matches!(
            self,
            Self::Dispatch {
                message: PersistedUserMessage { inserted: true, .. },
                ..
            } | Self::Dispatched(PersistedUserMessage { inserted: true, .. })
        )
    }

    pub fn tracked_message_uuid(&self, payload: &PromptSendPayload) -> Option<String> {
        if !payload.track_prompt_receipt {
            return None;
        }
        match self {
            Self::Replay => payload.message_uuid.clone(),
            Self::Dispatch { message, .. } | Self::Dispatched(message) => {
                Some(message.message_uuid.clone())
            }
        }
    }

    pub fn dispatch_claim(&self) -> Option<(i64, &str)> {
        match self {
            Self::Dispatch {
                message,
                claim_token,
            } => Some((message.id, claim_token)),
            Self::Replay | Self::Dispatched(_) => None,
        }
    }
}

pub(super) async fn persist_and_publish_prompt(
    pool: &sqlx::SqlitePool,
    feature_senders: &WsFeatureSenderRegistry,
    sender: &WsSender,
    feature_id: i64,
    session_id: i64,
    payload: &PromptSendPayload,
    content: &str,
    internal_replay: bool,
) -> Result<PromptPersistenceOutcome, String> {
    if internal_replay {
        return Ok(PromptPersistenceOutcome::Replay);
    }
    let message_uuid = canonical_user_message_uuid(payload.message_uuid.as_deref())
        .map_err(|_| "prompt has an invalid canonical message UUID".to_string())?;
    let outcome = persist_and_publish_user_message(CanonicalUserMessageRequest {
        pool,
        feature_senders,
        owner: Some(sender),
        feature_id,
        session_id,
        content,
        message_uuid,
        origin: None,
        mode: if payload.track_prompt_receipt {
            CanonicalUserMessageMode::DispatchTrackedPrompt
        } else {
            CanonicalUserMessageMode::DispatchPrompt
        },
    })
    .await
    .map_err(|error| error.to_string())?;
    if let Err(error) = outcome.delivery {
        tracing::warn!(feature_id, session_id, error = %error, "canonical user-message owner disconnected");
    }
    let message = outcome.message;
    match message_dispatch::claim(pool, message.id)
        .await
        .map_err(|error| error.to_string())?
    {
        DispatchClaim::Claimed { token } => Ok(PromptPersistenceOutcome::Dispatch {
            message,
            claim_token: token,
        }),
        DispatchClaim::Dispatched => {
            let message = resolve_dispatched_pending_state(
                pool,
                feature_senders,
                sender,
                feature_id,
                session_id,
                message,
            )
            .await?;
            Ok(PromptPersistenceOutcome::Dispatched(message))
        }
        DispatchClaim::InProgress => Err(format!(
            "message {} is already being dispatched; retry with the same UUID",
            message.message_uuid
        )),
    }
}

async fn resolve_dispatched_pending_state(
    pool: &sqlx::SqlitePool,
    feature_senders: &WsFeatureSenderRegistry,
    sender: &WsSender,
    feature_id: i64,
    session_id: i64,
    mut message: PersistedUserMessage,
) -> Result<PersistedUserMessage, String> {
    if message.delivery_state.as_deref() != Some("pending_agent") {
        return Ok(message);
    }
    let transitioned = crate::domain::sessions::user_messages::update_delivery_state(
        pool,
        session_id,
        &message.message_uuid,
        "delivery_unknown",
    )
    .await
    .map_err(|error| error.to_string())?;
    if !transitioned {
        return Err(format!(
            "message {} no longer has a pending delivery state",
            message.message_uuid
        ));
    }
    message.delivery_state = sqlx::query_scalar(
        "SELECT delivery_state FROM agent_messages WHERE session_id = ? AND message_uuid = ?",
    )
    .bind(session_id)
    .bind(&message.message_uuid)
    .fetch_one(pool)
    .await
    .map_err(|error| error.to_string())?;
    publish_user_message(
        feature_senders,
        Some(sender),
        feature_id,
        &message,
        None,
        true,
    )
    .await
    .map_err(|error| error.to_string())?;
    Ok(message)
}

/// Persist and publish one canonical user message through the shared live
/// event path. All interactive ingress points use this helper so persistence
/// and WebSocket identity cannot drift into separate implementations.
#[derive(Debug, Clone, Copy)]
pub(crate) enum CanonicalUserMessageMode {
    PersistOnly,
    DispatchPrompt,
    DispatchTrackedPrompt,
}

impl CanonicalUserMessageMode {
    fn dispatch_prompt(self) -> bool {
        !matches!(self, Self::PersistOnly)
    }

    fn delivery_state(self) -> Option<&'static str> {
        matches!(self, Self::DispatchTrackedPrompt).then_some("pending_agent")
    }
}

pub(crate) struct CanonicalUserMessageRequest<'a> {
    pub pool: &'a sqlx::SqlitePool,
    pub feature_senders: &'a WsFeatureSenderRegistry,
    pub owner: Option<&'a WsSender>,
    pub feature_id: i64,
    pub session_id: i64,
    pub content: &'a str,
    pub message_uuid: uuid::Uuid,
    pub origin: Option<AgentMessageOrigin>,
    pub mode: CanonicalUserMessageMode,
}

pub(crate) async fn persist_and_publish_user_message(
    request: CanonicalUserMessageRequest<'_>,
) -> Result<CanonicalUserMessageOutcome, PersistUserMessageError> {
    let persistence = WsSessionPersistence::with_session_id(
        request.pool.clone(),
        request.feature_id,
        Some(request.session_id),
    );
    let message = if request.mode.dispatch_prompt() {
        persistence
            .persist_prompt_user_message(
                request.content,
                request.message_uuid,
                request.mode.delivery_state(),
            )
            .await?
    } else {
        persistence
            .persist_user_message_with_delivery(
                request.content,
                request.message_uuid,
                request.mode.delivery_state(),
            )
            .await?
    };
    let delivery = publish_user_message(
        request.feature_senders,
        request.owner,
        request.feature_id,
        &message,
        request.origin,
        request.mode.delivery_state().is_some(),
    )
    .await;
    Ok(CanonicalUserMessageOutcome { message, delivery })
}

/// Publish the one canonical persisted user-message shape to every viewer.
/// The owner receives the same event as passive viewers; there is no separate
/// sender-side block creation path.
pub(crate) async fn publish_user_message(
    feature_senders: &WsFeatureSenderRegistry,
    owner: Option<&WsSender>,
    feature_id: i64,
    message: &PersistedUserMessage,
    origin: Option<AgentMessageOrigin>,
    pending_agent_receipt: bool,
) -> Result<(), UserMessageDeliveryError> {
    let env = WsEnvelope::new(
        "session",
        "user_message",
        serde_json::to_value(UserMessagePayload {
            message_id: message.id,
            message_uuid: message.message_uuid.clone(),
            text: message.content.clone(),
            created_at: message.created_at.clone(),
            origin,
            prompt_delivery_state: message
                .delivery_state
                .as_deref()
                .and_then(UserMessageDeliveryState::from_db)
                .or_else(|| {
                    pending_agent_receipt.then_some(UserMessageDeliveryState::PendingAgent)
                }),
        })
        .unwrap(),
    );
    let ws_message = Message::Text(String::from(env).into());
    if let Some(owner) = owner {
        let owner_closed = feature_senders
            .send_and_mirror(feature_id, owner, ws_message)
            .await;
        if owner_closed {
            feature_senders.unregister_sender(owner).await;
            return Err(UserMessageDeliveryError::new(feature_id));
        }
        return Ok(());
    }
    for sender in feature_senders.get_senders(feature_id).await {
        if sender.send(ws_message.clone()).is_err() {
            feature_senders.unregister_sender(&sender).await;
        }
    }
    Ok(())
}

pub(super) async fn mark_agent_running(
    write_pool: &sqlx::SqlitePool,
    session_status_tx: &crate::domain::session_status::SessionStatusBroadcaster,
    active_turns: &super::super::ActiveTurnRegistry,
    owner: &super::super::SdkSessions,
    db_session_id: i64,
    feature_id: i64,
) {
    // Stamp the turn start on the server and record this connection as the
    // turn's owner. The timestamp is the single source of truth the timer is
    // anchored to on every client; the owner pointer lets a remote device
    // answer a permission/question/plan against this live turn.
    let started_at_ms = super::super::active_turns::now_ms();
    active_turns
        .begin_turn(db_session_id, owner, started_at_ms)
        .await;
    WsSessionPersistence::mark_running_static(write_pool, db_session_id).await;
    session_status_tx.broadcast_running_with_start(db_session_id, feature_id, started_at_ms);
}

#[cfg(test)]
mod tests {
    use super::*;

    fn persisted_user_message() -> PersistedUserMessage {
        PersistedUserMessage {
            id: 42,
            message_uuid: "a48cc11a-8a72-47f7-8577-d5c533d7909c".to_string(),
            content: "hello".to_string(),
            created_at: "2026-07-12 20:00:00".to_string(),
            delivery_state: Some("pending_agent".to_string()),
            inserted: true,
        }
    }

    #[tokio::test]
    async fn canonical_user_message_reaches_owner_with_both_identities() {
        let registry = WsFeatureSenderRegistry::new();
        let (owner, mut receiver) = tokio::sync::mpsc::unbounded_channel();
        registry.register(7, owner.clone()).await;

        publish_user_message(
            &registry,
            Some(&owner),
            7,
            &persisted_user_message(),
            None,
            true,
        )
        .await
        .unwrap();

        let Message::Text(raw) = receiver.try_recv().unwrap() else {
            panic!("expected text envelope");
        };
        let json: serde_json::Value = serde_json::from_str(&raw).unwrap();
        assert_eq!(json["action"], "user_message");
        assert_eq!(json["payload"]["message_id"], 42);
        assert_eq!(
            json["payload"]["message_uuid"],
            "a48cc11a-8a72-47f7-8577-d5c533d7909c"
        );
        assert_eq!(json["payload"]["prompt_delivery_state"], "pending_agent");
    }

    #[tokio::test]
    async fn canonical_user_message_reports_and_prunes_disconnected_owner() {
        let registry = WsFeatureSenderRegistry::new();
        let (owner, receiver) = tokio::sync::mpsc::unbounded_channel();
        registry.register(7, owner.clone()).await;
        drop(receiver);

        let result = publish_user_message(
            &registry,
            Some(&owner),
            7,
            &persisted_user_message(),
            None,
            false,
        )
        .await;

        assert!(result.is_err());
        assert!(registry.get_senders(7).await.is_empty());
    }

    #[tokio::test]
    async fn generated_user_message_is_broadcast_to_every_passive_viewer() {
        let registry = WsFeatureSenderRegistry::new();
        let (first, mut first_rx) = tokio::sync::mpsc::unbounded_channel();
        let (second, mut second_rx) = tokio::sync::mpsc::unbounded_channel();
        registry.register(7, first).await;
        registry.register(7, second).await;
        let origin = AgentMessageOrigin {
            origin_kind: "session_generated".to_string(),
            source_session_id: Some(9),
            source_feature_id: Some(8),
            source_project_id: Some(1),
            source_message_id: None,
            note: Some("delegated".to_string()),
            created_at: None,
        };

        publish_user_message(
            &registry,
            None,
            7,
            &persisted_user_message(),
            Some(origin),
            true,
        )
        .await
        .unwrap();

        for raw in [first_rx.try_recv().unwrap(), second_rx.try_recv().unwrap()] {
            let Message::Text(raw) = raw else {
                panic!("expected text envelope");
            };
            let json: serde_json::Value = serde_json::from_str(&raw).unwrap();
            assert_eq!(json["payload"]["origin"]["sourceSessionId"], 9);
        }
    }

    #[tokio::test]
    async fn repeated_prompt_uuid_has_one_insert_and_one_dispatch_winner() {
        let pool = sqlx::SqlitePool::connect("sqlite::memory:").await.unwrap();
        crate::shared::migrate::run_migrations(
            &crate::shared::migrate::MigrationContext::pool_only(&pool),
        )
        .await
        .unwrap();
        sqlx::query("INSERT INTO projects (id, name, path) VALUES (1, 'p', '/tmp/p')")
            .execute(&pool)
            .await
            .unwrap();
        sqlx::query(
            "INSERT INTO features (id, project_id, title, status, type)
             VALUES (7, 1, 'f', 'active', 'ws-session')",
        )
        .execute(&pool)
        .await
        .unwrap();
        let session_id: i64 = sqlx::query_scalar(
            "INSERT INTO agent_sessions (feature_id, agent_type, status)
             VALUES (7, 'session', 'paused') RETURNING id",
        )
        .fetch_one(&pool)
        .await
        .unwrap();
        let registry = WsFeatureSenderRegistry::new();
        let (sender, _receiver) = tokio::sync::mpsc::unbounded_channel();
        registry.register(7, sender.clone()).await;
        let message_uuid = uuid::Uuid::new_v4().to_string();
        let payload = PromptSendPayload {
            session_id: session_id.to_string(),
            text: "hello".to_string(),
            profile: None,
            claude_profile: None,
            images: Vec::new(),
            attachments: Vec::new(),
            use_worktree: None,
            new_project_branch: None,
            track_prompt_receipt: true,
            message_uuid: Some(message_uuid.clone()),
        };

        let first = persist_and_publish_prompt(
            &pool, &registry, &sender, 7, session_id, &payload, "hello", false,
        )
        .await
        .unwrap();
        let in_progress = persist_and_publish_prompt(
            &pool, &registry, &sender, 7, session_id, &payload, "hello", false,
        )
        .await
        .unwrap_err();

        assert!(first.should_dispatch());
        assert!(in_progress.contains("already being dispatched"));
        let (message_id, claim_token) = first.dispatch_claim().unwrap();
        crate::domain::sessions::message_dispatch::mark_succeeded(&pool, message_id, claim_token)
            .await
            .unwrap();
        let retry = persist_and_publish_prompt(
            &pool, &registry, &sender, 7, session_id, &payload, "hello", false,
        )
        .await
        .unwrap();
        assert!(!retry.should_dispatch());
        assert_eq!(first.message_id(), retry.message_id());
        let count: i64 = sqlx::query_scalar(
            "SELECT COUNT(*) FROM agent_messages WHERE session_id = ? AND message_uuid = ?",
        )
        .bind(session_id)
        .bind(message_uuid)
        .fetch_one(&pool)
        .await
        .unwrap();
        assert_eq!(count, 1);
    }

    #[tokio::test]
    async fn legacy_prompt_without_uuid_gets_identity_from_canonical_event() {
        let pool = sqlx::SqlitePool::connect("sqlite::memory:").await.unwrap();
        crate::shared::migrate::run_migrations(
            &crate::shared::migrate::MigrationContext::pool_only(&pool),
        )
        .await
        .unwrap();
        sqlx::query("INSERT INTO projects (id, name, path) VALUES (1, 'p', '/tmp/p')")
            .execute(&pool)
            .await
            .unwrap();
        sqlx::query(
            "INSERT INTO features (id, project_id, title, status, type)
             VALUES (7, 1, 'f', 'active', 'ws-session')",
        )
        .execute(&pool)
        .await
        .unwrap();
        let session_id: i64 = sqlx::query_scalar(
            "INSERT INTO agent_sessions (feature_id, agent_type, status)
             VALUES (7, 'session', 'paused') RETURNING id",
        )
        .fetch_one(&pool)
        .await
        .unwrap();
        let registry = WsFeatureSenderRegistry::new();
        let (sender, mut receiver) = tokio::sync::mpsc::unbounded_channel();
        registry.register(7, sender.clone()).await;
        let payload = PromptSendPayload {
            session_id: session_id.to_string(),
            text: "legacy hello".to_string(),
            profile: None,
            claude_profile: None,
            images: Vec::new(),
            attachments: Vec::new(),
            use_worktree: None,
            new_project_branch: None,
            track_prompt_receipt: false,
            message_uuid: None,
        };

        let outcome = persist_and_publish_prompt(
            &pool,
            &registry,
            &sender,
            7,
            session_id,
            &payload,
            "legacy hello",
            false,
        )
        .await
        .unwrap();

        assert!(outcome.should_dispatch());
        let Message::Text(raw) = receiver.try_recv().unwrap() else {
            panic!("expected canonical user-message event");
        };
        let event: serde_json::Value = serde_json::from_str(&raw).unwrap();
        let event_uuid = event["payload"]["message_uuid"].as_str().unwrap();
        assert!(uuid::Uuid::parse_str(event_uuid).is_ok());
        assert!(event["payload"]["prompt_delivery_state"].is_null());
        let (stored_uuid, delivery_state): (String, Option<String>) =
            sqlx::query_as("SELECT message_uuid, delivery_state FROM agent_messages WHERE id = ?")
                .bind(outcome.message_id().unwrap())
                .fetch_one(&pool)
                .await
                .unwrap();
        assert_eq!(stored_uuid, event_uuid);
        assert_eq!(delivery_state, None);
    }
}
