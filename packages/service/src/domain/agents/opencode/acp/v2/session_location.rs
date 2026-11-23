//! Keep a resumed OpenCode 2.x session in the folder it resumes in.
//!
//! 2.x refuses `session/resume` from any folder but the session's recorded one
//! ("does not belong to cwd"). Before a resume, a session recorded elsewhere is
//! moved through `POST /api/session/{id}/move`. OpenCode applies the move at
//! once when the recorded folder is gone (a renamed or moved project) and
//! otherwise queues it for the session's next turn, which a resume from the new
//! folder cannot reach: that case fails with an explanation rather than run the
//! agent in a folder the conversation left.

use std::path::Path;

use opencode_sdk_rs::StandaloneApi;

use crate::domain::agents::adapter::RuntimeError;
use crate::shared::path_rebase::same_folder;

pub(super) async fn follow_session_to(
    api: &StandaloneApi,
    session_id: &str,
    cwd: &Path,
) -> Result<(), RuntimeError> {
    let recorded = api.session_directory(session_id).await.map_err(|error| {
        RuntimeError::new(format!(
            "could not read where OpenCode keeps session {session_id}: {error}"
        ))
    })?;
    if recorded.is_empty() || same_folder(Path::new(&recorded), cwd) {
        return Ok(());
    }
    let target = cwd.to_string_lossy();
    tracing::info!(session_id, from = %recorded, to = %target, "moving OpenCode session to the conversation folder");
    api.move_session(session_id, cwd).await.map_err(|error| {
        RuntimeError::new(format!(
            "OpenCode could not move session {session_id} from {recorded} to {target}: {error}"
        ))
    })?;
    let now = api.session_directory(session_id).await.map_err(|error| {
        RuntimeError::new(format!(
            "could not read where OpenCode moved session {session_id}: {error}"
        ))
    })?;
    if same_folder(Path::new(&now), cwd) {
        return Ok(());
    }
    Err(RuntimeError::new(format!(
        "OpenCode session {session_id} still belongs to {recorded}: OpenCode moves a session \
         whose folder still exists only on its next turn there"
    )))
}

#[cfg(test)]
#[cfg(unix)]
mod tests {
    use std::os::unix::fs::PermissionsExt;
    use std::path::Path;

    use opencode_sdk_rs::StandaloneApi;

    use super::follow_session_to;

    /// A fake `opencode api` whose session lives in `$DIR` (a file next to it
    /// that a move rewrites when `moves` is true).
    fn fake(dir: &Path, recorded: &str, moves: bool) -> StandaloneApi {
        std::fs::write(dir.join("location"), recorded).unwrap();
        let script = format!(
            r#"#!/bin/sh
here="$(dirname "$0")"
echo "$4 $6" >> "$here/calls"
case "$3 $4" in
  "POST "*/move) {move} ;;
  "GET "*) printf '{{"data":{{"location":{{"directory":"%s"}}}}}}' "$(cat "$here/location")" ;;
esac
"#,
            move = if moves {
                r#"echo "$6" | sed 's/.*"directory":"\([^"]*\)".*/\1/' | tr -d '\n' > "$here/location""#
            } else {
                "true"
            }
        );
        let binary = dir.join("opencode");
        std::fs::write(&binary, script).unwrap();
        std::fs::set_permissions(&binary, std::fs::Permissions::from_mode(0o755)).unwrap();
        StandaloneApi::new(binary, None)
    }

    #[tokio::test]
    async fn a_session_already_in_the_folder_is_left_alone() {
        let dir = tempfile::tempdir().unwrap();
        let api = fake(dir.path(), "/repo/new", true);
        follow_session_to(&api, "ses_1", Path::new("/repo/new"))
            .await
            .unwrap();
        let calls = std::fs::read_to_string(dir.path().join("calls")).unwrap();
        assert!(!calls.contains("/move"), "{calls}");
    }

    #[tokio::test]
    async fn a_session_left_in_a_gone_folder_moves_to_the_conversation() {
        let dir = tempfile::tempdir().unwrap();
        let api = fake(dir.path(), "/repo/old", true);
        follow_session_to(&api, "ses_1", Path::new("/repo/new"))
            .await
            .unwrap();
        let calls = std::fs::read_to_string(dir.path().join("calls")).unwrap();
        assert!(
            calls.contains(r#"/api/session/ses_1/move {"directory":"/repo/new"}"#),
            "{calls}"
        );
    }

    #[tokio::test]
    async fn a_queued_move_fails_the_resume_with_an_explanation() {
        let dir = tempfile::tempdir().unwrap();
        let api = fake(dir.path(), "/repo/old", false);
        let error = follow_session_to(&api, "ses_1", Path::new("/repo/new"))
            .await
            .unwrap_err();
        assert!(
            error.to_string().contains("still belongs to /repo/old"),
            "{error}"
        );
    }
}
