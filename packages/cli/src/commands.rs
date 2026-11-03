use std::path::Path;

use serde_json::json;

use crate::args::{Cli, Command, PluginArgs, PluginCommand, PluginKind, RegistryCommand};
use crate::{operation_error, output, signing, Diagnostic};

pub(crate) fn run(cli: &Cli) -> Result<Option<String>, Diagnostic> {
    match &cli.command {
        Command::Plugin(PluginArgs {
            command: PluginCommand::InspectRelease { request, directory },
        }) => crate::author_release::run(request, directory, None),
        Command::Plugin(PluginArgs {
            command:
                PluginCommand::PublishRelease {
                    request,
                    directory,
                    confirm_request_sha256,
                },
        }) => crate::author_release::run(request, directory, Some(confirm_request_sha256)),
        Command::Plugin(PluginArgs {
            command:
                PluginCommand::Validate {
                    folder,
                    descriptor,
                    kind,
                    no_run,
                },
        }) => match kind {
            PluginKind::Provider => validate_provider(folder, descriptor.as_deref()),
            PluginKind::Lsp => crate::lsp::validate(folder, descriptor.as_deref()),
            PluginKind::Theme => crate::theme::validate(folder, descriptor.as_deref()),
            PluginKind::Tab => crate::tab::validate(folder, descriptor.as_deref(), !no_run),
            PluginKind::Plugin => crate::plugin::validate(folder, descriptor.as_deref(), !no_run),
        },
        Command::Registry(registry) => run_registry(&registry.command),
    }
}

/// `cadencr plugin validate <folder> --kind provider --descriptor <file>`.
fn validate_provider(
    folder: &Path,
    descriptor: Option<&Path>,
) -> Result<Option<String>, Diagnostic> {
    let descriptor = descriptor.ok_or_else(|| {
        operation_error(
            "PLUGIN_DESCRIPTOR_REQUIRED",
            "provider validation requires --descriptor",
        )
    })?;
    validate_provider_folder(folder, descriptor).map(|_| Some(provider_message(folder)))
}

/// The local provider-structure check, for `--kind plugin` members too.
pub(crate) fn validate_provider_folder(
    folder: &Path,
    descriptor: &Path,
) -> Result<cadencr_plugin_core::ValidatedPluginFolder, Diagnostic> {
    cadencr_plugin_core::validate_plugin_folder(folder, descriptor).map_err(|error| Diagnostic {
        code: error.code(),
        message: error.to_string(),
        exit_code: 1,
    })
}

pub(crate) fn provider_message(folder: &Path) -> String {
    format!(
        "valid local provider structure: {} (publication completeness and theme assets not checked)",
        folder.display()
    )
}

fn run_registry(command: &RegistryCommand) -> Result<Option<String>, Diagnostic> {
    match command {
        RegistryCommand::Diagnostics(command) => crate::metadata::run(command),
        RegistryCommand::Lsp(command) => crate::lsp::run(command),
        RegistryCommand::TabBackend(command) => crate::tab_backend::run(command),
        RegistryCommand::Policy(command) => crate::policy::run(command),
        RegistryCommand::Validate { base, candidate } => validate_registry(base, candidate),
        RegistryCommand::BuildIndex {
            schema_version,
            packages,
            generated_at,
            expires_at,
            output: destination,
        } => build_index(
            packages,
            *schema_version,
            generated_at,
            expires_at,
            destination.as_deref(),
        ),
        RegistryCommand::PackProvider {
            package,
            target,
            directory,
            output: destination,
        } => pack_provider(package, target, directory, destination),
        RegistryCommand::PackTheme { directory, output } => crate::theme::pack(directory, output),
        RegistryCommand::PackTab {
            directory,
            package,
            output,
        } => crate::tab::pack(
            cadencr_registry_core::PackTabRequest::builder()
                .directory(directory)
                .output(output)
                .maybe_package(package.as_deref())
                .build(),
        ),
        RegistryCommand::PlanPublication {
            submission,
            repository,
            output: destination,
        } => plan_publication(submission, repository, destination),
        RegistryCommand::StagePublication {
            submission,
            repository,
            directory,
        } => stage_publication(submission, repository, directory),
        RegistryCommand::MirrorPublication(args) => crate::publication::mirror(args),
        RegistryCommand::PromotePublication(args) => crate::publication::promote(args),
        RegistryCommand::RecoverPublication(args) => crate::publication::recover(args),
        RegistryCommand::RestorePublication(args) => crate::publication::restore(args),
        RegistryCommand::SignPublicationCatalog(args) => signing::catalog(args),
        RegistryCommand::PublishCatalog(args) => crate::publication::publish_catalog(args),
        RegistryCommand::PublishRegistry(args) => crate::pipeline::publish(args),
        RegistryCommand::AdvanceCatalog(args) => crate::publication::advance_catalog(args),
        RegistryCommand::SignIndex {
            payload,
            private_key,
            key_id,
            output,
        } => signing::sign(payload, private_key, key_id, output),
        RegistryCommand::VerifyIndex {
            index,
            public_key,
            key_id,
            allow_expired,
        } => signing::verify(index, public_key, key_id, *allow_expired),
        RegistryCommand::SignTrustManifest {
            payload,
            root_private_key,
            root_key_id,
            output,
        } => crate::trust::sign(payload, root_private_key, root_key_id, output),
        RegistryCommand::VerifyTrustManifest {
            manifest,
            root_public_key,
            root_key_id,
            minimum_generation,
        } => crate::trust::verify(manifest, root_public_key, root_key_id, *minimum_generation),
        RegistryCommand::AssembleSignedIndex {
            payload,
            signature,
            output,
        } => signing::assemble(payload, signature, output),
    }
}

fn validate_registry(base: &Path, candidate: &Path) -> Result<Option<String>, Diagnostic> {
    cadencr_registry_core::validate_contribution(base, candidate)
        .map(|()| {
            Some(format!(
                "valid registry contribution: {}",
                candidate.display()
            ))
        })
        .map_err(|error| operation_error("REGISTRY_VALIDATION_FAILED", error))
}

fn build_index(
    packages: &Path,
    schema_version: u64,
    generated_at: &str,
    expires_at: &str,
    destination: Option<&Path>,
) -> Result<Option<String>, Diagnostic> {
    let bytes = cadencr_registry_core::build_index()
        .packages_dir(packages)
        .schema_version(schema_version)
        .generated_at(generated_at)
        .expires_at(expires_at)
        .call()
        .map_err(|error| operation_error("REGISTRY_INDEX_FAILED", error))?;
    output::write_bytes(&bytes, destination)?;
    Ok(destination.map(|path| format!("wrote registry index: {}", path.display())))
}

fn pack_provider(
    package: &Path,
    target: &str,
    directory: &Path,
    destination: &Path,
) -> Result<Option<String>, Diagnostic> {
    let packed = cadencr_registry_core::pack_provider(
        cadencr_registry_core::PackProviderRequest::builder()
            .package(package)
            .target(target)
            .directory(directory)
            .output(destination)
            .build(),
    )
    .map_err(|error| operation_error("REGISTRY_PACKAGING_FAILED", error))?;
    output::write_receipt(
        &json!({
            "target": packed.target, "archive": packed.archive,
            "sha256": packed.sha256, "size": packed.size,
        }),
        "REGISTRY_PACKAGING_FAILED",
    )
}

fn plan_publication(
    submission: &Path,
    repository: &str,
    destination: &Path,
) -> Result<Option<String>, Diagnostic> {
    let plan = cadencr_registry_core::create_publication_plan_from_file(submission, repository)
        .map_err(|error| operation_error("PUBLICATION_PLAN_FAILED", error))?;
    output::write_json_file(&plan, destination, "PUBLICATION_PLAN_FAILED")?;
    Ok(Some(format!("publication plan: {}", destination.display())))
}

fn stage_publication(
    submission: &Path,
    repository: &str,
    directory: &Path,
) -> Result<Option<String>, Diagnostic> {
    let receipt = cadencr_registry_publisher::stage_publication(
        cadencr_registry_publisher::StageRequest::builder()
            .submission(submission)
            .repository(repository)
            .directory(directory)
            .build(),
    )
    .map_err(|error| operation_error("REGISTRY_PUBLICATION_STAGING_FAILED", error))?;
    Ok(Some(format!(
        "staged {} verified publication artifacts",
        receipt.artifacts.len()
    )))
}
