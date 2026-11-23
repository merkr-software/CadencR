//! Host metadata a provider registration carries next to its adapter.

use std::borrow::Cow;
use std::path::PathBuf;
use std::sync::Arc;

use cli_discovery::DiscoverySpec;

use crate::domain::agents::extensions::ExtensionCli;
use crate::domain::agents::relocation::ProviderRelocator;
use crate::domain::agents::updates::ProviderUpdater;

/// Optional host discovery metadata owned by one provider registration.
#[derive(Clone, Debug)]
pub struct ProviderDiscoveryMetadata {
    pub(super) discovery_id: Cow<'static, str>,
    pub(super) setting_key: Cow<'static, str>,
    pub(super) spec: DiscoverySpec,
    pub(super) apply_override: fn(Option<PathBuf>),
}

impl ProviderDiscoveryMetadata {
    pub fn discovery_id(&self) -> &str {
        &self.discovery_id
    }

    pub fn setting_key(&self) -> &str {
        &self.setting_key
    }

    pub fn spec(&self) -> &DiscoverySpec {
        &self.spec
    }

    pub fn apply_override(&self, path: Option<PathBuf>) {
        (self.apply_override)(path);
    }
}

/// Provider-owned metadata consumed generically by shared host services.
#[derive(Clone, Debug, Default)]
pub struct ProviderRegistrationMetadata {
    pub(super) aliases: Vec<Cow<'static, str>>,
    pub(super) model_guidance: Option<Cow<'static, str>>,
    pub(super) discovery: Option<ProviderDiscoveryMetadata>,
    /// Version detection and self-update, when the provider manages it.
    pub(super) updater: Option<Arc<dyn ProviderUpdater>>,
    /// Skills and MCP servers managed through the provider's own CLI.
    pub(super) extensions: Option<Arc<dyn ExtensionCli>>,
    /// Path-keyed provider state carried along when a project folder moves.
    pub(super) relocator: Option<Arc<dyn ProviderRelocator>>,
}

impl ProviderRegistrationMetadata {
    pub fn aliases(&self) -> &[Cow<'static, str>] {
        &self.aliases
    }

    pub fn model_guidance(&self) -> Option<&str> {
        self.model_guidance.as_deref()
    }

    pub fn discovery(&self) -> Option<&ProviderDiscoveryMetadata> {
        self.discovery.as_ref()
    }

    pub fn updater(&self) -> Option<&Arc<dyn ProviderUpdater>> {
        self.updater.as_ref()
    }

    pub fn extensions(&self) -> Option<&Arc<dyn ExtensionCli>> {
        self.extensions.as_ref()
    }

    pub fn relocator(&self) -> Option<&Arc<dyn ProviderRelocator>> {
        self.relocator.as_ref()
    }
}
