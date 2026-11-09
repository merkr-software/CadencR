//! Run the project's `setup_worktree` commands inside a freshly-created
//! worktree, streaming each line to the WS so the user sees progress live.

use std::path::PathBuf;

use sqlx::SqlitePool;

use crate::domain::workflow::ws_sender::WsSender;

use super::setup_events::{send_ready, send_running};
use super::setup_finish::{finish_error, finish_ready};
use super::setup_output::collect_setup_output;
use super::setup_state::{persist_setup_state, SetupState};
use super::WorktreeSetupRegistry;

/// Resolve the project's JSON `setup_worktree` setting, treating blank as absent.
pub(super) async fn resolve_setup_commands(
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
    setup_runs: WorktreeSetupRegistry,
    feature_id: i64,
    worktree_path: PathBuf,
    ws_sender: WsSender,
) {
    let Some(permit) = setup_runs.try_acquire(feature_id) else {
        return;
    };
    let commands_str = match resolve_setup_commands(&read_pool, feature_id).await {
        Ok(Some(commands)) => commands,
        Ok(None) => {
            if let Err(error) =
                persist_setup_state(&write_pool, feature_id, SetupState::Ready { log: "" }).await
            {
                finish_error(
                    &write_pool,
                    feature_id,
                    &ws_sender,
                    Some(permit),
                    &error,
                    "",
                    None,
                )
                .await;
                return;
            }
            permit.finish(|| send_ready(feature_id, &ws_sender, ""));
            return;
        }
        Err(error) => {
            finish_error(
                &write_pool,
                feature_id,
                &ws_sender,
                Some(permit),
                &error,
                "",
                None,
            )
            .await;
            return;
        }
    };

    if let Err(error) =
        persist_setup_state(&write_pool, feature_id, SetupState::Running { log: "" }).await
    {
        finish_error(
            &write_pool,
            feature_id,
            &ws_sender,
            Some(permit),
            &error,
            "",
            None,
        )
        .await;
        return;
    }

    send_running(feature_id, &ws_sender);

    run_resolved_setup_commands(
        &write_pool,
        permit,
        feature_id,
        worktree_path,
        &ws_sender,
        &commands_str,
    )
    .await;
}

async fn run_resolved_setup_commands(
    write_pool: &SqlitePool,
    permit: crate::domain::features::run_registry::FeatureRunPermit,
    feature_id: i64,
    worktree_path: PathBuf,
    ws_sender: &WsSender,
    commands_str: &str,
) {
    let commands = commands_str
        .lines()
        .filter(|l| !l.trim().is_empty())
        .collect::<Vec<_>>();

    let script = build_setup_script(&commands);
    let (output_tx, output_rx) = crate::shared::terminal_shell::terminal_output_channel();
    let run = crate::shared::terminal_shell::run_terminal_shell_script(
        &script,
        &worktree_path,
        output_tx,
    );
    let collect = collect_setup_output(write_pool, feature_id, ws_sender, output_rx);
    let (result, output) = tokio::join!(run, collect);
    match result {
        Ok(exit) if exit.success() => {}
        Ok(exit) => {
            let error = format!(
                "Setup script exited with status {} (cwd: {}, PATH: {})",
                exit.exit_code,
                worktree_path.display(),
                std::env::var("PATH").unwrap_or_else(|_| "<unset>".to_string())
            );
            finish_error(
                write_pool,
                feature_id,
                ws_sender,
                Some(permit),
                &error,
                &output.log,
                output.persistence_error.as_deref(),
            )
            .await;
            return;
        }
        Err(error) => {
            finish_error(
                write_pool,
                feature_id,
                ws_sender,
                Some(permit),
                &error,
                &output.log,
                output.persistence_error.as_deref(),
            )
            .await;
            return;
        }
    }

    finish_ready(
        write_pool,
        feature_id,
        ws_sender,
        permit,
        &output.log,
        output.persistence_error.as_deref(),
    )
    .await;
}

fn build_setup_script(commands: &[&str]) -> String {
    let mut script = String::from("set -e\n");
    for command in commands {
        script.push_str("printf '%s\\n' ");
        script.push_str(&cli_discovery::shell_quote(std::ffi::OsStr::new(&format!(
            "$ {command}"
        ))));
        script.push('\n');
        script.push_str(command);
        script.push('\n');
    }
    script
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::shared::test_env::EnvVarGuard;
    use axum::extract::ws::Message;
    use sqlx::sqlite::SqlitePoolOptions;
    use std::os::unix::fs::PermissionsExt;

    #[test]
    fn build_setup_script_prints_commands_with_shell_quoting() {
        let script = build_setup_script(&["echo it's ok"]);
        assert!(script.contains("printf '%s\\n' '$ echo it'\\''s ok'"));
        assert!(script.contains("\necho it's ok\n"));
    }

    async fn setup_pool(command: &str) -> SqlitePool {
        let pool = SqlitePoolOptions::new()
            .connect(":memory:")
            .await
            .expect("pool");
        sqlx::query("CREATE TABLE features (id INTEGER PRIMARY KEY, project_id INTEGER NOT NULL)")
            .execute(&pool)
            .await
            .expect("features table");
        // The settings store resolves the JSON file from this unique project name.
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
        // Seed the same JSON settings store production reads.
        crate::domain::settings_store::project_set(&pool, 7, "setup_worktree", command)
            .await
            .expect("setup setting");
        pool
    }

    #[tokio::test]
    async fn run_setup_commands_uses_terminal_like_shell_setup() {
        let _guard = crate::shared::test_env::async_env_lock().lock().await;
        let temp = tempfile::tempdir().expect("tempdir");
        // Named like a POSIX shell so the script also attaches the terminal.
        let shell = temp.path().join("zsh");
        std::fs::write(
            &shell,
            r#"#!/bin/sh
interactive=0
while [ "$#" -gt 0 ]; do
  case "$1" in
    -l) shift ;;
    -i) interactive=1; shift ;;
    -c) shift; script="$1"; shift; break ;;
    *) break ;;
  esac
done

# Startup files run for `-i` although stdin is never a terminal.
if [ "$interactive" = "1" ] && [ ! -t 0 ]; then
  init='nvm() { echo "nvm initialized"; PATH="$(pwd)/bin:$PATH"; export PATH; };'
  exec /bin/sh -c "$init $script"
fi

exec /bin/sh -c "$script"
"#,
        )
        .expect("write fake shell");
        let mut perms = std::fs::metadata(&shell).expect("metadata").permissions();
        perms.set_mode(0o755);
        std::fs::set_permissions(&shell, perms).expect("chmod");
        let _shell_guard = EnvVarGuard::set("SHELL", shell.to_string_lossy().as_ref());
        let worktree = temp.path().join("worktree");
        std::fs::create_dir(&worktree).expect("worktree dir");
        let bin = worktree.join("bin");
        std::fs::create_dir(&bin).expect("bin dir");
        let pnpm = bin.join("pnpm");
        std::fs::write(&pnpm, "#!/bin/sh\nprintf 'pnpm ok' > setup.out\n")
            .expect("write fake pnpm");
        let mut pnpm_perms = std::fs::metadata(&pnpm)
            .expect("pnpm metadata")
            .permissions();
        pnpm_perms.set_mode(0o755);
        std::fs::set_permissions(&pnpm, pnpm_perms).expect("chmod pnpm");
        let pool = setup_pool("nvm use\npnpm install").await;
        let (tx, _rx) = tokio::sync::mpsc::unbounded_channel();
        run_setup_commands(
            pool.clone(),
            pool.clone(),
            WorktreeSetupRegistry::new(),
            1,
            worktree.clone(),
            tx,
        )
        .await;
        let step = super::super::db::get_setting(&pool, 1, "worktree_setup_step").await;
        assert_eq!(step.as_deref(), Some("ready"));
        assert_eq!(
            std::fs::read_to_string(worktree.join("setup.out")).expect("setup output"),
            "pnpm ok"
        );
    }

    #[tokio::test]
    async fn no_setup_commands_finish_ready_without_entering_running_state() {
        let pool = setup_pool("").await;
        let temp = tempfile::tempdir().unwrap();
        let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel();
        run_setup_commands(
            pool.clone(),
            pool.clone(),
            WorktreeSetupRegistry::new(),
            1,
            temp.path().to_path_buf(),
            tx,
        )
        .await;
        let message = rx.try_recv().unwrap();
        let Message::Text(text) = message else {
            panic!("expected ready text envelope");
        };
        let envelope: serde_json::Value = serde_json::from_str(&text).unwrap();
        assert_eq!(envelope["action"], "worktree.ready");
        assert!(rx.try_recv().is_err());
        assert_eq!(
            super::super::db::get_setting(&pool, 1, "worktree_setup_step")
                .await
                .as_deref(),
            Some("ready")
        );
    }
}
