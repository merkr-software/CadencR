//! Run the project's `setup_worktree` commands inside a freshly-created
//! worktree, streaming each line to the WS so the user sees progress live.

use std::path::PathBuf;
use std::sync::Arc;

use sqlx::SqlitePool;
use tokio::io::{AsyncBufReadExt, BufReader};

use crate::domain::workflow::ws_sender::WsSender;

use super::db::set_setting;
use super::envelope::send_envelope;

/// Persist setup error state and notify the frontend via WebSocket.
async fn report_setup_error(
    write_pool: &SqlitePool,
    feature_id: i64,
    log_lines: &tokio::sync::Mutex<Vec<String>>,
    ws_sender: &WsSender,
    error: &str,
) {
    let _ = set_setting(write_pool, feature_id, "worktree_setup_step", "setup_error").await;
    let _ = set_setting(write_pool, feature_id, "worktree_setup_error", error).await;
    let log = log_lines.lock().await.join("\n");
    let _ = set_setting(write_pool, feature_id, "worktree_setup_log", &log).await;
    send_envelope(
        ws_sender,
        "workflow",
        "worktree.setup_error",
        serde_json::json!({
            "feature_id": feature_id,
            "error": error,
            "output": log,
        }),
    );
}

/// Resolve the project's `setup_worktree` commands for a feature.
///
/// `setup_worktree` is a project setting and now lives in the JSON settings store
/// (the legacy `project_settings` row is kept only as a backup). Returns `None`
/// when no non-empty setup script is configured.
async fn resolve_setup_commands(
    read_pool: &SqlitePool,
    feature_id: i64,
) -> Result<Option<String>, String> {
    let project_id = sqlx::query_as::<_, (i64,)>("SELECT project_id FROM features WHERE id = ?")
        .bind(feature_id)
        .fetch_optional(read_pool)
        .await
        .map_err(|e| format!("Failed to look up project for feature: {e}"))?
        .map(|r| r.0)
        .ok_or_else(|| format!("Feature {feature_id} not found"))?;

    let value = crate::domain::settings_store::project_get(read_pool, project_id, "setup_worktree")
        .await
        .map_err(|e| format!("Failed to query setup commands: {e}"))?
        .filter(|v| !v.trim().is_empty());
    Ok(value)
}

/// Run setup commands in the worktree (fire-and-forget via tokio::spawn).
pub async fn run_setup_commands(
    read_pool: SqlitePool,
    write_pool: SqlitePool,
    feature_id: i64,
    worktree_path: PathBuf,
    ws_sender: WsSender,
) {
    // 1. Resolve setup commands from the project's JSON settings.
    let commands_str = match resolve_setup_commands(&read_pool, feature_id).await {
        Ok(Some(commands)) => commands,
        Ok(None) => {
            // No setup commands
            let _ = set_setting(&write_pool, feature_id, "worktree_setup_step", "ready").await;
            let _ = set_setting(&write_pool, feature_id, "worktree_setup_error", "").await;
            let _ = set_setting(&write_pool, feature_id, "worktree_setup_log", "").await;
            send_envelope(
                &ws_sender,
                "workflow",
                "worktree.ready",
                serde_json::json!({
                    "feature_id": feature_id,
                }),
            );
            return;
        }
        Err(error) => {
            let _ = set_setting(
                &write_pool,
                feature_id,
                "worktree_setup_step",
                "setup_error",
            )
            .await;
            let _ = set_setting(&write_pool, feature_id, "worktree_setup_error", &error).await;
            send_envelope(
                &ws_sender,
                "workflow",
                "worktree.setup_error",
                serde_json::json!({
                    "feature_id": feature_id,
                    "error": error,
                }),
            );
            return;
        }
    };

    let _ = set_setting(
        &write_pool,
        feature_id,
        "worktree_setup_step",
        "setup_running",
    )
    .await;
    let _ = set_setting(&write_pool, feature_id, "worktree_setup_error", "").await;
    let _ = set_setting(&write_pool, feature_id, "worktree_setup_log", "").await;

    // 2. Send setup_running
    send_envelope(
        &ws_sender,
        "workflow",
        "worktree.setup_running",
        serde_json::json!({
            "feature_id": feature_id,
        }),
    );

    // 4. Parse and run each command, accumulating output log
    let commands: Vec<&str> = commands_str
        .lines()
        .filter(|l| !l.trim().is_empty())
        .collect();
    let log_lines = Arc::new(tokio::sync::Mutex::new(Vec::<String>::new()));
    for cmd in commands {
        if !run_one_command(
            &write_pool,
            feature_id,
            &worktree_path,
            &ws_sender,
            cmd,
            &log_lines,
        )
        .await
        {
            return;
        }
    }

    // 6. Success — persist log and mark ready
    let log = log_lines.lock().await.join("\n");
    let _ = set_setting(&write_pool, feature_id, "worktree_setup_log", &log).await;
    let _ = set_setting(&write_pool, feature_id, "worktree_setup_step", "ready").await;
    let _ = set_setting(&write_pool, feature_id, "worktree_setup_error", "").await;
    send_envelope(
        &ws_sender,
        "workflow",
        "worktree.ready",
        serde_json::json!({
            "feature_id": feature_id,
        }),
    );
}

/// Spawn `cmd` via the user's shell inside `worktree_path`, streaming each
/// stdout/stderr line to the WS *and* into `log_lines` for the final log
/// payload. Returns `true` on success and `false` after reporting the
/// failure (caller should bail out so it doesn't keep running follow-ups).
async fn run_one_command(
    write_pool: &SqlitePool,
    feature_id: i64,
    worktree_path: &std::path::Path,
    ws_sender: &WsSender,
    cmd: &str,
    log_lines: &Arc<tokio::sync::Mutex<Vec<String>>>,
) -> bool {
    // Log the command being run
    let cmd_line = format!("$ {cmd}");
    log_lines.lock().await.push(cmd_line.clone());
    send_envelope(
        ws_sender,
        "workflow",
        "worktree.setup_output",
        serde_json::json!({
            "feature_id": feature_id,
            "line": cmd_line,
        }),
    );

    let mut command = crate::shared::user_shell::command(cmd, worktree_path);
    let mut child = match command
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .spawn()
    {
        Ok(c) => c,
        Err(e) => {
            let error = format!("Failed to spawn command `{cmd}`: {e}");
            report_setup_error(write_pool, feature_id, log_lines, ws_sender, &error).await;
            return false;
        }
    };

    let stdout_handle = spawn_stream_reader(child.stdout.take(), feature_id, ws_sender, log_lines);
    let stderr_handle = spawn_stream_reader(child.stderr.take(), feature_id, ws_sender, log_lines);

    if let Some(h) = stdout_handle {
        let _ = h.await;
    }
    if let Some(h) = stderr_handle {
        let _ = h.await;
    }

    match child.wait().await {
        Ok(status) if status.success() => {
            log_lines.lock().await.push(String::new());
            true
        }
        Ok(status) => {
            let error = format!("Command `{cmd}` exited with status {status}");
            report_setup_error(write_pool, feature_id, log_lines, ws_sender, &error).await;
            false
        }
        Err(e) => {
            let error = format!("Failed to wait on command `{cmd}`: {e}");
            report_setup_error(write_pool, feature_id, log_lines, ws_sender, &error).await;
            false
        }
    }
}

/// Spawn a tokio task that drains a child's stdout/stderr line-by-line,
/// pushes each line into `log_lines` and broadcasts a `worktree.setup_output`
/// envelope. Returns `None` when the child didn't expose the requested
/// stream (caller skips the `await` in that case).
fn spawn_stream_reader<R>(
    stream: Option<R>,
    feature_id: i64,
    ws_sender: &WsSender,
    log_lines: &Arc<tokio::sync::Mutex<Vec<String>>>,
) -> Option<tokio::task::JoinHandle<()>>
where
    R: tokio::io::AsyncRead + Send + Unpin + 'static,
{
    let stream = stream?;
    let ws = ws_sender.clone();
    let log = Arc::clone(log_lines);
    Some(tokio::spawn(async move {
        let reader = BufReader::new(stream);
        let mut lines = reader.lines();
        while let Ok(Some(line)) = lines.next_line().await {
            log.lock().await.push(line.clone());
            send_envelope(
                &ws,
                "workflow",
                "worktree.setup_output",
                serde_json::json!({
                    "feature_id": feature_id,
                    "line": line,
                }),
            );
        }
    }))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::shared::test_env::EnvVarGuard;
    use sqlx::sqlite::SqlitePoolOptions;
    use std::os::unix::fs::PermissionsExt;

    async fn setup_pool(command: &str) -> SqlitePool {
        let pool = SqlitePoolOptions::new()
            .connect(":memory:")
            .await
            .expect("pool");
        sqlx::query("CREATE TABLE features (id INTEGER PRIMARY KEY, project_id INTEGER NOT NULL)")
            .execute(&pool)
            .await
            .expect("features table");
        // `projects` is needed so the settings store can resolve the project's
        // JSON file path. A unique name keeps this test's file from colliding
        // with other tests sharing the process-wide settings dir fallback.
        sqlx::query("CREATE TABLE projects (id INTEGER PRIMARY KEY, name TEXT NOT NULL, path TEXT NOT NULL DEFAULT '')")
            .execute(&pool)
            .await
            .expect("projects table");
        sqlx::query(
            "CREATE TABLE feature_settings (feature_id INTEGER, key TEXT, value TEXT, PRIMARY KEY(feature_id, key))",
        )
        .execute(&pool)
        .await
        .expect("feature_settings table");
        sqlx::query("INSERT INTO projects (id, name) VALUES (7, 'worktree-setup-test-project')")
            .execute(&pool)
            .await
            .expect("project row");
        sqlx::query("INSERT INTO features (id, project_id) VALUES (1, 7)")
            .execute(&pool)
            .await
            .expect("feature row");
        // Seed the setup script through the JSON settings store (the same path
        // production reads from), not the legacy `project_settings` table.
        crate::domain::settings_store::project_set(&pool, 7, "setup_worktree", command)
            .await
            .expect("setup setting");
        pool
    }

    #[tokio::test]
    async fn run_setup_commands_does_not_start_interactive_shell_without_pty() {
        let _guard = crate::shared::test_env::async_env_lock().lock().await;
        let temp = tempfile::tempdir().expect("tempdir");
        let shell = temp.path().join("fake-shell.sh");
        std::fs::write(
            &shell,
            "#!/bin/sh\nfor arg in \"$@\"; do\n  if [ \"$arg\" = \"-i\" ]; then\n    echo 'interactive shell without pty' >&2\n    exit 42\n  fi\ndone\nif [ \"$1\" = \"-l\" ]; then shift; fi\nexec /bin/sh \"$@\"\n",
        )
        .expect("write fake shell");
        let mut perms = std::fs::metadata(&shell).expect("metadata").permissions();
        perms.set_mode(0o755);
        std::fs::set_permissions(&shell, perms).expect("chmod");

        let _shell_guard = EnvVarGuard::set("SHELL", shell.to_string_lossy().as_ref());
        let worktree = temp.path().join("worktree");
        std::fs::create_dir(&worktree).expect("worktree dir");
        let pool = setup_pool("printf ok > setup.out").await;
        let (tx, _rx) = tokio::sync::mpsc::unbounded_channel();

        run_setup_commands(pool.clone(), pool.clone(), 1, worktree.clone(), tx).await;

        let step = super::super::db::get_setting(&pool, 1, "worktree_setup_step").await;
        assert_eq!(step.as_deref(), Some("ready"));
        assert_eq!(
            std::fs::read_to_string(worktree.join("setup.out")).expect("setup output"),
            "ok"
        );
    }
}
