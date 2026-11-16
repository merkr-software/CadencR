use std::path::PathBuf;

use thiserror::Error;

/// All errors that can occur in the Claude Agent SDK.
#[derive(Debug, Error)]
pub enum SdkError {
    /// The `claude` binary was not found anywhere we looked. The included
    /// `searched` list (every directory we probed for an executable named
    /// `claude`) lets the host app surface an actionable message and an
    /// onboarding "pick a path" UI.
    #[error("claude CLI not found; searched {} location(s)", searched.len())]
    CliNotFound { searched: Vec<PathBuf> },

    /// Failed to spawn the child process.
    #[error("failed to spawn child process: {0}")]
    SpawnFailed(std::io::Error),

    /// Received a malformed JSON line from the CLI's stdout.
    /// The raw line is included for debugging.
    #[error("protocol error: malformed JSON line `{line}`: {source}")]
    ProtocolError {
        line: String,
        source: serde_json::Error,
    },

    /// The CLI exited with a non-zero exit code.
    #[error("CLI process exited with code {code:?}: {stderr}")]
    ProcessExit { code: Option<i32>, stderr: String },

    /// A signal the SDK did not send ended the CLI (a crash, or a kill from
    /// outside). A stop or kill through the SDK never reports this.
    #[error("Claude Code was terminated by signal {signal} ({}){}", signal_name(*.signal), stderr_suffix(.stderr))]
    ProcessSignaled { signal: i32, stderr: String },

    /// An operation timed out.
    #[error("operation timed out")]
    Timeout,

    /// A generic I/O error occurred during stdin/stdout operations (distinct from SpawnFailed).
    #[error("I/O error: {0}")]
    IoError(std::io::Error),

    /// Failed to serialize a message for writing to stdin.
    #[error("serialization error: {0}")]
    SerializationError(serde_json::Error),

    /// Attempted to write to stdin after it was closed.
    #[error("stdin is closed")]
    InputClosed,

    /// The operation was cancelled via a CancellationToken.
    #[error("operation was cancelled")]
    Cancelled,

    /// The CLI replied to a `control_request` with an `error` subtype.
    /// `subtype` is the request subtype we sent (e.g. `set_permission_mode`,
    /// `set_model`); `message` is whatever the CLI included in the error
    /// payload. Surfaced verbatim so callers can decide how to display it.
    #[error("CLI rejected control request `{subtype}`: {message}")]
    ControlRequestFailed { subtype: String, message: String },
}

#[cfg(unix)]
fn signal_name(signal: i32) -> &'static str {
    match signal {
        libc::SIGHUP => "SIGHUP",
        libc::SIGINT => "SIGINT",
        libc::SIGABRT => "SIGABRT",
        libc::SIGKILL => "SIGKILL",
        libc::SIGBUS => "SIGBUS",
        libc::SIGSEGV => "SIGSEGV",
        libc::SIGPIPE => "SIGPIPE",
        libc::SIGTERM => "SIGTERM",
        _ => "unnamed signal",
    }
}

#[cfg(not(unix))]
fn signal_name(_signal: i32) -> &'static str {
    "unnamed signal"
}

fn stderr_suffix(stderr: &str) -> String {
    let stderr = stderr.trim();
    if stderr.is_empty() {
        String::new()
    } else {
        format!(": {stderr}")
    }
}

#[cfg(test)]
mod tests {
    use super::SdkError;

    #[test]
    fn a_signal_death_names_the_signal_and_keeps_stderr() {
        let bare = SdkError::ProcessSignaled {
            signal: 9,
            stderr: String::new(),
        };
        assert_eq!(
            bare.to_string(),
            "Claude Code was terminated by signal 9 (SIGKILL)"
        );
        let with_stderr = SdkError::ProcessSignaled {
            signal: 11,
            stderr: "segfault at 0x0\n".into(),
        };
        assert_eq!(
            with_stderr.to_string(),
            "Claude Code was terminated by signal 11 (SIGSEGV): segfault at 0x0"
        );
    }
}
