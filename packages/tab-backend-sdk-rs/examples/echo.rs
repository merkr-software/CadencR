//! A minimal backend: `cargo run --example echo`, then type
//! `{"type":"hello","protocol":1,…}` and requests on stdin.
//!
//! Methods:
//! - `echo` returns its params;
//! - `whoami` returns the plugin id, the conversation folder and the state
//!   directory from `hello` (keep state there, never in the working directory);
//! - `sleep` `{"ms": n}` waits n ms (≤ 10 000) before answering, to show that
//!   other requests are not held up;
//! - `print` writes to stdout with `println!`, which lands in the log rather
//!   than in the protocol stream;
//! - `panic` panics, which becomes an `INTERNAL_ERROR` response.

use std::process::ExitCode;
use std::thread;
use std::time::Duration;

use cadencr_tab_backend::{serve, Context, Error};
use serde::Deserialize;
use serde_json::{json, Value};

#[derive(Deserialize)]
struct Sleep {
    ms: u64,
}

pub fn handle(cx: &Context) -> Result<Value, Error> {
    match cx.method() {
        "echo" => Ok(cx.raw_params().clone()),
        "whoami" => Ok(json!({
            "plugin": cx.hello().plugin.id,
            "worktree": cx.hello().worktree,
            "state_dir": cx.state_dir(),
        })),
        "sleep" => {
            let Sleep { ms } = cx.params()?;
            if ms > 10_000 {
                return Err(Error::invalid_params("`ms` is at most 10000"));
            }
            thread::sleep(Duration::from_millis(ms));
            Ok(json!({ "slept_ms": ms }))
        }
        "print" => {
            println!("this goes to the log, not to the host");
            Ok(Value::Null)
        }
        "panic" => panic!("asked to panic"),
        other => Err(Error::unknown_method(other)),
    }
}

pub fn main() -> ExitCode {
    serve(handle)
}
