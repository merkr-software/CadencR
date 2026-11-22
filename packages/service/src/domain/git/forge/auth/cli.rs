//! CLI credential discovery. Process output is secret even on failure.

use std::collections::HashMap;
use std::future::Future;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::{Mutex, OnceLock, PoisonError};
use std::time::{Duration, Instant};

use cli_discovery::{discover_all, select_best, DiscoverySpec};
use tokio::sync::OnceCell;

use super::{normalize_hostname, ForgeError};
use crate::domain::git::host::GitHost;
use crate::shared::bounded_command::{capture_bounded, BoundedCommandError};
use crate::shared::singleflight::Singleflight;

const CLI_TIMEOUT: Duration = Duration::from_secs(10);
const CLI_TOKEN_TTL: Duration = Duration::from_secs(60);

#[derive(Debug, Clone, Hash, PartialEq, Eq)]
struct CliTokenKey {
    binary: &'static str,
    hostname: String,
}

#[derive(Clone)]
struct CachedToken {
    token: String,
    fetched_at: Instant,
}

type SharedCliOutcome = Result<Option<String>, ForgeError>;

#[derive(Default)]
struct CliCacheState {
    entries: HashMap<CliTokenKey, CachedToken>,
    generation: u64,
}

struct CliTokenCache {
    ttl: Duration,
    state: Mutex<CliCacheState>,
    in_flight: Singleflight<CliTokenKey, SharedCliOutcome>,
}

impl CliTokenCache {
    fn new(ttl: Duration) -> Self {
        Self {
            ttl,
            state: Mutex::new(CliCacheState::default()),
            in_flight: Singleflight::new(),
        }
    }

    fn invalidate_hostname(&self, hostname: &str) {
        let Ok(normalized) = normalize_hostname(hostname) else {
            return;
        };
        let mut state = self.state.lock().unwrap_or_else(PoisonError::into_inner);
        state.generation = state.generation.wrapping_add(1);
        state.entries.retain(|key, _| key.hostname != normalized);
    }

    fn fresh_token(&self, key: &CliTokenKey) -> Option<String> {
        let state = self.state.lock().unwrap_or_else(PoisonError::into_inner);
        state
            .entries
            .get(key)
            .filter(|cached| cached.fetched_at.elapsed() < self.ttl)
            .map(|cached| cached.token.clone())
    }

    async fn get_or_fetch<F, Fut>(
        &self,
        binary: &'static str,
        hostname: &str,
        mut fetch: F,
    ) -> SharedCliOutcome
    where
        F: FnMut() -> Fut,
        Fut: Future<Output = SharedCliOutcome>,
    {
        let key = CliTokenKey {
            binary,
            hostname: normalize_hostname(hostname)?,
        };
        if let Some(token) = self.fresh_token(&key) {
            return Ok(Some(token));
        }
        self.in_flight
            .run(key.clone(), || {
                let snapshot = {
                    let state = self.state.lock().unwrap_or_else(PoisonError::into_inner);
                    match state.entries.get(&key) {
                        Some(cached) if cached.fetched_at.elapsed() < self.ttl => {
                            Ok(cached.token.clone())
                        }
                        _ => Err(state.generation),
                    }
                };
                let key = key.clone();
                let work = match snapshot {
                    Ok(token) => Err(token),
                    Err(start_gen) => Ok((start_gen, fetch())),
                };
                async move {
                    let (start_gen, fut) = match work {
                        Err(token) => return Ok(Some(token)),
                        Ok(pair) => pair,
                    };
                    let outcome = fut.await;
                    if let Ok(Some(token)) = &outcome {
                        let mut state = self.state.lock().unwrap_or_else(PoisonError::into_inner);
                        if state.generation == start_gen {
                            state.entries.insert(
                                key,
                                CachedToken {
                                    token: token.clone(),
                                    fetched_at: Instant::now(),
                                },
                            );
                        }
                    }
                    outcome
                }
            })
            .await
    }
}

fn token_cache() -> &'static CliTokenCache {
    static CACHE: OnceLock<CliTokenCache> = OnceLock::new();
    CACHE.get_or_init(|| CliTokenCache::new(CLI_TOKEN_TTL))
}

/// Drop any cached CLI token for `hostname` (for example after auth settings
/// change or a forge rejects a cached CLI token).
pub(crate) fn invalidate_cli_token(hostname: &str) {
    token_cache().invalidate_hostname(hostname);
}

/// Resolve a CLI token for `(kind, hostname)`, sharing a short-TTL in-memory
/// cache so concurrent repo-group polls and PR image bursts do not repeatedly
/// spawn `gh` / `glab`.
pub(super) async fn cached_cli_token(
    kind: GitHost,
    hostname: &str,
) -> Result<Option<String>, ForgeError> {
    let binary = match kind {
        GitHost::GitHub => "gh",
        GitHost::GitLab => "glab",
        GitHost::Bitbucket => {
            return Err(ForgeError::Configuration(
                "Bitbucket has no supported CLI token source; enter an API token".into(),
            ));
        }
        GitHost::Other => {
            return Err(ForgeError::Configuration(
                "Choose a forge kind for this self-hosted remote".into(),
            ));
        }
    };
    token_cache()
        .get_or_fetch(binary, hostname, || fetch_cli_token(kind, hostname))
        .await
}

async fn fetch_cli_token(kind: GitHost, hostname: &str) -> Result<Option<String>, ForgeError> {
    let token = match kind {
        GitHost::GitHub => {
            let output = cli_output("gh", &["auth", "token", "--hostname", hostname]).await?;
            stdout_token("gh", &output)?
        }
        GitHost::GitLab => {
            let output = cli_output(
                "glab",
                &["auth", "status", "--hostname", hostname, "--show-token"],
            )
            .await?;
            parse_glab_token_output(&output).ok_or_else(|| {
                ForgeError::Authentication(
                    "glab authenticated successfully but did not expose a token".into(),
                )
            })?
        }
        GitHost::Bitbucket | GitHost::Other => unreachable!("checked before cache lookup"),
    };
    let trimmed = token.trim();
    Ok((!trimmed.is_empty()).then(|| trimmed.to_string()))
}

pub(super) async fn cli_output(
    binary: &'static str,
    args: &[&str],
) -> Result<std::process::Output, ForgeError> {
    let path = discover_forge_cli(binary).await?;
    run_cli_output(&path, binary, args, CLI_TIMEOUT).await
}

async fn run_cli_output(
    path: &Path,
    binary: &str,
    args: &[&str],
    timeout: Duration,
) -> Result<std::process::Output, ForgeError> {
    let mut command = tokio::process::Command::new(path);
    command
        .args(args)
        .env("NO_COLOR", "1")
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    let output = capture_bounded(command, timeout)
        .await
        .map_err(|error| classify_cli_error(binary, error))?;
    if !output.status.success() {
        return Err(authentication_failure(binary, &output));
    }
    Ok(output)
}

fn classify_cli_error(binary: &str, error: BoundedCommandError) -> ForgeError {
    let message = error.to_string();
    if message.starts_with("timed out") {
        ForgeError::Authentication(format!(
            "{binary} {message} while resolving credentials. Run {binary} auth login and try again."
        ))
    } else if error.is_output_exceeded() {
        ForgeError::Authentication(format!(
            "{binary} output exceeded limit while resolving credentials."
        ))
    } else {
        ForgeError::Configuration(format!(
            "Could not run {binary} for forge authentication: {message}"
        ))
    }
}

fn authentication_failure(binary: &str, output: &std::process::Output) -> ForgeError {
    // Authentication commands may print access tokens to either stream,
    // including on failure. Only the exit status is safe to expose or log.
    ForgeError::Authentication(format!(
        "{binary} did not return an authenticated token (exit {}). Run {binary} auth login and try again.",
        output.status
    ))
}

pub(super) fn stdout_token(
    binary: &str,
    output: &std::process::Output,
) -> Result<String, ForgeError> {
    std::str::from_utf8(&output.stdout)
        .map(|value| value.trim().to_string())
        .map_err(|_| ForgeError::Authentication(format!("{binary} returned a non-UTF-8 token")))
}

static GH_CLI_PATH: OnceCell<PathBuf> = OnceCell::const_new();
static GLAB_CLI_PATH: OnceCell<PathBuf> = OnceCell::const_new();

async fn discover_forge_cli(binary: &'static str) -> Result<PathBuf, ForgeError> {
    let cache = match binary {
        "gh" => &GH_CLI_PATH,
        "glab" => &GLAB_CLI_PATH,
        _ => {
            return Err(ForgeError::Configuration(format!(
                "Unsupported forge CLI: {binary}"
            )))
        }
    };
    let discovered = cache
        .get_or_try_init(|| async move {
            let spec = DiscoverySpec {
                bin_name: binary.to_string(),
                well_known_relative_to_home: vec![".local/bin".into()],
                well_known_absolute: vec![
                    "/opt/homebrew/bin".into(),
                    "/usr/local/bin".into(),
                    "/usr/bin".into(),
                ],
                version_args: vec!["--version".into()],
                version_must_contain: Some(binary.to_string()),
            };
            let candidates = discover_all(&spec, None).await;
            select_best(&candidates)
                .map(|candidate| candidate.path.clone())
                .ok_or_else(|| {
                    ForgeError::Configuration(format!(
                        "Could not find the {binary} CLI in PATH, the login-shell PATH, or common install directories"
                    ))
                })
        })
        .await?;
    Ok(discovered.clone())
}

fn parse_glab_token(output: &str) -> Option<String> {
    output.lines().find_map(|line| {
        let line = line.trim();
        let lowercase = line.to_ascii_lowercase();
        let marker = ["token found:", "token:"]
            .into_iter()
            .find(|marker| lowercase.contains(marker))?;
        let marker_start = lowercase.find(marker)?;
        let value = &line[marker_start + marker.len()..];
        let token = value.trim().trim_matches('\'').trim_matches('"');
        (!token.is_empty()).then(|| token.to_string())
    })
}

pub(super) fn parse_glab_token_output(output: &std::process::Output) -> Option<String> {
    parse_glab_token_streams(&output.stdout, &output.stderr)
}

// `glab auth status` renders its successful human-readable report to stderr,
// while older releases used stdout and labeled the value `Token:` rather than
// `Token found:`. Accept both streams so CLI reuse survives that format change.
fn parse_glab_token_streams(stdout: &[u8], stderr: &[u8]) -> Option<String> {
    [stdout, stderr]
        .into_iter()
        .filter_map(|stream| std::str::from_utf8(stream).ok())
        .find_map(parse_glab_token)
}

#[cfg(test)]
mod tests {
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::sync::Arc;

    use super::*;

    #[cfg(unix)]
    #[test]
    fn authentication_errors_never_include_cli_streams() {
        use std::os::unix::process::ExitStatusExt;
        let output = std::process::Output {
            status: std::process::ExitStatus::from_raw(256),
            stdout: b"ghp-stdout-secret".to_vec(),
            stderr: b"glpat-stderr-secret".to_vec(),
        };
        let error = authentication_failure("glab", &output).to_string();
        assert!(!error.contains("secret"));
        assert!(error.contains("glab auth login"));
    }

    #[test]
    fn parses_glab_status_token() {
        assert_eq!(
            parse_glab_token("✓ Logged in\n  Token: glpat-example\n").as_deref(),
            Some("glpat-example")
        );
    }

    #[test]
    fn parses_current_glab_status_token_from_stderr() {
        assert_eq!(
            parse_glab_token_streams(
                b"",
                b"gitlab.example.com\n  \xe2\x9c\x93 Token found: glpat-current\n"
            )
            .as_deref(),
            Some("glpat-current")
        );
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn hung_cli_times_out_and_kills_child_process() {
        let dir = tempfile::tempdir().unwrap();
        let pid_file = dir.path().join("child.pid");
        let script = format!("echo $$ > '{}' && exec sleep 30", pid_file.display());

        let err = run_cli_output(
            Path::new("/bin/sh"),
            "gh",
            &["-c", &script],
            Duration::from_millis(150),
        )
        .await
        .expect_err("hung CLI must time out");
        assert!(
            matches!(&err, ForgeError::Authentication(msg) if msg.contains("timed out")),
            "unexpected error: {err:?}"
        );

        // Give the kernel a brief window to reap the killed child.
        tokio::time::sleep(Duration::from_millis(80)).await;
        if let Ok(raw_pid) = std::fs::read_to_string(&pid_file) {
            if let Ok(pid) = raw_pid.trim().parse::<libc::pid_t>() {
                // SAFETY: signal 0 only probes process existence.
                let alive = unsafe { libc::kill(pid, 0) } == 0;
                assert!(!alive, "timed-out CLI child pid {pid} must be killed");
            }
        }
    }

    #[tokio::test]
    async fn cli_token_cache_deduplicates_within_ttl_and_invalidates() {
        let cache = Arc::new(CliTokenCache::new(Duration::from_millis(80)));
        let fetches = Arc::new(AtomicUsize::new(0));

        // Concurrent cold misses coalesce onto a single fetch.
        let started = Arc::new(tokio::sync::Notify::new());
        let release = Arc::new(tokio::sync::Notify::new());
        let mut tasks = Vec::new();
        for _ in 0..4 {
            let cache = Arc::clone(&cache);
            let fetches = Arc::clone(&fetches);
            let started = Arc::clone(&started);
            let release = Arc::clone(&release);
            tasks.push(tokio::spawn(async move {
                cache
                    .get_or_fetch("gh", "GitHub.com", || {
                        let fetches = Arc::clone(&fetches);
                        let started = Arc::clone(&started);
                        let release = Arc::clone(&release);
                        async move {
                            fetches.fetch_add(1, Ordering::SeqCst);
                            started.notify_one();
                            release.notified().await;
                            Ok(Some("tok-1".into()))
                        }
                    })
                    .await
            }));
        }
        started.notified().await;
        tokio::time::sleep(Duration::from_millis(15)).await;
        release.notify_waiters();
        for task in tasks {
            assert_eq!(task.await.unwrap().unwrap().as_deref(), Some("tok-1"));
        }
        assert_eq!(fetches.load(Ordering::SeqCst), 1);

        // Warm hit within TTL reuses cached token without fetching.
        let warm = cache
            .get_or_fetch("gh", "github.com", || {
                let fetches = Arc::clone(&fetches);
                async move {
                    fetches.fetch_add(1, Ordering::SeqCst);
                    Ok(Some("tok-2".into()))
                }
            })
            .await
            .unwrap();
        assert_eq!(warm.as_deref(), Some("tok-1"));
        assert_eq!(fetches.load(Ordering::SeqCst), 1);

        // Explicit invalidation forces a fresh fetch.
        cache.invalidate_hostname("github.com");
        let refreshed = cache
            .get_or_fetch("gh", "github.com", || {
                let fetches = Arc::clone(&fetches);
                async move {
                    fetches.fetch_add(1, Ordering::SeqCst);
                    Ok(Some("tok-2".into()))
                }
            })
            .await
            .unwrap();
        assert_eq!(refreshed.as_deref(), Some("tok-2"));
        assert_eq!(fetches.load(Ordering::SeqCst), 2);

        // After TTL expiry, a fresh fetch runs again.
        tokio::time::sleep(Duration::from_millis(100)).await;
        let expired = cache
            .get_or_fetch("gh", "github.com", || {
                let fetches = Arc::clone(&fetches);
                async move {
                    fetches.fetch_add(1, Ordering::SeqCst);
                    Ok(Some("tok-3".into()))
                }
            })
            .await
            .unwrap();
        assert_eq!(expired.as_deref(), Some("tok-3"));
        assert_eq!(fetches.load(Ordering::SeqCst), 3);
    }

    #[tokio::test]
    async fn invalidation_during_in_flight_fetch_does_not_cache_stale_token() {
        let cache = Arc::new(CliTokenCache::new(Duration::from_secs(60)));
        let started = Arc::new(tokio::sync::Notify::new());
        let release = Arc::new(tokio::sync::Notify::new());

        let stale_fetch = tokio::spawn({
            let cache = Arc::clone(&cache);
            let started = Arc::clone(&started);
            let release = Arc::clone(&release);
            async move {
                cache
                    .get_or_fetch("gh", "github.com", || {
                        let started = Arc::clone(&started);
                        let release = Arc::clone(&release);
                        async move {
                            started.notify_one();
                            release.notified().await;
                            Ok(Some("stale-tok".into()))
                        }
                    })
                    .await
            }
        });

        started.notified().await;
        // Invalidate while the CLI subprocess is still running.
        cache.invalidate_hostname("github.com");
        release.notify_one();

        assert_eq!(
            stale_fetch.await.unwrap().unwrap().as_deref(),
            Some("stale-tok")
        );

        // The next lookup must NOT read the stale token back from cache.
        let next = cache
            .get_or_fetch("gh", "github.com", || async {
                Ok(Some("fresh-tok".into()))
            })
            .await
            .unwrap();
        assert_eq!(next.as_deref(), Some("fresh-tok"));
    }
}
