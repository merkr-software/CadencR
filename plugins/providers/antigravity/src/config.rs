use cadencr_provider_sdk::meta::{
    merge_meta, permission_mode_meta_with_accent, ModeAccent, PermissionMode,
};
use serde_json::{json, Value};

use crate::cli;
use crate::native_compat::VERIFIED_CLI_VERSION;

const AUTO_MCP_HINT: &str = "Antigravity may still ask you to approve MCP tools.";

pub fn catalog_mode() -> Value {
    let mut option = json!({
        "id": "mode", "name": "Mode", "category": "mode", "type": "select",
        "currentValue": "default",
        "options": [
            {"value":"default","name":"Default","description":"Ask before edits and commands, per your permission settings."},
            {"value":"accept-edits","name":"Accept edits","description":"Approve file edits in the workspace without asking."},
            {"value":"auto","name":"Auto","description":"Approve workspace edits and safe commands automatically. Requires a personal account and terminal sandbox support."},
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
        let (permission_mode, accent) = match choice.get("value").and_then(Value::as_str) {
            Some("default") => (PermissionMode::Default, ModeAccent::Blue),
            Some("accept-edits") => (PermissionMode::AcceptEdits, ModeAccent::Green),
            Some("auto") => {
                let detail = choice
                    .get("description")
                    .and_then(Value::as_str)
                    .unwrap_or_default();
                if !detail.contains(AUTO_MCP_HINT) {
                    let detail = match detail.trim_end() {
                        "" => AUTO_MCP_HINT.to_owned(),
                        native => format!("{native} {AUTO_MCP_HINT}"),
                    };
                    choice.insert("description".into(), Value::String(detail));
                }
                (PermissionMode::Auto, ModeAccent::Yellow)
            }
            Some("plan") => (PermissionMode::Plan, ModeAccent::Violet),
            _ => continue,
        };
        merge_meta(
            choice,
            permission_mode_meta_with_accent(permission_mode, accent),
        );
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
                advertise_prompt_steering(result);
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

fn advertise_prompt_steering(result: &mut Value) {
    // agy introduced concurrent steering prompts in its ACP v1 server in 1.5.0.
    let version = result.pointer("/agentInfo/version").and_then(Value::as_str);
    if result["protocolVersion"] == 1
        && version.is_some_and(crate::native_compat::supports_prompt_steering)
    {
        if let Some(capabilities) = result["agentCapabilities"].as_object_mut() {
            merge_meta(
                capabilities,
                cadencr_provider_sdk::meta::prompt_steering_meta(),
            );
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
        if version
            .as_str()
            .is_some_and(|native| native != VERIFIED_CLI_VERSION)
        {
            eprintln!("Antigravity reported an unverified CLI version. The initial slash menu and child journal reader were verified with agy {VERIFIED_CLI_VERSION}. Check `agy --version` when diagnosing missing commands or child activity.");
        }
        let meta = [("antigravity".to_string(), json!({"cliVersion": version}))];
        merge_meta(info, meta.into_iter().collect());
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn steering_is_negotiated_from_the_native_cli_and_acp_versions() {
        for (cli, acp, expected) in [
            ("1.5.14", 1, true),
            ("1.5.0", 1, true),
            ("1.5.0-beta.1", 1, false),
            ("1.4.99", 1, false),
            ("2.0.0", 1, false),
            ("unknown", 1, false),
            ("1.5.14", 2, false),
        ] {
            let mut response = json!({"result":{"protocolVersion":acp,"agentInfo":{"version":cli},
                "agentCapabilities":{"_meta":{"antigravity":{"feature":true}}}}});
            ConfigMapper::default().map_agent(&mut response);
            assert_eq!(
                response
                    .pointer("/result/agentCapabilities/_meta/cadencr/promptSteering")
                    .is_some(),
                expected
            );
            assert_eq!(
                response["result"]["agentCapabilities"]["_meta"]["antigravity"]["feature"],
                true
            );
        }
    }

    #[test]
    fn auto_preserves_native_mcp_guidance_and_adds_its_approval_hint_once() {
        let mut modes = json!({"id":"mode","options":[
            {"value":"auto","description":"Discover configured MCP servers."}
        ]});
        decorate_mode(&mut modes);
        decorate_mode(&mut modes);
        assert_eq!(
            modes["options"][0]["description"],
            format!("Discover configured MCP servers. {AUTO_MCP_HINT}")
        );
    }
}
