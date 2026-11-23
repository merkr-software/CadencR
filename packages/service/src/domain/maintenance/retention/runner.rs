use sqlx::SqlitePool;

use super::super::compaction::{self, CompactionError};
use super::super::{
    StorageMaintenanceBroadcaster, StorageMaintenanceEvent, StorageMaintenanceTask,
};
use super::policy::PolicyGuard;
use super::queries::{DUE_FEATURES_SQL, FEATURE_MESSAGE_IDS_SQL, FEATURE_MESSAGE_SQL};

/// Message ids per batch. Large payloads are fetched individually afterward.
pub(super) const MESSAGE_BATCH: i64 = 16;

/// Yield the writer between batches while the user is driving an agent.
const BATCH_PAUSE: std::time::Duration = std::time::Duration::from_millis(50);

#[derive(Default)]
struct SweepProgress {
    total: u64,
    processed: u64,
    failed: u64,
    cancelled: bool,
}

struct FeatureCompaction {
    rewritten: u64,
    complete: bool,
}

impl FeatureCompaction {
    fn interrupted(rewritten: u64) -> Self {
        Self {
            rewritten,
            complete: false,
        }
    }

    fn complete(rewritten: u64) -> Self {
        Self {
            rewritten,
            complete: true,
        }
    }
}

impl SweepProgress {
    fn terminal_event(&self) -> StorageMaintenanceEvent {
        if self.cancelled {
            StorageMaintenanceEvent::Cancelled {
                task: StorageMaintenanceTask::Cleanup,
                completed: self.processed,
                total: self.total,
            }
        } else if self.failed == 0 {
            StorageMaintenanceEvent::Completed {
                task: StorageMaintenanceTask::Cleanup,
                completed: self.processed,
                total: self.total,
            }
        } else {
            StorageMaintenanceEvent::Failed {
                task: StorageMaintenanceTask::Cleanup,
                completed: self.processed.saturating_sub(self.failed),
                total: self.total,
            }
        }
    }
}

/// Compact every feature whose retention window has elapsed. Returns the number
/// of message rows rewritten.
pub async fn run(
    read_pool: &SqlitePool,
    write_pool: &SqlitePool,
    events: &StorageMaintenanceBroadcaster,
) -> u64 {
    let Some((days, policy)) = PolicyGuard::configured() else {
        return 0;
    };
    run_with_days(read_pool, write_pool, events, days, policy).await
}

async fn run_with_days(
    read_pool: &SqlitePool,
    write_pool: &SqlitePool,
    events: &StorageMaintenanceBroadcaster,
    days: i64,
    mut policy: PolicyGuard,
) -> u64 {
    let due = match due_features(read_pool, days).await {
        Ok(ids) => ids,
        Err(e) => {
            tracing::warn!("retention: failed to list features due for compaction: {e}");
            events.emit(StorageMaintenanceEvent::Failed {
                task: StorageMaintenanceTask::Cleanup,
                completed: 0,
                total: 0,
            });
            return 0;
        }
    };
    if due.is_empty() {
        return 0;
    }

    events.emit(StorageMaintenanceEvent::Started {
        task: StorageMaintenanceTask::Cleanup,
        completed: 0,
        total: due.len() as u64,
    });

    let mut sweep = SweepProgress {
        total: due.len() as u64,
        ..SweepProgress::default()
    };
    let mut rewritten = 0u64;
    let mut compacted_features = 0u64;
    for feature_id in due {
        if !policy.is_current(days) {
            tracing::info!("retention: policy changed, stopping active sweep");
            sweep.cancelled = true;
            break;
        }
        match compact_feature_guarded(read_pool, write_pool, feature_id, days, &mut policy).await {
            Ok(result) => {
                rewritten += result.rewritten;
                // A user can disable retention or increase the quiet period
                // while this feature is being walked. Do not stamp it complete
                // under a policy that is no longer the one they approved.
                let policy_current = policy.is_current(days);
                if result.complete && policy_current {
                    match stamp_compacted(write_pool, feature_id, days).await {
                        Ok(true) => compacted_features += 1,
                        Ok(false) => tracing::info!(
                            feature_id,
                            "retention: feature became ineligible before completion stamp"
                        ),
                        Err(error) => {
                            sweep.failed += 1;
                            tracing::warn!(
                                feature_id,
                                "retention: failed to stamp compacted_at: {error}"
                            );
                        }
                    }
                } else if !policy_current {
                    tracing::info!("retention: policy changed, stopping active sweep");
                    sweep.cancelled = true;
                    break;
                } else {
                    tracing::info!(
                        feature_id,
                        "retention: feature changed during compaction; leaving it pending"
                    );
                }
            }
            // Leave `compacted_at` unset so the next sweep retries this feature.
            Err(e) => {
                sweep.failed += 1;
                tracing::warn!(feature_id, "retention: compaction failed: {e}");
            }
        }
        sweep.processed += 1;
        events.emit(StorageMaintenanceEvent::Progress {
            task: StorageMaintenanceTask::Cleanup,
            completed: sweep.processed,
            total: sweep.total,
        });
    }

    events.emit(sweep.terminal_event());

    if rewritten > 0 {
        tracing::info!(
            features = compacted_features,
            rows = rewritten,
            window_days = days,
            "compacted archived features; run VACUUM to reclaim the file space"
        );
    }
    rewritten
}

/// Walk one feature's tool messages, compacting each. Errors abort this feature
/// only — rows already rewritten stay rewritten, which is safe because the
/// transform is idempotent.
#[cfg(test)]
pub(super) async fn compact_feature(
    pool: &SqlitePool,
    feature_id: i64,
    days: i64,
) -> Result<u64, CompactionError> {
    let mut policy = PolicyGuard::testing(|_| true);
    compact_feature_guarded(pool, pool, feature_id, days, &mut policy)
        .await
        .map(|result| result.rewritten)
}

#[cfg(test)]
pub(super) async fn compact_feature_with_policy(
    pool: &SqlitePool,
    feature_id: i64,
    days: i64,
    check: fn(i64) -> bool,
) -> Result<u64, CompactionError> {
    let mut policy = PolicyGuard::testing(check);
    compact_feature_guarded(pool, pool, feature_id, days, &mut policy)
        .await
        .map(|result| result.rewritten)
}

async fn compact_feature_guarded(
    read_pool: &SqlitePool,
    write_pool: &SqlitePool,
    feature_id: i64,
    days: i64,
    policy: &mut PolicyGuard,
) -> Result<FeatureCompaction, CompactionError> {
    let mut cursor = 0i64;
    let mut rewritten = 0u64;

    loop {
        // Re-check every batch so a feature restored mid-sweep stops promptly.
        if !policy.is_current(days) {
            tracing::info!(feature_id, "retention: policy changed, stopping feature");
            return Ok(FeatureCompaction::interrupted(rewritten));
        }
        if !still_eligible(read_pool, feature_id, days).await? {
            tracing::info!(
                feature_id,
                "retention: feature became active or received recent activity, stopping"
            );
            return Ok(FeatureCompaction::interrupted(rewritten));
        }

        let ids = sqlx::query_scalar::<_, i64>(FEATURE_MESSAGE_IDS_SQL)
            .bind(feature_id)
            .bind(cursor)
            .bind(MESSAGE_BATCH)
            .fetch_all(read_pool)
            .await?;
        if ids.is_empty() {
            return Ok(FeatureCompaction::complete(rewritten));
        }

        for id in ids {
            cursor = id;
            let Some(content) = sqlx::query_scalar::<_, String>(FEATURE_MESSAGE_SQL)
                .bind(id)
                .fetch_optional(read_pool)
                .await?
            else {
                continue;
            };
            let Some(snapshot) = compaction::compact_bash_content_async(content).await? else {
                continue;
            };
            if !policy.is_current(days) {
                tracing::info!(feature_id, "retention: policy changed, stopping feature");
                return Ok(FeatureCompaction::interrupted(rewritten));
            }
            if store_compacted_if_eligible(write_pool, feature_id, id, &snapshot, days).await? {
                rewritten += 1;
            } else {
                tracing::info!(
                    feature_id,
                    "retention: message or feature changed before update; leaving it pending"
                );
                return Ok(FeatureCompaction::interrupted(rewritten));
            }
        }

        tokio::time::sleep(BATCH_PAUSE).await;
    }
}

async fn due_features(pool: &SqlitePool, days: i64) -> Result<Vec<i64>, sqlx::Error> {
    sqlx::query_scalar::<_, i64>(DUE_FEATURES_SQL)
        .bind(format!("-{days} days"))
        .bind(format!("-{days} days"))
        .fetch_all(pool)
        .await
}

pub(super) async fn due_feature_count(pool: &SqlitePool, days: i64) -> Result<u64, sqlx::Error> {
    due_features(pool, days)
        .await
        .map(|features| features.len() as u64)
}

/// Persist one lossy rewrite only while its owning feature is still eligible.
///
/// The archive, latest-activity, and original-content checks are part of the
/// same SQLite statement as the update. Separate preflights leave races where
/// `update_status` can restore the feature, a schedule can add a message, or a
/// running shell can replace the message after cleanup loaded it.
pub(super) async fn store_compacted_if_eligible(
    pool: &SqlitePool,
    feature_id: i64,
    message_id: i64,
    snapshot: &compaction::CompactedSnapshot,
    days: i64,
) -> Result<bool, sqlx::Error> {
    sqlx::query(
        "UPDATE agent_messages SET content = ? \
         WHERE id = ? AND content = ? AND EXISTS ( \
           SELECT 1 FROM agent_sessions s \
           JOIN features f ON f.id = s.feature_id \
           WHERE s.id = agent_messages.session_id \
             AND f.id = ? AND f.status = 'archived' \
             AND f.archived_at <= datetime('now', ?) \
             AND NOT EXISTS ( \
               SELECT 1 FROM agent_sessions recent_s \
               JOIN agent_messages recent_m ON recent_m.session_id = recent_s.id \
               WHERE recent_s.feature_id = f.id \
                 AND recent_m.created_at > datetime('now', ?) \
             ) \
         )",
    )
    .bind(&snapshot.replacement)
    .bind(message_id)
    .bind(&snapshot.original)
    .bind(feature_id)
    .bind(format!("-{days} days"))
    .bind(format!("-{days} days"))
    .execute(pool)
    .await
    .map(|result| result.rows_affected() == 1)
}

async fn still_eligible(
    pool: &SqlitePool,
    feature_id: i64,
    days: i64,
) -> Result<bool, sqlx::Error> {
    sqlx::query_scalar::<_, i64>(
        "SELECT COUNT(*) FROM features f \
         WHERE f.id = ? AND f.status = 'archived' \
           AND f.archived_at <= datetime('now', ?) \
           AND NOT EXISTS ( \
             SELECT 1 FROM agent_sessions s \
             JOIN agent_messages m ON m.session_id = s.id \
             WHERE s.feature_id = f.id AND m.created_at > datetime('now', ?) \
           )",
    )
    .bind(feature_id)
    .bind(format!("-{days} days"))
    .bind(format!("-{days} days"))
    .fetch_one(pool)
    .await
    .map(|count| count > 0)
}

/// Stamp the feature only if it is still archived and still past both clocks.
///
/// A user can un-archive a feature while the sweep is walking it. `update_status`
/// clears `compacted_at` on the way out, so an unguarded stamp here would race
/// it and leave a stale timestamp on an active feature — which
/// `DUE_FEATURES_SQL` reads as "already done", permanently excluding the feature
/// from every future sweep.
pub(super) async fn stamp_compacted(
    pool: &SqlitePool,
    feature_id: i64,
    days: i64,
) -> Result<bool, sqlx::Error> {
    sqlx::query(
        "UPDATE features SET compacted_at = datetime('now') \
         WHERE id = ? AND status = 'archived' \
           AND archived_at <= datetime('now', ?) \
           AND NOT EXISTS ( \
             SELECT 1 FROM agent_sessions s \
             JOIN agent_messages m ON m.session_id = s.id \
             WHERE s.feature_id = features.id AND m.created_at > datetime('now', ?) \
           )",
    )
    .bind(feature_id)
    .bind(format!("-{days} days"))
    .bind(format!("-{days} days"))
    .execute(pool)
    .await
    .map(|result| result.rows_affected() == 1)
}

#[cfg(test)]
pub(super) async fn run_for_test(
    pool: &SqlitePool,
    events: &StorageMaintenanceBroadcaster,
    days: i64,
) -> u64 {
    run_with_days(pool, pool, events, days, PolicyGuard::testing(|_| true)).await
}

#[cfg(test)]
pub(super) async fn run_for_test_with_policy(
    pool: &SqlitePool,
    events: &StorageMaintenanceBroadcaster,
    days: i64,
    check: fn(i64) -> bool,
) -> u64 {
    run_with_days(pool, pool, events, days, PolicyGuard::testing(check)).await
}
