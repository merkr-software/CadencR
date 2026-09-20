//! Shared local-provider descriptor contract.
//!
//! The implementation lives in `cadencr-plugin-core` so the service, headless
//! CLI, and registry tooling cannot drift onto separate validation rules.

pub use cadencr_plugin_core::{
    current_binary_target, validate_provider_id, AcpAgentEntry, AcpBinaryTarget, AcpDistribution,
    AcpPackageDistribution, HostInstallationSpec, LocalAssetsSpec, LocalExecutableSpec,
    ProviderDescriptor, ACP_BINARY_TARGETS, SUPPORTED_SCHEMA_VERSION,
};
