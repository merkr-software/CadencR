//! Which of the two counters owns a given prompt.
//!
//! The historical import and the live recorder both count prompts, and every
//! prompt must be counted by exactly one of them. The cutoff message id says
//! which messages the import *covers*; it does not say which it *counted*. A
//! prompt persisted before the cutoff can still be sitting undelivered — left
//! `pending` by a quit mid-turn, or turned into `error` by restart recovery —
//! and may reach a provider much later, through the live path.
//!
//! So delivery, not persistence, decides: the import counts a prompt only if it
//! had already been delivered when the import claimed its cutoff, and the live
//! recorder counts every delivery after that instant. A prompt that is never
//! delivered is counted by neither, which is correct — it never reached a
//! provider, and the live recorder deliberately scores delivery rather than
//! persistence.

use std::sync::LazyLock;

use sqlx::{Row, SqlitePool};

/// True when this message was already delivered at the claim instant.
///
/// Messages with no lifecycle row at all are genuine legacy history, written
/// before `agent_message_dispatches` existed, and belong to the import. A NULL
/// `claimed_at` is a claim made before that column existed: there is no instant
/// to compare against, so delivery status alone decides.
pub(crate) const DELIVERED_BEFORE_CLAIM_SQL: &str = "
    NOT EXISTS (SELECT 1 FROM agent_message_dispatches d WHERE d.message_id = {message})
    OR EXISTS (
        SELECT 1 FROM agent_message_dispatches d
         WHERE d.message_id = {message}
           AND d.status = 'dispatched'
           AND ({claimed_at} IS NULL
                OR d.dispatched_at IS NULL
                OR d.dispatched_at < {claimed_at})
    )
";

/// Render [`DELIVERED_BEFORE_CLAIM_SQL`] against a message expression and a
/// claim-instant expression, so the import's scan and the live recorder's
/// check are literally the same predicate rather than two copies that can drift.
pub(crate) fn delivered_before_claim(message: &str, claimed_at: &str) -> String {
    DELIVERED_BEFORE_CLAIM_SQL
        .replace("{message}", message)
        .replace("{claimed_at}", claimed_at)
}

/// Does the historical import own this prompt's words?
///
/// `false` when there is no import marker yet, when the message is past the
/// cutoff, or when it had not been delivered by the time the import claimed —
/// in all of which cases the live recorder is the one that must count it.
pub async fn owns_prompt(pool: &SqlitePool, message_id: i64) -> Result<bool, sqlx::Error> {
    // Composed once: the predicate is assembled from a fragment, and `sqlx`
    // only accepts statements that outlive the call.
    static OWNS_PROMPT_SQL: LazyLock<String> = LazyLock::new(|| {
        format!(
            "SELECT EXISTS (
                 SELECT 1 FROM provider_usage_backfill b
                  WHERE b.id = 1
                    AND ? <= b.cutoff_message_id
                    AND ({predicate})
             )",
            predicate = delivered_before_claim("?", "b.claimed_at")
        )
    });

    let row = sqlx::query(OWNS_PROMPT_SQL.as_str())
        .bind(message_id)
        .bind(message_id)
        .bind(message_id)
        .fetch_one(pool)
        .await?;
    row.try_get::<i64, _>(0).map(|owned| owned == 1)
}

#[cfg(test)]
mod tests {
    use super::owns_prompt;
    use crate::domain::usage_stats::backfill::test_fixtures::{claim_at, message_pool};

    /// Legacy history: no dispatch lifecycle row at all.
    #[tokio::test]
    async fn owns_a_prompt_from_before_the_dispatch_lifecycle() {
        let (pool, message_id) = message_pool(None).await;
        claim_at(&pool, message_id, Some("2026-07-25 12:00:00")).await;

        assert!(owns_prompt(&pool, message_id).await.unwrap());
    }

    #[tokio::test]
    async fn owns_a_prompt_delivered_before_the_claim() {
        let (pool, message_id) =
            message_pool(Some(("dispatched", Some("2026-07-25 11:00:00")))).await;
        claim_at(&pool, message_id, Some("2026-07-25 12:00:00")).await;

        assert!(owns_prompt(&pool, message_id).await.unwrap());
    }

    /// The case that used to double-count: persisted before the cutoff, but only
    /// delivered afterwards, so the live recorder must be the one to score it.
    #[tokio::test]
    async fn leaves_a_prompt_delivered_after_the_claim_to_the_live_recorder() {
        let (pool, message_id) =
            message_pool(Some(("dispatched", Some("2026-07-25 13:00:00")))).await;
        claim_at(&pool, message_id, Some("2026-07-25 12:00:00")).await;

        assert!(!owns_prompt(&pool, message_id).await.unwrap());
    }

    #[tokio::test]
    async fn leaves_an_undelivered_prompt_to_whoever_finally_delivers_it() {
        for status in ["pending", "error"] {
            let (pool, message_id) = message_pool(Some((status, None))).await;
            claim_at(&pool, message_id, Some("2026-07-25 12:00:00")).await;

            assert!(
                !owns_prompt(&pool, message_id).await.unwrap(),
                "{status} prompts have not reached a provider yet"
            );
        }
    }

    #[tokio::test]
    async fn a_message_past_the_cutoff_is_never_owned() {
        let (pool, message_id) = message_pool(None).await;
        claim_at(&pool, message_id - 1, Some("2026-07-25 12:00:00")).await;

        assert!(!owns_prompt(&pool, message_id).await.unwrap());
    }

    #[tokio::test]
    async fn nothing_is_owned_before_the_import_has_claimed() {
        let (pool, message_id) = message_pool(None).await;

        assert!(!owns_prompt(&pool, message_id).await.unwrap());
    }

    /// A claim made before `claimed_at` existed: status alone has to decide.
    #[tokio::test]
    async fn falls_back_to_delivery_status_when_the_claim_instant_is_unknown() {
        let (pool, delivered) =
            message_pool(Some(("dispatched", Some("2026-07-25 13:00:00")))).await;
        claim_at(&pool, delivered, None).await;
        assert!(owns_prompt(&pool, delivered).await.unwrap());

        let (pool, pending) = message_pool(Some(("pending", None))).await;
        claim_at(&pool, pending, None).await;
        assert!(!owns_prompt(&pool, pending).await.unwrap());
    }
}
