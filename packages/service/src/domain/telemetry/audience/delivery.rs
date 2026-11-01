use super::*;
use std::time::Duration;

impl Audience {
    pub(super) async fn deliver(&self, cancellation: CancellationToken) {
        let (Some(client), Some((endpoint, key))) = (&self.client, &self.endpoint) else {
            return;
        };
        if !self.allowed(&cancellation) {
            return;
        }
        // No stable installation identity, app/session metadata, authentication headers,
        // platform, SDK defaults, or release fields cross this independent boundary.
        let send = client
            .post(endpoint.clone())
            .json(&crate::domain::telemetry::payload::audience(key))
            .send();
        tokio::pin!(send);
        let mut changes = tokio::time::interval(Duration::from_millis(100));
        loop {
            tokio::select! {
                biased;
                _ = cancellation.cancelled() => return,
                _ = changes.tick() => { if !self.allowed(&cancellation) { return; } },
                response = &mut send => {
                    if self.allowed(&cancellation) {
                        self.state.lock().unwrap_or_else(|p| p.into_inner()).failed =
                            response.map_or(true, |response| !response.status().is_success());
                    }
                    return;
                }
            }
        }
    }
}

#[cfg(test)]
pub(super) mod tests {
    use super::*;
    use crate::domain::settings_store::file::write_atomic;
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    pub(in super::super) async fn fixture(
        enabled: bool,
    ) -> (
        Arc<Audience>,
        tokio::sync::mpsc::UnboundedReceiver<Vec<u8>>,
        tempfile::TempDir,
    ) {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let endpoint = format!("http://{}/i/v0/e/", listener.local_addr().unwrap())
            .parse()
            .unwrap();
        let (tx, rx) = tokio::sync::mpsc::unbounded_channel();
        tokio::spawn(async move {
            loop {
                let (mut socket, _) = listener.accept().await.unwrap();
                let tx = tx.clone();
                tokio::spawn(async move {
                    let mut bytes = Vec::new();
                    loop {
                        let mut chunk = [0; 1024];
                        let count = socket.read(&mut chunk).await.unwrap();
                        if count == 0 {
                            return;
                        }
                        bytes.extend_from_slice(&chunk[..count]);
                        if let Some(end) = bytes.windows(4).position(|end| end == b"\r\n\r\n") {
                            let headers = std::str::from_utf8(&bytes[..end]).unwrap();
                            let length: usize = headers
                                .lines()
                                .find_map(|line| {
                                    line.to_ascii_lowercase()
                                        .strip_prefix("content-length:")
                                        .map(|value| value.trim().parse().unwrap())
                                })
                                .unwrap();
                            if bytes.len() >= end + 4 + length {
                                break;
                            }
                        }
                    }
                    tx.send(bytes).unwrap();
                    socket.write_all(b"HTTP/1.1 503 Service Unavailable\r\nContent-Length: 0\r\nConnection: close\r\n\r\n").await.unwrap();
                });
            }
        });
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("settings.json");
        write_atomic(
            &path,
            &serde_json::json!({"unrelated":"preserved", "telemetry":{"audience_enabled":enabled}})
                .to_string(),
        )
        .unwrap();
        let client = reqwest::Client::builder()
            .timeout(Duration::from_secs(3))
            .retry(reqwest::retry::never())
            .redirect(reqwest::redirect::Policy::none())
            .no_proxy()
            .build()
            .unwrap();
        (
            Audience::new(path, Some((endpoint, "key".into())), Some(client)),
            rx,
            dir,
        )
    }
    pub(in super::super) async fn received(
        rx: &mut tokio::sync::mpsc::UnboundedReceiver<Vec<u8>>,
    ) -> Vec<u8> {
        tokio::time::timeout(Duration::from_secs(2), rx.recv())
            .await
            .unwrap()
            .unwrap()
    }
    pub(in super::super) fn wire_payload(bytes: &[u8]) -> serde_json::Value {
        let body = bytes.windows(4).position(|end| end == b"\r\n\r\n").unwrap() + 4;
        serde_json::from_slice(&bytes[body..]).unwrap()
    }
    #[tokio::test]
    async fn posthog_request_is_minimal_and_failure_does_not_retry() {
        let (audience, mut requests, _dir) = fixture(true).await;
        audience.activity_in_month("2026-11").await;
        let bytes = received(&mut requests).await;
        let wire = std::str::from_utf8(&bytes).unwrap();
        assert!(wire.starts_with("POST /i/v0/e/ HTTP/1.1\r\n"));
        let (headers, _) = wire.split_once("\r\n\r\n").unwrap();
        let payload = wire_payload(&bytes);
        let event_id = payload["distinct_id"].as_str().unwrap();
        assert!(uuid::Uuid::parse_str(event_id).is_ok());
        assert_eq!(
            payload,
            serde_json::json!({"api_key":"key", "event":"active_installation_monthly", "distinct_id":event_id, "properties":{"$process_person_profile":false,"$geoip_disable":true,"$ip":"0.0.0.0"}})
        );
        assert!(preferences::read(&audience.path)
            .unwrap()
            .installation_id
            .is_none());
        assert!(!std::fs::read_to_string(&audience.path)
            .unwrap()
            .contains(event_id));
        for line in headers.split("\r\n").skip(1) {
            let (header, value) = line.split_once(':').unwrap();
            match header.to_ascii_lowercase().as_str() {
                "host" => assert!(value.trim().starts_with("127.0.0.1:")),
                "accept" => assert_eq!(value.trim(), "*/*"),
                "content-length" => assert_eq!(
                    value.trim().parse::<usize>().unwrap(),
                    payload.to_string().len()
                ),
                "content-type" => assert_eq!(value.trim(), "application/json"),
                other => panic!("Unexpected audience header: {other}"),
            }
        }
        tokio::time::timeout(Duration::from_secs(1), async {
            while !matches!(audience.status(true, false), DeliveryStatus::DeliveryFailed) {
                tokio::task::yield_now().await;
            }
        })
        .await
        .unwrap();
        audience.settings_changed();
        assert!(matches!(
            audience.status(true, false),
            DeliveryStatus::DeliveryFailed
        ));
        audience.activity_in_month("2026-11").await;
        assert!(requests.try_recv().is_err());
    }
    #[tokio::test]
    async fn disk_disable_cancels_inflight_and_keeps_claim_without_retries() {
        let (mut audience, _requests, _dir) = fixture(true).await;
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        Arc::get_mut(&mut audience).unwrap().endpoint = Some((
            format!("http://{}/i/v0/e/", listener.local_addr().unwrap())
                .parse()
                .unwrap(),
            "key".into(),
        ));
        let token = audience.state.lock().unwrap().cancellation.clone();
        write_atomic(
            &audience.path,
            &serde_json::json!({"telemetry": {
                "audience_enabled":true, "diagnostics_enabled":true, "usage_enabled":true,
                "installation_id":uuid::Uuid::new_v4().to_string()
            }})
            .to_string(),
        )
        .unwrap();
        audience.settings_changed();
        assert!(
            !token.is_cancelled(),
            "unrelated channels and identity cannot revoke audience"
        );
        assert!(preferences::claim_audience_month(&audience.path, "2026-11")
            .await
            .unwrap());
        let sending = audience.clone();
        let task = tokio::spawn(async move {
            sending.deliver(token).await;
        });
        let (mut socket, _) = listener.accept().await.unwrap();
        let mut bytes = [0; 1024];
        assert!(socket.read(&mut bytes).await.unwrap() > 0);
        let mut stored = preferences::read(&audience.path).unwrap();
        stored.audience_enabled = false;
        write_atomic(
            &audience.path,
            &serde_json::json!({"telemetry":stored}).to_string(),
        )
        .unwrap();
        audience.settings_changed();
        assert!(preferences::read(&audience.path)
            .unwrap()
            .decision_version
            .is_none());
        tokio::time::timeout(Duration::from_millis(200), task)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(
            preferences::read(&audience.path)
                .unwrap()
                .audience_last_claimed_month
                .as_deref(),
            Some("2026-11")
        );
        assert!(matches!(
            audience.status(false, false),
            DeliveryStatus::Disabled
        ));
    }
}
