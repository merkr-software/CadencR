//! Runtime provider registry.
//!
//! The set of runtime providers used to be a compile-time
//! `&[(&str, &dyn AgentRuntimeAdapter)]` slice, which forced every entry to be
//! a `'static` literal. This module keeps the exact same built-in providers, in
//! the exact same order, behind a registry that is *constructed* at runtime, so
//! a later increment can add installed (marketplace) providers without changing
//! the shape of any lookup site.
//!
//! See `docs/PROVIDER_SPEC/BOUNDARIES.md` (Phase 1). Built-ins supply factories
//! and host metadata here; validated local ACP descriptors append owned adapters
//! during startup.

use std::borrow::Cow;
use std::collections::HashSet;
use std::ops::Deref;
use std::path::PathBuf;
use std::sync::{Arc, OnceLock};

use cli_discovery::DiscoverySpec;

use crate::domain::agents::adapter::AgentRuntimeAdapter;
use crate::domain::agents::runtime::ProviderOrigin;

mod builtin_metadata;
use builtin_metadata::{claude_metadata, codex_metadata, cursor_metadata, opencode_metadata};

/// A cloneable, `'static` handle to a registered adapter.
///
/// `Borrowed` exists for exactly one reason: `spawn_startup_warmup(&self)` can't
/// move `self` into a `'static` task, so Claude Code's warmup
/// (`claude_code/adapter_impl.rs`) populates the `CLAUDE_CODE_ADAPTER` static
/// directly. Its probe caches live inline in the adapter value, so a
/// registry-owned copy would read a different cache than the warmup fills.
/// `Owned` covers adapters the registry constructs — today the stateless
/// built-ins, tomorrow adapters built from an installation record. Collapsing
/// to a single `Arc` becomes possible once warmup takes `self: Arc<Self>`.
///
/// Both variants own their target for `'static`, so a handle can be stored on a
/// spawned task exactly like the old `&'static` reference could.
#[derive(Clone)]
pub enum ProviderAdapterHandle {
    Borrowed(&'static (dyn AgentRuntimeAdapter + 'static)),
    Owned(Arc<dyn AgentRuntimeAdapter>),
}

impl ProviderAdapterHandle {
    /// Hand back an adapter that must remain the one shared instance.
    pub fn borrowed(adapter: &'static (dyn AgentRuntimeAdapter + 'static)) -> Self {
        Self::Borrowed(adapter)
    }

    /// Register an adapter value the registry owns.
    pub fn owned(adapter: impl AgentRuntimeAdapter + 'static) -> Self {
        Self::Owned(Arc::new(adapter))
    }

    /// Borrow the adapter behind this handle. Callers making a single
    /// dispatched call can rely on `Deref` instead.
    pub fn as_adapter(&self) -> &(dyn AgentRuntimeAdapter + 'static) {
        match self {
            Self::Borrowed(adapter) => *adapter,
            Self::Owned(adapter) => adapter.as_ref(),
        }
    }
}

impl Deref for ProviderAdapterHandle {
    type Target = dyn AgentRuntimeAdapter + 'static;

    fn deref(&self) -> &Self::Target {
        self.as_adapter()
    }
}

impl std::fmt::Debug for ProviderAdapterHandle {
    /// Prints the variant only. `catalog_entry()` builds a whole
    /// `ProviderCatalogEntry` (Claude Code's includes a fallback model list),
    /// so resolving the provider id here would make every `?registry` log line
    /// allocate one catalog per provider. `RegisteredProvider` carries the id.
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str(match self {
            Self::Borrowed(_) => "ProviderAdapterHandle::Borrowed",
            Self::Owned(_) => "ProviderAdapterHandle::Owned",
        })
    }
}

/// Constructs a registered adapter. Built-ins hand back their shared `static`
/// or build a fresh value; a future installed-provider factory will build an
/// `Owned` handle from a validated installation record.
type ProviderAdapterFactory = fn() -> ProviderAdapterHandle;
type ProviderMetadataFactory = fn() -> ProviderRegistrationMetadata;

/// Optional host discovery metadata owned by one provider registration.
#[derive(Clone, Debug)]
pub struct ProviderDiscoveryMetadata {
    discovery_id: Cow<'static, str>,
    setting_key: Cow<'static, str>,
    spec: DiscoverySpec,
    apply_override: fn(Option<PathBuf>),
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
    aliases: Vec<Cow<'static, str>>,
    model_guidance: Option<Cow<'static, str>>,
    discovery: Option<ProviderDiscoveryMetadata>,
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
}

/// One entry in the registry: the catalog id plus the adapter that owns it.
#[derive(Clone, Debug)]
pub struct RegisteredProvider {
    id: Cow<'static, str>,
    adapter: ProviderAdapterHandle,
    metadata: ProviderRegistrationMetadata,
    origin: ProviderOrigin,
}

impl RegisteredProvider {
    pub fn new(id: impl Into<Cow<'static, str>>, adapter: ProviderAdapterHandle) -> Self {
        Self {
            id: id.into(),
            adapter,
            metadata: ProviderRegistrationMetadata::default(),
            origin: ProviderOrigin::BuiltIn,
        }
    }

    pub fn installed_local(mut self) -> Self {
        self.origin = ProviderOrigin::InstalledLocal;
        self
    }

    fn with_metadata(mut self, metadata: ProviderRegistrationMetadata) -> Self {
        self.metadata = metadata;
        self
    }

    pub fn id(&self) -> &str {
        &self.id
    }

    pub fn adapter(&self) -> &ProviderAdapterHandle {
        &self.adapter
    }

    pub fn metadata(&self) -> &ProviderRegistrationMetadata {
        &self.metadata
    }

    pub fn origin(&self) -> ProviderOrigin {
        self.origin
    }
}

struct BuiltinProvider {
    id: &'static str,
    adapter: ProviderAdapterFactory,
    metadata: ProviderMetadataFactory,
}

/// The compiled-in providers, in catalog order. Registration order is
/// user-visible — it drives the provider picker and the catalog response — so
/// this list stays ordered and the registry never sorts it.
///
/// Adding a built-in provider is still one edit here.
static BUILTIN_PROVIDERS: &[BuiltinProvider] = &[
    // Claude Code caches its model catalog and slash commands *inside* the
    // adapter value, so every caller must see the same instance.
    BuiltinProvider {
        id: super::super::claude_code::PROVIDER_ID,
        adapter: || {
            ProviderAdapterHandle::borrowed(&super::super::claude_code::CLAUDE_CODE_ADAPTER)
        },
        metadata: claude_metadata,
    },
    // The remaining built-ins hold no inline state (their caches are
    // module-level), so the registry constructs them the same way it will
    // construct an installed provider.
    BuiltinProvider {
        id: super::super::codex::PROVIDER_ID,
        adapter: || ProviderAdapterHandle::owned(super::super::codex::CodexAdapter),
        metadata: codex_metadata,
    },
    BuiltinProvider {
        id: super::super::cursor::PROVIDER_ID,
        adapter: || ProviderAdapterHandle::owned(super::super::cursor::CursorAdapter),
        metadata: cursor_metadata,
    },
    BuiltinProvider {
        id: super::super::opencode::PROVIDER_ID,
        adapter: || ProviderAdapterHandle::owned(super::super::opencode::OpenCodeAdapter),
        metadata: opencode_metadata,
    },
];

/// Ordered set of runtime providers available to this process.
#[derive(Clone, Debug, Default)]
pub struct ProviderRegistry {
    providers: Vec<RegisteredProvider>,
}

impl ProviderRegistry {
    /// Build a registry from an ordered list of entries. Any canonical id or
    /// alias collision is ignored, so the first registration (built-ins at
    /// startup) keeps ownership of its complete public namespace.
    pub fn from_providers(providers: impl IntoIterator<Item = RegisteredProvider>) -> Self {
        let mut registered: Vec<RegisteredProvider> = Vec::new();
        let mut registered_identifiers: HashSet<String> = HashSet::new();
        for provider in providers {
            let adapter_id = provider.adapter().catalog_entry().id;
            if adapter_id != provider.id() {
                tracing::warn!(
                    provider_id = provider.id(),
                    adapter_provider_id = adapter_id,
                    "provider registration ignored because its id does not match its adapter catalog id"
                );
                continue;
            }
            let identifiers: HashSet<String> = std::iter::once(provider.id())
                .chain(
                    provider
                        .metadata()
                        .aliases()
                        .iter()
                        .map(|alias| alias.as_ref()),
                )
                .map(provider_identifier_key)
                .collect();
            if identifiers
                .iter()
                .any(|identifier| registered_identifiers.contains(identifier))
            {
                tracing::warn!(
                    provider_id = provider.id(),
                    "provider registration ignored because its public identifier conflicts with an earlier registration"
                );
                continue;
            }
            registered_identifiers.extend(identifiers);
            registered.push(provider);
        }
        Self {
            providers: registered,
        }
    }

    /// The registry this process runs on: built-ins first, then every enabled
    /// local ACP installation the startup scan validated.
    ///
    /// Order matters twice over. It is user-visible (the picker and the catalog
    /// render it as-is), and registering built-ins first is what makes "a
    /// descriptor cannot take a built-in's id" true by construction rather than
    /// by a special case.
    pub fn startup() -> Self {
        Self::from_providers(
            builtin_registrations().chain(super::installed::installed_registrations()),
        )
    }

    pub fn adapter(&self, provider_id: &str) -> Option<ProviderAdapterHandle> {
        self.iter()
            .find(|provider| provider.id() == provider_id)
            .map(|provider| provider.adapter().clone())
    }

    pub fn contains(&self, provider_id: &str) -> bool {
        self.iter().any(|provider| provider.id() == provider_id)
    }

    /// Registered providers in catalog order.
    pub fn iter(&self) -> impl Iterator<Item = &RegisteredProvider> {
        self.providers.iter()
    }

    /// Registered adapters in catalog order.
    pub fn adapters(&self) -> impl Iterator<Item = &ProviderAdapterHandle> {
        self.iter().map(RegisteredProvider::adapter)
    }

    /// Registered provider ids in catalog order.
    pub fn provider_ids(&self) -> Vec<String> {
        self.iter()
            .map(|provider| provider.id().to_string())
            .collect()
    }

    /// The first registration is the process default. Built-in order is a
    /// frozen user-visible contract, and installed providers are appended.
    pub fn default_provider_id(&self) -> &str {
        self.providers
            .first()
            .expect("the provider registry always has a built-in")
            .id()
    }

    pub fn discoveries(&self) -> impl Iterator<Item = (&str, &ProviderDiscoveryMetadata)> {
        self.iter().filter_map(|provider| {
            provider
                .metadata()
                .discovery()
                .map(|discovery| (provider.id(), discovery))
        })
    }
}

/// Catalog ids compiled into this build, in registration order. Read by the
/// descriptor loader so an installed entry cannot claim a built-in's id.
pub fn builtin_provider_ids() -> Vec<&'static str> {
    BUILTIN_PROVIDERS
        .iter()
        .map(|provider| provider.id)
        .collect()
}

/// Every public name owned by a built-in provider: canonical ids first, then
/// aliases. Installed providers reserve this whole namespace so an exact
/// third-party id can never shadow an alias such as `claude` or `openai`.
pub fn builtin_provider_identifiers() -> &'static [String] {
    static IDENTIFIERS: OnceLock<Vec<String>> = OnceLock::new();
    IDENTIFIERS.get_or_init(|| {
        let mut identifiers: Vec<String> = builtin_provider_ids()
            .into_iter()
            .map(ToOwned::to_owned)
            .collect();
        identifiers.extend(BUILTIN_PROVIDERS.iter().flat_map(|provider| {
            let metadata = (provider.metadata)();
            metadata
                .aliases()
                .iter()
                .map(ToString::to_string)
                .collect::<Vec<_>>()
        }));
        identifiers
    })
}

/// Provider references are compared the same way throughout resolution and
/// descriptor reservation: punctuation, spacing, and ASCII case do not create
/// distinct public names.
pub(super) fn provider_identifier_key(value: &str) -> String {
    value
        .chars()
        .filter(|ch| ch.is_ascii_alphanumeric())
        .flat_map(char::to_lowercase)
        .collect()
}

fn builtin_registrations() -> impl Iterator<Item = RegisteredProvider> {
    BUILTIN_PROVIDERS.iter().map(|provider| {
        RegisteredProvider::new(provider.id, (provider.adapter)())
            .with_metadata((provider.metadata)())
    })
}

/// The process-wide registry. Initialized on first use from the built-in
/// factories plus the startup descriptor scan.
pub fn provider_registry() -> &'static ProviderRegistry {
    static REGISTRY: OnceLock<ProviderRegistry> = OnceLock::new();
    REGISTRY.get_or_init(ProviderRegistry::startup)
}

#[cfg(test)]
mod tests {
    use super::{
        builtin_provider_identifiers, provider_identifier_key, provider_registry,
        ProviderAdapterHandle, ProviderRegistry, RegisteredProvider,
    };
    use crate::domain::agents::runtime::ProviderOrigin;

    /// Parity freeze: the registry exposes exactly the providers the static
    /// `ADAPTERS` slice used to, in the same order. Ordering is user-visible.
    #[test]
    fn registry_preserves_builtin_provider_order() {
        assert_eq!(
            provider_registry().provider_ids(),
            vec!["claude_code", "codex_cli", "cursor", "opencode"]
        );
    }

    #[test]
    fn registry_owns_provider_origin() {
        assert!(provider_registry()
            .iter()
            .all(|provider| provider.origin() == ProviderOrigin::BuiltIn));

        let installed = RegisteredProvider::new(
            "cursor",
            ProviderAdapterHandle::owned(crate::domain::agents::cursor::CursorAdapter),
        )
        .installed_local();
        assert_eq!(installed.origin(), ProviderOrigin::InstalledLocal);
    }

    /// Every registered id must be the id its adapter advertises, otherwise
    /// catalog lookups and runtime dispatch would disagree.
    #[test]
    fn registered_ids_match_adapter_catalog_ids() {
        for provider in provider_registry().iter() {
            assert_eq!(
                provider.adapter().catalog_entry().id,
                provider.id(),
                "catalog entry id mismatch for {}",
                provider.id()
            );
        }
    }

    #[test]
    fn registry_resolves_every_registered_id_and_rejects_unknown_ones() {
        for id in provider_registry().provider_ids() {
            let adapter = provider_registry()
                .adapter(&id)
                .unwrap_or_else(|| panic!("adapter for {id}"));
            assert_eq!(adapter.catalog_entry().id, id);
            assert!(provider_registry().contains(&id));
        }
        assert!(provider_registry().adapter("unknown").is_none());
        assert!(!provider_registry().contains("unknown"));
    }

    /// The compiled default provider must exist in the registry — otherwise the
    /// catalog would silently fall back to an arbitrary first entry.
    #[test]
    fn default_provider_is_registered() {
        assert!(provider_registry().contains(provider_registry().default_provider_id()));
    }

    /// The property that matters, independent of which handle variant a
    /// provider uses: repeated lookups resolve to the *same* adapter instance.
    /// Adapters cache probe results, so two instances would silently split the
    /// cache and make the catalog depend on which lookup won.
    ///
    /// The casts drop the vtable half of each fat pointer and compare data
    /// addresses, which is exactly the identity question being asked.
    #[test]
    fn repeated_lookups_resolve_to_one_shared_instance() {
        for id in provider_registry().provider_ids() {
            let first = provider_registry().adapter(&id).expect("adapter");
            let second = provider_registry().adapter(&id).expect("adapter");
            assert_eq!(
                first.as_adapter() as *const _ as *const u8,
                second.as_adapter() as *const _ as *const u8,
                "{id} handed out two adapter instances"
            );
        }
    }

    /// Claude Code's warmup writes the `CLAUDE_CODE_ADAPTER` static directly
    /// (`spawn_startup_warmup(&self)` can't move `self` into a `'static` task),
    /// so the registry must hand out that same static rather than a copy —
    /// otherwise lookups read a cache the warmup never fills. Making Claude
    /// Code registry-owned requires changing warmup in the same edit.
    #[test]
    fn claude_code_resolves_to_the_static_its_warmup_fills() {
        let claude = provider_registry().adapter("claude_code").expect("claude");
        assert_eq!(
            claude.as_adapter() as *const _ as *const u8,
            &crate::domain::agents::claude_code::CLAUDE_CODE_ADAPTER as *const _ as *const u8,
        );
    }

    /// Migration freeze — not a permanent invariant. It pins the provider-owned
    /// defaults across the `&'static str` → `Cow` re-typing, where a silent
    /// regression would surface as a wrong chip, a wrong workspace setting key,
    /// or config files missing from a new worktree. A deliberate change to any
    /// provider's defaults should update this table, not work around it.
    #[test]
    fn builtin_defaults_are_unchanged() {
        let expected: &[(&str, &str, Option<&str>, &[&str])] = &[
            (
                "claude_code",
                "acceptEdits",
                None,
                &[
                    ".claude/settings.local.json",
                    ".claude/settings.json",
                    ".claude/skills",
                    ".claude/commands",
                    ".claude/rules",
                    ".mcp.json",
                ],
            ),
            (
                "codex_cli",
                "default",
                Some("codex_permission_mode"),
                &[
                    ".codex/config.toml",
                    ".codex/hooks.json",
                    ".codex/rules",
                    ".codex/agents",
                    ".codex/skills",
                ],
            ),
            (
                "cursor",
                "default",
                Some("cursor_access_mode"),
                &[
                    ".cursor/rules",
                    ".cursor/commands",
                    ".cursor/skills",
                    ".cursor/mcp.json",
                    ".cursor/cli.json",
                ],
            ),
            (
                "opencode",
                "acceptEdits",
                None,
                &[
                    "opencode.json",
                    ".opencode/agents",
                    ".opencode/commands",
                    ".opencode/skills",
                ],
            ),
        ];

        for (id, mode_wire, access_key, config_paths) in expected {
            let adapter = provider_registry()
                .adapter(id)
                .unwrap_or_else(|| panic!("adapter for {id}"));
            assert_eq!(adapter.default_permission_mode_wire(), *mode_wire, "{id}");
            assert_eq!(
                adapter.access_mode_setting_key().as_deref(),
                *access_key,
                "{id}"
            );
            assert_eq!(
                adapter.worktree_config_paths(),
                config_paths
                    .iter()
                    .map(|path| std::borrow::Cow::Borrowed(*path))
                    .collect::<Vec<_>>(),
                "{id}"
            );
        }
    }

    #[test]
    fn duplicate_registrations_keep_the_first_entry() {
        let cursor = ProviderAdapterHandle::owned(crate::domain::agents::cursor::CursorAdapter);
        let registry = ProviderRegistry::from_providers([
            RegisteredProvider::new("cursor", cursor.clone()),
            RegisteredProvider::new("cursor", cursor),
            RegisteredProvider::new(
                "opencode",
                ProviderAdapterHandle::owned(crate::domain::agents::opencode::OpenCodeAdapter),
            ),
        ]);
        assert_eq!(registry.provider_ids(), vec!["cursor", "opencode"]);
    }

    /// A dynamically owned id resolves and dispatches the same way a borrowed
    /// built-in id does. This is the seam installed providers will use.
    #[test]
    fn runtime_registered_providers_join_the_ordered_registry() {
        let installed = RegisteredProvider::new(
            String::from("cursor"),
            ProviderAdapterHandle::owned(crate::domain::agents::cursor::CursorAdapter),
        );
        let registry = ProviderRegistry::from_providers([installed]);

        assert_eq!(registry.provider_ids(), vec!["cursor"]);
        assert!(registry.contains("cursor"));
        assert_eq!(
            registry
                .adapter("cursor")
                .expect("installed adapter")
                .catalog_entry()
                .id,
            "cursor"
        );
    }

    #[test]
    fn mismatched_registry_and_catalog_ids_are_rejected() {
        let registry = ProviderRegistry::from_providers([RegisteredProvider::new(
            "installed_example",
            ProviderAdapterHandle::owned(crate::domain::agents::cursor::CursorAdapter),
        )]);

        assert!(registry.provider_ids().is_empty());
        assert!(registry.adapter("installed_example").is_none());
    }

    /// With nothing installed, the startup registry is exactly the built-in
    /// one — the descriptor scan must not perturb the shipped catalog.
    #[test]
    fn startup_registry_equals_the_builtins_when_nothing_is_installed() {
        assert!(super::super::installed::startup_load()
            .registrable()
            .next()
            .is_none());
        assert_eq!(
            ProviderRegistry::startup().provider_ids(),
            super::builtin_provider_ids()
        );
    }

    /// Built-ins register first, so a descriptor claiming one of their ids
    /// loses — the id keeps resolving to the built-in adapter, not to the
    /// installed one that advertised the same catalog id.
    #[test]
    fn a_builtin_id_always_wins_over_a_later_registration() {
        use crate::domain::agents::adapter::AgentRuntimeAdapter;
        let impostor = crate::domain::agents::providers::installed::GenericAcpAdapter::new(
            std::sync::Arc::new(installed_impostor("cursor")),
        );
        assert_eq!(impostor.catalog_entry().label, "Impostor");

        let registry = ProviderRegistry::from_providers(super::builtin_registrations().chain([
            RegisteredProvider::new("cursor", ProviderAdapterHandle::owned(impostor)),
        ]));

        assert_eq!(
            registry.provider_ids(),
            vec!["claude_code", "codex_cli", "cursor", "opencode"]
        );
        assert_eq!(
            registry
                .adapter("cursor")
                .expect("cursor")
                .catalog_entry()
                .label,
            crate::domain::agents::cursor::CursorAdapter
                .catalog_entry()
                .label,
            "the built-in registration must keep ownership of its id"
        );
    }

    #[test]
    fn a_builtin_alias_always_wins_over_a_later_registration() {
        use crate::domain::agents::adapter::AgentRuntimeAdapter;
        let impostor = crate::domain::agents::providers::installed::GenericAcpAdapter::new(
            std::sync::Arc::new(installed_impostor("claude")),
        );
        assert_eq!(impostor.catalog_entry().id, "claude");

        let registry = ProviderRegistry::from_providers(super::builtin_registrations().chain([
            RegisteredProvider::new("claude", ProviderAdapterHandle::owned(impostor)),
        ]));

        assert_eq!(
            registry.provider_ids(),
            vec!["claude_code", "codex_cli", "cursor", "opencode"]
        );
        assert!(registry.adapter("claude").is_none());
    }

    /// An installed descriptor that claims the supplied public identifier,
    /// built the way the loader would build it.
    #[cfg(test)]
    fn installed_impostor(
        provider_id: &str,
    ) -> crate::domain::agents::providers::installed::installation::HostInstallation {
        let descriptor = serde_json::from_value(serde_json::json!({
            "schema_version": 1,
            "agent": {
                "id": provider_id,
                "name": "Impostor",
                "version": "9.9.9",
                "description": "claims a built-in id",
            },
            "installation": { "executable": { "command": "/nonexistent/cadencr/impostor" } },
        }))
        .expect("valid descriptor");
        crate::domain::agents::providers::installed::installation::HostInstallation::from_descriptor(
            descriptor,
            std::path::Path::new("/p/provider.json"),
        )
        .expect("valid installation")
    }

    #[test]
    fn builtin_provider_ids_match_the_registered_order() {
        assert_eq!(
            super::builtin_provider_ids(),
            vec!["claude_code", "codex_cli", "cursor", "opencode"]
        );
    }

    #[test]
    fn builtin_public_identifiers_include_normalized_aliases() {
        let identifiers = builtin_provider_identifiers();
        for expected in ["claude_code", "claude", "anthropic", "codex_cli", "openai"] {
            assert!(
                identifiers.iter().any(|value| value == expected),
                "{expected}"
            );
        }
        assert_eq!(provider_identifier_key("Claude Code"), "claudecode");
        assert_eq!(provider_identifier_key("claude-code"), "claudecode");
    }

    #[test]
    fn empty_registry_resolves_nothing() {
        let registry = ProviderRegistry::default();
        assert!(registry.provider_ids().is_empty());
        assert!(registry.adapter("claude_code").is_none());
    }
}
