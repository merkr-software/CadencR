//! Terminal-backed execution for user-authored shell scripts.
//!
//! Both worktree setup and Cadencr-managed `!` commands use this helper so
//! they see the same hydrated process environment, interactive/login shell
//! startup, working directory, and terminal color variables.
//!
//! Nobody can type into these scripts, so nothing in them may wait for input.
//! The user's shell still runs as `-l -i`, sourcing `.zshrc` & co. in the
//! working directory, so version managers (fnm, nvm, mise) pick the
//! project's Node exactly as a terminal would. But it starts with stdin on
//! `/dev/null`, without a controlling terminal, and with stdout/stderr on a
//! pipe while startup files run: zsh finds no terminal for `read -k` (Oh My
//! Zsh's update prompt), and plain reads hit end-of-file. A POSIX script then
//! reopens the PTY by path for stdout/stderr, so its commands still write to
//! a color terminal — one nothing can read from: the shell does not lead its
//! session, so opening the PTY cannot make it the controlling terminal.

use std::path::Path;
#[cfg(unix)]
use std::sync::atomic::{AtomicBool, Ordering};
#[cfg(unix)]
use std::sync::Arc;

use tokio::sync::mpsc::Sender;
use tokio_util::sync::CancellationToken;

#[cfg(unix)]
mod output;
#[cfg(unix)]
mod spawn;

#[cfg(unix)]
pub(crate) use spawn::detach_from_terminal;

const OUTPUT_CHANNEL_CAPACITY: usize = 256;

/// Shells that understand `exec >>path 2>&1`. Others (fish, nushell, csh)
/// keep stdout/stderr on the pipe: no color terminal, but no hang either.
const POSIX_SHELLS: &[&str] = &[
    "sh", "bash", "zsh", "dash", "ash", "ksh", "ksh93", "mksh", "oksh", "yash",
];

#[cfg_attr(not(unix), allow(dead_code))]
struct ShellInvocation {
    program: String,
    args: Vec<&'static str>,
    attaches_terminal: bool,
}

#[cfg_attr(not(unix), allow(dead_code))]
impl ShellInvocation {
    fn new(program: String, args: Vec<&'static str>) -> Self {
        let name = Path::new(&program)
            .file_name()
            .and_then(|name| name.to_str())
            .unwrap_or_default();
        let attaches_terminal = POSIX_SHELLS.contains(&name);
        Self {
            program,
            args,
            attaches_terminal,
        }
    }

    /// `script`, preceded on its first line (so error line numbers match)
    /// by the switch from the startup pipe to `terminal`.
    fn script(&self, script: &str, terminal: &Path) -> String {
        if !self.attaches_terminal {
            return script.to_string();
        }
        let terminal = cli_discovery::shell_quote(terminal.as_os_str());
        format!("exec >>{terminal} 2>&1; {script}")
    }
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

/// Run `script` until it exits or `cancellation` is triggered; either way,
/// cancellation or the end of the service kills its whole process group.
pub async fn run_terminal_shell_script_cancellable(
    script: &str,
    cwd: &Path,
    output_tx: Sender<String>,
    cancellation: CancellationToken,
) -> Result<TerminalShellExit, String> {
    run_shell(shell_invocation(), script, cwd, output_tx, cancellation).await
}

#[cfg(not(unix))]
async fn run_shell(
    _shell: ShellInvocation,
    _script: &str,
    _cwd: &Path,
    _output_tx: Sender<String>,
    _cancellation: CancellationToken,
) -> Result<TerminalShellExit, String> {
    Err("Running shell scripts is only supported on macOS and Linux.".to_string())
}

#[cfg(unix)]
async fn run_shell(
    shell: ShellInvocation,
    script: &str,
    cwd: &Path,
    output_tx: Sender<String>,
    cancellation: CancellationToken,
) -> Result<TerminalShellExit, String> {
    let terminal =
        spawn::open_terminal().map_err(|error| format!("Failed to open terminal: {error}"))?;
    let script = shell.script(script, &terminal.path);
    let spawned = spawn::spawn_shell(&shell, terminal, &script, cwd)
        .map_err(|error| format!("Failed to spawn shell `{}`: {error}", shell.program))?;
    let mut child = spawned.child;
    let process_id = child.id();
    // Held for the whole run: if this future is dropped (runtime shutdown,
    // aborted task) the lifeline closes and the reader stops.
    let lifeline = spawned.lifeline;
    let abandoned = AbandonOnDrop::default();
    let sources = vec![spawned.startup_output, spawned.terminal];
    let reader_abandoned = Arc::clone(&abandoned.0);
    let forward = tokio::task::spawn_blocking(move || {
        output::forward_output(sources, &reader_abandoned, &output_tx)
    });
    let finished = tokio::select! {
        status = child.wait() => Some(status),
        () = cancellation.cancelled() => None,
    };
    let interrupted = finished.is_none();
    let wait_result = match finished {
        Some(status) => status,
        None => {
            if let Err(error) = terminate_shell_process(&mut child, process_id) {
                tracing::warn!(%error, "failed to terminate cancelled shell process");
            }
            child.wait().await
        }
    };
    drop(spawned.terminal_slave);
    drop(lifeline);
    forward
        .await
        .map_err(|error| format!("Terminal output reader task panicked: {error}"))?;
    let status = wait_result.map_err(|error| format!("Failed to wait on shell: {error}"))?;

    if interrupted {
        return Err("Shell command interrupted by user.".to_string());
    }

    Ok(TerminalShellExit {
        exit_code: exit_code(status),
    })
}

/// Stops the output reader when the run's future is dropped before it ends
/// (on completion it fires after the reader has already finished).
#[cfg(unix)]
#[derive(Default)]
struct AbandonOnDrop(Arc<AtomicBool>);

#[cfg(unix)]
impl Drop for AbandonOnDrop {
    fn drop(&mut self) {
        self.0.store(true, Ordering::Release);
    }
}

#[cfg(unix)]
fn exit_code(status: std::process::ExitStatus) -> i32 {
    use std::os::unix::process::ExitStatusExt;
    status
        .code()
        .or_else(|| status.signal().map(|signal| 128 + signal))
        .unwrap_or(1)
}

#[cfg(unix)]
fn terminate_shell_process(
    child: &mut tokio::process::Child,
    process_id: Option<u32>,
) -> std::io::Result<()> {
    if let Some(process_id) = process_id {
        // The child leads its own session, so its PID is also the
        // process-group id. Kill the group to stop the user's shell too and
        // avoid leaving pipelines or grandchildren holding the terminal open.
        if crate::shared::process_group::try_signal_process_group(process_id, libc::SIGKILL).is_ok()
        {
            return Ok(());
        }
    }
    child.start_kill()
}

pub fn terminal_output_channel() -> (Sender<String>, tokio::sync::mpsc::Receiver<String>) {
    tokio::sync::mpsc::channel(OUTPUT_CHANNEL_CAPACITY)
}

fn shell_invocation() -> ShellInvocation {
    match std::env::var("SHELL") {
        Ok(shell) if !shell.trim().is_empty() => {
            ShellInvocation::new(shell, vec!["-l", "-i", "-c"])
        }
        _ => ShellInvocation::new("/bin/sh".to_string(), vec!["-i", "-c"]),
    }
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
        assert!(invocation.attaches_terminal);
    }

    #[test]
    fn fallback_shell_is_interactive() {
        let _guard = env_lock().lock().expect("env lock");
        let _shell = EnvVarGuard::set("SHELL", "");

        let invocation = shell_invocation();

        assert_eq!(invocation.program, "/bin/sh");
        assert_eq!(invocation.args, vec!["-i", "-c"]);
        assert!(invocation.attaches_terminal);
    }

    #[test]
    fn only_posix_shells_attach_the_terminal() {
        for program in [
            "/bin/bash",
            "/usr/bin/zsh",
            "/bin/dash",
            "/nix/store/x-bash/bin/bash",
        ] {
            assert!(invocation(program).attaches_terminal, "{program}");
        }
        for program in ["/opt/homebrew/bin/fish", "/usr/bin/nu", "/bin/tcsh"] {
            assert!(!invocation(program).attaches_terminal, "{program}");
        }
    }

    #[test]
    fn a_posix_script_attaches_the_terminal_on_its_first_line() {
        let terminal = Path::new("/dev/pts/3");
        assert_eq!(
            invocation("/bin/zsh").script("echo hi\nexit 2", terminal),
            "exec >>'/dev/pts/3' 2>&1; echo hi\nexit 2"
        );
        assert_eq!(
            invocation("/usr/bin/fish").script("echo hi", terminal),
            "echo hi"
        );
    }

    fn invocation(program: &str) -> ShellInvocation {
        ShellInvocation::new(program.to_string(), vec!["-l", "-i", "-c"])
    }

    #[cfg(unix)]
    mod running {
        use super::*;
        use std::os::unix::fs::PermissionsExt;
        use std::time::{Duration, Instant};

        /// What a script sees: a terminal to write to, end-of-file on
        /// stdin, and no controlling terminal to fall back on.
        const PROBE: &str = "[ -t 1 ] && echo stdout-is-a-terminal; \
            read -r answer; echo \"stdin read=$?\"; \
            (exec </dev/tty) 2>/dev/null || echo no-controlling-terminal";

        async fn run(shell: ShellInvocation, script: &str) -> (TerminalShellExit, Vec<String>) {
            let (output_tx, mut output_rx) = terminal_output_channel();
            let collect = async {
                let mut lines = Vec::new();
                while let Some(line) = output_rx.recv().await {
                    lines.push(line);
                }
                lines
            };
            let cwd = std::env::temp_dir();
            let run = run_shell(shell, script, &cwd, output_tx, CancellationToken::new());
            let (result, lines) = tokio::time::timeout(Duration::from_secs(20), async {
                tokio::join!(run, collect)
            })
            .await
            .expect("the shell must never wait for input");
            (result.expect("shell run"), lines)
        }

        fn has(lines: &[String], expected: &str) -> bool {
            lines.iter().any(|line| line.trim() == expected)
        }

        fn assert_non_interactive(exit: TerminalShellExit, lines: &[String], tty: bool) {
            assert!(exit.success(), "{lines:?}");
            assert_eq!(has(lines, "stdout-is-a-terminal"), tty, "{lines:?}");
            assert!(has(lines, "stdin read=1"), "{lines:?}");
            assert!(has(lines, "no-controlling-terminal"), "{lines:?}");
        }

        /// A fake shell whose startup file asks a question through stdin,
        /// `/dev/tty`, and whatever terminal its stdout is (how zsh's
        /// `read -k`, used by Oh My Zsh's update prompt, finds one).
        fn prompting_shell(dir: &Path, name: &str) -> String {
            let path = dir.join(name);
            std::fs::write(
                &path,
                r#"#!/bin/sh
while [ "$#" -gt 1 ]; do shift; done
echo "rc: Update? [Y/n]"
read -r answer; echo "rc stdin read=$?"
read -r answer </dev/tty 2>/dev/null; echo "rc tty read=$?"
if [ -t 1 ]; then read -r answer <&1; fi; echo "rc stdout-terminal read done"
exec /bin/sh -c "$1"
"#,
            )
            .expect("write fake shell");
            std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o755))
                .expect("chmod fake shell");
            path.to_string_lossy().into_owned()
        }

        #[tokio::test]
        async fn startup_prompts_read_end_of_file_and_the_script_writes_to_a_terminal() {
            let temp = tempfile::tempdir().expect("tempdir");
            let shell = invocation(&prompting_shell(temp.path(), "zsh"));

            let (exit, lines) = run(shell, PROBE).await;

            assert_non_interactive(exit, &lines, true);
            assert!(has(&lines, "rc: Update? [Y/n]"), "{lines:?}");
            assert!(has(&lines, "rc stdin read=1"), "{lines:?}");
            // POSIX only promises a nonzero status: macOS sh returns 1,
            // while Linux dash returns 2 when /dev/tty cannot be opened.
            assert!(
                lines.iter().any(|line| line
                    .trim()
                    .strip_prefix("rc tty read=")
                    .and_then(|status| status.parse::<u8>().ok())
                    .is_some_and(|status| status > 0)),
                "{lines:?}"
            );
            assert!(has(&lines, "rc stdout-terminal read done"), "{lines:?}");
        }

        #[tokio::test]
        async fn a_non_posix_shell_keeps_its_output_on_the_pipe() {
            let temp = tempfile::tempdir().expect("tempdir");
            let shell = invocation(&prompting_shell(temp.path(), "fish"));

            let (exit, lines) = run(shell, PROBE).await;

            assert_non_interactive(exit, &lines, false);
        }

        #[tokio::test]
        async fn the_exit_code_and_stderr_come_through() {
            let shell = invocation("/bin/sh");

            let (exit, lines) = run(shell, "echo oops >&2; exit 3").await;

            assert_eq!(exit.exit_code, 3);
            assert!(has(&lines, "oops"), "{lines:?}");
        }

        /// bash closes inherited descriptors 3–19 as an interactive login
        /// shell, so the terminal is reopened by path, not inherited.
        #[tokio::test]
        async fn a_daemon_started_by_a_startup_file_does_not_hold_the_terminal() {
            let temp = tempfile::tempdir().expect("tempdir");
            let daemonizing = temp.path().join("bash");
            std::fs::write(
                &daemonizing,
                "#!/bin/sh\nwhile [ \"$#\" -gt 1 ]; do shift; done\n\
                 (sleep 5 </dev/null >/dev/null 2>&1 &)\nexec /bin/sh -c \"$1\"\n",
            )
            .expect("write fake shell");
            std::fs::set_permissions(&daemonizing, std::fs::Permissions::from_mode(0o755))
                .expect("chmod fake shell");
            let started = Instant::now();

            let (exit, lines) = run(invocation(&daemonizing.to_string_lossy()), "echo done").await;

            assert!(exit.success());
            assert!(has(&lines, "done"), "{lines:?}");
            assert!(started.elapsed() < Duration::from_secs(4));
        }

        #[tokio::test]
        async fn the_fallback_sh_does_not_wait_for_input() {
            let shell = ShellInvocation::new("/bin/sh".to_string(), vec!["-i", "-c"]);

            let (exit, lines) = run(shell, PROBE).await;

            assert_non_interactive(exit, &lines, true);
        }

        #[tokio::test]
        async fn bash_does_not_wait_for_input() {
            let Some(bash) = installed("bash") else {
                return;
            };

            let (exit, lines) = run(invocation(&bash), PROBE).await;

            assert_non_interactive(exit, &lines, true);
        }

        /// The incident: `.zshrc` asking Oh My Zsh's `read -k` question.
        #[tokio::test]
        async fn zsh_startup_read_k_does_not_wait_for_input() {
            let Some(zsh) = installed("zsh") else {
                return;
            };
            let _guard = crate::shared::test_env::async_env_lock().lock().await;
            let zdotdir = tempfile::tempdir().expect("tempdir");
            std::fs::write(
                zdotdir.path().join(".zshrc"),
                "printf 'Update? [Y/n] '; read -r -k 1 option; echo \"rc read-k=$?\"\n",
            )
            .expect("write .zshrc");
            let _zdotdir = EnvVarGuard::set("ZDOTDIR", &zdotdir.path().to_string_lossy());

            let (exit, lines) = run(invocation(&zsh), PROBE).await;

            assert_non_interactive(exit, &lines, true);
            assert!(
                lines.iter().any(|line| line.contains("rc read-k=1")),
                "{lines:?}"
            );
        }

        fn installed(name: &str) -> Option<String> {
            ["/bin", "/usr/bin", "/usr/local/bin", "/opt/homebrew/bin"]
                .iter()
                .map(|dir| Path::new(dir).join(name))
                .find(|path| path.is_file())
                .map(|path| path.to_string_lossy().into_owned())
        }

        #[tokio::test]
        async fn cancellation_terminates_the_shell_process() {
            let cancellation = CancellationToken::new();
            cancellation.cancel();
            let (output_tx, _output_rx) = terminal_output_channel();

            let result = tokio::time::timeout(
                Duration::from_secs(5),
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

        /// The script records the pid of a background `sleep`; returns it
        /// once the file appears.
        async fn wait_for_pid(path: &Path) -> i32 {
            for _ in 0..200 {
                if let Ok(text) = std::fs::read_to_string(path) {
                    if let Ok(pid) = text.trim().parse() {
                        return pid;
                    }
                }
                tokio::time::sleep(Duration::from_millis(25)).await;
            }
            panic!("the script never wrote {}", path.display());
        }

        async fn assert_process_dies(pid: i32) {
            for _ in 0..120 {
                // SAFETY: signal 0 only probes whether the pid exists.
                if unsafe { libc::kill(pid, 0) } != 0 {
                    return;
                }
                tokio::time::sleep(Duration::from_millis(25)).await;
            }
            // SAFETY: as above; clean up our own straggler before failing.
            unsafe { libc::kill(pid, libc::SIGKILL) };
            panic!("process {pid} outlived its shell");
        }

        fn background_sleep_script(pid_file: &Path) -> String {
            format!(
                "sleep 30 & echo $! > {}; wait",
                cli_discovery::shell_quote(pid_file.as_os_str())
            )
        }

        #[tokio::test]
        async fn cancellation_kills_the_whole_process_group() {
            let temp = tempfile::tempdir().expect("tempdir");
            let pid_file = temp.path().join("pid");
            let cancellation = CancellationToken::new();
            let (output_tx, _output_rx) = terminal_output_channel();
            let script = background_sleep_script(&pid_file);
            let run = run_shell(
                invocation("/bin/sh"),
                &script,
                temp.path(),
                output_tx,
                cancellation.clone(),
            );
            let cancel = async {
                let pid = wait_for_pid(&pid_file).await;
                cancellation.cancel();
                pid
            };

            let (result, pid) = tokio::join!(run, cancel);

            assert_eq!(result.unwrap_err(), "Shell command interrupted by user.");
            assert_process_dies(pid).await;
        }

        /// What happens when the service exits or dies mid-run: the run's
        /// future goes away with its end of the lifeline.
        #[tokio::test]
        async fn dropping_the_run_kills_the_whole_process_group() {
            let temp = tempfile::tempdir().expect("tempdir");
            let pid_file = temp.path().join("pid");
            let (output_tx, _output_rx) = terminal_output_channel();
            let script = background_sleep_script(&pid_file);
            let run = run_shell(
                invocation("/bin/sh"),
                &script,
                temp.path(),
                output_tx,
                CancellationToken::new(),
            );

            let pid = tokio::select! {
                _ = run => panic!("the script should still be running"),
                pid = wait_for_pid(&pid_file) => pid,
            };

            assert_process_dies(pid).await;
        }
    }
}
