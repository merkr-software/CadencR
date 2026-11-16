//! Drive a handler in-process, without spawning a process.
//!
//! [`TestHost::session`] runs the real protocol loop over in-memory stdio —
//! `hello`, `ready`, the worker pool, error and panic handling — and returns
//! everything the backend wrote:
//!
//! ```
//! use cadencr_tab_backend::testing::TestHost;
//! use cadencr_tab_backend::{Context, Error};
//! use serde_json::{json, Value};
//!
//! fn handle(cx: &Context) -> Result<Value, Error> {
//!     match cx.method() {
//!         "ping" => Ok(json!("pong")),
//!         other => Err(Error::unknown_method(other)),
//!     }
//! }
//!
//! let host = TestHost::new(handle);
//! assert_eq!(host.call("ping", Value::Null), Ok(json!("pong")));
//! let transcript = host.session([TestHost::request("1", "nope", Value::Null)]);
//! assert!(transcript.ready().is_some());
//! assert_eq!(transcript.response("1").unwrap().error.unwrap().code, "UNKNOWN_METHOD");
//! ```

use std::io::{self, Write};
use std::sync::{Arc, Mutex};

use serde_json::{json, Value};

use crate::context::Handler;
use crate::protocol::{
    ApiInfo, BackendMessage, ErrorBody, Hello, HostMessage, PluginInfo, Ready, RequestId, Response,
    PROTOCOL_VERSION,
};
use crate::server::{lock, run, Config, Pool, ServeError};

/// A plausible `hello` for tests: plugin `example.tab`, no scopes, the system
/// temporary directory as worktree and state directory, and an API address
/// nothing listens on.
pub fn sample_hello() -> Hello {
    Hello {
        protocol: PROTOCOL_VERSION,
        plugin: PluginInfo {
            id: "example.tab".into(),
            version: "0.1.0".into(),
        },
        project_id: 1,
        feature_id: 1,
        worktree: std::env::temp_dir(),
        state_dir: std::env::temp_dir(),
        scopes: Vec::new(),
        api: ApiInfo {
            base_url: "http://127.0.0.1:9".into(),
            token_header: crate::protocol::TOKEN_HEADER.into(),
            token: "test-token".into(),
        },
    }
}

/// A fake host for one handler.
pub struct TestHost {
    handler: Arc<dyn Handler>,
    hello: Hello,
    config: Config,
}

impl TestHost {
    pub fn new<H: Handler>(handler: H) -> Self {
        Self {
            handler: Arc::new(handler),
            hello: sample_hello(),
            config: Config::default(),
        }
    }

    /// Send this `hello` instead of [`sample_hello`].
    pub fn with_hello(mut self, hello: Hello) -> Self {
        self.hello = hello;
        self
    }

    /// Run requests with this [`Config`].
    pub fn with_config(mut self, config: Config) -> Self {
        self.config = config;
        self
    }

    /// The `hello` this host sends.
    pub fn hello(&self) -> &Hello {
        &self.hello
    }

    /// One `request` line.
    pub fn request(id: &str, method: &str, params: Value) -> String {
        json!({"type": "request", "id": id, "method": method, "params": params}).to_string()
    }

    /// Call one method and return its outcome.
    pub fn call(&self, method: &str, params: Value) -> Result<Value, ErrorBody> {
        let transcript = self.session([Self::request("call", method, params)]);
        match transcript.response("call") {
            Some(response) => response.outcome().cloned().map_err(Clone::clone),
            None => panic!("no response to `{method}`: {:?}", transcript.outcome),
        }
    }

    /// Write `hello`, then `lines` (raw, without `\n`), then close stdin;
    /// return once every accepted request was answered.
    pub fn session<I, L>(&self, lines: I) -> Transcript
    where
        I: IntoIterator<Item = L>,
        L: Into<String>,
    {
        let hello = HostMessage::Hello(self.hello.clone());
        let mut input = serde_json::to_string(&hello).expect("a hello serializes");
        input.push('\n');
        for line in lines {
            input.push_str(&line.into());
            input.push('\n');
        }
        self.raw_session(&input)
    }

    /// Feed `input` as the whole of stdin, `hello` included.
    pub fn raw_session(&self, input: &str) -> Transcript {
        let output = Capture::default();
        let outcome = run(
            input.as_bytes(),
            Box::new(output.clone()),
            self.handler.clone(),
            &self.config,
        )
        .map(Pool::join);
        let bytes = lock(&output.0).clone();
        let output: Vec<Value> = String::from_utf8_lossy(&bytes)
            .lines()
            .map(|line| serde_json::from_str(line).expect("every stdout line is JSON"))
            .collect();
        let messages = output
            .iter()
            .map(|line| serde_json::from_value(line.clone()).ok())
            .collect();
        Transcript {
            output,
            messages,
            outcome,
        }
    }
}

/// Everything one in-process run wrote, in order.
#[derive(Debug)]
pub struct Transcript {
    /// Every stdout line, parsed.
    pub output: Vec<Value>,
    /// How the run ended.
    pub outcome: Result<(), ServeError>,
    /// [`Transcript::output`] as protocol messages, `None` where a line is
    /// not one.
    messages: Vec<Option<BackendMessage>>,
}

impl Transcript {
    /// The `ready` line, if it was the first one.
    pub fn ready(&self) -> Option<Ready> {
        match self.messages.first()? {
            Some(BackendMessage::Ready(ready)) => Some(ready.clone()),
            _ => None,
        }
    }

    /// Every response, in the order they were written.
    pub fn responses(&self) -> Vec<Response> {
        self.written_responses().cloned().collect()
    }

    /// The response to the request with the string id `id`.
    pub fn response(&self, id: &str) -> Option<Response> {
        let id = RequestId::from(id);
        self.written_responses()
            .find(|response| response.id == id)
            .cloned()
    }

    fn written_responses(&self) -> impl Iterator<Item = &Response> {
        self.messages.iter().filter_map(|message| match message {
            Some(BackendMessage::Response(response)) => Some(response),
            _ => None,
        })
    }
}

/// The in-memory stdout.
#[derive(Clone, Default)]
struct Capture(Arc<Mutex<Vec<u8>>>);

impl Write for Capture {
    fn write(&mut self, bytes: &[u8]) -> io::Result<usize> {
        lock(&self.0).extend_from_slice(bytes);
        Ok(bytes.len())
    }

    fn flush(&mut self) -> io::Result<()> {
        Ok(())
    }
}
