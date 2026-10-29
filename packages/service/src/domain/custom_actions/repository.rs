mod action_mutations;
mod actions;
mod runs;
mod schedules;
mod variables;

pub use action_mutations::{delete, reorder, update};
pub use actions::{get, insert, list_for_project};
pub use runs::{fail_orphaned_runs, finalize_run, insert_run, list_runs, update_run_output};
pub use schedules::{
    delete_schedule, get_schedule, list_enabled_schedules, touch_schedule_last_run, upsert_schedule,
};
pub use variables::{list_variables, upsert_variable};

#[cfg(test)]
pub(super) mod test_support {
    use sqlx::SqlitePool;

    pub(super) async fn pool_with_project_and_feature() -> (SqlitePool, i64, i64) {
        let pool = SqlitePool::connect("sqlite::memory:").await.unwrap();
        crate::shared::migrate::run_migrations(
            &crate::shared::migrate::MigrationContext::pool_only(&pool),
        )
        .await
        .unwrap();
        let project_id: i64 =
            sqlx::query_scalar("INSERT INTO projects (name, path) VALUES (?, ?) RETURNING id")
                .bind("p")
                .bind("/tmp/p")
                .fetch_one(&pool)
                .await
                .unwrap();
        let feature_id: i64 = sqlx::query_scalar(
            "INSERT INTO features (project_id, title) VALUES (?, ?) RETURNING id",
        )
        .bind(project_id)
        .bind("f")
        .fetch_one(&pool)
        .await
        .unwrap();
        (pool, project_id, feature_id)
    }
}
