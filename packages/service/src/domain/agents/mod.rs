pub mod acp;
pub mod adapter;
pub mod canonical;
pub mod claude_code;
pub mod codex;
pub mod config_migration;
pub mod cursor;
pub mod discovery;
mod mcp_tool_names;
pub mod model_refs;
pub mod opencode;
pub mod orchestration_skills;
pub mod permission_modes;
pub mod providers;
pub mod response_style;
pub mod runtime;
pub mod selection;

pub use discovery::apply_binary_overrides_from_settings;
pub use providers::{
    default_provider_id, resolve_effective_provider, runtime_adapter, runtime_session_finished,
    shutdown_runtime_servers, spawn_runtime_startup_warmups,
};
// `SelectionError` is only ever used via `.to_string()`, never named directly.
#[allow(unused_imports)]
pub use selection::{resolve_selection, ResolvedSelection, SelectionError, SelectionOrigin};
