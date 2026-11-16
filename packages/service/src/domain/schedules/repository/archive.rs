//! An archived conversation receives no scheduled messages: archiving pauses
//! every schedule aimed at it — a prompt or a custom action — and none can be
//! armed again while it stays archived (see `mutations`). Paused, not deleted:
//! the rule survives, and the Schedules page can resume it after an unarchive.
//! Unarchiving does not resume them on its own, since a schedule the user had
//! paused beforehand is indistinguishable from one the archive paused.

use sqlx::{QueryBuilder, Sqlite, SqliteConnection, SqlitePool};

use crate::domain::schedules::models::ScheduleTarget;
use crate::error::AppError;

/// Pause the armed schedules of `feature_ids`, inside the archive's own
/// transaction so a conversation is never archived with a schedule still
/// armed. Returns the ids paused, for the caller to announce once committed.
pub async fn pause_for_features(
    connection: &mut SqliteConnection,
    feature_ids: &[i64],
) -> Result<Vec<i64>, AppError> {
    let mut paused = Vec::new();
    // Keep each statement below SQLite's conservative bind-parameter limit.
    for chunk in feature_ids.chunks(500) {
        let mut query = QueryBuilder::<Sqlite>::new(
            "UPDATE schedules SET enabled = 0, updated_at = datetime('now') \
             WHERE enabled = 1 AND feature_id IN (",
        );
        let mut separated = query.separated(", ");
        for id in chunk {
            separated.push_bind(id);
        }
        separated.push_unseparated(") RETURNING id");
        paused.extend(
            query
                .build_query_scalar::<i64>()
                .fetch_all(&mut *connection)
                .await?,
        );
    }
    paused.sort_unstable();
    Ok(paused)
}

/// Refuse a write that would leave a schedule armed (`armed`) on an archived
/// conversation; a paused one can still be created or edited.
///
/// Run in the write's own transaction: on the single-connection write pool it
/// is then serialized against an archive, which could otherwise commit between
/// this check and the write and leave the schedule armed.
pub(super) async fn refuse_arming_into_archived(
    connection: &mut SqliteConnection,
    target: &ScheduleTarget,
    armed: bool,
) -> Result<(), AppError> {
    let Some(feature_id) = target.feature_id.filter(|_| armed) else {
        return Ok(());
    };
    let archived: bool = sqlx::query_scalar(
        "SELECT EXISTS (SELECT 1 FROM features WHERE id = ? AND status = 'archived')",
    )
    .bind(feature_id)
    .fetch_one(connection)
    .await?;
    if archived {
        return Err(AppError::Conflict(format!(
            "conversation {feature_id} is archived; unarchive it before arming this schedule"
        )));
    }
    Ok(())
}

/// Pause the armed schedules of every archived conversation, left by versions
/// that archived without pausing. Run once at startup, before the first tick.
pub async fn pause_for_archived_features(pool: &SqlitePool) -> Result<Vec<i64>, AppError> {
    Ok(sqlx::query_scalar(
        "UPDATE schedules SET enabled = 0, updated_at = datetime('now')
         WHERE enabled = 1
           AND feature_id IN (SELECT id FROM features WHERE status = 'archived')
         RETURNING id",
    )
    .fetch_all(pool)
    .await?)
}

#[cfg(test)]
mod tests {
    use super::super::mutations::insert;
    use super::super::reads::get;
    use super::super::test_support::{daily_new_conversation, fixture, once_into_conversation};
    use super::*;

    async fn add_feature(pool: &SqlitePool, project_id: i64, status: &str) -> i64 {
        sqlx::query_scalar(
            "INSERT INTO features (project_id, title, status) VALUES (?, 'f', ?) RETURNING id",
        )
        .bind(project_id)
        .bind(status)
        .fetch_one(pool)
        .await
        .unwrap()
    }

    async fn schedule_into(pool: &SqlitePool, feature_id: i64) -> i64 {
        insert(
            pool,
            once_into_conversation(feature_id, "2099-01-01T09:00:00Z"),
        )
        .await
        .unwrap()
        .id
    }

    async fn enabled(pool: &SqlitePool, id: i64) -> bool {
        get(pool, id).await.unwrap().unwrap().enabled
    }

    #[tokio::test]
    async fn pausing_touches_only_the_armed_schedules_of_the_given_conversations() {
        let (pool, project_id, feature_id) = fixture().await;
        let other = add_feature(&pool, project_id, "active").await;
        let armed = schedule_into(&pool, feature_id).await;
        let already_paused = schedule_into(&pool, feature_id).await;
        sqlx::query("UPDATE schedules SET enabled = 0 WHERE id = ?")
            .bind(already_paused)
            .execute(&pool)
            .await
            .unwrap();
        let elsewhere = schedule_into(&pool, other).await;
        let project_wide = insert(&pool, daily_new_conversation(project_id, "09:00"))
            .await
            .unwrap()
            .id;

        let mut connection = pool.acquire().await.unwrap();
        let paused = pause_for_features(&mut connection, &[feature_id])
            .await
            .unwrap();
        drop(connection);

        assert_eq!(paused, vec![armed]);
        assert!(!enabled(&pool, armed).await);
        assert!(!enabled(&pool, already_paused).await);
        assert!(enabled(&pool, elsewhere).await);
        assert!(enabled(&pool, project_wide).await);
    }

    #[tokio::test]
    async fn the_startup_sweep_pauses_schedules_of_archived_conversations_only() {
        let (pool, project_id, active) = fixture().await;
        let archived = add_feature(&pool, project_id, "active").await;
        let into_active = schedule_into(&pool, active).await;
        let into_archived = schedule_into(&pool, archived).await;
        // What an older version left: archived without pausing.
        sqlx::query("UPDATE features SET status = 'archived' WHERE id = ?")
            .bind(archived)
            .execute(&pool)
            .await
            .unwrap();

        let paused = pause_for_archived_features(&pool).await.unwrap();

        assert_eq!(paused, vec![into_archived]);
        assert!(enabled(&pool, into_active).await);
        assert!(!enabled(&pool, into_archived).await);
        assert!(pause_for_archived_features(&pool).await.unwrap().is_empty());
    }
}
