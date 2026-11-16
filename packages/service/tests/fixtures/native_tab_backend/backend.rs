//! A native custom-tab backend for tests, speaking the §4.7 stdio protocol.
//!
//! Std only: `install.rs` compiles this one file with `rustc` at test time,
//! so the service's packaged builds never contain it. Its behavior is picked
//! by the file name it was launched as (the host runs it by absolute path):
//!
//! - `silent`: reads `hello`, never writes `ready` (and exits on stdin close);
//! - `future`: answers `hello` with `ready` for protocol 2;
//! - `chatty`: writes a log line to stdout before anything else;
//! - `early`: reads `hello`, then exits with status 0 without `ready`;
//! - `deaf`: writes `ready`, starts `/bin/sleep 300` (its pid in `child.pid`
//!   in the working directory) and never reads stdin again;
//! - any other name: `ready`, then answers `echo`, `context`, `api`,
//!   `write_cwd` (whether a file can be created in its working directory),
//!   `fail` and `crash` requests until stdin closes.

use std::collections::BTreeMap;
use std::io::{BufRead, Read, Write};

#[derive(Clone, Debug)]
enum Json {
    Null,
    Bool(bool),
    Number(String),
    String(String),
    Array(Vec<Json>),
    Object(BTreeMap<String, Json>),
}

impl Json {
    fn get(&self, key: &str) -> &Json {
        match self {
            Json::Object(map) => map.get(key).unwrap_or(&Json::Null),
            _ => &Json::Null,
        }
    }

    fn str(&self) -> &str {
        match self {
            Json::String(text) => text,
            _ => "",
        }
    }

    fn write(&self, out: &mut String) {
        match self {
            Json::Null => out.push_str("null"),
            Json::Bool(value) => out.push_str(if *value { "true" } else { "false" }),
            Json::Number(number) => out.push_str(number),
            Json::String(text) => {
                out.push('"');
                for c in text.chars() {
                    match c {
                        '"' => out.push_str("\\\""),
                        '\\' => out.push_str("\\\\"),
                        '\n' => out.push_str("\\n"),
                        c if (c as u32) < 0x20 => out.push_str(&format!("\\u{:04x}", c as u32)),
                        c => out.push(c),
                    }
                }
                out.push('"');
            }
            Json::Array(items) => {
                out.push('[');
                for (index, item) in items.iter().enumerate() {
                    if index > 0 {
                        out.push(',');
                    }
                    item.write(out);
                }
                out.push(']');
            }
            Json::Object(map) => {
                out.push('{');
                for (index, (key, value)) in map.iter().enumerate() {
                    if index > 0 {
                        out.push(',');
                    }
                    Json::String(key.clone()).write(out);
                    out.push(':');
                    value.write(out);
                }
                out.push('}');
            }
        }
    }
}

struct Parser<'a> {
    bytes: &'a [u8],
    at: usize,
}

impl Parser<'_> {
    fn skip_space(&mut self) {
        while self.at < self.bytes.len() && self.bytes[self.at].is_ascii_whitespace() {
            self.at += 1;
        }
    }

    fn peek(&mut self) -> Option<u8> {
        self.skip_space();
        self.bytes.get(self.at).copied()
    }

    fn expect(&mut self, byte: u8) -> Option<()> {
        (self.peek()? == byte).then(|| self.at += 1)
    }

    fn value(&mut self) -> Option<Json> {
        match self.peek()? {
            b'{' => {
                self.at += 1;
                let mut map = BTreeMap::new();
                if self.peek()? == b'}' {
                    self.at += 1;
                    return Some(Json::Object(map));
                }
                loop {
                    let Json::String(key) = self.value()? else {
                        return None;
                    };
                    self.expect(b':')?;
                    map.insert(key, self.value()?);
                    match self.peek()? {
                        b',' => self.at += 1,
                        b'}' => {
                            self.at += 1;
                            return Some(Json::Object(map));
                        }
                        _ => return None,
                    }
                }
            }
            b'[' => {
                self.at += 1;
                let mut items = Vec::new();
                if self.peek()? == b']' {
                    self.at += 1;
                    return Some(Json::Array(items));
                }
                loop {
                    items.push(self.value()?);
                    match self.peek()? {
                        b',' => self.at += 1,
                        b']' => {
                            self.at += 1;
                            return Some(Json::Array(items));
                        }
                        _ => return None,
                    }
                }
            }
            b'"' => self.string().map(Json::String),
            b't' => self.word("true", Json::Bool(true)),
            b'f' => self.word("false", Json::Bool(false)),
            b'n' => self.word("null", Json::Null),
            _ => {
                let start = self.at;
                while self.at < self.bytes.len()
                    && matches!(self.bytes[self.at], b'-' | b'+' | b'.' | b'e' | b'E' | b'0'..=b'9')
                {
                    self.at += 1;
                }
                let number = std::str::from_utf8(&self.bytes[start..self.at]).ok()?;
                (!number.is_empty()).then(|| Json::Number(number.to_string()))
            }
        }
    }

    fn word(&mut self, word: &str, value: Json) -> Option<Json> {
        let end = self.at + word.len();
        (self.bytes.get(self.at..end)? == word.as_bytes()).then(|| {
            self.at = end;
            value
        })
    }

    fn string(&mut self) -> Option<String> {
        self.at += 1;
        let mut out = Vec::new();
        loop {
            let byte = *self.bytes.get(self.at)?;
            self.at += 1;
            match byte {
                b'"' => return String::from_utf8(out).ok(),
                b'\\' => {
                    let escaped = *self.bytes.get(self.at)?;
                    self.at += 1;
                    match escaped {
                        b'n' => out.push(b'\n'),
                        b't' => out.push(b'\t'),
                        b'r' => out.push(b'\r'),
                        b'b' => out.push(8),
                        b'f' => out.push(12),
                        b'u' => {
                            let hex = std::str::from_utf8(self.bytes.get(self.at..self.at + 4)?).ok()?;
                            self.at += 4;
                            let c = char::from_u32(u32::from_str_radix(hex, 16).ok()?)?;
                            out.extend_from_slice(c.to_string().as_bytes());
                        }
                        other => out.push(other),
                    }
                }
                other => out.push(other),
            }
        }
    }
}

fn parse(line: &str) -> Option<Json> {
    Parser { bytes: line.as_bytes(), at: 0 }.value()
}

fn object(entries: Vec<(&str, Json)>) -> Json {
    Json::Object(entries.into_iter().map(|(key, value)| (key.to_string(), value)).collect())
}

fn text(value: &str) -> Json {
    Json::String(value.to_string())
}

fn send(message: &Json) {
    let mut line = String::new();
    message.write(&mut line);
    line.push('\n');
    let mut stdout = std::io::stdout().lock();
    stdout.write_all(line.as_bytes()).expect("stdout");
    stdout.flush().expect("stdout");
}

fn ready(protocol: u32) {
    send(&object(vec![
        ("type", text("ready")),
        ("protocol", Json::Number(protocol.to_string())),
        ("sdk", text("native-tab-backend-fixture")),
    ]));
}

/// `GET base_url + path` with the backend's own token; the HTTP status.
fn http_status(hello: &Json, path: &str) -> u16 {
    let api = hello.get("api");
    let authority = api.get("base_url").str().trim_start_matches("http://").to_string();
    let mut stream = std::net::TcpStream::connect(&authority).expect("connect to Cadencr");
    let request = format!(
        "GET {path} HTTP/1.1\r\nHost: {authority}\r\n{}: {}\r\nConnection: close\r\n\r\n",
        api.get("token_header").str(),
        api.get("token").str()
    );
    stream.write_all(request.as_bytes()).expect("send request");
    let mut response = String::new();
    let _ = stream.read_to_string(&mut response);
    response
        .split_whitespace()
        .nth(1)
        .and_then(|status| status.parse().ok())
        .unwrap_or(0)
}

fn answer(hello: &Json, request: &Json) {
    let id = request.get("id").clone();
    let params = request.get("params").clone();
    let respond = |result: Json| send(&object(vec![("type", text("response")), ("id", id.clone()), ("result", result)]));
    match request.get("method").str() {
        "echo" => respond(params),
        "context" => respond(object(vec![
            ("feature_id", hello.get("feature_id").clone()),
            ("worktree", hello.get("worktree").clone()),
            ("state_dir", hello.get("state_dir").clone()),
            ("cwd", text(&std::env::current_dir().unwrap().to_string_lossy())),
            ("scopes", hello.get("scopes").clone()),
            ("leaked", std::env::var("CADENCR_AUTH_TOKEN").map_or(Json::Null, |token| text(&token))),
        ])),
        "api" => {
            let other = match params.get("other") {
                Json::Number(number) => number.clone(),
                _ => "0".into(),
            };
            let own = format!("/api/features/{}", match hello.get("feature_id") {
                Json::Number(number) => number.as_str(),
                _ => "0",
            });
            respond(object(vec![
                ("own", Json::Number(http_status(hello, &own).to_string())),
                ("other", Json::Number(http_status(hello, &format!("/api/features/{other}")).to_string())),
            ]))
        }
        "write_cwd" => respond(Json::Bool(std::fs::write("written-by-backend", "x").is_ok())),
        "fail" => send(&object(vec![
            ("type", text("response")),
            ("id", id),
            ("error", object(vec![("code", text("NOPE")), ("message", text("refused"))])),
        ])),
        "crash" => {
            eprintln!("about to crash");
            std::process::exit(3);
        }
        // An error response, as the protocol requires (and conformance checks).
        other => send(&object(vec![
            ("type", text("response")),
            ("id", id),
            (
                "error",
                object(vec![
                    ("code", text("UNKNOWN_METHOD")),
                    ("message", text(&format!("unknown method {other}"))),
                ]),
            ),
        ])),
    }
}

fn main() {
    let mode = std::env::args()
        .next()
        .and_then(|program| {
            std::path::Path::new(&program)
                .file_name()
                .map(|name| name.to_string_lossy().into_owned())
        })
        .unwrap_or_default();
    let stdin = std::io::stdin();
    let mut lines = stdin.lock().lines();
    if mode == "chatty" {
        println!("listening on 8080");
    }
    let Some(Ok(first)) = lines.next() else {
        return;
    };
    let hello = parse(&first).unwrap_or(Json::Null);
    match mode.as_str() {
        "silent" | "chatty" => {}
        "early" => return,
        "future" => ready(2),
        "deaf" => {
            ready(1);
            let child = std::process::Command::new("/bin/sleep")
                .arg("300")
                .spawn()
                .expect("spawn a child");
            std::fs::write("child.pid", child.id().to_string()).expect("write child.pid");
            std::thread::sleep(std::time::Duration::from_secs(300));
            return;
        }
        _ => {
            ready(1);
            eprintln!("backend ready");
        }
    }
    for line in lines {
        let Ok(line) = line else { break };
        let Some(request) = parse(&line) else { continue };
        if request.get("type").str() == "request" && !matches!(mode.as_str(), "silent" | "future" | "chatty") {
            answer(&hello, &request);
        }
    }
}
