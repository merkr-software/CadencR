//! Tie the service's life to the desktop shell that spawned it.
//!
//! Electron starts the packaged service with `--exit-with-parent` and a stdin
//! pipe it never writes to. However the shell ends — a clean quit, a crash, a
//! force-quit — the kernel closes its end of the pipe, and the read here sees
//! end-of-file. That works the same on macOS and Linux, unlike a parent-death
//! signal (`PR_SET_PDEATHSIG` is Linux-only) or polling the parent pid (which
//! a re-parented orphan cannot distinguish from a live parent on macOS).
//!
//! The watch takes the pipe off file descriptor 0 and puts `/dev/null` there
//! instead: every child the service spawns inherits an input that ends at
//! once, as it did when the shell ignored stdin, never a pipe that stays open
//! for the app's whole life.
//!
//! The read runs on a plain OS thread, not tokio's blocking pool: a blocking
//! stdin read never returns while the shell lives, and a pool task would hold
//! the runtime's shutdown hostage after a SIGTERM.

use std::io::Read;

use tokio::sync::oneshot;

/// Resolves once the desktop shell is gone. A watch that could not be set up
/// (or whose read failed) never resolves: the service keeps running rather
/// than quitting on a pipe it cannot read, and the failure is logged.
pub struct ParentWatch {
    exited: Option<oneshot::Receiver<()>>,
}

impl ParentWatch {
    pub async fn exited(self) {
        if let Some(exited) = self.exited {
            if exited.await.is_ok() {
                return;
            }
        }
        std::future::pending::<()>().await
    }
}

/// Start watching now, before anything spawns a child.
pub fn watch_parent() -> ParentWatch {
    match take_stdin() {
        Ok(input) => end_of_input(input),
        Err(error) => {
            tracing::error!(%error, "could not watch stdin; the service will not stop with the desktop shell");
            ParentWatch { exited: None }
        }
    }
}

/// The pipe Electron holds, moved off fd 0, which now reads `/dev/null`.
#[cfg(unix)]
fn take_stdin() -> std::io::Result<Box<dyn Read + Send>> {
    use std::os::fd::{AsFd, AsRawFd};
    let pipe = std::io::stdin().as_fd().try_clone_to_owned()?;
    let null = std::fs::File::open("/dev/null")?;
    // SAFETY: both descriptors are open and owned for the whole call; dup2
    // atomically repoints fd 0 and leaves `null` itself open until it drops.
    if unsafe { libc::dup2(null.as_raw_fd(), libc::STDIN_FILENO) } == -1 {
        return Err(std::io::Error::last_os_error());
    }
    Ok(Box::new(std::fs::File::from(pipe)))
}

#[cfg(not(unix))]
fn take_stdin() -> std::io::Result<Box<dyn Read + Send>> {
    Ok(Box::new(std::io::stdin()))
}

/// Resolves when `input` reaches end-of-file. A read error never resolves it.
fn end_of_input<R>(input: R) -> ParentWatch
where
    R: Read + Send + 'static,
{
    let (tx, rx) = oneshot::channel();
    let spawned = std::thread::Builder::new()
        .name("parent-lifetime".into())
        .spawn(move || {
            let mut input = input;
            match std::io::copy(&mut input, &mut std::io::sink()) {
                Ok(_) => {
                    let _ = tx.send(());
                }
                Err(error) => tracing::error!(
                    %error,
                    "reading stdin failed; the service will not stop with the desktop shell"
                ),
            }
        });
    match spawned {
        Ok(_) => ParentWatch { exited: Some(rx) },
        Err(error) => {
            tracing::error!(%error, "could not watch stdin; the service will not stop with the desktop shell");
            ParentWatch { exited: None }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::end_of_input;
    use std::io::{Error, ErrorKind, Read};
    use std::time::Duration;

    #[tokio::test]
    async fn resolves_once_the_parent_closes_the_pipe() {
        let (reader, writer) = std::io::pipe().unwrap();
        let exited = end_of_input(reader).exited();
        tokio::pin!(exited);
        assert!(tokio::time::timeout(Duration::from_millis(50), &mut exited)
            .await
            .is_err());
        drop(writer);
        tokio::time::timeout(Duration::from_secs(5), exited)
            .await
            .expect("end-of-file must resolve the watch");
    }

    struct Broken;
    impl Read for Broken {
        fn read(&mut self, _: &mut [u8]) -> std::io::Result<usize> {
            Err(Error::new(ErrorKind::PermissionDenied, "denied"))
        }
    }

    #[tokio::test]
    async fn a_read_error_does_not_stop_the_service() {
        let exited = end_of_input(Broken).exited();
        assert!(tokio::time::timeout(Duration::from_millis(100), exited)
            .await
            .is_err());
    }
}
