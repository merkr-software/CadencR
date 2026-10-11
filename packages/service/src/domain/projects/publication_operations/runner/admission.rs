use super::{
    active, is_active, journal, Active, PublicationOperation, PublicationOperationKind,
    PublicationOperationStatus,
};
use crate::error::AppError;
use std::path::Path;

pub(super) fn begin(
    root: &Path,
    project_id: i64,
    kind: PublicationOperationKind,
    id: &str,
    plan_sha256: String,
) -> Result<(PublicationOperation, Option<Active>), AppError> {
    let _lock = journal::lock().lock().map_err(|_| journal::storage())?;
    let prior = journal::read(root, id)?;
    if let Some(prior) = &prior {
        if prior.project_id != project_id || prior.kind != kind || prior.plan_sha256 != plan_sha256
        {
            return Err(journal::storage());
        }
        if prior.status == PublicationOperationStatus::Succeeded {
            return Ok((prior.clone(), None));
        }
        if is_active(root, id) {
            return Err(AppError::coded(axum::http::StatusCode::CONFLICT, "PUBLICATION_OPERATION_RUNNING", format!("Publication operation {id} is already running. Query its status instead of starting another.")));
        }
    }
    journal::ensure_root(root)?;
    if prior.is_none()
        && std::fs::read_dir(root)
            .map_err(|_| journal::storage())?
            .take(10_001)
            .collect::<Result<Vec<_>, _>>()
            .map_err(|_| journal::storage())?
            .len()
            >= 10_000
    {
        return Err(journal::storage());
    }
    let now = chrono::Utc::now().to_rfc3339();
    let mut operation = PublicationOperation {
        operation_id: id.into(),
        project_id,
        kind,
        plan_sha256,
        status: PublicationOperationStatus::Pending,
        attempt: prior
            .as_ref()
            .map_or(1, |value| value.attempt.saturating_add(1)),
        created_at: prior.map_or_else(|| now.clone(), |value| value.created_at),
        updated_at: now,
        result: None,
        error_code: None,
        error: None,
    };
    let path = root.join(id);
    active()
        .lock()
        .map_err(|_| journal::storage())?
        .insert(path.clone());
    let guard = Active(path);
    journal::write(root, &operation)?;
    operation.status = PublicationOperationStatus::Running;
    journal::write(root, &operation)?;
    Ok((operation, Some(guard)))
}

pub(super) fn classify(error: &AppError) -> (PublicationOperationStatus, String) {
    let code = match error {
        AppError::Coded { code, .. } => *code,
        _ => "PUBLICATION_OPERATION_UNKNOWN",
    };
    // Only named local admission/plan checks prove no mutation was attempted.
    // Final remote tag mismatch can happen after writes, so remains unknown.
    let definitive = matches!(
        code,
        "PUBLICATION_RELEASE_PLAN_CHANGED"
            | "PUBLICATION_REGISTRY_PLAN_CHANGED"
            | "PUBLICATION_RELEASE_BUSY"
    );
    (
        if definitive {
            PublicationOperationStatus::Failed
        } else {
            PublicationOperationStatus::Unknown
        },
        code.into(),
    )
}
