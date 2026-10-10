//! Version probing and semver parsing.

use std::path::Path;
use std::time::Duration;

use once_cell::sync::OnceCell;
use regex_lite::Regex;
use tokio::process::Command;

use crate::types::VersionKey;

/// Parse a semver triple out of a free-form `--version` string. Returns the
/// first match. Useful for both Claude (`1.2.3 (Claude Code)`) and OpenCode
/// (`opencode 1.4.3`).
pub fn parse_version_string(raw: &str) -> Option<VersionKey> {
    static MATCHER: OnceCell<Regex> = OnceCell::new();
    let regex = MATCHER.get_or_init(|| {
        Regex::new(r"\b(\d+)\.(\d+)\.(\d+)\b").expect("static semver regex compiles")
    });
    let captures = regex.captures(raw)?;
    Some(VersionKey(
        captures.get(1)?.as_str().parse().ok()?,
        captures.get(2)?.as_str().parse().ok()?,
        captures.get(3)?.as_str().parse().ok()?,
    ))
}

pub async fn query_version(command: &Path, args: &[&str]) -> Option<VersionKey> {
    let args: Vec<String> = args.iter().map(|arg| (*arg).to_string()).collect();
    probe_version(command, &args)
        .await
        .and_then(|probe| probe.version)
}

/// What one `--version` run printed and how it ended.
pub(crate) struct VersionProbe {
    pub(crate) version: Option<VersionKey>,
    output: String,
    success: bool,
}

impl VersionProbe {
    /// The `version_must_contain` shim guard (see `DiscoverySpec`).
    pub(crate) fn passes_filter(&self, needle: &str) -> bool {
        self.success && self.version.is_some() && contains_ci(&self.output, needle)
    }
}

/// Probe `command --args[..]`.
///
/// Returns `None` only when the subprocess itself fails (timeout, spawn
/// error). Any run that completes returns its output and exit status, even
/// when unparseable or failed, so the shim guard can inspect it.
pub(crate) async fn probe_version(command: &Path, args: &[String]) -> Option<VersionProbe> {
    let output = tokio::time::timeout(
        Duration::from_secs(5),
        Command::new(command).args(args).kill_on_drop(true).output(),
    )
    .await
    .ok()?
    .ok()?;

    // Combine streams so a single regex pass + single substring check
    // covers tools that print to either (rustup prints to stderr).
    let combined = format!(
        "{}\n{}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    );
    Some(VersionProbe {
        version: parse_version_string(&combined),
        output: combined,
        success: output.status.success(),
    })
}

fn contains_ci(haystack: &str, needle: &str) -> bool {
    haystack.to_lowercase().contains(&needle.to_lowercase())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::tests_support::make_executable_with_body;
    use tempfile::TempDir;

    #[test]
    fn parses_semver_anywhere_in_string() {
        assert_eq!(
            parse_version_string("opencode 1.4.3"),
            Some(VersionKey(1, 4, 3))
        );
        assert_eq!(
            parse_version_string("ERROR service=models.dev\n1.1.65\n"),
            Some(VersionKey(1, 1, 65))
        );
        assert_eq!(parse_version_string("no version here"), None);
    }

    #[tokio::test]
    async fn query_version_extracts_semver() {
        let dir = TempDir::new().unwrap();
        let path =
            make_executable_with_body(dir.path(), "thing", "#!/bin/sh\necho '2.7.1 build'\n");
        let version = query_version(&path, &["--version"]).await;
        assert_eq!(version, Some(VersionKey(2, 7, 1)));
    }

    #[tokio::test]
    async fn shim_guard_rejects_a_failed_probe_whose_error_names_a_version() {
        // Run the fixtures through `sh -c` rather than writing scripts: on
        // Linux, exec'ing a just-written file races with other tests' forks
        // (ETXTBSY), which surfaces as a failed probe.
        let sh = |script: &str| vec!["-c".to_string(), script.to_string()];
        // rustup with a toolchain pinned to `1.96.0`: the error mentions the
        // binary and a semver, but the shim exits non-zero.
        let shim = sh("echo \"error: Unknown binary 'rust-analyzer' in official toolchain '1.96.0-aarch64-apple-darwin'.\" 1>&2; exit 1");
        let probe = probe_version(Path::new("/bin/sh"), &shim).await.unwrap();
        assert_eq!(probe.version, Some(VersionKey(1, 96, 0)));
        assert!(!probe.passes_filter("rust-analyzer"));

        let real = sh("echo 'rust-analyzer 1.96.0 (abc 2026-05-25)'");
        let probe = probe_version(Path::new("/bin/sh"), &real).await.unwrap();
        assert!(probe.passes_filter("rust-analyzer"));
    }
}
