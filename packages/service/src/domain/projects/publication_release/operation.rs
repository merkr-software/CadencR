use super::{
    coded, operation_timeout, permit, publish_prepared, PublishPublicationReleaseRequest,
    PublishedProviderRelease,
};
use crate::{app_state::AppState, error::AppError};
use axum::Json;

pub(super) async fn publish(
    state: AppState,
    project_id: i64,
    body: PublishPublicationReleaseRequest,
) -> Result<Json<PublishedProviderRelease>, AppError> {
    let operation_id = super::super::publication_operations::operation_id()
        .project_id(project_id)
        .kind(super::super::publication_operations::PublicationOperationKind::Release)
        .bundle_id(&body.bundle_id)
        .bundle_ids(&body.bundle_ids)
        .release_notes(&body.release_notes)
        .plan_sha256(&body.expected_plan_sha256)
        .call()?;
    if body
        .operation_id
        .as_ref()
        .is_some_and(|expected| expected != &operation_id)
    {
        return Err(coded(
            "PUBLICATION_OPERATION_BINDING_CHANGED",
            "confirmed operation contents changed; preview again",
        ));
    }
    let plan_sha256 = body.expected_plan_sha256.clone();
    let result = super::super::publication_operations::execute()
        .project_id(project_id)
        .kind(super::super::publication_operations::PublicationOperationKind::Release)
        .operation_id(operation_id)
        .plan_sha256(plan_sha256)
        .job(Box::pin(async move {
            operation_timeout(Box::pin(publish_prepared(
                &state,
                project_id,
                body,
                permit()?,
            )))
            .await
            .map(|Json(value)| {
                super::super::publication_operations::PublicationOperationResult::Release(value)
            })
        }))
        .call()
        .await?;
    match result {
        super::super::publication_operations::PublicationOperationResult::Release(value) => {
            Ok(Json(value))
        }
        _ => Err(AppError::Internal(
            "publication operation kind mismatch".into(),
        )),
    }
}
