//! Per-session registry of live ACP terminals. Each entry owns a
//! supervisor for the spawned `Child` (`terminal_process.rs`), a bounded
//! stdout/stderr ring buffer, and the joined command line we surface to the
//! FE BashBlock.
//!
//! `terminal/create` enforces a sandbox: the requested cwd must live under
//! the session cwd, and the `env` field must follow ACP's array shape
//! (with a backward-compat warning for the legacy object shape). The
//! sandbox helpers live in `terminal_sandbox.rs`; the IO ring-buffer and
//! payload helpers live in `terminal_io.rs`.

use std::collections::HashMap;
use std::path::PathBuf;
use std::process::Stdio;
use std::sync::atomic::AtomicBool;
use std::sync::Arc;

use serde_json::{json, Value};
use tokio::process::Command;
use tokio::sync::Mutex;

use super::terminal_group::stop_groups;
use super::terminal_io::{
    build_output_payload, spawn_pumps, TerminalOutput, DEFAULT_TERMINAL_OUTPUT_LIMIT,
};
use super::terminal_process::{TerminalExitWaiter, TerminalProcess, KILL_GRACE};
use super::terminal_sandbox::{apply_restricted_env, parse_acp_env, resolve_sandboxed_cwd};

#[derive(Default)]
pub struct TerminalRegistry {
    inner: Mutex<Inner>,
    /// Tracks whether we've already logged the "deprecated env-as-object"
    /// warning for this session. The schema-correct shape is
    /// `[{name, value}, ...]`; we still accept the legacy object form for
    /// backward compatibility but only warn once per session.
    legacy_env_warned: AtomicBool,
}

#[derive(Default)]
struct Inner {
    next_id: u64,
    terminals: HashMap<String, TerminalEntry>,
}

struct TerminalEntry {
    process: TerminalProcess,
    output: Arc<Mutex<TerminalOutput>>,
    /// Joined `command + args` captured at `terminal/create` time. ACP's
    /// later `tool_call` / `tool_call_update` only carries `terminalId`, so
    /// we need this stash to surface a command in the FE's BashBlock.
    command_line: String,
}

impl TerminalRegistry {
    /// Spawn a new terminal under the given session and return its id.
    pub async fn create(
        &self,
        params: &Value,
        session_cwd: &PathBuf,
    ) -> Result<Value, (i64, String)> {
        let command = params
            .get("command")
            .and_then(Value::as_str)
            .ok_or((-32602, "terminal/create: missing 'command'".to_string()))?;
        if command.trim().is_empty() {
            return Err((
                -32602,
                "terminal/create: 'command' must not be empty".to_string(),
            ));
        }

        let args = params
            .get("args")
            .and_then(Value::as_array)
            .map(|a| {
                a.iter()
                    .filter_map(|v| v.as_str().map(ToOwned::to_owned))
                    .collect::<Vec<_>>()
            })
            .unwrap_or_default();

        let cwd = resolve_sandboxed_cwd(params.get("cwd"), session_cwd)?;
        let env = parse_acp_env(params.get("env"), &self.legacy_env_warned)?;

        let limit = params
            .get("outputByteLimit")
            .and_then(Value::as_u64)
            .map(|n| n as usize)
            .unwrap_or(DEFAULT_TERMINAL_OUTPUT_LIMIT);

        let command_line = if args.is_empty() {
            command.to_string()
        } else {
            format!("{command} {}", args.join(" "))
        };
        let mut cmd = Command::new(command);
        super::terminal_group::isolate(&mut cmd);
        cmd.args(&args).current_dir(&cwd);
        apply_restricted_env(&mut cmd, &env);
        cmd.stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .stdin(Stdio::null())
            .kill_on_drop(true);

        let mut child = cmd
            .spawn()
            .map_err(|e| (-32000, format!("terminal/create: spawn failed: {e}")))?;
        let stdout = child.stdout.take();
        let stderr = child.stderr.take();
        let output = Arc::new(Mutex::new(TerminalOutput::new(limit)));
        let pumps = spawn_pumps(stdout, stderr, Arc::clone(&output));
        let process = TerminalProcess::start(child, pumps);

        let mut inner = self.inner.lock().await;
        inner.next_id += 1;
        let id = format!("term_{}", inner.next_id);
        inner.terminals.insert(
            id.clone(),
            TerminalEntry {
                process,
                output,
                command_line,
            },
        );
        Ok(json!({ "terminalId": id }))
    }

    /// Look up the command line we stashed at `terminal/create`. ACP's
    /// later tool-call references only carry the `terminalId`, so the
    /// adapter calls this to enrich Bash tool blocks with a `command`.
    pub async fn command_for(&self, terminal_id: &str) -> Option<String> {
        let inner = self.inner.lock().await;
        inner
            .terminals
            .get(terminal_id)
            .map(|entry| entry.command_line.clone())
    }

    /// Return the current stdout/stderr snapshot as plain text. Used to
    /// surface terminal output in the FE without going through the full
    /// `output()` payload (which is shaped for ACP's wire response).
    pub async fn output_text(&self, terminal_id: &str) -> Option<String> {
        let inner = self.inner.lock().await;
        let entry = inner.terminals.get(terminal_id)?;
        let (text, _) = entry.output.lock().await.snapshot();
        Some(text)
    }

    /// Return current accumulated output without blocking. Includes the
    /// exit status as soon as the command has exited, even if nobody waited.
    pub async fn output(&self, terminal_id: &str) -> Result<Value, (i64, String)> {
        let inner = self.inner.lock().await;
        let Some(entry) = inner.terminals.get(terminal_id) else {
            return Err((-32602, format!("terminal/output: unknown id {terminal_id}")));
        };
        let (text, truncated) = entry.output.lock().await.snapshot();
        Ok(build_output_payload(
            text,
            truncated,
            entry.process.exit_info(),
        ))
    }

    /// Resolve the terminal now, but wait for its exit separately: the
    /// returned waiter holds no registry lock, so the event loop can await it
    /// off the dispatch path while `kill`/`release` keep working.
    pub(super) async fn exit_waiter(
        &self,
        terminal_id: &str,
    ) -> Result<TerminalExitWaiter, (i64, String)> {
        let inner = self.inner.lock().await;
        inner
            .terminals
            .get(terminal_id)
            .map(|entry| entry.process.exit_waiter())
            .ok_or_else(|| {
                (
                    -32602,
                    format!("terminal/wait_for_exit: unknown id {terminal_id}"),
                )
            })
    }

    /// Block until the child exits, then return exit info.
    #[cfg(test)]
    pub async fn wait_for_exit(&self, terminal_id: &str) -> Result<Value, (i64, String)> {
        self.exit_waiter(terminal_id).await?.wait().await
    }

    /// Kill the running command (if any) without releasing the registry slot.
    pub async fn kill(&self, terminal_id: &str) -> Result<Value, (i64, String)> {
        let inner = self.inner.lock().await;
        let Some(entry) = inner.terminals.get(terminal_id) else {
            return Err((-32602, format!("terminal/kill: unknown id {terminal_id}")));
        };
        entry
            .process
            .kill()
            .await
            .map_err(|error| (-32000, format!("terminal/kill: {error}")))?;
        Ok(Value::Null)
    }

    /// Session teardown: stop every terminal's process group (SIGTERM, then
    /// SIGKILL for what is left after the grace), including what exited
    /// commands left running, and drop the entries.
    pub async fn shutdown(&self) {
        let entries: Vec<TerminalEntry> = self
            .inner
            .lock()
            .await
            .terminals
            .drain()
            .map(|(_, entry)| entry)
            .collect();
        let groups: Vec<_> = entries.iter().map(|entry| entry.process.group()).collect();
        stop_groups(&groups, KILL_GRACE).await;
    }

    /// Kill the command if still running and remove the registry entry.
    pub async fn release(&self, terminal_id: &str) -> Result<Value, (i64, String)> {
        let entry = self.inner.lock().await.terminals.remove(terminal_id);
        let Some(entry) = entry else {
            return Err((
                -32602,
                format!("terminal/release: unknown id {terminal_id}"),
            ));
        };
        entry
            .process
            .release()
            .await
            .map_err(|error| (-32000, format!("terminal/release: {error}")))?;
        Ok(Value::Null)
    }
}

#[cfg(test)]
mod tests {
    use super::TerminalRegistry;
    use crate::shared::test_env::EnvVarGuard;
    use serde_json::json;
    use std::path::PathBuf;

    #[tokio::test]
    async fn create_then_output_returns_command_result() {
        let registry = TerminalRegistry::default();
        let cwd = std::env::temp_dir();
        let result = registry
            .create(&json!({ "command": "echo", "args": ["hi"] }), &cwd)
            .await
            .expect("create ok");
        let id = result["terminalId"].as_str().unwrap().to_string();

        let _ = registry.wait_for_exit(&id).await.unwrap();
        let out = registry.output(&id).await.unwrap();
        let text = out["output"].as_str().unwrap();
        assert!(text.contains("hi"), "output was: {text}");
        assert_eq!(out["exitStatus"]["exitCode"], 0);
        let _ = registry.release(&id).await.unwrap();
    }

    #[tokio::test]
    async fn create_missing_command_is_rejected() {
        let registry = TerminalRegistry::default();
        let err = registry
            .create(&json!({}), &PathBuf::from("/tmp"))
            .await
            .expect_err("should reject");
        assert_eq!(err.0, -32602);
    }

    #[tokio::test]
    async fn create_empty_command_is_rejected() {
        let registry = TerminalRegistry::default();
        let err = registry
            .create(&json!({ "command": "   " }), &std::env::temp_dir())
            .await
            .expect_err("empty command rejected");
        assert_eq!(err.0, -32602);
        assert!(err.1.contains("must not be empty"), "got: {}", err.1);
    }

    #[tokio::test]
    async fn create_rejects_cwd_outside_session_sandbox() {
        let session_cwd = std::env::temp_dir();
        let registry = TerminalRegistry::default();
        let err = registry
            .create(&json!({ "command": "echo", "cwd": "/etc" }), &session_cwd)
            .await
            .expect_err("escape rejected");
        assert_eq!(err.0, -32602);
        assert!(err.1.contains("outside session sandbox"), "got: {}", err.1);
    }

    #[tokio::test]
    async fn create_accepts_array_env_shape() {
        let registry = TerminalRegistry::default();
        let cwd = std::env::temp_dir();
        let result = registry
            .create(
                &json!({
                    "command": "sh",
                    "args": ["-c", "printf %s \"$ACP_PARITY\""],
                    "env": [{ "name": "ACP_PARITY", "value": "ok" }],
                }),
                &cwd,
            )
            .await
            .expect("array env ok");
        let id = result["terminalId"].as_str().unwrap().to_string();
        let _ = registry.wait_for_exit(&id).await.unwrap();
        let out = registry.output(&id).await.unwrap();
        assert_eq!(out["output"].as_str().unwrap(), "ok");
        let _ = registry.release(&id).await.unwrap();
    }

    #[tokio::test]
    async fn create_does_not_leak_parent_secret_env_by_default() {
        let _guard = crate::shared::test_env::async_env_lock().lock().await;
        let _secret = EnvVarGuard::set("CADENCR_TEST_AGENT_SECRET", "leaked");
        let registry = TerminalRegistry::default();
        let result = registry
            .create(
                &json!({
                    "command": "sh",
                    "args": ["-c", "printf %s \"${CADENCR_TEST_AGENT_SECRET-unset}\""],
                }),
                &std::env::temp_dir(),
            )
            .await
            .expect("create ok");
        let id = result["terminalId"].as_str().unwrap().to_string();
        let _ = registry.wait_for_exit(&id).await.unwrap();
        let out = registry.output(&id).await.unwrap();
        assert_eq!(out["output"].as_str().unwrap(), "unset");
        let _ = registry.release(&id).await.unwrap();
    }

    #[tokio::test]
    async fn create_rejects_malformed_env() {
        let registry = TerminalRegistry::default();
        let err = registry
            .create(
                &json!({ "command": "echo", "env": "not-an-env" }),
                &std::env::temp_dir(),
            )
            .await
            .expect_err("string env rejected");
        assert_eq!(err.0, -32602);
    }

    #[tokio::test]
    async fn release_on_unknown_id_is_an_error() {
        let registry = TerminalRegistry::default();
        let err = registry
            .release("term_does_not_exist")
            .await
            .expect_err("should reject");
        assert_eq!(err.0, -32602);
    }

    #[tokio::test]
    async fn output_buffer_respects_byte_limit() {
        let registry = TerminalRegistry::default();
        let cwd = std::env::temp_dir();
        let result = registry
            .create(
                &json!({
                    "command": "sh",
                    "args": ["-c", "head -c 4096 /dev/zero | tr '\\0' 'x'"],
                    "outputByteLimit": 16,
                }),
                &cwd,
            )
            .await
            .expect("create ok");
        let id = result["terminalId"].as_str().unwrap().to_string();
        let _ = registry.wait_for_exit(&id).await.unwrap();
        let out = registry.output(&id).await.unwrap();
        let text = out["output"].as_str().unwrap();
        assert!(text.len() <= 16);
        assert_eq!(out["truncated"], true);
        let _ = registry.release(&id).await.unwrap();
    }
}
