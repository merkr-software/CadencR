//! Shared integration-test harness. Booting an axum app + sqlite repo + tempfile
//! git tree is non-trivial and was duplicated across each test file; this module
//! is the single home for that scaffolding so individual test files can stay
//! focused on assertions.
//!
//! Each test binary that includes this module sees an independently compiled
//! copy, so dead-code warnings fire whenever a given file doesn't reference
//! every helper. The `#[allow(dead_code)]` on the items below is intentional —
//! removing it would force every test file to import every helper.

#![allow(dead_code)]

pub mod worktree;

use std::process::Command;

use reqwest::header::{HeaderMap, HeaderValue};
use reqwest::Client;
use sqlx::sqlite::SqlitePoolOptions;
use sqlx::SqlitePool;
use tempfile::TempDir;
use tokio::net::TcpListener;

use cadencr_service::api;
use cadencr_service::api::middleware::AUTH_HEADER;
use cadencr_service::app_state::AppState;

pub const TEST_AUTH_TOKEN: &str = "test-token";

/// Full RFC 6455 header set; axum's extractor rejects the request before
/// our handler runs if any are missing.
pub fn apply_ws_upgrade_headers(
    req: reqwest::RequestBuilder,
    origin: &str,
) -> reqwest::RequestBuilder {
    req.header("Upgrade", "websocket")
        .header("Connection", "Upgrade")
        .header("Sec-WebSocket-Version", "13")
        .header("Sec-WebSocket-Key", "dGhlIHNhbXBsZSBub25jZQ==")
        .header("Origin", origin)
}

/// Run a `git` command in `dir` with hermetic env (no system/global config,
/// no GPG signing). Surfaces stderr on failure — never swallow git errors.
pub fn git_in(dir: &std::path::Path, args: &[&str]) {
    let output = Command::new("git")
        .args(args)
        .current_dir(dir)
        .env("GIT_AUTHOR_NAME", "Test")
        .env("GIT_AUTHOR_EMAIL", "test@test.com")
        .env("GIT_COMMITTER_NAME", "Test")
        .env("GIT_COMMITTER_EMAIL", "test@test.com")
        .env("GIT_CONFIG_NOSYSTEM", "1")
        .env("HOME", dir)
        .output()
        .expect("git command failed to spawn");
    assert!(
        output.status.success(),
        "git {} failed (exit {}): {}",
        args.join(" "),
        output.status,
        String::from_utf8_lossy(&output.stderr),
    );
}

/// Capture `git`'s stdout for inspection in assertions. Same hermetic env as
/// [`git_in`].
pub fn git_capture(dir: &std::path::Path, args: &[&str]) -> String {
    let output = Command::new("git")
        .args(args)
        .current_dir(dir)
        .env("GIT_CONFIG_NOSYSTEM", "1")
        .env("HOME", dir)
        .output()
        .expect("git spawn");
    assert!(
        output.status.success(),
        "git {} failed (exit {}): {}",
        args.join(" "),
        output.status,
        String::from_utf8_lossy(&output.stderr),
    );
    String::from_utf8(output.stdout).expect("non-utf8 git output")
}

/// Create a temp git repo with an initial commit on `main` and a
/// `feature/test-branch` checked out at HEAD with a single tracked file.
pub fn create_test_repo(dir: &std::path::Path) {
    git_in(dir, &["init", "-b", "main"]);
    git_in(dir, &["config", "user.email", "test@test.com"]);
    git_in(dir, &["config", "user.name", "Test"]);
    git_in(dir, &["config", "commit.gpgsign", "false"]);
    git_in(dir, &["config", "tag.gpgsign", "false"]);
    std::fs::write(dir.join("README.md"), "# Test\n").unwrap();
    git_in(dir, &["add", "."]);
    git_in(dir, &["commit", "-m", "initial commit"]);
    git_in(dir, &["checkout", "-b", "feature/test-branch"]);
    std::fs::write(dir.join("test.txt"), "hello world\n").unwrap();
    git_in(dir, &["add", "."]);
    git_in(dir, &["commit", "-m", "add test file"]);
}

pub async fn setup_test_db(db_path: &str, repo_path: &str) -> SqlitePool {
    let pool = SqlitePoolOptions::new()
        .max_connections(1)
        .connect(&format!("sqlite:{db_path}?mode=rwc"))
        .await
        .unwrap();

    create_schema(&pool).await;
    seed_basic_rows(&pool, repo_path).await;
    pool
}

async fn create_schema(pool: &SqlitePool) {
    sqlx::query(
        r#"CREATE TABLE projects (
        id INTEGER PRIMARY KEY, name TEXT, path TEXT, branch_prefix TEXT DEFAULT 'feature/',
        model_session TEXT,
        agent_runtime_session TEXT,
        created_at TEXT DEFAULT (datetime('now'))
    )"#,
    )
    .execute(pool)
    .await
    .unwrap();
    sqlx::query(
        r#"CREATE TABLE features (
        id INTEGER PRIMARY KEY, project_id INTEGER NOT NULL, title TEXT,
        status TEXT NOT NULL DEFAULT 'active',
        type TEXT NOT NULL DEFAULT 'ws-session',
        label TEXT,
        model_session TEXT,
        agent_runtime_session TEXT,
        is_pinned INTEGER NOT NULL DEFAULT 0,
        created_at TEXT DEFAULT (datetime('now'))
    )"#,
    )
    .execute(pool)
    .await
    .unwrap();
    sqlx::query("CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT)")
        .execute(pool)
        .await
        .unwrap();
    sqlx::query("CREATE TABLE feature_settings (feature_id INTEGER, key TEXT, value TEXT, PRIMARY KEY(feature_id, key))")
        .execute(pool).await.unwrap();
    sqlx::query("CREATE TABLE project_settings (project_id INTEGER, key TEXT, value TEXT, PRIMARY KEY(project_id, key))")
        .execute(pool).await.unwrap();

    sqlx::query(
        r#"CREATE TABLE agent_sessions (
        id INTEGER PRIMARY KEY AUTOINCREMENT, feature_id INTEGER NOT NULL,
        agent_type TEXT NOT NULL DEFAULT 'session', status TEXT NOT NULL DEFAULT 'idle',
        runtime_provider TEXT, runtime_session_id TEXT, claude_session_id TEXT,
        model TEXT, permission_mode TEXT, thinking_effort TEXT,
        has_file_changes INTEGER NOT NULL DEFAULT 0,
        input_tokens INTEGER NOT NULL DEFAULT 0, output_tokens INTEGER NOT NULL DEFAULT 0,
        context_window INTEGER NOT NULL DEFAULT 200000, started_at TEXT, ended_at TEXT
    )"#,
    )
    .execute(pool)
    .await
    .unwrap();
    sqlx::query(
        r#"CREATE TABLE agent_session_links (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        source_session_id INTEGER NOT NULL,
        target_session_id INTEGER NOT NULL,
        link_type TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
    )"#,
    )
    .execute(pool)
    .await
    .unwrap();
}

async fn seed_basic_rows(pool: &SqlitePool, repo_path: &str) {
    sqlx::query("INSERT INTO projects (id, name, path) VALUES (1, 'test-project', ?)")
        .bind(repo_path)
        .execute(pool)
        .await
        .unwrap();
    sqlx::query("INSERT INTO features (id, project_id, title, type) VALUES (1, 1, 'Test Feature', 'ws-session')")
        .execute(pool).await.unwrap();
    // Worktree settings point at the repo itself so feature_id=1 resolves to
    // the on-disk repo for git endpoints under the typical path.
    sqlx::query(
        "INSERT INTO feature_settings (feature_id, key, value) VALUES (1, 'worktree_path', ?)",
    )
    .bind(repo_path)
    .execute(pool)
    .await
    .unwrap();
    sqlx::query("INSERT INTO feature_settings (feature_id, key, value) VALUES (1, 'worktree_branch', 'feature/test-branch')")
        .execute(pool).await.unwrap();
    sqlx::query("INSERT INTO feature_settings (feature_id, key, value) VALUES (1, 'worktree_original_branch', 'main')")
        .execute(pool).await.unwrap();
}

pub struct TestServer {
    pub base_url: String,
    pub client: Client,
    pub tmp_dir: TempDir,
    pub pool: SqlitePool,
}

impl TestServer {
    pub fn repo_path(&self) -> std::path::PathBuf {
        self.tmp_dir.path().join("repo")
    }
}

/// Stage `path` (creating `<repo>/<path>` with `contents` first if requested).
pub fn stage_file(repo: &std::path::Path, path: &str, contents: Option<&str>) {
    if let Some(c) = contents {
        std::fs::write(repo.join(path), c).unwrap();
    }
    git_in(repo, &["add", "--", path]);
}

/// Write `path` in `repo` without staging it.
pub fn write_unstaged(repo: &std::path::Path, path: &str, contents: &str) {
    std::fs::write(repo.join(path), contents).unwrap();
}

/// Find a file row by its `path` field in a JSON array body.
pub fn find_file_row<'a>(body: &'a serde_json::Value, name: &str) -> Option<&'a serde_json::Value> {
    body.as_array()?
        .iter()
        .find(|row| row["path"].as_str() == Some(name))
}

pub async fn start_test_server() -> TestServer {
    let tmp_dir = TempDir::new().unwrap();
    let repo_path = tmp_dir.path().join("repo");
    std::fs::create_dir_all(&repo_path).unwrap();
    create_test_repo(&repo_path);

    let db_path = tmp_dir.path().join("test.db");
    let db_path_str = db_path.to_string_lossy().to_string();
    let repo_path_str = repo_path.to_string_lossy().to_string();

    let pool = setup_test_db(&db_path_str, &repo_path_str).await;

    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = listener.local_addr().unwrap().port();

    let mut state = AppState::with_pool(pool.clone());
    state.auth_token = TEST_AUTH_TOKEN.to_string();
    state.port = port;

    let app = api::build_router(state).layer(tower_http::cors::CorsLayer::permissive());

    tokio::spawn(async move {
        axum::serve(
            listener,
            app.into_make_service_with_connect_info::<std::net::SocketAddr>(),
        )
        .await
        .unwrap();
    });

    let mut default_headers = HeaderMap::new();
    default_headers.insert(AUTH_HEADER, HeaderValue::from_static(TEST_AUTH_TOKEN));
    let client = Client::builder()
        .default_headers(default_headers)
        .build()
        .expect("reqwest client");

    TestServer {
        base_url: format!("http://127.0.0.1:{port}"),
        client,
        tmp_dir,
        pool,
    }
}
