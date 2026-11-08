//! Processes a test starts, stopped even when the test fails first.
//!
//! A target is resolved and signalled only on drop, when the test may
//! already have ended it, so the guard never signals the test runner's own
//! process or process group, whatever a reused id now points at.

use std::path::PathBuf;

/// SIGKILLs, once dropped, the processes and process groups it was given,
/// so a test that fails before its own cleanup does not leave a `sleep`
/// running for minutes after the suite.
#[derive(Default)]
pub struct KillOnDrop {
    processes: Vec<u32>,
    groups: Vec<u32>,
    groups_of_pid_files: Vec<PathBuf>,
}

impl KillOnDrop {
    pub fn process(mut self, pid: u32) -> Self {
        self.processes.push(pid);
        self
    }

    pub fn group(mut self, pgid: u32) -> Self {
        self.groups.push(pgid);
        self
    }

    /// The group of the process whose pid `path` holds, if it was written.
    pub fn group_of_pid_in(mut self, path: impl Into<PathBuf>) -> Self {
        self.groups_of_pid_files.push(path.into());
        self
    }
}

impl Drop for KillOnDrop {
    fn drop(&mut self) {
        let from_files = self.groups_of_pid_files.iter().filter_map(|path| {
            let pid: libc::pid_t = std::fs::read_to_string(path).ok()?.trim().parse().ok()?;
            // SAFETY: getpgid only reads the process table.
            let pgid = unsafe { libc::getpgid(pid) };
            (pgid > 0).then_some(pgid)
        });
        let groups = self
            .groups
            .iter()
            .filter_map(|pgid| libc::pid_t::try_from(*pgid).ok())
            .chain(from_files)
            .map(|pgid| -pgid);
        let processes = self
            .processes
            .iter()
            .filter_map(|pid| libc::pid_t::try_from(*pid).ok());
        // SAFETY: getpid/getpgrp only read this process's own ids.
        let (own_pid, own_group) = unsafe { (libc::getpid(), libc::getpgrp()) };
        let spared =
            |target: &libc::pid_t| target.abs() <= 1 || *target == own_pid || *target == -own_group;
        for target in groups.chain(processes).filter(|target| !spared(target)) {
            // SAFETY: kill takes plain integers; a vanished target is ESRCH.
            unsafe { libc::kill(target, libc::SIGKILL) };
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn kills_processes_and_groups_it_holds() {
        let mut process = std::process::Command::new("sleep")
            .arg("30")
            .spawn()
            .unwrap();
        let mut group = {
            use std::os::unix::process::CommandExt;
            std::process::Command::new("sleep")
                .arg("30")
                .process_group(0)
                .spawn()
                .unwrap()
        };
        let directory = tempfile::tempdir().unwrap();
        let pid_file = directory.path().join("child.pid");
        let mut by_file = {
            use std::os::unix::process::CommandExt;
            std::process::Command::new("sleep")
                .arg("30")
                .process_group(0)
                .spawn()
                .unwrap()
        };
        std::fs::write(&pid_file, by_file.id().to_string()).unwrap();

        drop(
            KillOnDrop::default()
                .process(process.id())
                .group(group.id())
                .group_of_pid_in(&pid_file)
                .group_of_pid_in(directory.path().join("never-written.pid")),
        );
        // The runner's own group, as a reused pid in a pid file could resolve to.
        let own_pid_file = directory.path().join("own.pid");
        std::fs::write(&own_pid_file, std::process::id().to_string()).unwrap();
        drop(
            KillOnDrop::default()
                .process(std::process::id())
                .group_of_pid_in(&own_pid_file),
        );
        for child in [&mut process, &mut group, &mut by_file] {
            use std::os::unix::process::ExitStatusExt;
            assert_eq!(child.wait().unwrap().signal(), Some(libc::SIGKILL));
        }
    }
}
