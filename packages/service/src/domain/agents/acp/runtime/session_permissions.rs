//! Per-session, in-memory permission decisions.
//!
//! When a user picks `allow_for_session` (or `allow_always`) on an ACP
//! permission prompt, the agent owns persistence via the echoed
//! `optionId`. The runtime keeps its own session-scoped cache so future
//! identical tool calls can be resolved without re-prompting if the agent
//! ever asks a second time. The map lives on the [`AcpRuntimeSession`]
//! and is dropped when the session closes — there is no SQLite
//! persistence. `AllowFuture` is recorded here too so the eventual
//! follow-up "promote to a real persistent store" lands in one place.
//!
//! `AllowOnce` and `Deny` are NOT cached — they're explicitly one-shot.

use std::collections::HashMap;
use std::sync::Arc;

use serde_json::Value;
use tokio::sync::RwLock;

use crate::domain::agents::adapter::RuntimePermissionDecision;

/// Stable key for cached permission decisions: `(tool_name,
/// canonical-json input)`. The ACP SDK enables serde_json's
/// `preserve_order` feature, so object key order must be normalized
/// explicitly. Two logically equal JSON inputs collapse to the same
/// string regardless of source order.
#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub struct PermissionKey {
    pub tool_name: String,
    pub canonical_input: String,
}

impl PermissionKey {
    pub fn new(tool_name: &str, tool_input: &Value) -> Self {
        Self {
            tool_name: tool_name.to_string(),
            canonical_input: canonical_json(tool_input),
        }
    }
}

fn canonical_json(value: &Value) -> String {
    match value {
        Value::Null | Value::Bool(_) | Value::Number(_) | Value::String(_) => value.to_string(),
        Value::Array(items) => {
            let values = items.iter().map(canonical_json).collect::<Vec<_>>();
            format!("[{}]", values.join(","))
        }
        Value::Object(map) => {
            let mut entries = map.iter().collect::<Vec<_>>();
            entries.sort_by(|(left, _), (right, _)| left.cmp(right));
            let fields = entries
                .into_iter()
                .map(|(key, value)| {
                    let encoded_key = serde_json::to_string(key)
                        .expect("JSON object keys should always serialize");
                    format!("{encoded_key}:{}", canonical_json(value))
                })
                .collect::<Vec<_>>();
            format!("{{{}}}", fields.join(","))
        }
    }
}

/// Shared map of recorded session-scoped decisions. Cheap to clone — the
/// inner `HashMap` lives behind an `Arc<RwLock<…>>`.
#[derive(Clone, Default)]
pub struct SessionPermissions {
    inner: Arc<RwLock<HashMap<PermissionKey, RuntimePermissionDecision>>>,
}

impl SessionPermissions {
    pub fn new() -> Self {
        Self::default()
    }

    /// Record a decision so future identical requests can be auto-allowed
    /// without re-prompting the user. Only `AllowFuture` and
    /// `AllowForSession` are stored — one-shot decisions never go in.
    pub async fn record(&self, key: PermissionKey, decision: RuntimePermissionDecision) {
        if !matches!(
            decision,
            RuntimePermissionDecision::AllowFuture | RuntimePermissionDecision::AllowForSession
        ) {
            return;
        }
        self.inner.write().await.insert(key, decision);
    }

    pub async fn lookup(&self, key: &PermissionKey) -> Option<RuntimePermissionDecision> {
        self.inner.read().await.get(key).copied()
    }

    /// Drop everything. Called on session close.
    pub async fn clear(&self) {
        self.inner.write().await.clear();
    }
}

#[cfg(test)]
mod tests {
    use super::{PermissionKey, SessionPermissions};
    use crate::domain::agents::adapter::RuntimePermissionDecision;
    use serde_json::json;

    #[tokio::test]
    async fn records_and_looks_up_session_decisions() {
        let map = SessionPermissions::new();
        let key = PermissionKey::new("Bash", &json!({ "command": "ls" }));
        map.record(key.clone(), RuntimePermissionDecision::AllowForSession)
            .await;
        assert_eq!(
            map.lookup(&key).await,
            Some(RuntimePermissionDecision::AllowForSession)
        );
    }

    #[tokio::test]
    async fn does_not_record_one_shot_decisions() {
        let map = SessionPermissions::new();
        let key = PermissionKey::new("Bash", &json!({ "command": "ls" }));
        map.record(key.clone(), RuntimePermissionDecision::AllowOnce)
            .await;
        map.record(key.clone(), RuntimePermissionDecision::Deny)
            .await;
        assert!(map.lookup(&key).await.is_none());
    }

    #[tokio::test]
    async fn records_allow_future_alongside_for_session() {
        let map = SessionPermissions::new();
        let key = PermissionKey::new("Read", &json!({ "path": "/x" }));
        map.record(key.clone(), RuntimePermissionDecision::AllowFuture)
            .await;
        assert_eq!(
            map.lookup(&key).await,
            Some(RuntimePermissionDecision::AllowFuture)
        );
    }

    #[test]
    fn permission_keys_are_canonical_across_object_key_order() {
        let a = PermissionKey::new("Bash", &json!({ "a": 1, "b": 2 }));
        let b = PermissionKey::new("Bash", &json!({ "b": 2, "a": 1 }));
        assert_eq!(a, b);
    }

    #[test]
    fn permission_keys_distinguish_tool_names() {
        let a = PermissionKey::new("Bash", &json!({ "x": 1 }));
        let b = PermissionKey::new("Read", &json!({ "x": 1 }));
        assert_ne!(a, b);
    }

    #[tokio::test]
    async fn clear_drops_all_recorded_decisions() {
        let map = SessionPermissions::new();
        let key = PermissionKey::new("Bash", &json!({ "command": "ls" }));
        map.record(key.clone(), RuntimePermissionDecision::AllowFuture)
            .await;
        map.clear().await;
        assert!(map.lookup(&key).await.is_none());
    }
}
