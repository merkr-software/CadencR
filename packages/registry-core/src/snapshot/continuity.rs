use std::collections::HashMap;

use serde_json::Value;

use crate::error::RegistryError;
use crate::package::identity;

pub(super) fn validate_continuity(
    previous: &Value,
    candidate: &Value,
) -> Result<(), RegistryError> {
    if timestamp(candidate) <= timestamp(previous) {
        return Err(RegistryError::single(
            "catalog generated_at must strictly increase",
        ));
    }
    let next = packages(candidate)
        .iter()
        .filter_map(|value| identity(value).map(|id| (id, value)))
        .collect::<HashMap<_, _>>();
    for prior in packages(previous) {
        let id = identity(prior).expect("verified package identity");
        let label = format!("{}@{}", id.0, id.1);
        let Some(current) = next.get(&id) else {
            return Err(RegistryError::single(format!(
                "catalog removes previous package {label}"
            )));
        };
        if *current != prior {
            return Err(RegistryError::single(format!(
                "catalog mutates previous package {label}"
            )));
        }
    }
    let owners = packages(previous)
        .iter()
        .filter_map(|value| identity(value).map(|(id, _)| (id, owner(value))))
        .collect::<HashMap<_, _>>();
    for entry in packages(candidate) {
        let (id, _) = identity(entry).expect("verified package identity");
        if owners.get(id).is_some_and(|prior| prior != &owner(entry)) {
            return Err(RegistryError::single(format!(
                "provider {id} changes publisher or source ownership"
            )));
        }
    }
    Ok(())
}

fn timestamp(value: &Value) -> &str {
    value["generated_at"].as_str().expect("verified timestamp")
}
fn packages(value: &Value) -> &[Value] {
    value["packages"].as_array().expect("verified packages")
}
fn owner(value: &Value) -> (Option<&str>, Option<&str>) {
    (
        value.pointer("/host/publisher").and_then(Value::as_str),
        value.pointer("/agent/repository").and_then(Value::as_str),
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn package(version: &str) -> Value {
        let mut value: Value = serde_json::from_str(include_str!(
            "../../../../tooling/marketplace-registry/tests/fixtures/example-provider.json.fixture"
        ))
        .unwrap();
        value["agent"]["version"] = json!(version);
        value
    }

    #[test]
    fn rejects_time_removal_mutation_and_owner_changes() {
        let previous = json!({"generated_at":"2026-01-01T00:00:00Z","packages":[package("1.0.0")]});
        let mut candidate = previous.clone();
        assert!(validate_continuity(&previous, &candidate)
            .unwrap_err()
            .to_string()
            .contains("strictly increase"));
        candidate["generated_at"] = json!("2026-01-02T00:00:00Z");
        candidate["packages"] = json!([]);
        assert!(validate_continuity(&previous, &candidate)
            .unwrap_err()
            .to_string()
            .contains("removes"));
        candidate["packages"] = json!([package("1.0.0")]);
        candidate["packages"][0]["agent"]["name"] = json!("Changed");
        assert!(validate_continuity(&previous, &candidate)
            .unwrap_err()
            .to_string()
            .contains("mutates"));
        candidate["packages"] = json!([package("1.0.0"), package("2.0.0")]);
        candidate["packages"][1]["host"]["publisher"] = json!("other");
        assert!(validate_continuity(&previous, &candidate)
            .unwrap_err()
            .to_string()
            .contains("changes publisher"));
    }
}
