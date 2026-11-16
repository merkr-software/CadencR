//! macOS: `lsof`, run directly (no shell), in its machine-readable `-F`
//! format. Without root it reports the user's own processes, which is what
//! the tab can act on anyway.

use std::collections::HashMap;
use std::path::PathBuf;

use crate::ports::{Listening, Snapshot};

#[cfg(not(target_os = "linux"))]
pub use run::snapshot;

/// `lsof -F` output: one field per line, its first character naming it, a
/// `p` line starting each process. Yields `(pid, field, value)`.
fn fields(stdout: &str) -> impl Iterator<Item = (u32, char, &str)> {
    let mut pid = None;
    stdout.lines().filter_map(move |line| {
        let mut chars = line.chars();
        let field = chars.next()?;
        let value = chars.as_str();
        if field == 'p' {
            pid = value.parse().ok();
        }
        Some((pid?, field, value))
    })
}

/// `*:5005`, `127.0.0.1:1420`, `[::1]:3000` → `("[::1]", 3000)`.
fn split_address(name: &str) -> Option<(String, u16)> {
    if name.contains("->") {
        return None; // a connection, not a listener
    }
    let (address, port) = name.rsplit_once(':')?;
    Some((address.to_owned(), port.parse().ok()?))
}

/// `lsof -nP -iTCP -sTCP:LISTEN -FpcLn`: the listening sockets, each
/// process's command and login.
pub fn parse_listening(stdout: &str) -> Snapshot {
    let mut snapshot = Snapshot::default();
    for (pid, field, value) in fields(stdout) {
        let process = snapshot.processes.entry(pid).or_default();
        match field {
            'c' => process.command = value.to_owned(),
            'L' => process.user = Some(value.to_owned()),
            'n' => {
                if let Some((address, port)) = split_address(value) {
                    snapshot.listening.push(Listening { pid, address, port });
                }
            }
            _ => {}
        }
    }
    snapshot
}

/// `lsof -a -d cwd -p <pids> -Fpn`: each process's working directory.
pub fn parse_cwds(stdout: &str) -> HashMap<u32, PathBuf> {
    fields(stdout)
        .filter(|(_, field, _)| *field == 'n')
        .map(|(pid, _, value)| (pid, PathBuf::from(value)))
        .collect()
}

#[cfg(not(target_os = "linux"))]
mod run {
    use std::io::ErrorKind;
    use std::process::{Command, Output, Stdio};

    use cadencr_tab_backend::Error;

    use super::{parse_cwds, parse_listening};
    use crate::ports::Snapshot;

    /// Where macOS keeps it, then `PATH` (Cadencr may run with a short one).
    const LOCATIONS: [&str; 3] = ["/usr/sbin/lsof", "/usr/bin/lsof", "lsof"];

    pub fn snapshot() -> Result<Snapshot, Error> {
        let mut snapshot = parse_listening(&lsof(&[
            "-nP",
            "-iTCP",
            "-sTCP:LISTEN",
            "+c",
            "0",
            "-FpcLn",
        ])?);
        if snapshot.processes.is_empty() {
            return Ok(snapshot);
        }
        let mut pids: Vec<String> = snapshot.processes.keys().map(u32::to_string).collect();
        pids.sort();
        let cwds = parse_cwds(&lsof(&["-a", "-d", "cwd", "-p", &pids.join(","), "-Fpn"])?);
        for (pid, cwd) in cwds {
            if let Some(process) = snapshot.processes.get_mut(&pid) {
                process.cwd = Some(cwd);
            }
        }
        Ok(snapshot)
    }

    fn lsof(args: &[&str]) -> Result<String, Error> {
        for program in LOCATIONS {
            match Command::new(program)
                .args(args)
                .stdin(Stdio::null())
                .output()
            {
                Ok(output) => return interpret(output),
                Err(error) if error.kind() == ErrorKind::NotFound => continue,
                Err(error) => {
                    return Err(Error::new(
                        "LSOF_FAILED",
                        format!("Cannot run {program}: {error}"),
                    ))
                }
            }
        }
        Err(Error::new(
            "LSOF_MISSING",
            "lsof is not installed; the port list needs it",
        ))
    }

    /// `lsof` exits 1 when part of the query matched nothing (no listening
    /// socket, a process gone since): an empty or partial answer, not a
    /// failure — unless all it printed is an error.
    fn interpret(output: Output) -> Result<String, Error> {
        let stdout = String::from_utf8_lossy(&output.stdout).into_owned();
        let stderr = String::from_utf8_lossy(&output.stderr);
        let complaint = stderr.lines().find(|line| !line.trim().is_empty());
        match output.status.code() {
            Some(0) => Ok(stdout),
            Some(1) if !stdout.is_empty() || complaint.is_none() => Ok(stdout),
            status => Err(Error::new(
                "LSOF_FAILED",
                match (complaint, status) {
                    (Some(line), _) => format!("lsof failed: {line}"),
                    (None, Some(code)) => format!("lsof failed with status {code}"),
                    (None, None) => "lsof was killed by a signal".to_owned(),
                },
            )),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const LISTENING: &str = "p941\ncrapportd\nLrle\nf18\nn*:49271\nf19\nn*:49271\n\
        p1245\ncControlCenter\nLrle\nf9\nn*:7000\nf11\nn127.0.0.1:5000\nf12\nn[::1]:5000\n\
        p77\ncnode\nLada\nf20\nnlocalhost:http\n";

    #[test]
    fn parses_listening_sockets_and_their_processes() {
        let snapshot = parse_listening(LISTENING);
        let found: Vec<_> = snapshot
            .listening
            .iter()
            .map(|socket| (socket.pid, socket.address.as_str(), socket.port))
            .collect();
        assert_eq!(
            found,
            [
                (941, "*", 49271),
                (941, "*", 49271),
                (1245, "*", 7000),
                (1245, "127.0.0.1", 5000),
                (1245, "[::1]", 5000),
            ]
        );
        let control_center = &snapshot.processes[&1245];
        assert_eq!(control_center.command, "ControlCenter");
        assert_eq!(control_center.user.as_deref(), Some("rle"));
        // A name lsof could not print numerically is skipped, its process kept.
        assert_eq!(snapshot.processes[&77].command, "node");
    }

    #[test]
    fn splits_addresses_and_skips_connections() {
        assert_eq!(split_address("[::1]:3000"), Some(("[::1]".into(), 3000)));
        assert_eq!(split_address("*:5005"), Some(("*".into(), 5005)));
        assert_eq!(split_address("127.0.0.1:1->127.0.0.1:2"), None);
        assert_eq!(split_address("*:99999"), None);
        assert_eq!(split_address("nothing"), None);
    }

    #[test]
    fn ignores_fields_before_the_first_process() {
        assert!(parse_listening("n*:80\nfoo\n").listening.is_empty());
        assert!(parse_listening("").processes.is_empty());
    }

    #[test]
    fn parses_working_directories() {
        let cwds = parse_cwds("p941\nfcwd\nn/\np1245\nfcwd\nn/Users/rle/My Project\n");
        assert_eq!(cwds[&941], PathBuf::from("/"));
        assert_eq!(cwds[&1245], PathBuf::from("/Users/rle/My Project"));
    }
}
