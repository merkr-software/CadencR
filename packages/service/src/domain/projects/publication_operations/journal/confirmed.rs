//! Durable reviewed intent, stored in the same private atomic operation record.
use super::*;
use crate::domain::projects::publication_release::registry::PublicationRegistryPreview;

const MAX_SCAN_BYTES: u64 = MAX_RECORD_BYTES * 8;
const MAX_MATCHING_PLANS: usize = 2;

#[derive(bon::Builder)]
pub(crate) struct RegistryIdentity {
    plugin_id: String,
    version: String,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct RegistryPlan {
    pub preview: PublicationRegistryPreview,
    pub actor_id: u64,
    pub repository_id: u64,
    pub package: String,
    pub submission: String,
    pub markdown: String,
}

pub(crate) async fn recover(
    project_id: i64,
    current: Option<String>,
    identity: RegistryIdentity,
) -> Result<Vec<RegistryPlan>, AppError> {
    let root = root(project_id).await?;
    tokio::task::spawn_blocking(move || {
        recover_at(
            &root,
            project_id,
            current.as_deref(),
            &identity,
            MAX_SCAN_BYTES,
        )
    })
    .await
    .map_err(|_| storage())?
}

fn recover_at(
    root: &Path,
    project_id: i64,
    current: Option<&str>,
    identity: &RegistryIdentity,
    byte_budget: u64,
) -> Result<Vec<RegistryPlan>, AppError> {
    let lock = lock(root)?;
    let _guard = lock.lock().map_err(|_| storage())?;
    if !root.try_exists().map_err(|_| storage())? {
        return Ok(Vec::new());
    }
    ensure_root(root)?;
    let mut plans = Vec::new();
    let mut processed_bytes = 0_u64;
    for (index, entry) in std::fs::read_dir(root).map_err(|_| storage())?.enumerate() {
        if index >= 10_000 {
            return Err(storage());
        }
        let name = entry.map_err(|_| storage())?.file_name();
        let Some(id) = name.to_str().and_then(|name| name.strip_suffix(".json")) else {
            continue;
        };
        if !valid_id(id) {
            return Err(storage());
        }
        // Journal writers hold this same project lock, so charge the bounded
        // record's on-disk size before allocating/parsing its documents.
        let record_bytes = entry_path_size(root, id)?;
        processed_bytes = processed_bytes
            .checked_add(record_bytes)
            .ok_or_else(budget_exceeded)?;
        if processed_bytes > byte_budget {
            return Err(budget_exceeded());
        }
        let stored = load(root, id)?.ok_or_else(storage)?;
        if stored.operation.project_id != project_id {
            return Err(storage());
        }
        if stored.operation.kind != super::super::PublicationOperationKind::Registry {
            continue;
        }
        // This named preflight failure plus absence of an intent proves the
        // worker never reached registry writes. It does not require recovery.
        if stored.confirmed_registry.is_none()
            && stored.operation.status == PublicationOperationStatus::Failed
            && stored.operation.error_code.as_deref() == Some("PUBLICATION_REGISTRY_PLAN_CHANGED")
        {
            continue;
        }
        // Old records contain no reviewed branch or documents. Even a fresh
        // preview must not erase that uncertainty and authorize a duplicate.
        if stored.confirmed_registry.is_none()
            && current == Some(id)
            && stored.operation.attempt == 1
            && super::super::runner::is_active(root, id)
        {
            continue;
        }
        let plan = stored.confirmed_registry.ok_or_else(legacy)?;
        if plan.preview.plugin_id == identity.plugin_id && plan.preview.version == identity.version
        {
            if plans.len() >= MAX_MATCHING_PLANS {
                return Err(budget_exceeded());
            }
            plans.push(plan);
        }
        // Unrelated full documents are dropped before reading the next record.
    }
    Ok(plans)
}

fn entry_path_size(root: &Path, id: &str) -> Result<u64, AppError> {
    let metadata = root
        .join(format!("{id}.json"))
        .symlink_metadata()
        .map_err(|_| storage())?;
    if !metadata.is_file() || metadata.file_type().is_symlink() || metadata.len() > MAX_RECORD_BYTES
    {
        return Err(storage());
    }
    Ok(metadata.len())
}

fn budget_exceeded() -> AppError {
    AppError::coded(axum::http::StatusCode::SERVICE_UNAVAILABLE,
        "PUBLICATION_REGISTRY_RECOVERY_BUDGET_EXCEEDED",
        "The registry recovery journal exceeds its bounded scan budget. No publication writes are permitted; reconcile the existing operations before retrying.")
}

pub(crate) async fn persist(project_id: i64, plan: RegistryPlan) -> Result<(), AppError> {
    let root = root(project_id).await?;
    tokio::task::spawn_blocking(move || persist_at(&root, plan))
        .await
        .map_err(|_| storage())?
}

fn persist_at(root: &Path, plan: RegistryPlan) -> Result<(), AppError> {
    let lock = lock(root)?;
    let _guard = lock.lock().map_err(|_| storage())?;
    let id = plan.preview.operation_id.clone();
    let mut stored = load(root, &id)?.ok_or_else(storage)?;
    validate(&plan, &stored.operation)?;
    if let Some(original) = &stored.confirmed_registry {
        if serde_json::to_vec(original).map_err(|_| storage())?
            != serde_json::to_vec(&plan).map_err(|_| storage())?
        {
            return Err(storage());
        }
        return Ok(());
    }
    if stored.operation.attempt != 1 {
        return Err(legacy());
    }
    stored.confirmed_registry = Some(plan);
    let bytes = serde_json::to_string(&stored).map_err(|_| storage())?;
    if bytes.len() as u64 > MAX_RECORD_BYTES {
        return Err(storage());
    }
    crate::shared::atomic_file::write_atomic_private(&root.join(format!("{id}.json")), &bytes)
        .map_err(|_| storage())
}

pub(super) fn validate(
    plan: &RegistryPlan,
    operation: &PublicationOperation,
) -> Result<(), AppError> {
    if operation.kind != super::super::PublicationOperationKind::Registry
        || plan.preview.operation_id != operation.operation_id
        || plan.preview.project_id != operation.project_id
        || plan.preview.plan_sha256 != operation.plan_sha256
        || plan.actor_id == 0
        || plan.repository_id == 0
    {
        return Err(storage());
    }
    Ok(())
}

fn legacy() -> AppError {
    AppError::coded(axum::http::StatusCode::CONFLICT,
        "PUBLICATION_REGISTRY_RECOVERY_REQUIRED",
        "A registry operation has no durable reviewed plan. Inspect its original remote branch and pull request before publishing; a new preview cannot safely retry it.")
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::domain::projects::publication_operations::{
        PublicationOperationKind, PublicationOperationStatus,
    };

    fn plan() -> RegistryPlan {
        let preview = serde_json::from_value(serde_json::json!({
            "operation_id": "a".repeat(64), "bundle_ids": [], "project_id": 7,
            "plugin_id": "acme", "version": "1.0.0", "bundle_id": "bundle",
            "release_notes": "notes", "account": "alice", "registry_repository": "merkr-software/cadencr-registry",
            "base_branch": "main", "base_commit": "b".repeat(40), "branch": "cadencr/original",
            "package_path": "packages/acme-1.0.0.json", "submission_path": "submissions/acme-1.0.0.json",
            "plan_sha256": "c".repeat(64)
        })).unwrap();
        RegistryPlan {
            preview,
            actor_id: 11,
            repository_id: 1,
            package: "package".into(),
            submission: "submission".into(),
            markdown: "body".into(),
        }
    }

    fn identity() -> RegistryIdentity {
        RegistryIdentity::builder()
            .plugin_id("acme".into())
            .version("1.0.0".into())
            .build()
    }

    fn operation() -> PublicationOperation {
        PublicationOperation {
            operation_id: "a".repeat(64),
            project_id: 7,
            kind: PublicationOperationKind::Registry,
            plan_sha256: "c".repeat(64),
            status: PublicationOperationStatus::Running,
            attempt: 1,
            created_at: chrono::Utc::now().to_rfc3339(),
            updated_at: chrono::Utc::now().to_rfc3339(),
            result: None,
            error: None,
            error_code: None,
        }
    }

    #[test]
    fn complete_original_plan_survives_restart_completion_and_retry() {
        let root = tempfile::tempdir().unwrap();
        let mut operation = operation();
        write(root.path(), &operation).unwrap();
        persist_at(root.path(), plan()).unwrap();
        let path = root.path().join(format!("{}.json", operation.operation_id));
        let mut stored: Stored = serde_json::from_slice(&std::fs::read(&path).unwrap()).unwrap();
        stored.boot_id = "previous-process".into();
        std::fs::write(&path, serde_json::to_vec(&stored).unwrap()).unwrap();
        operation = read(root.path(), &operation.operation_id).unwrap().unwrap();
        assert_eq!(operation.status, PublicationOperationStatus::Unknown);
        operation.attempt += 1;
        operation.status = PublicationOperationStatus::Running;
        write(root.path(), &operation).unwrap();
        let recovered = recover_at(root.path(), 7, None, &identity(), MAX_SCAN_BYTES).unwrap();
        assert_eq!(recovered.len(), 1);
        assert_eq!(
            serde_json::to_value(&recovered[0]).unwrap(),
            serde_json::to_value(plan()).unwrap()
        );
        persist_at(root.path(), recovered[0].clone()).unwrap();
        // Binding and documents cannot be replaced by a new preview.
        let mut changed = plan();
        changed.preview.branch = "cadencr/second".into();
        assert!(persist_at(root.path(), changed).is_err());
        let mut changed = plan();
        changed.package.push('!');
        assert!(persist_at(root.path(), changed).is_err());
    }

    #[test]
    fn older_registry_records_without_reviewed_intent_explicitly_fail_closed() {
        let root = tempfile::tempdir().unwrap();
        let mut operation = operation();
        operation.status = PublicationOperationStatus::Unknown;
        write(root.path(), &operation).unwrap();
        for current in [None, Some(operation.operation_id.as_str())] {
            assert!(matches!(
                recover_at(root.path(), 7, current, &identity(), MAX_SCAN_BYTES),
                Err(AppError::Coded {
                    code: "PUBLICATION_REGISTRY_RECOVERY_REQUIRED",
                    ..
                })
            ));
        }
        operation.attempt = 2;
        write(root.path(), &operation).unwrap();
        assert!(persist_at(root.path(), plan()).is_err());
    }
    fn write_fixture(
        root: &Path,
        index: u64,
        plugin_id: &str,
        version: &str,
        document_bytes: usize,
    ) {
        let mut operation = operation();
        operation.operation_id = format!("{index:064x}");
        let mut plan = plan();
        plan.preview.operation_id = operation.operation_id.clone();
        plan.preview.plugin_id = plugin_id.into();
        plan.preview.version = version.into();
        plan.package = "x".repeat(document_bytes);
        let stored = Stored {
            schema_version: 1,
            boot_id: boot_id().into(),
            operation,
            confirmed_registry: Some(plan),
        };
        let path = root.join(format!("{}.json", stored.operation.operation_id));
        crate::shared::atomic_file::write_atomic_private(
            &path,
            &serde_json::to_string(&stored).unwrap(),
        )
        .unwrap();
    }

    #[test]
    fn hundreds_of_unrelated_plans_are_scanned_but_not_retained() {
        let root = tempfile::tempdir().unwrap();
        write(root.path(), &operation()).unwrap();
        persist_at(root.path(), plan()).unwrap();
        for index in 0..300 {
            // Same plugin on other versions and other plugins on the same
            // version both count as unrelated, without skipping validation.
            let (plugin, version) = if index % 2 == 0 {
                ("acme", "0.9.0")
            } else {
                ("other", "1.0.0")
            };
            write_fixture(root.path(), index, plugin, version, 16 * 1024);
        }
        let matching = recover_at(root.path(), 7, None, &identity(), MAX_SCAN_BYTES).unwrap();
        assert_eq!(matching.len(), 1);
        assert_eq!(matching[0].preview.operation_id, "a".repeat(64));
        assert_eq!(matching[0].package, "package");
        // A legacy record cannot be filtered away: its missing intent might
        // describe the requested plugin/version, so recovery remains closed.
        let mut legacy = operation();
        legacy.operation_id = "f".repeat(64);
        write(root.path(), &legacy).unwrap();
        assert!(matches!(
            recover_at(root.path(), 7, None, &identity(), MAX_SCAN_BYTES),
            Err(AppError::Coded {
                code: "PUBLICATION_REGISTRY_RECOVERY_REQUIRED",
                ..
            })
        ));
    }

    #[test]
    fn scan_bytes_and_retained_matches_have_explicit_budgets() {
        let root = tempfile::tempdir().unwrap();
        write_fixture(root.path(), 1, "unrelated", "0.1.0", 1024);
        let record = root.path().join(format!("{:064x}.json", 1));
        let original = std::fs::read(&record).unwrap();
        assert!(matches!(
            recover_at(root.path(), 7, None, &identity(), original.len() as u64 - 1),
            Err(AppError::Coded {
                code: "PUBLICATION_REGISTRY_RECOVERY_BUDGET_EXCEEDED",
                ..
            })
        ));
        assert_eq!(std::fs::read(record).unwrap(), original);
        write_fixture(root.path(), 5, "also-unrelated", "0.1.0", 1024);
        let total =
            original.len() as u64 + entry_path_size(root.path(), &format!("{:064x}", 5)).unwrap();
        assert!(matches!(
            recover_at(root.path(), 7, None, &identity(), total - 1),
            Err(AppError::Coded {
                code: "PUBLICATION_REGISTRY_RECOVERY_BUDGET_EXCEEDED",
                ..
            })
        ));
        // Filtering is not a shortcut around ambiguity: matching full plans
        // also have a bounded retained set, regardless of the overall scan.
        for index in 2..=4 {
            write_fixture(root.path(), index, "acme", "1.0.0", 1024);
        }
        assert!(matches!(
            recover_at(root.path(), 7, None, &identity(), MAX_SCAN_BYTES),
            Err(AppError::Coded {
                code: "PUBLICATION_REGISTRY_RECOVERY_BUDGET_EXCEEDED",
                ..
            })
        ));
    }
}
