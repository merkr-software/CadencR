use uuid::Uuid;

use crate::error::AppError;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PersistedUserMessage {
    pub id: i64,
    pub message_uuid: String,
    pub content: String,
    pub created_at: String,
    pub delivery_state: Option<String>,
    pub inserted: bool,
}

pub struct NewUserMessage<'a> {
    pub session_id: i64,
    pub content: &'a str,
    pub message_uuid: Uuid,
    pub delivery_state: Option<&'a str>,
}

#[derive(Debug)]
pub enum PersistUserMessageError {
    Database(sqlx::Error),
    MissingSessionId,
    IdentityConflict {
        session_id: i64,
        message_uuid: String,
    },
}

impl std::fmt::Display for PersistUserMessageError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Database(error) => write!(f, "failed to persist user message: {error}"),
            Self::MissingSessionId => write!(f, "cannot persist user message without a session id"),
            Self::IdentityConflict {
                session_id,
                message_uuid,
            } => write!(
                f,
                "message UUID {message_uuid} already exists with different content in session {session_id}"
            ),
        }
    }
}

impl std::error::Error for PersistUserMessageError {}

impl From<sqlx::Error> for PersistUserMessageError {
    fn from(error: sqlx::Error) -> Self {
        Self::Database(error)
    }
}

impl From<PersistUserMessageError> for AppError {
    fn from(error: PersistUserMessageError) -> Self {
        match error {
            PersistUserMessageError::Database(error) => AppError::from(error),
            PersistUserMessageError::MissingSessionId => {
                AppError::Internal("cannot persist user message without a session id".to_string())
            }
            PersistUserMessageError::IdentityConflict {
                session_id,
                message_uuid,
            } => AppError::Conflict(format!(
                "message UUID {message_uuid} already has different content in session {session_id}"
            )),
        }
    }
}

#[derive(sqlx::FromRow)]
pub(super) struct CanonicalUserMessageRow {
    pub id: i64,
    pub message_uuid: String,
    pub content: String,
    pub created_at: String,
    pub delivery_state: Option<String>,
}

impl CanonicalUserMessageRow {
    pub(super) fn into_persisted(self, inserted: bool) -> PersistedUserMessage {
        PersistedUserMessage {
            id: self.id,
            message_uuid: self.message_uuid,
            content: self.content,
            created_at: self.created_at,
            delivery_state: self.delivery_state,
            inserted,
        }
    }
}
