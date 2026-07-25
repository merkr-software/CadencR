use sqlx::{AssertSqlSafe, SqlitePool};

use super::row::{ScheduleRow, SELECT};
use crate::domain::schedules::models::Schedule;
use crate::error::AppError;

/// Optional narrowing for the list endpoint. The schedules page asks for
/// everything; the composer asks for one conversation.
#[derive(Debug, Default, Clone, Copy)]
pub struct ScheduleFilter {
    pub feature_id: Option<i64>,
    pub project_id: Option<i64>,
}

/// Every schedule matching the filter.
///
/// Ordering is the page's default reading order and the reason the composer can
/// take the first row as "the next one": soonest upcoming run first, then rules
/// with no pending run (paused or finished), newest first among those.
pub async fn list(pool: &SqlitePool, filter: ScheduleFilter) -> Result<Vec<Schedule>, AppError> {
    let mut sql = format!("{SELECT} WHERE 1 = 1");
    if filter.feature_id.is_some() {
        sql.push_str(" AND s.feature_id = ?");
    }
    if filter.project_id.is_some() {
        sql.push_str(" AND COALESCE(s.project_id, f.project_id) = ?");
    }
    sql.push_str(
        " ORDER BY CASE WHEN s.next_run_at IS NULL THEN 1 ELSE 0 END,
                   s.next_run_at ASC, s.id DESC",
    );

    let mut query = sqlx::query_as::<_, ScheduleRow>(AssertSqlSafe(sql));
    if let Some(feature_id) = filter.feature_id {
        query = query.bind(feature_id);
    }
    if let Some(project_id) = filter.project_id {
        query = query.bind(project_id);
    }
    query
        .fetch_all(pool)
        .await?
        .into_iter()
        .map(ScheduleRow::into_schedule)
        .collect()
}

pub async fn get(pool: &SqlitePool, id: i64) -> Result<Option<Schedule>, AppError> {
    let sql = format!("{SELECT} WHERE s.id = ?");
    sqlx::query_as::<_, ScheduleRow>(AssertSqlSafe(sql))
        .bind(id)
        .fetch_optional(pool)
        .await?
        .map(ScheduleRow::into_schedule)
        .transpose()
}

#[cfg(test)]
mod tests {
    use super::super::test_support::{daily_new_conversation, fixture, once_into_conversation};
    use super::super::{insert, set_enabled};
    use super::*;

    #[tokio::test]
    async fn list_orders_by_next_run_and_sinks_finished_rules() {
        let (pool, project_id, feature_id) = fixture().await;
        let far = insert(
            &pool,
            once_into_conversation(feature_id, "2099-01-01T09:00:00Z"),
        )
        .await
        .unwrap();
        let near = insert(
            &pool,
            once_into_conversation(feature_id, "2098-01-01T09:00:00Z"),
        )
        .await
        .unwrap();
        // A finished one-off has no pending run and belongs at the bottom,
        // whatever its original time was.
        let finished = insert(
            &pool,
            once_into_conversation(feature_id, "2027-01-01T09:00:00Z"),
        )
        .await
        .unwrap();
        sqlx::query("UPDATE schedules SET next_run_at = NULL WHERE id = ?")
            .bind(finished.id)
            .execute(&pool)
            .await
            .unwrap();
        let daily = insert(&pool, daily_new_conversation(project_id, "09:00"))
            .await
            .unwrap();

        let listed = list(&pool, ScheduleFilter::default()).await.unwrap();
        let order: Vec<i64> = listed.iter().map(|schedule| schedule.id).collect();
        assert_eq!(order, vec![daily.id, near.id, far.id, finished.id]);

        let conversation = listed.iter().find(|s| s.id == near.id).unwrap();
        assert_eq!(
            conversation.context.feature_title.as_deref(),
            Some("Conversation")
        );
        assert_eq!(conversation.context.project_id, Some(project_id));
        assert_eq!(conversation.context.project_name.as_deref(), Some("Proj"));

        let created = listed.iter().find(|s| s.id == daily.id).unwrap();
        // A new-conversation schedule has no target conversation yet, but still
        // belongs to a project.
        assert_eq!(created.context.feature_title, None);
        assert_eq!(created.context.project_name.as_deref(), Some("Proj"));
    }

    // Pausing keeps the rule readable ("would run at 09:00") rather than
    // blanking it, so the row stays where the user last saw it.
    #[tokio::test]
    async fn pausing_keeps_a_schedule_in_the_list_with_its_time() {
        let (pool, _, feature_id) = fixture().await;
        let created = insert(
            &pool,
            once_into_conversation(feature_id, "2099-01-01T09:00:00Z"),
        )
        .await
        .unwrap();
        set_enabled(&pool, created.id, false).await.unwrap();

        let listed = list(&pool, ScheduleFilter::default()).await.unwrap();
        assert_eq!(listed.len(), 1);
        assert!(!listed[0].enabled);
        assert_eq!(
            listed[0].next_run_at.as_deref(),
            Some("2099-01-01T09:00:00Z")
        );
        assert!(!listed[0].completed);
    }

    #[tokio::test]
    async fn filters_narrow_to_a_conversation_or_project() {
        let (pool, project_id, feature_id) = fixture().await;
        insert(
            &pool,
            once_into_conversation(feature_id, "2099-01-01T09:00:00Z"),
        )
        .await
        .unwrap();
        insert(&pool, daily_new_conversation(project_id, "09:00"))
            .await
            .unwrap();

        let for_feature = list(
            &pool,
            ScheduleFilter {
                feature_id: Some(feature_id),
                project_id: None,
            },
        )
        .await
        .unwrap();
        assert_eq!(for_feature.len(), 1);
        assert_eq!(for_feature[0].target.feature_id, Some(feature_id));

        // Project scope spans both target kinds: the new-conversation rule
        // stores project_id directly, the conversation rule inherits it.
        let for_project = list(
            &pool,
            ScheduleFilter {
                feature_id: None,
                project_id: Some(project_id),
            },
        )
        .await
        .unwrap();
        assert_eq!(for_project.len(), 2);
    }

    #[tokio::test]
    async fn get_returns_none_for_unknown_ids() {
        let (pool, _, _) = fixture().await;
        assert!(get(&pool, 404).await.unwrap().is_none());
    }
}
