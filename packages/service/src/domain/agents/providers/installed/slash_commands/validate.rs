//! Parsing and validation of `slash-commands` output
//! (`cadencr-slash-commands-v1`): a JSON array of `{name, description?,
//! kind?}`. Any invalid entry rejects the whole list, so the menu never shows
//! a half-trusted catalog. Unknown entry keys are ignored for forward
//! compatibility; an unknown `kind` is not.

use std::collections::HashSet;

use serde::Deserialize;

use crate::domain::agents::adapter::{RuntimeSlashCommand, RuntimeSlashCommandKind};

const MAX_COMMANDS: usize = 1000;
const MAX_NAME_CHARS: usize = 128;
const MAX_DESCRIPTION_CHARS: usize = 4096;

#[derive(Deserialize)]
struct RawSlashCommand {
    name: String,
    description: Option<String>,
    #[serde(default)]
    kind: RawKind,
}

#[derive(Deserialize, Default)]
#[serde(rename_all = "lowercase")]
enum RawKind {
    #[default]
    Command,
    Skill,
}

pub fn parse_slash_commands(bytes: &[u8]) -> Result<Vec<RuntimeSlashCommand>, String> {
    let raw: Vec<RawSlashCommand> = serde_json::from_slice(bytes)
        .map_err(|error| format!("output is not a slash-command JSON array: {error}"))?;
    if raw.len() > MAX_COMMANDS {
        return Err(format!(
            "output lists {} commands (at most {MAX_COMMANDS})",
            raw.len()
        ));
    }
    let mut names = HashSet::with_capacity(raw.len());
    raw.into_iter()
        .map(|command| {
            validate_name(&command.name)?;
            if !names.insert(command.name.clone()) {
                return Err(format!("duplicate command name `{}`", command.name));
            }
            if let Some(description) = &command.description {
                validate_description(&command.name, description)?;
            }
            Ok(RuntimeSlashCommand {
                name: command.name,
                description: command.description,
                kind: match command.kind {
                    RawKind::Command => RuntimeSlashCommandKind::Command,
                    RawKind::Skill => RuntimeSlashCommandKind::Skill,
                },
            })
        })
        .collect()
}

fn validate_name(name: &str) -> Result<(), String> {
    let valid = (1..=MAX_NAME_CHARS).contains(&name.chars().count())
        && !name.starts_with('/')
        && !name.chars().any(|ch| ch.is_whitespace() || ch.is_control());
    if valid {
        Ok(())
    } else {
        Err(format!(
            "command name {name:?} must be 1-{MAX_NAME_CHARS} characters without a leading \
             `/`, whitespace or control characters"
        ))
    }
}

fn validate_description(name: &str, description: &str) -> Result<(), String> {
    let valid = description.chars().count() <= MAX_DESCRIPTION_CHARS
        && !description
            .chars()
            .any(|ch| ch.is_control() && !matches!(ch, '\n' | '\r' | '\t'));
    if valid {
        Ok(())
    } else {
        Err(format!(
            "description of `{name}` must be at most {MAX_DESCRIPTION_CHARS} characters with no \
             control characters other than newlines and tabs"
        ))
    }
}

#[cfg(test)]
mod tests {
    use super::parse_slash_commands;
    use crate::domain::agents::adapter::RuntimeSlashCommandKind;
    use serde_json::json;

    fn parse(value: serde_json::Value) -> Result<Vec<super::RuntimeSlashCommand>, String> {
        parse_slash_commands(&serde_json::to_vec(&value).unwrap())
    }

    #[test]
    fn accepts_the_contract_and_ignores_unknown_entry_keys() {
        let parsed = parse(json!([
            { "name": "review", "description": "Review\nchanges", "future": 1 },
            { "name": "plugin:deploy", "kind": "skill" },
            { "name": "copy-id", "kind": "command" }
        ]))
        .unwrap();
        assert_eq!(parsed.len(), 3);
        assert_eq!(parsed[0].description.as_deref(), Some("Review\nchanges"));
        assert_eq!(parsed[0].kind, RuntimeSlashCommandKind::Command);
        assert_eq!(parsed[1].kind, RuntimeSlashCommandKind::Skill);
        assert!(parse(json!([])).unwrap().is_empty());
    }

    #[test]
    fn rejects_every_invalid_list() {
        let many: Vec<_> = (0..1001)
            .map(|i| json!({ "name": format!("c{i}") }))
            .collect();
        for value in [
            json!({ "commands": [] }),
            json!([{ "description": "no name" }]),
            json!([{ "name": "" }]),
            json!([{ "name": "/review" }]),
            json!([{ "name": "two words" }]),
            json!([{ "name": "n".repeat(129) }]),
            json!([{ "name": "a" }, { "name": "a" }]),
            json!([{ "name": "a", "kind": "macro" }]),
            json!([{ "name": "a", "description": "bell\u{7}" }]),
            json!([{ "name": "a", "description": "d".repeat(4097) }]),
            json!(many),
        ] {
            assert!(parse(value.clone()).is_err(), "{value} should be rejected");
        }
    }
}
