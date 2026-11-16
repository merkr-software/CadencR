use std::time::Duration;

use reqwest::StatusCode;

use super::{ensure_success, OpenCodeClient};
use crate::error::SdkError;
use crate::parsing::parse_session_from;
use crate::types::Session;

/// What OpenCode did with a request to move a session to another directory.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SessionMoveOutcome {
    Moved,
    /// This OpenCode exposes no session move route.
    Unsupported,
}

/// 1.x serves the move as an experimental control-plane route; 2.x moved it
/// under the session API. Both answer 404 only when the route is absent.
const EXPERIMENTAL_MOVE_PATH: &str = "/experimental/control-plane/move-session";

/// Both calls run before a resume, against the server of the process that
/// was just started: a server that does not answer fails the resume instead
/// of holding it forever.
const REQUEST_TIMEOUT: Duration = Duration::from_secs(10);

impl OpenCodeClient {
    /// `GET /session/{id}` — the session, whichever directory it lives in.
    pub async fn get_session(&self, session_id: &str) -> Result<Session, SdkError> {
        let response = self
            .http
            .get(format!("{}/session/{session_id}", self.base_url))
            .timeout(REQUEST_TIMEOUT)
            .send()
            .await?;
        let body = ensure_success(response).await?;
        parse_session_from(&body)
            .ok_or_else(|| SdkError::Protocol("malformed session response".to_string()))
    }

    /// Point an existing session at `directory`, keeping its id and history.
    /// OpenCode boots a session's instance from its recorded directory, so a
    /// session whose folder moved cannot run until it is moved too. OpenCode
    /// refuses a directory that belongs to another project.
    pub async fn move_session(
        &self,
        session_id: &str,
        directory: &str,
    ) -> Result<SessionMoveOutcome, SdkError> {
        let experimental = self
            .http
            .post(format!("{}{EXPERIMENTAL_MOVE_PATH}", self.base_url))
            .json(&serde_json::json!({
                "sessionID": session_id,
                "destination": { "directory": directory },
            }))
            .timeout(REQUEST_TIMEOUT)
            .send()
            .await?;
        if experimental.status() != StatusCode::NOT_FOUND {
            return ensure_success(experimental)
                .await
                .map(|_| SessionMoveOutcome::Moved);
        }
        let current = self
            .http
            .post(format!("{}/api/session/{session_id}/move", self.base_url))
            .json(&serde_json::json!({ "directory": directory }))
            .timeout(REQUEST_TIMEOUT)
            .send()
            .await?;
        if current.status() == StatusCode::NOT_FOUND {
            return Ok(SessionMoveOutcome::Unsupported);
        }
        ensure_success(current)
            .await
            .map(|_| SessionMoveOutcome::Moved)
    }
}

#[cfg(test)]
mod tests {
    use std::sync::{Arc, Mutex};

    use axum::extract::State;
    use axum::http::{StatusCode, Uri};
    use axum::routing::{get, post};
    use axum::{Json, Router};
    use serde_json::{json, Value};
    use tokio::net::TcpListener;

    use super::{OpenCodeClient, SessionMoveOutcome};
    use crate::error::SdkError;

    #[derive(Clone, Default)]
    struct Requests(Arc<Mutex<Vec<(String, Value)>>>);

    async fn record(
        State(requests): State<Requests>,
        uri: Uri,
        Json(body): Json<Value>,
    ) -> StatusCode {
        requests.0.lock().unwrap().push((uri.to_string(), body));
        StatusCode::NO_CONTENT
    }

    async fn refuse(Json(_body): Json<Value>) -> (StatusCode, Json<Value>) {
        (
            StatusCode::BAD_REQUEST,
            Json(json!({ "name": "MoveSessionError", "data": {
                "message": "Destination directory belongs to another project" } })),
        )
    }

    async fn serve(app: Router) -> OpenCodeClient {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let client =
            OpenCodeClient::with_base_url(format!("http://{}", listener.local_addr().unwrap()));
        tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
        client
    }

    #[tokio::test]
    async fn moves_through_the_experimental_route_when_it_exists() {
        let requests = Requests::default();
        let client = serve(
            Router::new()
                .route("/experimental/control-plane/move-session", post(record))
                .with_state(requests.clone()),
        )
        .await;

        let outcome = client.move_session("ses_1", "/repo/new").await.unwrap();

        assert_eq!(outcome, SessionMoveOutcome::Moved);
        assert_eq!(
            requests.0.lock().unwrap()[0],
            (
                "/experimental/control-plane/move-session".to_string(),
                json!({ "sessionID": "ses_1", "destination": { "directory": "/repo/new" } })
            )
        );
    }

    #[tokio::test]
    async fn falls_back_to_the_session_route_of_opencode_2() {
        let requests = Requests::default();
        let client = serve(
            Router::new()
                .route("/api/session/{id}/move", post(record))
                .with_state(requests.clone()),
        )
        .await;

        let outcome = client.move_session("ses_1", "/repo/new").await.unwrap();

        assert_eq!(outcome, SessionMoveOutcome::Moved);
        assert_eq!(
            requests.0.lock().unwrap()[0],
            (
                "/api/session/ses_1/move".to_string(),
                json!({ "directory": "/repo/new" })
            )
        );
    }

    #[tokio::test]
    async fn reports_an_opencode_without_a_move_route() {
        let client = serve(Router::new()).await;

        let outcome = client.move_session("ses_1", "/repo/new").await.unwrap();

        assert_eq!(outcome, SessionMoveOutcome::Unsupported);
    }

    #[tokio::test]
    async fn surfaces_a_refused_move() {
        let client =
            serve(Router::new().route("/experimental/control-plane/move-session", post(refuse)))
                .await;

        let error = client
            .move_session("ses_1", "/elsewhere")
            .await
            .unwrap_err();

        assert!(
            matches!(&error, SdkError::HttpStatus { status: 400, body } if body.contains("another project")),
            "{error:?}"
        );
    }

    #[tokio::test]
    async fn reads_the_session_directory() {
        let client = serve(Router::new().route(
            "/session/{id}",
            get(|| async { Json(json!({ "id": "ses_1", "directory": "/repo/old" })) }),
        ))
        .await;

        let session = client.get_session("ses_1").await.unwrap();

        assert_eq!(session.directory, "/repo/old");
    }
}
