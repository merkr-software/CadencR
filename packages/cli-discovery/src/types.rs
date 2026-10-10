//! Core data types for CLI discovery.

use std::path::PathBuf;

/// Per-provider configuration describing what to discover.
#[derive(Debug, Clone, bon::Builder)]
pub struct DiscoverySpec {
    /// Bare binary name, e.g. `"claude"` or `"opencode"`.
    pub bin_name: String,
    /// Directories relative to `$HOME` that often contain the binary
    /// (e.g. `".claude/local"`, `".bun/bin"`).
    pub well_known_relative_to_home: Vec<String>,
    /// Absolute directories that often contain the binary
    /// (e.g. `"/opt/homebrew/bin"`, `"/usr/local/bin"`).
    pub well_known_absolute: Vec<String>,
    /// Args to pass when querying the binary's version (typically `["--version"]`).
    pub version_args: Vec<String>,
    /// When `Some(needle)`, a candidate must satisfy all of:
    /// 1. its `--version` output contains `needle` (case-insensitive),
    /// 2. the output parses as a valid semver triple, and
    /// 3. the probe exits successfully.
    ///
    /// Otherwise the candidate is excluded.
    ///
    /// Defends against version-multiplexer shims that masquerade as the real
    /// binary. `rust-analyzer` installed via `rustup` is a symlink to the
    /// `rustup` proxy; depending on whether the rust-analyzer component is
    /// registered, the shim either prints rustup's own help (parses as
    /// rustup's `1.28.x` but doesn't mention "rust-analyzer") or prints
    /// `error: Unknown binary 'rust-analyzer' in official toolchain ...`
    /// (mentions the name in quotes but has no semver — unless the toolchain
    /// is pinned to a version such as `1.96.0`, whose name then supplies one;
    /// current rustup exits non-zero there). Either way the process never
    /// speaks JSON-RPC, so we need every check: the real rust-analyzer prints
    /// `rust-analyzer 0.3.x-standalone (commit)` and exits 0.
    pub version_must_contain: Option<String>,
}

/// A semver triple captured from `--version` output.
#[derive(Clone, Copy, Debug, Eq, PartialEq, Ord, PartialOrd, Hash)]
pub struct VersionKey(pub u64, pub u64, pub u64);

impl VersionKey {
    pub fn to_string_dotted(&self) -> String {
        format!("{}.{}.{}", self.0, self.1, self.2)
    }
}

/// Where a candidate was found. Ordered so higher-priority sources beat lower
/// ones during ties (override > login-shell PATH > env PATH > well-known dir).
#[derive(Clone, Copy, Debug, Eq, PartialEq, Ord, PartialOrd, Hash)]
pub enum CandidateSource {
    WellKnown,
    EnvPath,
    LoginShellPath,
    Override,
}

/// One discovered binary on disk.
#[derive(Clone, Debug)]
pub struct Candidate {
    /// Path as discovered (may be a symlink/shim).
    pub path: PathBuf,
    /// Resolved through symlinks. Used for dedupe.
    pub canonical: PathBuf,
    /// Parsed semver, if `--version` returned something we could parse.
    pub version: Option<VersionKey>,
    /// Where the candidate was discovered.
    pub source: CandidateSource,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn version_key_orders_naturally() {
        assert!(VersionKey(1, 4, 3) > VersionKey(1, 1, 65));
        assert!(VersionKey(2, 0, 0) > VersionKey(1, 99, 99));
    }

    #[test]
    fn source_priority_orders_override_highest() {
        assert!(CandidateSource::Override > CandidateSource::LoginShellPath);
        assert!(CandidateSource::LoginShellPath > CandidateSource::EnvPath);
        assert!(CandidateSource::EnvPath > CandidateSource::WellKnown);
    }

    #[test]
    fn discovery_spec_builder_defaults_version_filter_to_none() {
        let spec = DiscoverySpec::builder()
            .bin_name("thing".to_string())
            .well_known_relative_to_home(vec![".thing/bin".to_string()])
            .well_known_absolute(Vec::new())
            .version_args(vec!["--version".to_string()])
            .build();

        assert_eq!(spec.bin_name, "thing");
        assert_eq!(spec.version_must_contain, None);
    }
}
