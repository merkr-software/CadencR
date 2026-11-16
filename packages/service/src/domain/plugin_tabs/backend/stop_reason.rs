//! Why Cadencr stopped a backend: what its Activity says under "why it last
//! stopped".

use std::fmt;

/// Why Cadencr asked a backend to stop. The first reason given for a run
/// wins ([`super::process::Running::request_stop`]).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum StopReason {
    /// The tab's consented permissions moved while it ran.
    PermissionsChanged,
    /// Its grant was revoked without a more specific reason first.
    GrantRevoked,
    /// A new revision of the tab was installed or accepted.
    TabUpdated,
    /// Cadencr's revocation policy now blocks the tab.
    Blocked,
    /// No open instance of the tab held a presence lease.
    TabClosed,
    /// The tab was uninstalled.
    TabRemoved,
    /// The user asked for it from the tab's Activity dialog.
    FromActivity,
    /// Cadencr is shutting down.
    Quit,
    /// Stopped with no reason recorded (every request names one, so a run
    /// only ends so if its stop raced its own cleanup).
    Unspecified,
}

impl fmt::Display for StopReason {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(match self {
            Self::PermissionsChanged => "its permissions changed",
            Self::GrantRevoked => "its permissions changed or it was turned off",
            Self::TabUpdated => "its tab was updated",
            Self::Blocked => "it was blocked",
            Self::TabClosed => "its tab was closed",
            Self::TabRemoved => "its tab was removed",
            Self::FromActivity => "stopped from the tab's Activity",
            Self::Quit => "Cadencr quit",
            Self::Unspecified => "stopped by Cadencr",
        })
    }
}
