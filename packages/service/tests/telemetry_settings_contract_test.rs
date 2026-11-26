//! HTTP contract for the process-wide telemetry runtime, backed by a disposable settings file.

use axum::{
    body::{to_bytes, Body},
    http::{Request, StatusCode},
    Router,
};
use cadencr_service::app_state::AppState;
use cadencr_service::domain::{settings_store, telemetry};
use serde_json::{json, Value};
use tower::ServiceExt;

#[tokio::test]
async fn telemetry_get_separates_absent_legacy_and_invalid_preferences_then_recovers() {
    let settings = tempfile::tempdir().unwrap();
    settings_store::init(settings.path().to_path_buf());
    let path = settings_store::paths::global_file(settings.path());
    let saved = json!({
        "onboarding_step": "completed",
        "telemetry": {
            "decision_version": 1,
            "diagnostics_enabled": false,
            "usage_enabled": false,
            "audience_enabled": false
        }
    })
    .to_string();
    std::fs::write(&path, &saved).unwrap();
    telemetry::initialize(None);
    let pool = sqlx::SqlitePool::connect_lazy("sqlite::memory:").unwrap();
    let app = telemetry::routes::router().with_state(AppState::with_pool(pool));

    for (document, expected_counter) in [
        ("{}", true),
        (r#"{"telemetry":{"audience_enabled":false}}"#, false),
    ] {
        std::fs::write(&path, document).unwrap();
        let (status, body) = preferences(&app, "GET", Body::empty()).await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(body["decision_version"], Value::Null);
        assert_eq!(body["audience_enabled"], expected_counter);
        assert_eq!(std::fs::read_to_string(&path).unwrap(), document);
    }

    std::fs::write(&path, &saved).unwrap();
    let original = preferences(&app, "GET", Body::empty()).await;
    assert_eq!(original.0, StatusCode::OK);
    assert_eq!(original.1["decision_version"], 1);
    for field in ["diagnostics_enabled", "usage_enabled", "audience_enabled"] {
        assert_eq!(original.1[field], false);
    }

    for invalid in ["[]", "[false, false, true, 1]", "null"] {
        let document = format!(r#"{{"onboarding_step":"completed","telemetry":{invalid}}}"#);
        std::fs::write(&path, &document).unwrap();
        for (method, payload) in [
            ("GET", Body::empty()),
            (
                "PUT",
                Body::from(r#"{"diagnostics_enabled":false,"usage_enabled":false}"#),
            ),
        ] {
            let (status, body) = preferences(&app, method, payload).await;
            assert_eq!(status, StatusCode::BAD_REQUEST);
            assert_eq!(body["code"], "SETTINGS_INVALID");
            assert!(body.get("decision_version").is_none());
        }
        assert_eq!(std::fs::read_to_string(&path).unwrap(), document);
    }

    std::fs::write(&path, &saved).unwrap();
    assert_eq!(preferences(&app, "GET", Body::empty()).await, original);
    assert_eq!(std::fs::read_to_string(&path).unwrap(), saved);
}

async fn preferences(app: &Router, method: &str, body: Body) -> (StatusCode, Value) {
    let request = Request::builder()
        .method(method)
        .uri("/api/telemetry")
        .header("X-Cadencr-Token", "test-token")
        .header("origin", "null")
        .header("content-type", "application/json")
        .body(body)
        .unwrap();
    let response = app.clone().oneshot(request).await.unwrap();
    let status = response.status();
    let body = to_bytes(response.into_body(), usize::MAX).await.unwrap();
    (status, serde_json::from_slice(&body).unwrap())
}
