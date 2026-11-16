use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use serde::Serialize;

mod database;
mod git;
mod origin;

pub use git::{GitFailureKind, GitRejection};
pub use origin::{Detail, Origin};

#[derive(Debug, Serialize)]
pub struct ErrorResponse {
    pub error: String,
    pub code: String,
}

#[derive(Debug)]
pub enum AppError {
    /// Unexpected database failure — a masked 500.
    DatabaseError(Detail),
    /// 503 — SQLite busy/locked or the pool timed out; retryable. The driver
    /// detail is logged, never returned.
    DatabaseBusy(Detail),
    /// 409 — a uniqueness or foreign-key constraint rejected the write. The
    /// driver detail (SQL names) is logged, never returned.
    ConstraintViolation(String),
    /// Git could not be run or produced unexpected output — a masked 500.
    GitCommandError(Detail),
    /// Git ran and refused the operation; its sanitized message is returned
    /// with a 4xx status and a stable `GIT_*` code.
    GitRejected(GitRejection),
    NotFound(String),
    BadRequest(String),
    Internal(Detail),
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
            AppError::DatabaseBusy(msg) => write!(f, "Database busy: {msg}"),
            AppError::ConstraintViolation(msg) => write!(f, "Constraint violation: {msg}"),
            // Same prefix for both git variants: streamed git operations
            // forward this Display text over WebSocket.
            AppError::GitCommandError(msg) => write!(f, "Git command error: {msg}"),
            AppError::GitRejected(rejection) => {
                write!(f, "Git command error: {}", rejection.message)
            }
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
        let (status, code) = self.status_and_code();
        self.report(status, code);
        let body = ErrorResponse {
            error: self.public_message(status),
            code: code.to_string(),
        };
        (status, axum::Json(body)).into_response()
    }
}

impl From<sqlx::Error> for AppError {
    #[track_caller]
    fn from(err: sqlx::Error) -> Self {
        database::from_sqlx(err)
    }
}

impl AppError {
    // Reported failures record their construction site; see `origin`.
    #[track_caller]
    pub fn internal(message: impl Into<String>) -> Self {
        Self::Internal(Detail::new(message))
    }

    #[track_caller]
    pub fn database(message: impl Into<String>) -> Self {
        Self::DatabaseError(Detail::new(message))
    }

    #[track_caller]
    pub fn database_busy(message: impl Into<String>) -> Self {
        Self::DatabaseBusy(Detail::new(message))
    }

    #[track_caller]
    pub fn git_command(message: impl Into<String>) -> Self {
        Self::GitCommandError(Detail::new(message))
    }

    pub fn coded(status: StatusCode, code: &'static str, message: impl Into<String>) -> Self {
        Self::Coded {
            status,
            code,
            message: message.into(),
        }
    }

    /// Git exited non-zero: classify its (already sanitized) message.
    #[track_caller]
    pub fn git_rejected(message: impl Into<String>) -> Self {
        Self::GitRejected(GitRejection::classify(message))
    }

    fn status_and_code(&self) -> (StatusCode, &'static str) {
        match self {
            AppError::DatabaseError(_) => (StatusCode::INTERNAL_SERVER_ERROR, "DATABASE_ERROR"),
            AppError::DatabaseBusy(_) => (StatusCode::SERVICE_UNAVAILABLE, "DATABASE_BUSY"),
            AppError::ConstraintViolation(_) => (StatusCode::CONFLICT, "CONSTRAINT_VIOLATION"),
            AppError::GitCommandError(_) => {
                (StatusCode::INTERNAL_SERVER_ERROR, "GIT_COMMAND_ERROR")
            }
            AppError::GitRejected(rejection) => (rejection.kind.status(), rejection.kind.code()),
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
        }
    }

    /// Server errors are logged and reported; client errors whose public
    /// message hides a detail (constraint text, git output) are still logged.
    /// An unclassified git refusal is reported too: it may be plumbing that
    /// failed rather than git declining the user's request.
    fn report(&self, status: StatusCode, code: &'static str) {
        use crate::domain::telemetry::{diagnostic, models::DiagnosticCategory};
        if !status.is_server_error() {
            if matches!(
                self,
                AppError::ConstraintViolation(_) | AppError::GitRejected(_)
            ) {
                tracing::warn!(code = code, error = %self, "request rejected");
            }
            if let AppError::GitRejected(rejection) = self {
                if rejection.kind == GitFailureKind::CommandFailed {
                    diagnostic(DiagnosticCategory::ServiceGit, self.origin_frames());
                }
            }
            return;
        }
        tracing::error!(code = code, error = %self, "request failed");
        // Only curated application failures; never forward Display, trace fields or provider text.
        let category = match self {
            AppError::DatabaseError(_) | AppError::DatabaseBusy(_) => {
                DiagnosticCategory::ServiceDatabase
            }
            AppError::Internal(_) => DiagnosticCategory::ServiceInternal,
            AppError::GitCommandError(_) => DiagnosticCategory::ServiceGit,
            _ => return,
        };
        diagnostic(category, self.origin_frames());
    }

    /// The construction site of a failure that telemetry reports.
    fn origin(&self) -> Option<Origin> {
        match self {
            AppError::DatabaseError(detail)
            | AppError::DatabaseBusy(detail)
            | AppError::Internal(detail)
            | AppError::GitCommandError(detail) => Some(detail.origin()),
            AppError::GitRejected(rejection) => Some(rejection.origin),
            _ => None,
        }
    }

    fn origin_frames(&self) -> Vec<crate::domain::telemetry::models::DiagnosticFrame> {
        self.origin().and_then(Origin::frame).into_iter().collect()
    }

    fn public_message(&self, status: StatusCode) -> String {
        match self {
            AppError::DatabaseBusy(_) => database::BUSY_PUBLIC_MESSAGE.to_string(),
            AppError::ConstraintViolation(_) => database::CONSTRAINT_PUBLIC_MESSAGE.to_string(),
            AppError::GitRejected(rejection) => rejection.message.clone(),
            _ if status == StatusCode::INTERNAL_SERVER_ERROR => "Internal server error".to_string(),
            _ => self.to_string(),
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
        let err = AppError::internal("boom");
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
        let response = AppError::database("SELECT secret FROM private_table").into_response();
        let bytes = to_bytes(response.into_body(), usize::MAX)
            .await
            .expect("read response body");
        let body: serde_json::Value =
            serde_json::from_slice(&bytes).expect("decode error response");

        assert_eq!(body["error"], "Internal server error");
        assert_eq!(body["code"], "DATABASE_ERROR");
        assert!(!body["error"].as_str().unwrap().contains("SELECT"));
    }

    async fn response_parts(error: AppError) -> (StatusCode, serde_json::Value) {
        let response = error.into_response();
        let status = response.status();
        let bytes = to_bytes(response.into_body(), usize::MAX)
            .await
            .expect("read response body");
        let body = serde_json::from_slice(&bytes).expect("decode error response");
        (status, body)
    }

    #[tokio::test]
    async fn git_refusal_returns_its_message_with_a_stable_code() {
        let message = "error: Your local changes to the following files would be overwritten by checkout:\n\tsrc/a.rs\nPlease commit your changes or stash them before you switch branches.";
        let (status, body) = response_parts(AppError::git_rejected(message)).await;
        assert_eq!(status, StatusCode::CONFLICT);
        assert_eq!(
            body,
            serde_json::json!({ "error": message, "code": "GIT_LOCAL_CHANGES_CONFLICT" })
        );
    }

    #[tokio::test]
    async fn unclassified_git_refusal_is_still_user_facing() {
        let message = "git status failed: fatal: not a git repository";
        let (status, body) = response_parts(AppError::git_rejected(message)).await;
        assert_eq!(status, StatusCode::UNPROCESSABLE_ENTITY);
        assert_eq!(
            body,
            serde_json::json!({ "error": message, "code": "GIT_COMMAND_FAILED" })
        );
    }

    #[tokio::test]
    async fn git_spawn_failure_stays_masked() {
        let (status, body) =
            response_parts(AppError::git_command("Failed to spawn git: ENOENT")).await;
        assert_eq!(status, StatusCode::INTERNAL_SERVER_ERROR);
        assert_eq!(
            body,
            serde_json::json!({ "error": "Internal server error", "code": "GIT_COMMAND_ERROR" })
        );
    }

    #[test]
    fn git_rejection_keeps_the_streamed_display_prefix() {
        assert_eq!(
            AppError::git_rejected("fatal: boom").to_string(),
            "Git command error: fatal: boom"
        );
    }

    #[tokio::test]
    async fn constraint_violation_body_hides_the_sql_detail() {
        let pool = sqlx::SqlitePool::connect("sqlite::memory:").await.unwrap();
        sqlx::query("CREATE TABLE private_table (name TEXT UNIQUE)")
            .execute(&pool)
            .await
            .unwrap();
        let insert = "INSERT INTO private_table (name) VALUES ('dup')";
        sqlx::query(insert).execute(&pool).await.unwrap();
        let error = AppError::from(sqlx::query(insert).execute(&pool).await.unwrap_err());

        let (status, body) = response_parts(error).await;
        assert_eq!(status, StatusCode::CONFLICT);
        assert_eq!(
            body,
            serde_json::json!({
                "error": "The change conflicts with existing data",
                "code": "CONSTRAINT_VIOLATION"
            })
        );
    }

    #[tokio::test]
    async fn database_busy_is_a_retryable_503() {
        let (status, body) = response_parts(AppError::from(sqlx::Error::PoolTimedOut)).await;
        assert_eq!(status, StatusCode::SERVICE_UNAVAILABLE);
        assert_eq!(
            body,
            serde_json::json!({
                "error": "The database is busy; please retry in a moment",
                "code": "DATABASE_BUSY"
            })
        );
    }

    fn origin_line(error: &AppError) -> (String, u32) {
        let [frame] = error.origin_frames().try_into().expect("one source frame");
        (frame.filename, frame.lineno)
    }

    #[test]
    fn reported_failures_record_the_line_that_built_them() {
        let first = line!() + 2;
        let errors = [
            AppError::internal("boom"),
            AppError::database("boom"),
            AppError::database_busy("boom"),
            AppError::git_command("boom"),
            AppError::git_rejected("fatal: boom"),
        ];
        for (line, error) in (first..).zip(&errors) {
            assert_eq!(origin_line(error), ("src/error.rs".into(), line));
        }
        assert!(AppError::NotFound("missing".into())
            .origin_frames()
            .is_empty());
    }

    #[test]
    fn a_converted_database_error_records_the_question_mark() {
        fn query() -> Result<(), AppError> {
            Err(sqlx::Error::RowNotFound)?;
            Ok(())
        }
        let line = line!() - 3;
        let error = query().unwrap_err();
        assert!(matches!(error, AppError::DatabaseError(_)), "{error:?}");
        assert_eq!(origin_line(&error), ("src/error.rs".into(), line));
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
