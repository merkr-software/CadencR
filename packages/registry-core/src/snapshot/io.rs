use std::path::Path;

use serde_json::Value;

use crate::error::RegistryError;
use crate::json::parse_json;
use crate::safe_io::read_bounded_regular;

pub(super) fn parse_document(bytes: &[u8], label: &str) -> Result<Value, RegistryError> {
    parse_json(bytes).map_err(|_| RegistryError::single(format!("{label} must be valid JSON")))
}

pub(super) fn read_file(path: &Path, limit: u64, label: &str) -> Result<Vec<u8>, RegistryError> {
    read_bounded_regular(path, limit)
        .map_err(|error| RegistryError::single(format!("cannot read {label}: {error}")))
}
