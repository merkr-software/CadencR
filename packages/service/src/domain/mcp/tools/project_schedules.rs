use serde_json::json;

use crate::domain::mcp::context::McpContext;
use crate::domain::schedules::repository::{self, ScheduleFilter};

/// Every schedule delivering into the calling conversation — the agent's own
/// and any the user set up — in the Schedules page's reading order. Read
/// straight from the database like the other read tools; only writes need the
/// service.
pub async fn list_schedules(ctx: &McpContext) -> Result<serde_json::Value, String> {
    let schedules = repository::list(
        &ctx.read_pool,
        ScheduleFilter {
            feature_id: Some(ctx.feature_id),
            ..ScheduleFilter::default()
        },
    )
    .await
    .map_err(|e| format!("Failed to list schedules: {e}"))?;
    Ok(json!({
        "feature_id": ctx.feature_id,
        "schedules": schedules,
    }))
}

#[cfg(test)]
mod tests {
    use super::list_schedules;
    use crate::domain::mcp::context::McpContext;
    use crate::domain::schedules::repository::insert;
    use crate::domain::schedules::repository::test_support::{
        daily_new_conversation, fixture, once_into_conversation,
    };

    #[tokio::test]
    async fn only_schedules_delivering_into_this_conversation_are_listed() {
        let (pool, project_id, feature_id) = fixture().await;
        let mine = insert(
            &pool,
            once_into_conversation(feature_id, "2099-01-01T09:00:00Z"),
        )
        .await
        .unwrap();
        // Same project, but it creates its own conversation each run.
        insert(&pool, daily_new_conversation(project_id, "09:00"))
            .await
            .unwrap();

        let ctx = std::sync::Arc::new(
            McpContext::builder()
                .read_pool(pool)
                .feature_id(feature_id)
                .source_session_id(1)
                .build(),
        );
        let result = list_schedules(&ctx).await.unwrap();

        let schedules = result["schedules"].as_array().unwrap();
        assert_eq!(schedules.len(), 1);
        assert_eq!(schedules[0]["id"], mine.id);
        assert_eq!(schedules[0]["prompt"], "ping");
    }
}
