use std::borrow::Cow;
use std::fmt::{Display, Formatter};
use std::path::PathBuf;

#[derive(Debug)]
pub enum RuntimeError {
    /// Generic runtime failure with a free-form message.
    Generic(String),
    /// The provider's CLI binary could not be located on disk. Carries the
    /// directories that were probed so the host can render an actionable
    /// message and prompt the user to set an explicit path via onboarding.
    CliNotFound {
        /// Owned so a runtime-registered provider can report its own CLI name
        /// without a compile-time literal.
        provider: Cow<'static, str>,
        searched: Vec<PathBuf>,
    },
    /// The provider's CLI accepted the protocol envelope but rejected the
    /// requested operation (e.g. `set_permission_mode("auto")` on a model
    /// that doesn't support auto). `subtype` is the control-request
    /// subtype the SDK sent — callers (e.g. the post-plan-approval
    /// transition) can branch on this to apply a fallback. `message` is
    /// the CLI's verbatim error text.
    ControlRequestRejected { subtype: String, message: String },
    /// A manual compaction turn failed after the compact request had already
    /// been accepted by Cadencr. The host can clear compact-specific UI state
    /// without treating unrelated steering failures as compact failures.
    CompactFailed(String),
    /// The runtime ignored a Stop and was terminated to end the turn. Shown
    /// even though the user asked for the stop: the process (and the state
    /// it held) was lost, which a normal stop never does.
    StopEscalated(String),
    /// A follow-up waited for the running turn and a Stop ended that turn
    /// first: the runtime dropped it rather than start a turn of its own.
    InputWithdrawn(String),
    /// An individual prompt failed after dispatch. The runtime stream settles
    /// the logical turn independently of this receipt.
    PromptDeliveryFailed {
        message: String,
        surfaced_on_stream: bool,
    },
    /// The runtime refused a request Cadencr sent it, without running it: a
    /// protocol or request error (an unknown method, invalid parameters, a
    /// state the request is not allowed in). Never a provider overload; the
    /// host reports it with its own code.
    RequestRejected(String),
    /// A stop found no turn running in the runtime: nothing was interrupted,
    /// so no stopped turn will be reported.
    NothingToInterrupt,
}

impl Display for RuntimeError {
    fn fmt(&self, f: &mut Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Generic(message) => f.write_str(message),
            Self::CliNotFound { provider, searched } => {
                write!(
                    f,
                    "{provider} CLI not found; searched {} location(s)",
                    searched.len()
                )
            }
            Self::ControlRequestRejected { subtype, message } => {
                write!(f, "CLI rejected control request `{subtype}`: {message}")
            }
            Self::CompactFailed(message)
            | Self::StopEscalated(message)
            | Self::InputWithdrawn(message)
            | Self::RequestRejected(message) => f.write_str(message),
            Self::PromptDeliveryFailed { message, .. } => f.write_str(message),
            Self::NothingToInterrupt => f.write_str("No turn was running to stop"),
        }
    }
}

impl std::error::Error for RuntimeError {}

impl RuntimeError {
    pub fn new(message: impl Into<String>) -> Self {
        Self::Generic(message.into())
    }

    pub fn compact_failed(message: impl Into<String>) -> Self {
        Self::CompactFailed(message.into())
    }

    pub fn stop_escalated(message: impl Into<String>) -> Self {
        Self::StopEscalated(message.into())
    }

    pub fn is_stop_escalation(&self) -> bool {
        matches!(self, Self::StopEscalated(_))
    }

    pub fn input_withdrawn(message: impl Into<String>) -> Self {
        Self::InputWithdrawn(message.into())
    }

    pub fn is_input_withdrawn(&self) -> bool {
        matches!(self, Self::InputWithdrawn(_))
    }

    pub fn request_rejected(message: impl Into<String>) -> Self {
        Self::RequestRejected(message.into())
    }

    /// The `session.error` code a turn that failed with this error carries;
    /// the client frames the failure from it.
    pub fn session_error_code(&self) -> &'static str {
        match self {
            Self::CompactFailed(_) => "COMPACT_ERROR",
            Self::RequestRejected(_) => "PROVIDER_REQUEST_REJECTED",
            _ => "SDK_ERROR",
        }
    }

    pub fn is_nothing_to_interrupt(&self) -> bool {
        matches!(self, Self::NothingToInterrupt)
    }

    /// Build a structured "CLI not found" error so the host can surface an
    /// actionable message + a link to the binary picker in onboarding.
    pub fn cli_not_found(provider: impl Into<Cow<'static, str>>, searched: Vec<PathBuf>) -> Self {
        Self::CliNotFound {
            provider: provider.into(),
            searched,
        }
    }
}
