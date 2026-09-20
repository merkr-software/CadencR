use crate::args::MirrorArgs;
use crate::{operation_error, Diagnostic};

const MIRROR_FAILED: &str = "REGISTRY_MIRROR_FAILED";

pub(crate) fn mirror(args: &MirrorArgs) -> Result<Option<String>, Diagnostic> {
    if args.confirm_repository != args.repository {
        return Err(operation_error(
            MIRROR_FAILED,
            "repository confirmation does not match",
        ));
    }
    cadencr_registry_publisher::validate_registry_commit(&args.registry_commit)
        .map_err(|error| operation_error(MIRROR_FAILED, error))?;
    // Local policy is evaluated before asking for publication credentials.
    cadencr_registry_core::create_publication_plan_from_file(&args.submission, &args.repository)
        .map_err(|error| operation_error(MIRROR_FAILED, error))?;
    let token = std::env::var("CADENCR_REGISTRY_GITHUB_TOKEN")
        .map_err(|_| operation_error(MIRROR_FAILED, "CADENCR_REGISTRY_GITHUB_TOKEN is required"))?;
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
