use axum::extract::{Query, State};
use axum::routing::get;
use axum::{Json, Router};
use serde::Deserialize;

use crate::app_state::AppState;
use crate::error::AppError;

use super::models::{UsageStatsEntry, UsageStatsResponse};
use super::repository;

/// Trailing window shown by the settings Stats tab when the client asks for no
/// particular range.
const DEFAULT_DAYS: i64 = 30;
/// Upper bound on the window. Keeps a hand-crafted request from scanning the
/// whole table; two years is far beyond any useful bar-chart density.
const MAX_DAYS: i64 = 730;

#[derive(Debug, Deserialize)]
pub struct UsageStatsQuery {
    /// Size of the trailing window in days, counting today. Clamped to
    /// `1..=730`; defaults to 30.
    days: Option<i64>,
}

#[utoipa::path(
    get,
    path = "/api/usage-stats",
    params(("days" = Option<i64>, Query, description = "Trailing window in days (1-730, default 30)")),
    responses((status = 200, body = UsageStatsResponse))
)]
pub async fn get_usage_stats_handler(
    State(state): State<AppState>,
    Query(query): Query<UsageStatsQuery>,
) -> Result<Json<UsageStatsResponse>, AppError> {
    let days = clamp_days(query.days);
    // Read the window bound first: taking it after the rows could name a day the
    // rows predate if the request straddles UTC midnight.
    let end_day = repository::end_day(&state.read_pool).await?;
    let entries: Vec<UsageStatsEntry> = repository::list_window(&state.read_pool, days).await?;
    Ok(Json(UsageStatsResponse {
        days,
        end_day,
        entries,
        recording_issue: super::health::snapshot(&state.read_pool).await,
        import_in_progress: super::backfill::in_progress(&state.read_pool).await?,
    }))
}

fn clamp_days(requested: Option<i64>) -> i64 {
    requested.unwrap_or(DEFAULT_DAYS).clamp(1, MAX_DAYS)
}

pub fn usage_stats_router() -> Router<AppState> {
    Router::new().route("/api/usage-stats", get(get_usage_stats_handler))
}

#[cfg(test)]
mod tests {
    use super::{clamp_days, DEFAULT_DAYS, MAX_DAYS};

    #[test]
    fn defaults_to_a_thirty_day_window() {
        assert_eq!(clamp_days(None), DEFAULT_DAYS);
    }

    #[test]
    fn clamps_out_of_range_windows() {
        assert_eq!(clamp_days(Some(0)), 1);
        assert_eq!(clamp_days(Some(-5)), 1);
        assert_eq!(clamp_days(Some(100_000)), MAX_DAYS);
    }

    #[test]
    fn keeps_windows_inside_the_range() {
        assert_eq!(clamp_days(Some(7)), 7);
        assert_eq!(clamp_days(Some(MAX_DAYS)), MAX_DAYS);
    }
}
