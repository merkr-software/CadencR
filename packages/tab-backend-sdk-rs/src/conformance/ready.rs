//! The `ready` check: the host's handshake rule, applied to the backend's
//! very first stdout line.

use std::time::Instant;

use super::backend::Backend;
use super::{millis, Check, CheckName, Options};
use crate::framing::Line;
use crate::protocol::{parse_ready, ReadyProblem};

pub(super) fn check_ready(backend: &mut Backend, options: &Options, hello: &str) -> Check {
    const NAME: CheckName = CheckName::Ready;
    if let Err(error) = backend.send(hello) {
        return Check::failed(NAME, format!("could not write `hello`: {error}"));
    }
    let started = Instant::now();
    let line = match backend.first_line(options.ready_timeout) {
        Some(Line::Text(line)) => line,
        Some(Line::TooLong) => {
            backend
                .stray
                .push("a first line over the size limit".into());
            return Check::failed(NAME, "the first stdout line is over the size limit");
        }
        None => {
            return Check::failed(
                NAME,
                format!(
                    "no stdout line within {} ms of `hello`",
                    millis(options.ready_timeout)
                ),
            )
        }
    };
    match parse_ready(&line, options.protocol) {
        Ok(ready) => Check::passed(
            NAME,
            format!(
                "protocol {} ({}) after {} ms",
                options.protocol,
                ready.sdk.as_deref().unwrap_or("no sdk given"),
                millis(started.elapsed())
            ),
        ),
        Err(problem) => {
            backend.keep(&line);
            Check::failed(NAME, describe(&problem, &line, options.protocol))
        }
    }
}

/// What is wrong with a first stdout line, for the report.
fn describe(problem: &ReadyProblem, line: &[u8], expected: u32) -> String {
    let wanted = format!(r#"{{"type":"ready","protocol":{expected}}}"#);
    match problem {
        ReadyProblem::NotReady => {
            let text = String::from_utf8_lossy(line);
            let quoted: String = text.chars().take(200).collect();
            format!(
                "the first stdout line must be `{wanted}`; the host stops a backend whose first line is anything else, got `{quoted}`"
            )
        }
        ReadyProblem::OtherProtocol(got) => {
            format!("`ready` has protocol {got}, expected {expected}")
        }
        ReadyProblem::NoProtocol => format!("`ready` has no protocol: expected `{wanted}`"),
    }
}
