//! Offline language-server packing and validation, plus domain-bound policy tools.
use crate::{operation_error, output, Diagnostic};
use cadencr_registry_core::{LspRuntime, PolicyKind};
use clap::{Subcommand, ValueEnum};
use std::path::PathBuf;

mod validation;
pub(crate) use validation::{validate, validate_folder};

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
