use crate::args::{MirrorArgs, PromoteArgs};
use crate::{operation_error, Diagnostic};

const MIRROR_FAILED: &str = "REGISTRY_MIRROR_FAILED";
const PROMOTION_FAILED: &str = "REGISTRY_PROMOTION_FAILED";

pub(crate) fn mirror(args: &MirrorArgs) -> Result<Option<String>, Diagnostic> {
    preflight(args, MIRROR_FAILED)?;
    let token = publication_token(MIRROR_FAILED)?;
    let receipt = cadencr_registry_publisher::mirror_publication(
        cadencr_registry_publisher::MirrorRequest::builder()
            .submission(&args.submission)
            .repository(&args.repository)
            .registry_commit(&args.registry_commit)
            .directory(&args.directory)
            .token(&token)
            .build(),
    )
    .map_err(|error| operation_error(MIRROR_FAILED, error))?;
    Ok(Some(format!(
        "verified draft release: {}",
        receipt.release_tag
    )))
}

pub(crate) fn promote(args: &PromoteArgs) -> Result<Option<String>, Diagnostic> {
    let publication = &args.publication;
    let plan = preflight(publication, PROMOTION_FAILED)?;
    if plan["release"]["tag"].as_str() != Some(args.confirm_publish.as_str()) {
        return Err(operation_error(
            PROMOTION_FAILED,
            "publish confirmation must exactly match the planned release tag",
        ));
    }
    let token = publication_token(PROMOTION_FAILED)?;
    let receipt = cadencr_registry_publisher::promote_publication(
        cadencr_registry_publisher::PromoteRequest::builder()
            .submission(&publication.submission)
            .repository(&publication.repository)
            .registry_commit(&publication.registry_commit)
            .expected_release_tag(&args.confirm_publish)
            .directory(&publication.directory)
            .token(&token)
            .build(),
    )
    .map_err(|error| operation_error(PROMOTION_FAILED, error))?;
    Ok(Some(format!(
        "published and verified release: {}",
        receipt.release_tag
    )))
}

fn preflight(args: &MirrorArgs, code: &'static str) -> Result<serde_json::Value, Diagnostic> {
    if args.confirm_repository != args.repository {
        return Err(operation_error(
            code,
            "repository confirmation does not match",
        ));
    }
    cadencr_registry_publisher::validate_registry_commit(&args.registry_commit)
        .map_err(|error| operation_error(code, error))?;
    // Local policy and explicit confirmations precede access to credentials.
    cadencr_registry_core::create_publication_plan_from_file(&args.submission, &args.repository)
        .map_err(|error| operation_error(code, error))
}

fn publication_token(code: &'static str) -> Result<String, Diagnostic> {
    std::env::var("CADENCR_REGISTRY_GITHUB_TOKEN")
        .map_err(|_| operation_error(code, "CADENCR_REGISTRY_GITHUB_TOKEN is required"))
}
