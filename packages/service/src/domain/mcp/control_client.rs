//! How a Cadencr MCP subprocess reaches the service: loopback HTTP to the
//! `/internal/mcp/*` routes, authenticated by the control grant the service
//! minted for it (see `control_grant`). The subprocess opens the database
//! read-only, so every write a tool causes goes through here.

use std::time::Duration;

use reqwest::Url;

use crate::api::middleware::MCP_CONTROL_HEADER;

const SERVICE_URL_ENV: &str = "CADENCR_SERVICE_URL";
const CONTROL_TOKEN_ENV: &str = "CADENCR_MCP_CONTROL_TOKEN";
/// How long a quick control call (an audit row, a link) may wait for the
/// service before the tool reports it as unreachable. Calls that start agent
/// work (spawn, send) stay unbounded: they legitimately outlast it.
const QUICK_CALL_TIMEOUT: Duration = Duration::from_secs(30);

#[derive(Debug)]
struct ControlRequestError {
    message: String,
    retryable: bool,
}

impl ControlRequestError {
    fn permanent(message: String) -> Self {
        Self {
            message,
            retryable: false,
        }
    }

    fn retryable(message: String) -> Self {
        Self {
            message,
            retryable: true,
        }
    }
}

#[derive(Debug, Clone)]
pub struct McpControlClient {
    client: reqwest::Client,
    service_url: Url,
    token: String,
}

impl McpControlClient {
    pub fn from_env() -> Result<Self, String> {
        Self::from_env_values(
            std::env::var(SERVICE_URL_ENV).ok(),
            std::env::var(CONTROL_TOKEN_ENV).ok(),
        )
    }

    pub fn from_env_values(
        service_url: Option<String>,
        token: Option<String>,
    ) -> Result<Self, String> {
        let service_url = service_url.ok_or_else(|| format!("{SERVICE_URL_ENV} is not set"))?;
        let token = token.ok_or_else(|| format!("{CONTROL_TOKEN_ENV} is not set"))?;
        if token.trim().is_empty() {
            return Err(format!("{CONTROL_TOKEN_ENV} must not be blank"));
        }
        let service_url = Url::parse(service_url.trim())
            .map_err(|e| format!("{SERVICE_URL_ENV} is invalid: {e}"))?;
        Ok(Self {
            client: reqwest::Client::new(),
            service_url,
            token,
        })
    }

    pub(crate) async fn post_json(
        &self,
        path: &str,
        body: serde_json::Value,
    ) -> Result<serde_json::Value, String> {
        self.post_json_attempt(path, body, None)
            .await
            .map_err(|error| error.message)
    }

    /// [`Self::post_json`] for a call the service answers at once: a stalled
    /// service fails the tool instead of hanging it.
    pub(crate) async fn post_json_quick(
        &self,
        path: &str,
        body: serde_json::Value,
    ) -> Result<serde_json::Value, String> {
        self.post_json_attempt(path, body, Some(QUICK_CALL_TIMEOUT))
            .await
            .map_err(|error| error.message)
    }

    async fn post_json_attempt(
        &self,
        path: &str,
        body: serde_json::Value,
        timeout: Option<Duration>,
    ) -> Result<serde_json::Value, ControlRequestError> {
        let url = self
            .service_url
            .join(path.trim_start_matches('/'))
            .map_err(|e| {
                ControlRequestError::permanent(format!("Control endpoint URL is invalid: {e}"))
            })?;
        let mut request = self
            .client
            .post(url)
            .header(MCP_CONTROL_HEADER, &self.token)
            .json(&body);
        if let Some(timeout) = timeout {
            request = request.timeout(timeout);
        }
        let response = request.send().await.map_err(|e| {
            ControlRequestError::retryable(format!("Control endpoint request failed: {e}"))
        })?;
        let status = response.status();
        let text = response.text().await.map_err(|e| {
            ControlRequestError::retryable(format!("Control endpoint response read failed: {e}"))
        })?;
        if !status.is_success() {
            let message = format!("Control endpoint returned {status}: {text}");
            return Err(
                if status.is_server_error()
                    || status == reqwest::StatusCode::REQUEST_TIMEOUT
                    || status == reqwest::StatusCode::TOO_MANY_REQUESTS
                {
                    ControlRequestError::retryable(message)
                } else {
                    ControlRequestError::permanent(message)
                },
            );
        }
        serde_json::from_str(&text).map_err(|e| {
            ControlRequestError::permanent(format!(
                "Control endpoint response was invalid JSON: {e}"
            ))
        })
    }

    pub(crate) async fn post_json_idempotent(
        &self,
        path: &str,
        body: serde_json::Value,
    ) -> Result<serde_json::Value, String> {
        let mut last_error = None;
        for attempt in 0..3 {
            match self.post_json_attempt(path, body.clone(), None).await {
                Ok(value) => return Ok(value),
                Err(error) if !error.retryable => return Err(error.message),
                Err(error) => last_error = Some(error.message),
            }
            if attempt < 2 {
                tokio::time::sleep(Duration::from_millis(50 * (attempt + 1))).await;
            }
        }
        Err(last_error.unwrap_or_else(|| "Control endpoint request failed".to_string()))
    }
}
