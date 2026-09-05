use chrono::Utc;
use serde::Serialize;
use std::collections::HashMap;
use std::path::Path;
use std::sync::{OnceLock, RwLock};

use super::super::history::{read_state, ManagedHistoryEntry};
use super::super::installer::{verify_descriptor_projection, ManagedStorage};
use super::super::quarantine::{records, ManagedQuarantineRecord};
use crate::domain::agents::providers::installed::installation::HostInstallation;
use crate::domain::agents::providers::installed::InstalledLoadOutcome;
use crate::error::AppError;

#[derive(Debug, Clone, Serialize, utoipa::ToSchema)]
pub struct ManagedProvidersInventory {
    pub root: String,
    pub process_policy: crate::domain::agents::providers::installed::managed::process_policy::ManagedProcessPolicyOutcome,
    pub trust: ManagedTrustInventory,
    pub blocklist: ManagedBlocklistInventory,
    pub providers: Vec<ManagedProviderInventoryEntry>,
}

#[derive(Debug, Clone, Serialize, utoipa::ToSchema)]
pub struct ManagedBlocklistInventory {
    pub source_configured: bool,
    pub cache_status: ManagedBlocklistCacheStatus,
    pub signer_key_id: Option<String>,
    pub expires_at: Option<String>,
    pub error_code: Option<String>,
    pub error: Option<String>,
    pub last_refresh: Option<ManagedBlocklistRefreshInventory>,
}

#[derive(Debug, Clone, Copy, Serialize, utoipa::ToSchema)]
#[serde(rename_all = "snake_case")]
pub enum ManagedBlocklistCacheStatus {
    Missing,
    Verified,
    Invalid,
}

#[derive(Debug, Clone, Serialize, utoipa::ToSchema)]
pub struct ManagedBlocklistRefreshInventory {
    pub attempted_at: String,
    pub outcome: ManagedBlocklistRefreshOutcome,
    pub error_code: Option<String>,
    pub error: Option<String>,
}

#[derive(Debug, Clone, Copy, Serialize, utoipa::ToSchema)]
#[serde(rename_all = "snake_case")]
pub enum ManagedBlocklistRefreshOutcome {
    Refreshed,
    UsedCachedVerifiedPolicy,
    Failed,
}

#[derive(Debug, Clone, Serialize, utoipa::ToSchema)]
pub struct ManagedTrustInventory {
    pub status: ManagedTrustConfigurationStatus,
    pub key_id: Option<String>,
    pub error_code: Option<String>,
    pub error: Option<String>,
}

#[derive(Debug, Clone, Copy, Serialize, utoipa::ToSchema)]
#[serde(rename_all = "snake_case")]
pub enum ManagedTrustConfigurationStatus {
    Unconfigured,
    Configured,
    Invalid,
}

#[derive(Debug, Clone, Serialize, utoipa::ToSchema)]
pub struct ManagedProviderInventoryEntry {
    pub id: String,
    pub version: Option<String>,
    pub digest: Option<String>,
    pub enabled_after_restart: bool,
    pub active_now: bool,
    /// Whether the desired revision passes the next startup scan's descriptor,
    /// identity, and payload checks. Trust and blocklist policy are rechecked at launch.
    pub active_after_restart: bool,
    pub restart_required: bool,
    pub history: Vec<ManagedHistoryEntry>,
    pub quarantine: Vec<ManagedQuarantineRecord>,
    /// Per-installation diagnostics never prevent listing other providers.
    pub error_code: Option<String>,
    pub error: Option<String>,
}

pub(super) fn inventory(
    storage: &ManagedStorage,
    descriptors: &Path,
    boot: &InstalledLoadOutcome,
) -> Result<ManagedProvidersInventory, AppError> {
    let boot_by_id: HashMap<_, _> = boot
        .installations
        .iter()
        .map(|installation| (installation.provider_id(), installation.as_ref()))
        .collect();
    let providers = storage
        .provider_ids()
        .into_iter()
        .map(|provider_id| {
            provider_entry(
                storage,
                descriptors,
                &provider_id,
                boot_by_id.get(provider_id.as_str()).copied(),
            )
        })
        .collect();
    Ok(ManagedProvidersInventory {
        root: storage.root().display().to_string(),
        process_policy: crate::domain::agents::providers::installed::managed::process_policy::managed_process_policy_outcome(),
        trust: trust_inventory(),
        blocklist: blocklist_inventory(storage),
        providers,
    })
}

pub(super) fn inventory_entry(
    storage: &ManagedStorage,
    descriptors: &Path,
    provider_id: &str,
    boot: &InstalledLoadOutcome,
) -> ManagedProviderInventoryEntry {
    let boot_install = boot
        .installations
        .iter()
        .find(|installation| installation.provider_id() == provider_id)
        .map(AsRef::as_ref);
    provider_entry(storage, descriptors, provider_id, boot_install)
}

fn provider_entry(
    storage: &ManagedStorage,
    descriptors: &Path,
    provider_id: &str,
    boot: Option<&HostInstallation>,
) -> ManagedProviderInventoryEntry {
    let active_now = boot.is_some_and(|installation| installation.enabled());
    let mut entry = ManagedProviderInventoryEntry {
        id: provider_id.to_string(),
        version: None,
        digest: None,
        enabled_after_restart: false,
        active_now,
        active_after_restart: false,
        restart_required: active_now,
        history: Vec::new(),
        quarantine: Vec::new(),
        error_code: None,
        error: None,
    };
    match records(storage, provider_id) {
        Ok(records) => entry.quarantine = records,
        Err(error) => entry.record_error(error, "MANAGED_QUARANTINE_INVALID"),
    }
    let state = match storage
        .state_path(provider_id)
        .and_then(|path| read_state(&path, provider_id))
    {
        Ok(state) => state,
        Err(error) => {
            entry.record_error(error, "MANAGED_STATE_INVALID");
            return entry;
        }
    };
    entry.history = state.history.clone();
    let Some(active) = state.active.as_ref() else {
        return entry;
    };
    entry.version = Some(active.revision.version.clone());
    entry.digest = Some(active.revision.digest.clone());
    entry.enabled_after_restart = active.enabled;
    match verify_descriptor_projection(storage, descriptors, &state) {
        Ok(Some(projection)) => {
            entry.active_after_restart = true;
            let matches = boot.is_some_and(|installation| {
                installation.executable().command == projection.executable
            });
            entry.restart_required = active_now != active.enabled || (active.enabled && !matches);
        }
        Ok(None) => entry.restart_required = active_now,
        Err(error) => entry.record_error(error, "MANAGED_RECEIPT_INVALID"),
    }
    entry
}

impl ManagedProviderInventoryEntry {
    fn record_error(&mut self, error: AppError, fallback: &str) {
        let code = match &error {
            AppError::Coded { code, .. } => *code,
            _ => fallback,
        };
        // Persisted content may be corrupt or contain secrets; expose stable
        // diagnostics, not arbitrary parse-error contents, in the inventory.
        let message = format!(
            "Provider {} has unreadable or invalid local metadata ({code})",
            self.id
        );
        self.error_code.get_or_insert_with(|| code.to_string());
        match &mut self.error {
            Some(previous) => {
                previous.push_str("; ");
                previous.push_str(&message);
            }
            None => self.error = Some(message),
        }
    }
}

fn blocklist_inventory(storage: &ManagedStorage) -> ManagedBlocklistInventory {
    let source_configured = super::super::blocklist::pinned_blocklist_url().is_some();
    match super::super::blocklist::load_cached_blocklist(
        &storage.blocklist_cache_path(),
        &super::super::trust::pinned_index_trust_store(),
        Utc::now(),
    ) {
        Ok(Some(blocklist)) => ManagedBlocklistInventory {
            source_configured,
            cache_status: ManagedBlocklistCacheStatus::Verified,
            signer_key_id: Some(blocklist.signer_key_id().to_string()),
            expires_at: Some(blocklist.expires_at().to_rfc3339()),
            error_code: None,
            error: None,
            last_refresh: last_blocklist_refresh(),
        },
        Ok(None) => ManagedBlocklistInventory {
            source_configured,
            cache_status: ManagedBlocklistCacheStatus::Missing,
            signer_key_id: None,
            expires_at: None,
            error_code: None,
            error: None,
            last_refresh: last_blocklist_refresh(),
        },
        Err(error) => ManagedBlocklistInventory {
            source_configured,
            cache_status: ManagedBlocklistCacheStatus::Invalid,
            signer_key_id: None,
            expires_at: None,
            error_code: Some(error.code.as_str().to_string()),
            error: Some(error.message),
            last_refresh: last_blocklist_refresh(),
        },
    }
}

fn trust_inventory() -> ManagedTrustInventory {
    use super::super::trust::{pinned_index_trust_status, PinnedIndexTrustStatus};

    match pinned_index_trust_status() {
        PinnedIndexTrustStatus::Unconfigured => ManagedTrustInventory {
            status: ManagedTrustConfigurationStatus::Unconfigured,
            key_id: None,
            error_code: None,
            error: None,
        },
        PinnedIndexTrustStatus::Configured { key } => ManagedTrustInventory {
            status: ManagedTrustConfigurationStatus::Configured,
            key_id: Some(key.key_id().to_string()),
            error_code: None,
            error: None,
        },
        PinnedIndexTrustStatus::Invalid { code, message } => ManagedTrustInventory {
            status: ManagedTrustConfigurationStatus::Invalid,
            key_id: None,
            error_code: Some(code.to_string()),
            error: Some(message),
        },
    }
}

pub(super) fn record_blocklist_refresh(
    outcome: ManagedBlocklistRefreshOutcome,
    error: Option<(&str, &str)>,
) {
    let refresh = ManagedBlocklistRefreshInventory {
        attempted_at: Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true),
        outcome,
        error_code: error.map(|(code, _)| code.to_string()),
        error: error.map(|(_, message)| message.to_string()),
    };
    *blocklist_refresh_slot()
        .write()
        .unwrap_or_else(|poisoned| poisoned.into_inner()) = Some(refresh);
}

fn last_blocklist_refresh() -> Option<ManagedBlocklistRefreshInventory> {
    blocklist_refresh_slot()
        .read()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
        .clone()
}

fn blocklist_refresh_slot() -> &'static RwLock<Option<ManagedBlocklistRefreshInventory>> {
    static LAST_REFRESH: OnceLock<RwLock<Option<ManagedBlocklistRefreshInventory>>> =
        OnceLock::new();
    LAST_REFRESH.get_or_init(RwLock::default)
}

#[cfg(test)]
mod tests {
    use super::super::super::history::{write_state, ManagedActiveRevision, ManagedProviderState};
    use super::super::super::receipt::ManagedRevision;
    use super::*;

    #[test]
    fn corrupt_state_and_ledger_are_reported_without_losing_other_entries() {
        let root = tempfile::tempdir().unwrap();
        let storage = ManagedStorage::new(root.path().to_path_buf());
        let bad_dir = storage.provider_dir("broken").unwrap();
        std::fs::create_dir_all(&bad_dir).unwrap();
        std::fs::write(bad_dir.join("state.json"), b"{bad state").unwrap();
        std::fs::write(bad_dir.join("quarantine.json"), b"{secret bad ledger").unwrap();
        let descriptors = root.path().join("descriptors");
        let bad = provider_entry(&storage, &descriptors, "broken", None);
        assert!(bad.error_code.is_some());
        assert!(!bad.error.unwrap().contains("secret"));
        assert!(!bad.active_after_restart);
        let good = provider_entry(&storage, &descriptors, "healthy", None);
        assert!(good.error.is_none());
    }

    #[test]
    fn missing_receipt_retains_desired_identity_and_diagnostic() {
        let root = tempfile::tempdir().unwrap();
        let storage = ManagedStorage::new(root.path().to_path_buf());
        let mut state = ManagedProviderState::empty("missing-receipt");
        state.active = Some(ManagedActiveRevision {
            revision: ManagedRevision {
                version: "1.0.0".into(),
                digest: "a".repeat(64),
            },
            enabled: true,
        });
        write_state(&storage.state_path("missing-receipt").unwrap(), &state).unwrap();
        let entry = provider_entry(
            &storage,
            &root.path().join("descriptors"),
            "missing-receipt",
            None,
        );
        assert_eq!(entry.version.as_deref(), Some("1.0.0"));
        assert!(entry.enabled_after_restart);
        assert!(!entry.active_after_restart);
        assert_eq!(entry.error_code.as_deref(), Some("MANAGED_RECEIPT_INVALID"));
    }
}
