//! Optional host control of a CLI subprocess's private POSIX session.

use std::ffi::OsStr;
use std::fmt;
use std::future::Future;
use std::io;
use std::pin::Pin;
use std::process::ExitStatus;
use std::sync::Arc;
use std::time::Duration;

use tokio::process::{Child, Command};

#[cfg(unix)]
mod anchor;

pub trait ChildSessionObserver: Send + Sync {
    /// Called for an unanchored launch. Anchored launches use `record_anchor`
    /// to establish ownership before letting the provider exec.
    fn started(&self, pid: u32);

    /// Called after the leader has exited, before the transport reaps it.
    /// The PID and session ID remain reserved until this future finishes.
    fn before_reap(&self, pid: u32) -> Pin<Box<dyn Future<Output = ()> + Send + '_>>;

    fn observation_failed(&self, _pid: u32, _error: &io::Error) {}

    /// Persist the private session's anchor before allowing the provider to exec.
    fn record_anchor(&self, _leader: u32, _anchor: u32) -> AnchorRecord<'_> {
        Box::pin(async { Err(io::Error::other("missing process ownership recorder")) })
    }

    fn launch_failed(&self) {}
}

pub type AnchorRecord<'a> = Pin<Box<dyn Future<Output = io::Result<()>> + Send + 'a>>;

#[derive(Clone)]
pub struct ChildSession {
    observer: Arc<dyn ChildSessionObserver>,
    #[cfg(unix)]
    launcher: Option<std::path::PathBuf>,
}

impl fmt::Debug for ChildSession {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("ChildSession").finish_non_exhaustive()
    }
}

impl ChildSession {
    pub fn new(observer: Arc<dyn ChildSessionObserver>) -> Self {
        Self {
            observer,
            #[cfg(unix)]
            launcher: None,
        }
    }

    #[cfg(unix)]
    pub fn with_anchor(
        observer: Arc<dyn ChildSessionObserver>,
        launcher: std::path::PathBuf,
    ) -> Self {
        Self {
            observer,
            launcher: Some(launcher),
        }
    }

    pub async fn spawn(&self, mut command: Command) -> io::Result<Child> {
        self.prepare(&mut command);
        #[cfg(unix)]
        if let Some(launcher) = &self.launcher {
            if command.as_std().get_program() != launcher.as_os_str()
                || command.as_std().get_args().next() != Some(OsStr::new(anchor::LAUNCH_ARG))
            {
                return Err(io::Error::other(
                    "the owned session requires its launch helper",
                ));
            }
            return self.spawn_anchored(command).await;
        }
        let child = command.spawn()?;
        self.started(&child);
        Ok(child)
    }

    #[cfg(unix)]
    async fn spawn_anchored(&self, command: Command) -> io::Result<Child> {
        // Once exec is authorized, the transport must still own the child if
        // its caller cancels the launch. A cancelled receiver triggers cleanup.
        let session = self.clone();
        let (mut result, receive) = tokio::sync::oneshot::channel();
        tokio::spawn(async move {
            let launched = anchor::spawn(command, &mut result, &*session.observer).await;
            if launched.is_err() {
                session.observer.launch_failed();
            }
            if let Err(undelivered) = result.send(launched.map(|child| PendingChild {
                child: Some(child),
                session,
                runtime: tokio::runtime::Handle::current(),
            })) {
                drop(undelivered);
            }
        });
        tokio::time::timeout(anchor::LAUNCH_TIMEOUT, receive)
            .await
            .map_err(|_| io::Error::from(io::ErrorKind::TimedOut))?
            .map_err(io::Error::other)?
            .map(PendingChild::take)
    }

    fn prepare(&self, command: &mut Command) {
        #[cfg(unix)]
        // SAFETY: the closure only calls an async-signal-safe syscall before exec.
        unsafe {
            command.pre_exec(|| {
                if libc::setsid() == -1 {
                    return Err(io::Error::last_os_error());
                }
                Ok(())
            });
        }
        #[cfg(not(unix))]
        let _ = command;
    }

    fn started(&self, child: &Child) {
        if let Some(pid) = child.id() {
            self.observer.started(pid);
        }
    }

    /// Give the direct leader time to shut down before forcing it to exit.
    /// Observe the leader separately so a deadline cannot cancel descendant
    /// cleanup or reap the leader ahead of that cleanup.
    pub async fn terminate(&self, child: &mut Child, grace: Duration) -> io::Result<ExitStatus> {
        #[cfg(unix)]
        if let Some(pid) = child.id() {
            // SAFETY: this handle still owns the child and hasn't reaped it.
            let sent = unsafe { libc::kill(pid as libc::pid_t, libc::SIGTERM) };
            if sent != 0 && io::Error::last_os_error().raw_os_error() != Some(libc::ESRCH) {
                child.start_kill()?;
            }
            match tokio::time::timeout(grace, wait_before_reap(pid)).await {
                Ok(result) => {
                    result.inspect_err(|error| self.observer.observation_failed(pid, error))?;
                }
                Err(_) => child.start_kill()?,
            }
        }
        #[cfg(not(unix))]
        {
            let _ = grace;
            child.start_kill()?;
        }
        wait_for_child(child, Some(self)).await
    }
}

/// Build the command before applying its environment, resource limits and
/// working directory so a private launcher inherits the same configuration.
pub fn session_command(program: impl AsRef<OsStr>, session: Option<&ChildSession>) -> Command {
    #[cfg(unix)]
    if let Some(launcher) = session.and_then(|session| session.launcher.as_ref()) {
        let mut command = Command::new(launcher);
        command.arg(anchor::LAUNCH_ARG).arg(program);
        // Make the target's environment explicit, including a caller's later
        // env_clear. The helper itself will run with an empty environment.
        command.env_clear().envs(std::env::vars_os());
        return command;
    }
    #[cfg(not(unix))]
    let _ = session;
    Command::new(program)
}

/// A host executable handles these private modes before it initializes any
/// runtime or reads settings. Ordinary invocations are left to the host.
pub fn process_session_entrypoint() -> Option<io::Result<()>> {
    #[cfg(unix)]
    return anchor::entrypoint();
    #[cfg(not(unix))]
    None
}

/// A successful send does not transfer ownership until the receiving future
/// actually takes it. Cancellation on either side still runs the same drain.
#[cfg(unix)]
struct PendingChild {
    child: Option<Child>,
    session: ChildSession,
    runtime: tokio::runtime::Handle,
}

#[cfg(unix)]
impl PendingChild {
    fn take(mut self) -> Child {
        self.child.take().expect("the launch still owns its child")
    }
}

#[cfg(unix)]
impl Drop for PendingChild {
    fn drop(&mut self) {
        if let Some(mut child) = self.child.take() {
            let session = self.session.clone();
            self.runtime.spawn(async move {
                if let Err(error) = session.terminate(&mut child, Duration::from_secs(2)).await {
                    tracing::warn!(%error, "could not finish stopping a cancelled CLI launch");
                }
            });
        }
    }
}

/// The transport must keep sole ownership of `child` and call this instead
/// of `try_wait`, `wait` or `kill` (which all can reap the leader).
pub async fn wait_for_child(
    child: &mut Child,
    session: Option<&ChildSession>,
) -> io::Result<ExitStatus> {
    observe_child_exit(child, session)
        .await?
        .reap(child, session)
        .await
}

/// An observed exit can be selected against a stop request. Descendant cleanup
/// happens only once the transport has chosen its path and owns the wait.
#[must_use]
pub struct ObservedChildExit {
    status: ExitStatus,
    reaped: bool,
}

impl From<ExitStatus> for ObservedChildExit {
    fn from(status: ExitStatus) -> Self {
        Self {
            status,
            reaped: true,
        }
    }
}

impl ObservedChildExit {
    pub fn status(&self) -> ExitStatus {
        self.status
    }

    pub async fn reap(
        self,
        child: &mut Child,
        session: Option<&ChildSession>,
    ) -> io::Result<ExitStatus> {
        if self.reaped {
            return Ok(self.status);
        }
        if let (Some(session), Some(pid)) = (session, child.id()) {
            session.observer.before_reap(pid).await;
        }
        child.wait().await
    }
}

pub async fn observe_child_exit(
    child: &mut Child,
    session: Option<&ChildSession>,
) -> io::Result<ObservedChildExit> {
    #[cfg(unix)]
    if let (Some(session), Some(pid)) = (session, child.id()) {
        let status = wait_before_reap(pid)
            .await
            .inspect_err(|error| session.observer.observation_failed(pid, error))?;
        return Ok(ObservedChildExit {
            status,
            reaped: false,
        });
    }
    #[cfg(not(unix))]
    let _ = session;
    child.wait().await.map(ObservedChildExit::from)
}

#[cfg(unix)]
async fn wait_before_reap(pid: u32) -> io::Result<ExitStatus> {
    use tokio::signal::unix::{signal, SignalKind};

    let mut changes = signal(SignalKind::child())?;
    let pid = libc::id_t::try_from(pid).map_err(io::Error::other)?;
    loop {
        if let Some(status) = exited_without_reaping(pid)? {
            return Ok(status);
        }
        changes
            .recv()
            .await
            .ok_or_else(|| io::Error::other("child exit notifications closed"))?;
    }
}

#[cfg(unix)]
fn exited_without_reaping(pid: libc::id_t) -> io::Result<Option<ExitStatus>> {
    use std::os::unix::process::ExitStatusExt;
    loop {
        // SAFETY: siginfo is writable and zero-initialized in case no state
        // was reported. WNOWAIT reserves the direct child's identity.
        let mut info: libc::siginfo_t = unsafe { std::mem::zeroed() };
        let result = unsafe {
            libc::waitid(
                libc::P_PID,
                pid,
                &mut info,
                libc::WEXITED | libc::WNOHANG | libc::WNOWAIT,
            )
        };
        if result != 0 {
            let error = io::Error::last_os_error();
            if error.kind() == io::ErrorKind::Interrupted {
                continue;
            }
            return Err(error);
        }
        // SAFETY: waitid supplies si_pid and si_status for a reported exit.
        if unsafe { info.si_pid() } == 0 {
            return Ok(None);
        }
        let status = unsafe { info.si_status() };
        let raw = match info.si_code {
            libc::CLD_EXITED => status << 8,
            libc::CLD_KILLED => status,
            libc::CLD_DUMPED => status | 0x80,
            _ => {
                return Err(io::Error::other(
                    "waitid returned an unexpected child exit state",
                ))
            }
        };
        return Ok(Some(ExitStatus::from_raw(raw)));
    }
}
