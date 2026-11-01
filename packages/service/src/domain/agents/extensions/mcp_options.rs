//! MCP Registry packages and remotes → install options (filled in by
//! [`super::mcp_spec::build_spec`]).
//!
//! Only launchers every agent CLI can run are offered: npm (`npx`), PyPI
//! (`uvx`), OCI images (`docker run`) over stdio, and remote streamable-HTTP
//! or SSE endpoints. Registry text is data: it becomes argv entries, never a
//! shell string.

use std::collections::BTreeMap;

use serde::Deserialize;

use super::types::{McpInput, McpInputKind, McpInstallOption, McpTransport};

#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
struct RawInput {
    #[serde(default)]
    name: Option<String>,
    #[serde(rename = "type", default)]
    kind: Option<String>,
    #[serde(default)]
    value: Option<String>,
    #[serde(default)]
    value_hint: Option<String>,
    #[serde(default)]
    default: Option<String>,
    #[serde(default)]
    description: Option<String>,
    #[serde(default)]
    is_required: bool,
    #[serde(default)]
    is_secret: bool,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct RawPackage {
    registry_type: String,
    identifier: String,
    #[serde(default)]
    version: Option<String>,
    #[serde(default)]
    transport: Option<RawTransport>,
    #[serde(default)]
    runtime_arguments: Vec<RawInput>,
    #[serde(default)]
    package_arguments: Vec<RawInput>,
    #[serde(default)]
    environment_variables: Vec<RawInput>,
}

#[derive(Debug, Deserialize)]
struct RawTransport {
    #[serde(rename = "type")]
    kind: String,
}

#[derive(Debug, Deserialize)]
struct RawRemote {
    #[serde(rename = "type")]
    kind: String,
    url: String,
    #[serde(default)]
    headers: Vec<RawInput>,
    #[serde(default)]
    variables: BTreeMap<String, RawInput>,
}

/// One argv entry of a stdio launch.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ArgPart {
    Literal(String),
    /// The user's value for `key`; dropped with `flag` when left empty.
    Input {
        key: String,
        flag: Option<String>,
    },
}

/// How to turn an option back into a server definition.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Launch {
    Stdio {
        command: String,
        args: Vec<ArgPart>,
    },
    Remote {
        transport: McpTransport,
        url: String,
    },
}

/// An install option together with the template that realizes it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LaunchOption {
    pub option: McpInstallOption,
    pub launch: Launch,
}

pub fn launch_options(
    packages: &[serde_json::Value],
    remotes: &[serde_json::Value],
) -> Vec<LaunchOption> {
    let local = packages
        .iter()
        .filter_map(|value| serde_json::from_value::<RawPackage>(value.clone()).ok())
        .filter_map(package_option);
    let remote = remotes
        .iter()
        .filter_map(|value| serde_json::from_value::<RawRemote>(value.clone()).ok())
        .filter_map(remote_option);
    local.chain(remote).collect()
}

fn has_placeholder(text: &str) -> bool {
    text.contains('{') && text.contains('}')
}

/// A registry key/value input (env var, header) as a form field.
fn key_value_input(kind: McpInputKind, prefix: &str, raw: &RawInput) -> Option<McpInput> {
    let name = raw.name.clone().filter(|name| !name.trim().is_empty())?;
    let fixed = raw.value.clone().filter(|value| !has_placeholder(value));
    Some(McpInput {
        key: format!("{prefix}:{name}"),
        kind,
        label: name,
        description: raw.description.clone(),
        required: raw.is_required,
        secret: raw.is_secret,
        default: raw.default.clone().or(fixed),
        placeholder: raw.value.clone().filter(|value| has_placeholder(value)),
    })
}

/// Registry arguments → argv parts plus the inputs the user fills in.
fn arguments(prefix: &str, raw: &[RawInput], inputs: &mut Vec<McpInput>) -> Vec<ArgPart> {
    let mut parts = Vec::new();
    for (index, argument) in raw.iter().enumerate() {
        let named = argument.kind.as_deref() == Some("named");
        let flag = named.then(|| argument.name.clone()).flatten();
        if named && flag.is_none() {
            continue;
        }
        match argument
            .value
            .as_ref()
            .filter(|value| !has_placeholder(value))
        {
            Some(value) => {
                parts.extend(flag.map(ArgPart::Literal));
                parts.push(ArgPart::Literal(value.clone()));
            }
            None if named && argument.value.is_none() && !argument.is_required => {
                // A bare switch the server documents; offer it only if it has a default.
                if argument.default.is_none() {
                    continue;
                }
                parts.push(input_part(prefix, index, flag, argument, inputs));
            }
            None => parts.push(input_part(prefix, index, flag, argument, inputs)),
        }
    }
    parts
}

fn input_part(
    prefix: &str,
    index: usize,
    flag: Option<String>,
    argument: &RawInput,
    inputs: &mut Vec<McpInput>,
) -> ArgPart {
    let key = format!("{prefix}:{index}");
    let label = flag
        .clone()
        .or_else(|| argument.value_hint.clone())
        .or_else(|| argument.name.clone())
        .unwrap_or_else(|| format!("Argument {}", index + 1));
    inputs.push(McpInput {
        key: key.clone(),
        kind: McpInputKind::Argument,
        label,
        description: argument.description.clone(),
        required: argument.is_required || argument.value.is_some(),
        secret: argument.is_secret,
        default: argument.default.clone(),
        placeholder: argument.value.clone(),
    });
    ArgPart::Input { key, flag }
}

fn package_option(package: RawPackage) -> Option<LaunchOption> {
    if package.transport.as_ref().map(|t| t.kind.as_str()) != Some("stdio") {
        return None;
    }
    let version = package
        .version
        .clone()
        .filter(|v| !v.is_empty() && v != "latest");
    let identifier = package.identifier.trim().to_string();
    if identifier.is_empty() || identifier.starts_with('-') {
        return None;
    }
    let mut inputs: Vec<McpInput> = package
        .environment_variables
        .iter()
        .filter_map(|raw| key_value_input(McpInputKind::Env, "env", raw))
        .collect();
    let runtime = arguments("runtime", &package.runtime_arguments, &mut inputs);
    let trailing = arguments("arg", &package.package_arguments, &mut inputs);
    let (command, mut args) = match package.registry_type.as_str() {
        "npm" => ("npx", vec![ArgPart::Literal("-y".into())]),
        "pypi" => ("uvx", Vec::new()),
        "oci" => (
            "docker",
            ["run", "-i", "--rm"]
                .map(|arg| ArgPart::Literal(arg.into()))
                .to_vec(),
        ),
        _ => return None,
    };
    args.extend(runtime);
    if package.registry_type == "oci" {
        for input in inputs
            .iter()
            .filter(|input| input.kind == McpInputKind::Env)
        {
            args.push(ArgPart::Literal("-e".into()));
            args.push(ArgPart::Literal(input.label.clone()));
        }
    }
    let token = package_token(&package.registry_type, &identifier, version.as_deref());
    args.push(ArgPart::Literal(token));
    args.extend(trailing);
    let summary = std::iter::once(command.to_string())
        .chain(args.iter().map(|part| match part {
            ArgPart::Literal(value) => value.clone(),
            ArgPart::Input { key, flag } => flag.clone().unwrap_or_else(|| format!("<{key}>")),
        }))
        .collect::<Vec<_>>()
        .join(" ");
    Some(LaunchOption {
        option: McpInstallOption {
            kind: package.registry_type.clone(),
            transport: McpTransport::Stdio,
            summary,
            identifier: Some(identifier),
            version,
            url: None,
            inputs,
        },
        launch: Launch::Stdio {
            command: command.to_string(),
            args,
        },
    })
}

/// The launcher argument naming a package at a version.
pub fn package_token(registry_type: &str, identifier: &str, version: Option<&str>) -> String {
    match (registry_type, version) {
        (_, None) => identifier.to_string(),
        ("pypi", Some(version)) => format!("{identifier}=={version}"),
        ("oci", Some(_)) if identifier.contains(':') || identifier.contains('@') => {
            identifier.to_string()
        }
        ("oci", Some(version)) => format!("{identifier}:{version}"),
        (_, Some(version)) => format!("{identifier}@{version}"),
    }
}

fn remote_option(remote: RawRemote) -> Option<LaunchOption> {
    let transport = match remote.kind.as_str() {
        "streamable-http" | "http" => McpTransport::Http,
        "sse" => McpTransport::Sse,
        _ => return None,
    };
    if !remote.url.starts_with("https://") && !remote.url.starts_with("http://") {
        return None;
    }
    let mut inputs: Vec<McpInput> = remote
        .variables
        .iter()
        .map(|(name, raw)| McpInput {
            key: format!("url:{name}"),
            kind: McpInputKind::UrlVariable,
            label: name.clone(),
            description: raw.description.clone(),
            required: true,
            secret: raw.is_secret,
            default: raw.default.clone(),
            placeholder: None,
        })
        .collect();
    inputs.extend(
        remote
            .headers
            .iter()
            .filter_map(|raw| key_value_input(McpInputKind::Header, "header", raw)),
    );
    Some(LaunchOption {
        option: McpInstallOption {
            kind: "remote".into(),
            transport,
            summary: remote.url.clone(),
            identifier: None,
            version: None,
            url: Some(remote.url.clone()),
            inputs,
        },
        launch: Launch::Remote {
            transport,
            url: remote.url,
        },
    })
}

#[cfg(test)]
mod tests {
    use super::super::mcp_spec::build_spec;
    use super::*;
    use serde_json::json;

    fn only(packages: serde_json::Value, remotes: serde_json::Value) -> LaunchOption {
        let mut options = launch_options(packages.as_array().unwrap(), remotes.as_array().unwrap());
        assert_eq!(options.len(), 1, "{options:?}");
        options.remove(0)
    }

    #[test]
    fn npm_packages_pin_their_version_and_ask_for_env_values() {
        let launch = only(
            json!([{
                "registryType": "npm", "identifier": "@acme/mcp", "version": "2.1.0",
                "transport": {"type": "stdio"},
                "packageArguments": [{"type": "positional", "value": "serve"}],
                "environmentVariables": [
                    {"name": "ACME_TOKEN", "isRequired": true, "isSecret": true},
                    {"name": "ACME_REGION", "default": "eu"}
                ]
            }]),
            json!([]),
        );
        assert_eq!(launch.option.summary, "npx -y @acme/mcp@2.1.0 serve");
        let error = build_spec(&launch, "acme", &BTreeMap::new()).unwrap_err();
        assert_eq!(error.to_string(), "ACME_TOKEN is required");
        let values = BTreeMap::from([("env:ACME_TOKEN".to_string(), "t0k".to_string())]);
        let spec = build_spec(&launch, "acme", &values).unwrap();
        assert_eq!(spec.command.as_deref(), Some("npx"));
        assert_eq!(spec.args, ["-y", "@acme/mcp@2.1.0", "serve"]);
        assert_eq!(spec.env["ACME_TOKEN"], "t0k");
        assert_eq!(spec.env["ACME_REGION"], "eu");
    }

    #[test]
    fn pypi_and_oci_use_their_launchers() {
        let pypi = only(
            json!([{"registryType": "pypi", "identifier": "medium-ops", "version": "0.1.2",
                    "transport": {"type": "stdio"}}]),
            json!([]),
        );
        assert_eq!(pypi.option.summary, "uvx medium-ops==0.1.2");
        let oci = only(
            json!([{"registryType": "oci", "identifier": "ghcr.io/acme/mcp", "version": "1.0.0",
                    "transport": {"type": "stdio"},
                    "environmentVariables": [{"name": "TOKEN"}]}]),
            json!([]),
        );
        assert_eq!(
            oci.option.summary,
            "docker run -i --rm -e TOKEN ghcr.io/acme/mcp:1.0.0"
        );
    }

    #[test]
    fn optional_arguments_left_empty_drop_with_their_flag() {
        let launch = only(
            json!([{"registryType": "npm", "identifier": "fs-mcp", "version": "1.0.0",
            "transport": {"type": "stdio"},
            "packageArguments": [
                {"type": "named", "name": "--root", "valueHint": "path", "value": "{root}"},
                {"type": "named", "name": "--port", "default": "8080"},
                {"type": "positional", "valueHint": "extra"}
            ]}]),
            json!([]),
        );
        let values = BTreeMap::from([("arg:0".to_string(), "/tmp".to_string())]);
        let spec = build_spec(&launch, "fs", &values).unwrap();
        assert_eq!(
            spec.args,
            ["-y", "fs-mcp@1.0.0", "--root", "/tmp", "--port", "8080"]
        );
    }

    #[test]
    fn remotes_fill_url_variables_and_headers() {
        let launch = only(
            json!([]),
            json!([{
                "type": "streamable-http",
                "url": "https://{tenant}.example.com/mcp",
                "variables": {"tenant": {"description": "Workspace"}},
                "headers": [{"name": "Authorization", "value": "Bearer {key}", "isSecret": true}]
            }]),
        );
        assert_eq!(
            launch.option.inputs[1].placeholder.as_deref(),
            Some("Bearer {key}")
        );
        let values = BTreeMap::from([
            ("url:tenant".to_string(), "acme-eu.prod".to_string()),
            ("header:Authorization".to_string(), "Bearer abc".to_string()),
        ]);
        let spec = build_spec(&launch, "remote", &values).unwrap();
        assert_eq!(
            spec.url.as_deref(),
            Some("https://acme-eu.prod.example.com/mcp")
        );
        assert_eq!(spec.headers["Authorization"], "Bearer abc");
    }

    #[test]
    fn values_with_line_breaks_are_refused() {
        let launch = only(
            json!([]),
            json!([{"type": "sse", "url": "https://x.example.com/sse",
                    "headers": [{"name": "X-Key"}]}]),
        );
        let values = BTreeMap::from([("header:X-Key".to_string(), "a\nb".to_string())]);
        assert!(build_spec(&launch, "x", &values).is_err());
    }

    #[test]
    fn unsupported_launchers_and_transports_are_not_offered() {
        let options = launch_options(
            json!([
                {"registryType": "mcpb", "identifier": "https://x/y.mcpb", "transport": {"type": "stdio"}},
                {"registryType": "npm", "identifier": "x", "transport": {"type": "streamable-http"}},
                {"registryType": "npm", "identifier": "--evil", "transport": {"type": "stdio"}}
            ]).as_array().unwrap(),
            json!([{"type": "websocket", "url": "wss://x"}]).as_array().unwrap(),
        );
        assert!(options.is_empty());
    }
}
