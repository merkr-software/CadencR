use std::path::Path;

use axum::http::{header, StatusCode};
use axum::response::Response;

use crate::error::AppError;

/// Maximum image payload accepted by the editor and Git diff preview routes.
pub const MAX_IMAGE_FILE_SIZE: usize = 25 * 1024 * 1024;

/// Return the MIME type for an image extension supported by Chromium.
///
/// The desktop frontend's `isImageFile` helper must stay in lockstep with
/// this allowlist.
pub fn image_mime_for_path(path: &Path) -> Option<&'static str> {
    let extension = path
        .extension()
        .and_then(|value| value.to_str())
        .map(str::to_ascii_lowercase)
        .unwrap_or_default();

    match extension.as_str() {
        "png" => Some("image/png"),
        "jpg" | "jpeg" => Some("image/jpeg"),
        "gif" => Some("image/gif"),
        "webp" => Some("image/webp"),
        "bmp" => Some("image/bmp"),
        "ico" => Some("image/x-icon"),
        "avif" => Some("image/avif"),
        _ => None,
    }
}

/// The same allowlist plus SVG, for the places that render through an `<img>`
/// tag rather than the editor: project icons and theme textures.
///
/// SVG cannot simply join the list above — that one is kept in lockstep with the
/// frontend's `isImageFile` helper, so widening it would also change the editor
/// and Git diff image routes. Serving it here is safe because an `<img>` neither
/// executes scripts nor loads external references.
///
/// `.icns` is in neither list: Chromium cannot decode it, so offering one as a
/// choice would render an empty box.
pub fn image_or_svg_mime_for_path(path: &Path) -> Option<&'static str> {
    if path
        .extension()
        .is_some_and(|ext| ext.eq_ignore_ascii_case("svg"))
    {
        return Some("image/svg+xml");
    }
    image_mime_for_path(path)
}

/// Build a raw image response whose stable URL always revalidates its bytes.
pub fn image_response(bytes: Vec<u8>, mime: &str) -> Result<Response, AppError> {
    let len = bytes.len();
    Response::builder()
        .status(StatusCode::OK)
        .header(header::CONTENT_TYPE, mime)
        .header(header::CONTENT_LENGTH, len)
        .header(header::CACHE_CONTROL, "no-cache")
        .body(axum::body::Body::from(bytes))
        .map_err(|e| AppError::internal(format!("Failed to build response: {e}")))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn recognizes_supported_image_extensions_case_insensitively() {
        assert_eq!(
            image_mime_for_path(Path::new("image.png")),
            Some("image/png")
        );
        assert_eq!(
            image_mime_for_path(Path::new("IMAGE.JPEG")),
            Some("image/jpeg")
        );
        assert_eq!(
            image_mime_for_path(Path::new("icon.avif")),
            Some("image/avif")
        );
    }

    #[test]
    fn rejects_unsupported_extensions() {
        assert_eq!(image_mime_for_path(Path::new("image.svg")), None);
        assert_eq!(image_mime_for_path(Path::new("archive.zip")), None);
    }

    #[test]
    fn raw_image_response_sets_type_length_and_revalidation_headers() {
        let response = image_response(vec![1, 2, 3], "image/png").unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        assert_eq!(response.headers()[header::CONTENT_TYPE], "image/png");
        assert_eq!(response.headers()[header::CONTENT_LENGTH], "3");
        assert_eq!(response.headers()[header::CACHE_CONTROL], "no-cache");
    }
}
