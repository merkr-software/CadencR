//! Field-level tolerance for messages the turn machinery cannot afford to lose.

use serde::de::DeserializeOwned;
use serde::{Deserialize, Deserializer};
use serde_json::Value;
use tracing::warn;

/// Deserialize a field, falling back to its default when the CLI sends `null`
/// or a shape that drifted from the typed schema. Pair with `#[serde(default)]`
/// so a missing field defaults too. Used on `result`, whose loss would leave
/// the turn running forever: a renamed counter must cost that counter, never
/// the turn end.
pub(super) fn lenient<'de, D, T>(deserializer: D) -> Result<T, D::Error>
where
    D: Deserializer<'de>,
    T: DeserializeOwned + Default,
{
    let value = Value::deserialize(deserializer)?;
    if value.is_null() {
        return Ok(T::default());
    }
    match T::deserialize(&value) {
        Ok(parsed) => Ok(parsed),
        Err(error) => {
            warn!(
                field_type = std::any::type_name::<T>(),
                %error,
                received = %value,
                "claude SDK: result field did not match its schema; using its default"
            );
            Ok(T::default())
        }
    }
}

#[cfg(test)]
mod tests {
    use serde::Deserialize;
    use serde_json::json;

    use super::lenient;

    #[derive(Deserialize)]
    struct Probe {
        #[serde(default, deserialize_with = "lenient")]
        count: u64,
        #[serde(default, deserialize_with = "lenient")]
        label: Option<String>,
    }

    #[test]
    fn drifted_null_and_missing_fields_fall_back_to_defaults() {
        let probe: Probe = serde_json::from_value(json!({ "count": "12", "label": null })).unwrap();
        assert_eq!(probe.count, 0);
        assert_eq!(probe.label, None);

        let probe: Probe = serde_json::from_value(json!({})).unwrap();
        assert_eq!(probe.count, 0);
        assert_eq!(probe.label, None);
    }

    #[test]
    fn well_formed_fields_parse_normally() {
        let probe: Probe = serde_json::from_value(json!({ "count": 3, "label": "ok" })).unwrap();
        assert_eq!(probe.count, 3);
        assert_eq!(probe.label.as_deref(), Some("ok"));
    }
}
