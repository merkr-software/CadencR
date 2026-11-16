//! The protocol loop: `hello` → `ready` → requests on a worker pool.

use std::fmt;
use std::io::{self, BufRead, BufReader, Write};
use std::panic::{catch_unwind, AssertUnwindSafe};
use std::process::ExitCode;
use std::sync::mpsc::{self, Receiver, SyncSender, TrySendError};
use std::sync::{Arc, Mutex, MutexGuard};
use std::thread::{self, JoinHandle};

use serde_json::Value;

use crate::context::{Context, Handler, Session};
use crate::error::{codes, Error};
use crate::framing::{next_line, Line};
use crate::incoming::{classify, hello, Incoming};
use crate::protocol::{
    BackendMessage, Ready, Request, Response, MAX_IN_FLIGHT, MAX_LINE_BYTES, PROTOCOL_VERSION,
};
use crate::stdio_guard;

/// `ready.sdk` of backends built with this crate.
pub const SDK: &str = concat!("cadencr-tab-backend/", env!("CARGO_PKG_VERSION"));

/// Requests that may wait for a free worker; past it, a request is answered
/// [`codes::BUSY`] at once. Several times what a host keeps in flight
/// ([`MAX_IN_FLIGHT`]), but a host's timed-out requests keep running here
/// (protocol v1 cannot cancel them), so slow handlers can still fill it.
const QUEUE: usize = 4 * MAX_IN_FLIGHT;

/// How [`serve_with`] runs requests.
#[derive(Debug, Clone, bon::Builder)]
pub struct Config {
    /// Requests run at the same time, each on its own worker thread
    /// (default 8, at least 1). Further requests wait for a free worker.
    #[builder(default = 8)]
    workers: usize,
}

impl Default for Config {
    fn default() -> Self {
        Self::builder().build()
    }
}

/// Why a run ended before stdin closed.
#[derive(Debug)]
pub enum ServeError {
    /// Stdin closed before the `hello` line.
    NoHello,
    /// The first line is not a `hello`; holds what it was.
    NotHello(String),
    /// The host speaks another protocol version; holds its `protocol` value.
    ProtocolMismatch { host: Value },
    /// The `hello` is not well-formed.
    InvalidHello(String),
    /// Reading stdin or writing the protocol output failed.
    Io(io::Error),
}

impl fmt::Display for ServeError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::NoHello => formatter.write_str("stdin closed before the `hello` line"),
            Self::NotHello(found) => write!(formatter, "expected `hello` first, got {found}"),
            Self::ProtocolMismatch { host } => write!(
                formatter,
                "the host speaks protocol {host}, this backend speaks {PROTOCOL_VERSION}"
            ),
            Self::InvalidHello(detail) => write!(formatter, "invalid `hello`: {detail}"),
            Self::Io(error) => write!(formatter, "stdio failed: {error}"),
        }
    }
}

impl std::error::Error for ServeError {}

/// Run `handler` as this process's backend with the default [`Config`].
/// Returns once stdin closes; use it as `main`'s result.
pub fn serve<H: Handler>(handler: H) -> ExitCode {
    serve_with(Config::default(), handler)
}

/// [`serve`] with an explicit [`Config`].
///
/// Exits with status 0 when stdin closes after a valid `hello`, and with
/// status 1 and a stderr message when the `hello` is missing, invalid or of
/// another protocol version, or when stdio fails. Requests still running
/// when stdin closes are abandoned: the host no longer waits for them.
pub fn serve_with<H: Handler>(config: Config, handler: H) -> ExitCode {
    let (input, output) = match stdio_guard::protocol_stdio() {
        Ok(stdio) => stdio,
        Err(error) => {
            log(format_args!(
                "cannot reserve stdin and stdout for the protocol: {error}"
            ));
            return ExitCode::FAILURE;
        }
    };
    // Requests still running when stdin closes are abandoned with the pool.
    match run(BufReader::new(input), output, Arc::new(handler), &config) {
        Ok(_pool) => ExitCode::SUCCESS,
        Err(error) => {
            log(&error);
            ExitCode::FAILURE
        }
    }
}

/// One run over `input`/`output`, until `input` ends. The returned pool may
/// still be answering accepted requests: dropping it abandons them,
/// [`Pool::join`] waits for them (in-process tests).
pub(crate) fn run(
    mut input: impl BufRead,
    output: Box<dyn Write + Send>,
    handler: Arc<dyn Handler>,
    config: &Config,
) -> Result<Pool, ServeError> {
    let first = match next_line(&mut input, MAX_LINE_BYTES).map_err(ServeError::Io)? {
        None => return Err(ServeError::NoHello),
        Some(Line::TooLong) => return Err(ServeError::InvalidHello("the line is too long".into())),
        Some(Line::Text(line)) => line,
    };
    let session = Arc::new(Session::new(hello(&first)?));
    let output = Output(Arc::new(Mutex::new(output)));
    let ready = BackendMessage::Ready(Ready {
        protocol: PROTOCOL_VERSION,
        sdk: Some(SDK.into()),
    });
    output.write(&ready).map_err(ServeError::Io)?;
    let pool = Pool::start(config.workers.max(1), session, handler, output.clone())?;
    while let Some(line) = next_line(&mut input, MAX_LINE_BYTES).map_err(ServeError::Io)? {
        let line = match line {
            Line::Text(line) => line,
            Line::TooLong => {
                log(format_args!("ignored a line over {MAX_LINE_BYTES} bytes"));
                continue;
            }
        };
        match classify(&line) {
            Incoming::Request(request) => pool.submit(request, &output),
            Incoming::Invalid(id, error) => output.respond(Response::err(id, error.into())),
            Incoming::Ignored(reason) => log(reason),
        }
    }
    Ok(pool)
}

/// The protocol output, shared by the workers; one whole line per write.
#[derive(Clone)]
struct Output(Arc<Mutex<Box<dyn Write + Send>>>);

impl Output {
    fn write(&self, message: &BackendMessage) -> io::Result<()> {
        self.write_line(serde_json::to_vec(message)?)
    }

    /// Write one serialized message and its `\n`.
    fn write_line(&self, mut line: Vec<u8>) -> io::Result<()> {
        line.push(b'\n');
        let mut output = lock(&self.0);
        output.write_all(&line)?;
        output.flush()
    }

    /// Write `response`, replaced by an error when it does not fit a line.
    fn respond(&self, response: Response) {
        let id = response.id.clone();
        let written = match serde_json::to_vec(&BackendMessage::Response(response)) {
            Ok(line) if line.len() <= MAX_LINE_BYTES => self.write_line(line),
            _ => {
                let error = Error::new(
                    codes::RESPONSE_TOO_LARGE,
                    format!("the response does not fit in {MAX_LINE_BYTES} bytes"),
                );
                self.write(&BackendMessage::Response(Response::err(
                    id.clone(),
                    error.into(),
                )))
            }
        };
        if let Err(error) = written {
            log(format_args!(
                "could not write the response to {id}: {error}"
            ));
        }
    }
}

/// The workers of one run. Once it is dropped or [`Pool::join`]ed, they
/// finish the requests already queued and stop.
pub(crate) struct Pool {
    jobs: SyncSender<Request>,
    workers: Vec<JoinHandle<()>>,
}

impl Pool {
    fn start(
        size: usize,
        session: Arc<Session>,
        handler: Arc<dyn Handler>,
        output: Output,
    ) -> Result<Self, ServeError> {
        let (jobs, queue) = mpsc::sync_channel::<Request>(QUEUE);
        let queue = Arc::new(Mutex::new(queue));
        let workers = (0..size)
            .map(|index| {
                let worker = Worker {
                    queue: queue.clone(),
                    session: session.clone(),
                    handler: handler.clone(),
                    output: output.clone(),
                };
                thread::Builder::new()
                    .name(format!("tab-backend-worker-{index}"))
                    .spawn(move || worker.run())
            })
            .collect::<io::Result<Vec<_>>>()
            .map_err(ServeError::Io)?;
        Ok(Self { jobs, workers })
    }

    /// Queue `request`, or answer it `BUSY` when the queue is full: reading
    /// stdin never waits for a worker, so its closing is always noticed.
    fn submit(&self, request: Request, output: &Output) {
        match self.jobs.try_send(request) {
            Ok(()) => {}
            Err(TrySendError::Full(request)) => {
                let error = Error::new(
                    codes::BUSY,
                    format!("{QUEUE} requests are already waiting for a worker"),
                );
                output.respond(Response::err(request.id, error.into()));
            }
            Err(TrySendError::Disconnected(request)) => {
                log(format_args!(
                    "no worker is left to run request {}",
                    request.id
                ));
            }
        }
    }

    /// Wait until every accepted request was answered.
    pub(crate) fn join(self) {
        drop(self.jobs);
        for worker in self.workers {
            if worker.join().is_err() {
                log("a worker thread panicked");
            }
        }
    }
}

struct Worker {
    queue: Arc<Mutex<Receiver<Request>>>,
    session: Arc<Session>,
    handler: Arc<dyn Handler>,
    output: Output,
}

impl Worker {
    fn run(self) {
        loop {
            // The guard is a temporary: the lock is released before the
            // request runs.
            let next = lock(&self.queue).recv();
            let Ok(request) = next else { return };
            let id = request.id.clone();
            let cx = Context::new(
                self.session.clone(),
                id.clone(),
                request.method,
                request.params,
            );
            let response = match catch_unwind(AssertUnwindSafe(|| self.handler.handle(&cx))) {
                Ok(Ok(result)) => Response::ok(id, result),
                Ok(Err(error)) => Response::err(id, error.into()),
                Err(panic) => {
                    let error = Error::internal(format!(
                        "the handler panicked: {}",
                        panic_message(panic.as_ref())
                    ));
                    Response::err(id, error.into())
                }
            };
            self.output.respond(response);
        }
    }
}

fn panic_message(panic: &(dyn std::any::Any + Send)) -> &str {
    panic
        .downcast_ref::<&str>()
        .copied()
        .or_else(|| panic.downcast_ref::<String>().map(String::as_str))
        .unwrap_or("no message")
}

/// `mutex`, even poisoned. Handlers run under `catch_unwind` and the other
/// holders only append or read, so a poisoned lock only means a write was
/// interrupted; the data is still usable.
pub(crate) fn lock<T: ?Sized>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

/// A line in the backend's log (stderr), which the host keeps and shows.
pub(crate) fn log(message: impl fmt::Display) {
    // stderr is the only channel left to report on; if it is gone too there
    // is nobody to tell.
    let _ = writeln!(io::stderr(), "[cadencr-tab-backend] {message}");
}

#[cfg(test)]
mod tests {
    use std::sync::mpsc::channel;

    use super::*;
    use crate::protocol::RequestId;
    use crate::testing::sample_hello;

    /// Output captured in memory.
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

    fn request(id: usize) -> Request {
        Request {
            id: id.to_string().as_str().into(),
            method: "m".into(),
            params: Value::Null,
        }
    }

    #[test]
    fn a_full_queue_answers_busy_without_waiting_for_a_worker() {
        let (entered_tx, entered) = channel::<()>();
        let (release, released) = channel::<()>();
        let (entered_tx, released) = (Mutex::new(entered_tx), Mutex::new(released));
        // The first request holds the only worker until released.
        let handler = move |cx: &Context| {
            if cx.id() == &RequestId::from("0") {
                let _ = lock(&entered_tx).send(());
                let _ = lock(&released).recv();
            }
            Ok(Value::Null)
        };
        let capture = Capture::default();
        let output = Output(Arc::new(Mutex::new(Box::new(capture.clone()))));
        let session = Arc::new(Session::new(sample_hello()));
        let pool = Pool::start(1, session, Arc::new(handler), output.clone()).unwrap();
        pool.submit(request(0), &output);
        entered.recv().unwrap();
        for id in 1..=QUEUE + 3 {
            pool.submit(request(id), &output);
        }
        // Answered by `submit` itself, while the worker is still held.
        let busy: Vec<Value> = String::from_utf8(lock(&capture.0).clone())
            .unwrap()
            .lines()
            .map(|line| serde_json::from_str(line).unwrap())
            .collect();
        let ids: Vec<&str> = busy
            .iter()
            .map(|line| line["id"].as_str().unwrap())
            .collect();
        let last = [QUEUE + 1, QUEUE + 2, QUEUE + 3].map(|id| id.to_string());
        assert_eq!(ids, last.iter().map(String::as_str).collect::<Vec<_>>());
        assert!(busy.iter().all(|line| line["error"]["code"] == codes::BUSY));
        release.send(()).unwrap();
        pool.join();
        let answered = String::from_utf8(lock(&capture.0).clone())
            .unwrap()
            .lines()
            .count();
        assert_eq!(answered, QUEUE + 4, "every request is answered once");
    }
}
