use std::collections::HashSet;

use base64::Engine as _;
use semver::Version;

use super::{
    ManagedContractError, ManagedContractErrorCode, ManagedProviderIndex, ManagedProviderPackage,
    ResolvedManagedProviderPackage, SignedManagedProviderIndex, MANAGED_INDEX_SCHEMA_VERSION,
};
use crate::domain::agents::providers::installed::descriptor::current_binary_target;

mod host_policy;
use host_policy::{
    reject_credentials_in_agent, validate_binary_target, validate_distribution_credentials,
    validate_identifier,
};

pub(super) fn validate_signed_index(
    envelope: &SignedManagedProviderIndex,
) -> Result<(), ManagedContractError> {
    validate_signature(envelope)?;
    validate_index(&envelope.signed)
}

fn validate_signature(envelope: &SignedManagedProviderIndex) -> Result<(), ManagedContractError> {
    validate_identifier("signature key_id", &envelope.signature.key_id)?;
    let signature = base64::engine::general_purpose::STANDARD
        .decode(&envelope.signature.value)
        .map_err(|error| {
            invalid_signature(format!(
                "signature value must be standard padded base64: {error}"
            ))
        })?;
    if signature.len() != 64 {
        return Err(invalid_signature(format!(
            "ed25519 signature must decode to 64 bytes, got {}",
            signature.len()
        )));
    }
    Ok(())
}

fn validate_index(index: &ManagedProviderIndex) -> Result<(), ManagedContractError> {
    if index.schema_version != MANAGED_INDEX_SCHEMA_VERSION {
        return Err(ManagedContractError::new(
            ManagedContractErrorCode::UnsupportedSchemaVersion,
            format!(
                "managed index schema_version {} is unsupported (expected {})",
                index.schema_version, MANAGED_INDEX_SCHEMA_VERSION
            ),
        ));
    }
    if index.packages.is_empty() {
        return Err(ManagedContractError::new(
            ManagedContractErrorCode::InvalidHostMetadata,
            "managed index packages must not be empty",
        ));
    }

    let mut previous: Option<(String, Version)> = None;
    let mut identities = HashSet::new();
    for package in &index.packages {
        let version = validate_package(package)?;
        let identity = (package.agent.id.clone(), version);
        if !identities.insert(identity.clone()) {
            return Err(nondeterministic(format!(
                "duplicate package {}@{}",
                identity.0, identity.1
            )));
        }
        if previous.as_ref().is_some_and(|prior| prior >= &identity) {
            return Err(nondeterministic(
                "packages must be sorted by provider id and semantic version",
            ));
        }
        previous = Some(identity);
    }
    Ok(())
}

fn validate_package(package: &ManagedProviderPackage) -> Result<Version, ManagedContractError> {
    package.agent.validate_registry_entry().map_err(|error| {
        ManagedContractError::new(
            ManagedContractErrorCode::InvalidPortableEntry,
            error.message,
        )
    })?;
    let version = Version::parse(&package.agent.version).map_err(|error| {
        ManagedContractError::new(
            ManagedContractErrorCode::InvalidPackageVersion,
            format!(
                "package {} version {:?} must be one exact semantic version: {error}",
                package.agent.id, package.agent.version
            ),
        )
    })?;
    validate_identifier("publisher", &package.host.publisher)?;
    package.host.compatibility.validate()?;
    package.host.assets.validate()?;
    reject_credentials_in_agent(package)?;
    validate_binary_distribution(package)?;
    Ok(version)
}

fn validate_binary_distribution(
    package: &ManagedProviderPackage,
) -> Result<(), ManagedContractError> {
    let distribution = package
        .agent
        .distribution
        .as_ref()
        .expect("registry validation requires distribution");
    let binary = distribution.binary.as_ref().ok_or_else(|| {
        ManagedContractError::new(
            ManagedContractErrorCode::UnsupportedDistribution,
            format!(
                "managed package {}@{} must declare binary distributions",
                package.agent.id, package.agent.version
            ),
        )
    })?;
    for (platform, target) in binary {
        validate_binary_target(platform, target)?;
    }
    validate_distribution_credentials(distribution)
}

pub(super) fn resolve_current_platform(
    envelope: &SignedManagedProviderIndex,
    provider_id: &str,
    provider_version: &str,
    app_version: &str,
) -> Result<ResolvedManagedProviderPackage, ManagedContractError> {
    validate_signed_index(envelope)?;
    Version::parse(provider_version).map_err(|error| {
        ManagedContractError::new(
            ManagedContractErrorCode::InvalidPackageVersion,
            format!("requested provider version must be exact semantic version: {error}"),
        )
    })?;
    let package = envelope
        .signed
        .packages
        .iter()
        .find(|package| {
            package.agent.id == provider_id && package.agent.version == provider_version
        })
        .ok_or_else(|| {
            ManagedContractError::new(
                ManagedContractErrorCode::PackageNotFound,
                format!("managed package {provider_id}@{provider_version} was not found"),
            )
        })?;
    if !package.host.compatibility.supports(app_version)? {
        return Err(ManagedContractError::new(
            ManagedContractErrorCode::IncompatibleAppVersion,
            format!(
                "managed package {provider_id}@{provider_version} is incompatible with Cadencr {app_version}"
            ),
        ));
    }
    resolve_platform(package, current_binary_target())
}

fn resolve_platform(
    package: &ManagedProviderPackage,
    platform: Option<&str>,
) -> Result<ResolvedManagedProviderPackage, ManagedContractError> {
    let platform = platform.ok_or_else(|| {
        ManagedContractError::new(
            ManagedContractErrorCode::UnsupportedPlatform,
            "this OS/architecture has no ACP Registry binary target name",
        )
    })?;
    let target = package
        .agent
        .distribution
        .as_ref()
        .and_then(|distribution| distribution.binary.as_ref())
        .and_then(|binary| binary.get(platform))
        .ok_or_else(|| {
            ManagedContractError::new(
                ManagedContractErrorCode::UnsupportedPlatform,
                format!(
                    "managed package {}@{} has no binary for {platform}",
                    package.agent.id, package.agent.version
                ),
            )
        })?;
    Ok(ResolvedManagedProviderPackage {
        provider_id: package.agent.id.clone(),
        provider_version: package.agent.version.clone(),
        publisher: package.host.publisher.clone(),
        platform: platform.to_string(),
        archive: target.archive.clone(),
        archive_sha256: target
            .sha256
            .as_ref()
            .expect("validated target has sha256")
            .to_ascii_lowercase(),
        executable: target.cmd.clone(),
        args: target.args.clone(),
        env: target.env.clone(),
        assets: package.host.assets.clone(),
    })
}

fn invalid_signature(message: impl Into<String>) -> ManagedContractError {
    ManagedContractError::new(ManagedContractErrorCode::InvalidSignatureEnvelope, message)
}

fn nondeterministic(message: impl Into<String>) -> ManagedContractError {
    ManagedContractError::new(ManagedContractErrorCode::EntriesNotDeterministic, message)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::{json, Value};

    const VALID_INDEX: &str = include_str!(concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/tests/fixtures/managed_provider_index/v1/valid.json"
    ));

    fn index_value() -> Value {
        serde_json::from_str(VALID_INDEX).expect("fixture JSON")
    }

    fn index_from(value: Value) -> SignedManagedProviderIndex {
        serde_json::from_value(value).expect("managed index shape")
    }

    #[test]
    fn checksum_is_mandatory_for_every_binary_target() {
        let mut value = index_value();
        let target = current_binary_target().expect("supported test host");
        value["signed"]["packages"][0]["agent"]["distribution"]["binary"][target]
            .as_object_mut()
            .expect("target")
            .remove("sha256");
        let error = index_from(value)
            .validate_contract()
            .expect_err("missing digest must fail");
        assert_eq!(error.code, ManagedContractErrorCode::ChecksumRequired);
    }

    #[test]
    fn executable_and_assets_must_stay_relative() {
        for pointer in [
            "/signed/packages/0/host/assets/icon",
            "/signed/packages/0/host/assets/readme",
        ] {
            let mut value = index_value();
            *value.pointer_mut(pointer).expect("fixture path") = json!("../escape");
            let error = index_from(value)
                .validate_contract()
                .expect_err("escaping path must fail");
            assert_eq!(error.code, ManagedContractErrorCode::InvalidPackagePath);
        }
        let mut value = index_value();
        let target = current_binary_target().expect("supported test host");
        value["signed"]["packages"][0]["agent"]["distribution"]["binary"][target]["cmd"] =
            json!("/tmp/agent");
        let error = index_from(value)
            .validate_contract()
            .expect_err("absolute executable must fail");
        assert_eq!(error.code, ManagedContractErrorCode::InvalidPackagePath);
    }

    #[test]
    fn binary_args_cannot_repeat_host_owned_command_tokens() {
        let target = current_binary_target().expect("supported test host");
        for reserved in [
            "version",
            "models",
            "run",
            "--protocol",
            "--protocol=acp-v2",
            "acp-v1",
            "--cwd=/tmp",
            "--format=json",
            "--",
        ] {
            let mut value = index_value();
            value["signed"]["packages"][0]["agent"]["distribution"]["binary"][target]["args"] =
                json!([reserved]);
            let error = index_from(value)
                .validate_contract()
                .expect_err("host-owned command tokens must not be package args");
            assert_eq!(error.code, ManagedContractErrorCode::InvalidHostMetadata);
        }
    }

    #[test]
    fn credentials_are_forbidden_in_extra_env_and_arguments() {
        let target = current_binary_target().expect("supported test host");
        for mutate in ["extra", "env", "args"] {
            let mut value = index_value();
            match mutate {
                "extra" => value["signed"]["packages"][0]["agent"]["authMethods"] = json!([]),
                "env" => {
                    value["signed"]["packages"][0]["agent"]["distribution"]["binary"][target]
                        ["env"] = json!({ "API_TOKEN": "secret" });
                }
                "args" => {
                    value["signed"]["packages"][0]["agent"]["distribution"]["binary"][target]
                        ["args"] = json!(["--token=secret"]);
                }
                _ => unreachable!(),
            }
            let error = index_from(value)
                .validate_contract()
                .expect_err("credential-bearing metadata must fail");
            assert_eq!(
                error.code,
                ManagedContractErrorCode::CredentialDataForbidden
            );
        }
    }

    #[test]
    fn compatibility_bounds_are_validated_and_inclusive() {
        let index = index_from(index_value());
        index
            .resolve_current_platform("acme-agent", "1.2.3", "0.11.0")
            .expect("minimum is inclusive");
        index
            .resolve_current_platform("acme-agent", "1.2.3", "0.13.0")
            .expect("maximum is inclusive");
        let error = index
            .resolve_current_platform("acme-agent", "1.2.3", "0.13.1")
            .expect_err("newer app is incompatible");
        assert_eq!(error.code, ManagedContractErrorCode::IncompatibleAppVersion);

        let mut value = index_value();
        value["signed"]["packages"][0]["host"]["compatibility"]["max_app_version"] =
            json!("0.10.0");
        let error = index_from(value)
            .validate_contract()
            .expect_err("inverted bounds must fail");
        assert_eq!(
            error.code,
            ManagedContractErrorCode::InvalidCompatibilityBounds
        );
    }

    #[test]
    fn package_list_must_have_one_deterministic_order() {
        let mut value = index_value();
        let duplicate = value["signed"]["packages"][0].clone();
        value["signed"]["packages"]
            .as_array_mut()
            .expect("packages")
            .push(duplicate);
        let error = index_from(value)
            .validate_contract()
            .expect_err("duplicate package must fail");
        assert_eq!(
            error.code,
            ManagedContractErrorCode::EntriesNotDeterministic
        );
    }

    #[test]
    fn package_version_must_be_exact_semver() {
        let mut value = index_value();
        value["signed"]["packages"][0]["agent"]["version"] = json!("1.2.3 latest");
        let error = index_from(value)
            .validate_contract()
            .expect_err("moving version text must fail");
        assert_eq!(error.code, ManagedContractErrorCode::InvalidPackageVersion);
    }

    #[test]
    fn resolution_never_falls_back_to_another_platform() {
        let mut value = index_value();
        let target = current_binary_target().expect("supported test host");
        value["signed"]["packages"][0]["agent"]["distribution"]["binary"]
            .as_object_mut()
            .expect("binary map")
            .remove(target);
        let error = index_from(value)
            .resolve_current_platform("acme-agent", "1.2.3", "0.12.0")
            .expect_err("another platform must never be selected");
        assert_eq!(error.code, ManagedContractErrorCode::UnsupportedPlatform);
    }

    #[test]
    fn signature_envelope_has_strict_size_and_encoding() {
        let mut value = index_value();
        value["signature"]["value"] = json!("not-base64");
        let error = index_from(value)
            .validate_contract()
            .expect_err("invalid signature text must fail");
        assert_eq!(
            error.code,
            ManagedContractErrorCode::InvalidSignatureEnvelope
        );
    }
}
