//! The files a theme's texture can reference, delivered as `data:` URLs.
//!
//! A theme may point its image texture at a file in its own folder. The
//! renderer can't fetch that file itself — it may be talking to a remote
//! backend, and a stylesheet `url()` carries no API token — so the bytes ride
//! along with the theme, base64-encoded. The size cap is what keeps that
//! honest: the theme list is refetched on every save while the user is editing.

use std::collections::BTreeMap;
use std::path::Path;

use base64::engine::general_purpose::STANDARD;
use base64::Engine as _;
use tokio::fs;

use super::chrome::asset_extension;
use super::models::{ThemeDocument, ThemeIssue};
use crate::shared::image_file::image_or_svg_mime_for_path;

/// Inlined assets travel in every theme listing, so this is a budget, not a
/// filesystem limit: a seamless noise tile or a paper grain is a few dozen KB.
const MAX_ASSET_BYTES: u64 = 512 * 1024;

/// The files `document` references. One entry per referenced asset; a theme
/// with no image texture reads nothing from disk.
///
/// Failures are issues rather than errors: a texture pointing at a file the
/// user hasn't added yet is a theme to fix, not a request to fail.
pub async fn load(
    dir: &Path,
    document: &ThemeDocument,
) -> (BTreeMap<String, String>, Vec<ThemeIssue>) {
    let mut assets = BTreeMap::new();
    let mut issues = Vec::new();
    let Some(image) = &document.chrome.texture.image else {
        return (assets, issues);
    };
    // An unpaintable or escaping name is already reported by `chrome::validate`;
    // re-checking here is what makes the path below safe on its own terms.
    if asset_extension(&image.asset).is_none() {
        return (assets, issues);
    }
    match read_data_url(&dir.join(&image.asset)).await {
        Ok(url) => {
            assets.insert(image.asset.clone(), url);
        }
        Err(message) => issues.push(ThemeIssue::new("chrome.texture.image.asset", message)),
    }
    (assets, issues)
}

async fn read_data_url(path: &Path) -> Result<String, String> {
    // The extension is one of `chrome::ASSET_EXTENSIONS`, all of which the
    // shared allowlist knows — but resolving it here rather than assuming keeps
    // a future addition to that list from being served as the wrong type.
    let mime = image_or_svg_mime_for_path(path)
        .ok_or_else(|| "is not an image format Cadencr can paint".to_string())?;
    let metadata = fs::metadata(path).await.map_err(|e| {
        if e.kind() == std::io::ErrorKind::NotFound {
            "no such file in this theme's folder".to_string()
        } else {
            format!("could not be read: {e}")
        }
    })?;
    if metadata.len() > MAX_ASSET_BYTES {
        return Err(format!(
            "is {} KiB — a texture asset must be at most {} KiB",
            metadata.len() / 1024,
            MAX_ASSET_BYTES / 1024
        ));
    }
    let bytes = fs::read(path)
        .await
        .map_err(|e| format!("could not be read: {e}"))?;
    Ok(format!("data:{mime};base64,{}", STANDARD.encode(bytes)))
}

/// Copy the asset files `document` references from another theme's folder.
///
/// Duplication is how every theme is made, so a copy that dropped the texture
/// file would silently produce a different-looking theme. A source that has no
/// such file is not an error here — the new theme is listed with the same
/// "no such file" issue the original would have.
pub async fn copy_from(source: &Path, target: &Path, document: &ThemeDocument) {
    let Some(image) = &document.chrome.texture.image else {
        return;
    };
    if asset_extension(&image.asset).is_none() {
        return;
    }
    // Best-effort: the theme itself is already written, and a missing asset is
    // surfaced as an issue on the new theme rather than as a failed create.
    if let Err(error) = fs::copy(source.join(&image.asset), target.join(&image.asset)).await {
        tracing::warn!(asset = %image.asset, %error, "could not copy the theme texture");
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::domain::themes::chrome::{ThemeBlend, ThemeImage, ThemeImageFit};
    use crate::domain::themes::paths;
    use crate::domain::themes::test_support::valid_document;

    fn with_image(asset: &str) -> ThemeDocument {
        let mut document = valid_document();
        document.chrome.texture.image = Some(ThemeImage {
            asset: asset.into(),
            opacity: 0.2,
            blend: ThemeBlend::Normal,
            fit: ThemeImageFit::Tile,
            scale: 320.0,
        });
        document
    }

    fn theme_dir(id: &str) -> std::path::PathBuf {
        paths::theme_dir(id).expect("valid id")
    }

    #[tokio::test]
    async fn a_theme_without_an_image_reads_nothing() {
        let (assets, issues) = load(&theme_dir("any"), &valid_document()).await;
        assert!(assets.is_empty());
        assert!(issues.is_empty());
    }

    #[tokio::test]
    async fn inlines_a_referenced_asset_as_a_data_url() {
        let dir = theme_dir("mine");
        fs::create_dir_all(&dir).await.expect("creates");
        fs::write(dir.join("paper.png"), b"\x89PNG\r\n")
            .await
            .expect("writes");

        let (assets, issues) = load(&dir, &with_image("paper.png")).await;
        assert!(issues.is_empty(), "{issues:?}");
        assert_eq!(
            assets.get("paper.png").map(String::as_str),
            Some("data:image/png;base64,iVBORw0K")
        );
    }

    #[tokio::test]
    async fn a_missing_asset_is_an_issue_not_an_error() {
        let (assets, issues) = load(&theme_dir("mine"), &with_image("paper.png")).await;
        assert!(assets.is_empty());
        assert_eq!(issues.len(), 1);
        assert!(
            issues[0].describe().contains("no such file"),
            "{}",
            issues[0].describe()
        );
    }

    #[tokio::test]
    async fn an_oversized_asset_is_refused_by_size_not_read_into_memory() {
        let dir = theme_dir("mine");
        fs::create_dir_all(&dir).await.expect("creates");
        fs::write(
            dir.join("huge.png"),
            vec![0u8; (MAX_ASSET_BYTES + 1) as usize],
        )
        .await
        .expect("writes");

        let (assets, issues) = load(&dir, &with_image("huge.png")).await;
        assert!(assets.is_empty());
        // KiB, matching both the arithmetic above and what `THEME.md` promises.
        assert!(issues[0].describe().contains("at most 512 KiB"));
    }

    #[tokio::test]
    async fn duplicating_carries_the_asset_into_the_new_folder() {
        let source = theme_dir("source");
        let target = theme_dir("target");
        fs::create_dir_all(&source).await.expect("creates");
        fs::create_dir_all(&target).await.expect("creates");
        fs::write(source.join("paper.png"), b"\x89PNG\r\n")
            .await
            .expect("writes");

        let document = with_image("paper.png");
        copy_from(&source, &target, &document).await;

        let (assets, issues) = load(&target, &document).await;
        assert!(issues.is_empty(), "{issues:?}");
        assert!(assets.contains_key("paper.png"));
    }
}
