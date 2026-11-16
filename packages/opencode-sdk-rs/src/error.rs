use std::fmt;
use std::path::PathBuf;

use thiserror::Error;

#[derive(Debug, Error)]
pub enum SdkError {
    #[error("opencode CLI not found; searched {} location(s)", searched.len())]
    CliNotFound { searched: Vec<PathBuf> },

    #[error("http request failed: {0}")]
    Http(#[from] reqwest::Error),

    #[error("http status {status}: {body}")]
    HttpStatus { status: u16, body: String },

    #[error("json decode failed: {0}")]
    Json(#[from] serde_json::Error),

    #[error("io failed: {0}")]
    Io(#[from] std::io::Error),

    #[error("failed to spawn opencode server: {0}")]
    Spawn(String),

    #[error("operation timed out: {0}")]
    Timeout(String),

    #[error("protocol error: {0}")]
    Protocol(String),

    /// A one-shot `opencode` command that ran and failed. `stderr` is its raw
    /// diagnostic output, kept out of the message: it can echo the resolved
    /// config, provider API keys included, so redact it before showing it.
    #[error("{command} exited with {status}")]
    CommandFailed {
        command: String,
        status: std::process::ExitStatus,
        stderr: CommandStderr,
    },
}

/// A command's raw stderr. Its `Debug` prints only the length, so logging the
/// error cannot leak it.
pub struct CommandStderr(String);

impl CommandStderr {
    pub fn new(stderr: String) -> Self {
        Self(stderr)
    }

    /// The raw output: redact it before showing it.
    pub fn raw(&self) -> &str {
        &self.0
    }
}

impl fmt::Debug for CommandStderr {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(formatter, "CommandStderr({} bytes)", self.0.len())
    }
}
