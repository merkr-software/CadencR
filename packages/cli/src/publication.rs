use crate::args::{
    AdvanceCatalogArgs, MirrorArgs, PromoteArgs, PublishCatalogArgs, RecoverArgs, RestoreArgs,
};
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

fn prepare_catalog(
    args: &PublishCatalogArgs,
    code: &'static str,
) -> Result<cadencr_registry_core::CatalogSnapshot, Diagnostic> {
    if args.confirm_repository != args.repository {
        return Err(operation_error(
            code,
            "repository confirmation does not match",
        ));
    }
    let previous = if args.previous_index == "bootstrap" {
        cadencr_registry_core::PreviousCatalog::Bootstrap
    } else {
        cadencr_registry_core::PreviousCatalog::File(std::path::Path::new(&args.previous_index))
    };
    let snapshot = cadencr_registry_core::prepare_catalog_snapshot()
        .catalog_file(&args.catalog)
        .previous(previous)
        .public_key_file(&args.public_key)
        .key_id(&args.key_id)
        .repository(&args.repository)
        .registry_commit(&args.registry_commit)
        .call()
        .map_err(|error| operation_error(code, error))?;
    cadencr_registry_publisher::preflight_catalog_publication(
        &snapshot,
        &args.manifest,
        &args.directory,
    )
    .map_err(|error| operation_error(code, error))?;
    if args.confirm_publish != snapshot.tag() {
        return Err(operation_error(
            code,
            "publish confirmation must exactly match the catalog tag",
        ));
    }
    Ok(snapshot)
}

pub(crate) fn publish_catalog(args: &PublishCatalogArgs) -> Result<Option<String>, Diagnostic> {
    const CODE: &str = "REGISTRY_CATALOG_PUBLICATION_FAILED";
    let snapshot = prepare_catalog(args, CODE)?;
    let token = publication_token(CODE)?;
    let receipt = cadencr_registry_publisher::publish_catalog(
        cadencr_registry_publisher::PublishCatalogRequest::builder()
            .snapshot(&snapshot)
            .manifest(&args.manifest)
            .directory(&args.directory)
            .token(&token)
            .build(),
    )
    .map_err(|error| operation_error(CODE, error))?;
    Ok(Some(format!(
        "published and verified catalog: {}",
        receipt.release_tag
    )))
}

pub(crate) fn advance_catalog(args: &AdvanceCatalogArgs) -> Result<Option<String>, Diagnostic> {
    const CODE: &str = "REGISTRY_CATALOG_DISCOVERY_FAILED";
    cadencr_registry_core::validate_discovery_branch(&args.discovery_branch)
        .map_err(|error| operation_error(CODE, error))?;
    let snapshot = prepare_catalog(&args.catalog, CODE)?;
    let expected_url =
        cadencr_registry_core::discovery_url(snapshot.repository(), &args.discovery_branch)
            .map_err(|error| operation_error(CODE, error))?;
    if args.confirm_discovery != expected_url {
        return Err(operation_error(
            CODE,
            "discovery confirmation must exactly match the raw discovery URL",
        ));
    }
    cadencr_registry_publisher::preflight_catalog_discovery(
        &snapshot,
        &args.catalog.manifest,
        &args.catalog.directory,
        &args.discovery_branch,
    )
    .map_err(|error| operation_error(CODE, error))?;
    let token = publication_token(CODE)?;
    let receipt = cadencr_registry_publisher::advance_catalog(
        cadencr_registry_publisher::AdvanceCatalogRequest::builder()
            .snapshot(&snapshot)
            .manifest(&args.catalog.manifest)
            .directory(&args.catalog.directory)
            .discovery_branch(&args.discovery_branch)
            .token(&token)
            .build(),
    )
    .map_err(|error| operation_error(CODE, error))?;
    Ok(Some(format!(
        "advanced discovery {} to {}",
        receipt.branch, receipt.snapshot_sha256
    )))
}

pub(crate) fn recover(args: &RecoverArgs) -> Result<Option<String>, Diagnostic> {
    const CODE: &str = "REGISTRY_PUBLICATION_RECOVERY_FAILED";
    let publication = &args.publication;
    let plan = preflight(publication, CODE)?;
    if plan["release"]["tag"].as_str() != Some(args.confirm_recover.as_str()) {
        return Err(operation_error(
            CODE,
            "recovery confirmation must exactly match the planned release tag",
        ));
    }
    let token = publication_token(CODE)?;
    let receipt = cadencr_registry_publisher::recover_publication(
        cadencr_registry_publisher::RecoverRequest::builder()
            .submission(&publication.submission)
            .repository(&publication.repository)
            .registry_commit(&publication.registry_commit)
            .expected_release_tag(&args.confirm_recover)
            .directory(&publication.directory)
            .token(&token)
            .build(),
    )
    .map_err(|error| operation_error(CODE, error))?;
    Ok(Some(format!(
        "verified published release; local mirror proof recovered: {}",
        receipt.release_tag
    )))
}

pub(crate) fn restore(args: &RestoreArgs) -> Result<Option<String>, Diagnostic> {
    const CODE: &str = "REGISTRY_PUBLICATION_RESTORE_FAILED";
    let publication = &args.publication;
    let plan = preflight(publication, CODE)?;
    if plan["release"]["tag"].as_str() != Some(args.confirm_restore.as_str()) {
        return Err(operation_error(
            CODE,
            "restore confirmation must exactly match the planned release tag",
        ));
    }
    let token = publication_token(CODE)?;
    let receipt = cadencr_registry_publisher::restore_publication(
        cadencr_registry_publisher::RestoreRequest::builder()
            .submission(&publication.submission)
            .repository(&publication.repository)
            .registry_commit(&publication.registry_commit)
            .expected_release_tag(&args.confirm_restore)
            .directory(&publication.directory)
            .token(&token)
            .build(),
    )
    .map_err(|error| operation_error(CODE, error))?;
    Ok(Some(format!(
        "restored and verified published release: {}",
        receipt.release_tag
    )))
}
