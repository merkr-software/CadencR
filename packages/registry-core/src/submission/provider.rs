use super::*;

// Existing conversations keep `cursor` when the built-in becomes a connector.
// Only its official publisher may carry that identity, on hosts that include
// the migration. Other built-ins and normalized lookalike ids stay reserved.
fn official_cursor(package: &Value) -> bool {
    let publisher = package.pointer("/host/publisher").and_then(Value::as_str);
    let repository = package.pointer("/agent/repository").and_then(Value::as_str);
    package.pointer("/agent/id").and_then(Value::as_str) == Some("cursor")
        && publisher.is_some_and(|name| {
            name.eq_ignore_ascii_case(crate::reserved_publisher::RESERVED_PUBLISHER)
        })
        && crate::reserved_publisher::reserved_publisher_error(
            "host.publisher",
            publisher,
            repository,
        )
        .is_none()
        && package
            .pointer("/host/compatibility/min_app_version")
            .and_then(Value::as_str)
            .and_then(|version| semver::Version::parse(version).ok())
            .is_some_and(|version| version >= semver::Version::new(0, 16, 0))
}

pub(super) fn validate_marketplace_package(package: &Value, label: &str, errors: &mut Diagnostics) {
    let Some(agent) = package.get("agent").and_then(Value::as_object) else {
        return;
    };
    if !agent.get("repository").is_some_and(Value::is_string) {
        errors.push(format!("{label}.agent.repository is required"));
    }
    if agent
        .get("license")
        .and_then(Value::as_str)
        .is_none_or(|value| ecmascript_trim(value).is_empty())
    {
        errors.push(format!(
            "{label}.agent.license must be a non-empty declared license"
        ));
    }
    if identity(package).is_some_and(|(id, _)| {
        reserved_provider_ids().contains(normalized_provider_id(id).as_str())
            && !official_cursor(package)
    }) {
        errors.push(format!(
            "{label}.agent.id is reserved by a built-in provider"
        ));
    }
    if let Some(assets) = package.pointer("/host/assets").and_then(Value::as_object) {
        for key in ["readme", "license"] {
            if assets
                .get(key)
                .and_then(Value::as_str)
                .is_none_or(|value| ecmascript_trim(value).is_empty())
            {
                errors.push(format!("{label}.host.assets.{key} is required"));
            }
        }
    }
    for runner in ["npx", "uvx"] {
        if package
            .pointer(&format!("/agent/distribution/{runner}"))
            .is_some()
        {
            errors.push(format!(
                "{label}.agent.distribution.{runner} is not supported by marketplace v1"
            ));
        }
    }
}

#[cfg(test)]
mod tests {
    use serde_json::{json, Value};

    fn submission() -> Value {
        let repository = "https://github.com/merkr-software/CadencR";
        json!({
            "schema_version": 1,
            "package": {
                "agent": {
                    "id": "cursor", "name": "Cursor", "version": "0.1.0",
                    "description": "Official Cursor connector", "repository": repository,
                    "license": "Apache-2.0", "distribution": {"binary": {"darwin-aarch64": {
                        "archive": format!("{repository}/releases/download/plugins%2Fprovider-cursor%2Fv0.1.0/provider.tar.gz"),
                        "sha256": "a".repeat(64), "cmd": "bin/provider"
                    }}}
                },
                "host": {
                    "publisher": "cadencr", "compatibility": {"min_app_version": "0.16.0"},
                    "assets": {"icon": "icon.svg", "readme": "README.md", "license": "LICENSE"}
                }
            },
            "source": {"repository": repository, "commit": "a".repeat(40), "tag": "plugins/provider-cursor/v0.1.0"},
            "changelog": "Initial official connector."
        })
    }

    #[test]
    fn official_cursor_submission_works_in_both_schemas() {
        let mut value = submission();
        crate::validate_submission(&value).unwrap();
        value["schema_version"] = json!(2);
        value["package"] = json!({"kind": "provider", "package": value["package"].take()});
        crate::validate_submission(&value).unwrap();
    }

    #[test]
    fn cursor_identity_stays_reserved_against_unofficial_or_older_host_claims() {
        for (pointer, replacement) in [
            ("/package/host/publisher", "acme"),
            (
                "/package/agent/repository",
                "https://github.com/acme/cursor",
            ),
            (
                "/package/agent/repository",
                "https://github.com/merkr-software-evil/cursor",
            ),
            ("/package/host/compatibility/min_app_version", "0.15.1"),
            (
                "/package/host/compatibility/min_app_version",
                "0.16.0-alpha",
            ),
            ("/package/agent/id", "cur-sor"),
        ] {
            let mut value = submission();
            *value.pointer_mut(pointer).unwrap() = json!(replacement);
            let error = crate::validate_submission(&value).unwrap_err().to_string();
            assert!(
                error.contains("reserved by a built-in provider"),
                "{pointer}: {error}"
            );
        }
        let mut value = submission();
        value["package"]["host"]["compatibility"] = json!({});
        assert!(crate::validate_submission(&value)
            .unwrap_err()
            .to_string()
            .contains("reserved by a built-in provider"));
    }

    #[test]
    fn other_builtin_ids_remain_reserved_even_for_official_packages() {
        for id in [
            "claude",
            "claude_code",
            "codex",
            "codex_cli",
            "opencode",
            "openai",
        ] {
            let mut value = submission();
            value["package"]["agent"]["id"] = json!(id);
            assert!(
                crate::validate_submission(&value)
                    .unwrap_err()
                    .to_string()
                    .contains("reserved by a built-in provider"),
                "{id}"
            );
        }
    }

    #[test]
    fn official_package_cannot_forge_a_different_submission_source() {
        let mut value = submission();
        value["source"]["repository"] = json!("https://github.com/acme/cursor");
        assert!(crate::validate_submission(&value)
            .unwrap_err()
            .to_string()
            .contains("reserved for merkr-software repositories"));
    }
}
