//! Offline language-server packing and validation, plus domain-bound policy tools.
use crate::{operation_error, output, Diagnostic};
use cadencr_registry_core::{LspDescriptor, LspRuntime, PolicyKind};
use clap::{Subcommand, ValueEnum};
use std::path::{Path, PathBuf};

#[derive(Debug, Clone, Copy, ValueEnum)]
pub(crate) enum Runtime {
    Native,
    Node,
}
impl Runtime {
    fn core(self) -> LspRuntime {
        match self {
            Self::Native => LspRuntime::Native,
            Self::Node => LspRuntime::Node,
        }
    }
}
#[derive(Debug, Subcommand)]
pub(crate) enum LspCommand {
    /// Pack a prepared native executable or Node bundle; executes no code or installers.
    PackLsp {
        #[arg(long)]
        directory: PathBuf,
        #[arg(long)]
        target: String,
        #[arg(long)]
        entry: String,
        #[arg(long, value_enum)]
        runtime: Runtime,
        #[arg(long)]
        output: PathBuf,
    },
    /// Sign a domain-bound language-server revocation policy.
    SignLspBlocklist {
        #[arg(long)]
        payload: PathBuf,
        #[arg(long)]
        private_key: PathBuf,
        #[arg(long)]
        key_id: String,
        #[arg(long)]
        output: PathBuf,
    },
    /// Verify a domain-bound language-server revocation policy.
    VerifyLspBlocklist {
        #[arg(long)]
        index: PathBuf,
        #[arg(long)]
        public_key: PathBuf,
        #[arg(long)]
        key_id: String,
        #[arg(long)]
        allow_expired: bool,
    },
}
pub(crate) fn run(command: &LspCommand) -> Result<Option<String>, Diagnostic> {
    match command {
        LspCommand::PackLsp {
            directory,
            target,
            entry,
            runtime,
            output: destination,
        } => {
            let packed = cadencr_registry_core::pack_lsp(
                cadencr_registry_core::PackLspRequest::builder()
                    .directory(directory)
                    .target(target)
                    .entry(entry)
                    .runtime(runtime.core())
                    .output(destination)
                    .build(),
            )
            .map_err(|e| operation_error("LSP_PACKAGING_FAILED", e))?;
            let mut receipt = serde_json::to_value(packed)
                .map_err(|e| operation_error("LSP_PACKAGING_FAILED", e))?;
            receipt["kind"] = serde_json::json!("lsp");
            output::write_receipt(&receipt, "LSP_PACKAGING_FAILED")
        }
        LspCommand::SignLspBlocklist {
            payload,
            private_key,
            key_id,
            output,
        } => crate::signing::sign_blocklist(PolicyKind::Lsp, payload, private_key, key_id, output),
        LspCommand::VerifyLspBlocklist {
            index,
            public_key,
            key_id,
            allow_expired,
        } => crate::signing::verify_blocklist(
            PolicyKind::Lsp,
            index,
            public_key,
            key_id,
            *allow_expired,
        ),
    }
}
pub(crate) fn validate(
    folder: &Path,
    descriptor: Option<&Path>,
) -> Result<Option<String>, Diagnostic> {
    if descriptor.is_some() {
        return Err(operation_error(
            "LSP_VALIDATION_FAILED",
            "LSP members declare their signed package in lsp.json",
        ));
    }
    validate_folder(folder).map(|(_, message)| Some(message))
}
pub(crate) fn validate_folder(folder: &Path) -> Result<(LspDescriptor, String), Diagnostic> {
    let metadata = std::fs::symlink_metadata(folder)
        .map_err(|e| operation_error("LSP_VALIDATION_FAILED", e))?;
    if !metadata.is_dir() || metadata.file_type().is_symlink() {
        return Err(operation_error(
            "LSP_VALIDATION_FAILED",
            "LSP folder must be a real directory",
        ));
    }
    let bytes = cadencr_plugin_core::read_regular_bounded(&folder.join("lsp.json"), 1024 * 1024)
        .map_err(|e| operation_error("LSP_VALIDATION_FAILED", e))?;
    let value = cadencr_registry_core::parse_json_bytes(&bytes)
        .map_err(|e| operation_error("LSP_VALIDATION_FAILED", e))?;
    let parsed = cadencr_registry_core::parse_marketplace_package(&value)
        .map_err(|e| operation_error("LSP_VALIDATION_FAILED", e))?;
    let cadencr_registry_core::MarketplacePackage::Lsp(package) = parsed else {
        return Err(operation_error(
            "LSP_VALIDATION_FAILED",
            "lsp.json must declare kind lsp",
        ));
    };
    for (platform, target) in &package.lsp.distribution.binary {
        let path = folder.join(&target.entry);
        let metadata = std::fs::symlink_metadata(&path)
            .map_err(|e| operation_error("LSP_VALIDATION_FAILED", e))?;
        if !metadata.is_file()
            || metadata.file_type().is_symlink()
            || path
                .canonicalize()
                .map_err(|e| operation_error("LSP_VALIDATION_FAILED", e))?
                != folder
                    .canonicalize()
                    .map_err(|e| operation_error("LSP_VALIDATION_FAILED", e))?
                    .join(&target.entry)
        {
            return Err(operation_error(
                "LSP_VALIDATION_FAILED",
                "entry must be a regular file reached without symlinks",
            ));
        }
        let bytes = cadencr_plugin_core::read_regular_bounded(
            &path,
            cadencr_registry_core::MAX_LSP_UNCOMPRESSED_BYTES,
        )
        .map_err(|e| operation_error("LSP_VALIDATION_FAILED", e))?;
        cadencr_registry_core::validate_lsp_entry(&bytes, platform, target)
            .map_err(|e| operation_error("LSP_VALIDATION_FAILED", e))?;
    }
    let message = format!(
        "valid language-server metadata: {} {} ({})",
        package.lsp.id,
        package.lsp.version,
        folder.display()
    );
    Ok((package.lsp, message))
}
