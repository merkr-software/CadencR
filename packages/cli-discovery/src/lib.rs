//! Provider-neutral CLI binary discovery.
//!
//! Both the Claude and OpenCode SDKs need to find their CLI binary on disk.
//! On macOS in particular, when Cadencr is launched from Finder/Dock/Spotlight
//! the inherited PATH is just `/etc/paths` + `/etc/paths.d/*` and never sources
//! the user's `~/.zshrc` / `~/.bash_profile` — so well-known dirs like
//! `/opt/homebrew/bin`, `~/.bun/bin`, `~/.nvm/.../bin` etc. are invisible.
//!
//! This crate enumerates *every* candidate it can find, queries each one's
//! `--version`, and lets the caller pick the best (highest semver). It also
//! exposes the full candidate list so the host app can render a picker UI.

mod shell;
mod shell_exec;
mod types;
mod version;
mod walk;

#[cfg(test)]
mod tests_support;

pub use shell::login_shell_path;
pub use shell_exec::{login_shell_command, login_shell_exec_command, shell_quote};
pub use types::{Candidate, CandidateSource, DiscoverySpec, VersionKey};
pub use version::{parse_version_string, query_version};

use std::collections::HashSet;
use std::path::{Path, PathBuf};

use crate::version::{contains_ci, probe_version};
use crate::walk::{canonicalize_executable, walk_path_var, walk_well_known};

/// Enumerate every candidate binary on disk, in source order.
///
/// The optional `override_path`, if given and executable, is returned as the
/// sole candidate (with `CandidateSource::Override`). Otherwise this walks:
/// 1. `$PATH` — `EnvPath`
/// 2. The user's login-shell PATH (cached) — `LoginShellPath`
/// 3. `well_known_*` from the spec — `WellKnown`
///
/// All candidates are deduped by canonical path. Version is queried for each.
pub async fn discover_all(spec: &DiscoverySpec, override_path: Option<&Path>) -> Vec<Candidate> {
    if let Some(path) = override_path {
        if let Some(canonical) = canonicalize_executable(path) {
            // Probe the override. Apply the substring filter too — a shim
            // dressed as the requested binary still wouldn't speak the
            // expected protocol, so silently dropping it is safer than
            // honoring an override that will only fail downstream.
            let probe = probe_version(path, &spec.version_args).await;
            let accept = match (&probe, spec.version_must_contain.as_deref()) {
                // Filter set: require both the substring and a parsed semver.
                // The substring alone is too lax — the rustup shim's
                // "Unknown binary 'rust-analyzer'" error mentions the name
                // and would pass a contains-only check.
                (Some((version, raw)), Some(needle)) => {
                    contains_ci(raw, needle) && version.is_some()
                }
                // No filter, or subprocess failed entirely: keep behavior
                // unchanged (returns a possibly versionless candidate).
                _ => true,
            };
            if accept {
                return vec![Candidate {
                    path: path.to_path_buf(),
                    canonical,
                    version: probe.and_then(|(v, _)| v),
                    source: CandidateSource::Override,
                }];
            }
        }
    }

    let mut seen_canonical = HashSet::new();
    let mut candidates = Vec::new();

    // 1. $PATH (works in Terminal launches; usually stripped under GUI launch).
    let env_path = std::env::var_os("PATH");
    walk_path_var(
        env_path.as_deref(),
        &spec.bin_name,
        CandidateSource::EnvPath,
        &mut seen_canonical,
        &mut candidates,
    );

    // 2. Login-shell PATH (fixes macOS GUI launches).
    if let Some(login_path) = login_shell_path().await {
        walk_path_var(
            Some(std::ffi::OsStr::new(login_path.as_str())),
            &spec.bin_name,
            CandidateSource::LoginShellPath,
            &mut seen_canonical,
            &mut candidates,
        );
    }

    // 3. Well-known dirs (deterministic, no subprocess).
    let home_dir = std::env::var_os("HOME").map(PathBuf::from);
    walk_well_known(
        spec,
        home_dir.as_deref(),
        &mut seen_canonical,
        &mut candidates,
    );

    // Probe versions in parallel — each probe is an independent subprocess
    // with its own 5s timeout, so serial waits would compound badly when
    // multiple installs are present.
    let probes = futures::future::join_all(
        candidates
            .iter()
            .map(|candidate| probe_version(&candidate.path, &spec.version_args)),
    )
    .await;

    candidates
        .into_iter()
        .zip(probes)
        .filter_map(|(mut candidate, probe)| {
            if let Some(needle) = spec.version_must_contain.as_deref() {
                // Subprocess failed (timeout, missing exec bits we somehow
                // accepted earlier, etc.) → reject. The filter exists
                // specifically to weed out shims and we can't validate one
                // without its output.
                let (version, raw) = match &probe {
                    Some(parts) => parts,
                    None => return None,
                };
                // Require both substring AND parsed semver — see the doc
                // comment on `version_must_contain`. A shim's error message
                // can mention the binary name without producing a version.
                if !contains_ci(raw, needle) || version.is_none() {
                    return None;
                }
            }
            candidate.version = probe.and_then(|(v, _)| v);
            Some(candidate)
        })
        .collect()
}

/// Enumerate every directory `discover_all` would probe for the given spec.
/// Used by callers that need to surface a "we looked here" list in error
/// messages or onboarding UI without re-implementing PATH-walking.
pub async fn searched_dirs(spec: &DiscoverySpec) -> Vec<PathBuf> {
    let mut dirs = Vec::new();
    if let Some(path_var) = std::env::var_os("PATH") {
        dirs.extend(std::env::split_paths(&path_var));
    }
    if let Some(login_path) = login_shell_path().await {
        dirs.extend(std::env::split_paths(&login_path));
    }
    if let Some(home) = std::env::var_os("HOME").map(PathBuf::from) {
        for relative in &spec.well_known_relative_to_home {
            dirs.push(home.join(relative));
        }
    }
    for absolute in &spec.well_known_absolute {
        dirs.push(PathBuf::from(absolute));
    }
    dirs
}

/// Pick the best candidate by (version desc, source priority desc).
///
/// Candidates without a parsed version sort below those that have one. Ties
/// break on `CandidateSource` (Override > LoginShellPath > EnvPath > WellKnown).
pub fn select_best(candidates: &[Candidate]) -> Option<&Candidate> {
    candidates.iter().max_by(|a, b| {
        a.version
            .cmp(&b.version)
            .then_with(|| a.source.cmp(&b.source))
    })
}

/// Detect whether `nvim` is available on this machine.
///
/// Reuses the same discovery pipeline (env `$PATH` + cached login-shell
/// `$PATH` + well-known dirs) as the agent-CLI probes above, so a `nvim`
/// only visible from a login shell (e.g. installed via Homebrew but Cadencr
/// launched from Finder/Dock) is found the same way `NeovimManager::start`
/// will later resolve it when spawning the headless process.
pub async fn detect_nvim() -> bool {
    let spec = DiscoverySpec {
        bin_name: "nvim".to_string(),
        well_known_relative_to_home: vec![],
        well_known_absolute: vec![
            "/opt/homebrew/bin".to_string(),
            "/usr/local/bin".to_string(),
        ],
        version_args: vec!["--version".to_string()],
        version_must_contain: Some("NVIM".to_string()),
    };
    let candidates = discover_all(&spec, None).await;
    select_best(&candidates).is_some()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::tests_support::{dummy_spec, make_executable_with_body};
    use tempfile::TempDir;

    #[tokio::test]
    async fn detect_nvim_returns_true_when_binary_available() {
        let expected = std::process::Command::new("nvim")
            .arg("--version")
            .output()
            .is_ok();
        let detected = detect_nvim().await;
        assert_eq!(detected, expected);
    }

    #[test]
    fn select_best_picks_highest_version_then_highest_source() {
        let candidates = vec![
            Candidate {
                path: PathBuf::from("/a/thing"),
                canonical: PathBuf::from("/a/thing"),
                version: Some(VersionKey(1, 4, 3)),
                source: CandidateSource::WellKnown,
            },
            Candidate {
                path: PathBuf::from("/b/thing"),
                canonical: PathBuf::from("/b/thing"),
                version: Some(VersionKey(1, 1, 65)),
                source: CandidateSource::EnvPath,
            },
        ];
        assert_eq!(
            select_best(&candidates).unwrap().path,
            PathBuf::from("/a/thing")
        );

        let same_version = vec![
            Candidate {
                path: PathBuf::from("/a/thing"),
                canonical: PathBuf::from("/a/thing"),
                version: Some(VersionKey(1, 0, 0)),
                source: CandidateSource::WellKnown,
            },
            Candidate {
                path: PathBuf::from("/b/thing"),
                canonical: PathBuf::from("/b/thing"),
                version: Some(VersionKey(1, 0, 0)),
                source: CandidateSource::EnvPath,
            },
        ];
        // Same version → higher-priority source wins.
        assert_eq!(
            select_best(&same_version).unwrap().path,
            PathBuf::from("/b/thing")
        );
    }

    #[test]
    fn select_best_prefers_versioned_over_unversioned() {
        let candidates = vec![
            Candidate {
                path: PathBuf::from("/a/thing"),
                canonical: PathBuf::from("/a/thing"),
                version: None,
                source: CandidateSource::Override,
            },
            Candidate {
                path: PathBuf::from("/b/thing"),
                canonical: PathBuf::from("/b/thing"),
                version: Some(VersionKey(0, 0, 1)),
                source: CandidateSource::WellKnown,
            },
        ];
        assert_eq!(
            select_best(&candidates).unwrap().path,
            PathBuf::from("/b/thing")
        );
    }

    #[test]
    fn select_best_returns_none_for_empty() {
        assert!(select_best(&[]).is_none());
    }

    #[tokio::test]
    async fn discover_all_with_override_returns_only_override() {
        let dir = TempDir::new().unwrap();
        let path = make_executable_with_body(dir.path(), "thing", "#!/bin/sh\necho 1.2.3\n");
        let candidates = discover_all(&dummy_spec(), Some(&path)).await;
        assert_eq!(candidates.len(), 1);
        assert_eq!(candidates[0].source, CandidateSource::Override);
        assert_eq!(
            candidates[0].canonical,
            std::fs::canonicalize(&path).unwrap()
        );
        assert_eq!(candidates[0].version, Some(VersionKey(1, 2, 3)));
    }

    #[tokio::test]
    async fn discover_all_falls_through_when_override_missing() {
        // Bogus override: should NOT short-circuit; falls through to regular
        // discovery (which here finds nothing).
        let candidates = discover_all(&dummy_spec(), Some(Path::new("/nonexistent/thing"))).await;
        // We can't assert empty (PATH may have a real `thing`), but we can
        // assert no Override entry slipped in.
        assert!(candidates
            .iter()
            .all(|candidate| candidate.source != CandidateSource::Override));
    }

    #[tokio::test]
    async fn version_must_contain_rejects_shim_error_that_mentions_bin_name() {
        // Real-world: `~/.cargo/bin/rust-analyzer` is a rustup shim. When
        // the rust-analyzer component isn't registered as a proxy, rustup
        // prints `error: Unknown binary 'rust-analyzer' in official
        // toolchain ...` to stderr and exits 0. The error literally
        // contains the bin name, so a contains-only filter would accept it.
        // The semver requirement is what saves us.
        let dir = TempDir::new().unwrap();
        let shim = make_executable_with_body(
            dir.path(),
            "rust-analyzer",
            "#!/bin/sh\necho \"error: Unknown binary 'rust-analyzer' in official toolchain 'stable-aarch64-apple-darwin'.\" 1>&2\nexit 0\n",
        );
        let mut spec = dummy_spec();
        spec.bin_name = "rust-analyzer".to_string();
        spec.version_must_contain = Some("rust-analyzer".to_string());
        let via_override = discover_all(&spec, Some(&shim)).await;
        assert!(
            via_override.is_empty(),
            "rustup 'Unknown binary' shim must be rejected; got {via_override:?}"
        );
    }

    #[tokio::test]
    async fn version_must_contain_excludes_shim_candidates() {
        // Simulate the rust-analyzer/rustup shim case: the binary prints
        // rustup's help (which parses as a valid semver but is the wrong
        // tool). With `version_must_contain` set, the shim must be dropped.
        let dir = TempDir::new().unwrap();
        let shim = make_executable_with_body(
            dir.path(),
            "thing",
            "#!/bin/sh\necho 'rustup 1.28.2 (e4f3ad6f8 2025-04-28)' 1>&2\n",
        );
        // Real binary in its own dir — keep the TempDir bound or it'll be
        // dropped (and `real` deleted) before `discover_all` even runs.
        let real_dir = TempDir::new().unwrap();
        let real = make_executable_with_body(
            real_dir.path(),
            "thing",
            "#!/bin/sh\necho 'thing 0.3.2050-standalone'\n",
        );
        // Place the shim in an override slot; it must be rejected and we
        // fall through to standard discovery (which here finds nothing).
        let mut spec = dummy_spec();
        spec.version_must_contain = Some("thing".to_string());
        let via_override = discover_all(&spec, Some(&shim)).await;
        assert!(
            via_override.iter().all(|c| c.path != shim),
            "shim must not be selected via override path"
        );

        // The real binary's --version output contains "thing", so the
        // filter accepts it.
        let via_override_real = discover_all(&spec, Some(&real)).await;
        assert!(
            via_override_real.iter().any(|c| c.path == real),
            "real binary must pass the filter"
        );
    }

    #[tokio::test]
    async fn version_must_contain_keeps_real_binary_in_path_walk() {
        let path_dir = TempDir::new().unwrap();
        let shim_dir = TempDir::new().unwrap();
        // Real binary first on PATH.
        let _real =
            make_executable_with_body(path_dir.path(), "thing", "#!/bin/sh\necho 'thing 1.0.0'\n");
        // Shim later on PATH that pretends to be `thing` but prints rustup help.
        let _shim = make_executable_with_body(
            shim_dir.path(),
            "thing",
            "#!/bin/sh\necho 'rustup 1.28.2' 1>&2\n",
        );

        // Restrict $PATH for the duration of this test so we only see our
        // two synthetic dirs. The login-shell PATH cache may still pull in
        // others; we just assert that the real one is present and the shim
        // is absent.
        let original_path = std::env::var_os("PATH");
        let combined = format!(
            "{}:{}",
            path_dir.path().display(),
            shim_dir.path().display()
        );
        // SAFETY: tests run single-threaded under `tokio::test` runtime; we
        // restore the var before returning.
        // NOTE: env mutation is process-global and racy across parallel
        // tests; mark with cfg(any()) if flakes show up. For now it's
        // self-contained.
        unsafe {
            std::env::set_var("PATH", &combined);
        }

        let mut spec = dummy_spec();
        spec.version_must_contain = Some("thing".to_string());
        let found = discover_all(&spec, None).await;

        unsafe {
            match original_path {
                Some(p) => std::env::set_var("PATH", p),
                None => std::env::remove_var("PATH"),
            }
        }

        // Real binary survived the filter; the shim did not.
        assert!(
            found.iter().any(|c| c.path.starts_with(path_dir.path())),
            "real binary must be present"
        );
        assert!(
            found.iter().all(|c| !c.path.starts_with(shim_dir.path())),
            "shim must be filtered out"
        );
    }
}
