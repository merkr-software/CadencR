use cadencr_plugin_core::ACP_BINARY_TARGETS;
use serde_json::{Map, Value};

use crate::diagnostics::Diagnostics;

mod host;
mod util;
use host::validate_host;
pub(crate) use util::{
    compare_versions, identity, normalized_provider_id, reject_unknown, reserved_provider_ids,
    valid_identifier,
};
use util::{
    credential_name, object, valid_https, valid_provider_id, valid_relative_path, valid_semver,
    valid_url,
};

pub(crate) fn validate_package(value: &Value, label: &str, errors: &mut Diagnostics) {
    let Some(package) = object(value, label, errors) else {
        return;
    };
    reject_unknown(package, &["agent", "host"], label, errors);
    let Some(agent) = package.get("agent").and_then(Value::as_object) else {
        errors.push(format!("{label}.agent must be an object"));
        return;
    };
    validate_agent(agent, &format!("{label}.agent"), errors);
    let Some(host) = package.get("host").and_then(Value::as_object) else {
        errors.push(format!("{label}.host must be an object"));
        return;
    };
    validate_host(host, &format!("{label}.host"), errors);
}

fn validate_agent(agent: &Map<String, Value>, label: &str, errors: &mut Diagnostics) {
    if !agent
        .get("id")
        .and_then(Value::as_str)
        .is_some_and(valid_provider_id)
    {
        errors.push(format!("{label}.id is invalid"));
    }
    for key in ["name", "description"] {
        if agent
            .get(key)
            .and_then(Value::as_str)
            .is_none_or(str::is_empty)
        {
            errors.push(format!("{label}.{key} must not be empty"));
        }
    }
    if !agent
        .get("version")
        .and_then(Value::as_str)
        .is_some_and(valid_semver)
    {
        errors.push(format!(
            "{label}.version must be one exact semantic version"
        ));
    }
    for key in ["repository", "website"] {
        if agent.get(key).is_some()
            && !agent
                .get(key)
                .and_then(Value::as_str)
                .is_some_and(valid_url)
        {
            errors.push(format!("{label}.{key} must be a valid URI"));
        }
    }
    for key in ["license", "icon"] {
        if agent.get(key).is_some() && !agent.get(key).is_some_and(Value::is_string) {
            errors.push(format!("{label}.{key} must be a string"));
        }
    }
    if agent.get("authors").is_some_and(|value| {
        !value
            .as_array()
            .is_some_and(|values| values.iter().all(Value::is_string))
    }) {
        errors.push(format!("{label}.authors must be an array of strings"));
    }
    if let Some(distribution) = agent.get("distribution").and_then(Value::as_object) {
        validate_distribution(distribution, &format!("{label}.distribution"), errors);
    } else {
        errors.push(format!("{label}.distribution is required"));
    }
    find_credentials_object(agent, label, errors, true);
}

fn validate_distribution(value: &Map<String, Value>, label: &str, errors: &mut Diagnostics) {
    reject_unknown(value, &["binary", "npx", "uvx"], label, errors);
    let Some(binary) = value.get("binary").and_then(Value::as_object) else {
        errors.push(format!(
            "{label}.binary must declare at least one target for managed packages"
        ));
        return;
    };
    if binary.is_empty() {
        errors.push(format!(
            "{label}.binary must declare at least one target for managed packages"
        ));
    }
    for (target, config) in binary {
        if errors.is_full() {
            break;
        }
        let item_label = format!("{label}.binary.{target}");
        if !ACP_BINARY_TARGETS.contains(&target.as_str()) {
            errors.push(format!("{item_label} uses an unsupported platform key"));
        }
        let Some(config) = config.as_object() else {
            errors.push(format!("{item_label} must be an object"));
            continue;
        };
        reject_unknown(
            config,
            &["archive", "cmd", "sha256", "args", "env"],
            &item_label,
            errors,
        );
        if !config
            .get("archive")
            .and_then(Value::as_str)
            .is_some_and(valid_https)
        {
            errors.push(format!(
                "{item_label}.archive must be an absolute HTTPS URL"
            ));
        }
        if !config
            .get("cmd")
            .and_then(Value::as_str)
            .is_some_and(valid_relative_path)
        {
            errors.push(format!(
                "{item_label}.cmd must be a bounded relative package path"
            ));
        }
        if !config
            .get("sha256")
            .and_then(Value::as_str)
            .is_some_and(|value| {
                value.len() == 64 && value.bytes().all(|byte| byte.is_ascii_hexdigit())
            })
        {
            errors.push(format!("{item_label}.sha256 must be 64 hex characters"));
        }
        validate_binary_args(config.get("args"), &format!("{item_label}.args"), errors);
        validate_env(config.get("env"), &format!("{item_label}.env"), errors);
    }
    for kind in ["npx", "uvx"] {
        if let Some(config) = value.get(kind) {
            validate_package_distribution(config, &format!("{label}.{kind}"), errors);
        }
    }
}

fn validate_binary_args(value: Option<&Value>, label: &str, errors: &mut Diagnostics) {
    let Some(value) = value else { return };
    let Some(args) = string_args(value, label, errors) else {
        return;
    };
    for arg in args {
        if errors.is_full() {
            break;
        }
        if ["version", "models", "run", "acp-v1", "--"].contains(&arg)
            || ["--protocol", "--cwd", "--format"]
                .iter()
                .any(|flag| arg == *flag || arg.starts_with(&format!("{flag}=")))
        {
            errors.push(format!("{label} contains reserved host argument {arg:?}"));
        }
        if credential_name(argument_name(arg)) {
            errors.push(format!(
                "{label} contains credential-bearing argument {arg:?}"
            ));
        }
    }
}

fn validate_package_distribution(value: &Value, label: &str, errors: &mut Diagnostics) {
    let Some(config) = value.as_object() else {
        errors.push(format!("{label} must be an object"));
        return;
    };
    reject_unknown(config, &["package", "args", "env"], label, errors);
    if config
        .get("package")
        .and_then(Value::as_str)
        .is_none_or(str::is_empty)
    {
        errors.push(format!("{label}.package must not be empty"));
    }
    let args_label = format!("{label}.args");
    let Some(args) = config.get("args") else {
        validate_env(config.get("env"), &format!("{label}.env"), errors);
        return;
    };
    let Some(args) = string_args(args, &args_label, errors) else {
        return;
    };
    for arg in args {
        if errors.is_full() {
            break;
        }
        if credential_name(argument_name(arg)) {
            errors.push(format!("{args_label} contains credential-bearing data"));
        }
    }
    validate_env(config.get("env"), &format!("{label}.env"), errors);
}

fn string_args<'a>(
    value: &'a Value,
    label: &str,
    errors: &mut Diagnostics,
) -> Option<impl Iterator<Item = &'a str>> {
    let Some(args) = value.as_array() else {
        errors.push(format!("{label} must be an array of strings"));
        return None;
    };
    if args.iter().any(|arg| !arg.is_string()) {
        errors.push(format!("{label} must be an array of strings"));
        return None;
    }
    Some(args.iter().filter_map(Value::as_str))
}

fn argument_name(argument: &str) -> &str {
    argument
        .trim_start_matches('-')
        .split('=')
        .next()
        .unwrap_or_default()
}

fn validate_env(value: Option<&Value>, label: &str, errors: &mut Diagnostics) {
    let Some(value) = value else { return };
    let Some(env) = value.as_object() else {
        errors.push(format!("{label} must map strings to strings"));
        return;
    };
    if env.values().any(|value| !value.is_string()) {
        errors.push(format!("{label} must map strings to strings"));
    }
    for key in env.keys() {
        if errors.is_full() {
            break;
        }
        if credential_name(key) {
            errors.push(format!("{label}.{key} may carry credentials"));
        }
    }
}

fn find_credentials(value: &Value, label: &str, errors: &mut Diagnostics, skip_distribution: bool) {
    if errors.is_full() {
        return;
    }
    match value {
        Value::Array(values) => {
            for (index, value) in values.iter().enumerate() {
                if errors.is_full() {
                    break;
                }
                find_credentials(value, &format!("{label}[{index}]"), errors, false);
            }
        }
        Value::Object(object) => find_credentials_object(object, label, errors, skip_distribution),
        _ => {}
    }
}

fn find_credentials_object(
    object: &Map<String, Value>,
    label: &str,
    errors: &mut Diagnostics,
    skip_distribution: bool,
) {
    for (key, value) in object {
        if errors.is_full() {
            break;
        }
        if skip_distribution && key == "distribution" {
            continue;
        }
        if credential_name(key) {
            errors.push(format!(
                "{label}.{key} may carry credentials or authentication data"
            ));
        }
        find_credentials(value, &format!("{label}.{key}"), errors, false);
    }
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    #[test]
    fn credentials_are_rejected_in_nested_metadata_env_and_arguments() {
        let package = json!({
            "agent": {
                "id": "acme",
                "name": "Acme",
                "version": "1.0.0",
                "description": "Provider",
                "metadata": { "authentication": "forbidden" },
                "distribution": { "binary": {
                    "linux-x86_64": {
                        "archive": "https://example.com/provider.tgz",
                        "cmd": "bin/provider",
                        "sha256": "a".repeat(64),
                        "args": ["--auth=value"],
                        "env": { "AUTHORIZATION": "forbidden" }
                    }
                }}
            },
            "host": {
                "publisher": "acme",
                "compatibility": { "min_app_version": "1.0.0" },
                "assets": { "icon": "icon.svg" }
            }
        });
        let mut errors = Diagnostics::default();
        validate_package(&package, "package", &mut errors);
        let joined = errors.into_messages().join("\n");
        assert!(joined.contains("package.agent.metadata.authentication may carry credentials"));
        assert!(joined.contains("args contains credential-bearing argument"));
        assert!(joined.contains("env.AUTHORIZATION may carry credentials"));
    }

    #[test]
    fn plugin_core_primitives_retain_registry_package_errors() {
        let package = json!({
            "agent": {
                "id": "Invalid",
                "name": "Acme",
                "version": "1.0.0",
                "description": "Provider",
                "distribution": { "binary": { "other": {} } }
            },
            "host": null
        });
        let mut errors = Diagnostics::default();
        validate_package(&package, "package", &mut errors);
        let errors = errors.into_messages();
        assert!(errors
            .iter()
            .any(|error| error == "package.agent.id is invalid"));
        assert!(errors
            .iter()
            .any(|error| error.contains("uses an unsupported platform key")));
    }
}
