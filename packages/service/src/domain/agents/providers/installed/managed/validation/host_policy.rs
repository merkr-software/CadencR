use std::path::{Component, Path};

use semver::Version;

use super::{ManagedContractError, ManagedContractErrorCode};
use crate::domain::agents::providers::installed::descriptor::{AcpBinaryTarget, AcpDistribution};
use crate::domain::agents::providers::installed::managed::{
    ManagedAppCompatibility, ManagedPackageAssets, ManagedProviderPackage,
};

const CREDENTIAL_FIELD_NAMES: &[&str] = &[
    "accesstoken",
    "apikey",
    "auth",
    "authentication",
    "authmethod",
    "authmethods",
    "authorization",
    "clientsecret",
    "credential",
    "credentials",
    "password",
    "passwd",
    "privatekey",
    "refreshtoken",
    "secret",
    "token",
];

impl ManagedAppCompatibility {
    pub(super) fn validate(&self) -> Result<(), ManagedContractError> {
        let minimum = parse_app_version("min_app_version", &self.min_app_version)?;
        if let Some(maximum) = self.max_app_version.as_deref() {
            let maximum = parse_app_version("max_app_version", maximum)?;
            if maximum < minimum {
                return Err(invalid_compatibility(
                    "max_app_version must be greater than or equal to min_app_version",
                ));
            }
        }
        Ok(())
    }

    pub(super) fn supports(&self, app_version: &str) -> Result<bool, ManagedContractError> {
        let app = parse_app_version("current app version", app_version)?;
        let minimum = parse_app_version("min_app_version", &self.min_app_version)?;
        let maximum = self
            .max_app_version
            .as_deref()
            .map(|value| parse_app_version("max_app_version", value))
            .transpose()?;
        Ok(app >= minimum && maximum.is_none_or(|maximum| app <= maximum))
    }
}

impl ManagedPackageAssets {
    pub(super) fn validate(&self) -> Result<(), ManagedContractError> {
        validate_relative_path("icon", &self.icon)?;
        if crate::shared::image_file::image_or_svg_mime_for_path(Path::new(&self.icon)).is_none() {
            return Err(invalid_path(format!(
                "icon {:?} must use an image format Cadencr can paint",
                self.icon
            )));
        }
        for (label, value) in [
            ("readme", self.readme.as_deref()),
            ("license", self.license.as_deref()),
        ] {
            if let Some(value) = value {
                validate_relative_path(label, value)?;
            }
        }
        Ok(())
    }
}

pub(super) fn validate_binary_target(
    platform: &str,
    target: &AcpBinaryTarget,
) -> Result<(), ManagedContractError> {
    let archive = reqwest::Url::parse(&target.archive).map_err(|error| {
        invalid_host(format!(
            "binary target {platform} archive is invalid: {error}"
        ))
    })?;
    if archive.scheme() != "https" || archive.host_str().is_none() {
        return Err(invalid_host(format!(
            "binary target {platform} archive must be an absolute HTTPS URL"
        )));
    }
    validate_relative_path(&format!("binary target {platform} executable"), &target.cmd)?;
    if let Some(argument) = target
        .args
        .iter()
        .find(|argument| is_reserved_host_argument(argument))
    {
        return Err(invalid_host(format!(
            "binary target {platform} argument {argument:?} is reserved by the managed provider host"
        )));
    }
    let checksum = target.sha256.as_deref().ok_or_else(|| {
        ManagedContractError::new(
            ManagedContractErrorCode::ChecksumRequired,
            format!("binary target {platform} must declare sha256"),
        )
    })?;
    if checksum.len() != 64
        || !checksum
            .chars()
            .all(|character| character.is_ascii_hexdigit())
    {
        return Err(ManagedContractError::new(
            ManagedContractErrorCode::ChecksumRequired,
            format!("binary target {platform} sha256 must be 64 hex characters"),
        ));
    }
    Ok(())
}

fn is_reserved_host_argument(argument: &str) -> bool {
    matches!(argument, "version" | "models" | "run" | "acp-v1" | "--")
        || ["--protocol", "--cwd", "--format"].iter().any(|flag| {
            argument == *flag
                || argument
                    .strip_prefix(flag)
                    .is_some_and(|suffix| suffix.starts_with('='))
        })
}

pub(super) fn validate_distribution_credentials(
    distribution: &AcpDistribution,
) -> Result<(), ManagedContractError> {
    for (platform, target) in distribution.binary.iter().flatten() {
        validate_launch_data(
            &format!("binary target {platform}"),
            &target.args,
            target.env.keys().map(String::as_str),
        )?;
    }
    for (label, package) in [("npx", &distribution.npx), ("uvx", &distribution.uvx)] {
        if let Some(package) = package {
            validate_launch_data(
                &format!("{label} distribution"),
                &package.args,
                package.env.keys().map(String::as_str),
            )?;
        }
    }
    Ok(())
}

fn validate_launch_data<'a>(
    label: &str,
    args: &[String],
    mut env_names: impl Iterator<Item = &'a str>,
) -> Result<(), ManagedContractError> {
    if let Some(name) = env_names.find(|name| is_credential_name(name)) {
        return Err(credentials_forbidden(format!(
            "{label} environment field {name:?} may carry provider credentials"
        )));
    }
    if let Some(argument) = args.iter().find(|argument| {
        let name = argument
            .trim_start_matches('-')
            .split_once('=')
            .map_or(argument.as_str(), |(name, _)| name);
        is_credential_name(name)
    }) {
        return Err(credentials_forbidden(format!(
            "{label} argument {argument:?} may carry provider credentials"
        )));
    }
    Ok(())
}

pub(super) fn reject_credentials_in_agent(
    package: &ManagedProviderPackage,
) -> Result<(), ManagedContractError> {
    let value = serde_json::Value::Object(package.agent.extra.clone());
    if let Some(path) = find_credential_key(&value, "agent") {
        return Err(credentials_forbidden(format!(
            "portable provider entry field {path} may carry credentials or authentication data"
        )));
    }
    Ok(())
}

fn find_credential_key(value: &serde_json::Value, path: &str) -> Option<String> {
    match value {
        serde_json::Value::Object(values) => values.iter().find_map(|(key, value)| {
            let child_path = format!("{path}.{key}");
            is_credential_name(key)
                .then_some(child_path.clone())
                .or_else(|| find_credential_key(value, &child_path))
        }),
        serde_json::Value::Array(values) => values
            .iter()
            .enumerate()
            .find_map(|(index, value)| find_credential_key(value, &format!("{path}[{index}]"))),
        _ => None,
    }
}

pub(super) fn validate_identifier(label: &str, value: &str) -> Result<(), ManagedContractError> {
    let valid = (1..=128).contains(&value.len())
        && value
            .bytes()
            .next()
            .is_some_and(|byte| byte.is_ascii_alphanumeric())
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || b"._-".contains(&byte));
    if valid {
        Ok(())
    } else {
        Err(invalid_host(format!(
            "{label} must contain 1-128 ASCII letters, numbers, dots, underscores, or hyphens"
        )))
    }
}

fn validate_relative_path(label: &str, value: &str) -> Result<(), ManagedContractError> {
    let path = Path::new(value);
    let valid = !value.trim().is_empty()
        && value.len() <= 1024
        && !value.contains('\\')
        && !value.contains('\0')
        && path
            .components()
            .all(|component| matches!(component, Component::Normal(_)));
    if valid {
        Ok(())
    } else {
        Err(invalid_path(format!(
            "{label} {value:?} must be a bounded relative path inside the package root"
        )))
    }
}

fn parse_app_version(label: &str, value: &str) -> Result<Version, ManagedContractError> {
    Version::parse(value).map_err(|error| {
        invalid_compatibility(format!("{label} must be semantic version: {error}"))
    })
}

fn is_credential_name(value: &str) -> bool {
    let normalized: String = value
        .chars()
        .filter(char::is_ascii_alphanumeric)
        .map(|character| character.to_ascii_lowercase())
        .collect();
    CREDENTIAL_FIELD_NAMES.contains(&normalized.as_str())
        || [
            "apikey",
            "credential",
            "password",
            "privatekey",
            "secret",
            "token",
        ]
        .iter()
        .any(|suffix| normalized.ends_with(suffix))
}

fn invalid_host(message: impl Into<String>) -> ManagedContractError {
    ManagedContractError::new(ManagedContractErrorCode::InvalidHostMetadata, message)
}

fn invalid_compatibility(message: impl Into<String>) -> ManagedContractError {
    ManagedContractError::new(
        ManagedContractErrorCode::InvalidCompatibilityBounds,
        message,
    )
}

fn invalid_path(message: impl Into<String>) -> ManagedContractError {
    ManagedContractError::new(ManagedContractErrorCode::InvalidPackagePath, message)
}

fn credentials_forbidden(message: impl Into<String>) -> ManagedContractError {
    ManagedContractError::new(ManagedContractErrorCode::CredentialDataForbidden, message)
}
