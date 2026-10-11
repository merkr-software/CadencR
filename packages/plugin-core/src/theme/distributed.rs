//! Strict, bounded boundaries for marketplace-delivered declarative content.
use serde_json::Value;

use super::{chrome, schema, validate, ThemeDocument, ThemeIssue};

pub const MAX_DISTRIBUTED_DOCUMENT_BYTES: usize = 256 * 1024;
pub const MAX_DISTRIBUTED_ASSET_BYTES: usize = 512 * 1024;

pub fn parse_distributed_document(bytes: &[u8]) -> Result<ThemeDocument, Vec<ThemeIssue>> {
    if bytes.len() > MAX_DISTRIBUTED_DOCUMENT_BYTES {
        return Err(vec![ThemeIssue::document("theme document exceeds 256 KiB")]);
    }
    let value: Value = serde_json::from_slice(bytes)
        .map_err(|error| vec![ThemeIssue::document(format!("invalid theme JSON: {error}"))])?;
    // Derive the field allowlists from the existing schema, not a second copy
    // of the vocabulary. Chrome's own serde contracts already reject unknowns.
    let contract: Value = serde_json::from_str(&schema::render()).map_err(|error| {
        vec![ThemeIssue::document(format!(
            "invalid theme schema: {error}"
        ))]
    })?;
    reject_unknown(&value, &contract, "")?;
    let document: ThemeDocument = serde_json::from_value(value).map_err(|error| {
        vec![ThemeIssue::document(format!(
            "invalid theme document: {error}"
        ))]
    })?;
    let mut issues = validate::validate(&document);
    if let Some(image) = &document.chrome.texture.image {
        if !matches!(
            chrome::asset_extension(&image.asset),
            Some("png" | "jpg" | "jpeg" | "webp")
        ) {
            issues.push(ThemeIssue::new(
                "chrome.texture.image.asset",
                "distributed textures must be raster images; SVG is not allowed",
            ));
        }
    }
    if issues.is_empty() {
        Ok(document)
    } else {
        Err(issues)
    }
}

fn reject_unknown(value: &Value, contract: &Value, path: &str) -> Result<(), Vec<ThemeIssue>> {
    let Some(properties) = contract.get("properties").and_then(Value::as_object) else {
        return Ok(());
    };
    let Some(object) = value.as_object() else {
        return Ok(());
    };
    for (key, child) in object {
        let field = if path.is_empty() {
            key.clone()
        } else {
            format!("{path}.{key}")
        };
        let Some(child_contract) = properties.get(key) else {
            return Err(vec![ThemeIssue::new(
                field,
                "unknown distributed theme field",
            )]);
        };
        reject_unknown(child, child_contract, &field)?;
    }
    Ok(())
}

/// Validate bytes before packaging or registering a distributed texture. The
/// caller must also enforce regular-file/no-symlink containment when reading.
pub fn validate_distributed_asset(name: &str, bytes: &[u8]) -> Result<(), ThemeIssue> {
    let field = "chrome.texture.image.asset";
    let mut issues = Vec::new();
    chrome::validate_asset_name(name, &mut issues);
    if let Some(issue) = issues.into_iter().next() {
        return Err(issue);
    }
    if bytes.is_empty() || bytes.len() > MAX_DISTRIBUTED_ASSET_BYTES {
        return Err(ThemeIssue::new(field, "texture must contain 1–512 KiB"));
    }
    let extension = chrome::asset_extension(name)
        .ok_or_else(|| ThemeIssue::new(field, "invalid raster extension"))?;
    super::raster::dimensions(extension, bytes)
        .map(|_| ())
        .map_err(|message| ThemeIssue::new(field, message))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::theme::test_support::valid_document;

    #[test]
    fn distributed_is_strict_while_local_parser_remains_compatible() {
        let mut value = serde_json::to_value(valid_document()).unwrap();
        assert!(parse_distributed_document(&serde_json::to_vec(&value).unwrap()).is_ok());
        value["script"] = Value::String("evil.js".into());
        assert!(serde_json::from_value::<ThemeDocument>(value.clone()).is_ok());
        assert!(parse_distributed_document(&serde_json::to_vec(&value).unwrap()).is_err());
        value.as_object_mut().unwrap().remove("script");
        value["xterm"]["execute"] = Value::Bool(true);
        assert!(parse_distributed_document(&serde_json::to_vec(&value).unwrap()).is_err());
    }

    #[test]
    fn distributed_checks_shared_tokens_colors_and_document_budget() {
        let mut value = serde_json::to_value(valid_document()).unwrap();
        value["cssVars"]["--background"] = Value::String("url(https://evil.invalid)".into());
        assert!(parse_distributed_document(&serde_json::to_vec(&value).unwrap()).is_err());
        assert!(
            parse_distributed_document(&vec![b' '; MAX_DISTRIBUTED_DOCUMENT_BYTES + 1]).is_err()
        );
    }

    #[test]
    fn textures_are_bounded_local_raster_bytes_not_scripts_or_svg() {
        assert!(validate_distributed_asset("paper.png", b"\x89PNG\r\n\x1a\nimage").is_err());
        for name in [
            "../paper.png",
            "a/b.png",
            "https://x/p.png",
            "image.svg",
            "script.js",
        ] {
            assert!(validate_distributed_asset(name, b"<svg onload='evil()'/>").is_err());
        }
        assert!(validate_distributed_asset("image.png", b"<script/>").is_err());
        assert!(
            validate_distributed_asset("image.png", &vec![0; MAX_DISTRIBUTED_ASSET_BYTES + 1])
                .is_err()
        );
    }
}
