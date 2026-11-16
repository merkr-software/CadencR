use super::{compare_packages, validate_index, validate_window};
use crate::{
    diagnostics::Diagnostics,
    json::canonical_json,
    package::{identity, validate_package},
    tree::load_packages,
    RegistryError,
};
use chrono::Utc;
use serde_json::json;
use std::path::Path;

#[bon::builder]
pub fn build_index(
    packages_dir: &Path,
    #[builder(default)] provider_handoffs: Vec<crate::ProviderHandoff>,
    #[builder(default = 1)] schema_version: u64,
    generated_at: &str,
    expires_at: &str,
) -> Result<Vec<u8>, RegistryError> {
    let metadata = json!({"generated_at": generated_at, "expires_at": expires_at});
    let mut errors = Diagnostics::default();
    validate_window(
        metadata.as_object().expect("JSON object"),
        Utc::now(),
        false,
        &mut errors,
    );
    if !errors.is_empty() {
        return Err(RegistryError::from_messages(errors.into_messages()));
    }
    let mut errors = Diagnostics::default();
    let mut packages = load_packages(packages_dir, &mut errors)
        .into_iter()
        .flat_map(|values| values.into_values())
        .collect::<Vec<_>>();
    if !errors.is_empty() {
        return Err(RegistryError::from_messages(errors.into_messages()));
    }
    // Only unsigned directory assembly adapts immutable legacy documents in memory.
    // Signed payload validation and authenticated upgrade policy never call this path.
    if schema_version == 2 {
        for package in &mut packages {
            if package.get("kind").is_none() {
                validate_package(package, "legacy provider package", &mut errors);
                if !errors.is_empty() {
                    return Err(RegistryError::from_messages(errors.into_messages()));
                }
                *package = json!({"kind": "provider", "package": package});
            }
        }
    }
    packages.sort_by(compare_packages);
    let mut index = json!({"schema_version": schema_version, "generated_at": generated_at, "expires_at": expires_at, "packages": packages});
    if !provider_handoffs.is_empty() {
        crate::provider_handoff::validate_records(&provider_handoffs)?;
        // This is an unsigned author-URL preview, never the protected publisher's
        // signed mirror payload. Bind preview records to the preview entries.
        let mut preview = provider_handoffs;
        for record in &mut preview {
            for (version, digest) in &mut record.retired_versions {
                let package = index["packages"]
                    .as_array()
                    .expect("constructed packages")
                    .iter()
                    .find(|p| identity(p) == Some((record.provider_id.as_str(), version.as_str())))
                    .ok_or_else(|| {
                        RegistryError::single("unsigned preview omits a retired version")
                    })?;
                *digest = crate::digest::sha256_hex(&crate::canonical_json_bytes(package));
            }
        }
        index["provider_handoffs"] = json!(preview);
    }
    validate_index(&index, Utc::now(), false)?;
    Ok(canonical_json(&index).into_bytes())
}
