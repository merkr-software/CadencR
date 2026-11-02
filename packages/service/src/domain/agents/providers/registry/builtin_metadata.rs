use std::borrow::Cow;
use std::path::PathBuf;
use std::sync::Arc;

use cli_discovery::DiscoverySpec;

use super::{ProviderDiscoveryMetadata, ProviderRegistrationMetadata};
use crate::domain::agents::extensions::ExtensionCli;
use crate::domain::agents::updates::native_cli::{LatestVersionSource, NativeCliUpdater};

pub(super) fn claude_metadata() -> ProviderRegistrationMetadata {
    ProviderRegistrationMetadata {
        aliases: aliases(&["claude", "claude-code", "Claude Code", "anthropic"]),
        model_guidance: Some(Cow::Borrowed(
            "Use catalog aliases such as opus, opus[1m], sonnet, haiku, or default.",
        )),
        ..with_native_updates(
            discovery(
                "claude",
                "claude_cli_path",
                claude_agent_sdk_rs::claude_discovery_spec(),
                claude_agent_sdk_rs::set_binary_override,
            ),
            crate::domain::agents::claude_code::updates::latest_version,
            &["update"],
        )
    }
    .with_extensions(Arc::new(
        crate::domain::agents::claude_code::extensions::ClaudeExtensions,
    ))
}

pub(super) fn codex_metadata() -> ProviderRegistrationMetadata {
    ProviderRegistrationMetadata {
        aliases: aliases(&["codex", "codex-cli", "Codex CLI", "openai"]),
        model_guidance: Some(Cow::Borrowed(
            "Use bare Codex/OpenAI-style model ids advertised by the Codex app-server, for example gpt-5.5.",
        )),
        ..with_native_updates(
            discovery(
                "codex",
                "codex_cli_path",
                codex_app_server_sdk_rs::codex_discovery_spec(),
                codex_app_server_sdk_rs::set_binary_override,
            ),
            crate::domain::agents::codex::updates::latest_version,
            &["update"],
        )
    }
    .with_extensions(Arc::new(crate::domain::agents::codex::extensions::CodexExtensions))
}

pub(super) fn opencode_metadata() -> ProviderRegistrationMetadata {
    ProviderRegistrationMetadata {
        aliases: aliases(&["open-code", "OpenCode", "open"]),
        model_guidance: Some(Cow::Borrowed(
            "Use OpenCode provider/model ids such as default/default or other ids shown by OpenCode's model catalog.",
        )),
        ..with_native_updates(
            discovery(
                "opencode",
                "opencode_cli_path",
                opencode_sdk_rs::opencode_discovery_spec(),
                opencode_sdk_rs::set_binary_override,
            ),
            crate::domain::agents::opencode::updates::latest_version,
            &["upgrade"],
        )
    }
}

impl ProviderRegistrationMetadata {
    fn with_extensions(mut self, extensions: Arc<dyn ExtensionCli>) -> Self {
        self.extensions = Some(extensions);
        self
    }
}

/// Discovery plus the provider's native CLI updater, which upgrades the same
/// binary discovery selects using the CLI's own `update_args` subcommand.
fn with_native_updates(
    discovery: ProviderDiscoveryMetadata,
    latest_version: LatestVersionSource,
    update_args: &'static [&'static str],
) -> ProviderRegistrationMetadata {
    let updater = NativeCliUpdater::builder()
        .discovery(discovery.clone())
        .latest_version(latest_version)
        .update_args(update_args)
        .build();
    ProviderRegistrationMetadata {
        updater: Some(Arc::new(updater)),
        discovery: Some(discovery),
        ..ProviderRegistrationMetadata::default()
    }
}

fn aliases(values: &'static [&'static str]) -> Vec<Cow<'static, str>> {
    values.iter().copied().map(Cow::Borrowed).collect()
}

fn discovery(
    discovery_id: &'static str,
    setting_key: &'static str,
    spec: DiscoverySpec,
    apply_override: fn(Option<PathBuf>),
) -> ProviderDiscoveryMetadata {
    ProviderDiscoveryMetadata {
        discovery_id: Cow::Borrowed(discovery_id),
        setting_key: Cow::Borrowed(setting_key),
        spec,
        apply_override,
    }
}
