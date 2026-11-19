//! Publishing unsolicited updates on the protocol writer.

use serde_json::Value;

use crate::error::{codes, Error};
use crate::output::Output;
use crate::protocol::{BackendMessage, Event, EVENT_PROTOCOL_VERSION, MAX_EVENT_BYTES};

/// A clonable, thread-safe publisher obtained from [`Context::emitter`](crate::Context::emitter).
///
/// It can outlive a request and be moved into a background thread. Writes
/// share the responses' lock and block while the host's pipe is full; the
/// SDK adds no queue. Stop a producer on an output error, and report other
/// errors to the caller or the backend's stderr log.
#[derive(Clone)]
pub struct EventEmitter {
    protocol: u32,
    output: Output,
}

impl EventEmitter {
    pub(crate) fn new(protocol: u32, output: Output) -> Self {
        Self { protocol, output }
    }

    /// Publish an opaque topic/payload update.
    ///
    /// Requires a v2 `hello`. Returns [`codes::EVENTS_UNSUPPORTED`] in v1,
    /// [`codes::INVALID_EVENT`] for an invalid topic, [`codes::EVENT_TOO_LARGE`]
    /// past 64 KiB of serialized JSON, or [`codes::OUTPUT_ERROR`] when the
    /// host's stream is closed or writing fails. Failed validation writes
    /// nothing. Once serving ends, retained publishers cannot write.
    pub fn emit(&self, topic: impl Into<String>, payload: Value) -> Result<(), Error> {
        if self.protocol != EVENT_PROTOCOL_VERSION {
            return Err(Error::new(
                codes::EVENTS_UNSUPPORTED,
                "events require backend protocol 2",
            ));
        }
        let event = Event {
            topic: topic.into(),
            payload,
        };
        event.validate_topic()?;
        let line = serde_json::to_vec(&BackendMessage::Event(event)).map_err(Error::internal)?;
        if line.len() > MAX_EVENT_BYTES {
            return Err(Error::new(
                codes::EVENT_TOO_LARGE,
                format!("the event does not fit in {MAX_EVENT_BYTES} bytes"),
            ));
        }
        self.output
            .write_line(line)
            .map_err(|error| Error::new(codes::OUTPUT_ERROR, error.to_string()))
    }
}
