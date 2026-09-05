//! Durable redacted evidence for managed-package refusal and quarantine.

use std::path::Path;
use std::sync::Mutex;

use serde::{Deserialize, Serialize};

use super::installer::ManagedStorage;
use crate::error::AppError;
use crate::shared::atomic_file;

const SCHEMA_VERSION: u32 = 1;
// Separate from the async lifecycle lock: launch and admission failures append
// here too, including while lifecycle mutations already hold that lock.
static LEDGER_WRITE_LOCK: Mutex<()> = Mutex::new(());

#[derive(Debug, Clone, Copy, Deserialize, Serialize, PartialEq, Eq, utoipa::ToSchema)]
#[serde(rename_all = "snake_case")]
pub enum ManagedFailureStage {
    Trust,
    Compatibility,
    Blocklist,
    Download,
    Extraction,
    Payload,
    Conformance,
    Activation,
    Rollback,
    Launch,
}

#[derive(Debug, Clone, Deserialize, Serialize, utoipa::ToSchema)]
#[serde(deny_unknown_fields)]
pub struct ManagedQuarantineRecord {
    pub sequence: u64,
    pub provider_id: String,
    pub version: String,
    pub digest: Option<String>,
    pub stage: ManagedFailureStage,
    pub code: String,
    /// Stable redacted explanation. Provider output, environment and stderr are
    /// never persisted.
    pub message: String,
    pub occurred_at: String,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct ManagedQuarantineLedger {
    schema_version: u32,
    provider_id: String,
    records: Vec<ManagedQuarantineRecord>,
}

pub fn append(
    storage: &ManagedStorage,
    provider_id: &str,
    version: &str,
    digest: Option<&str>,
    stage: ManagedFailureStage,
    code: &str,
) -> Result<ManagedQuarantineRecord, AppError> {
    let _guard = LEDGER_WRITE_LOCK.lock().map_err(|_| {
        AppError::Internal("managed quarantine ledger write lock is poisoned".into())
    })?;
    let path = quarantine_path(storage, provider_id)?;
    let mut ledger = read_ledger(&path, provider_id)?;
    let record = ManagedQuarantineRecord {
        sequence: ledger
            .records
            .last()
            .map_or(1, |record| record.sequence.saturating_add(1)),
        provider_id: provider_id.to_string(),
        version: version.to_string(),
        digest: digest.map(str::to_string),
        stage,
        code: code.to_string(),
        message: safe_message(stage, code),
        occurred_at: chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true),
    };
    ledger.records.push(record.clone());
    let mut json = serde_json::to_string_pretty(&ledger)
        .map_err(|error| AppError::Internal(format!("serialize quarantine ledger: {error}")))?;
    json.push('\n');
    atomic_file::write_atomic_private(&path, &json)?;
    Ok(record)
}

pub fn records(
    storage: &ManagedStorage,
    provider_id: &str,
) -> Result<Vec<ManagedQuarantineRecord>, AppError> {
    Ok(read_ledger(&quarantine_path(storage, provider_id)?, provider_id)?.records)
}

fn read_ledger(path: &Path, provider_id: &str) -> Result<ManagedQuarantineLedger, AppError> {
    match std::fs::read(path) {
        Ok(bytes) => {
            let ledger: ManagedQuarantineLedger =
                serde_json::from_slice(&bytes).map_err(|error| {
                    AppError::Internal(format!(
                        "parse quarantine ledger {}: {error}",
                        path.display()
                    ))
                })?;
            if ledger.schema_version != SCHEMA_VERSION || ledger.provider_id != provider_id {
                return Err(AppError::Internal(format!(
                    "quarantine ledger {} has mismatched identity",
                    path.display()
                )));
            }
            Ok(ledger)
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(ManagedQuarantineLedger {
            schema_version: SCHEMA_VERSION,
            provider_id: provider_id.to_string(),
            records: Vec::new(),
        }),
        Err(error) => Err(AppError::Internal(format!(
            "read quarantine ledger {}: {error}",
            path.display()
        ))),
    }
}

fn quarantine_path(
    storage: &ManagedStorage,
    provider_id: &str,
) -> Result<std::path::PathBuf, AppError> {
    Ok(storage.provider_dir(provider_id)?.join("quarantine.json"))
}

fn safe_message(stage: ManagedFailureStage, code: &str) -> String {
    format!("managed provider failed the {stage:?} gate ({code})")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn concurrent_failures_preserve_every_record_and_sequence() {
        let directory = tempfile::tempdir().unwrap();
        let storage = ManagedStorage::new(directory.path().into());
        let barrier = std::sync::Barrier::new(16);
        std::thread::scope(|scope| {
            for index in 0..16 {
                let storage = &storage;
                let barrier = &barrier;
                scope.spawn(move || {
                    barrier.wait();
                    append(
                        storage,
                        "acme-agent",
                        "1.0.0",
                        None,
                        ManagedFailureStage::Launch,
                        &format!("FAILURE_{index}"),
                    )
                    .unwrap();
                });
            }
        });
        let records = records(&storage, "acme-agent").unwrap();
        assert_eq!(records.len(), 16);
        assert_eq!(
            records
                .iter()
                .map(|record| record.sequence)
                .collect::<Vec<_>>(),
            (1..=16).collect::<Vec<_>>()
        );
        assert_eq!(
            records
                .iter()
                .map(|record| &record.code)
                .collect::<std::collections::HashSet<_>>()
                .len(),
            16
        );
    }

    #[test]
    fn ledger_is_monotonic_and_redacted() {
        let directory = tempfile::tempdir().unwrap();
        let storage = ManagedStorage::new(directory.path().into());
        append(
            &storage,
            "acme-agent",
            "1.0.0",
            None,
            ManagedFailureStage::Trust,
            "UNKNOWN_SIGNING_KEY",
        )
        .unwrap();
        let second = append(
            &storage,
            "acme-agent",
            "1.0.0",
            Some(&"a".repeat(64)),
            ManagedFailureStage::Download,
            "ARTIFACT_HASH_MISMATCH",
        )
        .unwrap();
        assert_eq!(second.sequence, 2);
        assert_eq!(records(&storage, "acme-agent").unwrap().len(), 2);
    }
}
