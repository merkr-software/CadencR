use std::collections::HashMap;
use std::io;
use std::path::PathBuf;

use super::{without_deleted_marker, ProcessLinks};

pub(super) fn cwds(pids: &[i32]) -> io::Result<HashMap<i32, PathBuf>> {
    let mut out = HashMap::new();
    for &pid in pids {
        if pid <= 0 || out.contains_key(&pid) {
            continue;
        }
        match std::fs::read_link(format!("/proc/{pid}/cwd")) {
            Ok(path) => {
                out.insert(pid, without_deleted_marker(path, |path| path.exists()));
            }
            // Exited (ENOENT, or ESRCH while it is torn down) or another
            // user's process (EACCES).
            Err(error)
                if matches!(
                    error.raw_os_error(),
                    Some(libc::ENOENT | libc::ESRCH | libc::EACCES)
                ) => {}
            Err(error) => {
                return Err(io::Error::new(
                    error.kind(),
                    format!("read /proc/{pid}/cwd: {error}"),
                ))
            }
        }
    }
    Ok(out)
}

pub(super) fn links() -> io::Result<HashMap<i32, ProcessLinks>> {
    let mut links = HashMap::new();
    for entry in std::fs::read_dir("/proc")? {
        let entry = entry?;
        let Some(pid) = entry
            .file_name()
            .to_str()
            .and_then(|name| name.parse().ok())
        else {
            continue;
        };
        // Unreadable once the process has exited: not in the table.
        let Ok(stat) = std::fs::read(entry.path().join("stat")) else {
            continue;
        };
        if let Some(found) = stat_links(&stat) {
            links.insert(pid, found);
        }
    }
    Ok(links)
}

/// The kernel's tick count, which `ps -o lstart` would round through the
/// wall clock (and can shift by a second between calls).
pub(super) fn start_time(pid: u32) -> Option<String> {
    let stat = std::fs::read(format!("/proc/{pid}/stat")).ok()?;
    stat_fields(&stat)?.nth(22 - 3).map(str::to_string)
}

/// A Linux process group can still exist with only unreaped zombies.
pub(super) fn group_has_live_member(pgid: libc::pid_t) -> io::Result<bool> {
    for entry in std::fs::read_dir("/proc")? {
        let entry = entry?;
        let Some(pid) = entry
            .file_name()
            .to_str()
            .and_then(|name| name.parse().ok())
        else {
            continue;
        };
        // SAFETY: getpgid only reads the process table.
        if unsafe { libc::getpgid(pid) } != pgid {
            continue;
        }
        let stat = match std::fs::read(entry.path().join("stat")) {
            Ok(stat) => stat,
            Err(error) if matches!(error.raw_os_error(), Some(libc::ENOENT | libc::ESRCH)) => {
                continue
            }
            Err(error) => return Err(error),
        };
        let live = member_is_live(&stat, pgid).ok_or_else(|| {
            io::Error::new(
                io::ErrorKind::InvalidData,
                format!("invalid /proc/{pid}/stat"),
            )
        })?;
        if live {
            return Ok(true);
        }
    }
    Ok(false)
}

fn member_is_live(stat: &[u8], pgid: libc::pid_t) -> Option<bool> {
    let mut fields = stat_fields(stat)?;
    let state = fields.next()?;
    let group = fields.nth(1)?.parse::<libc::pid_t>().ok()?;
    // Linux can show a zombie for a thread-group leader while another
    // thread is still alive and can hold the process's resources.
    let threads = fields.nth(14)?.parse::<usize>().ok()?;
    Some(group == pgid && (!matches!(state, "Z" | "X") || threads > 1))
}

/// Fields 3 onward of `/proc/<pid>/stat`. The command name (field 2) is in
/// parentheses and may itself contain spaces and parentheses, so fields are
/// counted from the last `)`.
fn stat_fields(stat: &[u8]) -> Option<std::str::SplitWhitespace<'_>> {
    // The kernel does not require the command name itself to be UTF-8.
    let end_of_comm = stat.iter().rposition(|byte| *byte == b')')?;
    Some(
        std::str::from_utf8(&stat[end_of_comm + 1..])
            .ok()?
            .split_whitespace(),
    )
}

/// Fields 4 (parent) and 5 (process group).
fn stat_links(stat: &[u8]) -> Option<ProcessLinks> {
    let mut fields = stat_fields(stat)?.skip(1);
    Some(ProcessLinks {
        ppid: fields.next()?.parse().ok()?,
        pgid: fields.next()?.parse().ok()?,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn stat_fields_are_read_past_a_command_name_with_spaces() {
        let stat = b"4242 (my (odd) cmd) S 1 4242 4242 0 -1 4194560 120 0 0 0 1 2 0 0 \
                    20 0 1 0 987654 1000 10";
        assert_eq!(
            stat_links(stat),
            Some(ProcessLinks {
                ppid: 1,
                pgid: 4242
            })
        );
        assert_eq!(stat_fields(stat).unwrap().nth(22 - 3), Some("987654"));
        assert_eq!(stat_links(b"garbage"), None);
    }

    /// A process whose directory was removed keeps that path, as on macOS.
    #[tokio::test]
    async fn a_removed_cwd_reads_as_its_last_path_on_linux() {
        let root = tempfile::tempdir().unwrap();
        let dir = root.path().join("gone");
        std::fs::create_dir(&dir).unwrap();
        let mut child = std::process::Command::new("sleep")
            .arg("30")
            .current_dir(&dir)
            .spawn()
            .unwrap();
        std::fs::remove_dir(&dir).unwrap();
        let pid = i32::try_from(child.id()).unwrap();

        let found = crate::shared::process_table::cwds(&[pid]).await;
        child.kill().unwrap();
        child.wait().unwrap();

        assert_eq!(found.unwrap().get(&pid), Some(&dir));
    }

    #[test]
    fn an_unreaped_linux_process_does_not_keep_its_group_live() {
        use std::os::unix::process::CommandExt;

        let mut child = std::process::Command::new("true")
            .process_group(0)
            .spawn()
            .unwrap();
        let pid = child.id();
        let mut info = std::mem::MaybeUninit::<libc::siginfo_t>::uninit();
        // SAFETY: waitid writes to the writable siginfo buffer and WNOWAIT
        // leaves the exited child in the process table for the assertions.
        let result = unsafe {
            libc::waitid(
                libc::P_PID,
                pid,
                info.as_mut_ptr(),
                libc::WEXITED | libc::WNOWAIT,
            )
        };
        assert_eq!(result, 0, "{}", io::Error::last_os_error());
        assert!(crate::shared::process_group::try_signal_process_group(pid, 0).is_ok());
        assert!(!group_has_live_member(pid as libc::pid_t).unwrap());
        child.wait().unwrap();
    }
}
