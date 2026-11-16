use crate::app_state::{BrowserBridgeConfig, BROWSER_BRIDGE_TOKEN_ENV, BROWSER_BRIDGE_URL_ENV};
use reqwest::{Client, Url};
use serde::{Deserialize, Serialize};
use serde_json::Value;

#[derive(Debug, Clone, Serialize)]
pub struct BrowserBridgeRequest {
    pub tool_name: String,
    pub args: Value,
    // Feature this MCP subprocess is pinned to. The desktop bridge uses it as the
    // browser scope so agent-opened tabs appear in that feature's Browser panel
    // (instead of a hidden scopeless tab).
    pub feature_id: i64,
}

impl BrowserBridgeRequest {
    pub fn new(tool_name: impl Into<String>, args: Value, feature_id: i64) -> Self {
        Self {
            tool_name: tool_name.into(),
            args,
            feature_id,
        }
    }
}

#[derive(Debug, Clone, Deserialize)]
pub struct BrowserBridgeImage {
    #[serde(rename = "mimeType")]
    pub mime_type: String,
    pub data: String,
}

#[derive(Debug, Clone, Deserialize)]
pub struct BrowserBridgeResponse {
    pub text: String,
    #[serde(default)]
    pub image: Option<BrowserBridgeImage>,
}

#[derive(Debug, Clone)]
pub struct BrowserBridgeClient {
    url: Url,
    token: String,
    client: Client,
}

impl BrowserBridgeClient {
    pub fn from_env() -> Option<Self> {
        Self::from_env_values(
            std::env::var(BROWSER_BRIDGE_URL_ENV).ok(),
            std::env::var(BROWSER_BRIDGE_TOKEN_ENV).ok(),
        )
    }

    pub fn from_env_values(url: Option<String>, token: Option<String>) -> Option<Self> {
        let config = BrowserBridgeConfig::from_raw(&url?, &token?).ok()?;
        Self::from_config(config).ok()
    }

    pub fn from_config(config: BrowserBridgeConfig) -> Result<Self, String> {
        Ok(Self {
            url: Url::parse(&config.url)
                .map_err(|err| format!("Browser bridge URL is invalid: {err}"))?,
            token: config.token,
            client: Client::new(),
        })
    }

    pub async fn call(
        &self,
        request: BrowserBridgeRequest,
    ) -> Result<BrowserBridgeResponse, String> {
        let response = self
            .client
            .post(self.url.clone())
            .bearer_auth(&self.token)
            .json(&request)
            .send()
            .await
            .map_err(|err| format!("Browser bridge request failed: {err}"))?;
        let status = response.status();
        if !status.is_success() {
            let body = response.text().await.unwrap_or_default();
            return Err(format!("Browser bridge returned {status}: {body}"));
        }
        response
            .json::<BrowserBridgeResponse>()
            .await
            .map_err(|err| format!("Browser bridge response was invalid: {err}"))
    }
}

#[cfg(test)]
mod tests {
    use super::{BrowserBridgeClient, BrowserBridgeRequest};
    use axum::{http::StatusCode, response::IntoResponse, routing::post, Router};
    use std::net::SocketAddr;
    use tokio::net::TcpListener;

    #[test]
    fn browser_bridge_client_requires_url_and_token_env() {
        let client = BrowserBridgeClient::from_env_values(None, Some("token".to_string()));
        assert!(client.is_none());
        let client =
            BrowserBridgeClient::from_env_values(Some("http://127.0.0.1:9".to_string()), None);
        assert!(client.is_none());
    }

    #[test]
    fn browser_bridge_client_rejects_non_loopback_urls() {
        let client = BrowserBridgeClient::from_env_values(
            Some("https://example.com/browser".to_string()),
            Some("token".to_string()),
        );
        assert!(client.is_none());
    }

    #[test]
    fn browser_bridge_request_preserves_tool_and_args() {
        let request = BrowserBridgeRequest::new(
            "browser_list_tabs",
            serde_json::json!({ "tab_id": "t1" }),
            7,
        );
        assert_eq!(request.tool_name, "browser_list_tabs");
        assert_eq!(request.args["tab_id"], "t1");
        assert_eq!(request.feature_id, 7);
    }

    #[tokio::test]
    async fn browser_bridge_call_returns_text_from_success_response() {
        let url = spawn_bridge_route(|| async { r#"{"text":"{\"ok\":true}"}"# }).await;
        let client = BrowserBridgeClient::from_env_values(Some(url), Some("token".to_string()))
            .expect("loopback bridge client");

        let result = client
            .call(BrowserBridgeRequest::new(
                "browser_list_tabs",
                serde_json::json!({}),
                1,
            ))
            .await;

        let response = result.expect("bridge response");
        assert_eq!(response.text, r#"{"ok":true}"#);
        assert!(response.image.is_none());
    }

    #[tokio::test]
    async fn browser_bridge_call_parses_image_payload() {
        let url = spawn_bridge_route(|| async {
            r#"{"text":"{\"format\":\"png\"}","image":{"mimeType":"image/png","data":"AAAA"}}"#
        })
        .await;
        let client = BrowserBridgeClient::from_env_values(Some(url), Some("token".to_string()))
            .expect("loopback bridge client");

        let response = client
            .call(BrowserBridgeRequest::new(
                "browser_screenshot",
                serde_json::json!({}),
                1,
            ))
            .await
            .expect("bridge response");

        let image = response.image.expect("image payload");
        assert_eq!(image.mime_type, "image/png");
        assert_eq!(image.data, "AAAA");
    }

    #[tokio::test]
    async fn browser_bridge_call_surfaces_non_success_status() {
        let url = spawn_bridge_route(|| async { (StatusCode::BAD_GATEWAY, "down") }).await;
        let client = BrowserBridgeClient::from_env_values(Some(url), Some("token".to_string()))
            .expect("loopback bridge client");

        let result = client
            .call(BrowserBridgeRequest::new(
                "browser_list_tabs",
                serde_json::json!({}),
                1,
            ))
            .await;

        assert!(result
            .expect_err("status error")
            .contains("502 Bad Gateway"));
    }

    #[tokio::test]
    async fn browser_bridge_call_surfaces_invalid_json() {
        let url = spawn_bridge_route(|| async { "not-json" }).await;
        let client = BrowserBridgeClient::from_env_values(Some(url), Some("token".to_string()))
            .expect("loopback bridge client");

        let result = client
            .call(BrowserBridgeRequest::new(
                "browser_list_tabs",
                serde_json::json!({}),
                1,
            ))
            .await;

        assert!(result
            .expect_err("json error")
            .contains("response was invalid"));
    }

    async fn spawn_bridge_route<R, F>(handler: fn() -> F) -> String
    where
        R: IntoResponse + 'static,
        F: std::future::Future<Output = R> + Send + 'static,
    {
        let app = Router::new().route("/", post(handler));
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr: SocketAddr = listener.local_addr().unwrap();
        tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
        format!("http://{addr}/")
    }
}
