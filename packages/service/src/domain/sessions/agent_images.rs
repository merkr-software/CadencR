//! `GET /api/features/{feature_id}/agent-image` — the bytes behind an image an
//! agent posted in chat by local path (`![shot](/tmp/qa/shot.png)`).
//!
//! The local window could load such a path straight off `file://`; a remote
//! device cannot, and the renderer CSP only admits `blob:` and `data:` images
//! anyway. So the chat hands the markdown `src` to this route and renders the
//! bytes from a `blob:` URL — the same transport as `read-image`.
//!
//! Screenshots land wherever the agent wrote them (`/tmp`, a QA folder, the
//! worktree), so the read cannot be confined to a project root. It is confined
//! to what the conversation shows instead: the `src` must appear as an image
//! destination in one of the feature's chat messages, and the file must carry
//! an image extension. That is defense in depth, not a boundary — a paired
//! device can write the reference into a prompt itself, and it already has a
//! terminal on this machine. Excluded from the OpenAPI paths like `read-image`:
//! orval would emit an `unknown`-typed hook for a binary body.

use std::path::PathBuf;

use axum::extract::{Path, Query, State};
use axum::http::StatusCode;
use axum::response::Response;
use percent_encoding::percent_decode_str;
use reqwest::Url;
use serde::Deserialize;
use sqlx::{AssertSqlSafe, SqlitePool};

use crate::app_state::AppState;
use crate::domain::features::service::get_feature_cwd;
use crate::error::AppError;
use crate::shared::capped_read::read_file_capped;
use crate::shared::image_file::{image_or_svg_mime_for_path, image_response, MAX_IMAGE_FILE_SIZE};

#[derive(Debug, Deserialize)]
pub struct AgentImageParams {
    /// The image `src` exactly as the markdown renderer received it.
    pub src: String,
}

pub async fn get_agent_image_handler(
    State(state): State<AppState>,
    Path(feature_id): Path<i64>,
    Query(params): Query<AgentImageParams>,
) -> Result<Response, AppError> {
    let src = params.src.as_str();
    // The markdown parser percent-encodes spaces and non-ASCII in a link
    // destination, so the transcript may hold either spelling. A file whose
    // name literally contains `%20` is out of reach; no agent names one so.
    let decoded = percent_decode_str(src)
        .decode_utf8()
        .map_err(|_| AppError::BadRequest("Image source is not valid UTF-8".into()))?;
    // Before touching the disk, so an unreferenced path can't probe for files.
    if !transcript_shows(&state.read_pool, feature_id, &[src, &decoded]).await? {
        return Err(AppError::Coded {
            status: StatusCode::FORBIDDEN,
            code: "IMAGE_NOT_REFERENCED",
            message: "This image is not referenced in the conversation".into(),
        });
    }

    let path = match image_path(src, &decoded)? {
        ImagePath::Absolute(path) => path,
        ImagePath::Relative(path) => {
            PathBuf::from(get_feature_cwd(&state.read_pool, feature_id).await?).join(path)
        }
    };
    let path = canonical_file(path).await?;
    let mime = image_or_svg_mime_for_path(&path)
        .ok_or_else(|| AppError::BadRequest("Unsupported image extension".into()))?;
    let bytes = read_file_capped(path, MAX_IMAGE_FILE_SIZE, "Image").await?;
    image_response(bytes, mime)
}

/// The ways a chat message shows `src` as an image: `![](src)`, `![](src "title")`,
/// `![](<src>)`, and a raw `<img src="src">`. Delimiters matter — a bare
/// substring would let `a.png` ride on any `data.png`, and a path merely
/// mentioned in prose was never displayed.
fn image_reference_needles(spellings: &[&str]) -> Vec<String> {
    let mut needles: Vec<String> = spellings
        .iter()
        .flat_map(|s| {
            [
                format!("({s})"),
                format!("({s} "),
                format!("<{s}>"),
                format!("\"{s}\""),
                format!("'{s}'"),
            ]
        })
        .collect();
    needles.sort();
    needles.dedup();
    needles
}

/// Whether any chat-rendered message of the feature shows the source as an
/// image. Tool output does not count: the chat never renders it as markdown.
async fn transcript_shows(
    pool: &SqlitePool,
    feature_id: i64,
    spellings: &[&str],
) -> Result<bool, AppError> {
    let needles = image_reference_needles(spellings);
    let matches = vec!["instr(content, ?) > 0"; needles.len()].join(" OR ");
    // `IN (subquery)` keeps the planner on the (session_id, message_type)
    // index; a join lets it pick a full scan of every message for some ids.
    let sql = format!(
        "SELECT 1 FROM agent_messages
         WHERE session_id IN (SELECT id FROM agent_sessions WHERE feature_id = ?)
           AND message_type IN ('text', 'thinking', 'user_message')
           AND ({matches})
         LIMIT 1"
    );
    // Only `?` placeholders are interpolated; every value is bound.
    let mut query = sqlx::query_scalar::<_, i64>(AssertSqlSafe(sql)).bind(feature_id);
    for needle in &needles {
        query = query.bind(needle);
    }
    Ok(query.fetch_optional(pool).await?.is_some())
}

#[derive(Debug, PartialEq)]
enum ImagePath {
    Absolute(PathBuf),
    /// Relative to the feature's working directory, where the agent ran.
    Relative(PathBuf),
}

fn image_path(src: &str, decoded: &str) -> Result<ImagePath, AppError> {
    // Paths don't parse as URLs (no base); anything that does is a URL.
    if let Ok(url) = Url::parse(src) {
        if url.scheme() != "file" {
            return Err(AppError::BadRequest("Not a local image".into()));
        }
        // Refuses a `file://otherhost/…` rather than reading it as a path.
        return url
            .to_file_path()
            .map(ImagePath::Absolute)
            .map_err(|()| AppError::BadRequest("Not a local file URL".into()));
    }
    let path = PathBuf::from(decoded);
    Ok(if path.is_absolute() {
        ImagePath::Absolute(path)
    } else {
        ImagePath::Relative(path)
    })
}

/// Resolve symlinks before the extension check, so `shot.png` pointing at a
/// private key is judged by what it points at.
async fn canonical_file(path: PathBuf) -> Result<PathBuf, AppError> {
    tokio::task::spawn_blocking(move || {
        let canonical = std::fs::canonicalize(&path).map_err(|e| {
            if e.kind() == std::io::ErrorKind::NotFound {
                AppError::NotFound(path.display().to_string())
            } else {
                AppError::BadRequest(format!("Cannot access image: {e}"))
            }
        })?;
        if !canonical.is_file() {
            return Err(AppError::BadRequest(format!(
                "Not a file: {}",
                path.display()
            )));
        }
        Ok(canonical)
    })
    .await
    .map_err(|e| AppError::internal(format!("Blocking task failed: {e}")))?
}

#[cfg(test)]
mod tests {
    use super::*;

    fn path_of(src: &str) -> Result<ImagePath, AppError> {
        let decoded = percent_decode_str(src).decode_utf8().unwrap();
        image_path(src, &decoded)
    }

    #[test]
    fn absolute_paths_and_file_urls_stand_alone() {
        for src in [
            "/tmp/shot.png",
            "file:///tmp/shot.png",
            "file://localhost/tmp/shot.png",
        ] {
            assert_eq!(
                path_of(src).unwrap(),
                ImagePath::Absolute("/tmp/shot.png".into()),
                "{src}"
            );
        }
        assert_eq!(
            path_of("/tmp/my%20shot.png").unwrap(),
            ImagePath::Absolute("/tmp/my shot.png".into())
        );
    }

    #[test]
    fn other_sources_are_relative_to_the_agent_cwd() {
        assert_eq!(
            path_of("docs/qa/shot.png").unwrap(),
            ImagePath::Relative("docs/qa/shot.png".into())
        );
    }

    #[test]
    fn urls_that_are_not_local_files_are_refused() {
        for src in [
            "https://example.com/a.png",
            "data:image/png,x",
            "file://otherhost/a.png",
        ] {
            assert!(
                matches!(path_of(src), Err(AppError::BadRequest(_))),
                "{src}"
            );
        }
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn an_image_named_symlink_is_judged_by_its_target() {
        let dir = tempfile::tempdir().unwrap();
        let secret = dir.path().join("id_rsa");
        std::fs::write(&secret, b"secret").unwrap();
        let disguised = dir.path().join("shot.png");
        std::os::unix::fs::symlink(&secret, &disguised).unwrap();

        let canonical = canonical_file(disguised).await.unwrap();
        assert_eq!(image_or_svg_mime_for_path(&canonical), None);
    }

    #[tokio::test]
    async fn directories_and_missing_files_are_refused() {
        let dir = tempfile::tempdir().unwrap();
        let folder = dir.path().join("shots.png");
        std::fs::create_dir(&folder).unwrap();
        assert!(matches!(
            canonical_file(folder).await,
            Err(AppError::BadRequest(_))
        ));
        assert!(matches!(
            canonical_file(dir.path().join("gone.png")).await,
            Err(AppError::NotFound(_))
        ));
    }

    async fn pool_with_message(content: &str, message_type: &str) -> (SqlitePool, i64) {
        let pool = SqlitePool::connect("sqlite::memory:").await.unwrap();
        crate::shared::migrate::run_migrations(
            &crate::shared::migrate::MigrationContext::pool_only(&pool),
        )
        .await
        .unwrap();
        let project_id: i64 = sqlx::query_scalar(
            "INSERT INTO projects (name, path) VALUES ('p', '/tmp/p') RETURNING id",
        )
        .fetch_one(&pool)
        .await
        .unwrap();
        let feature_id: i64 = sqlx::query_scalar(
            "INSERT INTO features (project_id, title, status) VALUES (?, 'f', 'active') RETURNING id",
        )
        .bind(project_id)
        .fetch_one(&pool)
        .await
        .unwrap();
        let session_id: i64 = sqlx::query_scalar(
            "INSERT INTO agent_sessions (feature_id, agent_type) VALUES (?, 'claude') RETURNING id",
        )
        .bind(feature_id)
        .fetch_one(&pool)
        .await
        .unwrap();
        sqlx::query(
            "INSERT INTO agent_messages (session_id, role, content, message_type)
             VALUES (?, 'assistant', ?, ?)",
        )
        .bind(session_id)
        .bind(content)
        .bind(message_type)
        .execute(&pool)
        .await
        .unwrap();
        (pool, feature_id)
    }

    async fn shows(content: &str, message_type: &str, spellings: &[&str]) -> bool {
        let (pool, feature_id) = pool_with_message(content, message_type).await;
        transcript_shows(&pool, feature_id, spellings)
            .await
            .unwrap()
    }

    #[tokio::test]
    async fn every_markdown_image_spelling_counts_as_shown() {
        for content in [
            "Done: ![after](/tmp/qa/a.png)",
            "Done: ![after](/tmp/qa/a.png \"After the fix\")",
            "Done: ![after](</tmp/qa/a.png>)",
            "Done: <img src=\"/tmp/qa/a.png\" width=\"400\">",
        ] {
            assert!(
                shows(content, "text", &["/tmp/qa/a.png"]).await,
                "{content}"
            );
        }
        // The parser hands the renderer an encoded spelling of this one.
        assert!(
            shows(
                "![écran](</tmp/qa/mon écran.png>)",
                "text",
                &["/tmp/qa/mon%20%C3%A9cran.png", "/tmp/qa/mon écran.png"]
            )
            .await
        );
    }

    #[tokio::test]
    async fn a_substring_or_a_prose_mention_is_not_shown() {
        let content = "Saved to /tmp/qa/a.png. ![b](/tmp/qa/data.png)";
        for src in ["/tmp/qa/a.png", "a.png", "/qa/data.png", "data.png"] {
            assert!(!shows(content, "text", &[src]).await, "{src}");
        }
    }

    #[tokio::test]
    async fn only_the_features_own_chat_messages_count() {
        let (pool, feature_id) = pool_with_message("![a](/tmp/a.png)", "text").await;
        assert!(!transcript_shows(&pool, feature_id + 1, &["/tmp/a.png"])
            .await
            .unwrap());
        assert!(!shows("![a](/tmp/a.png)", "tool_result", &["/tmp/a.png"]).await);
    }
}
