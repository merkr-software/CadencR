use sqlx::{Row, SqlitePool};
use tracing::{error, warn};

use crate::domain::agents::adapter::{RuntimeTokenUsage, RuntimeTokenUsageEntry};

use super::health;
use super::models::UsageAttribution;
use super::pending;
use super::repository;

mod attribution;

use attribution::resolve_session_attribution;
pub use attribution::snapshot_attribution;

/// Persist one provider-native token report.
///
/// The caller passes the attribution captured at the start of the turn so a
/// model switch cannot file completed usage under the next model. Writes are
/// awaited because usage events are sparse (not token-stream deltas), and the
/// transaction must preserve cumulative counter ordering while atomically
/// updating the durable checkpoint and daily bucket. The database future also
/// runs on a tracked task so shutdown can finish it if the stream reader that
/// was awaiting it gets cancelled.
pub async fn record_runtime_usage(
    write_pool: &SqlitePool,
    session_id: i64,
    attribution: Option<UsageAttribution>,
    usage: RuntimeTokenUsage,
) {
    if usage.is_noop() {
        return;
    }
    let write_pool = write_pool.clone();
    pending::run_tracked(async move {
        let attribution = match attribution {
            Some(attribution) => attribution,
            None => {
                let Some(attribution) = resolve_session_attribution(&write_pool, session_id).await
                else {
                    return;
                };
                attribution
            }
        };

        if let Err(error) = persist_usage(&write_pool, session_id, &attribution, &usage).await {
            report_failure(&error, "failed to record provider token usage");
        }
    })
    .await;
}

async fn persist_usage(
    pool: &SqlitePool,
    session_id: i64,
    attribution: &UsageAttribution,
    usage: &RuntimeTokenUsage,
) -> Result<(), sqlx::Error> {
    let mut tx = pool.begin().await?;
    let exists = sqlx::query_scalar::<_, i64>("SELECT 1 FROM agent_sessions WHERE id = ?")
        .bind(session_id)
        .fetch_optional(&mut *tx)
        .await?
        .is_some();
    if !exists {
        warn!(session_id, "skipped token usage for a deleted session");
        return Ok(());
    }

    match usage {
        RuntimeTokenUsage::Delta { event_id, entries } => {
            if let Some(event_id) = event_id {
                if !repository::claim_event(
                    &mut *tx,
                    session_id,
                    &attribution.provider_id,
                    event_id,
                )
                .await?
                {
                    return Ok(());
                }
            }
            add_entries(&mut tx, attribution, entries).await?;
        }
        RuntimeTokenUsage::Cumulative { entry: current } => {
            let checkpoint = sqlx::query(
                "SELECT input_tokens, output_tokens
                 FROM provider_usage_checkpoints
                 WHERE session_id = ? AND provider_id = ?",
            )
            .bind(session_id)
            .bind(&attribution.provider_id)
            .fetch_optional(&mut *tx)
            .await?;
            let previous_input = checkpoint
                .as_ref()
                .map(|row| row.try_get::<i64, _>("input_tokens"))
                .transpose()?
                .map(nonnegative)
                .unwrap_or(0);
            let previous_output = checkpoint
                .as_ref()
                .map(|row| row.try_get::<i64, _>("output_tokens"))
                .transpose()?
                .map(nonnegative)
                .unwrap_or(0);
            if current.input_tokens == previous_input && current.output_tokens == previous_output {
                return tx.commit().await;
            }
            let delta = RuntimeTokenUsageEntry {
                model_id: current.model_id.clone(),
                input_tokens: current.input_tokens.saturating_sub(previous_input),
                output_tokens: current.output_tokens.saturating_sub(previous_output),
            };
            add_entries(&mut tx, attribution, &[delta]).await?;
            sqlx::query(
                "INSERT INTO provider_usage_checkpoints
                     (session_id, provider_id, input_tokens, output_tokens)
                 VALUES (?, ?, ?, ?)
                 ON CONFLICT(session_id, provider_id) DO UPDATE SET
                     input_tokens = excluded.input_tokens,
                     output_tokens = excluded.output_tokens",
            )
            .bind(session_id)
            .bind(&attribution.provider_id)
            .bind(repository::as_i64(current.input_tokens))
            .bind(repository::as_i64(current.output_tokens))
            .execute(&mut *tx)
            .await?;
        }
    }

    tx.commit().await
}

async fn add_entries(
    tx: &mut sqlx::Transaction<'_, sqlx::Sqlite>,
    attribution: &UsageAttribution,
    entries: &[RuntimeTokenUsageEntry],
) -> Result<(), sqlx::Error> {
    for entry in entries {
        if entry.input_tokens == 0 && entry.output_tokens == 0 {
            continue;
        }
        let mut bucket = attribution.clone();
        if let Some(model_id) = entry.model_id.as_ref().filter(|model| !model.is_empty()) {
            bucket.model_id = model_id.clone();
        }
        repository::add_tokens_on_day(
            &mut **tx,
            None,
            &bucket,
            entry.input_tokens,
            entry.output_tokens,
        )
        .await?;
    }
    Ok(())
}

fn nonnegative(value: i64) -> u64 {
    u64::try_from(value).unwrap_or(0)
}

/// Log *and* remember the failure, so the next `/api/usage-stats` read can tell
/// the user their numbers are incomplete rather than silently under-reporting.
pub(super) fn report_failure(error: &sqlx::Error, context: &str) {
    error!(%error, "{context}");
    health::record_failure(&error.to_string());
}

#[cfg(test)]
mod tests {
    use super::attribution::pool_with_session;
    use super::record_runtime_usage;
    use crate::domain::agents::adapter::{RuntimeTokenUsage, RuntimeTokenUsageEntry};
    use crate::domain::usage_stats::repository::list_recent;

    fn entry(model: Option<&str>, input_tokens: u64, output_tokens: u64) -> RuntimeTokenUsageEntry {
        RuntimeTokenUsageEntry {
            model_id: model.map(ToOwned::to_owned),
            input_tokens,
            output_tokens,
        }
    }

    #[tokio::test]
    async fn cumulative_reports_add_only_the_new_tokens() {
        let (pool, session_id) =
            pool_with_session(Some("codex"), Some("gpt-5.4"), Some("high")).await;
        let attribution = super::snapshot_attribution(&pool, session_id).await;

        record_runtime_usage(
            &pool,
            session_id,
            attribution.clone(),
            RuntimeTokenUsage::cumulative(entry(None, 100, 20)),
        )
        .await;
        record_runtime_usage(
            &pool,
            session_id,
            attribution,
            RuntimeTokenUsage::cumulative(entry(None, 175, 35)),
        )
        .await;

        let rows = list_recent(&pool, 30).await.unwrap();
        assert_eq!((rows[0].input_tokens, rows[0].output_tokens), (175, 35));
    }

    #[tokio::test]
    async fn a_nonconsecutive_replayed_turn_event_is_counted_once() {
        let (pool, session_id) =
            pool_with_session(Some("opencode"), Some("openai/gpt-5.4"), None).await;
        let attribution = super::snapshot_attribution(&pool, session_id).await;
        let first = RuntimeTokenUsage::delta(Some("prompt-1".into()), vec![entry(None, 90, 10)]);
        let second = RuntimeTokenUsage::delta(Some("prompt-2".into()), vec![entry(None, 45, 5)]);

        record_runtime_usage(&pool, session_id, attribution.clone(), first.clone()).await;
        record_runtime_usage(&pool, session_id, attribution.clone(), second).await;
        record_runtime_usage(&pool, session_id, attribution, first).await;

        let rows = list_recent(&pool, 30).await.unwrap();
        assert_eq!((rows[0].input_tokens, rows[0].output_tokens), (135, 15));
    }

    #[tokio::test]
    async fn per_model_entries_keep_claude_models_separate() {
        let (pool, session_id) =
            pool_with_session(Some("claude_code"), Some("opus"), Some("high")).await;
        let usage = RuntimeTokenUsage::delta(
            Some("result-1".into()),
            vec![entry(Some("opus"), 100, 10), entry(Some("haiku"), 20, 5)],
        );

        record_runtime_usage(
            &pool,
            session_id,
            super::snapshot_attribution(&pool, session_id).await,
            usage,
        )
        .await;

        let rows = list_recent(&pool, 30).await.unwrap();
        assert_eq!(rows.len(), 2);
        assert_eq!(rows[0].model_id, "haiku");
        assert_eq!(rows[1].model_id, "opus");
    }

    #[tokio::test]
    async fn a_cumulative_counter_reset_does_not_inflate_usage() {
        let (pool, session_id) = pool_with_session(Some("cursor"), Some("auto"), None).await;
        let attribution = super::snapshot_attribution(&pool, session_id).await;
        for total in [100, 0, 40] {
            record_runtime_usage(
                &pool,
                session_id,
                attribution.clone(),
                RuntimeTokenUsage::cumulative(entry(None, total, 0)),
            )
            .await;
        }

        let rows = list_recent(&pool, 30).await.unwrap();
        assert_eq!(rows[0].input_tokens, 140);
    }

    #[tokio::test]
    async fn cumulative_checkpoints_are_scoped_to_the_provider() {
        let (pool, session_id) = pool_with_session(Some("codex"), Some("gpt-5.4"), None).await;
        let mut attribution = super::snapshot_attribution(&pool, session_id)
            .await
            .expect("session attribution");

        record_runtime_usage(
            &pool,
            session_id,
            Some(attribution.clone()),
            RuntimeTokenUsage::cumulative(entry(None, 100, 10)),
        )
        .await;
        attribution.provider_id = "cursor".into();
        attribution.model_id = "auto".into();
        record_runtime_usage(
            &pool,
            session_id,
            Some(attribution),
            RuntimeTokenUsage::cumulative(entry(None, 80, 0)),
        )
        .await;

        let rows = list_recent(&pool, 30).await.unwrap();
        assert_eq!(rows.len(), 2);
        assert_eq!(rows[0].provider_id, "codex");
        assert_eq!(rows[0].input_tokens, 100);
        assert_eq!(rows[1].provider_id, "cursor");
        assert_eq!(rows[1].input_tokens, 80);
    }

    #[tokio::test]
    async fn deleting_a_conversation_preserves_aggregate_usage() {
        let (pool, session_id) =
            pool_with_session(Some("opencode"), Some("openai/gpt-5.4"), None).await;
        let opencode = super::snapshot_attribution(&pool, session_id)
            .await
            .expect("session attribution");
        record_runtime_usage(
            &pool,
            session_id,
            Some(opencode.clone()),
            RuntimeTokenUsage::delta(Some("turn-1".into()), vec![entry(None, 40, 2)]),
        )
        .await;
        let mut codex = opencode;
        codex.provider_id = "codex".into();
        record_runtime_usage(
            &pool,
            session_id,
            Some(codex),
            RuntimeTokenUsage::cumulative(entry(None, 100, 10)),
        )
        .await;

        crate::domain::ws_session::persistence::WsSessionPersistence::delete_session_static(
            &pool, session_id,
        )
        .await
        .unwrap();

        let rows = list_recent(&pool, 30).await.unwrap();
        assert_eq!(rows.len(), 2);
        assert_eq!(rows.iter().map(|row| row.input_tokens).sum::<i64>(), 140);
        assert_eq!(rows.iter().map(|row| row.output_tokens).sum::<i64>(), 12);
        let checkpoints: i64 =
            sqlx::query_scalar("SELECT COUNT(*) FROM provider_usage_checkpoints")
                .fetch_one(&pool)
                .await
                .unwrap();
        let events: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM provider_usage_events")
            .fetch_one(&pool)
            .await
            .unwrap();
        assert_eq!((checkpoints, events), (0, 0));
    }
}
