//! Provider-neutral formatter catalog.
//!
//! Each formatter is a CLI that reads source on stdin and writes the formatted
//! result to stdout, so the renderer can apply the result to its buffer without
//! the host touching the file (no race with an unsaved buffer). Selection is
//! driven by the per-project `editor_formatter` setting on the frontend; the
//! host only maps the chosen id to a binary + args and runs it.
//!
//! Generic call sites must consult this table rather than branch on formatter
//! identity — adding a formatter is one row here plus one frontend option.

use cli_discovery::DiscoverySpec;

/// One formatter's invocation recipe.
#[derive(Debug, Clone, Copy)]
pub struct FormatterEntry {
    /// Stable id, matching the `editor_formatter` setting value.
    pub id: &'static str,
    /// Bare binary name on `$PATH` / well-known dirs.
    pub bin_name: &'static str,
    /// Args before the `{path}` placeholder. The formatted file's path is
    /// passed so stdin-aware formatters can pick the right parser; the source
    /// itself arrives on stdin.
    pub args_before_path: &'static [&'static str],
    /// The CLI flag that takes the file path (e.g. `--stdin-filepath`). The
    /// path value is appended as the next arg. Empty means "don't pass a path".
    pub path_flag: &'static str,
    /// Args after the path flag + value.
    pub args_after_path: &'static [&'static str],
    /// `--version`-style probe args used by `cli-discovery`.
    pub version_args: &'static [&'static str],
}

const NPM_WELL_KNOWN_RELATIVE_TO_HOME: &[&str] = &[
    ".bun/bin",
    ".npm-global/bin",
    ".volta/bin",
    "Library/pnpm",
    ".cadencr-tools/node_modules/.bin",
];
const WELL_KNOWN_ABSOLUTE: &[&str] = &["/opt/homebrew/bin", "/usr/local/bin"];

/// The static formatter catalog. `off` is intentionally absent — the frontend
/// never POSTs a format request when formatting is disabled.
pub const FORMATTERS: &[FormatterEntry] = &[
    // Prettier: stdin source + `--stdin-filepath` so it infers the parser.
    FormatterEntry {
        id: "prettier",
        bin_name: "prettier",
        args_before_path: &[],
        path_flag: "--stdin-filepath",
        args_after_path: &[],
        version_args: &["--version"],
    },
    // Biome: `format` subcommand reading stdin with `--stdin-file-path`.
    FormatterEntry {
        id: "biome",
        bin_name: "biome",
        args_before_path: &["format"],
        path_flag: "--stdin-file-path",
        args_after_path: &[],
        version_args: &["--version"],
    },
    // oxfmt: reads stdin, writes formatted output to stdout. It infers the
    // syntax from the path passed via `--stdin-file-name`.
    FormatterEntry {
        id: "oxfmt",
        bin_name: "oxfmt",
        args_before_path: &[],
        path_flag: "--stdin-file-name",
        args_after_path: &[],
        version_args: &["--version"],
    },
];

/// Look up a formatter recipe by its `editor_formatter` setting value.
pub fn lookup(id: &str) -> Option<&'static FormatterEntry> {
    FORMATTERS.iter().find(|f| f.id == id)
}

impl FormatterEntry {
    /// Build the full argv (excluding the binary itself) for a given file path.
    pub fn build_args(&self, file_path: &str) -> Vec<String> {
        let mut args: Vec<String> = self
            .args_before_path
            .iter()
            .map(|s| s.to_string())
            .collect();
        if !self.path_flag.is_empty() {
            args.push(self.path_flag.to_string());
            args.push(file_path.to_string());
        }
        args.extend(self.args_after_path.iter().map(|s| s.to_string()));
        args
    }

    /// `DiscoverySpec` for finding the formatter binary via `cli-discovery`.
    pub fn discovery_spec(&self) -> DiscoverySpec {
        DiscoverySpec {
            bin_name: self.bin_name,
            well_known_relative_to_home: NPM_WELL_KNOWN_RELATIVE_TO_HOME.to_vec(),
            well_known_absolute: WELL_KNOWN_ABSOLUTE.to_vec(),
            version_args: self.version_args,
            version_must_contain: None,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn lookup_resolves_known_formatters() {
        for id in ["prettier", "biome", "oxfmt"] {
            assert_eq!(lookup(id).expect(id).id, id);
        }
    }

    #[test]
    fn lookup_rejects_off_and_unknown() {
        assert!(lookup("off").is_none());
        assert!(lookup("eslint").is_none());
    }

    #[test]
    fn no_duplicate_ids() {
        let mut seen = std::collections::HashSet::new();
        for f in FORMATTERS {
            assert!(seen.insert(f.id), "duplicate formatter id {:?}", f.id);
        }
    }

    #[test]
    fn build_args_inserts_path_flag_and_value() {
        let prettier = lookup("prettier").unwrap();
        assert_eq!(
            prettier.build_args("/repo/a.ts"),
            vec!["--stdin-filepath".to_string(), "/repo/a.ts".to_string()]
        );

        let biome = lookup("biome").unwrap();
        assert_eq!(
            biome.build_args("/repo/a.ts"),
            vec![
                "format".to_string(),
                "--stdin-file-path".to_string(),
                "/repo/a.ts".to_string(),
            ]
        );
    }
}
