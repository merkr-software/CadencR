//! The plugin surface: the service's OpenAPI document filtered to the policy
//! table's scoped operations (`dump-openapi --plugin-surface`). The SDK's
//! typed client (`@cadencr/tab-sdk/api`) is generated from it, so the client
//! can only name routes a plugin token may call.
//!
//! Each operation carries `x-cadencr-scope` (the scopes that admit it),
//! `x-cadencr-binding` and `x-cadencr-tier`; operation ids lose their
//! `_handler` suffix so generated names read `getFeature`, `getGitStatus`….
//! Grant, `self` and socket routes are host plumbing reached through the SDK's
//! own methods and are left out.

use std::collections::{BTreeMap, BTreeSet};

use serde_json::{json, Map, Value};

use super::policy::{self, Binding, PolicyEntry};
use super::socket;

/// Component schemas of stream payloads (§4.4), kept even when no operation
/// references them so the SDK can type stream events.
const STREAM_SCHEMAS: [&str; 12] = [
    "GitStatusSnapshot",
    "PrStatusSnapshot",
    "UserMessagePayload",
    "PermissionRequestPayload",
    "GateClosedPayload",
    "PromptReceivedPayload",
    "SessionStreamStatusPayload",
    "BranchRewoundPayload",
    "BranchForkedPayload",
    "WsSessionAction",
    "WsSessionEvent",
    "WsEnvelope",
];

/// Build the plugin surface from the full document.
pub fn plugin_surface(full: &utoipa::openapi::OpenApi) -> Result<Value, String> {
    let full = serde_json::to_value(full).map_err(|error| error.to_string())?;
    let mut paths = Map::new();
    let mut grouped: BTreeMap<(&str, &str), Vec<&PolicyEntry>> = BTreeMap::new();
    for entry in policy::surface() {
        grouped
            .entry((entry.path, entry.method))
            .or_default()
            .push(entry);
    }
    for ((path, method), entries) in grouped {
        let verb = method.to_ascii_lowercase();
        let mut operation = full["paths"][path][verb.as_str()].clone();
        let Some(fields) = operation.as_object_mut() else {
            return Err(format!(
                "{method} {path} is in the policy table but not in the OpenAPI document"
            ));
        };
        annotate(fields, &entries);
        let item = paths
            .entry(path.to_string())
            .or_insert_with(|| Value::Object(Map::new()));
        item[verb.as_str()] = operation;
    }
    let schemas = &full["components"]["schemas"];
    let mut wanted: BTreeSet<String> = BTreeSet::new();
    collect_refs(&Value::Object(paths.clone()), &mut wanted);
    for name in STREAM_SCHEMAS {
        if schemas.get(name).is_none() {
            return Err(format!(
                "stream schema {name} is not in the OpenAPI document"
            ));
        }
        wanted.insert(name.to_string());
    }
    let components = close_over(schemas, wanted);
    let topics: Vec<Value> = socket::topic_scopes()
        .into_iter()
        .map(|(topic, scope)| json!({ "topic": topic, "scope": scope.as_str() }))
        .collect();
    Ok(json!({
        "openapi": full["openapi"],
        "info": {
            "title": "Cadencr plugin API",
            "version": full["info"]["version"],
            "description": "The routes a custom tab may call with its grant (docs/CUSTOM_TABS.md §4.3, §6).",
        },
        "paths": paths,
        "components": { "schemas": components },
        "x-cadencr-stream-topics": topics,
    }))
}

fn annotate(operation: &mut Map<String, Value>, entries: &[&PolicyEntry]) {
    let scopes: Vec<&str> = entries
        .iter()
        .filter_map(|entry| entry.scope.map(|scope| scope.as_str()))
        .collect();
    let bindings: Vec<String> = entries
        .iter()
        .map(|entry| binding_label(entry.binding))
        .collect();
    // The least stable entry decides: a route is `stable` only if every way
    // to reach it is.
    let tier = if entries
        .iter()
        .all(|entry| entry.tier == policy::Tier::Stable)
    {
        policy::Tier::Stable
    } else {
        policy::Tier::Proposed
    };
    operation.insert("x-cadencr-scope".into(), json!(scopes));
    operation.insert("x-cadencr-binding".into(), json!(bindings));
    operation.insert("x-cadencr-tier".into(), json!(tier.as_str()));
    if let Some(Value::String(id)) = operation.get_mut("operationId") {
        if let Some(stripped) = id.strip_suffix("_handler") {
            *id = stripped.to_string();
        }
    }
}

fn binding_label(binding: Binding) -> String {
    match binding {
        Binding::FeaturePath(param) => format!("feature:path:{param}"),
        Binding::FeatureQuery(param) => format!("feature:query:{param}"),
        Binding::ProjectPath(param) => format!("project:path:{param}"),
        Binding::ProjectQuery(param) => format!("project:query:{param}"),
        Binding::SelfPlugin => "self".into(),
        Binding::Unbound => "none".into(),
    }
}

const REF_PREFIX: &str = "#/components/schemas/";

fn collect_refs(value: &Value, into: &mut BTreeSet<String>) {
    match value {
        Value::Object(map) => {
            if let Some(Value::String(reference)) = map.get("$ref") {
                if let Some(name) = reference.strip_prefix(REF_PREFIX) {
                    into.insert(name.to_string());
                }
            }
            map.values().for_each(|child| collect_refs(child, into));
        }
        Value::Array(items) => items.iter().for_each(|child| collect_refs(child, into)),
        _ => {}
    }
}

/// `wanted` and every schema they reference, transitively.
fn close_over(schemas: &Value, mut pending: BTreeSet<String>) -> Map<String, Value> {
    let mut out = Map::new();
    while let Some(name) = pending.pop_first() {
        if out.contains_key(&name) {
            continue;
        }
        let Some(schema) = schemas.get(&name) else {
            continue;
        };
        let mut nested = BTreeSet::new();
        collect_refs(schema, &mut nested);
        pending.extend(nested.into_iter().filter(|child| !out.contains_key(child)));
        out.insert(name, schema.clone());
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn surface() -> Value {
        plugin_surface(&crate::api::openapi::api_doc()).unwrap()
    }

    #[test]
    fn keeps_exactly_the_scoped_policy_operations() {
        let surface = surface();
        let mut documented = BTreeSet::new();
        for (path, item) in surface["paths"].as_object().unwrap() {
            for (verb, operation) in item.as_object().unwrap() {
                documented.insert((path.clone(), verb.to_ascii_uppercase()));
                assert!(operation["x-cadencr-scope"]
                    .as_array()
                    .is_some_and(|s| !s.is_empty()));
                assert_eq!(operation["x-cadencr-tier"], "proposed");
                let id = operation["operationId"].as_str().unwrap();
                assert!(!id.ends_with("_handler"), "{id}");
            }
        }
        let expected: BTreeSet<(String, String)> = policy::surface()
            .map(|entry| (entry.path.to_string(), entry.method.to_string()))
            .collect();
        assert_eq!(documented, expected);
        assert!(!surface["paths"]
            .as_object()
            .unwrap()
            .keys()
            .any(|p| p.contains("/self/") || p.contains("grants")));
        let features = &surface["paths"]["/api/features"]["get"]["x-cadencr-scope"];
        assert_eq!(features, &json!(["features:read", "workspace:read"]));
    }

    #[test]
    fn carries_every_referenced_schema_and_the_stream_payloads() {
        let surface = surface();
        let schemas = surface["components"]["schemas"].as_object().unwrap();
        let mut referenced = BTreeSet::new();
        collect_refs(&surface["paths"], &mut referenced);
        for schema in schemas.values() {
            collect_refs(schema, &mut referenced);
        }
        for name in &referenced {
            assert!(schemas.contains_key(name), "missing component {name}");
        }
        assert!(schemas.contains_key("GitStatusSnapshot"));
        assert!(schemas.contains_key("WsSessionAction"));
        assert!(schemas.contains_key("WsSessionEvent"));
        assert!(schemas.contains_key("WsEnvelope"));
        assert!(schemas.contains_key("Feature"));
        assert!(!schemas.contains_key("PluginTabSummary"));
        assert_eq!(
            surface["x-cadencr-stream-topics"].as_array().unwrap().len(),
            6
        );
    }

    #[test]
    fn generated_operation_names_are_unique() {
        let surface = surface();
        let mut ids = BTreeSet::new();
        for item in surface["paths"].as_object().unwrap().values() {
            for operation in item.as_object().unwrap().values() {
                let id = operation["operationId"].as_str().unwrap().to_string();
                assert!(ids.insert(id.clone()), "duplicate operationId {id}");
            }
        }
    }
}
