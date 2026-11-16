//! `serve` reserving stdin and stdout for the protocol, against a real
//! process. A custom harness: this test binary re-executes itself with
//! `--backend` to become the backend under test.

use std::ffi::OsStr;
use std::process::ExitCode;

const BACKEND_FLAG: &str = "--backend";
/// Printed (without a newline, so it sits in std's stdout buffer) before
/// `serve` starts.
const BUFFERED: &str = "buffered before serve";

fn main() -> ExitCode {
    if std::env::args_os().nth(1).as_deref() == Some(OsStr::new(BACKEND_FLAG)) {
        return unix::backend();
    }
    #[cfg(unix)]
    {
        let me = std::env::current_exe().expect("the test binary has a path");
        unix::children_never_read_the_protocol(&me);
        unix::buffered_stdout_goes_to_the_log(&me);
        println!("stdio: all tests passed");
    }
    #[cfg(not(unix))]
    println!("stdio: nothing to test off Unix");
    ExitCode::SUCCESS
}

#[cfg(not(unix))]
mod unix {
    pub fn backend() -> std::process::ExitCode {
        std::process::ExitCode::FAILURE
    }
}

#[cfg(unix)]
mod unix {
    use std::io::{BufRead, BufReader, Read, Write};
    use std::path::Path;
    use std::process::{Child, ChildStdin, Command, ExitCode, Stdio};
    use std::sync::mpsc::{self, Receiver};
    use std::thread;
    use std::time::Duration;

    use cadencr_tab_backend::protocol::HostMessage;
    use cadencr_tab_backend::testing::{sample_hello, TestHost};
    use cadencr_tab_backend::{serve, Context, Error};
    use serde_json::{json, Value};

    use super::{BACKEND_FLAG, BUFFERED};

    const WAIT: Duration = Duration::from_secs(5);

    fn handle(cx: &Context) -> Result<Value, Error> {
        match cx.method() {
            // `cat` inheriting stdin, as `spawn`/`status` do by default.
            "child_stdin" => {
                let output = Command::new("cat")
                    .stdin(Stdio::inherit())
                    .stdout(Stdio::piped())
                    .stderr(Stdio::null())
                    .output()
                    .map_err(|error| Error::internal(error.to_string()))?;
                Ok(json!(String::from_utf8_lossy(&output.stdout)))
            }
            "echo" => Ok(cx.raw_params().clone()),
            other => Err(Error::unknown_method(other)),
        }
    }

    pub fn backend() -> ExitCode {
        print!("{BUFFERED}");
        serve(handle)
    }

    struct Backend {
        child: Child,
        stdin: Option<ChildStdin>,
        lines: Receiver<String>,
    }

    impl Backend {
        fn start(me: &Path) -> Self {
            let mut child = Command::new(me)
                .arg(BACKEND_FLAG)
                .stdin(Stdio::piped())
                .stdout(Stdio::piped())
                .stderr(Stdio::piped())
                .spawn()
                .unwrap();
            let stdout = child.stdout.take().unwrap();
            let (sender, lines) = mpsc::channel();
            thread::spawn(move || {
                for line in BufReader::new(stdout).lines() {
                    if sender.send(line.unwrap()).is_err() {
                        return;
                    }
                }
            });
            let mut backend = Self {
                stdin: child.stdin.take(),
                child,
                lines,
            };
            backend.send(&serde_json::to_string(&HostMessage::Hello(sample_hello())).unwrap());
            backend
        }

        fn send(&mut self, line: &str) {
            let stdin = self.stdin.as_mut().unwrap();
            writeln!(stdin, "{line}").unwrap();
            stdin.flush().unwrap();
        }

        fn next(&self) -> Value {
            let line = self
                .lines
                .recv_timeout(WAIT)
                .expect("the backend answers in time");
            serde_json::from_str(&line).unwrap_or_else(|_| panic!("not a protocol line: {line:?}"))
        }

        /// Close stdin, expect a clean exit, and return stderr.
        fn finish(mut self) -> String {
            drop(self.stdin.take());
            let status = self.child.wait().unwrap();
            assert!(status.success(), "{status}");
            let mut stderr = String::new();
            self.child
                .stderr
                .take()
                .unwrap()
                .read_to_string(&mut stderr)
                .unwrap();
            stderr
        }
    }

    /// A child inheriting stdin sees `/dev/null` (end of file at once), not
    /// the host's request lines.
    pub fn children_never_read_the_protocol(me: &Path) {
        let mut backend = Backend::start(me);
        assert_eq!(backend.next()["type"], "ready");
        backend.send(&TestHost::request("1", "child_stdin", Value::Null));
        // Give a child that could read stdin the chance to take this line.
        thread::sleep(Duration::from_millis(200));
        backend.send(&TestHost::request("2", "echo", json!("still mine")));
        let mut results = [backend.next(), backend.next()];
        results.sort_by_key(|message| message["id"].as_str().unwrap_or("").to_owned());
        assert_eq!(
            results[0],
            json!({"type": "response", "id": "1", "result": ""})
        );
        assert_eq!(
            results[1],
            json!({"type": "response", "id": "2", "result": "still mine"})
        );
        backend.finish();
    }

    /// What std buffered for stdout before `serve` reaches the log, never the
    /// protocol stream: the first stdout line is exactly `ready`.
    pub fn buffered_stdout_goes_to_the_log(me: &Path) {
        let backend = Backend::start(me);
        let ready = backend.next();
        assert_eq!(ready["type"], "ready", "{ready}");
        let stderr = backend.finish();
        assert!(stderr.contains(BUFFERED), "{stderr}");
    }
}
