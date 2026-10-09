//! Context windows learned from the CLI itself.
//!
//! Claude Code advertises no context window in its model catalog or its `init`
//! message — the only authoritative source is `result.modelUsage[<model>]
//! .contextWindow`, which lands at the *end* of a turn. Banking every window
//! the CLI reports closes that gap for every later turn and session; the very
//! first turn on a model the bank has never seen runs with an unknown window
//! (the UI shows a pending meter). Windows are never inferred from model ids —
//! a `[1m]` marker or a family list goes stale with every new model.
//!
//! # Keys are the CLI's fully-qualified ids, never normalized
//!
//! `modelUsage` keys and the `init` message's model id share one namespace and
//! both preserve the `[1m]` beta marker (`claude-opus-5[1m]`). The *streaming*
//! model id does not — `message_start` reports the bare `claude-opus-5` even
//! when the 1M beta is active. Since `claude-opus-5` (200k) and
//! `claude-opus-5[1m]` (1M) are genuinely different windows, stripping or
//! fuzzy-matching the marker would conflate them, so lookups are exact and
//! `message_start` ids are deliberately never used as keys.

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::sync::RwLock;

use serde_json::Value;

use super::events::model_usage_windows;
use super::ClaudeCodeAdapter;
use crate::domain::settings_store;

pub(super) type LearnedWindows = BTreeMap<String, u64>;

const LEARNED_WINDOWS_FILE: &str = "claude-code-context-windows.json";

fn learned_windows_path() -> PathBuf {
    settings_store::dir::sibling_dir("cache").join(LEARNED_WINDOWS_FILE)
}

/// The persisted bank, or an empty one. A missing file is the normal first
/// run; an unreadable one is only a cache, so it is reported and relearned.
fn load_learned_windows(path: &Path) -> LearnedWindows {
    let content = match std::fs::read_to_string(path) {
        Ok(content) => content,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return LearnedWindows::new(),
        Err(error) => {
            tracing::warn!(%error, path = %path.display(), "failed to read learned Claude context windows; relearning");
            return LearnedWindows::new();
        }
    };
    serde_json::from_str::<LearnedWindows>(&content)
        .map(|windows| windows.into_iter().filter(|(_, window)| *window > 0).collect())
        .unwrap_or_else(|error| {
            tracing::warn!(%error, path = %path.display(), "learned Claude context windows are corrupt; relearning");
            LearnedWindows::new()
        })
}

fn save_learned_windows(path: &Path, windows: &LearnedWindows) {
    let result = serde_json::to_string_pretty(windows)
        .map_err(|error| error.to_string())
        .and_then(|content| {
            crate::shared::atomic_file::write_atomic(path, &content).map_err(|e| e.to_string())
        });
    if let Err(error) = result {
        // In-memory windows still serve this process; only the next restart
        // loses them, so a cache write failure is not worth failing a turn.
        tracing::warn!(%error, path = %path.display(), "failed to persist learned Claude context windows");
    }
}

impl ClaudeCodeAdapter {
    fn context_windows_cell(&self) -> &RwLock<LearnedWindows> {
        self.cached_context_windows
            .get_or_init(|| RwLock::new(load_learned_windows(&learned_windows_path())))
    }

    /// Learn every model's window from a raw `result` payload.
    ///
    /// Entries for models the turn merely touched (the CLI bills a background
    /// Haiku call on essentially every turn) are recorded too — they are just
    /// as authoritative, and keying by model id keeps them from being mistaken
    /// for the session's own window.
    pub(super) fn record_context_windows(&self, raw: &Value) {
        // Steady state is "every window already known", so probe under a read
        // lock and skip the write entirely — this lock is shared by every
        // session's stream reader.
        let cell = self.context_windows_cell();
        let unchanged = |guard: &LearnedWindows| {
            model_usage_windows(raw).all(|(model, window)| guard.get(model) == Some(&window))
        };
        match cell.read() {
            Ok(guard) if unchanged(&guard) => return,
            Ok(_) => {}
            Err(error) => {
                tracing::warn!(%error, "claude context-window cache poisoned; not learning windows");
                return;
            }
        }

        let mut guard = match cell.write() {
            Ok(guard) => guard,
            Err(error) => {
                tracing::warn!(%error, "claude context-window cache poisoned; not learning windows");
                return;
            }
        };
        let mut learned = false;
        for (model, window) in model_usage_windows(raw) {
            if guard.insert(model.to_string(), window) != Some(window) {
                tracing::debug!(%model, window, "learned Claude Code context window");
                learned = true;
            }
        }
        // Written under the lock so two sessions learning different models
        // cannot persist their snapshots out of order. Rare: once per model.
        if learned {
            save_learned_windows(&learned_windows_path(), &guard);
        }
    }

    /// Window previously learned for `model`, if any.
    ///
    /// `model` must be a CLI fully-qualified id — a catalog id or an `init`
    /// model, not a `message_start` model. See the module docs.
    pub(super) fn learned_context_window(&self, model: &str) -> Option<u64> {
        match self.context_windows_cell().read() {
            Ok(guard) => guard.get(model).copied(),
            Err(error) => {
                tracing::warn!(%error, "claude context-window cache poisoned; window unknown");
                None
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::super::test_support::new_test_adapter;
    use super::learned_windows_path;

    #[test]
    fn records_every_model_usage_entry_and_looks_up_by_exact_id() {
        let adapter = new_test_adapter();
        adapter.record_context_windows(&json!({
            "type": "result",
            "modelUsage": {
                "claude-haiku-4-5-20251001": { "contextWindow": 200_000 },
                "claude-sonnet-5[1m]": { "contextWindow": 1_000_000 }
            }
        }));

        assert_eq!(
            adapter.learned_context_window("claude-sonnet-5[1m]"),
            Some(1_000_000)
        );
        assert_eq!(
            adapter.learned_context_window("claude-haiku-4-5-20251001"),
            Some(200_000)
        );
    }

    #[test]
    fn never_conflates_the_1m_beta_variant_with_its_bare_id() {
        let adapter = new_test_adapter();
        adapter.record_context_windows(&json!({
            "type": "result",
            "modelUsage": { "claude-opus-5[1m]": { "contextWindow": 1_000_000 } }
        }));

        // `message_start` reports the bare id for a 1M-beta turn; answering
        // from the marked entry would claim 1M for the 200k variant.
        assert_eq!(adapter.learned_context_window("claude-opus-5"), None);
    }

    #[test]
    fn ignores_events_without_model_usage_and_zero_windows() {
        let adapter = new_test_adapter();
        adapter.record_context_windows(&json!({ "type": "stream_event", "event": {} }));
        adapter.record_context_windows(&json!({
            "type": "result",
            "modelUsage": { "broken-model": { "contextWindow": 0 } }
        }));

        assert_eq!(adapter.learned_context_window("broken-model"), None);
    }

    #[test]
    fn learned_windows_survive_a_restart() {
        // Each test thread gets its own settings dir, so a second adapter on
        // this thread reads exactly what the first one persisted.
        let before = new_test_adapter();
        before.record_context_windows(&json!({
            "type": "result",
            "modelUsage": { "claude-opus-6": { "contextWindow": 1_000_000 } }
        }));

        let after_restart = new_test_adapter();
        assert_eq!(
            after_restart.learned_context_window("claude-opus-6"),
            Some(1_000_000)
        );
    }

    #[test]
    fn a_corrupt_bank_is_relearned_instead_of_failing() {
        let path = learned_windows_path();
        std::fs::create_dir_all(path.parent().expect("cache dir")).expect("create cache dir");
        std::fs::write(&path, "{not json").expect("write corrupt bank");

        let adapter = new_test_adapter();
        assert_eq!(adapter.learned_context_window("claude-opus-6"), None);

        adapter.record_context_windows(&json!({
            "type": "result",
            "modelUsage": { "claude-opus-6": { "contextWindow": 1_000_000 } }
        }));
        assert_eq!(
            new_test_adapter().learned_context_window("claude-opus-6"),
            Some(1_000_000)
        );
    }

    #[test]
    fn persisted_zero_windows_are_ignored() {
        let path = learned_windows_path();
        std::fs::create_dir_all(path.parent().expect("cache dir")).expect("create cache dir");
        std::fs::write(&path, r#"{"claude-opus-6": 0, "claude-haiku-5": 200000}"#)
            .expect("write bank");

        let adapter = new_test_adapter();
        assert_eq!(adapter.learned_context_window("claude-opus-6"), None);
        assert_eq!(
            adapter.learned_context_window("claude-haiku-5"),
            Some(200_000)
        );
    }
}
