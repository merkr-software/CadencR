use super::util::{reject_unknown, valid_identifier, valid_relative_path, valid_semver};
use crate::diagnostics::Diagnostics;
use serde_json::{Map, Value};

pub(super) fn validate_host(host: &Map<String, Value>, label: &str, errors: &mut Diagnostics) {
    reject_unknown(
        host,
        &["publisher", "compatibility", "assets"],
        label,
        errors,
    );
    if !host
        .get("publisher")
        .and_then(Value::as_str)
        .is_some_and(valid_identifier)
    {
        errors.push(format!("{label}.publisher is invalid"));
    }
    let Some(compatibility) = host.get("compatibility").and_then(Value::as_object) else {
        errors.push(format!("{label}.compatibility must be an object"));
        return;
    };
    reject_unknown(
        compatibility,
        &["min_app_version", "max_app_version"],
        &format!("{label}.compatibility"),
        errors,
    );
    if !compatibility
        .get("min_app_version")
        .and_then(Value::as_str)
        .is_some_and(valid_semver)
    {
        errors.push(format!(
            "{label}.compatibility.min_app_version must be semantic version"
        ));
    }
    if compatibility.get("max_app_version").is_some()
        && !compatibility
            .get("max_app_version")
            .and_then(Value::as_str)
            .is_some_and(valid_semver)
    {
        errors.push(format!(
            "{label}.compatibility.max_app_version must be semantic version"
        ));
    }
    if let (Some(minimum), Some(maximum)) = (
        compatibility
            .get("min_app_version")
            .and_then(Value::as_str)
            .and_then(|value| semver::Version::parse(value).ok()),
        compatibility
            .get("max_app_version")
            .and_then(Value::as_str)
            .and_then(|value| semver::Version::parse(value).ok()),
    ) {
        if maximum < minimum {
            errors.push(format!("{label}.compatibility maximum precedes minimum"));
        }
    }
    let Some(assets) = host.get("assets").and_then(Value::as_object) else {
        errors.push(format!("{label}.assets must be an object"));
        return;
    };
    reject_unknown(
        assets,
        &["icon", "readme", "license"],
        &format!("{label}.assets"),
        errors,
    );
    for key in ["icon", "readme", "license"] {
        if (key == "icon" || assets.contains_key(key))
            && !assets
                .get(key)
                .and_then(Value::as_str)
                .is_some_and(valid_relative_path)
        {
            errors.push(format!(
                "{label}.assets.{key} must be a bounded relative package path"
            ));
        }
    }
    if let Some(icon) = assets.get("icon").and_then(Value::as_str) {
        let extension = icon
            .rsplit_once('.')
            .map(|(_, extension)| extension.to_ascii_lowercase());
        if !extension.is_some_and(|ext| {
            [
                "avif", "bmp", "gif", "ico", "jpeg", "jpg", "png", "svg", "webp",
            ]
            .contains(&ext.as_str())
        }) {
            errors.push(format!(
                "{label}.assets.icon has an unsupported image extension"
            ));
        }
    }
}
