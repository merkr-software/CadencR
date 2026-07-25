use serde::{Deserialize, Serialize};
use utoipa::ToSchema;

/// One bucket of the usage timeline: everything the user exchanged with a
/// single provider / model / thinking-effort combination on one UTC day.
///
/// `model_id` and `thinking_effort` are empty strings — never null — when the
/// provider reported none; see the migration for why.
#[derive(Debug, Clone, Serialize, Deserialize, sqlx::FromRow, ToSchema)]
pub struct UsageStatsEntry {
    /// UTC day, `YYYY-MM-DD`.
    pub day: String,
    pub provider_id: String,
    pub model_id: String,
    pub thinking_effort: String,
    /// Words sent to the provider (user prompts).
    pub input_words: i64,
    /// Words received from the provider (assistant text and thinking).
    pub output_words: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize, ToSchema)]
pub struct UsageStatsResponse {
    /// Size of the trailing window the entries were read from, in days.
    pub days: i64,
    /// Last (most recent) UTC day of the window, `YYYY-MM-DD`, as the database
    /// computed it. The client builds its day axis from this rather than from
    /// its own clock: a request straddling UTC midnight — or a skewed client
    /// clock — would otherwise shift the axis off the returned rows, dropping
    /// the oldest day and appending a blank one.
    pub end_day: String,
    /// Flat buckets, oldest day first. The client pivots these into the
    /// per-provider and per-model timelines; the row count is bounded by
    /// days × providers × models × efforts.
    pub entries: Vec<UsageStatsEntry>,
    /// Present when at least one usage write has failed since startup, so the
    /// UI can warn that these numbers are incomplete.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub recording_issue: Option<super::health::UsageRecordingIssue>,
}

/// What to attribute a batch of words to. Resolved from the session row at
/// record time so the numbers survive the session being deleted afterwards.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct UsageAttribution {
    pub provider_id: String,
    pub model_id: String,
    pub thinking_effort: String,
}

#[cfg(test)]
mod tests {
    use super::{UsageStatsEntry, UsageStatsResponse};

    #[test]
    fn response_serializes_empty_model_and_effort_as_strings() {
        let response = UsageStatsResponse {
            days: 30,
            end_day: "2026-07-25".into(),
            recording_issue: None,
            entries: vec![UsageStatsEntry {
                day: "2026-07-25".into(),
                provider_id: "claude_code".into(),
                model_id: String::new(),
                thinking_effort: String::new(),
                input_words: 12,
                output_words: 345,
            }],
        };

        let json = serde_json::to_string(&response).unwrap();
        assert!(json.contains("\"days\":30"));
        assert!(json.contains("\"end_day\":\"2026-07-25\""));
        assert!(json.contains("\"model_id\":\"\""));
        assert!(json.contains("\"thinking_effort\":\"\""));
        assert!(json.contains("\"output_words\":345"));
        assert!(
            !json.contains("recording_issue"),
            "a healthy response stays quiet"
        );
    }
}
