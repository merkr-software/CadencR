//! Data-driven LSP server catalog. Generic call sites should look up rows
//! here rather than branch on provider or language identity.

use cli_discovery::DiscoverySpec;

/// The job an LSP server does for a file. Lets a project run several servers
/// per language (e.g. a type checker plus a linter) without the catalog
/// branching on provider identity. `lookup_all` returns every entry for a
/// language id; `active-servers` on the frontend then picks one per role.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, serde::Serialize, utoipa::ToSchema)]
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
    pub download: Option<DownloadRecipe>,
}

/// Recipe for installing the server into `~/.cadencr/lsp/<lsp_id>/<version>/`.
#[derive(Debug, Clone)]
pub enum DownloadRecipe {
    /// Single executable hosted as a `.gz` GitHub release asset.
    GithubReleaseGz {
        /// Pinned version string used for URL substitution and install dir.
        version: &'static str,
        /// URL template with `{version}`, `{arch}`, and `{os}` placeholders.
        url_template: &'static str,
        /// SHA-256 of the decompressed executable for each supported asset.
        sha256_by_platform: &'static [PlatformSha256],
    },
    /// npm packages installed into a managed local prefix.
    NpmPackage {
        /// Pinned recipe version used as the `<version>` install directory.
        version: &'static str,
        /// Exact package specs passed to `npm install`.
        packages: &'static [&'static str],
    },
}

impl DownloadRecipe {
    pub fn version(&self) -> &'static str {
        match self {
            DownloadRecipe::GithubReleaseGz { version, .. } => version,
            DownloadRecipe::NpmPackage { version, .. } => version,
        }
    }
}

pub(super) const NPM_WELL_KNOWN_RELATIVE_TO_HOME: &[&str] = &[
    ".bun/bin",
    ".npm-global/bin",
    ".volta/bin",
    "Library/pnpm",
    ".cadencr-tools/node_modules/.bin",
];
pub(super) const HOMEBREW_WELL_KNOWN_ABSOLUTE: &[&str] = &["/opt/homebrew/bin", "/usr/local/bin"];

/// Root markers for the JS/TS family (and TS-backed frameworks). Prefer the
/// most specific config first so a nested package roots there rather than at
/// the monorepo's top-level `package.json`.
const JS_TS_ROOT_MARKERS: &[&str] = &["tsconfig.json", "jsconfig.json", "package.json"];

/// Config-file language servers (json/yaml/html/css/shell/docker) have no
/// meaningful per-package root — they reason about a single file — so they
/// fall back to the feature working dir.
const NO_ROOT_MARKERS: &[&str] = &[];

#[allow(clippy::too_many_arguments)]
const fn npm_catalog_entry(
    lsp_id: &'static str,
    role: ServerRole,
    language_ids: &'static [&'static str],
    root_markers: &'static [&'static str],
    bin_name: &'static str,
    args: &'static [&'static str],
    version: &'static str,
    packages: &'static [&'static str],
) -> CatalogEntry {
    CatalogEntry {
        lsp_id,
        role,
        language_ids,
        root_markers,
        bin_name,
        args,
        well_known_relative_to_home: NPM_WELL_KNOWN_RELATIVE_TO_HOME,
        well_known_absolute: HOMEBREW_WELL_KNOWN_ABSOLUTE,
        version_args: &["--version"],
        version_must_contain: None,
        download: Some(DownloadRecipe::NpmPackage { version, packages }),
    }
}

#[derive(Debug, Clone, Copy)]
pub struct PlatformSha256 {
    pub arch: &'static str,
    pub os: &'static str,
    pub sha256: &'static str,
}

/// The static catalog. Order doesn't matter — lookup is by `language_id`.
pub const CATALOG: &[CatalogEntry] = &[
    npm_catalog_entry(
        "typescript-language-server",
        ServerRole::TypeChecker,
        &[
            "typescript",
            "typescriptreact",
            "javascript",
            "javascriptreact",
        ],
        JS_TS_ROOT_MARKERS,
        "typescript-language-server",
        &["--stdio"],
        "5.3.0",
        &["typescript-language-server@5.3.0", "typescript@6.0.3"],
    ),
    // `tsgo`, the Go-native TypeScript compiler's language server. Same TS
    // family as `typescript-language-server` but role-distinct, so both can
    // coexist in the catalog (selection picks one via `editor_typescript_server`).
    // native-preview exposes the LSP over stdio with `tsgo --lsp -stdio`.
    npm_catalog_entry(
        "tsgo",
        ServerRole::TypeChecker,
        &[
            "typescript",
            "typescriptreact",
            "javascript",
            "javascriptreact",
        ],
        JS_TS_ROOT_MARKERS,
        "tsgo",
        &["--lsp", "-stdio"],
        "7.0.0-dev.20250609.1",
        &["@typescript/native-preview@7.0.0-dev.20250609.1"],
    ),
    // Biome: linter + formatter for the JS/TS/JSON family. `biome lsp-proxy`
    // speaks LSP over stdio. Role Linter (it also formats, surfaced through
    // the formatter catalog rather than a second LSP entry).
    npm_catalog_entry(
        "biome",
        ServerRole::Linter,
        &[
            "typescript",
            "typescriptreact",
            "javascript",
            "javascriptreact",
            "json",
            "jsonc",
        ],
        JS_TS_ROOT_MARKERS,
        "biome",
        &["lsp-proxy"],
        "1.9.4",
        &["@biomejs/biome@1.9.4"],
    ),
    // ESLint language server. Flat-config (`eslint.config.js`) is auto-detected
    // by recent versions; legacy `.eslintrc*` still works. Role Linter.
    npm_catalog_entry(
        "eslint",
        ServerRole::Linter,
        &[
            "typescript",
            "typescriptreact",
            "javascript",
            "javascriptreact",
        ],
        JS_TS_ROOT_MARKERS,
        "vscode-eslint-language-server",
        &["--stdio"],
        "4.10.0",
        &["vscode-langservers-extracted@4.10.0"],
    ),
    // oxlint's language server (`oxc_language_server`). Role Linter.
    npm_catalog_entry(
        "oxlint",
        ServerRole::Linter,
        &[
            "typescript",
            "typescriptreact",
            "javascript",
            "javascriptreact",
        ],
        JS_TS_ROOT_MARKERS,
        "oxc_language_server",
        &[],
        "0.16.0",
        &["oxlint@0.16.0"],
    ),
    npm_catalog_entry(
        "json-language-server",
        ServerRole::General,
        &["json", "jsonc"],
        NO_ROOT_MARKERS,
        "vscode-json-language-server",
        &["--stdio"],
        "4.10.0",
        &["vscode-langservers-extracted@4.10.0"],
    ),
    npm_catalog_entry(
        "yaml-language-server",
        ServerRole::General,
        &["yaml"],
        NO_ROOT_MARKERS,
        "yaml-language-server",
        &["--stdio"],
        "1.23.0",
        &["yaml-language-server@1.23.0"],
    ),
    npm_catalog_entry(
        "html-language-server",
        ServerRole::General,
        &["html"],
        NO_ROOT_MARKERS,
        "vscode-html-language-server",
        &["--stdio"],
        "4.10.0",
        &["vscode-langservers-extracted@4.10.0"],
    ),
    npm_catalog_entry(
        "css-language-server",
        ServerRole::General,
        &["css", "scss", "less"],
        NO_ROOT_MARKERS,
        "vscode-css-language-server",
        &["--stdio"],
        "4.10.0",
        &["vscode-langservers-extracted@4.10.0"],
    ),
    npm_catalog_entry(
        "svelte-language-server",
        ServerRole::TypeChecker,
        &["svelte"],
        JS_TS_ROOT_MARKERS,
        "svelteserver",
        &["--stdio"],
        "0.18.0",
        &["svelte-language-server@0.18.0", "typescript@6.0.3"],
    ),
    npm_catalog_entry(
        "vue-language-server",
        ServerRole::TypeChecker,
        &["vue"],
        JS_TS_ROOT_MARKERS,
        "vue-language-server",
        &["--stdio"],
        "3.3.1",
        &["@vue/language-server@3.3.1", "typescript@6.0.3"],
    ),
    npm_catalog_entry(
        "astro-ls",
        ServerRole::TypeChecker,
        &["astro"],
        JS_TS_ROOT_MARKERS,
        "astro-ls",
        &["--stdio"],
        "2.16.9",
        &["@astrojs/language-server@2.16.9"],
    ),
    npm_catalog_entry(
        "bash-language-server",
        ServerRole::General,
        &["shellscript"],
        NO_ROOT_MARKERS,
        "bash-language-server",
        &["start"],
        "5.6.0",
        &["bash-language-server@5.6.0"],
    ),
    npm_catalog_entry(
        "docker-langserver",
        ServerRole::General,
        &["dockerfile"],
        NO_ROOT_MARKERS,
        "docker-langserver",
        &["--stdio"],
        "0.15.0",
        &["dockerfile-language-server-nodejs@0.15.0"],
    ),
    CatalogEntry {
        lsp_id: "rust-analyzer",
        role: ServerRole::TypeChecker,
        language_ids: &["rust"],
        // rust-analyzer already roots at the cargo workspace itself, so this
        // marker only ensures we hand it the crate/workspace dir rather than
        // a feature root that might sit above multiple unrelated crates.
        root_markers: &["Cargo.toml"],
        bin_name: "rust-analyzer",
        args: &[],
        well_known_relative_to_home: &[".cargo/bin"],
        well_known_absolute: HOMEBREW_WELL_KNOWN_ABSOLUTE,
        version_args: &["--version"],
        // Reject rustup shims that don't have the component installed.
        version_must_contain: Some("rust-analyzer"),
        download: Some(DownloadRecipe::GithubReleaseGz {
            version: "2026-05-18",
            url_template:
                "https://github.com/rust-lang/rust-analyzer/releases/download/{version}/rust-analyzer-{arch}-{os}.gz",
            sha256_by_platform: &[
                PlatformSha256 {
                    arch: "x86_64",
                    os: "apple-darwin",
                    sha256: "7a302096e2d1a925172eae4bd948b4023d8add006f87bd8603afefd7703a9e41",
                },
                PlatformSha256 {
                    arch: "aarch64",
                    os: "apple-darwin",
                    sha256: "bdc9dea86392a14aa752de040e6e1b7b128d1021e6fdf688ded49164173985c6",
                },
                PlatformSha256 {
                    arch: "x86_64",
                    os: "unknown-linux-gnu",
                    sha256: "249f9b2b901cad51a0f62227eafbc02570a4230755fdb87a75b21dc8b0eaeafa",
                },
                PlatformSha256 {
                    arch: "aarch64",
                    os: "unknown-linux-gnu",
                    sha256: "e14f06cdb53678d245d714e92e749a9260482178738c7fb40f6aa6184f6220d0",
                },
            ],
        }),
    },
    CatalogEntry {
        lsp_id: "gopls",
        role: ServerRole::TypeChecker,
        language_ids: &["go"],
        root_markers: &["go.work", "go.mod"],
        bin_name: "gopls",
        args: &[],
        well_known_relative_to_home: &["go/bin"],
        well_known_absolute: HOMEBREW_WELL_KNOWN_ABSOLUTE,
        version_args: &["version"],
        version_must_contain: None,
        download: None,
    },
    CatalogEntry {
        lsp_id: "pyright",
        role: ServerRole::TypeChecker,
        language_ids: &["python"],
        root_markers: &["pyproject.toml", "setup.py", "setup.cfg", "requirements.txt"],
        bin_name: "pyright-langserver",
        args: &["--stdio"],
        well_known_relative_to_home: NPM_WELL_KNOWN_RELATIVE_TO_HOME,
        well_known_absolute: HOMEBREW_WELL_KNOWN_ABSOLUTE,
        version_args: &["--version"],
        version_must_contain: None,
        download: None,
    },
];

/// Look up the *default* catalog entry serving a given LSP `languageId`.
///
/// "Default" = the language's primary intelligence server: the first
/// non-Linter entry (TypeChecker / General), so callers that don't specify a
/// concrete `lsp_id` get type-checking, not a linter. Used by the
/// language-id-only session path and root resolution.
pub fn lookup(language_id: &str) -> Option<&'static CatalogEntry> {
    let all = lookup_all(language_id);
    all.iter()
        .find(|entry| entry.role != ServerRole::Linter)
        .or_else(|| all.first())
        .copied()
}

/// Every catalog entry serving a given LSP `languageId`, in catalog order.
/// The frontend's `active-servers` picks one TypeChecker plus an optional
/// Linter from this set based on per-project settings.
pub fn lookup_all(language_id: &str) -> Vec<&'static CatalogEntry> {
    CATALOG
        .iter()
        .filter(|entry| entry.language_ids.contains(&language_id))
        .collect()
}

/// Look up a catalog entry by its stable `lsp_id`. Used by the session and
/// root endpoints when the renderer asks for a specific server.
pub fn lookup_by_id(lsp_id: &str) -> Option<&'static CatalogEntry> {
    CATALOG.iter().find(|entry| entry.lsp_id == lsp_id)
}

impl CatalogEntry {
    /// Build a `DiscoverySpec` that `cli-discovery` consumes.
    pub fn discovery_spec(&self) -> DiscoverySpec {
        DiscoverySpec {
            bin_name: self.bin_name,
            well_known_relative_to_home: self.well_known_relative_to_home.to_vec(),
            well_known_absolute: self.well_known_absolute.to_vec(),
            version_args: self.version_args,
            version_must_contain: self.version_must_contain,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn typescript_family_maps_to_tsserver() {
        let entry = lookup("typescript").expect("typescript");
        assert_eq!(entry.lsp_id, "typescript-language-server");
        assert!(entry.language_ids.contains(&"typescriptreact"));
    }

    #[test]
    fn typescript_language_server_has_managed_npm_recipe() {
        let entry = lookup("typescriptreact").expect("typescriptreact");
        let recipe = entry.download.as_ref().expect("managed installer");
        let DownloadRecipe::NpmPackage { version, packages } = recipe else {
            panic!("typescript-language-server should install through npm");
        };
        assert_eq!(*version, "5.3.0");
        assert_eq!(
            *packages,
            &["typescript-language-server@5.3.0", "typescript@6.0.3",]
        );
    }

    #[test]
    fn npm_managed_language_servers_are_registered() {
        let cases = [
            (
                "json",
                "json-language-server",
                "vscode-json-language-server",
            ),
            (
                "jsonc",
                "json-language-server",
                "vscode-json-language-server",
            ),
            ("yaml", "yaml-language-server", "yaml-language-server"),
            (
                "html",
                "html-language-server",
                "vscode-html-language-server",
            ),
            ("css", "css-language-server", "vscode-css-language-server"),
            ("scss", "css-language-server", "vscode-css-language-server"),
            ("less", "css-language-server", "vscode-css-language-server"),
            ("svelte", "svelte-language-server", "svelteserver"),
            ("vue", "vue-language-server", "vue-language-server"),
            ("astro", "astro-ls", "astro-ls"),
            (
                "shellscript",
                "bash-language-server",
                "bash-language-server",
            ),
            ("dockerfile", "docker-langserver", "docker-langserver"),
        ];

        for (language_id, lsp_id, bin_name) in cases {
            let entry = lookup(language_id).expect(language_id);
            assert_eq!(entry.lsp_id, lsp_id);
            assert_eq!(entry.bin_name, bin_name);
            assert!(
                matches!(entry.download, Some(DownloadRecipe::NpmPackage { .. })),
                "{lsp_id} should install through npm"
            );
        }
    }

    #[test]
    fn rust_resolves_to_rust_analyzer() {
        let entry = lookup("rust").expect("rust");
        assert_eq!(entry.bin_name, "rust-analyzer");
        assert!(entry.download.is_some());
    }

    #[test]
    fn unknown_language_returns_none() {
        assert!(lookup("brainfuck").is_none());
    }

    #[test]
    fn no_duplicate_language_id_per_server() {
        // The Phase-4 model: a language is served by several *alternative*
        // entries the user selects between (one type checker + one linter), so
        // the old "one entry per language" invariant is gone. What must still
        // hold is that a single server never lists the same language twice and
        // that every (lsp_id, language_id) pair is unique across the catalog —
        // otherwise selection by id+language would be ambiguous.
        let mut seen = std::collections::HashSet::new();
        for entry in CATALOG {
            for lang in entry.language_ids {
                assert!(
                    seen.insert((entry.lsp_id, *lang)),
                    "(lsp_id {:?}, language id {lang:?}) appears more than once",
                    entry.lsp_id
                );
            }
        }
    }

    #[test]
    fn type_checkers_are_selectable_alternatives_for_ts() {
        // tsgo and typescript-language-server intentionally share role + langs:
        // they're alternatives chosen via `editor_typescript_server`. Confirm
        // both exist as TypeCheckers for typescript so selection has options.
        let ts_checkers: Vec<&str> = lookup_all("typescript")
            .iter()
            .filter(|e| e.role == ServerRole::TypeChecker)
            .map(|e| e.lsp_id)
            .collect();
        assert!(ts_checkers.contains(&"typescript-language-server"));
        assert!(ts_checkers.contains(&"tsgo"));
    }

    #[test]
    fn lookup_skips_linters_for_default() {
        // The default (`lookup`) for a TS file must be the type checker, never
        // a linter, even though several linters also serve TS.
        let entry = lookup("typescript").expect("typescript");
        assert_eq!(entry.role, ServerRole::TypeChecker);
        assert_eq!(entry.lsp_id, "typescript-language-server");
    }

    #[test]
    fn lookup_all_returns_every_server_for_language() {
        let ids: Vec<&str> = lookup_all("typescript").iter().map(|e| e.lsp_id).collect();
        for expected in [
            "typescript-language-server",
            "tsgo",
            "biome",
            "eslint",
            "oxlint",
        ] {
            assert!(
                ids.contains(&expected),
                "lookup_all(typescript) missing {expected}; got {ids:?}"
            );
        }
    }

    #[test]
    fn lookup_by_id_resolves_concrete_servers() {
        assert_eq!(lookup_by_id("tsgo").expect("tsgo").bin_name, "tsgo");
        assert_eq!(
            lookup_by_id("biome").expect("biome").role,
            ServerRole::Linter
        );
        assert!(lookup_by_id("does-not-exist").is_none());
    }

    #[test]
    fn new_servers_have_managed_npm_recipes() {
        for id in ["tsgo", "biome", "eslint", "oxlint"] {
            let entry = lookup_by_id(id).expect(id);
            assert!(
                matches!(entry.download, Some(DownloadRecipe::NpmPackage { .. })),
                "{id} should install through npm"
            );
        }
    }

    #[test]
    fn rust_analyzer_has_rustup_shim_guard() {
        // Regression: without this filter, a rustup-proxied
        // `~/.cargo/bin/rust-analyzer` whose component isn't installed
        // shadows the managed install and every LSP request hangs.
        let entry = lookup("rust").expect("rust");
        assert_eq!(entry.version_must_contain, Some("rust-analyzer"));
    }

    #[test]
    fn typescript_family_roots_at_tsconfig_first() {
        let entry = lookup("typescript").expect("typescript");
        assert_eq!(
            entry.root_markers,
            &["tsconfig.json", "jsconfig.json", "package.json"]
        );
    }

    #[test]
    fn rust_roots_at_cargo_toml() {
        let entry = lookup("rust").expect("rust");
        assert_eq!(entry.root_markers, &["Cargo.toml"]);
    }

    #[test]
    fn config_languages_have_no_root_markers() {
        for lang in ["json", "yaml", "css", "html"] {
            let entry = lookup(lang).expect(lang);
            assert!(
                entry.root_markers.is_empty(),
                "{lang} should fall back to the feature root"
            );
        }
    }

    #[test]
    fn no_duplicate_lsp_ids() {
        let mut seen = std::collections::HashSet::new();
        for entry in CATALOG {
            assert!(
                seen.insert(entry.lsp_id),
                "lsp_id {:?} appears twice in catalog",
                entry.lsp_id
            );
        }
    }
}
