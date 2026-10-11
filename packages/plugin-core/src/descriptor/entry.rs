use super::AcpDistribution;
use serde::{Deserialize, Deserializer, Serialize};
use serde_json::{Map, Value};

/// ACP Registry agent entry. Field names and shapes follow
/// <https://github.com/agentclientprotocol/registry> `agent.schema.json`.
#[derive(Debug, Clone, Deserialize, Serialize, utoipa::ToSchema)]
pub struct AcpAgentEntry {
    pub id: String,
    pub name: String,
    pub version: String,
    pub description: String,
    #[serde(
        default,
        deserialize_with = "deserialize_non_null_option",
        skip_serializing_if = "Option::is_none"
    )]
    #[schema(nullable = false)]
    pub repository: Option<String>,
    #[serde(
        default,
        deserialize_with = "deserialize_non_null_option",
        skip_serializing_if = "Option::is_none"
    )]
    #[schema(nullable = false)]
    pub website: Option<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub authors: Vec<String>,
    #[serde(
        default,
        deserialize_with = "deserialize_non_null_option",
        skip_serializing_if = "Option::is_none"
    )]
    #[schema(nullable = false)]
    pub license: Option<String>,
    #[serde(
        default,
        deserialize_with = "deserialize_non_null_option",
        skip_serializing_if = "Option::is_none"
    )]
    #[schema(nullable = false)]
    pub icon: Option<String>,
    /// Optional in the Rust shape because a hand-written local install has
    /// nothing to download. The registry-import validation profile requires it;
    /// the local-install profile does not.
    #[serde(
        default,
        deserialize_with = "deserialize_non_null_option",
        skip_serializing_if = "Option::is_none"
    )]
    #[schema(nullable = false)]
    pub distribution: Option<AcpDistribution>,
    /// Every field this build does not model, preserved verbatim.
    #[serde(flatten)]
    pub extra: Map<String, Value>,
}

/// JSON Schema optional properties may be absent, but an explicit `null` is
/// not a value of their declared type. Serde's ordinary `Option<T>` collapses
/// those two cases, so registry fields use this deserializer to preserve the
/// schema distinction: `#[serde(default)]` handles absence, while a present
/// value must deserialize as `T`.
pub(super) fn deserialize_non_null_option<'de, D, T>(deserializer: D) -> Result<Option<T>, D::Error>
where
    D: Deserializer<'de>,
    T: Deserialize<'de>,
{
    T::deserialize(deserializer).map(Some)
}

#[cfg(test)]
mod tests {
    use super::super::fixture::*;
    use super::*;
    use serde_json::json;

    #[test]
    fn validates_every_registry_uri_field() {
        for field in ["repository", "website"] {
            let mut agent = valid_agent();
            agent["distribution"] = json!({ "npx": { "package": "acme-agent" } });
            agent[field] = json!("not a uri");
            let error = descriptor(json!({ "schema_version": 1, "agent": agent }))
                .agent
                .validate_registry_entry()
                .expect_err("invalid URI should be rejected");
            assert!(error.message.contains(field), "{}", error.message);
        }

        let mut agent = valid_agent();
        agent["distribution"] = json!({
            "binary": {
                "linux-x86_64": { "archive": "not a uri", "cmd": "acme" },
            },
        });
        let error = descriptor(json!({ "schema_version": 1, "agent": agent }))
            .agent
            .validate_registry_entry()
            .expect_err("invalid archive URI should be rejected");
        assert!(error.message.contains("archive"), "{}", error.message);
    }

    #[test]
    fn optional_registry_properties_reject_explicit_null() {
        for (field, value) in [
            ("repository", json!(null)),
            ("website", json!(null)),
            ("license", json!(null)),
            ("icon", json!(null)),
            ("distribution", json!(null)),
        ] {
            let mut agent = valid_agent();
            agent[field] = value;
            let error = serde_json::from_value::<AcpAgentEntry>(agent)
                .expect_err("an explicit null is not an omitted schema property");
            assert!(error.to_string().contains("null"), "{field}: {error}");
        }

        for distribution in [
            json!({ "binary": null, "npx": { "package": "acme" } }),
            json!({ "npx": null, "uvx": { "package": "acme" } }),
            json!({ "uvx": null, "npx": { "package": "acme" } }),
            json!({
                "binary": {
                    "linux-x86_64": {
                        "archive": "https://example.com/acme.tar.gz",
                        "cmd": "acme",
                        "sha256": null,
                    },
                },
            }),
        ] {
            let mut agent = valid_agent();
            agent["distribution"] = distribution;
            serde_json::from_value::<AcpAgentEntry>(agent)
                .expect_err("nested optional schema properties reject null");
        }
    }

    #[test]
    fn pinned_registry_entry_validates_and_round_trips_losslessly() {
        let raw = std::fs::read_to_string(registry_fixture("claude-acp.agent.json"))
            .expect("pinned registry entry");
        let original: serde_json::Value = serde_json::from_str(&raw).expect("fixture JSON");
        let entry: AcpAgentEntry = serde_json::from_value(original.clone()).expect("entry shape");
        entry
            .validate_registry_entry()
            .expect("pinned upstream entry should validate");
        assert_eq!(serde_json::to_value(entry).unwrap(), original);
    }

    #[test]
    fn pinned_schema_records_the_constraints_implemented_here() {
        let raw = std::fs::read_to_string(registry_fixture("agent.schema.json"))
            .expect("pinned registry schema");
        let schema: serde_json::Value = serde_json::from_str(&raw).expect("schema JSON");
        assert_eq!(
            schema["$id"],
            "https://cdn.agentclientprotocol.com/registry/v1/latest/agent.schema.json"
        );
        assert!(schema["required"]
            .as_array()
            .expect("required")
            .iter()
            .any(|field| field == "distribution"));
        assert_eq!(
            schema["properties"]["distribution"]["additionalProperties"],
            false
        );
        assert_eq!(
            schema["definitions"]["binaryDistribution"]["minProperties"],
            1
        );
        assert_eq!(
            schema["definitions"]["binaryTarget"]["additionalProperties"],
            false
        );
        assert_eq!(
            schema["definitions"]["packageDistribution"]["additionalProperties"],
            false
        );
    }

    /// Registry fields this build does not model must survive a round trip, so
    /// an imported entry can be exported again without silent data loss.
    #[test]
    fn unknown_registry_fields_round_trip() {
        let entry: AcpAgentEntry = serde_json::from_value(json!({
            "id": "acme-agent",
            "name": "Acme Agent",
            "version": "1.0.0",
            "description": "d",
            "license": "MIT",
            "futureField": { "nested": [1, 2, 3] },
        }))
        .unwrap();
        assert_eq!(entry.extra.get("futureField").unwrap()["nested"][2], 3);
        let exported = serde_json::to_value(&entry).unwrap();
        assert_eq!(exported["futureField"]["nested"][2], 3);
        assert_eq!(exported["license"], "MIT");
    }

    #[test]
    fn registry_profile_preserves_unknown_root_fields_without_applying_host_policy() {
        let entry: AcpAgentEntry = serde_json::from_value(json!({
            "id": "acme-agent",
            "name": "Acme Agent",
            "version": "1.0.0",
            "description": "d",
            "distribution": { "npx": { "package": "acme-agent" } },
            "models": ["future-registry-field"],
        }))
        .unwrap();
        entry
            .validate_registry_entry()
            .expect("the upstream root schema permits additional properties");
        assert_eq!(entry.extra["models"][0], "future-registry-field");
    }
}
