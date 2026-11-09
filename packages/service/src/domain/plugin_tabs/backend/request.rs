//! One request to a tab's backend: its bounds, and the handle a request
//! reusing a running backend goes through.

use std::future::Future;
use std::path::Path;
use std::sync::Arc;
use std::time::Duration;

use axum::http::StatusCode;
use tokio::time::Instant;

use super::models::{PluginBackendRequest, PluginBackendResponse};
use super::process::Running;
use crate::domain::plugin_tabs::exec::request_timeout;
use crate::domain::plugin_tabs::managed::storage::ManagedFacts;
use crate::error::AppError;

const MAX_METHOD_CHARS: usize = 128;
pub(super) const MAX_PARAMS_BYTES: usize = 1024 * 1024;

/// A backend [`super::BackendSupervisor::running`] found, for one request.
pub struct RunningBackend(Arc<Running>);

impl RunningBackend {
    pub(super) fn new(running: Arc<Running>) -> Self {
        Self(running)
    }

    /// The tab folder it runs from.
    pub fn plugin_dir(&self) -> &Path {
        &self.0.plugin_dir
    }

    /// The version and signed facts of the marketplace revision it runs;
    /// `None` for a local tab.
    pub fn managed(&self) -> Option<(&str, &ManagedFacts)> {
        let running = &self.0;
        running
            .managed
            .as_ref()
            .map(|facts| (running.plugin_version.as_str(), facts))
    }

    /// Relay `request` to it.
    pub async fn request(
        &self,
        request: PluginBackendRequest,
    ) -> Result<PluginBackendResponse, AppError> {
        let budget = check_request(&request)?;
        self.0.call(&request.method, request.params, budget).await
    }
}

/// The time one request has, from the moment it was checked to its answer:
/// starting the backend (waiting behind another start, checking the binary,
/// the handshake) counts against it.
#[derive(Debug, Clone, Copy)]
pub(super) struct Budget {
    pub timeout: Duration,
    pub deadline: Instant,
}

impl Budget {
    pub fn starting_now(timeout: Duration) -> Self {
        Self {
            timeout,
            deadline: Instant::now() + timeout,
        }
    }

    pub fn exceeded(&self, method: &str) -> AppError {
        AppError::coded(
            StatusCode::GATEWAY_TIMEOUT,
            "PLUGIN_BACKEND_TIMEOUT",
            format!(
                "the backend did not answer `{method}` within {} ms",
                self.timeout.as_millis()
            ),
        )
    }

    /// Wait for `task` until the deadline. The task runs on its own, so one
    /// cut short (a backend start) still completes, for the next request.
    pub async fn wait_detached<T: Send + 'static>(
        &self,
        method: &str,
        task: impl Future<Output = Result<T, AppError>> + Send + 'static,
    ) -> Result<T, AppError> {
        match tokio::time::timeout_at(self.deadline, tokio::spawn(task)).await {
            Ok(Ok(result)) => result,
            Ok(Err(error)) => Err(AppError::internal(format!(
                "starting the backend failed: {error}"
            ))),
            Err(_) => Err(self.exceeded(method)),
        }
    }
}

pub(super) fn check_request(request: &PluginBackendRequest) -> Result<Budget, AppError> {
    let method_chars = request.method.chars().count();
    if method_chars == 0 || method_chars > MAX_METHOD_CHARS {
        return Err(AppError::BadRequest(format!(
            "method must be 1–{MAX_METHOD_CHARS} characters"
        )));
    }
    let params_bytes = serde_json::to_vec(&request.params).map_or(usize::MAX, |bytes| bytes.len());
    if params_bytes > MAX_PARAMS_BYTES {
        return Err(AppError::BadRequest(format!(
            "params must be at most {} KiB of JSON",
            MAX_PARAMS_BYTES / 1024
        )));
    }
    request_timeout(request.timeout_ms).map(Budget::starting_now)
}

#[cfg(test)]
mod tests {
    use serde_json::{json, Value};

    use super::*;

    fn request(method: &str, params: Value, timeout_ms: Option<u64>) -> PluginBackendRequest {
        PluginBackendRequest {
            method: method.into(),
            params,
            timeout_ms,
        }
    }

    #[test]
    fn requests_are_bounded() {
        assert_eq!(
            check_request(&request("list", json!({}), None))
                .ok()
                .map(|budget| budget.timeout),
            Some(crate::domain::plugin_tabs::exec::DEFAULT_TIMEOUT)
        );
        for bad in [
            request("", Value::Null, None),
            request(&"m".repeat(129), Value::Null, None),
            request("m", json!("x".repeat(MAX_PARAMS_BYTES)), None),
            request("m", Value::Null, Some(0)),
            request("m", Value::Null, Some(120_001)),
        ] {
            assert!(check_request(&bad).is_err());
        }
    }
}
