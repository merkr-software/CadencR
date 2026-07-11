use serde_json::{json, Value};

pub(super) fn schema(name: &str) -> Value {
    match name {
        "project_list_pending_gates" => json!({
            "type": "object",
            "properties": { "session_id": { "type": "number" } },
            "required": ["session_id"]
        }),
        "project_respond_gate" => respond_schema(),
        _ => json!({ "type": "object", "properties": {} }),
    }
}

fn respond_schema() -> Value {
    json!({
        "type": "object",
        "properties": {
            "session_id": { "type": "number" },
            "request_id": { "type": "string" },
            "decision": {
                "oneOf": [
                    {"type":"object","properties":{"type":{"const":"permission"},"action":{"type":"string","enum":["allow_once","allow_always","deny"]},"message":{"type":"string"}},"required":["type","action"]},
                    {"type":"object","properties":{"type":{"const":"plan"},"action":{"type":"string","enum":["approve","request_changes","reject"]},"message":{"type":"string"}},"required":["type","action"]},
                    {"type":"object","properties":{"type":{"const":"question"},"answers":{"oneOf":[{"type":"object"},{"type":"array"},{"type":"string"}]}},"required":["type","answers"]}
                ]
            }
        },
        "required": ["session_id", "request_id", "decision"]
    })
}
