//! User-authored color themes.
//!
//! A theme is pure data — a closed set of design-token values plus an xterm
//! palette — stored as `~/.cadencr/plugins/themes/<id>/theme.json`. There is no
//! code to sandbox, which is why themes are the first extensibility step; what
//! this module establishes is the pipeline the later ones reuse: read from a
//! user-owned directory under `plugins/`, validate hard, surface failures,
//! watch for edits.
//!
//! Each theme owning a whole directory (rather than being one file in a shared
//! one) is deliberate: it is the unit a user — or an agent working on their
//! behalf — can be pointed at as a working directory.
//!
//! The renderer never touches the filesystem for these — it may be talking to a
//! remote backend — so everything goes through `routes`.

pub mod assets;
pub mod check;
pub mod chrome;
pub mod color;
pub mod managed;
pub mod models;
pub mod paths;
pub mod routes;
pub mod scaffold;
pub mod schema;
pub mod store;
pub mod tokens;
pub mod validate;
pub mod watcher;
pub mod workspace;

#[cfg(test)]
mod test_support;

pub use routes::themes_router;
pub use watcher::ThemesChangeEvent;
