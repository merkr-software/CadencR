use serde_json::{json, Value};

/// A complete, valid distributed `theme.json` document.
pub fn document() -> Value {
    use cadencr_plugin_core::theme::{schema, tokens};
    let mut vars = serde_json::Map::new();
    for token in tokens::REQUIRED_TOKENS {
        vars.insert((*token).into(), json!("#000000"));
    }
    for pair in tokens::CONTRAST_PAIRS {
        vars.insert(pair.foreground.into(), json!("#ffffff"));
    }
    let contract: Value = serde_json::from_str(&schema::render()).unwrap();
    let xterm = contract["properties"]["xterm"]["properties"]
        .as_object()
        .unwrap()
        .keys()
        .map(|key| (key.clone(), json!("#ffffff")))
        .collect::<serde_json::Map<_, _>>();
    json!({"label":"CLI Theme", "appearance":"dark", "cssVars":vars, "xterm":xterm})
}
