//! The methods against this computer: a real listening socket must show up
//! in `ports`, and `stop` must end a real listening process in the folder.

use std::io::{BufRead, BufReader};
use std::net::TcpListener;
use std::os::unix::process::ExitStatusExt;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::time::Duration;

use cadencr_tab_backend::protocol::Hello;
use cadencr_tab_backend::testing::{sample_hello, TestHost};
use serde_json::{json, Value};

/// Set in the environment of the child that `stop_ends_a_listener_in_the_folder` stops.
const CHILD_ENV: &str = "PORT_MONITOR_TEST_LISTENER";

fn host(worktree: &Path) -> TestHost {
    TestHost::new(port_monitor::PortMonitor::default()).with_hello(Hello {
        worktree: worktree.to_path_buf(),
        ..sample_hello()
    })
}

fn here() -> PathBuf {
    std::env::current_dir().unwrap()
}

fn entry_of(ports: &Value, pid: u32, port: u16) -> Option<Value> {
    ports["ports"]
        .as_array()
        .unwrap()
        .iter()
        .find(|entry| entry["pid"] == json!(pid) && entry["port"] == json!(port))
        .cloned()
}

#[test]
fn ports_lists_this_process_listener() {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let port = listener.local_addr().unwrap().port();
    let ports = host(&here()).call("ports", Value::Null).unwrap();
    let entry = entry_of(&ports, std::process::id(), port).unwrap_or_else(|| panic!("{ports:#}"));
    assert_eq!(entry["addresses"], json!(["127.0.0.1"]));
    assert_eq!(entry["inFolder"], json!(true));
    assert!(!entry["command"].as_str().unwrap().is_empty());
    assert!(entry["user"].is_string());

    let elsewhere = host(&std::env::temp_dir().join("port-monitor-elsewhere"));
    let ports = elsewhere.call("ports", Value::Null).unwrap();
    assert_eq!(
        entry_of(&ports, std::process::id(), port).unwrap()["inFolder"],
        json!(false)
    );
}

#[test]
fn stop_refuses_what_the_tab_may_not_stop() {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let me = json!({ "pid": std::process::id() });
    let code =
        |worktree: &Path, params: Value| host(worktree).call("stop", params).unwrap_err().code;
    // The backend itself (this test process plays it here).
    assert_eq!(code(&here(), me.clone()), "CADENCR_PROCESS");
    assert_eq!(
        code(&std::env::temp_dir().join("elsewhere"), me),
        "OUTSIDE_FOLDER"
    );
    assert_eq!(
        code(&here(), json!({ "pid": 999_999_999 })),
        "NOT_LISTENING"
    );
    assert_eq!(code(&here(), json!({})), "INVALID_PARAMS");
    drop(listener);
}

/// Kills the child if the test fails before `stop` ends it.
struct Guard(Option<Child>);

impl Drop for Guard {
    fn drop(&mut self) {
        if let Some(mut child) = self.0.take() {
            child.kill().expect("kill the listener child");
            child.wait().expect("reap the listener child");
        }
    }
}

#[test]
fn stop_ends_a_listener_in_the_folder() {
    let mut child = Command::new(std::env::current_exe().unwrap())
        .args([
            "listener_child",
            "--exact",
            "--nocapture",
            "--test-threads=1",
        ])
        .env(CHILD_ENV, "1")
        .current_dir(here())
        .stdout(Stdio::piped())
        .spawn()
        .unwrap();
    let stdout = BufReader::new(child.stdout.take().unwrap());
    let mut guard = Guard(Some(child));
    let port: u16 = stdout
        .lines()
        .map_while(Result::ok)
        .find_map(|line| {
            line.split_once("LISTENING ")
                .map(|(_, port)| port.trim().parse().unwrap())
        })
        .expect("the child reports its port");
    let pid = guard.0.as_ref().unwrap().id();

    let host = host(&here());
    let ports = host.call("ports", Value::Null).unwrap();
    assert_eq!(
        entry_of(&ports, pid, port).unwrap()["inFolder"],
        json!(true)
    );
    assert_eq!(
        host.call("stop", json!({ "pid": pid })),
        Ok(json!({ "stopped": pid }))
    );

    let status = guard.0.take().unwrap().wait().unwrap();
    assert_eq!(status.signal(), Some(libc::SIGTERM));
}

/// Not a test of its own: the listening process `stop_ends_a_listener_in_the_folder`
/// starts (a no-op unless `CHILD_ENV` is set).
#[test]
fn listener_child() {
    if std::env::var_os(CHILD_ENV).is_none() {
        return;
    }
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    println!("LISTENING {}", listener.local_addr().unwrap().port());
    std::thread::sleep(Duration::from_secs(60));
}
