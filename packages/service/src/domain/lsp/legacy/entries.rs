use super::{CatalogEntry, LegacyInstall, ServerRole};
use std::sync::LazyLock;

pub(in crate::domain::lsp) const NPM_WELL_KNOWN_RELATIVE_TO_HOME: &[&str] = &[
    ".bun/bin",
    ".npm-global/bin",
    ".volta/bin",
    // pnpm's global bin: macOS, then Linux (`$XDG_DATA_HOME` default).
    "Library/pnpm",
    ".local/share/pnpm",
    ".cadencr-tools/node_modules/.bin",
];
/// Homebrew (macOS), then distro packages and snaps (Linux).
pub(in crate::domain::lsp) const SYSTEM_WELL_KNOWN_ABSOLUTE: &[&str] = &[
    "/opt/homebrew/bin",
    "/usr/local/bin",
    "/usr/bin",
    "/snap/bin",
];

/// Root markers for the JS/TS family (and TS-backed frameworks). Prefer the
/// most specific config first so a nested package roots there rather than at
/// the monorepo's top-level `package.json`.
const JS_TS_ROOT_MARKERS: &[&str] = &["tsconfig.json", "jsconfig.json", "package.json"];

/// Config-file language servers (json/yaml/html/css/shell/docker) have no
/// meaningful per-package root — they reason about a single file — so they
/// fall back to the feature working dir.
const NO_ROOT_MARKERS: &[&str] = &[];

#[bon::builder]
fn npm_catalog_entry(
    lsp_id: &'static str,
    role: ServerRole,
    language_ids: &'static [&'static str],
    root_markers: &'static [&'static str],
    bin_name: &'static str,
    args: &'static [&'static str],
    version: &'static str,
) -> CatalogEntry {
    CatalogEntry {
        lsp_id,
        role,
        language_ids,
        root_markers,
        bin_name,
        args,
        well_known_relative_to_home: NPM_WELL_KNOWN_RELATIVE_TO_HOME,
        well_known_absolute: SYSTEM_WELL_KNOWN_ABSOLUTE,
        version_args: &["--version"],
        version_must_contain: None,
        legacy_install: Some(LegacyInstall::Npm { version }),
    }
}

/// The static catalog. Order doesn't matter — lookup is by `language_id`.
pub static CATALOG: LazyLock<Vec<CatalogEntry>> = LazyLock::new(|| {
    vec![
        npm_catalog_entry()
            .lsp_id("typescript-language-server")
            .role(ServerRole::TypeChecker)
            .language_ids(&[
                "typescript",
                "typescriptreact",
                "javascript",
                "javascriptreact",
            ])
            .root_markers(JS_TS_ROOT_MARKERS)
            .bin_name("typescript-language-server")
            .args(&["--stdio"])
            .version("5.3.0")
            .call(),
        // `tsgo`, the Go-native TypeScript compiler's language server. Same TS
        // family as `typescript-language-server` but role-distinct, so both can
        // coexist in the catalog (selection picks one via `editor_typescript_server`).
        // native-preview exposes the LSP over stdio with `tsgo --lsp -stdio`.
        npm_catalog_entry()
            .lsp_id("tsgo")
            .role(ServerRole::TypeChecker)
            .language_ids(&[
                "typescript",
                "typescriptreact",
                "javascript",
                "javascriptreact",
            ])
            .root_markers(JS_TS_ROOT_MARKERS)
            .bin_name("tsgo")
            .args(&["--lsp", "-stdio"])
            .version("7.0.0-dev.20250609.1")
            .call(),
        // Biome: linter + formatter for the JS/TS/JSON family. `biome lsp-proxy`
        // speaks LSP over stdio. Role Linter (it also formats, surfaced through
        // the formatter catalog rather than a second LSP entry).
        npm_catalog_entry()
            .lsp_id("biome")
            .role(ServerRole::Linter)
            .language_ids(&[
                "typescript",
                "typescriptreact",
                "javascript",
                "javascriptreact",
                "json",
                "jsonc",
            ])
            .root_markers(JS_TS_ROOT_MARKERS)
            .bin_name("biome")
            .args(&["lsp-proxy"])
            .version("1.9.4")
            .call(),
        // ESLint language server. Flat-config (`eslint.config.js`) is auto-detected
        // by recent versions; legacy `.eslintrc*` still works. Role Linter.
        npm_catalog_entry()
            .lsp_id("eslint")
            .role(ServerRole::Linter)
            .language_ids(&[
                "typescript",
                "typescriptreact",
                "javascript",
                "javascriptreact",
            ])
            .root_markers(JS_TS_ROOT_MARKERS)
            .bin_name("vscode-eslint-language-server")
            .args(&["--stdio"])
            .version("4.10.0")
            .call(),
        // oxlint's language server (`oxc_language_server`). Role Linter.
        npm_catalog_entry()
            .lsp_id("oxlint")
            .role(ServerRole::Linter)
            .language_ids(&[
                "typescript",
                "typescriptreact",
                "javascript",
                "javascriptreact",
            ])
            .root_markers(JS_TS_ROOT_MARKERS)
            .bin_name("oxc_language_server")
            .args(&[])
            .version("0.16.0")
            .call(),
        npm_catalog_entry()
            .lsp_id("json-language-server")
            .role(ServerRole::General)
            .language_ids(&["json", "jsonc"])
            .root_markers(NO_ROOT_MARKERS)
            .bin_name("vscode-json-language-server")
            .args(&["--stdio"])
            .version("4.10.0")
            .call(),
        npm_catalog_entry()
            .lsp_id("yaml-language-server")
            .role(ServerRole::General)
            .language_ids(&["yaml"])
            .root_markers(NO_ROOT_MARKERS)
            .bin_name("yaml-language-server")
            .args(&["--stdio"])
            .version("1.23.0")
            .call(),
        npm_catalog_entry()
            .lsp_id("html-language-server")
            .role(ServerRole::General)
            .language_ids(&["html"])
            .root_markers(NO_ROOT_MARKERS)
            .bin_name("vscode-html-language-server")
            .args(&["--stdio"])
            .version("4.10.0")
            .call(),
        npm_catalog_entry()
            .lsp_id("css-language-server")
            .role(ServerRole::General)
            .language_ids(&["css", "scss", "less"])
            .root_markers(NO_ROOT_MARKERS)
            .bin_name("vscode-css-language-server")
            .args(&["--stdio"])
            .version("4.10.0")
            .call(),
        npm_catalog_entry()
            .lsp_id("svelte-language-server")
            .role(ServerRole::TypeChecker)
            .language_ids(&["svelte"])
            .root_markers(JS_TS_ROOT_MARKERS)
            .bin_name("svelteserver")
            .args(&["--stdio"])
            .version("0.18.0")
            .call(),
        npm_catalog_entry()
            .lsp_id("vue-language-server")
            .role(ServerRole::TypeChecker)
            .language_ids(&["vue"])
            .root_markers(JS_TS_ROOT_MARKERS)
            .bin_name("vue-language-server")
            .args(&["--stdio"])
            .version("3.3.1")
            .call(),
        npm_catalog_entry()
            .lsp_id("astro-ls")
            .role(ServerRole::TypeChecker)
            .language_ids(&["astro"])
            .root_markers(JS_TS_ROOT_MARKERS)
            .bin_name("astro-ls")
            .args(&["--stdio"])
            .version("2.16.9")
            .call(),
        npm_catalog_entry()
            .lsp_id("bash-language-server")
            .role(ServerRole::General)
            .language_ids(&["shellscript"])
            .root_markers(NO_ROOT_MARKERS)
            .bin_name("bash-language-server")
            .args(&["start"])
            .version("5.6.0")
            .call(),
        npm_catalog_entry()
            .lsp_id("docker-langserver")
            .role(ServerRole::General)
            .language_ids(&["dockerfile"])
            .root_markers(NO_ROOT_MARKERS)
            .bin_name("docker-langserver")
            .args(&["--stdio"])
            .version("0.15.0")
            .call(),
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
            well_known_absolute: SYSTEM_WELL_KNOWN_ABSOLUTE,
            version_args: &["--version"],
            // Reject rustup shims that don't have the component installed.
            version_must_contain: Some("rust-analyzer"),
            legacy_install: Some(LegacyInstall::Native {
                version: "2026-05-18",
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
            well_known_absolute: SYSTEM_WELL_KNOWN_ABSOLUTE,
            version_args: &["version"],
            version_must_contain: None,
            legacy_install: None,
        },
        CatalogEntry {
            lsp_id: "pyright",
            role: ServerRole::TypeChecker,
            language_ids: &["python"],
            root_markers: &[
                "pyproject.toml",
                "setup.py",
                "setup.cfg",
                "requirements.txt",
            ],
            bin_name: "pyright-langserver",
            args: &["--stdio"],
            well_known_relative_to_home: NPM_WELL_KNOWN_RELATIVE_TO_HOME,
            well_known_absolute: SYSTEM_WELL_KNOWN_ABSOLUTE,
            version_args: &["--version"],
            version_must_contain: None,
            legacy_install: None,
        },
    ]
});
