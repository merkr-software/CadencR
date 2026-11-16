//! Check a backend binary against the stdio protocol (feature `conformance`).
//!
//! [`run`] spawns the binary the way the Cadencr host does (piped stdio, no
//! arguments, the tab folder as working directory, no `CADENCR_*`/`VITE_*`
//! environment, on Unix its own process group, killed at the end so nothing
//! it started survives), sends a `hello` with a dummy API address and token
//! and a fresh temporary `state_dir` (removed afterwards), and checks, in
//! order:
//!
//! | Check | Passes when |
//! |---|---|
//! | `starts` | the binary can be spawned |
//! | `ready` | the very first stdout line is a `ready` object naming the expected protocol (the host's rule: any other first line stops the backend), within [`READY_TIMEOUT`] |
//! | `unknown_method` | an unknown method is answered with an error response carrying the same id, and the process stays alive |
//! | `malformed_line` | a non-JSON line and a request without an id are survived: a later request is still answered |
//! | `concurrent_requests` | two requests sent back to back are both answered |
//! | `exit_on_stdin_close` | closing stdin makes the process exit with status 0 within [`EXIT_GRACE`] (else it is killed) |
//! | `stdout_clean` | every stdout line was a protocol message |
//!
//! It works with any backend, whatever its language: only the binary is used.

use std::ffi::OsString;
use std::path::{Path, PathBuf};
use std::time::Duration;

use serde_json::json;

use crate::protocol::{
    ApiInfo, Hello, HostMessage, PluginInfo, EXIT_GRACE, PROTOCOL_VERSION, READY_TIMEOUT,
};
use crate::testing::{sample_hello, TestHost};

mod backend;
mod ready;
mod report;
use backend::{working_dir, Backend, StateDir};
use ready::check_ready;
pub use report::{Check, CheckName, CheckStatus, Report};

/// A method no backend implements.
const UNKNOWN_METHOD: &str = "__cadencr_conformance_unknown_method__";

/// How [`run`] drives the backend. `Options::default()` mirrors the host.
#[derive(Debug, Clone, bon::Builder)]
pub struct Options {
    /// Working directory; the binary's folder when unset. The host uses the
    /// tab folder.
    #[builder(into)]
    cwd: Option<PathBuf>,
    /// Arguments for the binary. The host passes none: this is for test
    /// harnesses whose one binary plays several roles.
    #[builder(default)]
    args: Vec<OsString>,
    /// The protocol the tab declares (`backend.protocol` in `tab.json`):
    /// sent in `hello` and expected in `ready`. Defaults to this crate's
    /// [`PROTOCOL_VERSION`].
    #[builder(default = PROTOCOL_VERSION)]
    protocol: u32,
    #[builder(default = READY_TIMEOUT)]
    ready_timeout: Duration,
    /// How long each probe request may take.
    #[builder(default = Duration::from_secs(5))]
    request_timeout: Duration,
    #[builder(default = EXIT_GRACE)]
    exit_timeout: Duration,
}

impl Default for Options {
    fn default() -> Self {
        Self::builder().build()
    }
}

/// Spawn `binary` and check it; the process never outlives the call.
pub fn run(binary: &Path, options: &Options) -> Report {
    let cwd = working_dir(binary, options.cwd.as_deref());
    let state_dir = match StateDir::create() {
        Ok(state_dir) => state_dir,
        Err(error) => return not_started(format!("cannot create a state directory: {error}")),
    };
    let mut backend = match Backend::spawn(binary, &options.args, &cwd) {
        Ok(backend) => backend,
        Err(error) => return not_started(format!("cannot start {}: {error}", binary.display())),
    };
    let mut checks = vec![Check::passed(
        CheckName::Starts,
        format!("in {}", cwd.display()),
    )];
    let ready = check_ready(
        &mut backend,
        options,
        &conformance_hello(&cwd, state_dir.path(), options.protocol),
    );
    let ready_ok = ready.status == CheckStatus::Passed;
    checks.push(ready);
    if ready_ok {
        checks.push(check_unknown_method(&mut backend, options));
        checks.push(check_malformed_line(&mut backend, options));
        checks.push(check_concurrent_requests(&mut backend, options));
    } else {
        checks.extend(skipped(
            CheckName::UnknownMethod,
            CheckName::ConcurrentRequests,
        ));
    }
    checks.push(check_exit(&mut backend, options));
    checks.push(check_stdout_clean(&mut backend));
    Report {
        checks,
        stderr_tail: backend.stderr_tail(),
    }
}

fn not_started(detail: String) -> Report {
    let mut checks = vec![Check::failed(CheckName::Starts, detail)];
    checks.extend(skipped(CheckName::Ready, CheckName::StdoutClean));
    Report {
        checks,
        stderr_tail: Vec::new(),
    }
}

/// The checks from `first` through `last`, in run order, not run.
fn skipped(first: CheckName, last: CheckName) -> Vec<Check> {
    CheckName::ALL[first as usize..=last as usize]
        .iter()
        .map(|name| Check::new(*name, CheckStatus::Skipped, "an earlier check failed"))
        .collect()
}

fn conformance_hello(cwd: &Path, state_dir: &Path, protocol: u32) -> String {
    let sample = sample_hello();
    let hello = HostMessage::Hello(Hello {
        protocol,
        plugin: PluginInfo {
            id: "conformance.check".into(),
            version: "0.0.0".into(),
        },
        worktree: cwd.canonicalize().unwrap_or_else(|_| cwd.to_path_buf()),
        state_dir: state_dir.to_path_buf(),
        // Nothing listens at its address: conformance never needs the API.
        api: ApiInfo {
            token: "conformance-token".into(),
            ..sample.api
        },
        ..sample
    });
    serde_json::to_string(&hello).expect("a hello serializes")
}

fn request(id: &str) -> String {
    TestHost::request(id, UNKNOWN_METHOD, json!({}))
}

fn millis(duration: Duration) -> u128 {
    duration.as_millis()
}

/// `None` while alive, else why it is a failure.
fn still_alive(backend: &mut Backend) -> Option<String> {
    match backend.exited() {
        Ok(None) => None,
        Ok(Some(status)) => Some(format!("the backend exited ({status})")),
        Err(error) => Some(format!("cannot tell whether the backend runs: {error}")),
    }
}

/// Send `ids` back to back, then wait for every response.
fn exchange(
    backend: &mut Backend,
    ids: &[&str],
    timeout: Duration,
) -> Result<Vec<serde_json::Value>, String> {
    for id in ids {
        backend
            .send(&request(id))
            .map_err(|error| format!("could not write request {id}: {error}"))?;
    }
    ids.iter()
        .map(|id| {
            backend.response(id, timeout).ok_or_else(|| {
                format!("no response with id \"{id}\" within {} ms", millis(timeout))
            })
        })
        .collect()
}

fn check_unknown_method(backend: &mut Backend, options: &Options) -> Check {
    const NAME: CheckName = CheckName::UnknownMethod;
    let response = match exchange(backend, &["conformance-unknown"], options.request_timeout) {
        Ok(mut responses) => responses.remove(0),
        Err(detail) => return Check::failed(NAME, detail),
    };
    let error = &response["error"];
    if !error["code"].is_string() || !error["message"].is_string() {
        return Check::failed(
            NAME,
            format!("expected an error with a string `code` and `message`, got {response}"),
        );
    }
    match still_alive(backend) {
        Some(detail) => Check::failed(NAME, detail),
        None => Check::passed(NAME, format!("answered with {}", error["code"])),
    }
}

fn check_malformed_line(backend: &mut Backend, options: &Options) -> Check {
    const NAME: CheckName = CheckName::MalformedLine;
    let malformed = ["this is not JSON", r#"{"type":"request","method":"x"}"#];
    for line in malformed {
        if let Err(error) = backend.send(line) {
            return Check::failed(NAME, format!("could not write a malformed line: {error}"));
        }
    }
    if let Err(detail) = exchange(
        backend,
        &["conformance-after-malformed"],
        options.request_timeout,
    ) {
        return Check::failed(NAME, format!("after two malformed lines: {detail}"));
    }
    match still_alive(backend) {
        Some(detail) => Check::failed(NAME, detail),
        None => Check::passed(NAME, "still answering after two malformed lines"),
    }
}

fn check_concurrent_requests(backend: &mut Backend, options: &Options) -> Check {
    const NAME: CheckName = CheckName::ConcurrentRequests;
    let ids = ["conformance-concurrent-1", "conformance-concurrent-2"];
    match exchange(backend, &ids, options.request_timeout) {
        Ok(_) => Check::passed(NAME, "both answered"),
        Err(detail) => Check::failed(NAME, detail),
    }
}

fn check_exit(backend: &mut Backend, options: &Options) -> Check {
    const NAME: CheckName = CheckName::ExitOnStdinClose;
    let limit = millis(options.exit_timeout);
    match backend.close_and_wait(options.exit_timeout) {
        Ok(Some(status)) if status.success() => {
            Check::passed(NAME, format!("exited with status 0 within {limit} ms"))
        }
        Ok(Some(status)) => Check::failed(
            NAME,
            format!("exited with {status}; the host records a non-zero exit as a crash"),
        ),
        Ok(None) => Check::failed(
            NAME,
            format!("still running {limit} ms after stdin closed; it was killed"),
        ),
        Err(error) => Check::failed(NAME, format!("cannot wait for the backend: {error}")),
    }
}

fn check_stdout_clean(backend: &mut Backend) -> Check {
    const NAME: CheckName = CheckName::StdoutClean;
    backend.drain_stdout(Duration::from_millis(200));
    match backend.stray.as_slice() {
        [] => Check::passed(NAME, "only protocol messages"),
        stray => Check::failed(
            NAME,
            format!(
                "{} stdout line(s) are not protocol messages, first: {:?}",
                stray.len(),
                stray[0]
            ),
        ),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn skipping_names_a_run_order_span() {
        let names: Vec<&str> = skipped(CheckName::UnknownMethod, CheckName::ConcurrentRequests)
            .iter()
            .map(|check| check.name.as_str())
            .collect();
        assert_eq!(
            names,
            ["unknown_method", "malformed_line", "concurrent_requests"]
        );
    }
}
