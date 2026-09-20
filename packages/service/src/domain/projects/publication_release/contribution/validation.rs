use serde_json::Value;

use crate::domain::agents::providers::{builtin_provider_identifiers, provider_identifier_key};
use crate::error::AppError;

const MAX_CHANGELOG: usize = 16 * 1024;

pub(super) fn validate(
    package: &Value,
    repository: &str,
    commit: &str,
    tag: &str,
    changelog: &str,
) -> Result<(), AppError> {
    let agent = package
        .get("agent")
        .and_then(Value::as_object)
        .ok_or_else(|| invalid("package.agent is required"))?;
    let host = package
        .get("host")
        .and_then(Value::as_object)
        .ok_or_else(|| invalid("package.host is required"))?;
    reject_known_nulls(package)?;
    required_text(agent.get("license"), "package.agent.license")?;
    let assets = host
        .get("assets")
        .and_then(Value::as_object)
        .ok_or_else(|| invalid("package.host.assets is required"))?;
    required_text(assets.get("readme"), "package.host.assets.readme")?;
    required_text(assets.get("license"), "package.host.assets.license")?;
    let distribution = agent
        .get("distribution")
        .and_then(Value::as_object)
        .ok_or_else(|| invalid("package.agent.distribution is required"))?;
    if distribution.contains_key("npx") || distribution.contains_key("uvx") {
        return Err(invalid(
            "marketplace v1 does not support npx or uvx distributions",
        ));
    }
    let id = agent.get("id").and_then(Value::as_str).unwrap_or_default();
    let key = provider_identifier_key(id);
    if builtin_provider_identifiers()
        .iter()
        .any(|reserved| provider_identifier_key(reserved) == key)
    {
        return Err(invalid("provider id is reserved by a built-in provider"));
    }
    validate_repository(repository)?;
    let expected_repository = format!("https://github.com/{repository}");
    if agent.get("repository").and_then(Value::as_str) != Some(expected_repository.as_str()) {
        return Err(invalid(
            "package repository does not match the release repository",
        ));
    }
    if commit.len() != 40
        || !commit
            .bytes()
            .all(|byte| byte.is_ascii_hexdigit() && !byte.is_ascii_uppercase())
    {
        return Err(invalid(
            "source commit must be 40 lowercase hexadecimal characters",
        ));
    }
    if !valid_git_tag(tag) {
        return Err(invalid("source tag is not a safe Git tag"));
    }
    if changelog.trim().is_empty() || changelog.len() > MAX_CHANGELOG || changelog.contains('\0') {
        return Err(invalid("changelog must be non-empty and at most 16 KiB"));
    }
    Ok(())
}

fn required_text(value: Option<&Value>, label: &str) -> Result<(), AppError> {
    if value
        .and_then(Value::as_str)
        .is_none_or(|value| value.trim().is_empty())
    {
        return Err(invalid(format!("{label} must be a non-empty string")));
    }
    Ok(())
}

fn reject_known_nulls(package: &Value) -> Result<(), AppError> {
    for pointer in [
        "/agent/website",
        "/agent/icon",
        "/agent/authors",
        "/host/compatibility/max_app_version",
        "/host/assets/icon",
    ] {
        if package.pointer(pointer).is_some_and(Value::is_null) {
            return Err(invalid(format!(
                "{pointer} must be omitted instead of null"
            )));
        }
    }
    if let Some(binary) = package
        .pointer("/agent/distribution/binary")
        .and_then(Value::as_object)
    {
        for (target, value) in binary {
            for field in ["args", "env"] {
                if value.get(field).is_some_and(Value::is_null) {
                    return Err(invalid(format!(
                        "binary target {target} field {field} must be omitted instead of null"
                    )));
                }
            }
        }
    }
    Ok(())
}

fn validate_repository(repository: &str) -> Result<(), AppError> {
    let Some((owner, repo)) = repository.split_once('/') else {
        return Err(invalid("source repository must be owner/repository"));
    };
    let owner_valid = owner.len() <= 39
        && owner
            .bytes()
            .next()
            .is_some_and(|byte| byte.is_ascii_alphanumeric())
        && owner
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-');
    let repo_valid = !repo.is_empty()
        && !repo.ends_with(".git")
        && repo
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || b"._-".contains(&byte));
    if repository.matches('/').count() != 1 || !owner_valid || !repo_valid {
        return Err(invalid(
            "source repository must be a canonical GitHub owner/repository",
        ));
    }
    Ok(())
}

fn valid_git_tag(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 255
        && value != "@"
        && !value.starts_with('-')
        && !value.starts_with('/')
        && !value.ends_with('/')
        && !value.ends_with('.')
        && !value.contains("..")
        && !value.contains("@{")
        && !value
            .chars()
            .any(|ch| ch <= ' ' || ch == '\u{7f}' || "~^:?*[\\".contains(ch))
        && value
            .split('/')
            .all(|part| !part.is_empty() && !part.starts_with('.') && !part.ends_with(".lock"))
}

fn invalid(message: impl Into<String>) -> AppError {
    AppError::coded(
        axum::http::StatusCode::BAD_REQUEST,
        "REGISTRY_CONTRIBUTION_INVALID",
        message,
    )
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    fn package() -> Value {
        json!({
            "agent": {"id":"acme-agent","license":"MIT","repository":"https://github.com/acme/provider","distribution":{"binary":{}}},
            "host": {"assets":{"readme":"README.md","license":"LICENSE"}}
        })
    }

    #[test]
    fn rejects_marketplace_policy_deltas() {
        let call = |value: &Value, repository: &str, tag: &str, notes: &str| {
            validate(value, repository, &"a".repeat(40), tag, notes)
        };
        let repositories = vec![
            "_x/provider".to_string(),
            "a_b/provider".to_string(),
            format!("{}/repo", "a".repeat(40)),
            "acme/provider.git".to_string(),
        ];
        for repository in repositories {
            assert!(call(&package(), &repository, "v1.0.0", "notes").is_err());
        }
        for tag in ["end.", "scope/name.lock", "a..b"] {
            assert!(call(&package(), "acme/provider", tag, "notes").is_err());
        }
        for notes in ["", "\0"] {
            assert!(call(&package(), "acme/provider", "v1.0.0", notes).is_err());
        }
        let mut value = package();
        value["agent"]["license"] = json!(" ");
        assert!(call(&value, "acme/provider", "v1.0.0", "notes").is_err());
        let mut value = package();
        value["host"]["assets"]["readme"] = Value::Null;
        assert!(call(&value, "acme/provider", "v1.0.0", "notes").is_err());
        for runner in ["npx", "uvx"] {
            let mut value = package();
            value["agent"]["distribution"][runner] = json!({"package":"x"});
            assert!(call(&value, "acme/provider", "v1.0.0", "notes").is_err());
        }
        let mut value = package();
        value["agent"]["id"] = json!("Claude_Code");
        assert!(call(&value, "acme/provider", "v1.0.0", "notes").is_err());
        for pointer in ["website", "icon", "authors"] {
            let mut value = package();
            value["agent"][pointer] = Value::Null;
            assert!(call(&value, "acme/provider", "v1.0.0", "notes").is_err());
        }
        let mut value = package();
        value["host"]["compatibility"] = json!({"max_app_version":null});
        assert!(call(&value, "acme/provider", "v1.0.0", "notes").is_err());
    }
}
