use super::reply_audit::record_reply_delivery_audit;
use super::reply_envelope::{build_reply_envelope, ReplyEnvelopeMetadata};
use super::reply_wait::{ReplyOutcome, ReplyWait};
use super::requester_delivery::deliver_reply;
use super::scope::{resolve_session_scope, SessionScope};
use crate::app_state::AppState;
use crate::error::AppError;

pub(super) async fn claim_and_deliver(
    state: &AppState,
    wait: &ReplyWait,
    outcome: ReplyOutcome,
    body: &str,
) -> Result<(), AppError> {
    let Some(claim) = claim(&state.write_pool, wait.id).await? else {
        return Ok(());
    };
    let started_at = std::time::Instant::now();
    let responder = match resolve_session_scope(&state.write_pool, wait.responder_session_id).await
    {
        Ok(responder) => responder,
        Err(error) => return fail_claim(state, wait, outcome, &claim.token, error).await,
    };
    let requester = match resolve_session_scope(&state.write_pool, wait.requester_session_id).await
    {
        Ok(requester) => requester,
        Err(error) => return fail_claim(state, wait, outcome, &claim.token, error).await,
    };
    let envelope = reply_envelope(wait, &responder, outcome.envelope_status(), body);
    let delivery =
        deliver_reply(state, &responder, &requester, &envelope, claim.message_uuid).await;
    let error = delivery.as_ref().err().map(ToString::to_string);
    finalize(
        &state.write_pool,
        wait.id,
        &claim.token,
        outcome,
        error.as_deref(),
    )
    .await?;
    record_reply_delivery_audit(
        state,
        &responder,
        &requester,
        &envelope,
        error.as_deref(),
        started_at,
    )
    .await?;
    delivery
}

async fn fail_claim(
    state: &AppState,
    wait: &ReplyWait,
    outcome: ReplyOutcome,
    claim_token: &str,
    error: AppError,
) -> Result<(), AppError> {
    let message = error.to_string();
    if let Err(finalize_error) = finalize(
        &state.write_pool,
        wait.id,
        claim_token,
        outcome,
        Some(&message),
    )
    .await
    {
        return Err(AppError::internal(format!(
            "reply delivery failed ({message}) and its claim could not be finalized ({finalize_error})"
        )));
    }
    Err(error)
}

struct DeliveryClaim {
    token: String,
    message_uuid: uuid::Uuid,
}

async fn claim(pool: &sqlx::SqlitePool, wait_id: i64) -> Result<Option<DeliveryClaim>, AppError> {
    let token = uuid::Uuid::new_v4().to_string();
    let candidate_message_uuid = uuid::Uuid::new_v4().to_string();
    let claimed: Option<(String, String)> = sqlx::query_as(
        "UPDATE agent_session_reply_waits
         SET delivery_claim_token = ?, delivery_started_at = datetime('now'),
             delivery_message_uuid = COALESCE(delivery_message_uuid, ?),
             delivered_at = NULL, error = NULL
         WHERE id = ? AND status = 'armed' AND delivery_claim_token IS NULL
         RETURNING delivery_claim_token, delivery_message_uuid",
    )
    .bind(&token)
    .bind(candidate_message_uuid)
    .bind(wait_id)
    .fetch_optional(pool)
    .await?;
    claimed
        .map(|(token, message_uuid)| {
            Ok(DeliveryClaim {
                token,
                message_uuid: uuid::Uuid::parse_str(&message_uuid).map_err(|_| {
                    AppError::internal(format!(
                        "reply wait {wait_id} has an invalid delivery message UUID"
                    ))
                })?,
            })
        })
        .transpose()
}

async fn finalize(
    pool: &sqlx::SqlitePool,
    wait_id: i64,
    claim_token: &str,
    outcome: ReplyOutcome,
    error: Option<&str>,
) -> Result<(), AppError> {
    let (status, delivered_at, error) = match error {
        Some(error) => ("failed", None, Some(error)),
        None => (outcome.wait_status(), Some("now"), None),
    };
    let result = sqlx::query(
        "UPDATE agent_session_reply_waits
         SET status = ?,
             delivered_at = CASE WHEN ? IS NULL THEN NULL ELSE datetime('now') END,
             error = ?, delivery_claim_token = NULL
         WHERE id = ? AND delivery_claim_token = ?",
    )
    .bind(status)
    .bind(delivered_at)
    .bind(error)
    .bind(wait_id)
    .bind(claim_token)
    .execute(pool)
    .await?;
    if result.rows_affected() != 1 {
        return Err(AppError::Conflict("reply delivery claim was lost".into()));
    }
    Ok(())
}

fn reply_envelope(wait: &ReplyWait, responder: &SessionScope, status: &str, body: &str) -> String {
    build_reply_envelope(
        ReplyEnvelopeMetadata {
            responder_session_id: responder.session_id,
            responder_feature_id: responder.feature_id,
            responder_feature_title: &responder.feature_title,
            responder_project_id: responder.project_id,
            request_message_id: wait.request_message_id,
            link: if wait.kind == "spawn" {
                "spawned"
            } else {
                "messaged"
            },
            status,
        },
        body,
    )
}
