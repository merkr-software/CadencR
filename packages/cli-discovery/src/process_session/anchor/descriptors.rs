//! Private helper processes run immediately after exec, before starting any
//! threads. Do not keep a descriptor that an ancestor left inheritable.

use std::io;
use std::os::fd::RawFd;

#[cfg(target_os = "linux")]
const FD_DIRECTORY: &str = "/proc/self/fd";
#[cfg(not(target_os = "linux"))]
const FD_DIRECTORY: &str = "/dev/fd";

pub(super) fn close_inherited(keep: RawFd) -> io::Result<()> {
    let mut inherited = Vec::new();
    for entry in std::fs::read_dir(FD_DIRECTORY)? {
        let name = entry?.file_name();
        if let Some(fd) = name.to_str().and_then(|name| name.parse::<RawFd>().ok()) {
            if fd > libc::STDERR_FILENO && fd != keep {
                inherited.push(fd);
            }
        }
    }
    // The directory iterator has already closed its own descriptor. No
    // other helper thread can open a descriptor between the list and close.
    for fd in inherited {
        loop {
            // SAFETY: descriptors belong to this single-threaded process.
            if unsafe { libc::close(fd) } == 0 {
                break;
            }
            let error = io::Error::last_os_error();
            match error.raw_os_error() {
                Some(libc::EBADF) => break,
                Some(libc::EINTR) => continue,
                _ => return Err(error),
            }
        }
    }
    Ok(())
}
