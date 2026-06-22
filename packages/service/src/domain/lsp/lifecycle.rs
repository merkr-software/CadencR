//! Lifecycle policies layered on top of the proxy.
//!
//! - **Crash backoff**: tracks per-`(workspace_root, language_id)` failures
//!   and refuses to spawn within an exponential cooldown window. Stops a
//!   broken rust-analyzer from being relaunched 100×/minute when the
//!   renderer reconnects on every WS error.
//! - **Idle shutdown**: returned by [`CrashTracker::watcher`] as a future
//!   the proxy can race against. When no LSP traffic crosses the WS for
//!   `IDLE_TIMEOUT`, the future resolves and the proxy tears down. (The
//!   browser tab can keep an LSP child alive forever otherwise.)
//!
//! Both pieces are intentionally in-memory and per-process. Persistent
//! state would invite the question "what does 'crash count = 7' mean
//! across an app restart?", which there's no good answer to.

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Arc;
use std::time::{Duration, Instant};

use tokio::sync::Mutex;

/// How long an idle proxy can sit before we kill the child. An *open editor*
/// is not "idle" — the user may be reading without typing for long stretches —
/// so 30 minutes avoids tearing the server out from under a live buffer (which
/// previously stranded Cmd-click with no reconnect). Long enough to span a
/// reading/meeting break; short enough that a forgotten tab doesn't keep a
/// language server resident forever.
pub const IDLE_TIMEOUT: Duration = Duration::from_secs(30 * 60);

/// Backoff schedule: `2^min(fails, 6)` seconds, capped at ~1 minute. After
/// 6 failures in a row, callers wait 64s between attempts — long enough
/// that a misconfigured server doesn't spin up a fork-bomb of children,
/// short enough that a one-off network blip doesn't lock the user out.
const BACKOFF_CAP_SECONDS: u32 = 64;

/// Inside this window after spawn, a child exit counts as a "crash" for
/// backoff purposes. Past that, the user has had a working LSP session
/// long enough that we treat the death as benign (likely they closed the
/// last tab using it).
pub const CRASH_WINDOW: Duration = Duration::from_secs(10);

#[derive(Debug, Clone)]
struct CrashEntry {
    fail_count: u32,
    next_allowed_at: Instant,
}

/// Key into the crash table. Same shape as the proxy spawn inputs so
/// callers don't have to translate.
#[derive(Debug, Clone, Hash, Eq, PartialEq)]
pub struct CrashKey {
    pub workspace_root: PathBuf,
    pub language_id: String,
}

/// Concurrent-safe per-`(workspace, language)` failure tracker.
///
/// Lives in [`AppState`](crate::app_state::AppState) so every request
/// shares it. Cloning is cheap (`Arc`).
#[derive(Debug, Default)]
pub struct CrashTracker {
    inner: Mutex<HashMap<CrashKey, CrashEntry>>,
}

impl CrashTracker {
    pub fn new() -> Arc<Self> {
        Arc::new(Self::default())
    }

    /// `Ok(())` if a new spawn is allowed; `Err(duration_remaining)` if
    /// the caller should wait. Callers turn the error into a user-facing
    /// 503 with a Retry-After hint.
    pub async fn check(&self, key: &CrashKey) -> Result<(), Duration> {
        let inner = self.inner.lock().await;
        if let Some(entry) = inner.get(key) {
            let now = Instant::now();
            if now < entry.next_allowed_at {
                return Err(entry.next_allowed_at - now);
            }
        }
        Ok(())
    }

    /// Record a crash that happened within [`CRASH_WINDOW`] of spawn.
    /// Increments the fail counter and arms the next backoff window.
    pub async fn record_crash(&self, key: CrashKey) {
        let mut inner = self.inner.lock().await;
        let entry = inner.entry(key).or_insert(CrashEntry {
            fail_count: 0,
            next_allowed_at: Instant::now(),
        });
        entry.fail_count = entry.fail_count.saturating_add(1);
        let wait = backoff_for(entry.fail_count);
        entry.next_allowed_at = Instant::now() + wait;
    }

    /// Clear the failure history for `key` — call this when a session
    /// runs long enough to be considered "healthy" so a later transient
    /// failure doesn't inherit ancient backoff.
    pub async fn record_success(&self, key: &CrashKey) {
        let mut inner = self.inner.lock().await;
        inner.remove(key);
    }
}

fn backoff_for(fail_count: u32) -> Duration {
    let seconds = 1u32 << fail_count.min(6);
    Duration::from_secs(seconds.min(BACKOFF_CAP_SECONDS) as u64)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn key(lang: &str) -> CrashKey {
        CrashKey {
            workspace_root: PathBuf::from("/tmp/x"),
            language_id: lang.into(),
        }
    }

    #[tokio::test]
    async fn fresh_key_is_allowed() {
        let t = CrashTracker::new();
        assert!(t.check(&key("rust")).await.is_ok());
    }

    #[tokio::test]
    async fn first_crash_arms_short_backoff() {
        let t = CrashTracker::new();
        t.record_crash(key("rust")).await;
        let err = t.check(&key("rust")).await.unwrap_err();
        // First failure -> 2^1 = 2s cooldown
        assert!(err >= Duration::from_millis(1500));
        assert!(err <= Duration::from_secs(3));
    }

    #[tokio::test]
    async fn backoff_grows_with_repeated_failures() {
        let t = CrashTracker::new();
        for _ in 0..3 {
            t.record_crash(key("rust")).await;
        }
        let err = t.check(&key("rust")).await.unwrap_err();
        // 3 crashes -> 2^3 = 8s cooldown
        assert!(err >= Duration::from_secs(6));
        assert!(err <= Duration::from_secs(9));
    }

    #[tokio::test]
    async fn backoff_caps_at_one_minute() {
        let t = CrashTracker::new();
        for _ in 0..20 {
            t.record_crash(key("rust")).await;
        }
        let err = t.check(&key("rust")).await.unwrap_err();
        assert!(err <= Duration::from_secs(BACKOFF_CAP_SECONDS as u64 + 1));
    }

    #[tokio::test]
    async fn record_success_clears_backoff() {
        let t = CrashTracker::new();
        t.record_crash(key("rust")).await;
        t.record_success(&key("rust")).await;
        assert!(t.check(&key("rust")).await.is_ok());
    }

    #[tokio::test]
    async fn different_keys_track_independently() {
        let t = CrashTracker::new();
        t.record_crash(key("rust")).await;
        assert!(t.check(&key("typescript")).await.is_ok());
        assert!(t.check(&key("rust")).await.is_err());
    }
}
