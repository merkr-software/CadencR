//! Keeps stdin and stdout for the protocol.
//!
//! On Unix, [`protocol_stdio`] moves both protocol descriptors out of the
//! way of everything else in the process:
//!
//! - descriptor 0 is duplicated to a private, close-on-exec descriptor the
//!   protocol is read from, and descriptor 0 is pointed at `/dev/null` — so a
//!   child process (`Command::spawn`, `status`, `output` inherit descriptor 0
//!   by default) can never read, and swallow, the host's request lines;
//! - descriptor 1 is duplicated to a private, close-on-exec descriptor that
//!   only this crate writes to, and descriptor 1 is pointed at stderr — so a
//!   stray `println!` (the backend's, a dependency's, or a child's) lands in
//!   the log instead of corrupting the protocol stream.
//!
//! The swaps happen with std's stdin and stdout locks held, and std's stdout
//! buffer is flushed only after descriptor 1 points at stderr: no print from
//! another thread can reach the protocol stream, before `ready` or after.
//! Elsewhere stdin and stdout are used as they are.

use std::io::{self, Read, Write};

/// The protocol's input and output. Call once, before reading stdin
/// any other way.
pub(crate) fn protocol_stdio() -> io::Result<(Box<dyn Read + Send>, Box<dyn Write + Send>)> {
    imp::protocol_stdio()
}

#[cfg(unix)]
mod imp {
    use std::fs::File;
    use std::io::{self, Read, Write};
    use std::os::fd::{AsRawFd, FromRawFd, RawFd};

    pub(super) fn protocol_stdio() -> io::Result<(Box<dyn Read + Send>, Box<dyn Write + Send>)> {
        let input = {
            // Nothing reads descriptor 0 through std while it is swapped.
            let _stdin = io::stdin().lock();
            let private = duplicate(libc::STDIN_FILENO)?;
            // std opens files close-on-exec; `dup2` clears the flag on
            // descriptor 0, so children inherit `/dev/null` there.
            let null = File::open("/dev/null")?;
            replace(libc::STDIN_FILENO, null.as_raw_fd())?;
            private
        };
        let output = {
            let mut stdout = io::stdout().lock();
            let private = duplicate(libc::STDOUT_FILENO)?;
            replace(libc::STDOUT_FILENO, libc::STDERR_FILENO)?;
            // Whatever std buffered before the swap goes to the log now.
            stdout.flush()?;
            private
        };
        Ok((Box::new(input), Box::new(output)))
    }

    /// A private, close-on-exec copy of `fd`, owned by the returned `File`.
    fn duplicate(fd: RawFd) -> io::Result<File> {
        // SAFETY: `fcntl(F_DUPFD_CLOEXEC)` only reads `fd` and returns a new
        // descriptor (or -1); no memory is touched.
        let private = unsafe { libc::fcntl(fd, libc::F_DUPFD_CLOEXEC, 3) };
        if private < 0 {
            return Err(io::Error::last_os_error());
        }
        // SAFETY: `private` was just created above and is owned by nothing
        // else, so the `File` becomes its sole owner.
        Ok(unsafe { File::from_raw_fd(private) })
    }

    /// Point descriptor `target` at what `source` refers to.
    fn replace(target: RawFd, source: RawFd) -> io::Result<()> {
        // SAFETY: `dup2` atomically replaces `target` with a copy of
        // `source`; both are open descriptors of this process.
        if unsafe { libc::dup2(source, target) } < 0 {
            return Err(io::Error::last_os_error());
        }
        Ok(())
    }
}

#[cfg(not(unix))]
mod imp {
    use std::io::{self, Read, Write};

    pub(super) fn protocol_stdio() -> io::Result<(Box<dyn Read + Send>, Box<dyn Write + Send>)> {
        Ok((Box::new(io::stdin()), Box::new(io::stdout())))
    }
}
