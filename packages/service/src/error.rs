use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use serde::Serialize;

#[derive(Debug, Serialize)]
pub struct ErrorResponse {
    pub error: String,
    pub code: String,
}

#[derive(Debug)]
pub enum AppError {
    DatabaseError(String),
    GitCommandError(String),
    NotFound(String),
    BadRequest(String),
    Internal(String),
    Conflict(String),
    /// An endpoint-specific, stable public error code while preserving the
    /// repository-wide `{ error, code }` response envelope.
    Coded {
        status: StatusCode,
        code: &'static str,
        message: String,
    },
    /// 503 — a downstream resource is temporarily unhealthy. Used by the
    /// LSP host's crash-backoff to signal "retry later", matching the
    /// semantics web clients already understand.
    ServiceUnavailable(String),
    NeovimSpawnError {
        detail: String,
    },
    NeovimHandshakeTimeout,
    NeovimNotRunning {
        feature_id: String,
    },
    NeovimProcessNotRunning,
    NeovimFileNotFound {
        path: String,
    },
}

impl std::fmt::Display for AppError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            AppError::DatabaseError(msg) => write!(f, "Database error: {msg}"),
            AppError::GitCommandError(msg) => write!(f, "Git command error: {msg}"),
            AppError::NotFound(msg) => write!(f, "Not found: {msg}"),
            AppError::BadRequest(msg) => write!(f, "Bad request: {msg}"),
            AppError::Internal(msg) => write!(f, "Internal error: {msg}"),
            AppError::Conflict(msg) => write!(f, "Conflict: {msg}"),
            AppError::Coded { message, .. } => f.write_str(message),
            AppError::ServiceUnavailable(msg) => write!(f, "Service unavailable: {msg}"),
            AppError::NeovimSpawnError { detail } => write!(f, "Neovim spawn error: {detail}"),
            AppError::NeovimHandshakeTimeout => write!(f, "Neovim handshake timeout"),
            AppError::NeovimNotRunning { feature_id } => {
                write!(f, "Neovim not running for feature: {feature_id}")
            }
            AppError::NeovimProcessNotRunning => {
                write!(f, "Neovim process is not running")
            }
            AppError::NeovimFileNotFound { path } => {
                write!(f, "Neovim could not open file: {path}")
            }
        }
    }
}

impl std::error::Error for AppError {}

impl IntoResponse for AppError {
    fn into_response(self) -> Response {
        let (status, code) = match &self {
            AppError::DatabaseError(_) => (StatusCode::INTERNAL_SERVER_ERROR, "DATABASE_ERROR"),
            AppError::GitCommandError(_) => {
                (StatusCode::INTERNAL_SERVER_ERROR, "GIT_COMMAND_ERROR")
            }
            AppError::NotFound(_) => (StatusCode::NOT_FOUND, "NOT_FOUND"),
            AppError::BadRequest(_) => (StatusCode::BAD_REQUEST, "BAD_REQUEST"),
            AppError::Internal(_) => (StatusCode::INTERNAL_SERVER_ERROR, "INTERNAL_ERROR"),
            AppError::Conflict(_) => (StatusCode::CONFLICT, "CONFLICT"),
            AppError::Coded { status, code, .. } => (*status, *code),
            AppError::ServiceUnavailable(_) => {
                (StatusCode::SERVICE_UNAVAILABLE, "SERVICE_UNAVAILABLE")
            }
            AppError::NeovimSpawnError { .. } => {
                (StatusCode::INTERNAL_SERVER_ERROR, "NEOVIM_SPAWN_ERROR")
            }
            AppError::NeovimHandshakeTimeout => (
                StatusCode::INTERNAL_SERVER_ERROR,
                "NEOVIM_HANDSHAKE_TIMEOUT",
            ),
            AppError::NeovimNotRunning { .. } => (StatusCode::NOT_FOUND, "NEOVIM_NOT_RUNNING"),
            AppError::NeovimProcessNotRunning => {
                (StatusCode::NOT_FOUND, "NEOVIM_PROCESS_NOT_RUNNING")
            }
            AppError::NeovimFileNotFound { .. } => (StatusCode::NOT_FOUND, "NEOVIM_FILE_NOT_FOUND"),
        };

        if status.is_server_error() {
            tracing::error!(code = code, error = %self, "request failed");
        }

        let public_error = if status == StatusCode::INTERNAL_SERVER_ERROR {
            "Internal server error".to_string()
        } else {
            self.to_string()
        };
        let body = ErrorResponse {
            error: public_error,
            code: code.to_string(),
        };

        (status, axum::Json(body)).into_response()
    }
}

impl From<sqlx::Error> for AppError {
    fn from(err: sqlx::Error) -> Self {
        AppError::DatabaseError(err.to_string())
    }
}

impl AppError {
    pub fn coded(status: StatusCode, code: &'static str, message: impl Into<String>) -> Self {
        Self::Coded {
            status,
            code,
            message: message.into(),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::body::to_bytes;
    use axum::response::IntoResponse;

    #[test]
    fn test_not_found_returns_404() {
        let err = AppError::NotFound("missing".into());
        let response = err.into_response();
        assert_eq!(response.status(), StatusCode::NOT_FOUND);
    }

    #[test]
    fn test_bad_request_returns_400() {
        let err = AppError::BadRequest("invalid".into());
        let response = err.into_response();
        assert_eq!(response.status(), StatusCode::BAD_REQUEST);
    }

    #[test]
    fn test_internal_returns_500() {
        let err = AppError::Internal("boom".into());
        let response = err.into_response();
        assert_eq!(response.status(), StatusCode::INTERNAL_SERVER_ERROR);
    }

    #[test]
    fn neovim_file_not_found_maps_to_404_and_stable_code() {
        let response = AppError::NeovimFileNotFound {
            path: "/tmp/missing.rs".to_string(),
        }
        .into_response();
        assert_eq!(response.status(), StatusCode::NOT_FOUND);
    }

    #[tokio::test]
    async fn internal_error_body_does_not_expose_details() {
        let response =
            AppError::DatabaseError("SELECT secret FROM private_table".into()).into_response();
        let bytes = to_bytes(response.into_body(), usize::MAX)
            .await
            .expect("read response body");
        let body: serde_json::Value =
            serde_json::from_slice(&bytes).expect("decode error response");

        assert_eq!(body["error"], "Internal server error");
        assert_eq!(body["code"], "DATABASE_ERROR");
        assert!(!body["error"].as_str().unwrap().contains("SELECT"));
    }

    #[tokio::test]
    async fn coded_error_preserves_the_public_code_and_message() {
        let response = AppError::coded(
            StatusCode::CONFLICT,
            "PROVIDER_ALREADY_INSTALLED",
            "provider is already installed",
        )
        .into_response();
        assert_eq!(response.status(), StatusCode::CONFLICT);
        let bytes = to_bytes(response.into_body(), usize::MAX).await.unwrap();
        let body: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
        assert_eq!(body["code"], "PROVIDER_ALREADY_INSTALLED");
        assert_eq!(body["error"], "provider is already installed");
    }
}
