mod delivery;

use std::collections::VecDeque;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use tokio::sync::Notify;
use tokio_util::sync::CancellationToken;

use super::configuration::Configuration;
#[cfg(test)]
use super::models::DeliveryStatus;
use super::models::{status, DiagnosticReport, ProductEvent, TelemetryPreferences};
use super::{payload, preferences};

pub(super) enum Event {
    Diagnostic(DiagnosticReport),
    Product(ProductEvent),
}

impl Event {
    fn diagnostics(&self) -> bool {
        matches!(self, Self::Diagnostic(_))
    }
}

struct Pending {
    event: Event,
    identity: String,
    cancellation: CancellationToken,
    created: Instant,
}

struct State {
    pending: VecDeque<Pending>,
    cancellation: CancellationToken,
    failed: [bool; 2],
    counts: [u16; 2],
    minute_counts: [u16; 2],
    minute: Instant,
    session_started: bool,
    provider_ready: bool,
    observed: ConsentIdentity,
}

type ConsentIdentity = (bool, bool, Option<u32>, Option<String>);

fn consent_identity(path: &std::path::Path) -> ConsentIdentity {
    let stored = preferences::read(path).unwrap_or_default();
    (
        stored.diagnostics_enabled,
        stored.usage_enabled,
        stored.decision_version,
        stored.installation_id,
    )
}

pub(super) struct Telemetry {
    pub config: Configuration,
    path: PathBuf,
    state: Mutex<State>,
    wake: Notify,
    client: Option<reqwest::Client>,
    audience: Arc<super::audience::Audience>,
}

impl Telemetry {
    pub fn new(config: Configuration, path: PathBuf) -> Arc<Self> {
        let client = reqwest::Client::builder()
            .timeout(Duration::from_secs(3))
            .retry(reqwest::retry::never())
            .redirect(reqwest::redirect::Policy::none())
            .no_proxy()
            .build()
            .ok();
        Self::with_client(config, path, client)
    }

    fn with_client(
        config: Configuration,
        path: PathBuf,
        client: Option<reqwest::Client>,
    ) -> Arc<Self> {
        let observed = consent_identity(&path);
        let audience =
            super::audience::Audience::new(path.clone(), config.posthog.clone(), client.clone());
        Arc::new(Self {
            audience,
            config,
            path,
            client,
            wake: Notify::new(),
            state: Mutex::new(State {
                pending: VecDeque::new(),
                cancellation: CancellationToken::new(),
                failed: [false; 2],
                counts: [0; 2],
                minute_counts: [0; 2],
                minute: Instant::now(),
                session_started: false,
                provider_ready: false,
                observed,
            }),
        })
    }

    pub fn spawn(self: &Arc<Self>) {
        let telemetry = self.clone();
        tokio::spawn(async move {
            telemetry.run().await;
        });
        self.session_started();
    }

    pub fn snapshot(&self) -> TelemetryPreferences {
        let stored = preferences::read(&self.path);
        let read_failed = stored.is_err() || self.client.is_none();
        let stored = stored.unwrap_or_default();
        let decided = stored.decision_made();
        let failed = self.state.lock().unwrap_or_else(|p| p.into_inner()).failed;
        let diagnostics_configured = self.config.sentry.is_some();
        let usage_configured = self.config.posthog.is_some();
        TelemetryPreferences {
            diagnostics_enabled: stored.diagnostics_enabled,
            usage_enabled: stored.usage_enabled,
            audience_enabled: stored.audience_enabled,
            decision_version: stored.decision_version,
            audience_configured: self.audience.configured(),
            audience_status: self.audience.status(stored.audience_enabled, read_failed),
            installation_id: stored.installation_id,
            diagnostics_configured,
            usage_configured,
            diagnostics_status: status(
                stored.diagnostics_enabled && decided,
                diagnostics_configured,
                failed[0],
                read_failed,
            ),
            usage_status: status(
                stored.usage_enabled && decided,
                usage_configured,
                failed[1],
                read_failed,
            ),
        }
    }

    /// Cancel before AND after durable mutations so nothing observed mid-write survives.
    pub fn clear(&self) {
        self.audience.settings_changed();
        let mut state = self.state.lock().unwrap_or_else(|p| p.into_inner());
        state.cancellation.cancel();
        state.cancellation = CancellationToken::new();
        state.pending.clear();
        state.failed = [false; 2];
        state.observed = consent_identity(&self.path);
    }

    pub fn settings_changed(&self) {
        self.audience.settings_changed();
        let observed = consent_identity(&self.path);
        let mut state = self.state.lock().unwrap_or_else(|p| p.into_inner());
        if state.observed == observed {
            return;
        }
        state.cancellation.cancel();
        state.cancellation = CancellationToken::new();
        state.pending.clear();
        state.observed = observed;
    }

    pub fn revoke_audience(&self) {
        self.audience.revoke();
    }

    pub async fn activity(&self) {
        self.audience.activity().await;
    }

    pub fn fail_usage(&self) {
        self.state.lock().unwrap_or_else(|p| p.into_inner()).failed[1] = true;
    }

    pub fn session_started(&self) {
        let mut state = self.state.lock().unwrap_or_else(|p| p.into_inner());
        if state.session_started
            || self.config.posthog.is_none()
            || !preferences::read(&self.path).is_ok_and(|s| s.usage_enabled && s.decision_made())
        {
            return;
        }
        state.session_started = true;
        drop(state);
        self.capture(Event::Product(ProductEvent::AppSessionStarted));
    }

    pub fn provider_ready(&self) {
        let mut state = self.state.lock().unwrap_or_else(|p| p.into_inner());
        if state.provider_ready
            || self.config.posthog.is_none()
            || !preferences::read(&self.path).is_ok_and(|s| s.usage_enabled && s.decision_made())
        {
            return;
        }
        state.provider_ready = true;
        drop(state);
        self.capture(Event::Product(ProductEvent::ProviderReady));
    }

    pub fn capture(&self, event: Event) {
        let diagnostics = event.diagnostics();
        if self.client.is_none()
            || if diagnostics {
                self.config.sentry.is_none()
            } else {
                self.config.posthog.is_none()
            }
        {
            return;
        }
        // Hold one generation across the disk consent read and enqueue. A revoke/reset
        // cannot lend its fresh cancellation token to a previously observed identity.
        // A panic hook must never wait on this lock or recurse through tracing.
        let Ok(mut state) = self.state.try_lock() else {
            return;
        };
        let index = usize::from(!diagnostics);
        if state.minute.elapsed() >= Duration::from_secs(60) {
            state.minute = Instant::now();
            state.minute_counts = [0; 2];
        }
        if state.pending.len() >= 32
            || state.counts[index] >= [20, 200][index]
            || state.minute_counts[index] >= [5, 30][index]
        {
            return;
        }
        let Ok(stored) = preferences::read(&self.path) else {
            return;
        };
        if !self.enabled(&stored, diagnostics) {
            return;
        }
        let Some(identity) = stored.valid_id() else {
            return;
        };
        state.counts[index] += 1;
        state.minute_counts[index] += 1;
        let cancellation = state.cancellation.clone();
        state.pending.push_back(Pending {
            event,
            identity: identity.into(),
            cancellation,
            created: Instant::now(),
        });
        drop(state);
        self.wake.notify_one();
    }

    fn enabled(&self, stored: &preferences::StoredPreferences, diagnostics: bool) -> bool {
        if self.client.is_none() || !stored.decision_made() {
            return false;
        }
        if diagnostics {
            stored.diagnostics_enabled && self.config.sentry.is_some()
        } else {
            stored.usage_enabled && self.config.posthog.is_some()
        }
    }

    fn still_allowed(&self, pending: &Pending) -> bool {
        pending.created.elapsed() < Duration::from_secs(30)
            && !pending.cancellation.is_cancelled()
            && preferences::read(&self.path).is_ok_and(|stored| {
                self.enabled(&stored, pending.event.diagnostics())
                    && stored.valid_id() == Some(pending.identity.as_str())
            })
    }

    async fn run(&self) {
        loop {
            self.wake.notified().await;
            loop {
                let next = self
                    .state
                    .lock()
                    .unwrap_or_else(|p| p.into_inner())
                    .pending
                    .pop_front();
                let Some(pending) = next else {
                    break;
                };
                if !self.still_allowed(&pending) {
                    continue;
                }
                self.deliver(pending).await;
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::domain::settings_store::file::write_atomic;
    use crate::domain::telemetry::configuration::SentryTarget;
    use crate::domain::telemetry::models::DiagnosticCategory;
    use axum::{routing::post, Router};

    pub(super) async fn fixture(
        enabled: bool,
    ) -> (Arc<Telemetry>, Arc<Mutex<Vec<String>>>, tempfile::TempDir) {
        let requests = Arc::new(Mutex::new(Vec::new()));
        let count = requests.clone();
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let endpoint = format!("http://{}/", listener.local_addr().unwrap());
        let app = Router::new().route(
            "/",
            post(move |body: String| {
                let count = count.clone();
                async move {
                    count.lock().unwrap().push(body);
                    axum::http::StatusCode::SERVICE_UNAVAILABLE
                }
            }),
        );
        tokio::spawn(async move {
            axum::serve(listener, app).await.unwrap();
        });
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("settings.json");
        write_atomic(
            &path,
            &serde_json::json!({"telemetry":{"diagnostics_enabled":enabled,"usage_enabled":enabled,
            "decision_version":1,"installation_id":uuid::Uuid::new_v4().to_string()}})
            .to_string(),
        )
        .unwrap();
        let runtime = Telemetry::new(
            Configuration {
                sentry: Some(SentryTarget {
                    endpoint: endpoint.parse().unwrap(),
                    key: "public".into(),
                }),
                posthog: Some((endpoint.parse().unwrap(), "key".into())),
                release: "cadencr@1".into(),
            },
            path,
        );
        (runtime, requests, dir)
    }

    pub(super) fn report() -> Event {
        Event::Diagnostic(DiagnosticReport {
            category: DiagnosticCategory::ReactBoundary,
            frames: vec![],
            build_id: None,
        })
    }

    #[tokio::test]
    async fn opt_out_has_no_queue_or_requests_and_revoke_clears_pending() {
        let (runtime, requests, _dir) = fixture(false).await;
        runtime.capture(report());
        assert!(runtime.state.lock().unwrap().pending.is_empty());
        assert_eq!(requests.lock().unwrap().len(), 0);
        let (runtime, requests, _dir) = fixture(true).await;
        runtime.capture(report());
        let pending = runtime.state.lock().unwrap().pending.pop_front().unwrap();
        let cancellation = pending.cancellation.clone();
        runtime.clear();
        assert!(cancellation.is_cancelled());
        assert!(runtime.state.lock().unwrap().pending.is_empty());
        runtime.deliver(pending).await;
        assert_eq!(requests.lock().unwrap().len(), 0);
    }

    #[tokio::test]
    async fn failure_is_reported_once_without_retries_or_sensitive_payloads() {
        let (runtime, requests, _dir) = fixture(true).await;
        runtime.capture(report());
        let next = runtime.state.lock().unwrap().pending.pop_front().unwrap();
        runtime.deliver(next).await;
        assert_eq!(requests.lock().unwrap().len(), 1);
        assert!(matches!(
            runtime.snapshot().diagnostics_status,
            DeliveryStatus::DeliveryFailed
        ));
        assert!(runtime.state.lock().unwrap().pending.is_empty());
    }
}
