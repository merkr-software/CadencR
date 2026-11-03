//! Bounded compatibility mapping for installations predating marketplace receipts.
mod entries;
mod types;
pub use entries::CATALOG;
pub use types::{CatalogEntry, LegacyInstall, ServerRole};
