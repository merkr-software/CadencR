//! Independent monthly activity signal with an ephemeral per-event identifier.
//! A durable claim precedes one attempt; failures undercount rather than retry.
mod delivery;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};

use tokio_util::sync::CancellationToken;

use super::models::DeliveryStatus;
use super::preferences;

struct State {
    cancellation: CancellationToken,
    failed: bool,
    enabled: bool,
}

pub(super) struct Audience {
    path: PathBuf,
    endpoint: Option<(reqwest::Url, String)>,
    client: Option<reqwest::Client>,
    state: Mutex<State>,
}

impl Audience {
    pub fn new(
        path: PathBuf,
        endpoint: Option<(reqwest::Url, String)>,
        client: Option<reqwest::Client>,
    ) -> Arc<Self> {
        let enabled = preferences::read(&path).is_ok_and(|stored| stored.audience_enabled);
        Arc::new(Self {
            path,
            endpoint,
            client,
            state: Mutex::new(State {
                cancellation: CancellationToken::new(),
                failed: false,
                enabled,
            }),
        })
    }

    pub fn configured(&self) -> bool {
        self.endpoint.is_some()
    }

    pub fn status(&self, enabled: bool, read_failed: bool) -> DeliveryStatus {
        let failed = self.state.lock().unwrap_or_else(|p| p.into_inner()).failed;
        super::models::status(
            enabled,
            self.configured(),
            failed,
            read_failed || self.client.is_none(),
        )
    }

    pub fn settings_changed(&self) {
        let enabled = preferences::read(&self.path).is_ok_and(|stored| stored.audience_enabled);
        let mut state = self.state.lock().unwrap_or_else(|p| p.into_inner());
        if state.enabled != enabled {
            state.cancellation.cancel();
            state.cancellation = CancellationToken::new();
            state.enabled = enabled;
        }
    }

    pub fn revoke(&self) {
        let mut state = self.state.lock().unwrap_or_else(|p| p.into_inner());
        state.cancellation.cancel();
        state.cancellation = CancellationToken::new();
        // The durable write may still fail; revoke existing attempts before it starts.
    }

    pub async fn activity(self: &Arc<Self>) {
        self.activity_in_month(&chrono::Utc::now().format("%Y-%m").to_string())
            .await;
    }

    async fn activity_in_month(self: &Arc<Self>, month: &str) {
        if self.endpoint.is_none() || self.client.is_none() {
            return;
        }
        let cancellation = self
            .state
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .cancellation
            .clone();
        if cancellation.is_cancelled() {
            return;
        }
        let stored = match preferences::read(&self.path) {
            Ok(stored) => stored,
            Err(_) => {
                self.fail();
                return;
            }
        };
        if !stored.audience_enabled
            || stored
                .audience_last_claimed_month
                .as_deref()
                .is_some_and(|last| last >= month)
        {
            return;
        }
        match preferences::claim_audience_month(&self.path, month).await {
            Ok(true) => {
                let audience = self.clone();
                tokio::spawn(async move {
                    audience.deliver(cancellation).await;
                });
            }
            Ok(false) => {}
            Err(_) => self.fail(),
        }
    }

    fn fail(&self) {
        self.state.lock().unwrap_or_else(|p| p.into_inner()).failed = true;
    }

    fn allowed(&self, cancellation: &CancellationToken) -> bool {
        !cancellation.is_cancelled()
            && preferences::read(&self.path).is_ok_and(|stored| stored.audience_enabled)
    }
}

#[cfg(test)]
mod tests {
    use super::delivery::tests::{fixture, received, wire_payload};
    use super::*;
    use crate::domain::settings_store::file::write_atomic;

    #[tokio::test]
    async fn monthly_claim_deduplicates_concurrency_restart_and_clock_rollback() {
        let (audience, mut requests, _dir) = fixture(true).await;
        tokio::join!(
            audience.activity_in_month("2026-11"),
            audience.activity_in_month("2026-11")
        );
        let first = received(&mut requests).await;
        let first = wire_payload(&first);
        let restarted = Audience::new(
            audience.path.clone(),
            audience.endpoint.clone(),
            audience.client.clone(),
        );
        restarted.activity_in_month("2026-11").await;
        restarted.activity_in_month("2026-10").await;
        assert!(requests.try_recv().is_err());
        restarted.activity_in_month("2026-12").await;
        let second = received(&mut requests).await;
        let second = wire_payload(&second);
        assert_ne!(first["distinct_id"], second["distinct_id"]);
        restarted.activity_in_month("2027-01").await;
        received(&mut requests).await;
        let stored = preferences::read(&audience.path).unwrap();
        assert_eq!(
            stored.audience_last_claimed_month.as_deref(),
            Some("2027-01")
        );
        assert!(stored.installation_id.is_none());
        assert!(stored.decision_version.is_none());
        let document: serde_json::Value =
            serde_json::from_str(&std::fs::read_to_string(&audience.path).unwrap()).unwrap();
        assert_eq!(document["unrelated"], "preserved");
        assert!(document["telemetry"].get("decision_version").is_none());
        assert!(document["telemetry"].get("installation_id").is_none());
    }

    #[tokio::test]
    async fn absent_preferences_send_before_decision_and_explicit_off_cancels() {
        let (audience, mut requests, dir) = fixture(true).await;
        let fresh_path = dir.path().join("fresh-settings.json");
        let audience = Audience::new(
            fresh_path.clone(),
            audience.endpoint.clone(),
            audience.client.clone(),
        );
        assert!(audience.state.lock().unwrap().enabled);
        audience.activity_in_month("2026-11").await;
        received(&mut requests).await;
        let mut document: serde_json::Value =
            serde_json::from_str(&std::fs::read_to_string(&fresh_path).unwrap()).unwrap();
        assert_eq!(
            document["telemetry"]["audience_last_claimed_month"],
            "2026-11"
        );
        assert!(document["telemetry"].get("decision_version").is_none());
        assert!(document["telemetry"].get("installation_id").is_none());
        let token = audience.state.lock().unwrap().cancellation.clone();
        document["telemetry"]["audience_enabled"] = serde_json::json!(false);
        write_atomic(&fresh_path, &document.to_string()).unwrap();
        audience.settings_changed();
        assert!(token.is_cancelled());
        assert!(!audience.allowed(&token));
        audience.activity_in_month("2026-12").await;
        assert!(requests.try_recv().is_err());
        let stored = preferences::read(&fresh_path).unwrap();
        assert!(stored.decision_version.is_none());
        assert_eq!(
            stored.audience_last_claimed_month.as_deref(),
            Some("2026-11")
        );
    }

    #[tokio::test]
    async fn disabled_unconfigured_missing_client_and_malformed_preferences_never_claim_or_send() {
        let (mut audience, mut requests, _dir) = fixture(false).await;
        audience.activity_in_month("2026-11").await;
        assert!(preferences::read(&audience.path)
            .unwrap()
            .audience_last_claimed_month
            .is_none());
        write_atomic(&audience.path, "{}").unwrap();
        Arc::get_mut(&mut audience).unwrap().endpoint = None;
        audience.activity_in_month("2026-11").await;
        assert!(preferences::read(&audience.path)
            .unwrap()
            .audience_last_claimed_month
            .is_none());
        let runtime = Arc::get_mut(&mut audience).unwrap();
        runtime.endpoint = Some(("http://127.0.0.1:1/i/v0/e/".parse().unwrap(), "key".into()));
        runtime.client = None;
        audience.activity_in_month("2026-11").await;
        assert!(preferences::read(&audience.path)
            .unwrap()
            .audience_last_claimed_month
            .is_none());
        Arc::get_mut(&mut audience).unwrap().client = Some(reqwest::Client::new());
        write_atomic(&audience.path, "{").unwrap();
        audience.activity_in_month("2026-11").await;
        assert!(matches!(
            audience.status(true, true),
            DeliveryStatus::DeliveryFailed
        ));
        assert!(requests.try_recv().is_err());
    }

    #[test]
    fn calendar_month_is_utc_at_year_boundary() {
        let local = chrono::DateTime::parse_from_rfc3339("2027-01-01T00:30:00+01:00").unwrap();
        assert_eq!(
            local
                .with_timezone(&chrono::Utc)
                .format("%Y-%m")
                .to_string(),
            "2026-12"
        );
    }
}
