use super::ProviderDescriptor;
use serde_json::json;
use std::path::PathBuf;

pub(super) fn descriptor(value: serde_json::Value) -> ProviderDescriptor {
    serde_json::from_value(value).expect("descriptor should deserialize")
}

pub(super) fn valid_agent() -> serde_json::Value {
    json!({
        "id": "acme-agent",
        "name": "Acme Agent",
        "version": "1.2.3",
        "description": "An ACP agent",
    })
}

pub(super) fn registry_fixture(name: &str) -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("tests/fixtures/acp_registry/v1")
        .join(name)
}
