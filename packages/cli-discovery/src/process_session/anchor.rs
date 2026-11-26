//! The launcher execs before opening the gate, so it has no copy of the
//! service's database lock. The anchor joins its private Unix session and
//! survives the provider, without keeping either one's stdio alive.

use std::ffi::OsStr;
use std::fs::File;
use std::io::{self, Read, Write};
use std::os::fd::{AsRawFd, FromRawFd};
use std::os::unix::process::CommandExt;
use std::process::{Command as StdCommand, Stdio};
use std::time::Duration;

use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::unix::pipe::Receiver;
use tokio::process::{Child, Command};
use tokio::sync::oneshot;

use super::{ChildSessionObserver, PendingChild};

mod descriptors;
mod environment;

pub(super) const LAUNCH_ARG: &str = "--internal-owned-provider-launch";
const ANCHOR_ARG: &str = "--internal-owned-provider-anchor";
const EXEC_STATUS_FD: &str = "CADENCR_OWNED_PROVIDER_EXEC_FD";
pub(super) const LAUNCH_TIMEOUT: Duration = Duration::from_secs(15);
const APPROVE: u8 = 1;

pub(super) async fn spawn(
    mut command: Command,
    result: &mut oneshot::Sender<io::Result<PendingChild>>,
    observer: &dyn ChildSessionObserver,
) -> io::Result<Child> {
    let provider_env = environment::take_from(&mut command)?;
    let (reader, writer) = io::pipe()?;
    let mut exec_status = Receiver::from_owned_fd(reader.into())?;
    command.env(EXEC_STATUS_FD, writer.as_raw_fd().to_string());
    // SAFETY: this fork hook only changes one held descriptor's flag so the
    // fresh launcher can use it. The launcher restores CLOEXEC immediately.
    unsafe { command.pre_exec(move || set_fd_flags(writer.as_raw_fd(), 0)) };
    let mut child = command
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .kill_on_drop(true)
        .spawn()?;
    drop(command);
    let leader = child
        .id()
        .ok_or_else(|| io::Error::other("missing provider launcher PID"))?;
    let output = child
        .stdout
        .as_mut()
        .expect("the launcher has piped stdout");
    let mut anchor = [0; 4];
    tokio::select! {
        () = result.closed() => return Err(interrupted()),
        read = output.read_exact(&mut anchor) => read?,
    };
    let recording = observer.record_anchor(leader, u32::from_ne_bytes(anchor));
    tokio::pin!(recording);
    tokio::select! {
        recorded = &mut recording => recorded?,
        () = result.closed() => {
            // End the handshake immediately. The file write may already be
            // running in a blocking task. Keep its result owned for cleanup.
            // Keep the Child unreaped until the late registration is known.
            drop(child.stdin.take());
            recording.await?;
            return Err(interrupted());
        }
    }
    if result.is_closed() {
        return Err(interrupted());
    }
    let input = child.stdin.as_mut().expect("the launcher has piped stdin");
    tokio::select! {
        () = result.closed() => return Err(interrupted()),
        wrote = async {
            input.write_u8(APPROVE).await?;
            input.write_all(&provider_env).await
        } => wrote?,
    }
    tokio::select! {
        () = result.closed() => return Err(interrupted()),
        ready = output.read_u8() => {
            if ready? != APPROVE {
                return Err(io::Error::other("the provider anchor did not arm"));
            }
        }
    }
    tokio::select! {
        () = result.closed() => return Err(interrupted()),
        status = confirm_exec(&mut exec_status) => status?,
    }
    Ok(child)
}

async fn confirm_exec(pipe: &mut Receiver) -> io::Result<()> {
    let mut errno = [0; 4];
    if pipe.read(&mut errno[..1]).await? == 0 {
        return Ok(());
    }
    pipe.read_exact(&mut errno[1..]).await?;
    Err(io::Error::from_raw_os_error(i32::from_ne_bytes(errno)))
}

fn interrupted() -> io::Error {
    io::Error::from(io::ErrorKind::Interrupted)
}

pub(super) fn entrypoint() -> Option<io::Result<()>> {
    let mut args = std::env::args_os().skip(1);
    let mode = args.next()?;
    if mode == OsStr::new(LAUNCH_ARG) {
        return Some(match args.next() {
            Some(program) => with_exec_status(StdCommand::new(program).args(args)),
            None => Err(io::Error::other("missing provider command")),
        });
    }
    if mode == OsStr::new(ANCHOR_ARG) {
        return Some(run_anchor());
    }
    None
}

fn with_exec_status(command: &mut StdCommand) -> io::Result<()> {
    let fd: i32 = std::env::var(EXEC_STATUS_FD)
        .ok()
        .and_then(|value| value.parse().ok())
        .filter(|&fd| fd >= 3)
        .ok_or_else(|| io::Error::other("missing provider exec status pipe"))?;
    set_fd_flags(fd, libc::FD_CLOEXEC)?;
    // SAFETY: fcntl just verified this is an open non-stdio descriptor which
    // is reserved for our private launch protocol.
    let mut status = unsafe { File::from_raw_fd(fd) };
    let Err(error) = descriptors::close_inherited(fd).and_then(|()| launch(command)) else {
        return Ok(());
    };
    status.write_all(&error.raw_os_error().unwrap_or(libc::EIO).to_ne_bytes())?;
    Err(error)
}

fn set_fd_flags(fd: i32, flags: i32) -> io::Result<()> {
    // SAFETY: F_SETFD only changes flags on a descriptor in this process.
    if unsafe { libc::fcntl(fd, libc::F_SETFD, flags) } < 0 {
        return Err(io::Error::last_os_error());
    }
    Ok(())
}

fn launch(command: &mut StdCommand) -> io::Result<()> {
    let mut intermediate = StdCommand::new(std::env::current_exe()?)
        .arg(ANCHOR_ARG)
        .env_clear()
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()?;
    let mut input = intermediate
        .stdin
        .take()
        .expect("the anchor has piped stdin");
    let mut output = intermediate
        .stdout
        .take()
        .expect("the anchor has piped stdout");
    if !intermediate.wait()?.success() {
        return Err(io::Error::other("could not detach the provider anchor"));
    }
    let mut pid = [0; 4];
    output.read_exact(&mut pid)?;
    announce(&pid)?;
    receive_approval()?;
    environment::read_into(command)?;
    command.env_remove(EXEC_STATUS_FD);
    input.write_all(&[APPROVE])?;
    let mut ready = [0];
    output.read_exact(&mut ready)?;
    if ready[0] != APPROVE {
        return Err(io::Error::other("the provider anchor did not arm"));
    }
    drop(output);
    announce(&ready)?;
    let error = command.exec();
    // On exec success the closed pipe leaves the anchor standing. An exec
    // failure can release it immediately because no provider has run.
    if let Err(release_error) = input.write_all(&[0]) {
        if release_error.kind() != io::ErrorKind::BrokenPipe {
            return Err(release_error);
        }
    }
    Err(error)
}

fn run_anchor() -> io::Result<()> {
    // SAFETY: this private entry point runs in a freshly exec'd process,
    // before the host initializes threads. The provider never has to reap it.
    let child = unsafe { libc::fork() };
    if child < 0 {
        return Err(io::Error::last_os_error());
    }
    if child > 0 {
        return Ok(());
    }
    // Stay in the Unix session, but separate from the provider's group.
    if unsafe { libc::setpgid(0, 0) } != 0 {
        return Err(io::Error::last_os_error());
    }
    announce(&(unsafe { libc::getpid() } as u32).to_ne_bytes())?;
    receive_approval()?;
    announce(&[APPROVE])?;
    if read_gate()?.is_some() {
        return Ok(());
    }
    // Keep stdin's private pipe for identity inspection. stdout is only for
    // the launcher handshake. The anchor never forks or opens other streams.
    unsafe { libc::close(libc::STDOUT_FILENO) };
    loop {
        unsafe { libc::pause() };
    }
}

fn announce(message: &[u8]) -> io::Result<()> {
    let mut stdout = io::stdout().lock();
    stdout.write_all(message)?;
    stdout.flush()
}

fn receive_approval() -> io::Result<()> {
    if read_gate()? != Some(APPROVE) {
        return Err(interrupted());
    }
    Ok(())
}

fn read_gate() -> io::Result<Option<u8>> {
    let mut byte = 0;
    loop {
        // Read exactly one byte without buffering: later bytes belong to the
        // provider, which inherits the original stdin unchanged.
        let read = unsafe { libc::read(libc::STDIN_FILENO, (&mut byte as *mut u8).cast(), 1) };
        match read {
            1 => return Ok(Some(byte)),
            -1 => {
                let error = io::Error::last_os_error();
                if error.kind() != io::ErrorKind::Interrupted {
                    return Err(error);
                }
            }
            _ => return Ok(None),
        }
    }
}

#[cfg(test)]
mod tests {
    use std::future::Future;
    use std::pin::Pin;
    use std::sync::Arc;

    use crate::ChildSession;

    use super::*;

    struct ObserveExit(tokio::sync::Notify);

    impl ChildSessionObserver for ObserveExit {
        fn started(&self, _: u32) {}

        fn before_reap(&self, _: u32) -> Pin<Box<dyn Future<Output = ()> + Send + '_>> {
            Box::pin(async { self.0.notify_one() })
        }
    }

    #[tokio::test]
    async fn cancellation_after_a_successful_send_still_drains_the_child() {
        let observer = Arc::new(ObserveExit(tokio::sync::Notify::new()));
        let session = ChildSession::new(observer.clone());
        let mut command = Command::new("/bin/sleep");
        command.arg("15").kill_on_drop(true);
        let child = session.spawn(command).await.unwrap();
        let (send, receive) = oneshot::channel();
        assert!(send
            .send(PendingChild {
                child: Some(child),
                session,
                runtime: tokio::runtime::Handle::current(),
            })
            .is_ok());
        drop(receive);
        tokio::time::timeout(Duration::from_secs(2), observer.0.notified())
            .await
            .unwrap();
    }
}
