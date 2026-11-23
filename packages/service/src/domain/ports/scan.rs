//! Raw OS process/socket enumeration.
//!
//! Listening sockets come from `lsof`, through a thin wrapper plus a pure
//! parser so attribution logic can be tested without a live process tree.
//! The process tree comes from `shared::process_table`, and process working
//! directories are read directly from the kernel (`proc_pidinfo` on macOS,
//! `/proc/<pid>/cwd` on Linux) to avoid a second `lsof` pass that can wedge
//! on unreachable mounts. Other platforms have neither table, so port
//! scanning reports an error there instead of falling back to `lsof`.

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

/// `lsof` stats every mount it reports on and is known to wedge on an
/// unreachable network or FUSE mount. Give up after a short timeout and let
/// the cache's negative backoff protect the service until the next scan.
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

/// A scan tool outlived [`COMMAND_TIMEOUT`] (typically `lsof` stuck on an
/// unreachable mount). Kept distinct so the cache can back off from it.
#[derive(Debug)]
pub struct ScanTimeout {
    pub program: String,
}

impl std::fmt::Display for ScanTimeout {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "`{}` timed out after {COMMAND_TIMEOUT:?}", self.program)
    }
}

impl std::error::Error for ScanTimeout {}

pub async fn listening_sockets() -> anyhow::Result<Vec<ListenSocket>> {
    let out = capture("lsof", &["-nP", "-iTCP", "-sTCP:LISTEN", "-F", "pcn"]).await?;
    Ok(parse_listen_sockets(&out))
}

/// Map of pid -> parent pid for every process on the machine.
pub async fn parent_map() -> anyhow::Result<HashMap<i32, i32>> {
    crate::shared::process_table::parents()
        .await
        .map_err(|error| anyhow::anyhow!("could not read the process table: {error}"))
}

/// Working directory of each requested pid. Pids that have exited between the
/// socket scan and this call (or belong to another user) are simply absent.
/// Paths that are not UTF-8 are kept lossily: the feature directories they
/// are matched against are UTF-8, and a lossy name below one still matches.
pub async fn cwd_map(pids: &[i32]) -> anyhow::Result<HashMap<i32, String>> {
    if pids.is_empty() {
        return Ok(HashMap::new());
    }
    let paths = crate::shared::process_table::cwds(pids)
        .await
        .map_err(|error| anyhow::anyhow!("could not read process directories: {error}"))?;
    Ok(paths
        .into_iter()
        .filter_map(|(pid, path)| {
            let path = path.to_string_lossy().into_owned();
            (!path.is_empty()).then_some((pid, path))
        })
        .collect())
}

/// Run a command and return stdout. `lsof` exits non-zero when nothing matched,
/// which is a normal empty result rather than a failure — only a spawn error or
/// a non-zero exit that also wrote to stderr is reported as one.
///
/// `kill_on_drop` matters as much as the timeout: without it, a child outlives
/// the dropped future both on timeout and when a client disconnects mid-request.
async fn capture(program: &str, args: &[&str]) -> anyhow::Result<String> {
    let run = Command::new(program)
        .args(args)
        .stdin(Stdio::null())
        .kill_on_drop(true)
        .output();
    let output = tokio::time::timeout(COMMAND_TIMEOUT, run)
        .await
        .map_err(|_| {
            anyhow::Error::from(ScanTimeout {
                program: program.to_owned(),
            })
        })?
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

    #[cfg(any(target_os = "macos", target_os = "linux"))]
    #[tokio::test]
    async fn cwd_map_resolves_current_process_cwd_and_skips_invalid_pids() {
        let self_pid = i32::try_from(std::process::id()).unwrap();
        let expected = std::fs::canonicalize(std::env::current_dir().unwrap()).unwrap();

        let cwds = cwd_map(&[self_pid, -1, 0]).await.unwrap();

        let resolved = cwds
            .get(&self_pid)
            .expect("current process cwd must resolve");
        assert_eq!(std::fs::canonicalize(resolved).unwrap(), expected);
        assert!(!cwds.contains_key(&-1));
        assert!(!cwds.contains_key(&0));
    }
}
