//! Explicit mixed-content marketplace contract. Schema 1 remains provider-only.
use crate::{diagnostics::Diagnostics, package, RegistryError};
use serde_json::Value;

/// Validate a schema-2 discriminated package, rejecting extension fields.
pub fn validate_marketplace_package(value: &Value) -> Result<(), RegistryError> {
    let mut errors = Diagnostics::default();
    validate(value, "package", &mut errors);
    if errors.is_empty() {
        Ok(())
    } else {
        Err(RegistryError::from_messages(errors.into_messages()))
    }
}

pub fn marketplace_package_kind(value: &Value) -> Option<&str> {
    match value.get("kind").and_then(Value::as_str) {
        Some("provider") => Some("provider"),
        Some("theme") => Some("theme"),
        _ => None,
    }
}
pub fn marketplace_package_identity(value: &Value) -> Option<(&str, &str)> {
    let kind = marketplace_package_kind(value)?;
    let descriptor = value
        .get("package")?
        .get(if kind == "theme" { "theme" } else { "agent" })?;
    Some((
        descriptor.get("id")?.as_str()?,
        descriptor.get("version")?.as_str()?,
    ))
}
pub(crate) fn body(value: &Value) -> &Value {
    value.get("package").unwrap_or(value)
}
pub(crate) fn descriptor(value: &Value) -> &Value {
    let body = body(value);
    body.get("theme")
        .or_else(|| body.get("agent"))
        .unwrap_or(&Value::Null)
}
pub(crate) fn kind(value: &Value) -> &str {
    marketplace_package_kind(value).unwrap_or("provider")
}

pub(crate) fn validate(value: &Value, label: &str, errors: &mut Diagnostics) {
    let Some(object) = value.as_object() else {
        errors.push(format!("{label} must be an object"));
        return;
    };
    package::reject_unknown(object, &["kind", "package"], label, errors);
    let Some(kind) = marketplace_package_kind(value) else {
        errors.push(format!("{label}.kind must equal provider or theme"));
        return;
    };
    let content = value.get("package").unwrap_or(&Value::Null);
    if kind == "provider" {
        package::validate_provider_content(content, label, errors);
        return;
    }
    validate_theme(content, label, errors);
}

pub fn valid_theme_id(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= 128
        && id.split('-').all(|part| {
            !part.is_empty()
                && part
                    .bytes()
                    .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit())
        })
}

fn validate_theme(content: &Value, label: &str, errors: &mut Diagnostics) {
    let Some(object) = content.as_object() else {
        errors.push(format!("{label}.package must be an object"));
        return;
    };
    package::reject_unknown(object, &["theme", "host"], label, errors);
    let Some(theme) = content.get("theme").and_then(Value::as_object) else {
        errors.push(format!("{label}.theme must be an object"));
        return;
    };
    package::reject_unknown(
        theme,
        &[
            "id",
            "name",
            "description",
            "version",
            "repository",
            "license",
            "document_version",
            "distribution",
        ],
        label,
        errors,
    );
    if theme
        .get("id")
        .and_then(Value::as_str)
        .is_none_or(|id| !valid_theme_id(id))
    {
        errors.push(format!("{label}.theme.id is invalid"));
    }
    for field in ["name", "description", "license"] {
        if theme
            .get(field)
            .and_then(Value::as_str)
            .is_none_or(|s| s.trim().is_empty() || s.contains('\0'))
        {
            errors.push(format!("{label}.theme.{field} must not be empty"));
        }
    }
    if theme
        .get("version")
        .and_then(Value::as_str)
        .is_none_or(|s| semver::Version::parse(s).is_err())
    {
        errors.push(format!("{label}.theme.version must be semantic version"));
    }
    if !theme
        .get("repository")
        .and_then(Value::as_str)
        .is_some_and(crate::submission::canonical_github_repository)
    {
        errors.push(format!(
            "{label}.theme.repository must be a canonical HTTPS GitHub repository"
        ));
    }
    if theme.get("document_version") != Some(&Value::from(1)) {
        errors.push(format!("{label}.theme.document_version must equal 1"));
    }
    validate_theme_distribution(theme, label, errors);
    validate_theme_host(content, label, errors);
}

/// Resolve the signed distribution origin independently from author provenance.
/// Legacy schema-2 entries encode it in their signed archive URL; new mirrored
/// entries also declare it explicitly. Neither form permits arbitrary HTTPS.
pub fn theme_distribution_repository(
    archive: &str,
    explicit: Option<&Value>,
) -> Result<String, RegistryError> {
    let fail = || {
        RegistryError::single("theme archive must be an exact GitHub release asset matching its distribution repository")
    };
    let url = url::Url::parse(archive).map_err(|_| fail())?;
    let parts = url.path().split('/').collect::<Vec<_>>();
    let segment = |s: &str| {
        !s.is_empty()
            && s != "."
            && s != ".."
            && s.bytes()
                .all(|b| b.is_ascii_alphanumeric() || b"._-".contains(&b))
    };
    if url.scheme() != "https"
        || url.host_str() != Some("github.com")
        || !url.username().is_empty()
        || url.password().is_some()
        || url.port().is_some()
        || url.query().is_some()
        || url.fragment().is_some()
        || url.as_str() != archive
        || parts.len() != 7
        || !parts[0].is_empty()
        || parts[3..5] != ["releases", "download"]
        || ![parts[1], parts[2], parts[5], parts[6]]
            .iter()
            .all(|s| segment(s))
        || parts[6].len() > 128
        || (!parts[6].to_ascii_lowercase().ends_with(".tar.gz")
            && !parts[6].to_ascii_lowercase().ends_with(".tgz"))
    {
        return Err(fail());
    }
    let repository = format!("https://github.com/{}/{}", parts[1], parts[2]);
    if explicit.is_some_and(|value| value.as_str() != Some(repository.as_str())) {
        return Err(fail());
    }
    Ok(repository)
}

fn validate_theme_distribution(
    theme: &serde_json::Map<String, Value>,
    label: &str,
    errors: &mut Diagnostics,
) {
    let Some(distribution) = theme.get("distribution").and_then(Value::as_object) else {
        errors.push(format!("{label}.theme.distribution must be an object"));
        return;
    };
    package::reject_unknown(
        distribution,
        &["archive", "sha256", "repository"],
        label,
        errors,
    );
    if let Err(error) = theme_distribution_repository(
        distribution
            .get("archive")
            .and_then(Value::as_str)
            .unwrap_or_default(),
        distribution.get("repository"),
    ) {
        errors.push(format!("{label}.theme.distribution: {error}"));
    }
    if !distribution
        .get("sha256")
        .and_then(Value::as_str)
        .is_some_and(|s| {
            s.len() == 64
                && s.bytes()
                    .all(|b| b.is_ascii_hexdigit() && !b.is_ascii_uppercase())
        })
    {
        errors.push(format!(
            "{label}.theme.distribution.sha256 must be lowercase SHA256"
        ));
    }
}

fn validate_theme_host(content: &Value, label: &str, errors: &mut Diagnostics) {
    if let Some(host) = content.get("host").and_then(Value::as_object) {
        package::host::validate_optional_assets_host(host, label, errors);
    } else {
        errors.push(format!("{label}.host must be an object"));
    }
    if let Some(icon) = content.pointer("/host/assets/icon").and_then(Value::as_str) {
        if !["png", "jpg", "jpeg", "webp"]
            .iter()
            .any(|ext| icon.to_ascii_lowercase().ends_with(&format!(".{ext}")))
        {
            errors.push(format!("{label}.host.assets.icon must be raster"));
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    pub(crate) fn theme() -> Value {
        json!({"kind":"theme","package":{"theme":{"id":"midnight","name":"Midnight","description":"Dark theme","version":"1.0.0","repository":"https://github.com/acme/themes","license":"MIT","document_version":1,"distribution":{"archive":"https://github.com/acme/themes/releases/download/v1/theme.tar.gz","sha256":"a".repeat(64)}},"host":{"publisher":"acme","compatibility":{"min_app_version":"1.0.0"}}}})
    }
    #[test]
    fn distribution_archive_extension_matches_author_release_case_policy() {
        for name in ["theme.tar.gz", "theme.TAR.GZ", "theme.tgz", "theme.TGZ"] {
            let url = format!("https://github.com/acme/themes/releases/download/v1/{name}");
            assert_eq!(
                theme_distribution_repository(&url, None).unwrap(),
                "https://github.com/acme/themes"
            );
        }
    }
    #[test]
    fn explicit_distribution_repository_is_signed_and_must_match_archive() {
        let mut value = theme();
        value["package"]["theme"]["distribution"]["repository"] =
            json!("https://github.com/acme/themes");
        validate_marketplace_package(&value).unwrap();
        value["package"]["theme"]["distribution"]["repository"] =
            json!("https://github.com/other/themes");
        assert!(validate_marketplace_package(&value).is_err());
        value["package"]["theme"]["distribution"]["repository"] = Value::Null;
        assert!(validate_marketplace_package(&value).is_err());
    }
    #[test]
    fn theme_contract_is_closed_platform_independent_and_no_assets_required() {
        let value = theme();
        validate_marketplace_package(&value).unwrap();
        assert!(matches!(
            crate::parse_marketplace_package(&value).unwrap(),
            crate::MarketplacePackage::Theme(_)
        ));
        assert_eq!(
            marketplace_package_identity(&value),
            Some(("midnight", "1.0.0"))
        );
        for assets in [
            Value::Null,
            json!({}),
            json!({"icon":"../preview.png"}),
            json!({"icon":"preview.svg"}),
        ] {
            let mut bad = value.clone();
            bad["package"]["host"]["assets"] = assets;
            assert!(validate_marketplace_package(&bad).is_err());
        }
        for field in ["cmd", "args", "env", "binary", "targets"] {
            let mut bad = value.clone();
            bad["package"]["theme"]["distribution"][field] = json!({});
            assert!(
                validate_marketplace_package(&bad).is_err(),
                "accepted {field}"
            );
        }
        let mut bad = value.clone();
        bad["kind"] = json!("provider");
        assert!(validate_marketplace_package(&bad).is_err());
        let mut bad = value;
        bad["unknown"] = json!(true);
        assert!(validate_marketplace_package(&bad).is_err());
    }
    #[test]
    fn provider_content_cannot_dispatch_nested_marketplace_envelopes() {
        for content in [theme(), json!({"kind":"provider", "package":theme()})] {
            let value = json!({"kind":"provider", "package":content});
            assert!(validate_marketplace_package(&value).is_err());
            assert!(crate::parse_marketplace_package(&value).is_err());
        }
    }

    #[test]
    fn schema2_submissions_and_plans_preserve_discriminator_and_exact_source() {
        let submission = json!({"schema_version":2,"package":theme(),"source":{"repository":"https://github.com/acme/themes","commit":"b".repeat(40),"tag":"v1"},"changelog":"Release"});
        crate::validate_submission(&submission).unwrap();
        let plan = crate::create_publication_plan(&submission, "cadencr/registry").unwrap();
        assert_eq!(plan["targets"].as_array().unwrap().len(), 1);
        assert_eq!(plan["targets"][0]["target"], "theme");
        assert_eq!(plan["mirrored_package"]["kind"], "theme");
        assert!(plan["mirrored_package"]["package"].get("agent").is_none());
        let mut bad = submission;
        bad["source"]["repository"] = json!("https://github.com/acme/other");
        assert!(crate::validate_submission(&bad).is_err());
    }
    #[test]
    fn malformed_types_paths_and_ownership_fail_closed() {
        for path in [
            "/kind",
            "/package/theme",
            "/package/host",
            "/package/theme/distribution",
        ] {
            let mut bad = theme();
            *bad.pointer_mut(path).unwrap() = Value::Null;
            assert!(validate_marketplace_package(&bad).is_err());
        }
        for text in [
            "",
            " ",
            "../midnight",
            "midnight/evil",
            "midnight-",
            "mid--night",
            "mid_night",
            "mid.night",
        ] {
            let mut bad = theme();
            bad["package"]["theme"]["id"] = json!(text);
            assert!(validate_marketplace_package(&bad).is_err());
        }
        for url in [
            "https://127.0.0.1/theme.tgz",
            "https://github.com/acme/themes/releases/download/v1/theme.tgz?x",
            "https://github.com/acme/themes/releases/download/v1/theme.tgz#x",
        ] {
            let mut bad = theme();
            bad["package"]["theme"]["distribution"]["archive"] = json!(url);
            assert!(validate_marketplace_package(&bad).is_err());
        }
        let original = theme();
        let mut next = original.clone();
        next["package"]["theme"]["version"] = json!("2.0.0");
        next["package"]["host"]["publisher"] = json!("other");
        assert!(crate::catalog::validate_catalog_identities_with_label(
            &[original, next],
            "repository"
        )
        .is_err());
    }
}
