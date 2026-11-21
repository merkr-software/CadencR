use serde_json::Value;

const WARNING_TEXT_LIMIT: usize = 512;

/// CadencR uses the ACP option name as the user-visible label. Include any
/// native warning about a persistent grant there while retaining the option's
/// id, kind, and metadata for the permission response.
pub(super) fn display_security_warnings(params: &mut Value) {
    let Some(options) = params.get_mut("options").and_then(Value::as_array_mut) else {
        return;
    };
    for option in options {
        if option.get("kind").and_then(Value::as_str) != Some("allow_always") {
            continue;
        }
        let Some(label) = option.get("name").and_then(Value::as_str) else {
            continue;
        };
        let Some(warning) = security_warning(option) else {
            continue;
        };
        if !label.contains(&warning) {
            option["name"] = Value::String(format!("{label} ({warning})"));
        }
    }
}

fn security_warning(option: &Value) -> Option<String> {
    let meta = option.pointer("/_meta/agy.security.warning")?;
    let warning = ["message", "title"]
        .into_iter()
        .filter_map(|key| meta.get(key).and_then(Value::as_str).map(str::trim))
        .find(|text| !text.is_empty())?;
    let mut characters = warning.chars();
    let mut text = characters
        .by_ref()
        .take(WARNING_TEXT_LIMIT)
        .collect::<String>();
    if characters.next().is_some() {
        text.push('…');
    }
    Some(text)
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    #[test]
    fn persistent_grant_warning_is_visible_once_and_retains_wire_metadata() {
        let original = json!({
            "optionId":"native-always","kind":"allow_always","name":"Allow always",
            "_meta":{"agy.security.warning":{"title":"Permission scope","message":"  Includes future commands.  "}}
        });
        let mut params = json!({"options":[original.clone()]});
        display_security_warnings(&mut params);
        display_security_warnings(&mut params);
        let option = &params["options"][0];
        assert_eq!(option["name"], "Allow always (Includes future commands.)");
        for key in ["optionId", "kind", "_meta"] {
            assert_eq!(option[key], original[key]);
        }
    }

    #[test]
    fn empty_or_malformed_warnings_do_not_change_labels() {
        let original = json!({"options":[
            {"name":"Allow always","kind":"allow_always","_meta":{"agy.security.warning":{"message":42,"title":"  "}}},
            {"name":"Allow once","kind":"allow_once","_meta":{"agy.security.warning":{"message":"Other warning"}}}
        ]});
        let mut params = original.clone();
        display_security_warnings(&mut params);
        assert_eq!(params, original);
    }
}
