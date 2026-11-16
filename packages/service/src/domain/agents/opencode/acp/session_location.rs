//! Keep a resumed OpenCode session in the folder it resumes in.
//!
//! OpenCode records the directory a session was created in and boots the
//! session's instance from it: once that folder is renamed or moved, the
//! session still opens but every prompt fails ("OpenCode service failure",
//! ENOENT on the old folder). Before a resume, a session recorded elsewhere is
//! moved to the conversation's folder, keeping its id and history.

use std::path::Path;

use opencode_sdk_rs::{OpenCodeClient, SessionMoveOutcome};

use crate::domain::agents::adapter::RuntimeError;
use crate::shared::path_rebase::same_folder;

pub(super) async fn follow_session_to(
    http: &OpenCodeClient,
    session_id: &str,
    cwd: &Path,
) -> Result<(), RuntimeError> {
    let session = http.get_session(session_id).await.map_err(|error| {
        RuntimeError::new(format!(
            "could not read where OpenCode keeps session {session_id}: {error}"
        ))
    })?;
    let recorded = Path::new(&session.directory);
    if session.directory.is_empty() || same_folder(recorded, cwd) {
        return Ok(());
    }
    let target = cwd.to_string_lossy();
    tracing::info!(session_id, from = %session.directory, to = %target, "moving OpenCode session to the conversation folder");
    match http.move_session(session_id, &target).await {
        Ok(SessionMoveOutcome::Moved) => Ok(()),
        // Resuming anyway would run the agent in the recorded folder: gone
        // after a move, or the original left behind by a copy to another disk.
        Ok(SessionMoveOutcome::Unsupported) => Err(RuntimeError::new(format!(
            "OpenCode session {session_id} belongs to {}, and this OpenCode version cannot \
             move sessions; update OpenCode to resume it in {target}",
            session.directory
        ))),
        Err(error) => Err(RuntimeError::new(format!(
            "OpenCode could not move session {session_id} from {} to {target}: {error}",
            session.directory
        ))),
    }
}

#[cfg(test)]
mod tests {
    use std::sync::{Arc, Mutex};

    use axum::extract::State;
    use axum::http::StatusCode;
    use axum::routing::{get, post};
    use axum::{Json, Router};
    use serde_json::{json, Value};
    use tokio::net::TcpListener;

    use super::*;

    #[derive(Clone)]
    struct Fake {
        directory: String,
        moves: Arc<Mutex<Vec<Value>>>,
        move_status: StatusCode,
    }

    async fn session(State(fake): State<Fake>) -> Json<Value> {
        Json(json!({ "id": "ses_1", "directory": fake.directory }))
    }

    async fn record_move(State(fake): State<Fake>, Json(body): Json<Value>) -> StatusCode {
        fake.moves.lock().unwrap().push(body);
        fake.move_status
    }

    async fn serve(
        directory: &str,
        move_route: bool,
        move_status: StatusCode,
    ) -> (OpenCodeClient, Fake) {
        let fake = Fake {
            directory: directory.to_string(),
            moves: Arc::default(),
            move_status,
        };
        let mut app = Router::new().route("/session/{id}", get(session));
        if move_route {
            app = app.route(
                "/experimental/control-plane/move-session",
                post(record_move),
            );
        }
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let client =
            OpenCodeClient::with_base_url(format!("http://{}", listener.local_addr().unwrap()));
        let app = app.with_state(fake.clone());
        tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
        (client, fake)
    }

    #[tokio::test]
    async fn a_session_already_in_the_folder_is_left_alone() {
        let folder = tempfile::tempdir().unwrap();
        let path = folder.path().to_string_lossy().to_string();
        let (client, fake) = serve(&path, true, StatusCode::NO_CONTENT).await;

        follow_session_to(&client, "ses_1", folder.path())
            .await
            .unwrap();

        assert!(fake.moves.lock().unwrap().is_empty());
    }

    #[tokio::test]
    async fn a_session_recorded_in_a_moved_folder_follows_it() {
        let folder = tempfile::tempdir().unwrap();
        let (client, fake) = serve("/repo/old", true, StatusCode::NO_CONTENT).await;

        follow_session_to(&client, "ses_1", folder.path())
            .await
            .unwrap();

        let moves = fake.moves.lock().unwrap();
        assert_eq!(
            moves[0]["destination"]["directory"],
            json!(folder.path().to_string_lossy())
        );
    }

    #[tokio::test]
    async fn an_opencode_that_cannot_move_explains_why_the_resume_fails() {
        let folder = tempfile::tempdir().unwrap();
        let (client, _fake) = serve("/repo/gone", false, StatusCode::NO_CONTENT).await;

        let error = follow_session_to(&client, "ses_1", folder.path())
            .await
            .unwrap_err();

        assert!(
            error.to_string().contains("cannot move sessions"),
            "{error}"
        );
    }

    #[tokio::test]
    async fn an_opencode_that_cannot_move_does_not_resume_in_the_original_of_a_copy() {
        let original = tempfile::tempdir().unwrap();
        let copy = tempfile::tempdir().unwrap();
        let (client, _fake) = serve(
            &original.path().to_string_lossy(),
            false,
            StatusCode::NO_CONTENT,
        )
        .await;

        let error = follow_session_to(&client, "ses_1", copy.path())
            .await
            .unwrap_err();

        assert!(
            error.to_string().contains("cannot move sessions"),
            "{error}"
        );
    }

    #[tokio::test]
    async fn a_refused_move_fails_the_resume_with_opencode_s_reason() {
        let folder = tempfile::tempdir().unwrap();
        let (client, _fake) = serve("/repo/old", true, StatusCode::BAD_REQUEST).await;

        let error = follow_session_to(&client, "ses_1", folder.path())
            .await
            .unwrap_err();

        assert!(
            error.to_string().contains("could not move session"),
            "{error}"
        );
    }
}
