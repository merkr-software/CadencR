use chrono::{SecondsFormat, Utc};
use serde_json::{Map, Value};

use crate::error::RegistryError;
use crate::index::validate_index;
use crate::json::canonical_json_bytes;

use super::DOCUMENT_LIMIT;

pub(crate) fn validate_signing_payload(
    value: &Value,
    allow_expired: bool,
) -> Result<Vec<u8>, RegistryError> {
    let canonical = canonical_json_bytes(value);
    if canonical.len() as u64 > DOCUMENT_LIMIT {
        return Err(RegistryError::single(
            "canonical signing payload exceeds 32 MiB",
        ));
    }
    validate_canonical_timestamps(value)?;
    validate_optional_fields(value)?;
    validate_index(value, Utc::now(), allow_expired)?;
    Ok(canonical)
}

fn validate_canonical_timestamps(signed: &Value) -> Result<(), RegistryError> {
    for field in ["generated_at", "expires_at"] {
        let Some(value) = signed.get(field).and_then(Value::as_str) else {
            continue;
        };
        let parsed = chrono::DateTime::parse_from_rfc3339(value).ok();
        let canonical = parsed.map(|timestamp| {
            timestamp
                .with_timezone(&Utc)
                .to_rfc3339_opts(SecondsFormat::Secs, true)
        });
        if value.len() != 20 || canonical.as_deref() != Some(value) {
            return Err(RegistryError::single(format!(
                "payload.{field} must use canonical UTC whole-second form YYYY-MM-DDTHH:mm:ssZ"
            )));
        }
    }
    Ok(())
}

fn validate_optional_fields(signed: &Value) -> Result<(), RegistryError> {
    let Some(packages) = signed.get("packages").and_then(Value::as_array) else {
        return Ok(());
    };
    for (index, package) in packages.iter().enumerate() {
        let agent = package.get("agent");
        reject_empty(
            agent,
            "authors",
            &format!("payload.packages[{index}].agent.authors"),
        )?;
        let distribution = agent.and_then(|value| value.get("distribution"));
        if let Some(binary) = distribution
            .and_then(|value| value.get("binary"))
            .and_then(Value::as_object)
        {
            for (target, config) in binary {
                let prefix =
                    format!("payload.packages[{index}].agent.distribution.binary.{target}");
                reject_empty(Some(config), "args", &format!("{prefix}.args"))?;
                reject_empty(Some(config), "env", &format!("{prefix}.env"))?;
            }
        }
        for runner in ["npx", "uvx"] {
            let config = distribution.and_then(|value| value.get(runner));
            let prefix = format!("payload.packages[{index}].agent.distribution.{runner}");
            reject_empty(config, "args", &format!("{prefix}.args"))?;
            reject_empty(config, "env", &format!("{prefix}.env"))?;
        }
    }
    Ok(())
}

fn reject_empty(parent: Option<&Value>, field: &str, label: &str) -> Result<(), RegistryError> {
    let Some(value) = parent.and_then(|value| value.get(field)) else {
        return Ok(());
    };
    if value.as_array().is_some_and(Vec::is_empty) || value.as_object().is_some_and(Map::is_empty) {
        return Err(RegistryError::single(format!(
            "{label} is an empty optional field; omit it before signing"
        )));
    }
    Ok(())
}
