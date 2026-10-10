use crate::args::PublishRegistryArgs;
use crate::{operation_error, Diagnostic};

pub(crate) fn publish(args: &PublishRegistryArgs) -> Result<Option<String>, Diagnostic> {
    const CODE: &str = "REGISTRY_PIPELINE_FAILED";
    // The request binds repository, baseline, signing key, discovery branch,
    // dates and every publication. Confirmation/local policy precede secrets.
    let prepared = cadencr_registry_publisher::prepare_registry_publication(
        cadencr_registry_publisher::PipelineRequest::builder()
            .request(&args.request)
            .directory(&args.directory)
            .repository(&args.repository)
            .registry_commit(&args.registry_commit)
            .private_key(&args.private_key)
            .confirm_request_sha256(&args.confirm_request_sha256)
            .build(),
    )
    .map_err(|error| operation_error(CODE, error))?;
    let token = std::env::var("CADENCR_REGISTRY_GITHUB_TOKEN")
        .map_err(|_| operation_error(CODE, "CADENCR_REGISTRY_GITHUB_TOKEN is required"))?;
    let receipt = cadencr_registry_publisher::publish_registry(prepared, &token)
        .map_err(|error| operation_error(CODE, error))?;
    Ok(Some(format!(
        "registry publication and public discovery verified: {} ({})",
        receipt.catalog.release_tag, receipt.discovery.branch
    )))
}
