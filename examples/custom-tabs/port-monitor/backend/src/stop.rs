//! `stop {pid}`: `SIGTERM` to a process that is listening right now and runs
//! in this conversation's folder. Anything else is refused.

use std::io;

use cadencr_tab_backend::{Context, Error};
use serde::Deserialize;
use serde_json::{json, Value};

use crate::ports::{self, Folder, PortEntry};

#[derive(Deserialize)]
struct Params {
    pid: u32,
}

pub fn stop(cx: &Context, folder: &Folder) -> Result<Value, Error> {
    let Params { pid } = cx.params()?;
    let entries = ports::list(folder)?;
    let target = stoppable(&entries, pid, &protected_pids())?;
    terminate(pid)?;
    eprintln!(
        "[port-monitor] sent SIGTERM to {pid} ({}) on port {}",
        target.command, target.port
    );
    Ok(json!({ "stopped": pid }))
}

/// This backend and the Cadencr service that started it, which may well run
/// in the conversation's folder when Cadencr works on itself.
fn protected_pids() -> [u32; 2] {
    [std::process::id(), std::os::unix::process::parent_id()]
}

/// The entry of `pid`, if the tab may stop it.
fn stoppable<'a>(
    entries: &'a [PortEntry],
    pid: u32,
    protected: &[u32],
) -> Result<&'a PortEntry, Error> {
    let target = entries
        .iter()
        .find(|entry| entry.pid == pid)
        .ok_or_else(|| {
            Error::new(
                "NOT_LISTENING",
                format!("Process {pid} is not listening on a port"),
            )
        })?;
    if target.in_folder != Some(true) {
        return Err(Error::new(
            "OUTSIDE_FOLDER",
            format!(
                "Process {pid} ({}) is not running in this conversation's folder",
                target.command
            ),
        ));
    }
    if protected.contains(&pid) {
        return Err(Error::new(
            "CADENCR_PROCESS",
            format!(
                "Process {pid} ({}) is part of Cadencr itself",
                target.command
            ),
        ));
    }
    Ok(target)
}

fn terminate(pid: u32) -> Result<(), Error> {
    // `kill` with 0 or a negative pid signals whole process groups: never.
    let target = libc::pid_t::try_from(pid)
        .ok()
        .filter(|pid| *pid > 0)
        .ok_or_else(|| Error::invalid_params(format!("{pid} is not a process id")))?;
    // SAFETY: `kill` has no memory-safety preconditions.
    if unsafe { libc::kill(target, libc::SIGTERM) } == 0 {
        return Ok(());
    }
    let error = io::Error::last_os_error();
    Err(Error::new(
        "STOP_FAILED",
        format!("Could not stop process {pid}: {error}"),
    ))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn entry(pid: u32, in_folder: Option<bool>) -> PortEntry {
        PortEntry {
            port: 3000,
            pid,
            command: "vite".into(),
            user: None,
            cwd: None,
            addresses: vec!["*".into()],
            in_folder,
        }
    }

    #[test]
    fn stops_only_listening_processes_in_the_folder() {
        let entries = [
            entry(10, Some(true)),
            entry(11, Some(false)),
            entry(12, None),
            entry(13, Some(true)),
        ];
        assert_eq!(stoppable(&entries, 10, &[13]).unwrap().pid, 10);
        let code = |pid| {
            stoppable(&entries, pid, &[13])
                .unwrap_err()
                .code()
                .to_owned()
        };
        assert_eq!(code(11), "OUTSIDE_FOLDER");
        assert_eq!(code(12), "OUTSIDE_FOLDER");
        assert_eq!(code(13), "CADENCR_PROCESS");
        assert_eq!(code(99), "NOT_LISTENING");
    }

    #[test]
    fn never_signals_a_process_group() {
        assert_eq!(terminate(0).unwrap_err().code(), "INVALID_PARAMS");
        assert_eq!(terminate(u32::MAX).unwrap_err().code(), "INVALID_PARAMS");
    }
}
