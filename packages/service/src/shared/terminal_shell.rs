//! Terminal-backed execution for user-authored shell scripts.
//!
//! Both worktree setup and Cadencr-managed `!` commands use this helper so
//! they see the same hydrated process environment, interactive/login shell
//! startup, working directory, PTY behavior, and terminal color variables.

use std::io::Read;
use std::path::Path;

use portable_pty::{native_pty_system, CommandBuilder, PtySize};
use tokio::sync::mpsc::Sender;
use tokio_util::sync::CancellationToken;

const OUTPUT_CHANNEL_CAPACITY: usize = 256;
const MAX_PENDING_OUTPUT_BYTES: usize = 16 * 1024;

struct ShellInvocation {
    program: String,
    args: Vec<&'static str>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct TerminalShellExit {
    pub exit_code: i32,
}

impl TerminalShellExit {
    pub fn success(self) -> bool {
        self.exit_code == 0
    }
}

/// Run `script` in the same terminal environment used for worktree setup.
pub async fn run_terminal_shell_script(
    script: &str,
    cwd: &Path,
    output_tx: Sender<String>,
) -> Result<TerminalShellExit, String> {
    run_terminal_shell_script_cancellable(script, cwd, output_tx, CancellationToken::new()).await
}

/// Run `script` until it exits or `cancellation` is triggered.
pub async fn run_terminal_shell_script_cancellable(
    script: &str,
    cwd: &Path,
    output_tx: Sender<String>,
    cancellation: CancellationToken,
) -> Result<TerminalShellExit, String> {
    let shell = shell_invocation();
    let pty_system = native_pty_system();
    let pair = pty_system
        .openpty(PtySize {
            rows: 24,
            cols: 120,
            pixel_width: 0,
            pixel_height: 0,
        })
        .map_err(|error| format!("Failed to open terminal: {error}"))?;

    let mut command = CommandBuilder::new(&shell.program);
    crate::shared::security::inherit_sanitized_pty_env(&mut command);
    command.cwd(cwd);
    command.env("TERM", "xterm-256color");
    // The renderer is truecolor-capable. Without this, TUIs that probe
    // COLORTERM quantize their palettes to the 256-color cube.
    command.env("COLORTERM", "truecolor");
    command.env("FORCE_COLOR", "1");
    for argument in &shell.args {
        command.arg(argument);
    }
    command.arg(script);

    let mut child = pair
        .slave
        .spawn_command(command)
        .map_err(|error| format!("Failed to spawn shell `{}`: {error}", shell.program))?;
    drop(pair.slave);

    let mut reader = pair
        .master
        .try_clone_reader()
        .map_err(|error| format!("Failed to read terminal output: {error}"))?;
    let killer = child.clone_killer();
    let process_id = child.process_id();
    let read_handle = tokio::task::spawn_blocking(move || read_pty_lines(&mut reader, output_tx));
    let mut wait_handle = tokio::task::spawn_blocking(move || child.wait());
    let (wait_result, interrupted) = tokio::select! {
        result = &mut wait_handle => (result, false),
        () = cancellation.cancelled() => {
            let kill_result = tokio::task::spawn_blocking(move || {
                terminate_shell_process(killer, process_id)
            })
                .await
                .map_err(|error| format!("Shell cancellation task panicked: {error}"))?;
            if let Err(error) = kill_result {
                tracing::warn!(%error, "failed to terminate cancelled shell process");
            }
            (wait_handle.await, true)
        }
    };
    let status = wait_result
        .map_err(|error| format!("Shell wait task panicked: {error}"))?
        .map_err(|error| format!("Failed to wait on shell: {error}"))?;
    read_handle
        .await
        .map_err(|error| format!("Terminal output reader task panicked: {error}"))?;
    drop(pair.master);

    if interrupted {
        return Err("Shell command interrupted by user.".to_string());
    }

    Ok(TerminalShellExit {
        exit_code: status.exit_code() as i32,
    })
}

fn terminate_shell_process(
    mut killer: Box<dyn portable_pty::ChildKiller + Send + Sync>,
    process_id: Option<u32>,
) -> std::io::Result<()> {
    #[cfg(not(unix))]
    let _ = process_id;
    #[cfg(unix)]
    if let Some(process_id) = process_id {
        // portable-pty starts the child with `setsid`, so its PID is also the
        // process-group id. Kill the group to avoid leaving pipelines or
        // grandchildren holding the PTY open after the shell exits.
        let result = unsafe { libc::kill(-(process_id as libc::pid_t), libc::SIGKILL) };
        if result == 0 {
            return Ok(());
        }
    }
    killer.kill()
}

pub fn terminal_output_channel() -> (Sender<String>, tokio::sync::mpsc::Receiver<String>) {
    tokio::sync::mpsc::channel(OUTPUT_CHANNEL_CAPACITY)
}

fn shell_invocation() -> ShellInvocation {
    match std::env::var("SHELL") {
        Ok(shell) if !shell.trim().is_empty() => ShellInvocation {
            program: shell,
            args: vec!["-l", "-i", "-c"],
        },
        _ => ShellInvocation {
            program: "/bin/sh".to_string(),
            args: vec!["-i", "-c"],
        },
    }
}

fn read_pty_lines(reader: &mut dyn Read, output_tx: Sender<String>) {
    let mut buffer = [0_u8; 4096];
    let mut pending = String::new();
    loop {
        let count = match reader.read(&mut buffer) {
            Ok(0) => break,
            Ok(count) => count,
            Err(_) => break,
        };
        pending.push_str(&String::from_utf8_lossy(&buffer[..count]));
        flush_complete_segments(&mut pending, &output_tx);
        flush_oversized_pending(&mut pending, &output_tx);
    }
    if !pending.is_empty() {
        let line = pending.trim_end_matches('\r').to_string();
        let _ = output_tx.blocking_send(line);
    }
}

fn flush_complete_segments(pending: &mut String, output_tx: &Sender<String>) {
    let mut consumed = 0;
    while let Some(relative_index) = pending[consumed..].find(['\n', '\r']) {
        let index = consumed + relative_index;
        let line = pending[consumed..index].to_string();
        if output_tx.blocking_send(line).is_err() {
            return;
        }
        consumed = index + 1;
    }
    if consumed > 0 {
        pending.drain(..consumed);
    }
}

fn flush_oversized_pending(pending: &mut String, output_tx: &Sender<String>) {
    if pending.len() <= MAX_PENDING_OUTPUT_BYTES {
        return;
    }
    let line = std::mem::take(pending);
    let _ = output_tx.blocking_send(line);
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::shared::test_env::{env_lock, EnvVarGuard};

    #[test]
    fn user_shell_is_interactive_and_login() {
        let _guard = env_lock().lock().expect("env lock");
        let _shell = EnvVarGuard::set("SHELL", "/bin/zsh");

        let invocation = shell_invocation();

        assert_eq!(invocation.program, "/bin/zsh");
        assert_eq!(invocation.args, vec!["-l", "-i", "-c"]);
    }

    #[test]
    fn fallback_shell_is_interactive() {
        let _guard = env_lock().lock().expect("env lock");
        let _shell = EnvVarGuard::set("SHELL", "");

        let invocation = shell_invocation();

        assert_eq!(invocation.program, "/bin/sh");
        assert_eq!(invocation.args, vec!["-i", "-c"]);
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn cancellation_terminates_the_shell_process() {
        let cancellation = CancellationToken::new();
        cancellation.cancel();
        let (output_tx, _output_rx) = terminal_output_channel();

        let result = tokio::time::timeout(
            std::time::Duration::from_secs(5),
            run_terminal_shell_script_cancellable(
                "while :; do :; done",
                &std::env::current_dir().unwrap(),
                output_tx,
                cancellation,
            ),
        )
        .await
        .expect("cancelled shell should stop promptly");

        assert_eq!(result.unwrap_err(), "Shell command interrupted by user.");
    }
}
