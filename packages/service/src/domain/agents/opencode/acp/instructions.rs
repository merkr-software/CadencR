use std::collections::HashMap;
use std::fs;
use std::path::Path;

use serde_json::{json, Map, Value};
use tempfile::TempDir;

use crate::domain::agents::adapter::{RuntimeError, RuntimeSpawnConfig};
use crate::domain::agents::response_style::compose_response_style_prompt;

const CONFIG_CONTENT_ENV: &str = "OPENCODE_CONFIG_CONTENT";

/// Configure `OPENCODE_CONFIG_CONTENT` with Cadencr's instructions file (when
/// any response style or base system prompt applies) and, when `enable_todos`
/// is set for OpenCode 2.x, turn on `experimental.todo` unless already decided.
pub(super) fn apply_instruction_config(
    config: &mut RuntimeSpawnConfig,
    enable_todos: bool,
) -> Result<Option<TempDir>, RuntimeError> {
    let instructions = compose_response_style_prompt(config);
    if instructions.is_none() && !enable_todos {
        return Ok(None);
    }

    let inherited_config_content = std::env::var(CONFIG_CONTENT_ENV).ok();
    let existing_config_content = config
        .env
        .as_ref()
        .and_then(|env| env.get(CONFIG_CONTENT_ENV))
        .or(inherited_config_content.as_ref());
    let mut object = parse_config_object(existing_config_content)?;

    let dir = match instructions {
        Some(instructions) => {
            let dir = write_instruction_file(&instructions)?;
            append_instruction_path(&mut object, &dir.path().join("cadencr-instructions.md"))?;
            Some(dir)
        }
        None => None,
    };
    if enable_todos {
        enable_todo_tool(&mut object);
    }

    let merged = serde_json::to_string(&Value::Object(object)).map_err(|error| {
        RuntimeError::new(format!(
            "failed to serialize OpenCode config content: {error}"
        ))
    })?;
    config
        .env
        .get_or_insert_with(HashMap::new)
        .insert(CONFIG_CONTENT_ENV.to_string(), merged);
    Ok(dir)
}

fn write_instruction_file(instructions: &str) -> Result<TempDir, RuntimeError> {
    let dir = tempfile::Builder::new()
        .prefix("cadencr-opencode-instructions-")
        .tempdir()
        .map_err(|error| {
            RuntimeError::new(format!(
                "failed to create OpenCode instructions dir: {error}"
            ))
        })?;
    let path = dir.path().join("cadencr-instructions.md");
    fs::write(&path, instructions.as_bytes()).map_err(|error| {
        RuntimeError::new(format!(
            "failed to write OpenCode instructions file: {error}"
        ))
    })?;
    Ok(dir)
}

fn parse_config_object(existing: Option<&String>) -> Result<Map<String, Value>, RuntimeError> {
    let value = match existing
        .map(|content| content.trim())
        .filter(|content| !content.is_empty())
    {
        Some(content) => serde_json::from_str::<Value>(content).map_err(|error| {
            RuntimeError::new(format!("invalid existing OPENCODE_CONFIG_CONTENT: {error}"))
        })?,
        None => json!({}),
    };
    match value {
        Value::Object(object) => Ok(object),
        _ => Err(RuntimeError::new(
            "existing OPENCODE_CONFIG_CONTENT must be a JSON object",
        )),
    }
}

#[cfg(test)]
fn opencode_config_content_with_instruction(
    existing: Option<&String>,
    path: Option<&Path>,
    enable_todos: bool,
) -> Result<String, RuntimeError> {
    let mut object = parse_config_object(existing)?;
    if let Some(path) = path {
        append_instruction_path(&mut object, path)?;
    }
    if enable_todos {
        enable_todo_tool(&mut object);
    }
    serde_json::to_string(&Value::Object(object)).map_err(|error| {
        RuntimeError::new(format!(
            "failed to serialize OpenCode config content: {error}"
        ))
    })
}

fn append_instruction_path(
    object: &mut Map<String, Value>,
    path: &Path,
) -> Result<(), RuntimeError> {
    let path = path.to_string_lossy().into_owned();
    match object.get_mut("instructions") {
        Some(Value::Array(instructions)) => {
            if !instructions.iter().any(|item| item.as_str() == Some(&path)) {
                instructions.push(Value::String(path));
            }
        }
        Some(_) => {
            return Err(RuntimeError::new(
                "existing OPENCODE_CONFIG_CONTENT.instructions must be an array",
            ));
        }
        None => {
            object.insert("instructions".to_string(), json!([path]));
        }
    }
    Ok(())
}

fn enable_todo_tool(object: &mut Map<String, Value>) {
    let experimental = object.entry("experimental").or_insert_with(|| json!({}));
    if let Some(experimental) = experimental.as_object_mut() {
        experimental.entry("todo").or_insert(Value::Bool(true));
    }
}

#[cfg(test)]
mod tests {
    use std::collections::HashMap;
    use std::path::Path;

    use serde_json::{json, Value};

    use super::{
        apply_instruction_config, opencode_config_content_with_instruction, CONFIG_CONTENT_ENV,
    };
    use crate::domain::agents::adapter::{RuntimePurpose, RuntimeSpawnConfig};
    use crate::domain::agents::response_style::RICH_MARKDOWN_INSTRUCTION;

    fn read_instruction_file(config: &RuntimeSpawnConfig) -> String {
        let env = config.env.as_ref().unwrap();
        let parsed: Value = serde_json::from_str(env.get(CONFIG_CONTENT_ENV).unwrap()).unwrap();
        let instruction_path = parsed["instructions"][0].as_str().unwrap();
        std::fs::read_to_string(instruction_path).unwrap()
    }

    #[test]
    fn inline_config_adds_instruction_path() {
        let config = opencode_config_content_with_instruction(
            None,
            Some(Path::new("/tmp/cadencr.md")),
            false,
        )
        .expect("config serializes");
        let parsed: Value = serde_json::from_str(&config).unwrap();

        assert_eq!(parsed["instructions"], json!(["/tmp/cadencr.md"]));
    }

    #[test]
    fn inline_config_preserves_existing_content_and_appends_instruction() {
        let existing = json!({
            "model": "anthropic/claude-sonnet-4-5",
            "instructions": ["CONTRIBUTING.md"]
        })
        .to_string();
        let config = opencode_config_content_with_instruction(
            Some(&existing),
            Some(Path::new("/tmp/cadencr.md")),
            false,
        )
        .expect("config serializes");
        let parsed: Value = serde_json::from_str(&config).unwrap();

        assert_eq!(parsed["model"], "anthropic/claude-sonnet-4-5");
        assert_eq!(
            parsed["instructions"],
            json!(["CONTRIBUTING.md", "/tmp/cadencr.md"])
        );
    }

    #[test]
    fn inline_config_rejects_non_object_even_without_instruction_path() {
        let existing = "[]".to_string();
        let error = opencode_config_content_with_instruction(Some(&existing), None, true)
            .expect_err("non-object config must be rejected");
        assert!(error.to_string().contains("must be a JSON object"));
    }

    #[test]
    fn apply_instruction_config_writes_rich_markdown_prompt_file() {
        let mut config = RuntimeSpawnConfig {
            system_prompt: Some("Base prompt".to_string()),
            env: Some(HashMap::from([("EXISTING".to_string(), "1".to_string())])),
            ..RuntimeSpawnConfig::default()
        };
        let dir = apply_instruction_config(&mut config, false)
            .expect("instruction config applies")
            .expect("instructions dir created");
        let content = read_instruction_file(&config);

        assert!(dir.path().exists());
        assert_eq!(
            config
                .env
                .as_ref()
                .unwrap()
                .get("EXISTING")
                .map(String::as_str),
            Some("1")
        );
        assert!(content.starts_with(RICH_MARKDOWN_INSTRUCTION));
        assert!(content.ends_with("Base prompt"));
    }

    #[test]
    fn auto_name_skips_rich_markdown_in_opencode_instructions() {
        let mut config = RuntimeSpawnConfig {
            purpose: Some(RuntimePurpose::AutoName),
            system_prompt: Some("  Name this session.  ".to_string()),
            ..RuntimeSpawnConfig::default()
        };
        let dir = apply_instruction_config(&mut config, false)
            .expect("instruction config applies")
            .expect("auto-name base prompt file created");
        let content = read_instruction_file(&config);

        assert!(dir.path().exists());
        assert_eq!(content, "Name this session.");
        assert!(!content.contains(RICH_MARKDOWN_INSTRUCTION));

        for system_prompt in [None, Some("   \n ".to_string())] {
            let mut empty_auto_name = RuntimeSpawnConfig {
                purpose: Some(RuntimePurpose::AutoName),
                system_prompt,
                ..RuntimeSpawnConfig::default()
            };
            let none_dir = apply_instruction_config(&mut empty_auto_name, false)
                .expect("empty auto-name applies");
            assert!(none_dir.is_none());
            assert!(empty_auto_name.env.is_none());
        }
    }

    #[test]
    fn apply_instruction_config_with_todos_only_sets_experimental_todo() {
        let mut config = RuntimeSpawnConfig {
            purpose: Some(RuntimePurpose::AutoName),
            env: Some(HashMap::from([(
                CONFIG_CONTENT_ENV.to_string(),
                "{}".to_string(),
            )])),
            ..RuntimeSpawnConfig::default()
        };
        let dir = apply_instruction_config(&mut config, true).expect("todos-only config applies");
        assert!(dir.is_none());
        let parsed: Value = serde_json::from_str(
            config
                .env
                .as_ref()
                .unwrap()
                .get(CONFIG_CONTENT_ENV)
                .unwrap(),
        )
        .unwrap();
        assert!(parsed.get("instructions").is_none());
        assert_eq!(parsed["experimental"]["todo"], true);
    }

    #[test]
    fn v2_config_enables_todos_unless_already_decided() {
        let enabled: Value = serde_json::from_str(
            &opencode_config_content_with_instruction(None, Some(Path::new("/tmp/c.md")), true)
                .unwrap(),
        )
        .unwrap();
        assert_eq!(enabled["experimental"]["todo"], true);
        let existing = r#"{"experimental":{"todo":false,"codemode_vm":true}}"#.to_string();
        let kept: Value = serde_json::from_str(
            &opencode_config_content_with_instruction(
                Some(&existing),
                Some(Path::new("/tmp/c.md")),
                true,
            )
            .unwrap(),
        )
        .unwrap();
        assert_eq!(kept["experimental"]["todo"], false);
        assert_eq!(kept["experimental"]["codemode_vm"], true);
    }
}
