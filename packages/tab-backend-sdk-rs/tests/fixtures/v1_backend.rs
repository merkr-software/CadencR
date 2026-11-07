//! Frozen protocol-v1 fixture. Deliberately independent of the SDK server.

use std::io::{self, BufRead, Write};
use std::process::ExitCode;

use serde_json::{json, Value};

pub fn run() -> ExitCode {
    let stdin = io::stdin();
    let mut lines = stdin.lock().lines();
    let hello: Value = serde_json::from_str(&lines.next().unwrap().unwrap()).unwrap();
    if hello["type"] != "hello" || hello["protocol"] != 1 {
        eprintln!("legacy backend only speaks protocol 1");
        return ExitCode::FAILURE;
    }
    println!(r#"{{"type":"ready","protocol":1,"sdk":"legacy-fixture/1"}}"#);
    io::stdout().flush().unwrap();
    for line in lines {
        let Ok(request) = serde_json::from_str::<Value>(&line.unwrap()) else {
            continue;
        };
        if request["type"] != "request" || request.get("id").is_none() {
            continue;
        }
        let response = json!({
            "type":"response","id":request["id"],
            "error":{"code":"UNKNOWN_METHOD","message":"unknown method"}
        });
        println!("{response}");
        io::stdout().flush().unwrap();
    }
    ExitCode::SUCCESS
}
