//! Where a reported failure was created. Constructors are `#[track_caller]`, so
//! the location is the line that built the error, or the `?` that converted it.
//! Telemetry receives only that curated CadencR source position, never the message.

use std::fmt;
use std::ops::Deref;
use std::panic::Location;

use crate::domain::telemetry::{self, models::DiagnosticFrame};

#[derive(Clone, Copy)]
pub struct Origin(&'static Location<'static>);

impl Origin {
    #[track_caller]
    pub fn here() -> Self {
        Self(Location::caller())
    }

    pub(crate) fn frame(self) -> Option<DiagnosticFrame> {
        telemetry::source_frame(self.0)
    }
}

impl fmt::Debug for Origin {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        fmt::Display::fmt(self.0, f)
    }
}

/// An internal failure message and the source line that created it.
/// Reads as the message itself; the origin only feeds telemetry.
pub struct Detail {
    message: String,
    origin: Origin,
}

impl Detail {
    #[track_caller]
    pub fn new(message: impl Into<String>) -> Self {
        Self {
            message: message.into(),
            origin: Origin::here(),
        }
    }

    /// Rewords the message while keeping the original creation site.
    pub fn map(self, reword: impl FnOnce(String) -> String) -> Self {
        Self {
            message: reword(self.message),
            origin: self.origin,
        }
    }

    pub(crate) fn origin(&self) -> Origin {
        self.origin
    }
}

impl Deref for Detail {
    type Target = String;

    fn deref(&self) -> &String {
        &self.message
    }
}

impl fmt::Display for Detail {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.message)
    }
}

impl fmt::Debug for Detail {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        fmt::Debug::fmt(&self.message, f)
    }
}

impl PartialEq<str> for Detail {
    fn eq(&self, other: &str) -> bool {
        self.message == other
    }
}

impl PartialEq<&str> for Detail {
    fn eq(&self, other: &&str) -> bool {
        self.message == *other
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn records_the_constructing_line_and_keeps_it_when_reworded() {
        let line = line!() + 1;
        let detail = Detail::new("disk full").map(|message| format!("{message}; retry"));
        assert_eq!(detail, "disk full; retry");
        assert_eq!(format!("{detail:?}"), "\"disk full; retry\"");
        let frame = detail.origin().frame().expect("service source frame");
        assert_eq!(frame.filename, "src/error/origin.rs");
        assert_eq!(frame.lineno, line);
    }
}
