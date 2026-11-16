//! Where user themes live on disk, and what an id is allowed to be.

use std::path::{Path, PathBuf};

use crate::error::AppError;
use crate::shared::slug::slugify;

pub const THEME_FILE_NAME: &str = "theme.json";

/// `~/.cadencr/plugins/themes` in production — never inside the app bundle,
/// whose resources are read-only and replaced wholesale on update. User content
/// has to outlive that.
///
/// Themes are the first thing a user can author, not the last, so they live
/// under a `plugins/` root the later extensibility steps share rather than as
/// another top-level sibling of `settings/` and `lsp/`.
pub fn themes_dir() -> PathBuf {
    crate::domain::settings_store::dir::data_sibling_dir("plugins").join("themes")
}

pub fn theme_dir(id: &str) -> Result<PathBuf, AppError> {
    if !is_valid_id(id) {
        return Err(AppError::BadRequest(format!(
            "`{id}` is not a valid theme id"
        )));
    }
    Ok(themes_dir().join(id))
}

/// The id a theme folder carries: its directory name, which is what
/// [`theme_dir`] joined to produce it.
///
/// Empty for a path that has no final component, which no theme directory does
/// — but the callers all need a `&str` for a message or a response field, not a
/// reason to fail.
pub fn id_of(dir: &Path) -> &str {
    dir.file_name()
        .and_then(|name| name.to_str())
        .unwrap_or_default()
}

/// A theme id is a lowercase slug — exactly what `shared::slug::slugify`
/// produces. Restrictive by construction: the id is a path segment *and* lands
/// in a CSS attribute selector, so `.`, `/` and quotes can never appear in one.
pub fn is_valid_id(id: &str) -> bool {
    !id.is_empty() && id == slugify(id)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn every_non_empty_slug_is_a_valid_id() {
        // The store slugifies labels into ids, so the two definitions must
        // agree — otherwise creating a theme produces an id it then rejects.
        for label in ["My Theme", "Dracula (copy)", "Café Noir", &"A".repeat(200)] {
            let slug = slugify(label);
            assert!(is_valid_id(&slug), "{label} -> {slug}");
        }
        // A label with no alphanumerics slugifies to nothing; the store
        // substitutes a fallback id rather than writing an unusable path.
        assert_eq!(slugify("  ...  "), "");
        assert!(!is_valid_id(""));
    }

    #[test]
    fn rejects_traversal_and_selector_breaking_ids() {
        assert!(!is_valid_id(""));
        assert!(!is_valid_id(".."));
        assert!(!is_valid_id("a/b"));
        assert!(!is_valid_id("My-Theme"));
        assert!(!is_valid_id("theme\"]"));
        assert!(!is_valid_id("-lead"));
        assert!(is_valid_id("my-theme-2"));
    }

    #[test]
    fn theme_dir_refuses_an_invalid_id() {
        assert!(theme_dir("../escape").is_err());
    }

    #[test]
    fn themes_dir_lives_under_the_plugins_root() {
        let dir = themes_dir();
        assert_eq!(dir.file_name().unwrap(), "themes");
        assert_eq!(dir.parent().unwrap().file_name().unwrap(), "plugins");
    }
}
