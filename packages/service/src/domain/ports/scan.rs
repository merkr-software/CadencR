//! Raw OS process/socket enumeration.
//!
//! Everything here is a thin wrapper around `lsof` and `ps` plus the pure
//! parsers for their output. Parsing is separated from spawning so the
//! attribution logic can be tested without a live process tree.

use std::collections::HashMap;
use std::process::Stdio;
use std::time::Duration;

use tokio::process::Command;

/// A TCP socket in LISTEN state.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ListenSocket {
    pub pid: i32,
    pub command: String,
    pub port: u16,
}

/// Cap on how many pids we hand to a single `lsof -p` invocation, so a machine
/// with an unusual number of listeners can't build an over-long argv.
const CWD_BATCH: usize = 256;

/// `lsof` stats every mount it reports on and is known to wedge on an
/// unreachable network or FUSE mount. The caller holds a process-wide lock
/// across the scan, so a hang here would stall every future poll: give up
/// instead and let the next scan try again.
const COMMAND_TIMEOUT: Duration = Duration::from_secs(5);

/// A required system tool is not installed (spawn failed with `NotFound`).
/// Kept distinct so the API can tell the user what to install instead of
/// reporting an opaque internal error — `lsof` is absent from minimal Linux
/// installs (Arch, Fedora minimal, containers).
#[derive(Debug)]
pub struct MissingTool {
    pub program: String,
}

impl std::fmt::Display for MissingTool {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "`{}` is not installed", self.program)
    }
}

impl std::error::Error for MissingTool {}

pub async fn listening_sockets() -> anyhow::Result<Vec<ListenSocket>> {
    let out = capture("lsof", &["-nP", "-iTCP", "-sTCP:LISTEN", "-F", "pcn"]).await?;
    Ok(parse_listen_sockets(&out))
}

/// Map of pid -> parent pid for every process on the machine.
pub async fn parent_map() -> anyhow::Result<HashMap<i32, i32>> {
    let out = capture("ps", parent_map_args(cfg!(target_os = "macos"))).await?;
    Ok(parse_parent_map(&out))
}

/// BSD `ps -ax` on macOS (unchanged); POSIX `-A` elsewhere, which procps-ng on
/// Linux documents for "every process" without relying on BSD flag parsing.
fn parent_map_args(is_macos: bool) -> &'static [&'static str] {
    if is_macos {
        &["-axo", "pid=,ppid="]
    } else {
        &["-Ao", "pid=,ppid="]
    }
}

/// Working directory of each requested pid. Pids that have exited between the
/// socket scan and this call are simply absent from the map.
pub async fn cwd_map(pids: &[i32]) -> anyhow::Result<HashMap<i32, String>> {
    let mut cwds = HashMap::new();
    for chunk in pids.chunks(CWD_BATCH) {
        let list = chunk
            .iter()
            .map(i32::to_string)
            .collect::<Vec<_>>()
            .join(",");
        let out = capture("lsof", &["-a", "-d", "cwd", "-F", "pn", "-p", &list]).await?;
        cwds.extend(parse_cwd_map(&out));
    }
    Ok(cwds)
}

/// Run a command and return stdout. `lsof` exits non-zero when nothing matched,
/// which is a normal empty result rather than a failure — only a spawn error or
/// a non-zero exit that also wrote to stderr is reported as one.
///
/// `kill_on_drop` matters as much as the timeout: without it, a child outlives
/// the dropped future both on timeout and when a client disconnects mid-request.
pub(crate) async fn capture(program: &str, args: &[&str]) -> anyhow::Result<String> {
    let run = Command::new(program)
        .args(args)
        .stdin(Stdio::null())
        .kill_on_drop(true)
        .output();
    let output = tokio::time::timeout(COMMAND_TIMEOUT, run)
        .await
        .map_err(|_| anyhow::anyhow!("`{program}` timed out after {COMMAND_TIMEOUT:?}"))?
        .map_err(|error| spawn_error(program, error))?;
    let stdout = String::from_utf8_lossy(&output.stdout).into_owned();
    if !output.status.success() && stdout.trim().is_empty() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        let stderr = stderr.trim();
        if !stderr.is_empty() {
            anyhow::bail!("`{program}` failed: {stderr}");
        }
    }
    Ok(stdout)
}

fn spawn_error(program: &str, error: std::io::Error) -> anyhow::Error {
    if error.kind() == std::io::ErrorKind::NotFound {
        return MissingTool {
            program: program.to_owned(),
        }
        .into();
    }
    anyhow::anyhow!("could not run `{program}`: {error}")
}

/// Parse `lsof -F pcn` output. Fields arrive as one-character-tagged lines,
/// grouped per process: `p<pid>` and `c<command>` followed by one `n<name>` per
/// open file.
fn parse_listen_sockets(output: &str) -> Vec<ListenSocket> {
    let mut sockets = Vec::new();
    let mut pid: Option<i32> = None;
    let mut command = String::new();
    for line in output.lines() {
        let Some((tag, value)) = split_field(line) else {
            continue;
        };
        match tag {
            'p' => {
                pid = value.trim().parse().ok();
                command.clear();
            }
            'c' => command = value.to_owned(),
            'n' => {
                let (Some(pid), Some(port)) = (pid, parse_listen_port(value)) else {
                    continue;
                };
                sockets.push(ListenSocket {
                    pid,
                    command: command.clone(),
                    port,
                });
            }
            _ => {}
        }
    }
    sockets
}

/// Parse `lsof -d cwd -F pn` output into pid -> working directory.
fn parse_cwd_map(output: &str) -> HashMap<i32, String> {
    let mut cwds = HashMap::new();
    let mut pid: Option<i32> = None;
    for line in output.lines() {
        let Some((tag, value)) = split_field(line) else {
            continue;
        };
        match tag {
            'p' => pid = value.trim().parse().ok(),
            'n' => {
                if let Some(pid) = pid {
                    cwds.entry(pid).or_insert_with(|| value.to_owned());
                }
            }
            _ => {}
        }
    }
    cwds
}

/// Parse `ps -axo pid=,ppid=` output into pid -> parent pid.
fn parse_parent_map(output: &str) -> HashMap<i32, i32> {
    let mut parents = HashMap::new();
    for line in output.lines() {
        let mut fields = line.split_whitespace();
        let (Some(pid), Some(ppid)) = (fields.next(), fields.next()) else {
            continue;
        };
        if let (Ok(pid), Ok(ppid)) = (pid.parse::<i32>(), ppid.parse::<i32>()) {
            parents.insert(pid, ppid);
        }
    }
    parents
}

fn split_field(line: &str) -> Option<(char, &str)> {
    let mut chars = line.chars();
    let tag = chars.next()?;
    Some((tag, chars.as_str()))
}

/// Port from an lsof socket name (`*:3000`, `127.0.0.1:5005`, `[::1]:8080`).
/// Wildcard ports (`*:*`) and anything that isn't a plain listening endpoint
/// yield `None`. The bind address is parsed only to validate the shape — a
/// server is identified to the user by its port, and the same one is commonly
/// bound several times over.
fn parse_listen_port(name: &str) -> Option<u16> {
    let name = name.split_whitespace().next()?;
    if name.contains("->") {
        return None;
    }
    let (address, port) = name.rsplit_once(':')?;
    if address.is_empty() {
        return None;
    }
    port.parse().ok()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_listen_sockets_grouped_by_process() {
        let out = "p101\ncnode\nf12\nn*:3000\nn127.0.0.1:3001\np202\ncpython3\nf7\nn[::1]:8000\n";

        let sockets = parse_listen_sockets(out);

        assert_eq!(
            sockets,
            vec![
                ListenSocket {
                    pid: 101,
                    command: "node".into(),
                    port: 3000
                },
                ListenSocket {
                    pid: 101,
                    command: "node".into(),
                    port: 3001
                },
                ListenSocket {
                    pid: 202,
                    command: "python3".into(),
                    port: 8000
                },
            ]
        );
    }

    #[test]
    fn skips_wildcard_ports_and_connected_sockets() {
        let out = "p1\ncnode\nn*:*\nn127.0.0.1:5432->127.0.0.1:9999\nn*:4000\n";

        let sockets = parse_listen_sockets(out);

        assert_eq!(sockets.len(), 1);
        assert_eq!(sockets[0].port, 4000);
    }

    #[test]
    fn keeps_the_first_cwd_reported_for_a_pid() {
        let out = "p11\nn/Users/me/work\np22\nn/tmp\nn/ignored\n";

        let cwds = parse_cwd_map(out);

        assert_eq!(cwds.get(&11).map(String::as_str), Some("/Users/me/work"));
        assert_eq!(cwds.get(&22).map(String::as_str), Some("/tmp"));
    }

    #[test]
    fn missing_program_is_reported_as_a_missing_tool() {
        let error = spawn_error("lsof", std::io::Error::from(std::io::ErrorKind::NotFound));
        let missing = error
            .downcast_ref::<MissingTool>()
            .expect("typed missing tool");
        assert_eq!(missing.program, "lsof");
        let other = spawn_error(
            "lsof",
            std::io::Error::from(std::io::ErrorKind::PermissionDenied),
        );
        assert!(other.downcast_ref::<MissingTool>().is_none());
    }

    #[test]
    fn ps_arguments_per_platform() {
        assert_eq!(parent_map_args(true), ["-axo", "pid=,ppid="]);
        assert_eq!(parent_map_args(false), ["-Ao", "pid=,ppid="]);
    }

    #[test]
    fn parses_ps_parent_columns() {
        let out = "  501     1\n  733   501\nbroken line\n";

        let parents = parse_parent_map(out);

        assert_eq!(parents.get(&501), Some(&1));
        assert_eq!(parents.get(&733), Some(&501));
        assert_eq!(parents.len(), 2);
    }
}
