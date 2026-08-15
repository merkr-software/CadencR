//! Developer workspaces for authoring code-backed provider connectors.
//!
//! This is deliberately not a marketplace installer. It creates an ordinary
//! Git-backed Cadencr project, seeds the provider executable contract, and
//! installs a host-local descriptor whose activation remains restart-gated.

mod models;
pub mod routes;
mod scaffold;
mod workspace;

pub use models::{CreateProviderWorkspaceRequest, ProviderWorkspace};
