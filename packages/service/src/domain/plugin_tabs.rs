//! Custom tabs: local web-UI plugins shown as a feature-page tab.
//!
//! The contract is `docs/CUSTOM_TABS.md`. A tab is a folder under
//! `~/.cadencr/plugins/tabs/<id>/` holding `tab.json` and a built `dist/`;
//! validation lives in `cadencr_plugin_core::tab` so the CLI agrees with the
//! service. This module owns the host side: the registry of folders, the
//! enablement/consent/configuration stores, static asset serving with the
//! guest CSP, the watcher that drives live reload, and authoring.
//!
//! Entry points for other modules:
//! - [`registry::get`] / [`registry::list`] → [`registry::LocalTab`] (validated
//!   manifest + permissions hash);
//! - [`enablement::effective`] — may tab X run in project P right now;
//! - [`config::resolved_values`] / [`config::secret_value`] — settings, server-side;
//! - [`grants::GrantStore`] + [`principal::authorize`] + [`policy::POLICY`] —
//!   the plugin token, checked by `auth_middleware` (§4.3);
//! - [`surface::plugin_surface`] — the filtered OpenAPI document the SDK's
//!   typed client is generated from;
//! - [`exec::run`] / [`backend::BackendSupervisor`] — the tabs that run
//!   commands or a native backend (§4.6, §4.7), recorded in
//!   [`activity::ActivityLog`]; [`presence::PresenceStore`] says which tabs
//!   are open, so a backend stops with its tab.

pub mod activity;
pub mod assets;
pub mod authoring;
pub mod backend;
pub mod config;
pub mod consent;
pub mod enablement;
pub mod exec;
pub mod grants;
pub mod managed;
pub mod models;
pub mod net;
pub mod paths;
pub mod plugin_routes;
pub mod policy;
pub mod presence;
pub mod principal;
pub mod registry;
pub mod routes;
pub mod runtime_routes;
pub mod scaffold;
pub mod socket;
pub mod storage;
pub mod summary;
pub mod surface;
pub mod watcher;
pub mod workspace;

/// The shared native backend fixture (see its module docs).
#[cfg(test)]
#[path = "../../tests/fixtures/native_tab_backend/install.rs"]
mod native_tab_backend;
#[cfg(test)]
mod revocation_tests;
#[cfg(test)]
mod test_support;

pub use plugin_routes::plugin_tabs_loopback_router;
pub use routes::plugin_tabs_router;
pub use watcher::PluginTabChangedEvent;
