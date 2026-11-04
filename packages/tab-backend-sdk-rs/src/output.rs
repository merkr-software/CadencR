//! One atomic protocol writer shared by ready, responses and events.

use std::io::{self, Write};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};

use crate::error::{codes, Error};
use crate::protocol::{BackendMessage, Response, MAX_LINE_BYTES};
use crate::server::{lock, log};

#[derive(Clone)]
pub(crate) struct Output(Arc<State>);

struct State {
    writer: Mutex<Box<dyn Write + Send>>,
    open: AtomicBool,
}

/// Closes the protocol output when the serving pool is abandoned or joined.
/// Closing never waits for a publisher blocked on the host's pipe.
pub(crate) struct OutputLifetime(Output);

impl Drop for OutputLifetime {
    fn drop(&mut self) {
        self.0.close();
    }
}

impl Output {
    pub(crate) fn new(writer: Box<dyn Write + Send>) -> Self {
        Self(Arc::new(State {
            writer: Mutex::new(writer),
            open: AtomicBool::new(true),
        }))
    }

    pub(crate) fn lifetime(&self) -> OutputLifetime {
        OutputLifetime(self.clone())
    }

    fn close(&self) {
        self.0.open.store(false, Ordering::Release);
    }

    pub(crate) fn write(&self, message: &BackendMessage) -> io::Result<()> {
        self.write_line(serde_json::to_vec(message)?)
    }

    /// Append a newline and write the whole message under the common lock.
    pub(crate) fn write_line(&self, mut line: Vec<u8>) -> io::Result<()> {
        line.push(b'\n');
        let mut output = lock(&self.0.writer);
        if !self.0.open.load(Ordering::Acquire) {
            return Err(io::Error::new(
                io::ErrorKind::BrokenPipe,
                "protocol output is closed",
            ));
        }
        let written = output.write_all(&line).and_then(|()| output.flush());
        if written.is_err() {
            // A partial write could have corrupted the stream. Never append
            // another message to it, even if the next write would succeed.
            self.close();
        }
        written
    }

    /// Write `response`, replaced by an error when it does not fit a line.
    pub(crate) fn respond(&self, response: Response) {
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

#[cfg(test)]
mod tests {
    use super::*;
    use crate::emitter::EventEmitter;
    use serde_json::Value;

    struct FailingWriter;

    impl Write for FailingWriter {
        fn write(&mut self, _: &[u8]) -> io::Result<usize> {
            Err(io::Error::other("publisher write failed"))
        }

        fn flush(&mut self) -> io::Result<()> {
            Ok(())
        }
    }

    #[test]
    fn publishing_surfaces_io_errors_and_closes_the_failed_stream() {
        let output = Output::new(Box::new(FailingWriter));
        let publisher = EventEmitter::new(2, output);
        let error = publisher.emit("t", Value::Null).unwrap_err();
        assert_eq!(error.code(), codes::OUTPUT_ERROR);
        assert!(error.message().contains("publisher write failed"));
        let error = publisher.emit("t", Value::Null).unwrap_err();
        assert_eq!(error.code(), codes::OUTPUT_ERROR);
        assert!(error.message().contains("closed"));
    }
}
