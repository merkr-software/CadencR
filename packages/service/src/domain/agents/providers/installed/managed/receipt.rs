//! Immutable managed-package receipts and launch-integrity metadata.

use std::collections::BTreeMap;
use std::fmt::Write as _;
use std::io::Read as _;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use sha2::{Digest as _, Sha256};

use super::conformance::ManagedProbeOutcome;
use super::{ManagedPackageAssets, SignedManagedProviderIndex};
use crate::domain::agents::providers::installed::descriptor::{
    AcpAgentEntry, HostInstallationSpec, LocalAssetsSpec, LocalExecutableSpec, ProviderDescriptor,
    SUPPORTED_SCHEMA_VERSION,
};
use crate::error::AppError;
use crate::shared::atomic_file;

pub const MANAGED_RECEIPT_SCHEMA_VERSION: u32 = 1;

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct ManagedRevision {
    pub version: String,
    pub digest: String,
}

#[derive(Debug, Clone, Deserialize, Serialize, bon::Builder)]
#[serde(deny_unknown_fields)]
pub struct ManagedPackageReceipt {
    pub schema_version: u32,
    pub agent: AcpAgentEntry,
    pub publisher: String,
    pub platform: String,
    pub archive_url: String,
    pub archive_sha256: String,
    pub archive_size: u64,
    pub archive_file_count: u32,
    pub archive_uncompressed_bytes: u64,
    pub executable: String,
    pub executable_sha256: String,
    pub payload_files: Vec<ManagedPayloadFile>,
    pub args: Vec<String>,
    pub env: BTreeMap<String, String>,
    pub assets: ManagedPackageAssets,
    pub installed_at: String,
    pub trust: ManagedTrustReceipt,
    pub conformance: ManagedConformanceReceipt,
    /// Exact signed metadata retained so rollback re-establishes trust against
    /// the host's current pinned keyring rather than trusting an old decision.
    pub signed_index: SignedManagedProviderIndex,
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct ManagedPayloadFile {
    pub path: String,
    pub sha256: String,
    pub size: u64,
    pub mode: u32,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct ManagedTrustReceipt {
    pub index_key_id: String,
    pub signed_payload_sha256: String,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct ManagedConformanceReceipt {
    pub verified_at: String,
    pub version: ManagedProbeOutcome,
    pub verified_version: String,
    pub model_config_id: String,
    pub model_ids: Vec<String>,
    pub model_count: u32,
    pub default_model: String,
    pub resume: ManagedProbeOutcome,
    pub load: ManagedProbeOutcome,
    pub close: ManagedProbeOutcome,
    pub prompt: ManagedProbeOutcome,
    pub os_sandbox_applied: bool,
}

impl ManagedPackageReceipt {
    pub fn revision(&self) -> ManagedRevision {
        ManagedRevision {
            version: self.agent.version.clone(),
            digest: self.archive_sha256.clone(),
        }
    }

    pub fn descriptor(&self, payload_dir: &Path, enabled: bool) -> ProviderDescriptor {
        let mut agent = self.agent.clone();
        // The managed envelope owns the package-relative icon. Keep the signed
        // portable entry intact in the receipt while deriving the local runtime
        // descriptor the existing adapter consumes.
        agent.icon = Some(self.assets.icon.clone());
        ProviderDescriptor {
            schema_version: SUPPORTED_SCHEMA_VERSION,
            agent,
            installation: HostInstallationSpec {
                enabled,
                executable: Some(LocalExecutableSpec {
                    command: payload_dir
                        .join(&self.executable)
                        .to_string_lossy()
                        .into_owned(),
                    args: self.args.clone(),
                    env: self.env.clone(),
                }),
                assets: Some(LocalAssetsSpec {
                    directory: payload_dir.to_string_lossy().into_owned(),
                }),
            },
        }
    }
}

pub fn read_receipt(path: &Path) -> Result<ManagedPackageReceipt, AppError> {
    let bytes = std::fs::read(path)
        .map_err(|error| receipt_error(format!("read {}: {error}", path.display())))?;
    let receipt: ManagedPackageReceipt = serde_json::from_slice(&bytes)
        .map_err(|error| receipt_error(format!("parse {}: {error}", path.display())))?;
    if receipt.schema_version != MANAGED_RECEIPT_SCHEMA_VERSION {
        return Err(receipt_error(format!(
            "receipt {} uses unsupported schema_version {}",
            path.display(),
            receipt.schema_version
        )));
    }
    Ok(receipt)
}

pub fn write_receipt(path: &Path, receipt: &ManagedPackageReceipt) -> Result<(), AppError> {
    let mut json = serde_json::to_string_pretty(receipt)
        .map_err(|error| AppError::Internal(format!("serialize managed receipt: {error}")))?;
    json.push('\n');
    atomic_file::write_atomic_private(path, &json)
}

pub fn hash_regular_file(path: &Path) -> Result<String, AppError> {
    let metadata = std::fs::symlink_metadata(path)
        .map_err(|error| receipt_error(format!("inspect {}: {error}", path.display())))?;
    if !metadata.file_type().is_file() || metadata.file_type().is_symlink() {
        return Err(receipt_error(format!(
            "managed executable {} is not a regular file",
            path.display()
        )));
    }
    let mut file = std::fs::File::open(path)
        .map_err(|error| receipt_error(format!("open {}: {error}", path.display())))?;
    let mut hasher = Sha256::new();
    let mut buffer = [0_u8; 64 * 1024];
    loop {
        let read = file
            .read(&mut buffer)
            .map_err(|error| receipt_error(format!("hash {}: {error}", path.display())))?;
        if read == 0 {
            break;
        }
        hasher.update(&buffer[..read]);
    }
    Ok(hex_lower(&hasher.finalize()))
}

pub fn payload_manifest(payload: &Path) -> Result<Vec<ManagedPayloadFile>, AppError> {
    let mut files = Vec::new();
    collect_payload_files(payload, payload, &mut files)?;
    files.sort_by(|left, right| left.path.cmp(&right.path));
    Ok(files)
}

pub fn verify_payload_manifest(
    payload: &Path,
    expected: &[ManagedPayloadFile],
) -> Result<(), AppError> {
    let actual = payload_manifest(payload)?;
    if actual == expected {
        Ok(())
    } else {
        Err(AppError::coded(
            axum::http::StatusCode::CONFLICT,
            "MANAGED_PAYLOAD_TAMPERED",
            format!(
                "managed payload {} differs from its receipt",
                payload.display()
            ),
        ))
    }
}

fn collect_payload_files(
    root: &Path,
    directory: &Path,
    files: &mut Vec<ManagedPayloadFile>,
) -> Result<(), AppError> {
    let mut entries = std::fs::read_dir(directory)
        .map_err(|error| receipt_error(format!("read {}: {error}", directory.display())))?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|error| receipt_error(format!("read {}: {error}", directory.display())))?;
    entries.sort_by_key(std::fs::DirEntry::file_name);
    for entry in entries {
        let path = entry.path();
        let metadata = std::fs::symlink_metadata(&path)
            .map_err(|error| receipt_error(format!("inspect {}: {error}", path.display())))?;
        if metadata.file_type().is_symlink() {
            return Err(receipt_error(format!(
                "managed payload {} contains a symbolic link",
                path.display()
            )));
        }
        if metadata.is_dir() {
            collect_payload_files(root, &path, files)?;
        } else if metadata.is_file() {
            let relative = path.strip_prefix(root).map_err(|_| {
                receipt_error(format!(
                    "managed payload path {} escaped root",
                    path.display()
                ))
            })?;
            let relative = relative.to_str().ok_or_else(|| {
                receipt_error(format!(
                    "managed payload path {} is not UTF-8",
                    path.display()
                ))
            })?;
            files.push(ManagedPayloadFile {
                path: relative.replace(std::path::MAIN_SEPARATOR, "/"),
                sha256: hash_regular_file(&path)?,
                size: metadata.len(),
                mode: file_mode(&metadata),
            });
        } else {
            return Err(receipt_error(format!(
                "managed payload {} is not a regular file or directory",
                path.display()
            )));
        }
    }
    Ok(())
}

#[cfg(unix)]
fn file_mode(metadata: &std::fs::Metadata) -> u32 {
    use std::os::unix::fs::PermissionsExt as _;
    metadata.permissions().mode() & 0o777
}

#[cfg(not(unix))]
fn file_mode(_metadata: &std::fs::Metadata) -> u32 {
    0
}

pub fn signed_payload_sha256(bytes: &[u8]) -> String {
    hex_lower(&Sha256::digest(bytes))
}

pub fn receipt_path(payload_dir: &Path) -> Result<PathBuf, AppError> {
    let revision_dir = payload_dir.parent().ok_or_else(|| {
        AppError::Internal(format!(
            "managed payload has no revision directory: {}",
            payload_dir.display()
        ))
    })?;
    Ok(revision_dir.join("receipt.json"))
}

fn receipt_error(message: impl Into<String>) -> AppError {
    AppError::coded(
        axum::http::StatusCode::CONFLICT,
        "MANAGED_RECEIPT_INVALID",
        message,
    )
}

fn now() -> String {
    chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
}

pub fn installed_now() -> String {
    now()
}

fn hex_lower(bytes: &[u8]) -> String {
    let mut encoded = String::with_capacity(bytes.len() * 2);
    for byte in bytes {
        write!(&mut encoded, "{byte:02x}").expect("writing to a String cannot fail");
    }
    encoded
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn file_hash_rejects_symlinks_and_changes_with_bytes() {
        let directory = tempfile::tempdir().unwrap();
        let executable = directory.path().join("agent");
        std::fs::write(&executable, b"first").unwrap();
        let first = hash_regular_file(&executable).unwrap();
        std::fs::write(&executable, b"second").unwrap();
        assert_ne!(first, hash_regular_file(&executable).unwrap());

        #[cfg(unix)]
        {
            std::os::unix::fs::symlink(&executable, directory.path().join("link")).unwrap();
            assert!(hash_regular_file(&directory.path().join("link")).is_err());
        }
    }

    #[test]
    fn receipt_is_private_and_round_trips() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("receipt.json");
        let mut value = json!({
            "schema_version": 1,
            "agent": {
                "id": "acme-agent", "name": "Acme", "version": "1.0.0",
                "description": "d"
            },
            "publisher": "acme", "platform": "darwin-aarch64",
            "archive_url": "https://example.test/acme.tar.gz",
            "archive_sha256": "a".repeat(64), "archive_size": 42,
            "archive_file_count": 2, "archive_uncompressed_bytes": 84,
            "executable": "bin/acme", "executable_sha256": "b".repeat(64),
            "payload_files": [{
                "path": "bin/acme", "sha256": "b".repeat(64), "size": 42, "mode": 493
            }],
            "args": [], "env": {}, "assets": { "icon": "icon.svg" },
            "installed_at": "2026-01-01T00:00:00.000Z",
            "trust": { "index_key_id": "key", "signed_payload_sha256": "c".repeat(64) },
            "conformance": {
                "verified_at": "2026-01-01T00:00:00.000Z", "version": "passed",
                "verified_version": "1.2.3", "model_config_id": "model",
                "model_ids": ["acme-1"], "model_count": 1, "default_model": "acme-1",
                "resume": "not_advertised", "load": "not_advertised",
                "close": "passed", "prompt": "unprobed", "os_sandbox_applied": false
            },
            "signed_index": null
        });
        value["signed_index"] = serde_json::from_str(include_str!(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/tests/fixtures/managed_provider_index/v1/valid.json"
        )))
        .unwrap();
        let receipt: ManagedPackageReceipt = serde_json::from_value(value).unwrap();
        write_receipt(&path, &receipt).unwrap();
        assert_eq!(read_receipt(&path).unwrap().agent.id, "acme-agent");
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt as _;
            assert_eq!(
                std::fs::metadata(path).unwrap().permissions().mode() & 0o777,
                0o600
            );
        }
    }

    #[test]
    fn payload_manifest_detects_non_executable_tampering() {
        let directory = tempfile::tempdir().unwrap();
        std::fs::create_dir(directory.path().join("lib")).unwrap();
        std::fs::write(directory.path().join("agent"), b"launcher").unwrap();
        std::fs::write(directory.path().join("lib/runtime.js"), b"trusted").unwrap();
        let manifest = payload_manifest(directory.path()).unwrap();
        std::fs::write(directory.path().join("lib/runtime.js"), b"tampered").unwrap();
        let error = verify_payload_manifest(directory.path(), &manifest).unwrap_err();
        assert!(error.to_string().contains("differs from its receipt"));
    }
}
