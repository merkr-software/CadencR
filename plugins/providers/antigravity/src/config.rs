use cadencr_provider_sdk::meta::{merge_meta, permission_mode_meta, PermissionMode};
use serde_json::{json, Value};

use crate::cli;

pub fn catalog_mode() -> Value {
    // Auto is conditional on the account and the native sandbox. The cold
    // catalog only maps modes available without those prerequisites.
    let mut option = json!({
        "id": "mode", "name": "Mode", "category": "mode", "type": "select",
        "currentValue": "default",
        "options": [
            {"value":"default","name":"Default","description":"Ask before edits and commands, per your permission settings."},
            {"value":"accept-edits","name":"Accept edits","description":"Approve file edits in the workspace without asking."},
            {"value":"plan","name":"Plan","description":"Plan carefully before executing a task."}
        ],
    });
    decorate_mode(&mut option);
    option
}

fn decorate_mode(option: &mut Value) {
    if option.get("id").and_then(Value::as_str) != Some("mode") {
        return;
    }
    let Some(choices) = option.get_mut("options").and_then(Value::as_array_mut) else {
        return;
    };
    for choice in choices.iter_mut().filter_map(Value::as_object_mut) {
        let permission_mode = match choice.get("value").and_then(Value::as_str) {
            Some("default") => PermissionMode::Default,
            Some("accept-edits") => PermissionMode::AcceptEdits,
            Some("auto") => PermissionMode::Auto,
            Some("plan") => PermissionMode::Plan,
            _ => continue,
        };
        merge_meta(choice, permission_mode_meta(permission_mode));
    }
}

#[derive(Default)]
pub struct ConfigMapper {
    system_prompt_append: bool,
}

impl ConfigMapper {
    pub fn map_agent(&mut self, message: &mut Value) {
        match message.get("method").and_then(Value::as_str) {
            Some("session/update") => {
                if let Some(update) = message
                    .pointer_mut("/params/update")
                    .filter(|update| update["sessionUpdate"] == "config_option_update")
                {
                    decorate_options(update);
                }
            }
            None => self.map_response(message),
            Some(_) => {}
        }
    }

    fn map_response(&mut self, message: &mut Value) {
        if let Some(result) = message.get_mut("result") {
            if let Some(capabilities) = result.get("agentCapabilities") {
                self.system_prompt_append = capabilities
                    .pointer("/_meta/antigravity/systemPrompt/append")
                    .and_then(Value::as_bool)
                    .unwrap_or(false);
                decorate_agent_info(result);
            }
            decorate_options(result);
        }
        if message.pointer("/error/code").and_then(Value::as_i64) == Some(-32000)
            && message.pointer("/error/message").and_then(Value::as_str)
                == Some("Authentication required")
        {
            message["error"]["message"] =
                json!(format!("Authentication required. {}", cli::SIGN_IN));
        }
    }

    pub fn map_host(&self, message: &mut Value) {
        if !self.system_prompt_append || message["method"] != "session/new" {
            return;
        }
        let Some(prompt) = message
            .pointer("/params/_meta/com.cadencr/systemPrompt")
            .and_then(Value::as_str)
            .filter(|prompt| !prompt.is_empty())
        else {
            return;
        };
        let prompt = json!(prompt);
        let Some(meta) = message
            .pointer_mut("/params/_meta")
            .and_then(Value::as_object_mut)
        else {
            return;
        };
        if let Some(antigravity) = meta
            .entry("antigravity")
            .or_insert_with(|| json!({}))
            .as_object_mut()
        {
            if let Some(system_prompt) = antigravity
                .entry("systemPrompt")
                .or_insert_with(|| json!({}))
                .as_object_mut()
            {
                system_prompt.entry("append").or_insert(prompt);
            }
        }
    }
}

fn decorate_options(payload: &mut Value) {
    if let Some(options) = payload
        .get_mut("configOptions")
        .and_then(Value::as_array_mut)
    {
        for option in options {
            decorate_mode(option);
        }
    }
}

fn decorate_agent_info(result: &mut Value) {
    let Some(info) = result.get_mut("agentInfo").and_then(Value::as_object_mut) else {
        return;
    };
    // Managed conformance compares the implementation version to the
    // connector's package metadata. Keep the native version for diagnostics.
    if let Some(version) = info.insert("version".to_string(), json!(env!("CARGO_PKG_VERSION"))) {
        let meta = [("antigravity".to_string(), json!({"cliVersion": version}))];
        merge_meta(info, meta.into_iter().collect());
    }
}
