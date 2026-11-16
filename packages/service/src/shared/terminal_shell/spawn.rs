//! Start a user shell that can write to a terminal but never read from one.

use std::ffi::CStr;
use std::io;
use std::os::fd::{AsRawFd, FromRawFd, OwnedFd, RawFd};
use std::path::{Path, PathBuf};

use super::ShellInvocation;

/// Leads the session and runs the user's shell as a foreground child (not
/// the last command, so sh cannot exec it). A session leader without a
/// controlling terminal that opens one without `O_NOCTTY` acquires it —
/// macOS does so even for a write-only open, and bash, sh, dash and ksh
/// redirections never pass that flag — so the user's shell must not lead.
///
/// Its stdin is the service's lifeline, a pipe whose write end only the
/// service holds and never writes to. A
/// background watcher kills the whole process group once it reads
/// end-of-file, which comes as soon as the service lets go of the pipe — it
/// cancels the run, drops it, exits, or dies to `kill -9`. Without a
/// controlling terminal there is no SIGHUP to do this.
const SESSION_LEADER_SCRIPT: &str = r#"exec 3<&0 </dev/null
(read -r lifeline <&3; kill -KILL 0) >/dev/null 2>&1 &
watcher=$!
exec 3<&-
"$@"
status=$?
kill "$watcher" 2>/dev/null
exit "$status""#;

pub(super) struct SpawnedShell {
    pub child: tokio::process::Child,
    /// PTY master: the script's output once it attaches the terminal.
    pub terminal: OwnedFd,
    /// PTY slave, held until the shell exits so the master does not see
    /// end-of-file before the script has opened the terminal by path.
    pub terminal_slave: OwnedFd,
    /// Read end of the pipe startup files (and non-POSIX scripts) write to.
    pub startup_output: OwnedFd,
    /// Write end of the lifeline: dropping it kills the process group.
    pub lifeline: OwnedFd,
}

/// A PTY whose slave `script_for` may reopen (write-only) by path.
pub(super) struct Terminal {
    master: OwnedFd,
    slave: OwnedFd,
    pub path: PathBuf,
}

/// Spawn `shell` running `script` in `cwd`: stdin on `/dev/null`, stdout and
/// stderr on a pipe, no controlling terminal, and no terminal descriptor at
/// all — bash, as an interactive login shell, closes inherited descriptors
/// 3–19, so the script reopens the terminal by path instead. The returned
/// child is the `/bin/sh` session leader, whose exit status is the shell's.
pub(super) fn spawn_shell(
    shell: &ShellInvocation,
    terminal: Terminal,
    script: &str,
    cwd: &Path,
) -> io::Result<SpawnedShell> {
    let (startup_output, startup_input) = io::pipe()?;
    let (lifeline_end, lifeline) = io::pipe()?;
    let mut command = tokio::process::Command::new("/bin/sh");
    command
        .args(["-c", SESSION_LEADER_SCRIPT, "sh", &shell.program])
        .args(&shell.args)
        .arg(script)
        .current_dir(cwd)
        .stdin(lifeline_end)
        .stdout(startup_input.try_clone()?)
        .stderr(startup_input)
        .env("TERM", "xterm-256color")
        // The renderer is truecolor-capable. Without this, TUIs that probe
        // COLORTERM quantize their palettes to the 256-color cube.
        .env("COLORTERM", "truecolor")
        .env("FORCE_COLOR", "1")
        // Git cannot reach a terminal here anyway; this makes it say so.
        .env("GIT_TERMINAL_PROMPT", "0");
    crate::shared::security::scrub_service_only_env(&mut command);
    detach_from_terminal(&mut command);
    // SAFETY: `reset_signals` only makes async-signal-safe libc calls.
    unsafe {
        command.pre_exec(reset_signals);
    }
    let child = command.spawn()?;
    Ok(SpawnedShell {
        child,
        terminal: terminal.master,
        terminal_slave: terminal.slave,
        startup_output: startup_output.into(),
        lifeline: lifeline.into(),
    })
}

/// Run the command in a new session, which has no controlling terminal: any
/// `open("/dev/tty")` fails at once instead of waiting for input nobody can
/// type (or, under `pnpm dev`, stealing it from the developer's terminal).
/// The child also leads a process group whose id is its pid.
pub(crate) fn detach_from_terminal(command: &mut tokio::process::Command) {
    // SAFETY: setsid(2) is async-signal-safe and touches no memory.
    unsafe {
        command.pre_exec(|| {
            if libc::setsid() == -1 {
                return Err(io::Error::last_os_error());
            }
            Ok(())
        });
    }
}

/// Same reset portable-pty applied: do not hand down the service's ignored
/// or default-changed signals.
fn reset_signals() -> io::Result<()> {
    for signal in [
        libc::SIGCHLD,
        libc::SIGHUP,
        libc::SIGINT,
        libc::SIGQUIT,
        libc::SIGTERM,
        libc::SIGALRM,
    ] {
        // SAFETY: signal(2) is async-signal-safe.
        unsafe { libc::signal(signal, libc::SIG_DFL) };
    }
    Ok(())
}

/// Open a 24×120 PTY. Both ends close on exec: the shell never inherits them.
pub(super) fn open_terminal() -> io::Result<Terminal> {
    let mut master: RawFd = -1;
    let mut slave: RawFd = -1;
    let mut size = libc::winsize {
        ws_row: 24,
        ws_col: 120,
        ws_xpixel: 0,
        ws_ypixel: 0,
    };
    // SAFETY: every pointer refers to live storage owned by this frame.
    #[allow(clippy::unnecessary_mut_passed)]
    let result = unsafe {
        libc::openpty(
            &mut master,
            &mut slave,
            std::ptr::null_mut(),
            std::ptr::null_mut(),
            &mut size,
        )
    };
    if result != 0 {
        return Err(io::Error::last_os_error());
    }
    // SAFETY: openpty succeeded, so both descriptors are open and ours.
    let (master, slave) = unsafe { (OwnedFd::from_raw_fd(master), OwnedFd::from_raw_fd(slave)) };
    set_close_on_exec(&master)?;
    set_close_on_exec(&slave)?;
    let path = terminal_path(&slave)?;
    Ok(Terminal {
        master,
        slave,
        path,
    })
}

fn terminal_path(slave: &OwnedFd) -> io::Result<PathBuf> {
    let mut buffer = [0 as libc::c_char; 128];
    // SAFETY: ttyname_r writes a NUL-terminated name within `buffer`.
    let result = unsafe { libc::ttyname_r(slave.as_raw_fd(), buffer.as_mut_ptr(), buffer.len()) };
    if result != 0 {
        return Err(io::Error::from_raw_os_error(result));
    }
    // SAFETY: on success the buffer holds a NUL-terminated string.
    let name = unsafe { CStr::from_ptr(buffer.as_ptr()) };
    Ok(PathBuf::from(name.to_string_lossy().into_owned()))
}

fn set_close_on_exec(fd: &OwnedFd) -> io::Result<()> {
    // SAFETY: fcntl(2) on a descriptor this function borrows.
    if unsafe { libc::fcntl(fd.as_raw_fd(), libc::F_SETFD, libc::FD_CLOEXEC) } == -1 {
        return Err(io::Error::last_os_error());
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::process::Stdio;

    #[tokio::test]
    async fn a_detached_command_cannot_open_the_controlling_terminal() {
        let mut command = tokio::process::Command::new("/bin/sh");
        command
            .args(["-c", "exec </dev/tty"])
            .stdin(Stdio::null())
            .stderr(Stdio::null());
        detach_from_terminal(&mut command);

        let status = command.status().await.expect("spawn /bin/sh");

        assert!(!status.success(), "a detached child reached /dev/tty");
    }

    #[test]
    fn the_terminal_closes_on_exec_and_names_its_device() {
        let terminal = open_terminal().expect("openpty");
        for fd in [&terminal.master, &terminal.slave] {
            // SAFETY: fcntl(2) on a live descriptor.
            let flags = unsafe { libc::fcntl(fd.as_raw_fd(), libc::F_GETFD) };
            assert_eq!(flags & libc::FD_CLOEXEC, libc::FD_CLOEXEC);
        }
        assert!(terminal.path.starts_with("/dev/"), "{:?}", terminal.path);
    }
}
