//! Host API shapes for custom tabs (`docs/CUSTOM_TABS.md` §4.2).

use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};
use utoipa::{IntoParams, ToSchema};

use super::managed::storage::{InstalledBackend, ManagedFacts};
pub use cadencr_plugin_core::tab::{
    TabAccessLevel, TabBackend, TabCommand, TabConfigField, TabConfigFieldType, TabConfigScope,
    TabEditorContribution, TabIssue, TabIssueCode, TabPlatform, TabShortcut,
};

/// One local custom tab, valid or not.
#[derive(Debug, Clone, Serialize, ToSchema)]
pub struct PluginTabSummary {
    /// Present for an immutable marketplace installation.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub managed: Option<bool>,
    pub id: String,
    /// The manifest name, or the id when `tab.json` could not be parsed.
    pub name: String,
    pub version: Option<String>,
    pub description: Option<String>,
    /// The tab trigger text (`tab.label`, else the name).
    pub label: String,
    /// The icon's SVG markup, inlined so the renderer needs no extra request.
    pub icon_svg: Option<String>,
    pub api_version: Option<u32>,
    pub entry: Option<String>,
    /// Whether `entry` exists — `false` until the author first builds.
    pub entry_present: bool,
    pub permissions: Vec<String>,
    pub network: PluginTabNetwork,
    pub configuration: Vec<TabConfigField>,
    /// Programs the tab may ask Cadencr to run.
    pub commands: Vec<TabCommand>,
    /// Keyboard shortcuts the tab handles while it has focus.
    pub shortcuts: Vec<TabShortcut>,
    /// The native process the tab ships, which runs with the user's rights.
    pub backend: Option<TabBackend>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub editor: Option<TabEditorContribution>,
    /// Whether `backend` can run where Cadencr runs; `None` without one.
    pub backend_availability: Option<PluginTabBackendAvailability>,
    /// A marketplace tab's installed backend binary (what consent binds),
    /// with the platform it was installed for; `None` for a local tab or a
    /// tab without a backend.
    pub backend_binary: Option<PluginTabBackendBinary>,
    /// A marketplace update staged beside this revision because it would
    /// run something new. Accept it by consenting to its `permissions_hash`
    /// (`PUT /api/plugin-tabs/{id}/consent`), or discard it
    /// (`DELETE /api/marketplace/tabs/{id}/pending`); until then this
    /// revision keeps running.
    pub pending_update: Option<PluginTabPendingUpdate>,
    /// How far the tab reaches: its page only, commands, or a native backend.
    /// `ui` when the manifest is unreadable (such a tab cannot run).
    pub access_level: TabAccessLevel,
    /// What consent is recorded against; `None` when the manifest is unreadable.
    pub permissions_hash: Option<String>,
    pub status: PluginTabStatus,
    /// Why Cadencr's signed revocation policy blocks this marketplace tab
    /// (`status` is then `blocked`): it cannot be enabled, opened or run its
    /// backend, only removed. `None` when not blocked.
    pub blocked_reason: Option<String>,
    pub errors: Vec<TabIssue>,
    pub warnings: Vec<TabIssue>,
    /// Absolute path of the tab folder.
    pub dir: String,
    /// The project this tab is authored in, when Cadencr created one.
    pub authoring_project_id: Option<i64>,
    pub enablement: PluginTabEnablement,
    /// Every project override, by project id; only on a list asked for them
    /// (`?project_overrides=true`), so the settings page needs one request.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub project_overrides: Option<Vec<PluginTabProjectOverride>>,
}

/// One project's switch for a tab, overriding the global one.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, ToSchema)]
pub struct PluginTabProjectOverride {
    pub project_id: i64,
    pub enabled: bool,
}

/// What a staged marketplace update would run, for the review dialog.
#[derive(Debug, Clone, Serialize, ToSchema)]
pub struct PluginTabPendingUpdate {
    pub version: String,
    /// What accepting it records; differs from the installed revision's.
    pub permissions_hash: String,
    pub access_level: TabAccessLevel,
    pub permissions: Vec<String>,
    pub network: PluginTabNetwork,
    pub commands: Vec<TabCommand>,
    pub backend: Option<TabBackend>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub editor: Option<TabEditorContribution>,
    /// The staged revision's backend binary, to compare with the installed
    /// `backend_binary`; `None` when the update ships no backend.
    pub backend_binary: Option<PluginTabBackendBinary>,
    /// Why Cadencr's revocation policy blocks it: it cannot be accepted
    /// (403 `PLUGIN_TAB_BLOCKED`), only discarded.
    pub blocked_reason: Option<String>,
}

/// One installed (or staged) marketplace backend binary: the signed facts a
/// binary-only update changes.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, ToSchema)]
pub struct PluginTabBackendBinary {
    /// The platform it was installed for (`darwin-aarch64`, …).
    pub platform: TabPlatform,
    /// The backend protocol version it speaks.
    pub protocol: u32,
    /// The signed SHA-256 of the executable, checked before each launch.
    pub executable_sha256: String,
}

/// A backend's availability on the platform Cadencr runs on.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, ToSchema)]
#[serde(rename_all = "snake_case")]
pub enum PluginTabBackendAvailability {
    /// It declares a binary for this platform (which may still be unbuilt
    /// or refused at launch; see `warnings`).
    Available,
    /// It ships no binary for this platform, or Cadencr runs where tab
    /// backends are not supported: it never starts here.
    UnavailableOnPlatform,
}

impl PluginTabBackendAvailability {
    /// A local tab's: whether its manifest declares this platform's binary.
    pub fn of(backend: &TabBackend) -> Self {
        Self::when(
            TabPlatform::current().is_some_and(|platform| backend.binary_for(platform).is_some()),
        )
    }

    /// A marketplace revision's: whether it installed this platform's binary.
    pub fn of_installed(facts: &ManagedFacts) -> Self {
        Self::when(installed_here(facts).is_some())
    }

    fn when(available: bool) -> Self {
        if available {
            Self::Available
        } else {
            Self::UnavailableOnPlatform
        }
    }
}

/// A marketplace revision's backend binary when it is the one for the
/// platform Cadencr runs on. A revision holds the binary of the platform it
/// was installed on, or none: the same data copied to another machine is
/// not this platform's.
pub fn installed_here(facts: &ManagedFacts) -> Option<&InstalledBackend> {
    facts
        .backend
        .as_ref()
        .filter(|backend| TabPlatform::current() == Some(backend.platform))
}

#[derive(Debug, Clone, Default, Serialize, ToSchema)]
pub struct PluginTabNetwork {
    pub allowed_origins: Vec<String>,
    pub reasoning: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, ToSchema)]
#[serde(rename_all = "lowercase")]
pub enum PluginTabStatus {
    Valid,
    Invalid,
    /// A marketplace revision Cadencr's revocation policy blocks
    /// (`blocked_reason` says why), whatever its manifest.
    Blocked,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, ToSchema)]
pub struct PluginTabEnablement {
    /// The global switch; `None` when never set (off).
    pub global: Option<bool>,
    /// The requested project's override; `None` when unset or no project was given.
    pub project: Option<bool>,
    /// Switched on, consented at the current hash, valid, and not blocked.
    pub effective: bool,
    /// No consent, or consent for an older permissions hash.
    pub consent_required: bool,
}

/// `?project_id=` on reads that can show one project's view.
#[derive(Debug, Deserialize, IntoParams)]
#[into_params(parameter_in = Query)]
pub struct PluginTabProjectQuery {
    pub project_id: Option<i64>,
}

/// `GET /api/plugin-tabs`: [`PluginTabProjectQuery`], and whether to include
/// every project's override.
#[derive(Debug, Deserialize, IntoParams)]
#[into_params(parameter_in = Query)]
pub struct PluginTabListQuery {
    pub project_id: Option<i64>,
    /// Fill each summary's `project_overrides`.
    #[serde(default)]
    pub project_overrides: bool,
}

#[derive(Debug, Deserialize, ToSchema)]
pub struct SetPluginTabEnablementRequest {
    /// `null` targets the global switch.
    pub project_id: Option<i64>,
    /// `null` clears the switch (a project falls back to global, global to off).
    pub enabled: Option<bool>,
}

#[derive(Debug, Deserialize, ToSchema)]
pub struct PluginTabConsentRequest {
    /// The hash the user was shown; must equal the current one.
    pub permissions_hash: String,
}

/// The settings form: the declared fields and the stored values. Secret values
/// are never returned; a set secret reads `{ "is_set": true }`.
#[derive(Debug, Clone, Serialize, ToSchema)]
pub struct PluginTabConfiguration {
    pub fields: Vec<TabConfigField>,
    #[schema(value_type = Object)]
    pub global: BTreeMap<String, serde_json::Value>,
    /// The requested project's values; `None` when no project was given.
    #[schema(value_type = Option<Object>)]
    pub project: Option<BTreeMap<String, serde_json::Value>>,
}

#[derive(Debug, Deserialize, ToSchema)]
pub struct PutPluginTabConfigurationRequest {
    /// Key → new value; `null` removes the stored value. Keys not listed are
    /// left untouched, so a form can omit secrets it did not change.
    #[schema(value_type = Object)]
    pub values: BTreeMap<String, serde_json::Value>,
}

#[derive(Debug, Deserialize, ToSchema)]
pub struct CreatePluginTabRequest {
    /// Human-readable name; the id is slugified from it.
    pub name: String,
    pub description: Option<String>,
}

/// Where a tab is authored. The renderer navigates to the conversation.
#[derive(Debug, Clone, Serialize, ToSchema)]
pub struct PluginTabWorkspace {
    pub plugin_id: String,
    pub project_id: i64,
    pub feature_id: i64,
    /// The tab folder — the project root and the agent's cwd.
    pub dir: String,
}

#[derive(Debug, Deserialize, ToSchema)]
pub struct CreatePluginTabGrantRequest {
    /// The feature the tab instance is shown in; the grant binds to it and
    /// its project.
    pub feature_id: i64,
}

/// A plugin token for one tab instance. Opaque; send it as
/// `x-cadencr-plugin-token` (HTTP) or the `cadencr-plugin.<token>`
/// subprotocol (`/api/plugin-tabs/ws`). In memory only, never persisted.
#[derive(Debug, Clone, Serialize, ToSchema)]
pub struct PluginTabGrant {
    pub token: String,
    /// RFC 3339; mint a new grant before then.
    pub expires_at: String,
    /// The consented scopes (§6) the token carries.
    pub scopes: Vec<String>,
    pub api_version: u32,
}

/// `POST /api/plugin-tabs/self/net/fetch` (§4.5). The request body is the
/// raw upstream body; outbound headers ride in `x-cadencr-net-headers`.
#[derive(Debug, Deserialize, IntoParams)]
#[into_params(parameter_in = Query)]
pub struct PluginNetFetchQuery {
    /// Absolute URL whose origin is in the manifest's `network.allowed_origins`.
    pub url: String,
    /// HTTP method, `GET` when omitted.
    pub method: Option<String>,
}
