//! Faulty raw backend for conformance tests, bypassing the SDK validator.

use std::io::{self, BufRead, Write};
use std::process::ExitCode;

use serde_json::{json, Value};

pub fn run(topic: &str, payload: Value) -> ExitCode {
    let stdin = io::stdin();
    let mut lines = stdin.lock().lines();
    let hello: Value = serde_json::from_str(&lines.next().unwrap().unwrap()).unwrap();
    println!("{}", json!({"type":"ready","protocol":hello["protocol"]}));
    io::stdout().flush().unwrap();
    for line in lines {
        let Ok(request) = serde_json::from_str::<Value>(&line.unwrap()) else {
            continue;
        };
        if request["type"] != "request" || request.get("id").is_none() {
            continue;
        }
        println!(
            "{}",
            json!({"type":"event","topic":topic,"payload":payload})
        );
        println!(
            "{}",
            json!({
                "type":"response","id":request["id"],
                "error":{"code":"UNKNOWN_METHOD","message":"unknown method"}
            })
        );
        io::stdout().flush().unwrap();
    }
    ExitCode::SUCCESS
}
