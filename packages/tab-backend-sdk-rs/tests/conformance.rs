//! `conformance::run` against real processes. A custom harness: this test
//! binary re-executes itself with `--backend` to become the echo example, so
//! the backend under test needs no separate build step or target-dir lookup.

use std::io::Write;
use std::path::Path;
use std::process::{Command, ExitCode, Stdio};
use std::time::Duration;

use cadencr_tab_backend::conformance::{self, CheckStatus, Options, Report};
use cadencr_tab_backend::protocol::{HostMessage, MAX_LINE_BYTES};
use cadencr_tab_backend::testing::{sample_hello, TestHost};
use serde_json::{json, Value};

#[path = "../examples/echo.rs"]
mod echo;

const BACKEND_FLAG: &str = "--backend";
/// The echo backend after a line of chatter on stdout.
const CHATTY_FLAG: &str = "--chatty";
/// The echo backend after a stderr line over the protocol's line limit.
const LONG_STDERR_FLAG: &str = "--long-stderr";
/// The echo backend after recording its environment and starting a
/// long-lived grandchild, in the file named by the next argument.
#[cfg(unix)]
const PROBE_FLAG: &str = "--probe";
const AFTER_LONG_LINE: &str = "written after the long line";

fn main() -> ExitCode {
    let args: Vec<_> = std::env::args_os().collect();
    match args.get(1).and_then(|flag| flag.to_str()) {
        Some(BACKEND_FLAG) => return echo::main(),
        Some(CHATTY_FLAG) => {
            println!("starting up...");
            return echo::main();
        }
        Some(LONG_STDERR_FLAG) => {
            let long = "x".repeat(MAX_LINE_BYTES + 1);
            eprintln!("{long}");
            eprintln!("{AFTER_LONG_LINE}");
            return echo::main();
        }
        #[cfg(unix)]
        Some(PROBE_FLAG) => {
            unix::probe(Path::new(&args[2]));
            return echo::main();
        }
        _ => {}
    }
    let me = std::env::current_exe().expect("the test binary has a path");
    echo_backend_conforms(&me);
    stray_stdout_goes_to_the_log(&me);
    ready_must_be_the_first_line(&me);
    the_declared_protocol_is_used(&me);
    stderr_is_drained_past_long_lines(&me);
    #[cfg(unix)]
    unix::spawned_like_the_host(&me);
    #[cfg(unix)]
    a_non_backend_fails(Path::new("/bin/cat"));
    a_missing_binary_fails();
    println!("conformance: all tests passed");
    ExitCode::SUCCESS
}

fn status(report: &Report, name: &str) -> CheckStatus {
    let check = report.checks.iter().find(|check| check.name == name);
    check.unwrap_or_else(|| panic!("no `{name}` check")).status
}

fn echo_backend_conforms(me: &Path) {
    let options = Options::builder().args(vec![BACKEND_FLAG.into()]).build();
    let report = conformance::run(me, &options);
    print!("{report}");
    assert!(
        report.passed(),
        "{report}\nstderr: {:?}",
        report.stderr_tail
    );
    assert_eq!(report.checks.len(), 7);
    assert!(report
        .checks
        .iter()
        .all(|check| check.status == CheckStatus::Passed));
}

fn stray_stdout_goes_to_the_log(me: &Path) {
    let mut child = Command::new(me)
        .arg(BACKEND_FLAG)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .unwrap();
    let hello = serde_json::to_string(&HostMessage::Hello(sample_hello())).unwrap();
    let input = [
        hello,
        TestHost::request("1", "print", Value::Null),
        TestHost::request("2", "echo", json!("after print")),
    ]
    .join("\n");
    let mut stdin = child.stdin.take().unwrap();
    writeln!(stdin, "{input}").unwrap();
    // Give both requests time to be answered before stdin closes, since the
    // backend abandons unanswered requests at that point.
    std::thread::sleep(Duration::from_millis(500));
    drop(stdin);
    let output = child.wait_with_output().unwrap();
    assert!(output.status.success());
    let stdout = String::from_utf8(output.stdout).unwrap();
    let types: Vec<String> = stdout
        .lines()
        .map(|line| {
            let message: Value = serde_json::from_str(line).expect("stdout holds only JSON");
            message["type"].as_str().unwrap().to_owned()
        })
        .collect();
    assert_eq!(types, ["ready", "response", "response"], "{stdout}");
    let stderr = String::from_utf8_lossy(&output.stderr);
    assert!(stderr.contains("this goes to the log"), "{stderr}");
}

#[cfg(unix)]
fn a_non_backend_fails(cat: &Path) {
    let options = Options::builder()
        .ready_timeout(Duration::from_millis(300))
        .build();
    let report = conformance::run(cat, &options);
    assert!(!report.passed());
    assert_eq!(status(&report, "ready"), CheckStatus::Failed);
    assert_eq!(status(&report, "unknown_method"), CheckStatus::Skipped);
    // `cat` echoes the hello back, which is not a protocol message.
    assert_eq!(status(&report, "stdout_clean"), CheckStatus::Failed);
    assert_eq!(status(&report, "exit_on_stdin_close"), CheckStatus::Passed);
}

fn a_missing_binary_fails() {
    let report = conformance::run(Path::new("/definitely/not/a/backend"), &Options::default());
    assert!(!report.passed());
    assert_eq!(status(&report, "starts"), CheckStatus::Failed);
    assert_eq!(status(&report, "ready"), CheckStatus::Skipped);
}

fn ready_must_be_the_first_line(me: &Path) {
    let options = Options::builder().args(vec![CHATTY_FLAG.into()]).build();
    let report = conformance::run(me, &options);
    assert_eq!(status(&report, "ready"), CheckStatus::Failed, "{report}");
    let ready = report.checks.iter().find(|c| c.name == "ready").unwrap();
    assert!(ready.detail.contains("starting up..."), "{report}");
    assert_eq!(status(&report, "stdout_clean"), CheckStatus::Failed);
}

fn the_declared_protocol_is_used(me: &Path) {
    // The echo backend speaks protocol 1 and refuses a protocol-2 hello.
    let options = Options::builder()
        .args(vec![BACKEND_FLAG.into()])
        .protocol(2)
        .build();
    let report = conformance::run(me, &options);
    assert_eq!(status(&report, "ready"), CheckStatus::Failed, "{report}");
    let refusal = report.stderr_tail.join("\n");
    assert!(refusal.contains("protocol 2"), "{refusal}");
}

fn stderr_is_drained_past_long_lines(me: &Path) {
    let options = Options::builder()
        .args(vec![LONG_STDERR_FLAG.into()])
        .build();
    let report = conformance::run(me, &options);
    assert!(report.passed(), "{report}");
    assert!(
        report
            .stderr_tail
            .iter()
            .any(|line| line == AFTER_LONG_LINE),
        "{:?}",
        report.stderr_tail
    );
}

#[cfg(unix)]
mod unix {
    use std::path::Path;
    use std::process::{Command, Stdio};
    use std::time::{Duration, Instant};

    use cadencr_tab_backend::conformance::{self, Options};

    use super::PROBE_FLAG;

    /// Record the host-only variables this process sees and the pid of a
    /// grandchild that would outlive it.
    #[expect(
        clippy::zombie_processes,
        reason = "the grandchild must outlive this process: the conformance run has to kill it"
    )]
    pub fn probe(file: &Path) {
        let leaked: Vec<String> = std::env::vars()
            .map(|(key, _)| key)
            .filter(|key| {
                let key = key.to_ascii_uppercase();
                key.starts_with("CADENCR_") || key.starts_with("VITE_")
            })
            .collect();
        let grandchild = Command::new("sleep")
            .arg("30")
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .expect("sleep starts");
        let record = format!("{}\n{}", grandchild.id(), leaked.join(","));
        std::fs::write(file, record).expect("the probe file is writable");
    }

    pub fn spawned_like_the_host(me: &Path) {
        let directory = tempfile_dir();
        let file = directory.join("probe");
        // Only this test sets these, and only the probe backend reads them.
        std::env::set_var("CADENCR_CONFORMANCE_SECRET", "1");
        std::env::set_var("vite_conformance_secret", "1");
        let options = Options::builder()
            .args(vec![PROBE_FLAG.into(), file.clone().into()])
            .build();
        let report = conformance::run(me, &options);
        std::env::remove_var("CADENCR_CONFORMANCE_SECRET");
        std::env::remove_var("vite_conformance_secret");
        assert!(report.passed(), "{report}");
        let record = std::fs::read_to_string(&file).unwrap();
        let (pid, leaked) = record.split_once('\n').unwrap();
        assert_eq!(leaked, "", "host-only variables reached the backend");
        let pid: libc::pid_t = pid.parse().unwrap();
        // The grandchild is killed with the backend's process group (it may
        // linger a moment as a zombie until it is reaped).
        let deadline = Instant::now() + Duration::from_secs(5);
        // SAFETY: signal 0 only checks whether the process exists.
        while unsafe { libc::kill(pid, 0) } == 0 && !is_zombie(pid) {
            assert!(Instant::now() < deadline, "grandchild {pid} survived");
            std::thread::sleep(Duration::from_millis(20));
        }
        std::fs::remove_dir_all(directory).unwrap();
    }

    fn is_zombie(pid: libc::pid_t) -> bool {
        let state = Command::new("ps")
            .args(["-o", "stat=", "-p", &pid.to_string()])
            .output()
            .map(|output| String::from_utf8_lossy(&output.stdout).trim().to_owned())
            .unwrap_or_default();
        state.is_empty() || state.starts_with('Z')
    }

    fn tempfile_dir() -> std::path::PathBuf {
        let path =
            std::env::temp_dir().join(format!("cadencr-conformance-probe-{}", std::process::id()));
        std::fs::create_dir_all(&path).unwrap();
        path
    }
}
