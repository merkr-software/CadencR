//! Index rules for `tab.backend` and `tab.distribution.binary`.
//!
//! Under [`Rules::Publish`] (registry, publisher, submissions, author CLI)
//! the protocol must be one this build speaks and every platform key one it
//! knows. Under [`Rules::Consume`] (the app reading a signed catalog) any
//! protocol number and any well-formed platform key are accepted, so a newer
//! registry's entry is "not installable here" rather than a catalog the app
//! must reject whole; the shapes stay closed and bounded either way.
use cadencr_plugin_core::tab::{
    is_clean_relative_path, reasoning_ok, supported_backend_protocols, TabPlatform,
    MANIFEST_FILE_NAME, MAX_REASONING_CHARS, SUPPORTED_BACKEND_PROTOCOLS,
};
use serde_json::{Map, Value};

use super::{MAX_TAB_BACKEND_ARCHIVE_BYTES, MAX_TAB_BACKEND_EXECUTABLE_BYTES, TAB_BINARY_FIELDS};
use crate::diagnostics::Diagnostics;
use crate::digest::is_lower_sha256;
use crate::marketplace::Rules;
use crate::{package, GitHubReleaseArchive};

/// Longest platform key a consumed catalog may carry.
const MAX_PLATFORM_KEY_BYTES: usize = 64;

/// `tab.backend` is present exactly when `tab.distribution.binary` is; both
/// are closed, and every backend archive is a `.tar.gz` asset of the web
/// archive's own release (same repository, same tag).
pub(crate) fn validate_descriptor(
    tab: &Map<String, Value>,
    label: &str,
    rules: Rules,
    errors: &mut Diagnostics,
) {
    let distribution = tab.get("distribution").and_then(Value::as_object);
    let backend = tab.get("backend");
    let binary = distribution.and_then(|distribution| distribution.get("binary"));
    if backend.is_some() != binary.is_some() {
        errors.push(format!(
            "{label}.tab.backend and {label}.tab.distribution.binary must be declared together"
        ));
    }
    if let Some(backend) = backend {
        validate_backend(backend, &format!("{label}.tab.backend"), rules, errors);
    }
    if let Some(binary) = binary {
        let web = distribution
            .and_then(|distribution| distribution.get("archive"))
            .and_then(Value::as_str)
            .and_then(|archive| crate::parse_github_release_archive_url(archive).ok());
        validate_binary(
            binary,
            web.as_ref(),
            &format!("{label}.tab.distribution.binary"),
            rules,
            errors,
        );
    }
}

fn validate_backend(value: &Value, label: &str, rules: Rules, errors: &mut Diagnostics) {
    let Some(backend) = value.as_object() else {
        errors.push(format!("{label} must be an object"));
        return;
    };
    package::reject_unknown(backend, &["protocol", "reasoning"], label, errors);
    let protocol = backend
        .get("protocol")
        .and_then(Value::as_u64)
        .and_then(|protocol| u32::try_from(protocol).ok());
    match (rules, protocol) {
        (Rules::Publish, Some(protocol)) if SUPPORTED_BACKEND_PROTOCOLS.contains(&protocol) => {}
        (Rules::Consume, Some(protocol)) if protocol >= 1 => {}
        (Rules::Consume, _) => errors.push(format!(
            "{label}.protocol must be a positive 32-bit integer"
        )),
        (Rules::Publish, _) => errors.push(format!(
            "{label}.protocol must be a supported backend protocol ({})",
            supported_backend_protocols()
        )),
    }
    if !reasoning_ok(backend.get("reasoning").and_then(Value::as_str)) {
        errors.push(format!(
            "{label}.reasoning must be 1–{MAX_REASONING_CHARS} characters of text"
        ));
    }
}

fn validate_binary(
    value: &Value,
    web: Option<&GitHubReleaseArchive>,
    label: &str,
    rules: Rules,
    errors: &mut Diagnostics,
) {
    let Some(targets) = value.as_object() else {
        errors.push(format!("{label} must be an object"));
        return;
    };
    if targets.is_empty() {
        errors.push(format!(
            "{label} must declare at least one platform ({})",
            TabPlatform::list()
        ));
    }
    if web.is_none() {
        errors.push(format!(
            "{label} requires a valid web archive to bind its release"
        ));
    }
    for (platform, target) in targets {
        if errors.is_full() {
            break;
        }
        let field = format!("{label}.{platform}");
        let known = TabPlatform::parse(platform).is_some();
        match rules {
            Rules::Publish if !known => errors.push(format!(
                "{field}: `{platform}` is not a tab backend platform ({})",
                TabPlatform::list()
            )),
            Rules::Consume if !well_formed_platform_key(platform) => errors.push(format!(
                "{label}: platform key `{}` must be 1–{MAX_PLATFORM_KEY_BYTES} bytes of a-z, 0-9, `-` or `_`",
                platform.escape_debug()
            )),
            Rules::Publish | Rules::Consume => {}
        }
        match target.as_object() {
            Some(target) => validate_target(target, web, &field, errors),
            None => errors.push(format!("{field} must be an object")),
        }
    }
}

fn validate_target(
    target: &Map<String, Value>,
    web: Option<&GitHubReleaseArchive>,
    label: &str,
    errors: &mut Diagnostics,
) {
    package::reject_unknown(target, &TAB_BINARY_FIELDS, label, errors);
    let text = |field: &str| target.get(field).and_then(Value::as_str);
    match text("archive").map(crate::parse_github_release_archive_url) {
        Some(Ok(archive)) => {
            if !archive.asset.ends_with(".tar.gz") {
                errors.push(format!("{label}.archive must be a .tar.gz asset"));
            }
            if web.is_some_and(|web| web.repository != archive.repository || web.tag != archive.tag)
            {
                errors.push(format!(
                    "{label}.archive must be an asset of the web archive's release (same repository and tag)"
                ));
            }
        }
        _ => errors.push(format!(
            "{label}.archive must be a canonical HTTPS GitHub release asset"
        )),
    }
    for field in ["sha256", "executable_sha256"] {
        if !text(field).is_some_and(is_lower_sha256) {
            errors.push(format!("{label}.{field} must be lowercase SHA-256"));
        }
    }
    for (field, max, cap) in [
        ("size", MAX_TAB_BACKEND_ARCHIVE_BYTES, "64 MiB"),
        (
            "executable_size",
            MAX_TAB_BACKEND_EXECUTABLE_BYTES,
            "128 MiB",
        ),
    ] {
        if !target
            .get(field)
            .and_then(Value::as_u64)
            .is_some_and(|size| (1..=max).contains(&size))
        {
            errors.push(format!(
                "{label}.{field} must be a byte count from 1 to {cap}"
            ));
        }
    }
    if !text("cmd").is_some_and(|cmd| {
        is_clean_relative_path(cmd) && !cmd.eq_ignore_ascii_case(MANIFEST_FILE_NAME)
    }) {
        errors.push(format!(
            "{label}.cmd must be a clean relative path other than {MANIFEST_FILE_NAME}"
        ));
    }
}

/// A platform key a newer registry could sign: `os-cpu` style, bounded.
fn well_formed_platform_key(key: &str) -> bool {
    (1..=MAX_PLATFORM_KEY_BYTES).contains(&key.len())
        && key
            .bytes()
            .all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit() || b"-_".contains(&byte))
}

#[cfg(test)]
mod tests {
    use chrono::{Duration, SecondsFormat, Utc};
    use serde_json::{json, Value};

    use super::super::tests::{package, target};
    use crate::marketplace::Rules;
    use crate::TabBackendRefusal;

    /// A schema-2 signed payload listing `entry` beside a UI-only tab.
    fn index(entry: Value) -> Value {
        let generated = Utc::now() - Duration::minutes(1);
        let stamp = |at: chrono::DateTime<Utc>| at.to_rfc3339_opts(SecondsFormat::Secs, true);
        let mut ui_only = package();
        let tab = ui_only["package"]["tab"].as_object_mut().unwrap();
        tab.remove("backend");
        tab["distribution"]
            .as_object_mut()
            .unwrap()
            .remove("binary");
        tab["id"] = json!("aaa-ui-only");
        json!({"schema_version":2,"generated_at":stamp(generated),
            "expires_at":stamp(generated + Duration::days(1)),"packages":[ui_only, entry]})
    }

    fn consumed(index: &Value) -> Result<(), String> {
        crate::validate_catalog_payload_at(index, false, Utc::now())
            .map(|_| ())
            .map_err(|error| error.to_string())
    }

    fn published(index: &Value) -> Result<(), String> {
        crate::index::validate_index_with(index, Utc::now(), false, Rules::Publish)
            .map_err(|error| error.to_string())
    }

    fn newer_registry_entries() -> Vec<(&'static str, Value)> {
        let mut windows = package();
        windows["package"]["tab"]["distribution"]["binary"]["windows-x86_64"] =
            target("windows-x86_64");
        let mut protocol_two = package();
        protocol_two["package"]["tab"]["backend"]["protocol"] = json!(2);
        vec![("windows-x86_64", windows), ("protocol 2", protocol_two)]
    }

    #[test]
    fn the_app_accepts_a_catalog_listing_a_backend_it_cannot_install() {
        for (what, entry) in newer_registry_entries() {
            let catalog = index(entry.clone());
            consumed(&catalog).unwrap_or_else(|error| panic!("{what}: {error}"));
            assert!(published(&catalog).is_err(), "{what}");
            assert!(
                crate::validate_marketplace_package(&entry).is_err(),
                "{what}"
            );
            // The entry itself is not installable here, and says why.
            let refusal = crate::signed_tab_backend(&entry).unwrap_err();
            assert!(
                matches!(
                    (&refusal, what),
                    (TabBackendRefusal::UnknownPlatform { key }, "windows-x86_64") if key == what
                ) || matches!(
                    (&refusal, what),
                    (
                        TabBackendRefusal::UnsupportedProtocol { protocol: 2 },
                        "protocol 2"
                    )
                ),
                "{what}: {refusal:?}"
            );
            let refused = refusal.to_string();
            assert!(refused.contains("a newer Cadencr"), "{what}: {refused}");
            // Continuity checks consume history the same way.
            let mut previous = catalog.clone();
            previous["generated_at"] = json!(
                (Utc::now() - Duration::minutes(5)).to_rfc3339_opts(SecondsFormat::Secs, true)
            );
            crate::validate_catalog_continuity(&previous, &catalog)
                .unwrap_or_else(|error| panic!("{what}: {error}"));
        }
        // The registry still refuses to sign it.
        let (_, entry) = newer_registry_entries().remove(0);
        let signing = crate::signing::validate_signing_payload(&index(entry), false);
        assert!(signing.is_err());
    }

    fn binary(v: &mut Value) -> &mut Value {
        &mut v["package"]["tab"]["distribution"]["binary"]
    }

    #[test]
    fn a_consumed_backend_stays_closed_and_bounded() {
        let refused = |edit: &dyn Fn(&mut Value)| {
            let mut entry = package();
            edit(&mut entry);
            consumed(&index(entry)).is_err()
        };
        for key in ["Windows", "", "win dows", "x/y", &"a".repeat(65)] {
            assert!(
                refused(&|v| binary(v)[key] = target("linux-x86_64")),
                "{key:?}"
            );
        }
        assert!(refused(
            &|v| binary(v)["windows-x86_64"] = json!({"archive": "x"})
        ));
        assert!(refused(&|v| {
            let mut extra = target("windows-x86_64");
            extra["args"] = json!([]);
            binary(v)["windows-x86_64"] = extra;
        }));
        let protocol =
            |v: &mut Value, value: Value| v["package"]["tab"]["backend"]["protocol"] = value;
        for value in [
            json!(0),
            json!(-1),
            json!("2"),
            json!(u64::from(u32::MAX) + 1),
            json!(1.5),
        ] {
            assert!(refused(&|v| protocol(v, value.clone())), "{value}");
        }
        assert!(refused(
            &|v| v["package"]["tab"]["backend"]["extra"] = json!(true)
        ));
        assert!(!refused(&|v| protocol(v, json!(u32::MAX))));
    }
}
