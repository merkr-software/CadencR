//! What [`run`](super::run) reports: one named [`Check`] per protocol rule.

use std::fmt;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CheckStatus {
    Passed,
    Failed,
    /// Not run because an earlier check failed.
    Skipped,
}

/// The checks [`run`] makes, in the order it makes them.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum CheckName {
    Starts,
    Ready,
    UnknownMethod,
    MalformedLine,
    ConcurrentRequests,
    ExitOnStdinClose,
    StdoutClean,
}

impl CheckName {
    /// Every check, in run order (each one's index is its discriminant).
    pub const ALL: [CheckName; 7] = [
        CheckName::Starts,
        CheckName::Ready,
        CheckName::UnknownMethod,
        CheckName::MalformedLine,
        CheckName::ConcurrentRequests,
        CheckName::ExitOnStdinClose,
        CheckName::StdoutClean,
    ];

    /// The name the report shows, e.g. `unknown_method`.
    pub const fn as_str(self) -> &'static str {
        match self {
            CheckName::Starts => "starts",
            CheckName::Ready => "ready",
            CheckName::UnknownMethod => "unknown_method",
            CheckName::MalformedLine => "malformed_line",
            CheckName::ConcurrentRequests => "concurrent_requests",
            CheckName::ExitOnStdinClose => "exit_on_stdin_close",
            CheckName::StdoutClean => "stdout_clean",
        }
    }
}

impl fmt::Display for CheckName {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(self.as_str())
    }
}

impl PartialEq<&str> for CheckName {
    fn eq(&self, other: &&str) -> bool {
        self.as_str() == *other
    }
}

/// One named check and what was observed.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Check {
    pub name: CheckName,
    pub status: CheckStatus,
    pub detail: String,
}

impl Check {
    pub(super) fn new(name: CheckName, status: CheckStatus, detail: impl Into<String>) -> Self {
        Self {
            name,
            status,
            detail: detail.into(),
        }
    }

    pub(super) fn passed(name: CheckName, detail: impl Into<String>) -> Self {
        Self::new(name, CheckStatus::Passed, detail)
    }

    pub(super) fn failed(name: CheckName, detail: impl Into<String>) -> Self {
        Self::new(name, CheckStatus::Failed, detail)
    }
}

/// The outcome of [`run`].
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Report {
    pub checks: Vec<Check>,
    /// The backend's last stderr lines, oldest first.
    pub stderr_tail: Vec<String>,
}

impl Report {
    /// No check failed.
    pub fn passed(&self) -> bool {
        self.checks
            .iter()
            .all(|check| check.status != CheckStatus::Failed)
    }
}

impl fmt::Display for Report {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        for check in &self.checks {
            let mark = match check.status {
                CheckStatus::Passed => "pass",
                CheckStatus::Failed => "FAIL",
                CheckStatus::Skipped => "skip",
            };
            writeln!(formatter, "{mark}  {}: {}", check.name, check.detail)?;
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn check_names_are_listed_in_run_order() {
        for (index, name) in CheckName::ALL.into_iter().enumerate() {
            assert_eq!(name as usize, index);
        }
        assert!(CheckName::Ready == "ready");
    }
}
