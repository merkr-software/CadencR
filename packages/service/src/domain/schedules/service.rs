use chrono::Utc;

use super::models::ScheduleRunResult;
use super::{dispatch, repository};
use crate::app_state::AppState;
use crate::error::AppError;

/// Run a schedule on demand.
///
/// A manual run is a preview: it delivers the prompt exactly as the scheduler
/// would, but leaves `next_run_at` alone so testing a daily message at 3pm
/// doesn't move tomorrow's 9am run. The failure is reported in the response
/// *and* recorded on the row, so it shows up in the list like any other run.
pub async fn run_now(state: &AppState, id: i64) -> Result<ScheduleRunResult, AppError> {
    let schedule = repository::get(&state.read_pool, id)
        .await?
        .ok_or_else(|| AppError::NotFound(format!("schedule {id} not found")))?;

    // Distinct per invocation: a manual run is a genuinely new message, not a
    // redelivery of the occurrence the timer owns.
    let occurrence = format!("manual:{}", Utc::now().to_rfc3339());
    match dispatch::run(state, &schedule, &occurrence).await {
        Ok(feature_id) => {
            // Logged, not propagated: the prompt has already been delivered, so
            // failing the request would invite a retry that sends the user's
            // conversation a second real message. Losing the history row is the
            // lesser of the two, and the run itself still succeeded.
            if let Err(error) =
                repository::record_manual_run(&state.write_pool, id, "sent", None, Some(feature_id))
                    .await
            {
                tracing::warn!(
                    error = %error,
                    schedule_id = id,
                    "a manual run was delivered but its history row could not be written"
                );
            }
            Ok(ScheduleRunResult {
                ran: true,
                feature_id: Some(feature_id),
                error: None,
            })
        }
        Err(error) => {
            let message = error.to_string();
            repository::record_manual_run(&state.write_pool, id, "failed", Some(&message), None)
                .await?;
            Ok(ScheduleRunResult {
                ran: false,
                feature_id: None,
                error: Some(message),
            })
        }
    }
}
