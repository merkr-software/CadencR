//! Long-lived record of provider-reported token usage for each
//! provider / model / thinking-effort combination.
//!
//! Deliberately decoupled from conversations: tokens are folded into a per-day
//! bucket keyed only by (provider, model, effort), so archiving a feature or
//! deleting a conversation never erases the history behind the settings Stats
//! tab. Recording happens when the provider publishes native usage metadata,
//! separately from the context-window snapshot used by the live usage bar.

pub mod health;
pub mod history_import;
pub mod models;
mod pending;
pub mod recorder;
pub mod repository;
pub mod routes;

pub(crate) use models::provider_message_event_id;
pub use models::UsageAttribution;
pub use pending::flush as flush_pending_writes;
pub use recorder::{record_runtime_usage, snapshot_attribution};
