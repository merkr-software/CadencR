mod claim;
mod mutations;
mod reads;
mod row;

pub use claim::{claim_due, finish_run, record_manual_run, ClaimedSchedule, RunOutcome};
pub use mutations::{delete, insert, set_enabled, update};
pub use reads::{get, list, ScheduleFilter};

#[cfg(test)]
pub(super) mod test_support {
    use sqlx::SqlitePool;

    use super::super::models::{RecurrenceInput, SaveScheduleRequest, ScheduleTarget, TargetKind};
    use super::super::recurrence::RecurrenceKind;

    /// Migrated pool plus one project and one conversation, the two anchors
    /// every schedule needs.
    pub(crate) async fn fixture() -> (SqlitePool, i64, i64) {
        let pool = SqlitePool::connect("sqlite::memory:").await.unwrap();
        crate::shared::migrate::run_migrations(
            &crate::shared::migrate::MigrationContext::pool_only(&pool),
        )
        .await
        .unwrap();
        let project_id: i64 =
            sqlx::query_scalar("INSERT INTO projects (name, path) VALUES (?, ?) RETURNING id")
                .bind("Proj")
                .bind("/tmp/proj")
                .fetch_one(&pool)
                .await
                .unwrap();
        let feature_id: i64 = sqlx::query_scalar(
            "INSERT INTO features (project_id, title) VALUES (?, ?) RETURNING id",
        )
        .bind(project_id)
        .bind("Conversation")
        .fetch_one(&pool)
        .await
        .unwrap();
        (pool, project_id, feature_id)
    }

    pub(crate) fn once_into_conversation(feature_id: i64, run_at: &str) -> SaveScheduleRequest {
        SaveScheduleRequest {
            name: None,
            prompt: "ping".into(),
            target: ScheduleTarget {
                kind: TargetKind::Conversation,
                feature_id: Some(feature_id),
                project_id: None,
                provider: None,
                model: None,
                thinking_level: None,
                permission_mode: None,
                access_mode: None,
                profile: None,
                worktree_mode: None,
                reuse_branch: None,
                base_branch: None,
            },
            recurrence: RecurrenceInput {
                kind: RecurrenceKind::Once,
                run_at: Some(run_at.into()),
                interval_seconds: None,
                time_of_day: None,
                weekdays: None,
                day_of_month: None,
                timezone: Some("UTC".into()),
            },
            enabled: None,
        }
    }

    pub(crate) fn daily_new_conversation(project_id: i64, time: &str) -> SaveScheduleRequest {
        SaveScheduleRequest {
            name: Some("Standup".into()),
            prompt: "summarise yesterday".into(),
            target: ScheduleTarget {
                kind: TargetKind::NewConversation,
                feature_id: None,
                project_id: Some(project_id),
                provider: None,
                model: None,
                thinking_level: None,
                permission_mode: None,
                access_mode: None,
                profile: None,
                worktree_mode: Some("skip".into()),
                reuse_branch: None,
                base_branch: None,
            },
            recurrence: RecurrenceInput {
                kind: RecurrenceKind::Daily,
                run_at: None,
                interval_seconds: None,
                time_of_day: Some(time.into()),
                weekdays: None,
                day_of_month: None,
                timezone: Some("UTC".into()),
            },
            enabled: None,
        }
    }
}
