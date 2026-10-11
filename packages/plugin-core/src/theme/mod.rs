//! Shared declarative theme vocabulary and validation. Local parsing remains
//! backwards-compatible; distributed documents pass the strict boundary.
pub mod chrome;
pub mod color;
mod distributed;
mod folder;
mod raster;
pub use folder::{validate_theme_folder, ValidatedThemeFolder};
pub mod models;
pub mod schema;
pub mod tokens;
pub mod validate;
pub use distributed::{
    parse_distributed_document, validate_distributed_asset, MAX_DISTRIBUTED_ASSET_BYTES,
    MAX_DISTRIBUTED_DOCUMENT_BYTES,
};
pub use models::{ThemeAppearance, ThemeDocument, ThemeIssue, XtermPalette};
#[cfg(test)]
mod test_support;
