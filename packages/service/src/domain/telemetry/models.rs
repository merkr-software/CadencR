use serde::{Deserialize, Serialize};
use utoipa::ToSchema;

#[derive(Clone, Copy, Debug, Default, Deserialize, Serialize, ToSchema)]
#[serde(deny_unknown_fields)]
pub struct TelemetryConsent {
    pub diagnostics_enabled: bool,
    pub usage_enabled: bool,
    /// Omit for a detailed telemetry decision to preserve the current counter setting.
    pub audience_enabled: Option<bool>,
}

#[derive(Clone, Copy, Debug, Serialize, ToSchema)]
#[serde(rename_all = "snake_case")]
pub enum DeliveryStatus {
    Disabled,
    NotConfigured,
    Ready,
    DeliveryFailed,
}

#[derive(Serialize, ToSchema)]
pub struct TelemetryPreferences {
    pub diagnostics_enabled: bool,
    pub usage_enabled: bool,
    pub audience_enabled: bool,
    pub decision_version: Option<u32>,
    pub installation_id: Option<String>,
    pub diagnostics_configured: bool,
    pub usage_configured: bool,
    pub audience_configured: bool,
    pub diagnostics_status: DeliveryStatus,
    pub usage_status: DeliveryStatus,
    pub audience_status: DeliveryStatus,
}

/// The wire contract deliberately has no message, URL, context or arbitrary properties.
#[derive(Clone, Debug, Deserialize, Serialize, ToSchema)]
#[serde(deny_unknown_fields)]
pub struct DiagnosticReport {
    pub category: DiagnosticCategory,
    #[serde(default)]
    pub frames: Vec<DiagnosticFrame>,
    pub build_id: Option<String>,
}

#[derive(Clone, Debug, Deserialize, Serialize, ToSchema)]
#[serde(deny_unknown_fields)]
pub struct DiagnosticFrame {
    pub filename: String,
    pub lineno: u32,
    pub colno: u32,
}

#[derive(Clone, Copy, Debug, Deserialize, Serialize, ToSchema)]
#[serde(rename_all = "snake_case")]
pub enum DiagnosticCategory {
    ReactBoundary,
    RendererUnhandledError,
    RendererUnhandledRejection,
    RendererRecoverable,
    ElectronMain,
    ElectronPreload,
    RendererProcessExit,
    ServiceProcessExit,
    ServiceInternal,
    ServiceDatabase,
    ServiceGit,
    ServicePanic,
}

impl DiagnosticCategory {
    pub fn process(self) -> &'static str {
        match self {
            Self::ElectronMain | Self::RendererProcessExit | Self::ServiceProcessExit => "main",
            Self::ElectronPreload => "preload",
            Self::ServiceInternal
            | Self::ServiceDatabase
            | Self::ServiceGit
            | Self::ServicePanic => "service",
            _ => "renderer",
        }
    }
}

#[derive(Clone, Copy, Debug, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum TurnOutcome {
    Completed,
    Failed,
    Interrupted,
}

#[derive(Clone, Copy, Debug)]
pub enum ProductEvent {
    AppSessionStarted,
    ProjectAdded,
    ProviderReady,
    FirstTurnCompleted,
    TurnCompleted(TurnSummary),
}

#[derive(Clone, Copy, Debug, Serialize)]
pub struct TurnSummary {
    pub outcome: TurnOutcome,
    pub provider: &'static str,
    pub duration_bucket: DurationBucket,
    pub actor: TurnActor,
}

#[derive(Clone, Copy, Debug, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum TurnActor {
    Unknown,
}

#[derive(Clone, Copy, Debug, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum DurationBucket {
    UnderOneSecond,
    UnderTenSeconds,
    UnderOneMinute,
    UnderFiveMinutes,
    FiveMinutesOrMore,
}

impl TurnSummary {
    pub fn new(outcome: TurnOutcome, provider: &str, seconds: u64) -> Self {
        let provider = crate::domain::agents::providers::builtin_provider_identifiers()
            .iter()
            .find(|id| id.as_str() == provider)
            .map(String::as_str)
            .unwrap_or("custom");
        let duration_bucket = match seconds {
            0 => DurationBucket::UnderOneSecond,
            1..=9 => DurationBucket::UnderTenSeconds,
            10..=59 => DurationBucket::UnderOneMinute,
            60..=299 => DurationBucket::UnderFiveMinutes,
            _ => DurationBucket::FiveMinutesOrMore,
        };
        Self {
            outcome,
            provider,
            duration_bucket,
            actor: TurnActor::Unknown,
        }
    }
}

impl ProductEvent {
    pub fn name(self) -> &'static str {
        match self {
            Self::AppSessionStarted => "app_session_started",
            Self::ProjectAdded => "project_added",
            Self::ProviderReady => "provider_ready",
            Self::FirstTurnCompleted => "first_turn_completed",
            Self::TurnCompleted(_) => "turn_completed",
        }
    }
}

pub fn safe_token(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 128
        && value
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b"._-".contains(&b))
}

pub fn valid_report(report: &DiagnosticReport) -> bool {
    report.frames.len() <= 32
        && report.build_id.as_deref().is_none_or(safe_token)
        && report.frames.iter().all(|frame| {
            let asset = frame.filename.strip_prefix("assets/");
            (asset.is_some_and(|name| safe_token(name) && name.ends_with(".js"))
                || matches!(
                    frame.filename.as_str(),
                    "main/index.js" | "preload/index.js"
                ))
                && frame.lineno > 0
                && frame.lineno <= 10_000_000
                && frame.colno <= 10_000_000
        })
}

pub(super) fn status(
    enabled: bool,
    configured: bool,
    failed: bool,
    read_failed: bool,
) -> DeliveryStatus {
    if read_failed {
        DeliveryStatus::DeliveryFailed
    } else if !enabled {
        DeliveryStatus::Disabled
    } else if !configured {
        DeliveryStatus::NotConfigured
    } else if failed {
        DeliveryStatus::DeliveryFailed
    } else {
        DeliveryStatus::Ready
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn consent_requires_detailed_choices_and_preserves_omitted_audience() {
        let detailed = serde_json::from_value::<TelemetryConsent>(
            serde_json::json!({"diagnostics_enabled":false,"usage_enabled":false}),
        )
        .unwrap();
        assert!(detailed.audience_enabled.is_none());
        assert!(serde_json::from_value::<TelemetryConsent>(
            serde_json::json!({"diagnostics_enabled":false})
        )
        .is_err());
        let consent: TelemetryConsent = serde_json::from_value(serde_json::json!({"diagnostics_enabled":false,"usage_enabled":false,"audience_enabled":false})).unwrap();
        assert_eq!(consent.audience_enabled, Some(false));
        let preferences = TelemetryPreferences {
            diagnostics_enabled: false,
            usage_enabled: false,
            audience_enabled: true,
            decision_version: None,
            installation_id: None,
            diagnostics_configured: false,
            usage_configured: false,
            audience_configured: false,
            diagnostics_status: DeliveryStatus::Disabled,
            usage_status: DeliveryStatus::Disabled,
            audience_status: DeliveryStatus::NotConfigured,
        };
        let value = serde_json::to_value(preferences).unwrap();
        assert!(value["decision_version"].is_null());
        assert_eq!(value["audience_status"], "not_configured");
    }

    #[test]
    fn rejects_content_and_unbounded_or_private_frames() {
        for field in ["message", "url", "stack", "properties", "user"] {
            let mut value = serde_json::json!({"category":"react_boundary"});
            value[field] = serde_json::json!("secret prompt /Users/private token");
            assert!(serde_json::from_value::<DiagnosticReport>(value).is_err());
        }
        for filename in [
            "/Users/private.js",
            "https://secret/file.js",
            "assets/../secret.js",
            "assets/a.js?token=secret",
            "assets/secret prompt.js",
        ] {
            let report = DiagnosticReport {
                category: DiagnosticCategory::ReactBoundary,
                frames: vec![DiagnosticFrame {
                    filename: filename.into(),
                    lineno: 1,
                    colno: 1,
                }],
                build_id: None,
            };
            assert!(!valid_report(&report));
        }
        assert!(valid_report(&serde_json::from_value(serde_json::json!({
            "category":"react_boundary", "frames":[{"filename":"assets/index-ab12.js","lineno":1,"colno":9}], "build_id":"abc-123"
        })).unwrap()));
    }
}
