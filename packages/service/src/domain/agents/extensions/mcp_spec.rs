//! An install option plus the user's values → the server definition a CLI's
//! `mcp add` receives.

use std::collections::BTreeMap;

use super::mcp_options::{ArgPart, Launch, LaunchOption};
use super::types::{McpInput, McpInputKind, McpServerSpec};
use super::ExtensionError;

/// What a URL variable may keep as is: RFC 3986 unreserved characters, so a
/// `{tenant}` of `my-org` stays a valid host label.
const URL_VARIABLE: &percent_encoding::AsciiSet = &percent_encoding::NON_ALPHANUMERIC
    .remove(b'-')
    .remove(b'.')
    .remove(b'_')
    .remove(b'~');

/// The user's values for an option → the server definition to add.
pub fn build_spec(
    launch: &LaunchOption,
    name: &str,
    values: &BTreeMap<String, String>,
) -> Result<McpServerSpec, ExtensionError> {
    let value_of = |input: &McpInput| -> Result<Option<String>, ExtensionError> {
        let value = values
            .get(&input.key)
            .map(|value| value.trim().to_string())
            .filter(|value| !value.is_empty())
            .or_else(|| input.default.clone());
        if let Some(value) = &value {
            if value.contains(['\n', '\r', '\0']) {
                return Err(ExtensionError::Invalid(format!(
                    "{} cannot contain line breaks",
                    input.label
                )));
            }
        }
        if value.is_none() && input.required {
            return Err(ExtensionError::Invalid(format!(
                "{} is required",
                input.label
            )));
        }
        Ok(value)
    };
    let mut resolved = BTreeMap::new();
    for input in &launch.option.inputs {
        if let Some(value) = value_of(input)? {
            resolved.insert(input.key.clone(), value);
        }
    }
    let pick = |kind: McpInputKind| -> BTreeMap<String, String> {
        launch
            .option
            .inputs
            .iter()
            .filter(|input| input.kind == kind)
            .filter_map(|input| Some((input.label.clone(), resolved.get(&input.key)?.clone())))
            .collect()
    };
    let mut spec = McpServerSpec {
        name: name.to_string(),
        transport: launch.option.transport,
        command: None,
        args: Vec::new(),
        env: pick(McpInputKind::Env),
        url: None,
        headers: pick(McpInputKind::Header),
    };
    match &launch.launch {
        Launch::Stdio { command, args } => {
            spec.command = Some(command.clone());
            for part in args {
                match part {
                    ArgPart::Literal(value) => spec.args.push(value.clone()),
                    ArgPart::Input { key, flag } => {
                        if let Some(value) = resolved.get(key) {
                            spec.args.extend(flag.clone());
                            spec.args.push(value.clone());
                        }
                    }
                }
            }
        }
        Launch::Remote { url, .. } => {
            let mut url = url.clone();
            for (name, value) in pick(McpInputKind::UrlVariable) {
                let encoded = percent_encoding::utf8_percent_encode(&value, URL_VARIABLE);
                url = url.replace(&format!("{{{name}}}"), &encoded.to_string());
            }
            spec.url = Some(url);
        }
    }
    Ok(spec)
}
