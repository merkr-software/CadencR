//! Optional host-integration contract: `host-integration` tells Cadencr how to
//! compact a live session, which project-local configuration to copy into new
//! worktrees, and how to resume a session in a terminal.
//!
//! Every field is optional; `{}` means "no host integration". The host
//! validates the same rules [`HostIntegration::validate`] applies here and
//! rejects the whole object when one entry is invalid.

use std::ffi::OsString;
use std::path::{Component, Path};
use std::process::ExitCode;

use serde::{Deserialize, Serialize};

use super::{CadencrProvider, ProviderError};

pub const HOST_INTEGRATION_FORMAT: &str = "cadencr-host-integration-v1";
/// The only placeholder `resumeCommand.args` may contain; the host replaces it
/// with the session id it stored (the ACP `sessionId`).
pub const SESSION_ID_PLACEHOLDER: &str = "{session_id}";

const MAX_NAME_BYTES: usize = 64;
const MAX_WORKTREE_PATHS: usize = 32;
const MAX_ENTRY_BYTES: usize = 256;
const MAX_RESUME_ARGS: usize = 16;

/// What the host may do for this provider beyond the ACP session.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize, bon::Builder)]
#[serde(rename_all = "camelCase")]
pub struct HostIntegration {
    /// Slash command (without `/`) the host sends as a prompt to compact the
    /// live conversation, e.g. `compress`.
    #[builder(into)]
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub compact_command: Option<String>,
    /// Relative, normalized project paths copied into each new worktree.
    #[builder(default)]
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub worktree_config_paths: Vec<String>,
    /// Native CLI invocation that resumes a session in a terminal.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub resume_command: Option<ResumeCommand>,
}

/// A bare executable name plus arguments; [`SESSION_ID_PLACEHOLDER`] marks the
/// session id. The host runs it in the session's working directory.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, bon::Builder)]
pub struct ResumeCommand {
    #[builder(into)]
    pub program: String,
    #[builder(default)]
    #[serde(default)]
    pub args: Vec<String>,
}

impl HostIntegration {
    /// Check the contract rules the host enforces.
    pub fn validate(&self) -> Result<(), ProviderError> {
        if let Some(command) = &self.compact_command {
            if !is_name(command, |ch| matches!(ch, '.' | '_' | ':' | '-')) {
                return Err(invalid(format!(
                    "compactCommand `{command}` must be 1-64 of [A-Za-z0-9._:-] (no leading `/`)"
                )));
            }
        }
        if self.worktree_config_paths.len() > MAX_WORKTREE_PATHS {
            return Err(invalid(format!(
                "worktreeConfigPaths allows at most {MAX_WORKTREE_PATHS} entries"
            )));
        }
        for path in &self.worktree_config_paths {
            validate_worktree_path(path)?;
        }
        if let Some(resume) = &self.resume_command {
            resume.validate()?;
        }
        Ok(())
    }
}

impl ResumeCommand {
    fn validate(&self) -> Result<(), ProviderError> {
        if !is_name(&self.program, |ch| matches!(ch, '.' | '_' | '-')) {
            return Err(invalid(format!(
                "resumeCommand.program `{}` must be a bare executable name of 1-64 [A-Za-z0-9._-]",
                self.program
            )));
        }
        if self.args.len() > MAX_RESUME_ARGS {
            return Err(invalid(format!(
                "resumeCommand.args allows at most {MAX_RESUME_ARGS} entries"
            )));
        }
        for arg in &self.args {
            if arg.len() > MAX_ENTRY_BYTES {
                return Err(invalid(format!(
                    "resumeCommand argument exceeds {MAX_ENTRY_BYTES} bytes"
                )));
            }
            let rest = arg.replace(SESSION_ID_PLACEHOLDER, "");
            if rest.contains('{') || rest.contains('}') {
                return Err(invalid(format!(
                    "resumeCommand argument `{arg}` may only use the `{SESSION_ID_PLACEHOLDER}` placeholder"
                )));
            }
        }
        Ok(())
    }
}

fn is_name(value: &str, extra: impl Fn(char) -> bool) -> bool {
    !value.is_empty()
        && value.len() <= MAX_NAME_BYTES
        && value
            .chars()
            .all(|ch| ch.is_ascii_alphanumeric() || extra(ch))
}

fn validate_worktree_path(path: &str) -> Result<(), ProviderError> {
    let normal = !path.is_empty()
        && path.len() <= MAX_ENTRY_BYTES
        && !path.contains('\\')
        && Path::new(path)
            .components()
            .all(|component| matches!(component, Component::Normal(_)))
        && path.split('/').all(|segment| !segment.is_empty());
    if normal {
        Ok(())
    } else {
        Err(invalid(format!(
            "worktreeConfigPaths entry `{path}` must be a normalized relative path without `..` (≤ {MAX_ENTRY_BYTES} bytes)"
        )))
    }
}

fn invalid(message: String) -> ProviderError {
    ProviderError::new(format!("invalid host integration: {message}"))
}

pub(super) fn execute_host_integration(
    provider: &impl CadencrProvider,
    args: &[OsString],
) -> Result<ExitCode, ProviderError> {
    if args.len() != 2 || args[0] != "--format" || args[1] != HOST_INTEGRATION_FORMAT {
        return Err(ProviderError::new(format!(
            "host-integration requires `--format {HOST_INTEGRATION_FORMAT}`"
        )));
    }
    let integration = provider.host_integration()?.unwrap_or_default();
    integration.validate()?;
    println!("{}", serde_json::to_string(&integration)?);
    Ok(ExitCode::SUCCESS)
}

#[cfg(test)]
mod tests {
    use super::{HostIntegration, ResumeCommand};
    use serde_json::json;

    fn cursor_like() -> HostIntegration {
        HostIntegration::builder()
            .compact_command("compress")
            .worktree_config_paths(vec![".cursor/rules".into(), ".cursor/mcp.json".into()])
            .resume_command(
                ResumeCommand::builder()
                    .program("agent")
                    .args(vec!["--resume".into(), "{session_id}".into()])
                    .build(),
            )
            .build()
    }

    #[test]
    fn serializes_the_versioned_contract_in_camel_case() {
        assert_eq!(
            serde_json::to_value(cursor_like()).unwrap(),
            json!({
                "compactCommand": "compress",
                "worktreeConfigPaths": [".cursor/rules", ".cursor/mcp.json"],
                "resumeCommand": { "program": "agent", "args": ["--resume", "{session_id}"] }
            })
        );
        assert_eq!(
            serde_json::to_value(HostIntegration::default()).unwrap(),
            json!({})
        );
        let parsed: HostIntegration =
            serde_json::from_value(json!({ "compactCommand": "compact", "future": 1 })).unwrap();
        assert_eq!(parsed.compact_command.as_deref(), Some("compact"));
        assert!(cursor_like().validate().is_ok());
    }

    #[test]
    fn rejects_what_the_host_rejects() {
        let invalid = |integration: HostIntegration| integration.validate().is_err();
        assert!(invalid(
            HostIntegration::builder()
                .compact_command("/compress")
                .build()
        ));
        assert!(invalid(
            HostIntegration::builder().compact_command("").build()
        ));
        for path in ["", "../x", "/etc", "a/../b", "./a", "a//b", "a\\b", "a/"] {
            assert!(
                invalid(
                    HostIntegration::builder()
                        .worktree_config_paths(vec![path.into()])
                        .build()
                ),
                "{path}"
            );
        }
        assert!(invalid(
            HostIntegration::builder()
                .worktree_config_paths(vec!["a".into(); 33])
                .build()
        ));
        let resume = |program: &str, args: &[&str]| {
            HostIntegration::builder()
                .resume_command(
                    ResumeCommand::builder()
                        .program(program)
                        .args(args.iter().map(|arg| arg.to_string()).collect())
                        .build(),
                )
                .build()
        };
        assert!(invalid(resume("/usr/bin/agent", &[])));
        assert!(invalid(resume("bin/agent", &[])));
        assert!(invalid(resume("agent", &["{cwd}"])));
        assert!(invalid(resume("agent", &["x"; 17])));
        assert!(!invalid(resume("agent", &["--resume={session_id}"])));
    }
}
