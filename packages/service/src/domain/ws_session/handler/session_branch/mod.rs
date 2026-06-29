//! Provider-neutral orchestration for the Rewind & Fork actions.
//!
//! Both flows share a preamble — validate the target user message, resolve the
//! worktree + provider, stop any live turn — then diverge: rewind mutates the
//! session in place (code + conversation rolled back), fork branches the
//! conversation into a new session in the same worktree. Provider specifics
//! live entirely behind the `SessionBranching` capability; nothing here branches
//! on provider identity.

mod fork;
mod fork_db;
mod rewind;
mod rewind_state;

pub(crate) use fork::handle_fork;
pub(crate) use rewind::handle_rewind;

use axum::extract::ws::Message;
use serde::Deserialize;
use tracing::warn;

use super::super::persistence::WsSessionPersistence;
use super::super::protocol::WsEnvelope;
use super::helpers::{parse_session_id, persist_and_close_query, send_error};
use super::session_control::resolve_owner_sessions;
use super::types::{QueryState, SdkSessions, WsSender};
use crate::app_state::AppState;
use crate::domain::agents::adapter::{BranchContext, RuntimeSpawnConfig};
use crate::domain::agents::providers::runtime_adapter;
use crate::error::AppError;

/// Inbound payload shared by `branch.rewind` and `branch.fork`.
#[derive(Debug, Deserialize)]
pub(super) struct BranchPayload {
    pub session_id: String,
    pub message_id: i64,
    /// Rewind only: the user has acknowledged that uncommitted changes since the
    /// checkpoint will be discarded. Ignored by fork.
    #[serde(default)]
    pub confirm_discard: bool,
}

/// Resolved, validated inputs for a branch operation.
pub(super) struct BranchInputs {
    pub db_session_id: i64,
    pub feature_id: i64,
    pub message_id: i64,
    pub provider_id: String,
    pub cwd: std::path::PathBuf,
    /// Text of the cut user message — restored into the composer as a draft.
    pub message_text: String,
    /// 1-indexed position of the cut message among the session's user prompts.
    pub cut_user_ordinal: usize,
    /// The cut message's provider id, when captured (Claude: usually `None`, so
    /// surgery uses the ordinal). Reserved for providers that stamp it.
    pub cut_provider_uuid: Option<String>,
}

/// Why a branch could not even begin (surfaced as a typed WS error).
pub(super) enum BranchAbort {
    SessionNotFound,
    NotAUserMessage,
    NoWorktree,
    /// The provider can't branch its context (not registered, or no
    /// `SessionBranching` capability). We refuse rather than silently completing
    /// the action against the full, untrimmed history.
    Unsupported(String),
    /// Transcript surgery failed (corrupt/missing/unreadable session file). We
    /// abort *before* mutating code or the conversation so nothing is left half
    /// rewound.
    Surgery(String),
    Db(String),
}

impl BranchAbort {
    fn code(&self) -> &'static str {
        match self {
            BranchAbort::SessionNotFound => "SESSION_NOT_FOUND",
            BranchAbort::NotAUserMessage => "INVALID_MESSAGE",
            BranchAbort::NoWorktree => "NO_WORKTREE",
            BranchAbort::Unsupported(_) => "UNSUPPORTED_BRANCHING",
            BranchAbort::Surgery(_) => "BRANCH_SURGERY_FAILED",
            BranchAbort::Db(_) => "DB_ERROR",
        }
    }
    fn message(&self) -> String {
        match self {
            BranchAbort::SessionNotFound => "Session or message not found".to_string(),
            BranchAbort::NotAUserMessage => {
                "Rewind/Fork can only target a user message".to_string()
            }
            BranchAbort::NoWorktree => "This session has no worktree yet".to_string(),
            BranchAbort::Unsupported(msg) | BranchAbort::Surgery(msg) => msg.clone(),
            BranchAbort::Db(msg) => msg.clone(),
        }
    }
}

impl From<AppError> for BranchAbort {
    fn from(err: AppError) -> Self {
        BranchAbort::Db(err.to_string())
    }
}
impl From<sqlx::Error> for BranchAbort {
    fn from(err: sqlx::Error) -> Self {
        BranchAbort::Db(err.to_string())
    }
}

pub(super) fn parse_payload(
    envelope: &WsEnvelope,
    sender: &WsSender,
) -> Option<(BranchPayload, i64)> {
    let payload: BranchPayload = match serde_json::from_value(envelope.payload.clone()) {
        Ok(p) => p,
        Err(e) => {
            send_error(sender, &envelope.id, "INVALID_PAYLOAD", &e.to_string());
            return None;
        }
    };
    let Some(db_session_id) = parse_session_id(&payload.session_id) else {
        send_error(
            sender,
            &envelope.id,
            "INVALID_SESSION_ID",
            "session_id must be a numeric DB id",
        );
        return None;
    };
    Some((payload, db_session_id))
}

/// Validate the target message and resolve the worktree + provider. Returns a
/// typed abort (never panics) so every failure path produces a WS error.
pub(super) async fn load_inputs(
    pool: &sqlx::SqlitePool,
    db_session_id: i64,
    message_id: i64,
) -> Result<BranchInputs, BranchAbort> {
    let session: Option<(i64, Option<String>)> =
        sqlx::query_as("SELECT feature_id, runtime_provider FROM agent_sessions WHERE id = ?")
            .bind(db_session_id)
            .fetch_optional(pool)
            .await?;
    let (feature_id, provider_id) = session.ok_or(BranchAbort::SessionNotFound)?;
    let provider_id = provider_id.unwrap_or_default();

    // Pull the cut message's type, text and provider uuid in one read — the
    // provider uuid lives on the same row, so a second query would be a wasted
    // round-trip on every rewind/fork.
    let message: Option<(String, String, Option<String>)> = sqlx::query_as(
        "SELECT message_type, content, provider_message_uuid \
         FROM agent_messages WHERE id = ? AND session_id = ?",
    )
    .bind(message_id)
    .bind(db_session_id)
    .fetch_optional(pool)
    .await?;
    let (message_type, message_text, cut_provider_uuid) =
        message.ok_or(BranchAbort::SessionNotFound)?;
    if message_type != "user_message" {
        return Err(BranchAbort::NotAUserMessage);
    }

    let cut_user_ordinal: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM agent_messages \
         WHERE session_id = ? AND message_type = 'user_message' AND id <= ?",
    )
    .bind(db_session_id)
    .bind(message_id)
    .fetch_one(pool)
    .await?;

    // The agent runs in the feature's worktree, or — for "on branch" features —
    // directly in the project folder. Rewind/fork must target whichever it is;
    // requiring a worktree would wrongly reject every non-worktree feature.
    let cwd = match crate::domain::workflow::worktree::resolve_feature_cwd(pool, feature_id).await {
        Ok(path) if !path.trim().is_empty() => std::path::PathBuf::from(path),
        _ => return Err(BranchAbort::NoWorktree),
    };

    Ok(BranchInputs {
        db_session_id,
        feature_id,
        message_id,
        provider_id,
        cwd,
        message_text,
        cut_user_ordinal: cut_user_ordinal.max(0) as usize,
        cut_provider_uuid,
    })
}

pub(super) fn report_abort(sender: &WsSender, envelope_id: &str, abort: BranchAbort) {
    send_error(sender, envelope_id, abort.code(), &abort.message());
}

/// Outcome of truncating the provider's context at the cut point.
pub(super) enum TruncateOutcome {
    /// Surgery produced a new provider session whose context ends at the cut.
    Truncated(String),
    /// No prior context to keep — start fresh (no resume).
    Fresh,
}

impl TruncateOutcome {
    /// The runtime session id the branch should resume from: the freshly cut one,
    /// or `None` for a fresh start.
    pub(super) fn into_session_id(self) -> Option<String> {
        match self {
            TruncateOutcome::Truncated(new_id) => Some(new_id),
            TruncateOutcome::Fresh => None,
        }
    }
}

/// Run the provider's transcript surgery. Returns a hard [`BranchAbort`] when the
/// provider can't branch or surgery fails, so the caller aborts the whole action
/// *before* touching code or the conversation — never completing a rewind/fork
/// that silently resumes the full, untrimmed history.
pub(super) async fn truncate_context(
    inputs: &BranchInputs,
    source: Option<String>,
) -> Result<TruncateOutcome, BranchAbort> {
    // Rewinding to (or before) the first prompt keeps no prior context.
    if inputs.cut_user_ordinal <= 1 {
        return Ok(TruncateOutcome::Fresh);
    }
    let Some(source) = source else {
        // The session never produced a provider session id — nothing to branch,
        // so there is no full history to accidentally carry over: start fresh.
        return Ok(TruncateOutcome::Fresh);
    };
    let Some(adapter) = runtime_adapter(&inputs.provider_id) else {
        return Err(BranchAbort::Unsupported(format!(
            "Provider '{}' is not available, so this conversation can't be branched.",
            inputs.provider_id
        )));
    };
    let Some(branching) = adapter.session_branching() else {
        return Err(BranchAbort::Unsupported(format!(
            "Rewind & Fork isn't supported for the '{}' provider yet.",
            inputs.provider_id
        )));
    };
    let ctx = BranchContext {
        cwd: inputs.cwd.clone(),
        source_runtime_session_id: source,
        cut_provider_uuid: inputs.cut_provider_uuid.clone(),
        cut_user_ordinal: inputs.cut_user_ordinal,
    };
    match branching.truncate_before(&ctx).await {
        Ok(result) => Ok(TruncateOutcome::Truncated(result.new_runtime_session_id)),
        Err(error) => {
            warn!(
                inputs.db_session_id,
                error = %error,
                "transcript surgery failed; aborting branch before any mutation"
            );
            Err(BranchAbort::Surgery(format!(
                "The conversation couldn't be branched: {error}"
            )))
        }
    }
}

/// Interrupt and close any live turn for this session, then reset the handle to
/// `Pending` so the next prompt respawns (resuming whatever `runtime_session_id`
/// the DB then holds). Returns the source provider session id (persisted to the
/// DB by the close). Holds the sessions lock only for this transition.
pub(super) async fn stop_live_turn(
    sdk_sessions: &SdkSessions,
    app_state: &AppState,
    db_session_id: i64,
) {
    let effective = resolve_owner_sessions(sdk_sessions, app_state, db_session_id).await;
    let mut sessions = effective.lock().await;
    let Some(handle) = sessions.get_mut(&db_session_id) else {
        return;
    };
    if let QueryState::Active { query, .. } = &handle.state {
        // Flip status off `running` BEFORE closing so the per-turn reader reads
        // the close as benign (mirrors handle_clear / handle_destroy).
        WsSessionPersistence::mark_completed_static(&app_state.write_pool, db_session_id).await;
        persist_and_close_query(
            query,
            &app_state.write_pool,
            db_session_id,
            &handle.runtime_provider,
        )
        .await;
        let fresh = RuntimeSpawnConfig {
            cwd: handle.config.cwd.clone(),
            permission_mode: handle.desired_permission_mode.clone(),
            access_mode: handle.desired_access_mode.clone(),
            model: handle.desired_model.clone(),
            thinking_effort: handle.desired_thinking_effort.clone(),
            system_prompt: handle.config.system_prompt.clone(),
            env: handle.config.env.clone(),
            ..RuntimeSpawnConfig::default()
        };
        handle.state = QueryState::Pending(fresh);
    }
}

/// The provider session id currently recorded for this session.
pub(super) async fn current_runtime_session_id(
    pool: &sqlx::SqlitePool,
    db_session_id: i64,
) -> Option<String> {
    match sqlx::query_scalar::<_, Option<String>>(
        "SELECT runtime_session_id FROM agent_sessions WHERE id = ?",
    )
    .bind(db_session_id)
    .fetch_optional(pool)
    .await
    {
        Ok(row) => row.flatten(),
        Err(error) => {
            // Don't silently treat a real DB failure as "no prior session" — that
            // would quietly force a fresh-context branch. Log it; the caller still
            // degrades gracefully (TruncateOutcome::Fresh).
            warn!(db_session_id, error = %error, "failed to read runtime_session_id for branch");
            None
        }
    }
}

/// Send the originating client a typed reply, then broadcast the same change to
/// the other devices viewing this feature so they reload.
pub(super) async fn reply_and_broadcast(
    app_state: &AppState,
    sender: &WsSender,
    envelope_id: &str,
    feature_id: i64,
    action: &str,
    payload: serde_json::Value,
) {
    let reply = WsEnvelope::reply(envelope_id, "session", action, payload.clone());
    let _ = sender.send(Message::Text(String::from(reply).into()));
    let broadcast = WsEnvelope::new("session", action, payload);
    app_state
        .ws_feature_senders
        .broadcast_others(
            feature_id,
            sender,
            &Message::Text(String::from(broadcast).into()),
        )
        .await;
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn into_session_id_maps_each_outcome() {
        assert_eq!(
            TruncateOutcome::Truncated("new".into()).into_session_id(),
            Some("new".to_string()),
        );
        assert_eq!(TruncateOutcome::Fresh.into_session_id(), None);
    }

    #[test]
    fn branch_abort_exposes_typed_codes() {
        assert_eq!(
            BranchAbort::Unsupported("x".into()).code(),
            "UNSUPPORTED_BRANCHING"
        );
        assert_eq!(
            BranchAbort::Surgery("x".into()).code(),
            "BRANCH_SURGERY_FAILED"
        );
        // The carried message is surfaced verbatim to the user.
        assert_eq!(BranchAbort::Surgery("boom".into()).message(), "boom");
    }
}
