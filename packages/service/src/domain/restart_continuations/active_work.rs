use std::collections::HashMap;

use serde::Serialize;
use utoipa::ToSchema;

use crate::app_state::AppState;
use crate::domain::session_status::AgentStatus;

#[derive(Debug, Serialize, ToSchema)]
pub(crate) struct ActiveCloseWork {
    pub session_id: i64,
    pub feature_id: i64,
    pub label: String,
    /// The label is a placeholder that clients can translate.
    pub label_uses_fallback: bool,
    pub waiting_on_you: bool,
    pub background_only: bool,
}

/// The live status book covers active turns on every device. The durable
/// background-work registry also covers conversations between turns.
pub(super) async fn list(state: &AppState) -> Result<Vec<ActiveCloseWork>, sqlx::Error> {
    let snapshot: HashMap<_, _> = state
        .session_status_tx
        .snapshot()
        .states
        .into_values()
        .map(|entry| (entry.session_id, entry.status))
        .collect();
    let mut active_ids: Vec<_> = snapshot.keys().copied().collect();
    active_ids.extend(
        crate::domain::ws_session::runtime::prompt::runtime_hold_registry::sessions_holding_background_work(),
    );
    let rows: Vec<(i64, i64, Option<String>)> = sqlx::query_as(
        "WITH work AS (
             SELECT value AS session_id FROM json_each(?)
             UNION
             SELECT w.session_id FROM agent_background_work w WHERE NOT EXISTS (
                 SELECT 1 FROM agent_user_stops u WHERE u.session_id = w.session_id
             )
         )
         SELECT s.id, s.feature_id, NULLIF(f.title, '')
         FROM work JOIN agent_sessions s ON s.id = work.session_id
         JOIN features f ON f.id = s.feature_id
         WHERE s.agent_type = 'session'
         ORDER BY s.id",
    )
    .bind(sqlx::types::Json(active_ids))
    .fetch_all(&state.read_pool)
    .await?;
    Ok(rows
        .into_iter()
        .map(|(session_id, feature_id, label)| {
            let status = snapshot.get(&session_id).copied();
            ActiveCloseWork {
                session_id,
                feature_id,
                label_uses_fallback: label.is_none(),
                label: label.unwrap_or_else(|| "Untitled conversation".to_owned()),
                waiting_on_you: status == Some(AgentStatus::Question),
                background_only: matches!(status, None | Some(AgentStatus::Idle)),
            }
        })
        .collect())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::domain::restart_continuations::store::tests::session;
    use crate::domain::schedules::repository::test_support::fixture;

    #[tokio::test]
    async fn includes_unopened_background_work_and_deduplicates_active_turns() {
        let (pool, _, feature_id) = fixture().await;
        let state = AppState::with_pool(pool.clone());
        let active = session(&pool, feature_id, "running").await;
        let unopened = session(&pool, feature_id, "completed").await;
        let stopped = session(&pool, feature_id, "completed").await;
        let now = chrono::Utc::now();
        for session_id in [active, unopened, stopped] {
            crate::domain::restart_continuations::record_background_work(
                &pool,
                session_id,
                Some(now),
            )
            .await
            .unwrap();
        }
        crate::domain::restart_continuations::record_user_stop(&pool, stopped, now)
            .await
            .unwrap();
        state
            .session_status_tx
            .broadcast_running(active, feature_id);

        let work = list(&state).await.unwrap();

        assert_eq!(
            work.iter()
                .map(|entry| (entry.session_id, entry.background_only))
                .collect::<Vec<_>>(),
            [(active, false), (unopened, true)]
        );
        assert!(work.iter().all(|entry| !entry.label.is_empty()));
    }

    #[tokio::test]
    async fn distinguishes_a_placeholder_from_a_conversation_with_the_same_title() {
        let (pool, _, feature_id) = fixture().await;
        let state = AppState::with_pool(pool.clone());
        let active = session(&pool, feature_id, "running").await;
        state
            .session_status_tx
            .broadcast_running(active, feature_id);

        for (title, is_fallback) in [("", true), ("Untitled conversation", false)] {
            sqlx::query("UPDATE features SET title = ? WHERE id = ?")
                .bind(title)
                .bind(feature_id)
                .execute(&pool)
                .await
                .unwrap();

            let work = list(&state).await.unwrap();

            assert_eq!(work.len(), 1);
            assert_eq!(work[0].label, "Untitled conversation");
            assert_eq!(work[0].label_uses_fallback, is_fallback);
        }
    }
}
