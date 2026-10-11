//! Shared, side-effect-free contracts for inspecting Cadencr provider plugins.
//!
//! Validation reads bounded local files but never executes provider code. This
//! contracts support provider and declarative theme content. Validation does
//! not constitute publication approval.

pub mod theme;

mod descriptor;
mod error;
mod folder;

pub use descriptor::{
    current_binary_target, validate_provider_id, AcpAgentEntry, AcpBinaryTarget, AcpDistribution,
    AcpPackageDistribution, HostInstallationSpec, LocalAssetsSpec, LocalExecutableSpec,
    ProviderDescriptor, ACP_BINARY_TARGETS, SUPPORTED_SCHEMA_VERSION,
};
pub use error::{DescriptorError, PluginValidationError, RejectionCode};
pub use folder::{validate_plugin_folder, ValidatedPluginFolder};
