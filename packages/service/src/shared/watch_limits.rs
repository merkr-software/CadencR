//! Turn file-watcher start failures into actionable messages.
//!
//! Linux watches each directory of a recursive tree with its own inotify watch
//! and gives every watcher its own inotify instance, so a large monorepo or
//! many open worktrees exhaust the per-user limits
//! (`fs.inotify.max_user_watches` → `ENOSPC`, which notify reports as
//! `MaxFilesWatch`; `fs.inotify.max_user_instances` → `EMFILE`). The raw error
//! ("No space left on device") sends users looking at their disk, so these
//! cases carry the sysctl fix instead.

use notify_debouncer_mini::notify::{Error, ErrorKind};

const LIMIT_HINT: &str = "The system file-watch limit is exhausted. On Linux, raise it with \
`echo -e 'fs.inotify.max_user_watches=524288\\nfs.inotify.max_user_instances=1024' | \
sudo tee /etc/sysctl.d/90-cadencr-inotify.conf && sudo sysctl --system`, then reopen the project.";

/// `context: error`, plus the inotify hint when the error is a watch-limit one.
pub fn describe_watch_error(context: &str, error: &Error) -> String {
    if is_watch_limit_error(&error.kind) {
        format!("{context}: {error}. {LIMIT_HINT}")
    } else {
        format!("{context}: {error}")
    }
}

/// Whether `kind` is the system watch limit, which no retry fixes.
pub(crate) fn is_watch_limit_error(kind: &ErrorKind) -> bool {
    match kind {
        ErrorKind::MaxFilesWatch => true,
        ErrorKind::Io(io) => matches!(io.raw_os_error(), Some(libc::ENOSPC | libc::EMFILE)),
        _ => false,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn max_files_watch_gets_the_sysctl_hint() {
        let message =
            describe_watch_error("git watcher watch", &Error::new(ErrorKind::MaxFilesWatch));
        assert!(message.starts_with("git watcher watch: "));
        assert!(message.contains("fs.inotify.max_user_watches"));
    }

    #[test]
    fn instance_exhaustion_gets_the_sysctl_hint() {
        let error = Error::io(std::io::Error::from_raw_os_error(libc::EMFILE));
        assert!(describe_watch_error("watch", &error).contains("max_user_instances"));
        let error = Error::io(std::io::Error::from_raw_os_error(libc::ENOSPC));
        assert!(describe_watch_error("watch", &error).contains("max_user_watches"));
    }

    #[test]
    fn unrelated_errors_stay_unchanged() {
        let message = describe_watch_error("watch", &Error::path_not_found());
        assert!(!message.contains("inotify"));
        let error = Error::io(std::io::Error::from_raw_os_error(libc::EACCES));
        assert!(!describe_watch_error("watch", &error).contains("inotify"));
    }
}
