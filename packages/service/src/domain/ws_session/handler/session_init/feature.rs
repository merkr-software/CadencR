use super::{send_error, WsSender};
use crate::app_state::AppState;

pub(super) async fn require_feature_project_id(
    app_state: &AppState,
    sender: &WsSender,
    envelope_id: &str,
    feature_id: i64,
) -> Option<i64> {
    match sqlx::query_scalar::<_, i64>("SELECT project_id FROM features WHERE id = ?")
        .bind(feature_id)
        .fetch_optional(&app_state.read_pool)
        .await
    {
        Ok(Some(project_id)) => Some(project_id),
        Ok(None) => {
            send_error(
                sender,
                envelope_id,
                "FEATURE_NOT_FOUND",
                "Feature not found",
            );
            None
        }
        Err(error) => {
            tracing::error!(feature_id, %error, "failed to verify feature before session init");
            send_error(
                sender,
                envelope_id,
                "DB_ERROR",
                "Failed to verify feature in database",
            );
            None
        }
    }
}
