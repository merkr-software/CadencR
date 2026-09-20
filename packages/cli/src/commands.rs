use std::io::{self, Write as _};
use std::path::Path;

use serde_json::json;

use crate::args::{Cli, Command, PluginArgs, PluginCommand, RegistryCommand};
use crate::{operation_error, output, signing, Diagnostic};

pub(crate) fn run(cli: &Cli) -> Result<Option<String>, Diagnostic> {
    match &cli.command {
        Command::Plugin(PluginArgs {
            command: PluginCommand::Validate { folder, descriptor },
        }) => validate_plugin(folder, descriptor),
        Command::Registry(registry) => run_registry(&registry.command),
    }
}

fn run_registry(command: &RegistryCommand) -> Result<Option<String>, Diagnostic> {
    match command {
        RegistryCommand::Validate { base, candidate } => validate_registry(base, candidate),
        RegistryCommand::BuildIndex {
            packages,
            generated_at,
            expires_at,
            output: destination,
        } => build_index(packages, generated_at, expires_at, destination.as_deref()),
        RegistryCommand::PackProvider {
            package,
            target,
            directory,
            output: destination,
        } => pack_provider(package, target, directory, destination),
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
        RegistryCommand::SignPublicationCatalog(args) => signing::catalog(args),
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
        RegistryCommand::AssembleSignedIndex {
            payload,
            signature,
            output,
        } => signing::assemble(payload, signature, output),
    }
}

fn validate_plugin(folder: &Path, descriptor: &Path) -> Result<Option<String>, Diagnostic> {
    cadencr_plugin_core::validate_plugin_folder(folder, descriptor)
        .map(|_| Some(format!("valid local provider structure: {} (publication completeness and theme assets not checked)", folder.display())))
        .map_err(|error| Diagnostic {
            code: error.code(),
            message: error.to_string(),
            exit_code: 1,
        })
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
    generated_at: &str,
    expires_at: &str,
    destination: Option<&Path>,
) -> Result<Option<String>, Diagnostic> {
    let bytes = cadencr_registry_core::build_index()
        .packages_dir(packages)
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
    let mut receipt = serde_json::to_vec(&json!({
        "target": packed.target, "archive": packed.archive,
        "sha256": packed.sha256, "size": packed.size,
    }))
    .map_err(|error| operation_error("REGISTRY_PACKAGING_FAILED", error))?;
    receipt.push(b'\n');
    output::write_stdout(&receipt, &mut io::stdout().lock())?;
    Ok(None)
}

fn plan_publication(
    submission: &Path,
    repository: &str,
    destination: &Path,
) -> Result<Option<String>, Diagnostic> {
    let plan = cadencr_registry_core::create_publication_plan_from_file(submission, repository)
        .map_err(|error| operation_error("PUBLICATION_PLAN_FAILED", error))?;
    let mut bytes = serde_json::to_vec_pretty(&plan)
        .map_err(|error| operation_error("PUBLICATION_PLAN_FAILED", error))?;
    bytes.push(b'\n');
    output::publish(destination, |temporary| {
        temporary.write_all(&bytes)?;
        temporary.flush()
    })?;
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
