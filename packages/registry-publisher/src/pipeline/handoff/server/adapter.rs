//! Bounded frozen-fixture adapter process; no pipe can fill while waiting on exit.
use serde_json::Value;
use std::io::{Read as _, Seek as _};
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

const LIMIT: u64 = 2 * 1024 * 1024;

pub(super) fn load(input: Value) -> std::io::Result<Value> {
    let adapter =
        std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("src/pipeline/handoff/rebase.mjs");
    let mut command = Command::new("node");
    // This adapter pins archived hashes and restricts timestamp/crypto field changes.
    command.arg("--input-type=module").arg("-e")
        .arg("const {loadCapture}=await import(process.argv[1]); console.log(JSON.stringify(await loadCapture(JSON.parse(process.argv[2]))));")
        .arg(adapter).arg(input.to_string());
    serde_json::from_slice(&run(&mut command, Duration::from_secs(5))?)
        .map_err(std::io::Error::other)
}

fn run(command: &mut Command, timeout: Duration) -> std::io::Result<Vec<u8>> {
    let mut stdout = tempfile::tempfile()?;
    let mut stderr = tempfile::tempfile()?;
    let mut child = command
        .stdin(Stdio::null())
        .stdout(stdout.try_clone()?)
        .stderr(stderr.try_clone()?)
        .spawn()?;
    let deadline = Instant::now() + timeout;
    loop {
        match child.try_wait() {
            Ok(Some(status)) => {
                stdout.rewind()?;
                stderr.rewind()?;
                let mut output = Vec::new();
                (&mut stdout).take(LIMIT + 1).read_to_end(&mut output)?;
                if output.len() as u64 > LIMIT {
                    return Err(std::io::Error::other("adapter output exceeded limit"));
                }
                if status.success() {
                    return Ok(output);
                }
                let mut error = String::new();
                stderr.take(LIMIT).read_to_string(&mut error)?;
                return Err(std::io::Error::other(error));
            }
            Err(error) => {
                let _ = child.kill();
                child.wait()?;
                return Err(error);
            }
            Ok(None) if Instant::now() >= deadline => {
                let killed = child.kill();
                child.wait()?;
                killed?;
                return Err(std::io::Error::new(
                    std::io::ErrorKind::TimedOut,
                    "fixture adapter timed out and was reaped",
                ));
            }
            Ok(None) => std::thread::sleep(Duration::from_millis(10)),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn stalled_adapter_is_killed_and_reaped_without_full_pipe_deadlock() {
        let dir = tempfile::tempdir().unwrap();
        let pid_file = dir.path().join("pid");
        let mut command = Command::new("node");
        command.arg("-e").arg("require('fs').writeFileSync(process.argv[1], String(process.pid)); process.stdout.write('x'.repeat(256*1024)); setInterval(()=>{},1000)")
            .arg(&pid_file);
        let start = Instant::now();
        let error = run(&mut command, Duration::from_millis(500)).unwrap_err();
        assert_eq!(error.kind(), std::io::ErrorKind::TimedOut);
        assert!(start.elapsed() < Duration::from_secs(3));
        #[cfg(unix)]
        {
            let pid: i32 = std::fs::read_to_string(pid_file).unwrap().parse().unwrap();
            // A reaped child is neither running nor a zombie owned by this process.
            assert_eq!(
                unsafe { libc::waitpid(pid, std::ptr::null_mut(), libc::WNOHANG) },
                -1
            );
            assert_eq!(
                std::io::Error::last_os_error().raw_os_error(),
                Some(libc::ECHILD)
            );
        }
    }
}
