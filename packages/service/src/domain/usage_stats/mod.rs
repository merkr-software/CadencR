//! Long-lived record of how many words the user has exchanged with each
//! provider / model / thinking-effort combination.
//!
//! Deliberately decoupled from conversations: words are folded into a per-day
//! bucket keyed only by (provider, model, effort), so archiving a feature or
//! deleting a conversation never erases the history behind the settings Stats
//! tab. Recording is fire-and-forget (see [`recorder::record_session_words`])
//! because it sits on the agent's streaming hot path.

pub mod backfill;
pub mod health;
pub mod models;
pub mod pending;
pub mod recorder;
pub mod repository;
pub mod routes;
pub mod word_count;

pub use backfill::spawn as spawn_backfill;
pub use pending::flush as flush_pending_writes;
pub use recorder::{record_dispatched_prompt, record_session_words};
pub use word_count::TurnWordUsage;
