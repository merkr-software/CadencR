//! Calls to the loopback API of a service this CLI started (`cadencr serve`).

use std::path::PathBuf;
use std::time::Duration;

use serde::de::DeserializeOwned;
use serde::{Deserialize, Serialize};

use crate::{operation_error, Diagnostic};

const TOKEN_HEADER: &str = "x-cadencr-token";

pub(super) struct ServiceApi {
    client: reqwest::Client,
    base_url: String,
    token: String,
}

#[derive(Deserialize)]
pub(super) struct Project {
    pub(super) id: i64,
    pub(super) name: String,
    pub(super) path: PathBuf,
}

#[derive(Serialize)]
struct CreateProject<'a> {
    name: &'a str,
    path: &'a std::path::Path,
}

#[derive(Deserialize)]
pub(super) struct RemoteStatus {
    pub(super) port: Option<u16>,
}

#[derive(Deserialize, Serialize)]
pub(super) struct PairingCode {
    pub(super) urls: Vec<String>,
    pub(super) fingerprint: String,
    pub(super) expires_in_secs: u64,
}

/// The service's error body (`AppError`).
#[derive(Deserialize)]
struct ServiceError {
    error: String,
    code: Option<String>,
}

impl ServiceApi {
    pub(super) fn new(base_url: String, token: String) -> Result<Self, Diagnostic> {
        let client = reqwest::Client::builder()
            .timeout(Duration::from_secs(30))
            .no_proxy()
            .build()
            .map_err(|error| operation_error("CLI_SERVICE_UNREACHABLE", error))?;
        Ok(Self {
            client,
            base_url,
            token,
        })
    }

    /// Whether the service answers its authenticated health check yet.
    pub(super) async fn healthy(&self) -> bool {
        let response = self
            .client
            .get(self.url("/api/health"))
            .header(TOKEN_HEADER, &self.token)
            .timeout(Duration::from_secs(2))
            .send()
            .await;
        response.is_ok_and(|response| response.status().is_success())
    }

    pub(super) async fn projects(&self) -> Result<Vec<Project>, Diagnostic> {
        self.call(self.client.get(self.url("/api/projects"))).await
    }

    pub(super) async fn create_project(
        &self,
        name: &str,
        path: &std::path::Path,
    ) -> Result<Project, Diagnostic> {
        let request = self
            .client
            .post(self.url("/api/projects"))
            .json(&CreateProject { name, path });
        self.call(request).await
    }

    pub(super) async fn enable_remote(&self) -> Result<RemoteStatus, Diagnostic> {
        self.call(self.client.post(self.url("/api/remote/enable")))
            .await
    }

    /// Stops remote access and saves it off, the inverse of `enable_remote`.
    pub(super) async fn disable_remote(&self) -> Result<(), Diagnostic> {
        self.call::<serde_json::Value>(self.client.post(self.url("/api/remote/disable")))
            .await
            .map(drop)
    }

    pub(super) async fn pairing_code(&self) -> Result<PairingCode, Diagnostic> {
        self.call(self.client.post(self.url("/api/remote/pairing-code")))
            .await
    }

    fn url(&self, path: &str) -> String {
        format!("{}{path}", self.base_url)
    }

    async fn call<T: DeserializeOwned>(
        &self,
        request: reqwest::RequestBuilder,
    ) -> Result<T, Diagnostic> {
        let response = request
            .header(TOKEN_HEADER, &self.token)
            .send()
            .await
            .map_err(|error| operation_error("CLI_SERVICE_UNREACHABLE", error))?;
        let status = response.status();
        let body = response
            .bytes()
            .await
            .map_err(|error| operation_error("CLI_SERVICE_UNREACHABLE", error))?;
        if !status.is_success() {
            return Err(service_error(status, &body));
        }
        serde_json::from_slice(&body)
            .map_err(|error| operation_error("CLI_SERVICE_RESPONSE_INVALID", error))
    }
}

fn service_error(status: reqwest::StatusCode, body: &[u8]) -> Diagnostic {
    let message = match serde_json::from_slice::<ServiceError>(body) {
        Ok(ServiceError {
            error,
            code: Some(code),
        }) => format!("{error} ({code})"),
        Ok(ServiceError { error, code: None }) => error,
        Err(_) => format!("the service answered {status}"),
    };
    operation_error("CLI_SERVICE_REQUEST_FAILED", message)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn service_errors_keep_the_message_and_code() {
        let error = service_error(
            reqwest::StatusCode::CONFLICT,
            br#"{"error":"Enable remote access before pairing","code":"CONFLICT"}"#,
        );
        assert_eq!(error.code, "CLI_SERVICE_REQUEST_FAILED");
        assert_eq!(
            error.message,
            "Enable remote access before pairing (CONFLICT)"
        );
        let opaque = service_error(reqwest::StatusCode::BAD_GATEWAY, b"<html>");
        assert_eq!(opaque.message, "the service answered 502 Bad Gateway");
    }
}
