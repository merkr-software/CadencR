use super::*;

impl Telemetry {
    pub(super) async fn deliver(&self, pending: Pending) {
        if !self.still_allowed(&pending) {
            return;
        }
        let Some(client) = self.client.as_ref() else {
            return;
        };
        let request = match &pending.event {
            Event::Diagnostic(report) => {
                let Some(target) = &self.config.sentry else {
                    return;
                };
                client
                    .post(target.endpoint.clone())
                    .header(
                        "X-Sentry-Auth",
                        format!("Sentry sentry_version=7,sentry_key={}", target.key),
                    )
                    .header("Content-Type", "application/x-sentry-envelope")
                    .body(payload::diagnostic(
                        report,
                        &pending.identity,
                        &self.config.release,
                    ))
            }
            Event::Product(event) => {
                let Some((endpoint, key)) = &self.config.posthog else {
                    return;
                };
                client.post(endpoint.clone()).json(&payload::product(
                    *event,
                    &pending.identity,
                    &self.config.release,
                    key,
                ))
            }
        };
        let mut changes = tokio::time::interval(Duration::from_millis(100));
        let send = request.send();
        tokio::pin!(send);
        loop {
            tokio::select! {
                biased;
                _ = pending.cancellation.cancelled() => return,
                _ = changes.tick() => { if !self.still_allowed(&pending) { return; } },
                response = &mut send => {
                    let failed = response.map_or(true, |r| !r.status().is_success());
                    // Fixed status is exposed to Settings. Never log transport errors or recurse.
                    if !pending.cancellation.is_cancelled() {
                        self.state.lock().unwrap_or_else(|p| p.into_inner()).failed[usize::from(!pending.event.diagnostics())] = failed;
                    }
                    return;
                }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::super::tests::{fixture, report};
    use super::*;
    use crate::domain::settings_store::file::write_atomic;

    #[tokio::test]
    async fn capture_bounds_each_channel_per_minute_and_per_run() {
        for (diagnostics, per_minute, per_run) in [(true, 5, 20), (false, 30, 200)] {
            let (runtime, requests, _dir) = fixture(true).await;
            for already_accepted in (0..per_run).step_by(per_minute) {
                for _ in 0..per_minute + 1 {
                    runtime.capture(if diagnostics {
                        report()
                    } else {
                        Event::Product(ProductEvent::ProjectAdded)
                    });
                }
                let mut state = runtime.state.lock().unwrap();
                assert_eq!(
                    state.pending.len(),
                    per_minute.min(per_run - already_accepted)
                );
                state.pending.clear();
                state.minute = Instant::now() - Duration::from_secs(61);
            }
            runtime.capture(if diagnostics {
                report()
            } else {
                Event::Product(ProductEvent::ProjectAdded)
            });
            assert!(runtime.state.lock().unwrap().pending.is_empty());
            assert!(requests.lock().unwrap().is_empty());
        }
    }

    #[tokio::test]
    async fn mixed_channels_share_one_bounded_queue() {
        let (runtime, _requests, _dir) = fixture(true).await;
        for _ in 0..5 {
            runtime.capture(report());
        }
        for _ in 0..30 {
            runtime.capture(Event::Product(ProductEvent::ProjectAdded));
        }
        assert_eq!(runtime.state.lock().unwrap().pending.len(), 32);
    }

    #[tokio::test]
    async fn predecision_activity_sends_only_audience_and_refusal_keeps_it_independent() {
        let (runtime, requests, _dir) = fixture(true).await;
        let identity = uuid::Uuid::new_v4().to_string();
        let mut document = serde_json::json!({"telemetry": {
            "diagnostics_enabled":true, "usage_enabled":true, "installation_id":identity
        }});
        write_atomic(&runtime.path, &document.to_string()).unwrap();
        runtime.settings_changed();
        let snapshot = runtime.snapshot();
        assert!(snapshot.decision_version.is_none());
        assert!(matches!(snapshot.audience_status, DeliveryStatus::Ready));
        assert!(matches!(
            snapshot.diagnostics_status,
            DeliveryStatus::Disabled
        ));
        assert!(matches!(snapshot.usage_status, DeliveryStatus::Disabled));
        runtime.session_started();
        runtime.provider_ready();
        runtime.capture(report());
        runtime.capture(Event::Product(ProductEvent::FirstTurnCompleted));
        assert!(runtime.state.lock().unwrap().pending.is_empty());
        runtime.activity().await;
        tokio::time::timeout(Duration::from_secs(2), async {
            while requests.lock().unwrap().is_empty() {
                tokio::task::yield_now().await;
            }
        })
        .await
        .unwrap();
        let body: serde_json::Value = serde_json::from_str(&requests.lock().unwrap()[0]).unwrap();
        assert_eq!(body["event"], "active_installation_monthly");
        assert_ne!(body["distinct_id"], identity);
        let stored = preferences::read(&runtime.path).unwrap();
        assert!(stored.decision_version.is_none());
        assert_eq!(stored.installation_id.as_deref(), Some(identity.as_str()));
        document["telemetry"]["diagnostics_enabled"] = false.into();
        document["telemetry"]["usage_enabled"] = false.into();
        document["telemetry"]["decision_version"] = 1.into();
        document["telemetry"]["audience_last_claimed_month"] =
            serde_json::to_value(stored.audience_last_claimed_month).unwrap();
        write_atomic(&runtime.path, &document.to_string()).unwrap();
        runtime.clear();
        let snapshot = runtime.snapshot();
        assert!(snapshot.audience_enabled);
        assert!(matches!(
            snapshot.diagnostics_status,
            DeliveryStatus::Disabled
        ));
        assert!(matches!(snapshot.usage_status, DeliveryStatus::Disabled));
        runtime.activity().await;
        assert_eq!(requests.lock().unwrap().len(), 1);
    }

    #[tokio::test]
    async fn legacy_detailed_flags_send_nothing_until_explicit_decision_is_saved() {
        use crate::domain::telemetry::configuration::SentryTarget;
        use crate::domain::telemetry::models::TelemetryConsent;
        let path = preferences::path();
        write_atomic(
            &path,
            &serde_json::json!({"telemetry":{
                "diagnostics_enabled":true,"usage_enabled":true,
                "installation_id":uuid::Uuid::new_v4().to_string()
            }})
            .to_string(),
        )
        .unwrap();
        let runtime = Telemetry::new(
            Configuration {
                sentry: Some(SentryTarget {
                    endpoint: "https://example.com/envelope".parse().unwrap(),
                    key: "key".into(),
                }),
                posthog: Some(("https://example.com/i/v0/e/".parse().unwrap(), "key".into())),
                release: "test".into(),
            },
            path,
        );
        runtime.session_started();
        runtime.provider_ready();
        runtime.capture(report());
        assert!(runtime.state.lock().unwrap().pending.is_empty());
        assert!(!preferences::claim_first_turn().await.unwrap());
        assert!(matches!(
            runtime.snapshot().diagnostics_status,
            DeliveryStatus::Disabled
        ));
        assert!(matches!(
            runtime.snapshot().usage_status,
            DeliveryStatus::Disabled
        ));
        preferences::update(
            Some(TelemetryConsent {
                diagnostics_enabled: true,
                usage_enabled: true,
                audience_enabled: Some(false),
            }),
            false,
        )
        .await
        .unwrap();
        runtime.clear();
        runtime.session_started();
        runtime.provider_ready();
        runtime.capture(report());
        assert_eq!(runtime.state.lock().unwrap().pending.len(), 3);
        assert!(matches!(
            runtime.snapshot().usage_status,
            DeliveryStatus::Ready
        ));
    }

    #[tokio::test]
    async fn reset_and_disk_revocation_never_send_old_identity_or_expired_events() {
        let (runtime, requests, _dir) = fixture(true).await;
        runtime.capture(report());
        let pending = runtime.state.lock().unwrap().pending.pop_front().unwrap();
        let old_identity = pending.identity.clone();
        runtime.clear();
        let new_identity = uuid::Uuid::new_v4().to_string();
        write_atomic(
            &runtime.path,
            &serde_json::json!({"telemetry":{
                "diagnostics_enabled":true,"usage_enabled":true,"decision_version":1,"installation_id":new_identity
            }})
            .to_string(),
        )
        .unwrap();
        runtime.clear();
        runtime.deliver(pending).await;
        assert!(requests.lock().unwrap().is_empty());
        runtime.capture(report());
        let pending = runtime.state.lock().unwrap().pending.pop_front().unwrap();
        runtime.deliver(pending).await;
        {
            let bodies = requests.lock().unwrap();
            assert_eq!(bodies.len(), 1);
            assert!(bodies[0].contains(&new_identity));
            assert!(!bodies[0].contains(&old_identity));
        }
        runtime.capture(report());
        let mut pending = runtime.state.lock().unwrap().pending.pop_front().unwrap();
        pending.created = Instant::now() - Duration::from_secs(31);
        runtime.deliver(pending).await;
        assert_eq!(requests.lock().unwrap().len(), 1);
        runtime.capture(report());
        let pending = runtime.state.lock().unwrap().pending.pop_front().unwrap();
        write_atomic(&runtime.path, "{}").unwrap();
        runtime.deliver(pending).await;
        assert_eq!(requests.lock().unwrap().len(), 1);
    }

    #[tokio::test]
    async fn optional_transport_unavailable_never_breaks_application_or_queues() {
        let dir = tempfile::tempdir().unwrap();
        let runtime = Telemetry::with_client(
            Configuration {
                sentry: None,
                posthog: None,
                release: "cadencr@1".into(),
            },
            dir.path().join("settings.json"),
            None,
        );
        assert!(matches!(
            runtime.snapshot().diagnostics_status,
            DeliveryStatus::DeliveryFailed
        ));
        runtime.capture(report());
        assert!(runtime.state.lock().unwrap().pending.is_empty());
    }

    #[tokio::test]
    async fn settings_watcher_ignores_unrelated_writes_but_cancels_revoked_epoch() {
        let (runtime, _requests, _dir) = fixture(true).await;
        runtime.capture(report());
        let token = runtime.state.lock().unwrap().pending[0]
            .cancellation
            .clone();
        let mut doc: serde_json::Value =
            serde_json::from_str(&std::fs::read_to_string(&runtime.path).unwrap()).unwrap();
        doc["theme_current"] = serde_json::json!("unrelated");
        write_atomic(&runtime.path, &doc.to_string()).unwrap();
        runtime.settings_changed();
        assert!(!token.is_cancelled());
        assert_eq!(runtime.state.lock().unwrap().pending.len(), 1);
        doc["telemetry"]["diagnostics_enabled"] = serde_json::json!(false);
        write_atomic(&runtime.path, &doc.to_string()).unwrap();
        runtime.settings_changed();
        assert!(token.is_cancelled());
        assert!(runtime.state.lock().unwrap().pending.is_empty());
    }

    #[tokio::test]
    async fn revocation_cancels_in_flight_wait_without_retrying() {
        use tokio::io::AsyncReadExt;
        let (mut runtime, _requests, _dir) = fixture(true).await;
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let endpoint = format!("http://{}/", listener.local_addr().unwrap())
            .parse()
            .unwrap();
        Arc::get_mut(&mut runtime)
            .unwrap()
            .config
            .sentry
            .as_mut()
            .unwrap()
            .endpoint = endpoint;
        let (started, received) = tokio::sync::oneshot::channel();
        tokio::spawn(async move {
            let (mut socket, _) = listener.accept().await.unwrap();
            let mut buffer = [0u8; 4096];
            assert!(socket.read(&mut buffer).await.unwrap() > 0);
            started.send(()).unwrap();
            tokio::time::sleep(Duration::from_secs(5)).await;
        });
        runtime.capture(report());
        let pending = runtime.state.lock().unwrap().pending.pop_front().unwrap();
        let sending = runtime.clone();
        let task = tokio::spawn(async move {
            sending.deliver(pending).await;
        });
        tokio::time::timeout(Duration::from_secs(1), received)
            .await
            .unwrap()
            .unwrap();
        runtime.clear();
        tokio::time::timeout(Duration::from_millis(200), task)
            .await
            .unwrap()
            .unwrap();
        assert!(runtime.state.lock().unwrap().pending.is_empty());
    }
}
