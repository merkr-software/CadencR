//! Opt-in detailed telemetry and an independent monthly audience count.
//! Never attach the tracing subscriber: provider traces can contain prompts and credentials.

mod audience;
mod configuration;
pub mod models;
mod payload;
mod preferences;
pub mod routes;
mod runtime;

use std::sync::{Arc, OnceLock};

use crate::error::AppError;
use models::{
    DiagnosticCategory, DiagnosticFrame, DiagnosticReport, ProductEvent, TelemetryConsent,
    TelemetryPreferences, TurnOutcome, TurnSummary,
};
use runtime::{Event, Telemetry};

static TELEMETRY: OnceLock<Arc<Telemetry>> = OnceLock::new();
static MUTATION: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

/// Only the HTTP server calls this, after settings initialization; never MCP subprocesses.
pub fn initialize(app_version: Option<&str>) {
    let runtime = Telemetry::new(
        configuration::Configuration::from_env(app_version),
        preferences::path(),
    );
    if TELEMETRY.set(runtime.clone()).is_ok() {
        runtime.spawn();
        let previous = std::panic::take_hook();
        std::panic::set_hook(Box::new(move |info| {
            let frames = info
                .location()
                .and_then(|location| {
                    let filename = location.file().split("packages/service/").last()?;
                    (filename.starts_with("src/")
                        && filename.len() <= 180
                        && filename
                            .bytes()
                            .all(|b| b.is_ascii_alphanumeric() || b"/_.-".contains(&b)))
                    .then(|| DiagnosticFrame {
                        filename: filename.into(),
                        lineno: location.line(),
                        colno: location.column(),
                    })
                })
                .into_iter()
                .collect();
            diagnostic(DiagnosticCategory::ServicePanic, frames);
            previous(info);
        }));
    }
}

pub fn snapshot() -> Result<TelemetryPreferences, AppError> {
    TELEMETRY
        .get()
        .map(|runtime| runtime.snapshot())
        .ok_or_else(|| AppError::ServiceUnavailable("Telemetry is not initialized".into()))
}

pub async fn update(
    consent: Option<TelemetryConsent>,
    reset: bool,
) -> Result<TelemetryPreferences, AppError> {
    let _guard = MUTATION.lock().await;
    let runtime = TELEMETRY
        .get()
        .ok_or_else(|| AppError::ServiceUnavailable("Telemetry is not initialized".into()))?;
    if consent.is_some_and(|consent| consent.audience_enabled == Some(false)) {
        runtime.revoke_audience();
    }
    runtime.clear();
    let result = preferences::update(consent, reset).await;
    runtime.clear();
    result?;
    runtime.session_started();
    Ok(runtime.snapshot())
}

/// Called only after local desktop authentication; service/MCP startup is not activity.
pub async fn activity() {
    let _guard = MUTATION.lock().await;
    if let Some(runtime) = TELEMETRY.get() {
        runtime.activity().await;
    }
}

pub fn capture_diagnostic(report: DiagnosticReport) {
    if let Some(runtime) = TELEMETRY.get() {
        runtime.capture(Event::Diagnostic(report));
    }
}

pub fn diagnostic(category: DiagnosticCategory, frames: Vec<DiagnosticFrame>) {
    capture_diagnostic(DiagnosticReport {
        category,
        frames,
        build_id: None,
    });
}

pub fn product(event: ProductEvent) {
    if let Some(runtime) = TELEMETRY.get() {
        runtime.capture(Event::Product(event));
    }
}

pub fn provider_ready() {
    if let Some(runtime) = TELEMETRY.get() {
        runtime.provider_ready();
    }
}

/// Raw settings edits may revoke consent without passing through the dedicated UI.
pub fn settings_changed() {
    if let Some(runtime) = TELEMETRY.get() {
        runtime.settings_changed();
    }
}

pub async fn turn_completed(summary: TurnSummary) {
    let _guard = MUTATION.lock().await;
    let Some(runtime) = TELEMETRY.get() else {
        return;
    };
    let snapshot = runtime.snapshot();
    if !snapshot
        .decision_version
        .is_some_and(|version| version >= 1)
        || !snapshot.usage_enabled
        || !snapshot.usage_configured
    {
        return;
    }
    runtime.capture(Event::Product(ProductEvent::TurnCompleted(summary)));
    if matches!(summary.outcome, TurnOutcome::Completed) {
        match preferences::claim_first_turn().await {
            Ok(true) => runtime.capture(Event::Product(ProductEvent::FirstTurnCompleted)),
            Ok(false) => {}
            Err(_) => runtime.fail_usage(),
        }
    }
}
