use std::path::PathBuf;

use crate::domain::agents::adapter::{RuntimeAccessMode, RuntimePermissionMode};
use crate::domain::mcp::trusted::CadencrBrowserTrust;

pub(in crate::domain::agents::codex) struct CodexSessionOptions {
    pub(in crate::domain::agents::codex) model: Option<String>,
    pub(in crate::domain::agents::codex) effort: Option<String>,
    pub(in crate::domain::agents::codex) effective_model: Option<String>,
    pub(in crate::domain::agents::codex) effective_effort: Option<String>,
    pub(in crate::domain::agents::codex) summary: Option<String>,
    pub(in crate::domain::agents::codex) fast_mode: Option<bool>,
    pub(in crate::domain::agents::codex) permission_mode: Option<RuntimePermissionMode>,
    pub(in crate::domain::agents::codex) access_mode: Option<RuntimeAccessMode>,
    pub(in crate::domain::agents::codex) cwd: PathBuf,
    pub(in crate::domain::agents::codex) context_window: Option<u64>,
    /// Whether Cadencr's browser tools skip the approval prompt.
    pub(in crate::domain::agents::codex) browser_trust: CadencrBrowserTrust,
}
