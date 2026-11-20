//! How an app-server's stderr reaches the host's log. Content stays redacted
//! (see `stderr_tail`); only each line's log level is read. Routine output,
//! such as the INFO lines Codex writes when `RUST_LOG` reaches it, is logged
//! at trace level. Errors (with unparsed lines: a panic, a plain message) and
//! warnings are logged as warnings, each up to its own cap per process, so a
//! burst of warnings never hides a later error; past a cap, lines are only
//! counted, and the count is logged when stderr closes.

/// Lines of one class logged per process before the rest are only counted.
const MAX_REPORTED: usize = 20;
/// The level token sits right after the timestamp; nothing past this many
/// characters is read.
const LEVEL_PREFIX_CHARS: usize = 64;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum StderrLevel {
    Error,
    Warn,
    Info,
    Debug,
    Trace,
    /// Not a `tracing` line: a panic, a backtrace or a plain message.
    Unknown,
}

impl StderrLevel {
    fn as_str(self) -> &'static str {
        match self {
            Self::Error => "error",
            Self::Warn => "warn",
            Self::Info => "info",
            Self::Debug => "debug",
            Self::Trace => "trace",
            Self::Unknown => "unknown",
        }
    }

    fn is_routine(self) -> bool {
        matches!(self, Self::Info | Self::Debug | Self::Trace)
    }
}

/// The level of a `tracing` formatted line (`<timestamp> LEVEL target: …`,
/// colored or not).
pub(crate) fn classify(line: &str) -> StderrLevel {
    plain_prefix(line)
        .split_whitespace()
        .take(2)
        .find_map(|token| match token {
            "ERROR" => Some(StderrLevel::Error),
            "WARN" => Some(StderrLevel::Warn),
            "INFO" => Some(StderrLevel::Info),
            "DEBUG" => Some(StderrLevel::Debug),
            "TRACE" => Some(StderrLevel::Trace),
            _ => None,
        })
        .unwrap_or(StderrLevel::Unknown)
}

/// The start of `line` without its ANSI SGR sequences (`ESC [ … m`).
fn plain_prefix(line: &str) -> String {
    let mut plain = String::with_capacity(LEVEL_PREFIX_CHARS);
    let mut chars = line.chars();
    while let Some(ch) = chars.next() {
        if plain.len() >= LEVEL_PREFIX_CHARS {
            break;
        }
        if ch != '\u{1b}' {
            plain.push(ch);
            continue;
        }
        if chars.next() != Some('[') {
            continue;
        }
        for code in chars.by_ref() {
            if ('@'..='~').contains(&code) {
                break;
            }
        }
    }
    plain
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Outcome {
    Routine,
    Reported,
    /// Reported, and its class's cap is now reached.
    ReportedLast,
    Counted,
}

/// One class of diagnostics: how many were logged, and how many only counted.
#[derive(Debug, Default)]
struct Budget {
    reported: usize,
    counted: usize,
}

impl Budget {
    fn spend(&mut self) -> Outcome {
        if self.reported >= MAX_REPORTED {
            self.counted += 1;
            return Outcome::Counted;
        }
        self.reported += 1;
        if self.reported == MAX_REPORTED {
            Outcome::ReportedLast
        } else {
            Outcome::Reported
        }
    }
}

/// Per-process stderr accounting.
#[derive(Debug, Default)]
pub(crate) struct StderrLog {
    errors: Budget,
    warnings: Budget,
    routine: usize,
}

impl StderrLog {
    pub(crate) fn record(&mut self, line: &str) {
        let level = classify(line);
        match self.outcome(level) {
            Outcome::Routine => tracing::trace!(
                target: "codex_app_server",
                stderr_level = level.as_str(),
                "codex app-server wrote a routine stderr line (content redacted)"
            ),
            Outcome::Reported => warn_diagnostic(level),
            Outcome::ReportedLast => {
                warn_diagnostic(level);
                tracing::warn!(
                    target: "codex_app_server",
                    stderr_level = level.as_str(),
                    limit = MAX_REPORTED,
                    "codex app-server stderr diagnostics of this level are now counted, not logged"
                );
            }
            Outcome::Counted => tracing::debug!(
                target: "codex_app_server",
                stderr_level = level.as_str(),
                "codex app-server emitted a stderr diagnostic past the limit (content redacted)"
            ),
        }
    }

    /// Log what was only counted, once stderr has closed.
    pub(crate) fn finish(&self) {
        if self.errors.counted + self.warnings.counted > 0 {
            tracing::warn!(
                target: "codex_app_server",
                errors = self.errors.counted,
                warnings = self.warnings.counted,
                "codex app-server emitted more stderr diagnostics than were logged"
            );
        }
        if self.routine > 0 {
            tracing::debug!(
                target: "codex_app_server",
                count = self.routine,
                "codex app-server wrote routine stderr lines"
            );
        }
    }

    fn outcome(&mut self, level: StderrLevel) -> Outcome {
        match level {
            _ if level.is_routine() => {
                self.routine += 1;
                Outcome::Routine
            }
            StderrLevel::Warn => self.warnings.spend(),
            _ => self.errors.spend(),
        }
    }
}

fn warn_diagnostic(level: StderrLevel) {
    tracing::warn!(
        target: "codex_app_server",
        stderr_level = level.as_str(),
        "codex app-server emitted a stderr diagnostic (content redacted)"
    );
}

#[cfg(test)]
mod tests {
    use super::{classify, Outcome, StderrLevel, StderrLog, LEVEL_PREFIX_CHARS, MAX_REPORTED};

    #[test]
    fn reads_the_level_of_colored_and_plain_tracing_lines() {
        let colored = "\u{1b}[2m2026-11-20T10:00:00.000000Z\u{1b}[0m \u{1b}[32m INFO\u{1b}[0m \
                       \u{1b}[2mcodex_app_server\u{1b}[0m\u{1b}[2m:\u{1b}[0m started";
        assert_eq!(classify(colored), StderrLevel::Info);
        assert_eq!(
            classify("2026-11-20T10:00:00Z ERROR codex_core: bad config"),
            StderrLevel::Error
        );
        assert_eq!(
            classify("2026-11-20T10:00:00Z  WARN x: y"),
            StderrLevel::Warn
        );
        assert_eq!(classify("DEBUG x: y"), StderrLevel::Debug);
        assert_eq!(
            classify("2026-11-20T10:00:00Z TRACE x: y"),
            StderrLevel::Trace
        );
    }

    #[test]
    fn lines_that_are_not_tracing_output_are_unknown() {
        assert_eq!(
            classify("thread 'main' panicked at src/main.rs:1:1:"),
            StderrLevel::Unknown
        );
        assert_eq!(classify("config error: bad model"), StderrLevel::Unknown);
        assert_eq!(classify(""), StderrLevel::Unknown);
        // A level word later in the message is not the line's level.
        assert_eq!(
            classify("2026-11-20T10:00:00Z something INFO later"),
            StderrLevel::Unknown
        );
    }

    #[test]
    fn only_the_start_of_a_line_is_read() {
        let long = format!("2026-11-20T10:00:00Z ERROR x: {}", "y".repeat(1 << 20));
        assert_eq!(classify(&long), StderrLevel::Error);
        let late = format!("{} INFO x: y", "z".repeat(LEVEL_PREFIX_CHARS));
        assert_eq!(classify(&late), StderrLevel::Unknown);
    }

    #[test]
    fn routine_lines_never_count_against_the_diagnostic_cap() {
        let mut log = StderrLog::default();
        for _ in 0..1_000 {
            assert_eq!(log.outcome(StderrLevel::Info), Outcome::Routine);
        }
        assert_eq!(log.outcome(StderrLevel::Error), Outcome::Reported);
        assert_eq!(log.routine, 1_000);
        assert_eq!(log.errors.reported, 1);
    }

    #[test]
    fn diagnostics_past_the_cap_are_counted() {
        let mut log = StderrLog::default();
        let outcomes: Vec<Outcome> = (0..MAX_REPORTED + 5)
            .map(|index| {
                let level = if index % 2 == 0 {
                    StderrLevel::Unknown
                } else {
                    StderrLevel::Error
                };
                log.outcome(level)
            })
            .collect();
        assert!(outcomes[..MAX_REPORTED - 1]
            .iter()
            .all(|outcome| *outcome == Outcome::Reported));
        assert_eq!(outcomes[MAX_REPORTED - 1], Outcome::ReportedLast);
        assert!(outcomes[MAX_REPORTED..]
            .iter()
            .all(|outcome| *outcome == Outcome::Counted));
        assert_eq!(log.errors.counted, 5);
    }

    /// A burst of warnings at startup must not hide a later crash.
    #[test]
    fn warnings_never_use_up_the_error_budget() {
        let mut log = StderrLog::default();
        for _ in 0..MAX_REPORTED * 3 {
            log.outcome(StderrLevel::Warn);
        }
        assert_eq!(log.warnings.counted, MAX_REPORTED * 2);
        assert_eq!(log.outcome(StderrLevel::Unknown), Outcome::Reported);
        assert_eq!(log.outcome(StderrLevel::Error), Outcome::Reported);
    }
}
