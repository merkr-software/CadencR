//! Helpers for tests that drive `worktree::ensure_worktree` directly. Lives
//! under `common/` so the validation tests (`feature_create_test.rs`) and the
//! provisioning tests (`feature_worktree_test.rs`) can share fixtures without
//! either file blowing past the 400-line cap.

#![allow(dead_code)]

use std::path::Path;
use std::sync::Mutex;

use axum::extract::ws::Message;
use cadencr_service::domain::workflow::ws_sender::WsSender;
use sqlx::sqlite::SqlitePoolOptions;
use sqlx::SqlitePool;
use tokio::sync::mpsc;

use super::git_in;

/// In-memory DB with the schema bits `ensure_worktree` reads from.
pub async fn worktree_pool() -> SqlitePool {
    let pool = SqlitePoolOptions::new()
        .max_connections(1)
        .connect("sqlite::memory:")
        .await
        .unwrap();
    sqlx::query("CREATE TABLE projects (id INTEGER PRIMARY KEY, name TEXT, path TEXT)")
        .execute(&pool)
        .await
        .unwrap();
    sqlx::query(
        "CREATE TABLE features (id INTEGER PRIMARY KEY, project_id INTEGER NOT NULL, title TEXT)",
    )
    .execute(&pool)
    .await
    .unwrap();
    sqlx::query(
        "CREATE TABLE feature_settings (feature_id INTEGER, key TEXT, value TEXT, \
         PRIMARY KEY(feature_id, key))",
    )
    .execute(&pool)
    .await
    .unwrap();
    sqlx::query(
        "CREATE TABLE project_settings (project_id INTEGER, key TEXT, value TEXT, \
         PRIMARY KEY(project_id, key))",
    )
    .execute(&pool)
    .await
    .unwrap();
    pool
}

pub async fn set_feature_setting(pool: &SqlitePool, feature_id: i64, key: &str, value: &str) {
    sqlx::query(
        "INSERT OR REPLACE INTO feature_settings (feature_id, key, value) VALUES (?, ?, ?)",
    )
    .bind(feature_id)
    .bind(key)
    .bind(value)
    .execute(pool)
    .await
    .unwrap();
}

pub async fn insert_project_and_feature(pool: &SqlitePool, name: &str, project_path: &Path) {
    sqlx::query("INSERT INTO projects (id, name, path) VALUES (1, ?, ?)")
        .bind(name)
        .bind(project_path.to_string_lossy().to_string())
        .execute(pool)
        .await
        .unwrap();
    sqlx::query("INSERT INTO features (id, project_id, title) VALUES (1, 1, 'feat')")
        .execute(pool)
        .await
        .unwrap();
}

pub fn fresh_ws_sender() -> (WsSender, mpsc::UnboundedReceiver<Message>) {
    let (tx, rx) = mpsc::unbounded_channel::<Message>();
    (tx, rx)
}

/// Initialize a hermetic git repo with one empty commit on `main`.
pub fn init_git_repo(dir: &Path) {
    git_in(dir, &["init", "-q", "-b", "main"]);
    git_in(dir, &["config", "user.email", "t@example.com"]);
    git_in(dir, &["config", "user.name", "T"]);
    git_in(dir, &["config", "commit.gpgsign", "false"]);
    git_in(dir, &["config", "tag.gpgsign", "false"]);
    git_in(dir, &["commit", "--allow-empty", "-q", "-m", "init"]);
}

/// Process-global lock for tests that mutate `$HOME` to redirect the
/// Cadencr worktrees root into a tempdir. cargo test runs tokio tests in
/// parallel; without this lock two of them would race and one's `$HOME`
/// pop would leak into the other.
static HOME_LOCK: Mutex<()> = Mutex::new(());

const XDG_VARS: &[&str] = &["XDG_DATA_HOME", "XDG_CONFIG_HOME", "XDG_CACHE_HOME"];

/// Saves/restores `$HOME` plus the XDG roots. On Linux `app_paths::data_dir()`
/// honours `$XDG_DATA_HOME` first, so we have to clear it as well — otherwise
/// the developer's real XDG dir would leak into the test and the assertions
/// pinned to the tempdir would fail.
pub struct HomeGuard {
    saved: Vec<(&'static str, Option<std::ffi::OsString>)>,
    _lock: std::sync::MutexGuard<'static, ()>,
}

impl HomeGuard {
    pub fn set(new_home: &Path) -> Self {
        let lock = HOME_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        let mut saved: Vec<(&'static str, Option<std::ffi::OsString>)> =
            Vec::with_capacity(1 + XDG_VARS.len());
        saved.push(("HOME", std::env::var_os("HOME")));
        for key in XDG_VARS {
            saved.push((key, std::env::var_os(key)));
            std::env::remove_var(key);
        }
        std::env::set_var("HOME", new_home);
        Self { saved, _lock: lock }
    }
}

impl Drop for HomeGuard {
    fn drop(&mut self) {
        for (key, value) in &self.saved {
            match value {
                Some(v) => std::env::set_var(key, v),
                None => std::env::remove_var(key),
            }
        }
    }
}

/// Capture `git rev-parse HEAD` in `dir`. Used by tests to compare worktree
/// commits to base-branch commits.
pub fn rev_parse_head(dir: &Path) -> String {
    let out = std::process::Command::new("git")
        .args(["rev-parse", "HEAD"])
        .current_dir(dir)
        .output()
        .expect("git spawn");
    assert!(
        out.status.success(),
        "git rev-parse HEAD failed: {}",
        String::from_utf8_lossy(&out.stderr)
    );
    String::from_utf8(out.stdout)
        .expect("non-utf8 sha")
        .trim()
        .to_string()
}

/// Best-effort cleanup so test-created worktrees don't pile up under
/// `$HOME` between runs (the `HomeGuard` tempdir is dropped, but the
/// project-side bookkeeping stays valid until `git worktree remove`).
pub fn worktree_remove(project: &Path, wt_path: &Path) {
    let _ = std::process::Command::new("git")
        .args(["worktree", "remove", "--force", wt_path.to_str().unwrap()])
        .current_dir(project)
        .output();
}
