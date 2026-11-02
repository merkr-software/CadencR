//! Parsing and validation of `host-integration` output
//! (`cadencr-host-integration-v1`). Every field is optional; any invalid field
//! rejects the whole integration so a half-applied contract never ships.

use std::path::{Component, Path};

use serde::Deserialize;

use crate::domain::agents::runtime::ProviderResumeCommand;

const MAX_NAME_CHARS: usize = 64;
const MAX_CONFIG_PATHS: usize = 32;
const MAX_ITEM_BYTES: usize = 256;
const MAX_RESUME_ARGS: usize = 16;
pub const SESSION_ID_PLACEHOLDER: &str = "{session_id}";

/// The validated integration a provider package declared.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct HostIntegration {
    /// Slash-command name (no `/`) that compacts the live session.
    pub compact_command: Option<String>,
    /// Project-relative paths copied into new worktrees.
    pub worktree_config_paths: Vec<String>,
    pub resume_command: Option<ProviderResumeCommand>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct RawHostIntegration {
    compact_command: Option<String>,
    worktree_config_paths: Option<Vec<String>>,
    resume_command: Option<RawResumeCommand>,
}

#[derive(Deserialize)]
struct RawResumeCommand {
    program: String,
    #[serde(default)]
    args: Vec<String>,
}

pub fn parse_host_integration(bytes: &[u8]) -> Result<HostIntegration, String> {
    let raw: RawHostIntegration = serde_json::from_slice(bytes)
        .map_err(|error| format!("output is not a host-integration JSON object: {error}"))?;
    if let Some(command) = &raw.compact_command {
        validate_name(command, "compactCommand", |ch| {
            ch.is_ascii_alphanumeric() || matches!(ch, '.' | '_' | ':' | '-')
        })?;
    }
    let paths = raw.worktree_config_paths.unwrap_or_default();
    validate_config_paths(&paths)?;
    let resume_command = raw.resume_command.map(validate_resume).transpose()?;
    Ok(HostIntegration {
        compact_command: raw.compact_command,
        worktree_config_paths: paths,
        resume_command,
    })
}

fn validate_name(value: &str, field: &str, allowed: impl Fn(char) -> bool) -> Result<(), String> {
    let valid = (1..=MAX_NAME_CHARS).contains(&value.chars().count()) && value.chars().all(allowed);
    if valid {
        Ok(())
    } else {
        Err(format!(
            "`{field}` {value:?} must be 1-{MAX_NAME_CHARS} characters of the allowed set"
        ))
    }
}

fn validate_config_paths(paths: &[String]) -> Result<(), String> {
    if paths.len() > MAX_CONFIG_PATHS {
        return Err(format!(
            "`worktreeConfigPaths` lists {} entries (at most {MAX_CONFIG_PATHS})",
            paths.len()
        ));
    }
    paths.iter().try_for_each(|path| validate_config_path(path))
}

/// Relative, already normalized (`a/b`, never `./a`, `a//b`, `a/` or `..`),
/// separator `/` only, and bounded.
fn validate_config_path(path: &str) -> Result<(), String> {
    let invalid = |reason: &str| Err(format!("`worktreeConfigPaths` entry {path:?} {reason}"));
    if path.is_empty() || path.len() > MAX_ITEM_BYTES {
        return invalid(&format!("must be 1-{MAX_ITEM_BYTES} bytes"));
    }
    if path.contains('\\') || path.chars().any(char::is_control) {
        return invalid("must use `/` separators and no control characters");
    }
    let mut normalized = Vec::new();
    for component in Path::new(path).components() {
        match component {
            Component::Normal(part) => normalized.push(part.to_string_lossy().into_owned()),
            _ => return invalid("must be a relative path without `.`, `..` or a root"),
        }
    }
    if normalized.join("/") != path {
        return invalid("must be normalized");
    }
    Ok(())
}

fn validate_resume(raw: RawResumeCommand) -> Result<ProviderResumeCommand, String> {
    validate_name(&raw.program, "resumeCommand.program", |ch| {
        ch.is_ascii_alphanumeric() || matches!(ch, '.' | '_' | '-')
    })?;
    if matches!(raw.program.as_str(), "." | "..") {
        return Err("`resumeCommand.program` must name an executable".into());
    }
    if raw.args.len() > MAX_RESUME_ARGS {
        return Err(format!(
            "`resumeCommand.args` has {} entries (at most {MAX_RESUME_ARGS})",
            raw.args.len()
        ));
    }
    for arg in &raw.args {
        let rest = arg.replace(SESSION_ID_PLACEHOLDER, "");
        if arg.len() > MAX_ITEM_BYTES || rest.contains(['{', '}']) || arg.contains('\0') {
            return Err(format!(
                "`resumeCommand.args` entry {arg:?} must be at most {MAX_ITEM_BYTES} bytes \
                 with `{SESSION_ID_PLACEHOLDER}` as its only placeholder"
            ));
        }
    }
    Ok(ProviderResumeCommand {
        program: raw.program,
        args: raw.args,
    })
}

#[cfg(test)]
mod tests {
    use super::parse_host_integration;
    use serde_json::json;

    fn parse(value: serde_json::Value) -> Result<super::HostIntegration, String> {
        parse_host_integration(&serde_json::to_vec(&value).unwrap())
    }

    #[test]
    fn accepts_the_full_contract_and_ignores_unknown_keys() {
        let parsed = parse(json!({
            "compactCommand": "compress",
            "worktreeConfigPaths": [".cursor/rules", ".cursor/mcp.json"],
            "resumeCommand": { "program": "agent", "args": ["--resume", "{session_id}"] },
            "futureField": 1
        }))
        .unwrap();
        assert_eq!(parsed.compact_command.as_deref(), Some("compress"));
        assert_eq!(parsed.worktree_config_paths.len(), 2);
        let resume = parsed.resume_command.unwrap();
        assert_eq!(resume.program, "agent");
        assert_eq!(resume.args, ["--resume", "{session_id}"]);
        assert_eq!(parse(json!({})).unwrap(), super::HostIntegration::default());
    }

    #[test]
    fn rejects_every_invalid_field() {
        let long = "a".repeat(65);
        let paths: Vec<String> = (0..33).map(|i| format!("p{i}")).collect();
        for value in [
            json!([]),
            json!({ "compactCommand": "/compress" }),
            json!({ "compactCommand": "" }),
            json!({ "compactCommand": long }),
            json!({ "worktreeConfigPaths": ["../escape"] }),
            json!({ "worktreeConfigPaths": ["/etc/passwd"] }),
            json!({ "worktreeConfigPaths": ["./a"] }),
            json!({ "worktreeConfigPaths": ["a//b"] }),
            json!({ "worktreeConfigPaths": ["a/"] }),
            json!({ "worktreeConfigPaths": ["a\\b"] }),
            json!({ "worktreeConfigPaths": [""] }),
            json!({ "worktreeConfigPaths": paths }),
            json!({ "resumeCommand": { "program": "/usr/bin/agent", "args": [] } }),
            json!({ "resumeCommand": { "program": "..", "args": [] } }),
            json!({ "resumeCommand": { "program": "agent", "args": ["{cwd}"] } }),
            json!({ "resumeCommand": { "program": "agent", "args": vec!["x"; 17] } }),
            json!({ "resumeCommand": { "args": [] } }),
        ] {
            assert!(parse(value.clone()).is_err(), "{value} should be rejected");
        }
    }
}
