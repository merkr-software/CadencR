//! Optional slash-command catalog: `slash-commands` lists the commands and
//! skills the native agent accepts as `/name` in a prompt for one working
//! directory, so Cadencr can fill its `/` menu before an ACP session exists.
//!
//! Once a session runs, the agent's own ACP `available_commands_update` is
//! the live catalog; this command should print the same list. The host
//! validates the same rules [`validate_slash_commands`] applies here and
//! rejects the whole list when one entry is invalid.

use std::collections::HashSet;
use std::ffi::OsString;
use std::path::PathBuf;
use std::process::ExitCode;

use serde::{Deserialize, Serialize};
use serde_json::json;

use super::{CadencrProvider, ProviderError};

pub const SLASH_COMMANDS_FORMAT: &str = "cadencr-slash-commands-v1";
/// At most this many entries per list.
pub const MAX_SLASH_COMMANDS: usize = 1000;
/// Name length bound, in characters.
pub const MAX_SLASH_COMMAND_NAME_CHARS: usize = 128;
/// Description length bound, in characters.
pub const MAX_SLASH_COMMAND_DESCRIPTION_CHARS: usize = 4096;

/// How the host groups an entry in its `/` menu.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum SlashCommandKind {
    #[default]
    Command,
    Skill,
}

impl SlashCommandKind {
    pub fn wire_id(self) -> &'static str {
        match self {
            Self::Command => "command",
            Self::Skill => "skill",
        }
    }
}

/// One `/name` entry, as the ACP `AvailableCommand` the agent would send.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, bon::Builder)]
pub struct SlashCommand {
    /// Invoked as `/name`; no leading `/`, no whitespace.
    #[builder(into)]
    pub name: String,
    #[builder(into)]
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    #[builder(default)]
    #[serde(default)]
    pub kind: SlashCommandKind,
}

/// Check the contract rules the host enforces: bounded count, names of
/// 1-128 characters without a leading `/`, whitespace or control characters,
/// unique names, and descriptions of at most 4096 characters whose only
/// control characters are newlines and tabs.
pub fn validate_slash_commands(commands: &[SlashCommand]) -> Result<(), ProviderError> {
    if commands.len() > MAX_SLASH_COMMANDS {
        return Err(invalid(format!(
            "{} entries (at most {MAX_SLASH_COMMANDS})",
            commands.len()
        )));
    }
    let mut names = HashSet::with_capacity(commands.len());
    for command in commands {
        validate_name(&command.name)?;
        if !names.insert(command.name.as_str()) {
            return Err(invalid(format!("duplicate name `{}`", command.name)));
        }
        if let Some(description) = &command.description {
            validate_description(&command.name, description)?;
        }
    }
    Ok(())
}

/// Whether the host accepts `name`: 1-128 characters without a leading `/`,
/// whitespace or control characters.
pub fn is_valid_slash_command_name(name: &str) -> bool {
    (1..=MAX_SLASH_COMMAND_NAME_CHARS).contains(&name.chars().count())
        && !name.starts_with('/')
        && !name.chars().any(|ch| ch.is_whitespace() || ch.is_control())
}

/// Make a free-form description acceptable to the host: control characters
/// other than newlines and tabs become spaces, and it is cut to 4096
/// characters.
pub fn sanitize_slash_command_description(description: &str) -> String {
    description
        .chars()
        .map(|ch| if is_rejected_control(ch) { ' ' } else { ch })
        .take(MAX_SLASH_COMMAND_DESCRIPTION_CHARS)
        .collect()
}

fn is_rejected_control(ch: char) -> bool {
    ch.is_control() && !matches!(ch, '\n' | '\r' | '\t')
}

fn validate_name(name: &str) -> Result<(), ProviderError> {
    if is_valid_slash_command_name(name) {
        Ok(())
    } else {
        Err(invalid(format!(
            "name {name:?} must be 1-{MAX_SLASH_COMMAND_NAME_CHARS} characters without a \
             leading `/`, whitespace or control characters"
        )))
    }
}

fn validate_description(name: &str, description: &str) -> Result<(), ProviderError> {
    let valid = description.chars().count() <= MAX_SLASH_COMMAND_DESCRIPTION_CHARS
        && !description.chars().any(is_rejected_control);
    if valid {
        Ok(())
    } else {
        Err(invalid(format!(
            "description of `{name}` must be at most {MAX_SLASH_COMMAND_DESCRIPTION_CHARS} \
             characters with no control characters other than newlines and tabs"
        )))
    }
}

fn invalid(message: String) -> ProviderError {
    ProviderError::new(format!("invalid slash-command list: {message}"))
}

pub(super) fn execute_slash_commands(
    provider: &impl CadencrProvider,
    args: &[OsString],
) -> Result<ExitCode, ProviderError> {
    let cwd = parse_args(args)?;
    let commands = match provider.slash_commands(&cwd) {
        // Exiting non-zero without a `{"message"}` is the "not supported"
        // answer older packages give, so the host falls back on its own.
        Ok(None) => {
            return Err(ProviderError::new(
                "this provider does not list slash commands",
            ))
        }
        Ok(Some(commands)) => commands,
        Err(error) => return Ok(report_failure(&error)),
    };
    if let Err(error) = validate_slash_commands(&commands) {
        return Ok(report_failure(&error));
    }
    println!("{}", serde_json::to_string(&commands)?);
    Ok(ExitCode::SUCCESS)
}

fn parse_args(args: &[OsString]) -> Result<PathBuf, ProviderError> {
    let usage = || {
        ProviderError::new(format!(
            "slash-commands requires `--format {SLASH_COMMANDS_FORMAT} --cwd <absolute-path>`"
        ))
    };
    if args.len() != 4
        || args[0] != "--format"
        || args[1] != SLASH_COMMANDS_FORMAT
        || args[2] != "--cwd"
    {
        return Err(usage());
    }
    let cwd = PathBuf::from(&args[3]);
    if !cwd.is_absolute() {
        return Err(ProviderError::new(
            "slash-commands `--cwd` must be absolute",
        ));
    }
    Ok(cwd)
}

/// A failed listing is reported as stdout `{"message"}` so the host can show
/// it; stderr may hold credentials and is never surfaced.
fn report_failure(error: &ProviderError) -> ExitCode {
    println!("{}", json!({ "message": error.to_string() }));
    ExitCode::FAILURE
}

#[cfg(test)]
mod tests {
    use super::{
        sanitize_slash_command_description, validate_slash_commands, SlashCommand, SlashCommandKind,
    };
    use serde_json::json;

    fn named(name: &str) -> SlashCommand {
        SlashCommand::builder().name(name).build()
    }

    #[test]
    fn serializes_the_versioned_contract() {
        let commands = vec![
            SlashCommand::builder()
                .name("review")
                .description("Review changes")
                .build(),
            SlashCommand::builder()
                .name("deploy")
                .kind(SlashCommandKind::Skill)
                .build(),
        ];
        assert_eq!(
            serde_json::to_value(&commands).unwrap(),
            json!([
                { "name": "review", "description": "Review changes", "kind": "command" },
                { "name": "deploy", "kind": "skill" }
            ])
        );
        let parsed: SlashCommand = serde_json::from_value(json!({ "name": "x" })).unwrap();
        assert_eq!(parsed.kind, SlashCommandKind::Command);
        assert!(validate_slash_commands(&commands).is_ok());
        assert!(validate_slash_commands(&[]).is_ok());
    }

    #[test]
    fn rejects_what_the_host_rejects() {
        for name in ["", "/review", "two words", "tab\tname", &"n".repeat(129)] {
            assert!(validate_slash_commands(&[named(name)]).is_err(), "{name:?}");
        }
        assert!(validate_slash_commands(&[named("plugin:review"), named("é-skill")]).is_ok());
        assert!(validate_slash_commands(&[named("a"), named("a")]).is_err());
        assert!(validate_slash_commands(&vec![named("a"); 1001]).is_err());
        let described = |description: &str| {
            validate_slash_commands(&[SlashCommand::builder()
                .name("a")
                .description(description)
                .build()])
        };
        assert!(described("Line one\nline two\t(skill)").is_ok());
        assert!(described("bell\u{7}").is_err());
        assert!(described(&"d".repeat(4097)).is_err());
    }

    #[test]
    fn sanitized_descriptions_pass_validation() {
        let raw = format!("bell\u{7} line\n{}", "d".repeat(5000));
        let sanitized = sanitize_slash_command_description(&raw);
        assert!(sanitized.starts_with("bell  line\n"));
        let command = SlashCommand::builder()
            .name("a")
            .description(sanitized)
            .build();
        assert!(validate_slash_commands(&[command]).is_ok());
    }
}
