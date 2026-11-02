use axum::{
    extract::{DefaultBodyLimit, State},
    http::{HeaderMap, StatusCode},
    routing::{get, post},
    Json, Router,
};

use crate::api::middleware::{AUTH_HEADER, MCP_CONTROL_HEADER};
use crate::app_state::AppState;
use crate::error::AppError;
use crate::shared::security::constant_time_str_eq;

use super::models::{valid_report, DiagnosticReport, TelemetryConsent, TelemetryPreferences};

/// A device/plugin/MCP credential must never grant telemetry preference authority.
fn desktop_only(state: &AppState, headers: &HeaderMap) -> Result<(), AppError> {
    let presented = headers
        .get(AUTH_HEADER)
        .and_then(|value| value.to_str().ok())
        .unwrap_or_default();
    if headers.contains_key(MCP_CONTROL_HEADER)
        || presented.is_empty()
        || !constant_time_str_eq(presented, &state.auth_token)
        || crate::api::middleware::validate_ws_origin(headers, state.frontend_port).is_err()
    {
        return Err(AppError::coded(
            StatusCode::FORBIDDEN,
            "TELEMETRY_DESKTOP_ONLY",
            "Telemetry settings are available only in the local desktop app",
        ));
    }
    Ok(())
}

#[utoipa::path(get, path = "/api/telemetry", responses((status = 200, body = TelemetryPreferences)))]
pub async fn get_preferences(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> Result<Json<TelemetryPreferences>, AppError> {
    desktop_only(&state, &headers)?;
    Ok(Json(super::snapshot()?))
}

#[utoipa::path(put, path = "/api/telemetry", request_body = TelemetryConsent, responses((status = 200, body = TelemetryPreferences)))]
pub async fn put_preferences(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(consent): Json<TelemetryConsent>,
) -> Result<Json<TelemetryPreferences>, AppError> {
    desktop_only(&state, &headers)?;
    Ok(Json(super::update(Some(consent), false).await?))
}

#[utoipa::path(post, path = "/api/telemetry/reset-identity", responses((status = 200, body = TelemetryPreferences)))]
pub async fn reset_identity(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> Result<Json<TelemetryPreferences>, AppError> {
    desktop_only(&state, &headers)?;
    Ok(Json(super::update(None, true).await?))
}

#[utoipa::path(post, path = "/api/telemetry/diagnostics", request_body = DiagnosticReport, responses((status = 204, description = "Accepted subject to consent and bounded delivery")))]
pub async fn ingest_diagnostic(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(report): Json<DiagnosticReport>,
) -> Result<StatusCode, AppError> {
    desktop_only(&state, &headers)?;
    if !valid_report(&report) {
        return Err(AppError::BadRequest(
            "Diagnostic must contain only bounded application asset frames and a build ID".into(),
        ));
    }
    // Backend categories are internal instrumentation, never accepted from clients.
    if report.category.process() == "service" {
        return Err(AppError::BadRequest(
            "Service diagnostic categories are internal".into(),
        ));
    }
    super::capture_diagnostic(report);
    Ok(StatusCode::NO_CONTENT)
}

#[utoipa::path(post, path = "/api/telemetry/activity", responses((status = 204, description = "Accepted subject to audience preference and monthly claim")))]
pub async fn activity(
    State(state): State<AppState>,
    headers: HeaderMap,
    request: axum::extract::Request,
) -> Result<StatusCode, AppError> {
    desktop_only(&state, &headers)?;
    if axum::body::to_bytes(request.into_body(), 0).await.is_err() {
        return Err(AppError::BadRequest("Activity accepts no body".into()));
    }
    super::activity().await;
    Ok(StatusCode::NO_CONTENT)
}

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/api/telemetry", get(get_preferences).put(put_preferences))
        .route("/api/telemetry/reset-identity", post(reset_identity))
        .route("/api/telemetry/diagnostics", post(ingest_diagnostic))
        .route("/api/telemetry/activity", post(activity))
        .layer(DefaultBodyLimit::max(16 * 1024))
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::body::Body;
    use axum::http::Request;
    use tower::ServiceExt;

    async fn app() -> Router {
        let pool = sqlx::sqlite::SqlitePoolOptions::new()
            .max_connections(1)
            .connect("sqlite::memory:")
            .await
            .unwrap();
        router().with_state(AppState::with_pool(pool))
    }

    #[tokio::test]
    async fn local_routes_reject_agents_remote_credentials_and_foreign_origins() {
        for (header, value) in [
            (MCP_CONTROL_HEADER, "test-mcp-token"),
            (AUTH_HEADER, "device-token"),
            ("origin", "https://evil.example"),
        ] {
            for path in ["/api/telemetry/reset-identity", "/api/telemetry/activity"] {
                let mut request = Request::builder().method("POST").uri(path);
                if header != AUTH_HEADER {
                    request = request.header(AUTH_HEADER, "test-token");
                }
                let response = app()
                    .await
                    .oneshot(request.header(header, value).body(Body::empty()).unwrap())
                    .await
                    .unwrap();
                assert_eq!(response.status(), StatusCode::FORBIDDEN);
            }
        }
    }

    #[tokio::test]
    async fn activity_accepts_only_empty_local_desktop_requests() {
        for (body, expected) in [
            ("", StatusCode::NO_CONTENT),
            ("{}", StatusCode::BAD_REQUEST),
        ] {
            let response = app()
                .await
                .oneshot(
                    Request::builder()
                        .method("POST")
                        .uri("/api/telemetry/activity")
                        .header(AUTH_HEADER, "test-token")
                        .header("origin", "null")
                        .body(Body::from(body))
                        .unwrap(),
                )
                .await
                .unwrap();
            assert_eq!(response.status(), expected);
        }
    }

    #[tokio::test]
    async fn trusted_desktop_can_relay_curated_categories_but_not_backend_categories() {
        for (category, expected) in [
            ("react_boundary", StatusCode::NO_CONTENT),
            ("service_panic", StatusCode::BAD_REQUEST),
        ] {
            let response = app()
                .await
                .oneshot(
                    Request::builder()
                        .method("POST")
                        .uri("/api/telemetry/diagnostics")
                        .header(AUTH_HEADER, "test-token")
                        .header("origin", "null")
                        .header("content-type", "application/json")
                        .body(Body::from(
                            serde_json::json!({"category":category}).to_string(),
                        ))
                        .unwrap(),
                )
                .await
                .unwrap();
            assert_eq!(response.status(), expected);
        }
    }

    #[tokio::test]
    async fn request_shapes_reject_arbitrary_content_and_unknown_consent_fields() {
        for (path, body) in [
            (
                "/api/telemetry",
                r#"{"diagnostics_enabled":true,"usage_enabled":false,"prompt":"secret"}"#,
            ),
            (
                "/api/telemetry/diagnostics",
                r#"{"category":"react_boundary","message":"secret"}"#,
            ),
        ] {
            let response = app()
                .await
                .oneshot(
                    Request::builder()
                        .method(if path.ends_with("diagnostics") {
                            "POST"
                        } else {
                            "PUT"
                        })
                        .uri(path)
                        .header("content-type", "application/json")
                        .body(Body::from(body))
                        .unwrap(),
                )
                .await
                .unwrap();
            assert_eq!(response.status(), StatusCode::UNPROCESSABLE_ENTITY);
        }
    }
}
