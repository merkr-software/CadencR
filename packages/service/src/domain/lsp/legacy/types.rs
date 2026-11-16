use cli_discovery::DiscoverySpec;

/// The job an LSP server does for a file. Lets a project run several servers
/// per language (e.g. a type checker plus a linter) without the catalog
/// branching on provider identity. `lookup_all` returns every entry for a
/// language id; `active-servers` on the frontend then picks one per role.
#[derive(
    Debug, Clone, Copy, PartialEq, Eq, Hash, serde::Serialize, serde::Deserialize, utoipa::ToSchema,
)]
#[serde(rename_all = "snake_case")]
pub enum ServerRole {
    /// Full language intelligence: completion, hover, go-to-definition,
    /// diagnostics from type analysis. At most one is active per editor and it
    /// owns the navigation surface.
    TypeChecker,
    /// Lint diagnostics (and, for some, formatting). Several can run alongside
    /// the type checker; their diagnostics are merged, never replacing it.
    Linter,
    /// Formatting-focused server. Part of the role taxonomy; no catalog entry
    /// currently uses it (formatters are CLI-only via the formatter catalog),
    /// but it's kept so a future format-over-LSP server slots in without an API
    /// change.
    #[allow(dead_code)]
    Formatter,
    /// Everything else (config-file servers, single-file servers).
    General,
}

/// What a single LSP server looks like from the host's perspective.
#[derive(Debug)]
pub struct CatalogEntry {
    /// Stable id used in `~/.cadencr/lsp/<lsp_id>/<version>/` and tracing.
    pub lsp_id: &'static str,
    /// The role this server fills for its language(s). Drives per-project
    /// tooling selection (one TypeChecker + optional Linter per file).
    pub role: ServerRole,
    /// LSP `TextDocumentItem` language ids served by this entry.
    pub language_ids: &'static [&'static str],
    /// Filenames whose presence marks the LSP root for this language, in
    /// priority order (most specific first). The root resolver walks UP from
    /// an opened file to the nearest ancestor directory containing one of
    /// these. Empty means "no monorepo rooting" — fall back to the feature
    /// working dir (correct for whole-tree servers and standalone configs).
    pub root_markers: &'static [&'static str],
    /// Bare binary name on `$PATH` or in a managed recipe.
    pub bin_name: &'static str,
    /// Args appended to every invocation.
    pub args: &'static [&'static str],
    /// Directories relative to `$HOME` worth probing.
    pub well_known_relative_to_home: &'static [&'static str],
    /// Absolute directories worth probing.
    pub well_known_absolute: &'static [&'static str],
    /// Args used to query the binary's version.
    pub version_args: &'static [&'static str],
    /// Optional case-insensitive substring required in `--version` output.
    pub version_must_contain: Option<&'static str>,
    /// Optional on-demand downloader recipe; `None` means "user must
    /// install this themselves".
    pub legacy_install: Option<LegacyInstall>,
}

/// Read-only locations produced by pre-marketplace releases. No network recipes remain.
#[derive(Debug, Clone)]
pub enum LegacyInstall {
    Native { version: &'static str },
    Npm { version: &'static str },
}
impl LegacyInstall {
    pub fn version(&self) -> &'static str {
        match self {
            Self::Native { version } | Self::Npm { version } => version,
        }
    }
}

impl CatalogEntry {
    /// Build a `DiscoverySpec` that `cli-discovery` consumes.
    pub fn discovery_spec(&self) -> DiscoverySpec {
        DiscoverySpec {
            bin_name: self.bin_name.to_string(),
            well_known_relative_to_home: self
                .well_known_relative_to_home
                .iter()
                .map(|value| (*value).to_string())
                .collect(),
            well_known_absolute: self
                .well_known_absolute
                .iter()
                .map(|value| (*value).to_string())
                .collect(),
            version_args: self
                .version_args
                .iter()
                .map(|value| (*value).to_string())
                .collect(),
            version_must_contain: self.version_must_contain.map(str::to_string),
        }
    }
}
