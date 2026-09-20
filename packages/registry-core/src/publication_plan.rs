use serde_json::{json, Map, Value};

use crate::diagnostics::Diagnostics;
use crate::error::RegistryError;
use crate::submission::validate_submission;

const ARCHIVE_SUFFIXES: [&str; 5] = [".tar.bz2", ".tar.gz", ".tbz2", ".tgz", ".zip"];

pub fn create_publication_plan_from_file(
    submission: &std::path::Path,
    repository: &str,
) -> Result<Value, RegistryError> {
    let bytes = crate::safe_io::read_bounded_regular(submission, 1024 * 1024)
        .map_err(|error| RegistryError::single(format!("cannot read submission: {error}")))?;
    let value = crate::json::parse_json(&bytes)
        .map_err(|error| RegistryError::single(format!("invalid submission JSON: {error}")))?;
    create_publication_plan(&value, repository)
}

/// Build the deterministic, local-only publication plan used to mirror a
/// validated provider submission into a Cadencr-owned GitHub release.
pub fn create_publication_plan(
    submission: &Value,
    repository: &str,
) -> Result<Value, RegistryError> {
    let mut errors = Diagnostics::default();
    validate_submission(submission, &mut errors);
    if !errors.is_empty() {
        return Err(RegistryError::single(format!(
            "invalid submission:\n  - {}",
            errors.into_messages().join("\n  - ")
        )));
    }
    if !valid_publication_repository(repository) {
        return Err(RegistryError::single(
            "repository must be an ASCII GitHub owner/repository name without dots",
        ));
    }

    // Submission validation guarantees these fields. Keep extraction fallible
    // so this public boundary cannot panic if that contract changes later.
    let agent = required_object(submission.pointer("/package/agent"), "package.agent")?;
    let provider_id = required_string(agent.get("id"), "package.agent.id")?;
    let version = required_string(agent.get("version"), "package.agent.version")?;
    let source = required_object(submission.get("source"), "source")?;
    let source_repository = required_string(source.get("repository"), "source.repository")?;
    let commit = required_string(source.get("commit"), "source.commit")?;
    let source_tag = required_string(source.get("tag"), "source.tag")?;
    let release_tag = format!("provider-{provider_id}-v{version}");

    let binary = required_object(
        submission.pointer("/package/agent/distribution/binary"),
        "package.agent.distribution.binary",
    )?;
    let mut target_names = binary.keys().collect::<Vec<_>>();
    target_names.sort_unstable();
    let targets = target_names
        .into_iter()
        .map(|target| mirror_target(target, &binary[target], repository, &release_tag))
        .collect::<Result<Vec<_>, _>>()?;

    let mut mirrored_package = submission["package"].clone();
    let mirrored_binary = mirrored_package
        .pointer_mut("/agent/distribution/binary")
        .and_then(Value::as_object_mut)
        .ok_or_else(|| RegistryError::single("validated binary distribution is missing"))?;
    for target in &targets {
        let target_name = required_string(target.get("target"), "target")?;
        let destination = required_string(target.get("destination_url"), "destination_url")?;
        let distribution = mirrored_binary
            .get_mut(target_name)
            .and_then(Value::as_object_mut)
            .ok_or_else(|| RegistryError::single("validated binary target is missing"))?;
        distribution.insert("archive".into(), Value::String(destination.into()));
    }

    Ok(json!({
        "schema_version": 1,
        "repository": repository,
        "source": {
            "submission": submission.clone(),
            "identity": {
                "provider_id": provider_id,
                "version": version,
                "repository": source_repository,
                "commit": commit,
                "tag": source_tag,
            },
        },
        "release": { "tag": release_tag },
        "targets": targets,
        "mirrored_package": mirrored_package,
    }))
}

/// Match the JavaScript publication repository policy exactly.
pub fn valid_publication_repository(value: &str) -> bool {
    if value.len() > 140 {
        return false;
    }
    let mut parts = value.split('/');
    let (Some(owner), Some(repository), None) = (parts.next(), parts.next(), parts.next()) else {
        return false;
    };
    valid_owner(owner) && valid_repository_name(repository)
}

fn valid_owner(value: &str) -> bool {
    (1..=39).contains(&value.len())
        && value
            .bytes()
            .next()
            .is_some_and(|byte| byte.is_ascii_alphanumeric())
        && value
            .bytes()
            .last()
            .is_some_and(|byte| byte.is_ascii_alphanumeric())
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-')
}

fn valid_repository_name(value: &str) -> bool {
    (1..=100).contains(&value.len())
        && value
            .bytes()
            .next()
            .is_some_and(|byte| byte.is_ascii_alphanumeric())
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'-'))
}

fn mirror_target(
    target: &str,
    distribution: &Value,
    repository: &str,
    release_tag: &str,
) -> Result<Value, RegistryError> {
    let archive = required_string(distribution.get("archive"), "binary target archive")?;
    let suffix = archive_suffix(archive).ok_or_else(|| {
        RegistryError::single(format!(
            "target {target} archive must end in a supported .tar.gz, .tgz, .tar.bz2, .tbz2, or .zip suffix"
        ))
    })?;
    let sha256 =
        required_string(distribution.get("sha256"), "binary target sha256")?.to_ascii_lowercase();
    let asset = format!("{target}-{sha256}{suffix}");
    Ok(json!({
        "target": target,
        "asset": asset,
        "source_url": archive,
        "destination_url": format!(
            "https://github.com/{repository}/releases/download/{release_tag}/{asset}"
        ),
        "sha256": sha256,
    }))
}

fn archive_suffix(value: &str) -> Option<&'static str> {
    let pathname = url::Url::parse(value).ok()?.path().to_ascii_lowercase();
    ARCHIVE_SUFFIXES
        .into_iter()
        .find(|suffix| pathname.ends_with(suffix))
}

fn required_object<'a>(
    value: Option<&'a Value>,
    label: &str,
) -> Result<&'a Map<String, Value>, RegistryError> {
    value
        .and_then(Value::as_object)
        .ok_or_else(|| RegistryError::single(format!("validated {label} is missing")))
}

fn required_string<'a>(value: Option<&'a Value>, label: &str) -> Result<&'a str, RegistryError> {
    value
        .and_then(Value::as_str)
        .ok_or_else(|| RegistryError::single(format!("validated {label} is missing")))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn submission() -> Value {
        let repository = "https://github.com/acme/provider";
        let target = |name: &str, checksum: char| {
            json!({
                "archive": format!("{repository}/releases/download/v1.2.3/{name}"),
                "cmd": "bin/provider",
                "sha256": checksum.to_string().repeat(64),
            })
        };
        json!({
            "schema_version": 1,
            "package": {
                "agent": {
                    "id": "acme-agent",
                    "name": "Acme Agent",
                    "version": "1.2.3",
                    "description": "ACP connector for Acme",
                    "license": "Apache-2.0",
                    "repository": repository,
                    "distribution": { "binary": {
                        "windows-x86_64": target("provider.zip", 'B'),
                        "darwin-aarch64": target("provider.tar.gz", 'A'),
                        "darwin-x86_64": target("provider.tgz", 'C'),
                        "linux-aarch64": target("provider.tar.bz2", 'D'),
                        "linux-x86_64": target("provider.tbz2", 'E'),
                    }},
                },
                "host": {
                    "publisher": "acme",
                    "compatibility": { "min_app_version": "0.12.0" },
                    "assets": {
                        "icon": "assets/icon.svg",
                        "readme": "README.md",
                        "license": "LICENSE",
                    },
                },
            },
            "source": {
                "repository": repository,
                "commit": "1".repeat(40),
                "tag": "v1.2.3",
            },
            "changelog": "Release notes.",
        })
    }

    #[test]
    fn matches_javascript_fixture_and_preserves_provenance() {
        let submission = submission();
        let plan = create_publication_plan(&submission, "cadencr/registry").unwrap();
        assert_eq!(plan["source"]["submission"], submission);
        assert_eq!(
            plan["source"]["identity"],
            json!({
                "provider_id": "acme-agent",
                "version": "1.2.3",
                "repository": "https://github.com/acme/provider",
                "commit": "1".repeat(40),
                "tag": "v1.2.3",
            })
        );
        assert_eq!(plan["release"]["tag"], "provider-acme-agent-v1.2.3");

        let targets = plan["targets"].as_array().unwrap();
        let expected = [
            ("darwin-aarch64", 'a', ".tar.gz"),
            ("darwin-x86_64", 'c', ".tgz"),
            ("linux-aarch64", 'd', ".tar.bz2"),
            ("linux-x86_64", 'e', ".tbz2"),
            ("windows-x86_64", 'b', ".zip"),
        ];
        for (target, (name, checksum, suffix)) in targets.iter().zip(expected) {
            let sha256 = checksum.to_string().repeat(64);
            assert_eq!(target["target"], name);
            assert_eq!(target["sha256"], sha256);
            assert_eq!(target["asset"], format!("{name}-{sha256}{suffix}"));
            assert_eq!(
                target["destination_url"],
                format!(
                    "https://github.com/cadencr/registry/releases/download/provider-acme-agent-v1.2.3/{name}-{sha256}{suffix}"
                )
            );
            assert_eq!(
                plan["mirrored_package"]["agent"]["distribution"]["binary"][name]["archive"],
                target["destination_url"]
            );
        }
    }

    #[test]
    fn rejects_javascript_fixture_invalid_repositories() {
        for repository in [
            "https://github.com/a/b",
            "a/../b",
            "a/b.git",
            "a:b/c",
            "a/b/c",
            "a./b",
        ] {
            let error = create_publication_plan(&submission(), repository).unwrap_err();
            assert_eq!(
                error.to_string(),
                "repository must be an ASCII GitHub owner/repository name without dots",
                "{repository}"
            );
        }
    }

    #[test]
    fn rejects_raw_executable_outside_archive_policy() {
        let mut submission = submission();
        submission["package"]["agent"]["distribution"]["binary"]["darwin-aarch64"]["archive"] =
            Value::String(
                "https://github.com/acme/provider/releases/download/v1.2.3/provider.exe".into(),
            );
        let error = create_publication_plan(&submission, "a/b").unwrap_err();
        assert!(error
            .to_string()
            .contains("supported .tar.gz, .tgz, .tar.bz2, .tbz2, or .zip suffix"));
    }
}
