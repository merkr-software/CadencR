//! What a client can tell about its app-server process.

use crate::client::CodexAppServerClient;
use crate::types::AppServerExit;

impl CodexAppServerClient {
    pub fn pid(&self) -> Option<u32> {
        self.inner.pid
    }

    /// How the app-server ended, when it ended on its own rather than through
    /// [`Self::shutdown`] or a drop. Complete once `shutdown` has returned.
    pub fn exit(&self) -> Option<AppServerExit> {
        self.inner.exit.lock().ok().and_then(|exit| *exit)
    }

    /// The last lines the app-server wrote to stderr (at most 20, each cut to
    /// its last 1024 characters), complete once `shutdown` has returned. They
    /// are raw and can quote credentials from its config or environment:
    /// redact them before showing them.
    pub fn stderr_tail(&self) -> Vec<String> {
        self.inner
            .stderr_tail
            .lock()
            .map(|tail| tail.lines())
            .unwrap_or_default()
    }
}
