//! Internal helper that runs `git <args>` inside a freshly-allocated PTY
//! and streams the merged stdout/stderr chunks. Used by both
//! `commit_streaming` and `push_streaming`.

use std::path::Path;

use crate::error::AppError;

use super::SensitiveInput;

/// Spawn `git <args>` attached to a freshly-allocated PTY and stream the
/// merged stdout/stderr chunks to `tx` as they arrive. PTYs merge stdout
/// and stderr into a single stream — we forward everything as `"stdout"`
/// since the dialog renders both the same way and the frontend buffer
/// preserves the original ordering.
///
/// `stdin_rx` is optional: when `Some`, a writer task pumps every received
/// sensitive input into the PTY master, which feeds the child's stdin. Use it for
/// commands that may prompt — `git push` over ssh asks for a passphrase,
/// `git pull` may ask `(yes/no)?` for unknown hosts. When `None`, no writer
/// task is spawned and the child's stdin is the PTY slave's empty default
/// (which is fine for non-interactive ops like `git commit`).
pub(super) async fn spawn_pty_git(
    args: &[&str],
    cwd: &Path,
    tx: tokio::sync::mpsc::UnboundedSender<(String, String)>,
    stdin_rx: Option<tokio::sync::mpsc::UnboundedReceiver<SensitiveInput>>,
) -> Result<(), AppError> {
    use std::io::Read;
    use std::sync::{Arc, Mutex};

    use portable_pty::{native_pty_system, CommandBuilder, PtySize};

    // 120×24 is enough for git's output and the most verbose hook
    // formatters. The frontend `<pre>` wraps so the column count is
    // mostly cosmetic anyway.
    let pty_system = native_pty_system();
    let pair = pty_system
        .openpty(PtySize {
            rows: 24,
            cols: 120,
            pixel_width: 0,
            pixel_height: 0,
        })
        .map_err(|e| AppError::GitCommandError(format!("openpty failed: {e}")))?;

    let mut cmd = CommandBuilder::new("git");
    for a in args {
        cmd.arg(a);
    }
    cmd.cwd(cwd);
    // `portable_pty::CommandBuilder` starts with an *empty* environment by
    // default. That breaks two real-world workflows:
    //
    //  - **GPG-signed commits**: gpg-agent + pinentry need `HOME`, `PATH`,
    //    `GPG_TTY`, `GNUPGHOME` (when set) to find the keychain and the
    //    GUI pinentry program. Without `GPG_TTY`, gpg falls back to a
    //    stale path and fails with "Inappropriate ioctl for device".
    //  - **SSH push from inside the dialog**: ssh needs `SSH_AUTH_SOCK`
    //    (the running ssh-agent / macOS Keychain agent socket) and
    //    `HOME` (for `~/.ssh/config`). Missing those means the user is
    //    re-prompted for the passphrase on every push, with no way to
    //    type it from our dialog.
    //
    // We forward the full parent process environment, then layer our own
    // streaming-friendly overrides on top. This mirrors what `tokio::
    // process::Command` does by default and matches what the user gets
    // running `git` from a normal shell.
    crate::shared::security::inherit_sanitized_pty_env(&mut cmd);
    cmd.env("TERM", "xterm-256color");
    // The renderer is truecolor-capable. Without this, TUIs that probe
    // COLORTERM quantize their palettes to the 256-color cube.
    cmd.env("COLORTERM", "truecolor");
    cmd.env("FORCE_COLOR", "1");
    cmd.env("PYTHONUNBUFFERED", "1");
    // `/dev/tty` resolves inside the child to its controlling terminal —
    // i.e. the slave end of our PTY. This is the standard incantation
    // (`export GPG_TTY=$(tty)` in shell rc files) that lets gpg-agent
    // route pinentry through the right TTY when the user has
    // `pinentry-program` set to a curses/tty pinentry. With a GUI
    // pinentry (`pinentry-mac`, `pinentry-gtk-3`, …) the variable is
    // harmless — gpg ignores it once it has decided to use the GUI.
    cmd.env("GPG_TTY", "/dev/tty");

    let mut child = pair
        .slave
        .spawn_command(cmd)
        .map_err(|e| AppError::GitCommandError(format!("spawn git failed: {e}")))?;
    // Drop the slave in the parent so the master pipe gets EOF the moment
    // the child closes its end (otherwise the read loop would hang on
    // exit).
    drop(pair.slave);

    let mut reader = pair
        .master
        .try_clone_reader()
        .map_err(|e| AppError::GitCommandError(format!("pty reader clone failed: {e}")))?;

    // Spawn the stdin pump *before* the reader so it's ready by the time
    // the child prints a prompt. `take_writer()` consumes the master's
    // write half exactly once; we don't call it when there's no input
    // channel because some platforms (Windows ConPTY) implement the writer
    // as a kept-open pipe that would otherwise block child exit.
    let writer_handle = if let Some(mut rx) = stdin_rx {
        let mut writer = pair
            .master
            .take_writer()
            .map_err(|e| AppError::GitCommandError(format!("pty writer take failed: {e}")))?;
        Some(tokio::task::spawn_blocking(move || {
            // Each `recv` returns one user-input chunk (e.g. a passphrase
            // line). We pass it through verbatim — the caller is
            // responsible for terminating with `\n` when the protocol
            // expects a line. `write_all` + `flush` so ssh sees the bytes
            // immediately rather than buffered until enough accumulate.
            while let Some(text) = rx.blocking_recv() {
                use std::io::Write;
                if writer.write_all(text.as_ref()).is_err() {
                    break;
                }
                if writer.flush().is_err() {
                    break;
                }
            }
            // Drop the writer to close stdin so the child knows there's
            // nothing more coming. Important for tools that read stdin
            // until EOF (rare with git, but defensive).
            drop(writer);
        }))
    } else {
        None
    };

    let captured: Arc<Mutex<Vec<u8>>> = Arc::new(Mutex::new(Vec::new()));
    let captured_for_reader = Arc::clone(&captured);
    let tx_reader = tx.clone();

    // Reader runs on a blocking thread because portable-pty's reader is a
    // sync `std::io::Read`. Each `read` call returns whatever is available
    // in the kernel PTY buffer at that instant — no batching across
    // chunks. Same pattern as `terminal::service`.
    let read_handle = tokio::task::spawn_blocking(move || {
        let mut buf = [0u8; 4096];
        loop {
            match reader.read(&mut buf) {
                Ok(0) => break,
                Ok(n) => {
                    captured_for_reader
                        .lock()
                        .unwrap_or_else(|e| e.into_inner())
                        .extend_from_slice(&buf[..n]);
                    let chunk = String::from_utf8_lossy(&buf[..n]).into_owned();
                    if tx_reader.send(("stdout".into(), chunk)).is_err() {
                        break;
                    }
                }
                // `Err` on master typically means the slave was closed —
                // child exited. Bail out the same way as EOF.
                Err(_) => break,
            }
        }
    });

    // `child.wait()` is also sync (`portable_pty::Child`), so it goes on a
    // blocking thread too. `master` is held in this scope until both the
    // wait and the read loop have finished, guaranteeing the reader gets
    // every byte before the master is dropped.
    let wait_result = tokio::task::spawn_blocking(move || child.wait()).await;
    let exit = match wait_result {
        Ok(Ok(status)) => status,
        Ok(Err(e)) => {
            return Err(AppError::GitCommandError(format!(
                "git child wait failed: {e}"
            )))
        }
        Err(e) => {
            return Err(AppError::GitCommandError(format!(
                "git wait task panicked: {e}"
            )))
        }
    };
    let _ = read_handle.await;
    // The writer task is on `spawn_blocking` and may be parked in
    // `blocking_recv()` waiting for input the caller will never send (the
    // happy path: child finished without prompting, but the dialog still
    // holds the stdin sender). `abort()` flags the task as cancelled but
    // does NOT actually stop a blocking thread — `.await`ing it would
    // hang until the caller drops their sender. So we deliberately do
    // *not* await: the OS thread stays parked harmlessly until the
    // sender drops naturally (function returns to caller, dialog closes,
    // etc.), at which point `blocking_recv()` returns `None` and the
    // closure exits. Tokio's blocking pool reaps the slot then.
    if let Some(handle) = writer_handle {
        handle.abort();
    }
    drop(pair.master);

    if exit.success() {
        Ok(())
    } else {
        let bytes = captured.lock().unwrap_or_else(|e| e.into_inner()).clone();
        let s = String::from_utf8_lossy(&bytes).into_owned();
        Err(AppError::GitCommandError(s.trim().to_string()))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::shared::git_cli::run_git;

    /// End-to-end timing assertion: spawn a command that prints one line
    /// every 200 ms, and verify the streaming channel delivers chunks
    /// *while* it runs — not in a single batch at the end. This is the
    /// regression test for "I see all the output only when the command
    /// finishes". If the read loop is buffering anywhere in the chain
    /// (PTY → spawn_blocking → mpsc), the assertion fails.
    ///
    /// **This is the one remaining duration-based test in the streaming
    /// path** — kept on purpose as the lowest-level smoke test that real
    /// time can pass through `spawn_pty_git` without batching. Higher-
    /// level callers (commit_push tests) assert event ordering instead
    /// (chunk arrives BEFORE the operation completes), which is robust
    /// under load. Don't add new spread-based assertions; convert to
    /// event ordering.
    #[tokio::test]
    async fn spawn_pty_streams_chunks_progressively() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path();
        run_git(&["init", "-q"], path).await.unwrap();
        run_git(&["config", "user.email", "test@example.com"], path)
            .await
            .unwrap();
        run_git(&["config", "user.name", "Test"], path)
            .await
            .unwrap();
        run_git(&["config", "commit.gpgsign", "false"], path)
            .await
            .unwrap();
        run_git(&["config", "tag.gpgsign", "false"], path)
            .await
            .unwrap();
        run_git(&["commit", "--allow-empty", "-m", "init"], path)
            .await
            .unwrap();

        // Pre-commit hook that prints 5 lines, 200 ms apart. We run
        // `git commit --allow-empty` so the hook fires reliably.
        let hooks = path.join(".git").join("hooks");
        let hook = hooks.join("pre-commit");
        tokio::fs::write(
            &hook,
            "#!/bin/sh\nfor i in 1 2 3 4 5; do echo \"hook line $i\"; sleep 0.2; done\n",
        )
        .await
        .unwrap();
        // chmod +x
        use std::os::unix::fs::PermissionsExt;
        let mut perms = tokio::fs::metadata(&hook).await.unwrap().permissions();
        perms.set_mode(0o755);
        tokio::fs::set_permissions(&hook, perms).await.unwrap();

        let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel();
        let path_buf = path.to_path_buf();
        // Drive the commit on a dedicated task so the receiver can drain
        // the channel concurrently and stamp arrival times.
        let commit_task = tokio::spawn(async move {
            spawn_pty_git(
                &["commit", "--allow-empty", "-m", "stream test"],
                &path_buf,
                tx,
                None,
            )
            .await
        });

        let start = std::time::Instant::now();
        let mut arrival_ms: Vec<u128> = Vec::new();
        while let Some((_kind, text)) = rx.recv().await {
            for _line in text.lines() {
                arrival_ms.push(start.elapsed().as_millis());
            }
        }
        commit_task.await.unwrap().unwrap();

        // Spread between first and last hook line should be ≥ 600 ms
        // (5 lines × 200 ms − some slack). If everything arrives in one
        // batch at the end, the spread collapses to ~0. The assertion
        // window is generous to absorb CI flakiness.
        let earliest = *arrival_ms.first().unwrap_or(&0);
        let latest = *arrival_ms.last().unwrap_or(&0);
        let spread = latest.saturating_sub(earliest);
        assert!(
            spread >= 400,
            "chunks arrived all at once (spread = {spread}ms): {arrival_ms:?}"
        );
    }
}
