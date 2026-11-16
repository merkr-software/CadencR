//! Recover resumed descendants without treating a message as a spawn edge.
use std::collections::HashSet;
use std::future::Future;

use codex_app_server_sdk_rs::CodexAppServerClient;
use serde_json::{json, Value};

use super::event_lifecycle::SessionLifecycle;
use super::event_state::IndexState;
use super::event_subagent_routes::{lineage_error, thread_spawn_parent};
use super::events::notification_events;
use super::timeouts::RECOVERY_TIMEOUT;
use crate::domain::agents::adapter::{RuntimeError, RuntimeEvent};

pub(super) async fn recover_interacted_routes(
    client: &CodexAppServerClient,
    method: &str,
    params: &Value,
    root: &str,
    indexes: &mut IndexState,
    lifecycle: &mut SessionLifecycle,
) -> Vec<RuntimeEvent> {
    let Some(target) = interaction_target(method, params) else {
        return Vec::new();
    };
    if params["threadId"]
        .as_str()
        .is_some_and(|sender| indexes.is_untracked_thread(sender))
        || !indexes.should_recover_subagent(target)
    {
        return Vec::new();
    }
    // Only the rare unknown interaction does I/O. Bound the entire ancestry
    // walk, not each ancestor independently, so stream processing stays bounded.
    let recovery = resolve_lineage(target, indexes, |thread| async move {
        client
            .request_with_timeout(
                "thread/read",
                json!({"threadId":thread,"includeTurns":false}),
                RECOVERY_TIMEOUT,
            )
            .await
            .map_err(RuntimeError::from)
    });
    let result = tokio::time::timeout(RECOVERY_TIMEOUT, recovery)
        .await
        .unwrap_or_else(|_| {
            Err(RuntimeError::new(
                "Codex descendant metadata read timed out",
            ))
        });
    match result {
        Ok(threads) => register_lineage(threads, root, indexes, lifecycle),
        Err(error) => vec![lineage_error(root, error)],
    }
}

fn interaction_target<'a>(method: &str, params: &'a Value) -> Option<&'a str> {
    (matches!(method, "item/started" | "item/completed")
        && params["item"]["type"] == "subAgentActivity"
        && params["item"]["kind"] == "interacted")
        .then(|| params["item"]["agentThreadId"].as_str())
        .flatten()
}

async fn resolve_lineage<F, Fut>(
    target: &str,
    indexes: &IndexState,
    mut read: F,
) -> Result<Vec<Value>, RuntimeError>
where
    F: FnMut(String) -> Fut,
    Fut: Future<Output = Result<Value, RuntimeError>>,
{
    let mut cursor = target.to_string();
    let mut visited = HashSet::new();
    let mut threads = Vec::new();
    while !indexes.is_session_thread(&cursor) {
        if visited.len() >= 64 || !visited.insert(cursor.clone()) {
            return Err(RuntimeError::new(
                "Invalid or cyclic Codex descendant ancestry",
            ));
        }
        let snapshot = read(cursor.clone()).await?;
        let thread = &snapshot["thread"];
        if thread["id"].as_str() != Some(cursor.as_str()) {
            return Err(RuntimeError::new(
                "Codex thread/read returned a mismatched thread",
            ));
        }
        let Some(parent) = thread_spawn_parent(thread)? else {
            // A valid non-task target (another root or guardian) isn't a child.
            return Ok(Vec::new());
        };
        cursor = parent.to_string();
        threads.push(thread.clone());
    }
    threads.reverse();
    Ok(threads)
}

fn register_lineage(
    threads: Vec<Value>,
    root: &str,
    indexes: &mut IndexState,
    lifecycle: &mut SessionLifecycle,
) -> Vec<RuntimeEvent> {
    let mut recovered = Vec::new();
    for thread in threads {
        let params = json!({"thread":thread});
        let mut events = notification_events("thread/started", params.clone(), None, indexes);
        lifecycle.apply("thread/started", &params, root, indexes, &mut events);
        recovered.extend(events);
    }
    recovered
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashMap;

    fn child(id: &str, parent: &str, status: &str) -> Value {
        json!({"thread":{"id":id,"status":{"type":status},"source":{"subAgent":{
            "thread_spawn":{"parent_thread_id":parent,"agent_path":format!("/root/{id}")}
        }}}})
    }

    #[tokio::test]
    async fn sibling_interaction_uses_real_parent_and_recovers_active_descendants() {
        let mut indexes = IndexState::for_root_thread("root");
        indexes.record_subagent_thread("sender", "spawn-sender");
        let snapshots = HashMap::from([
            ("grandchild", child("grandchild", "sibling", "active")),
            ("sibling", child("sibling", "root", "idle")),
        ]);
        let lineage = resolve_lineage("grandchild", &indexes, |id| {
            std::future::ready(Ok(snapshots[&*id].clone()))
        })
        .await
        .unwrap();
        assert_eq!(
            lineage.iter().map(|t| &t["id"]).collect::<Vec<_>>(),
            vec!["sibling", "grandchild"]
        );
        let mut lifecycle = SessionLifecycle::default();
        let events = register_lineage(lineage, "root", &mut indexes, &mut lifecycle);
        assert_eq!(events[0].parent_tool_use_id(), None);
        assert!(events.iter().any(RuntimeEvent::is_turn_started_signal));
        assert_eq!(
            indexes.subagent_parent_tool_use_id("grandchild"),
            Some("codex-agent-grandchild")
        );
        let transcript: Vec<_> = events
            .iter()
            .filter(|event| !event.is_subagent_signal_only())
            .collect();
        assert_eq!(
            transcript.last().unwrap().parent_tool_use_id(),
            Some("codex-agent-sibling")
        );
        assert!(lifecycle.children.contains_key("grandchild"));
        assert!(!lifecycle.children.contains_key("sibling"));
        let mut ended = Vec::new();
        lifecycle.apply(
            "thread/status/changed",
            &json!({"threadId":"grandchild","status":{"type":"idle"}}),
            "root",
            &indexes,
            &mut ended,
        );
        assert!(ended.iter().any(RuntimeEvent::is_result));
    }

    #[tokio::test]
    async fn parent_known_child_and_duplicate_interactions_do_not_read_metadata() {
        let mut indexes = IndexState::for_root_thread("root");
        indexes.record_subagent_thread("child", "spawn");
        for id in ["root", "child", ""] {
            assert!(!indexes.should_recover_subagent(id));
        }
        assert!(indexes.should_recover_subagent("resumed"));
        assert!(!indexes.should_recover_subagent("resumed"));
        let lineage = resolve_lineage("root", &indexes, |_| async { panic!("unexpected read") })
            .await
            .unwrap();
        assert!(lineage.is_empty());
    }

    #[tokio::test]
    async fn invalid_ancestor_does_not_partially_register_a_descendant() {
        let mut indexes = IndexState::for_root_thread("root");
        let mut lifecycle = SessionLifecycle::default();
        for ancestor in [
            json!({"id":"parent","source":{"subAgent":{"thread_spawn":{}}}}),
            json!({"id":"parent","parentThreadId":"root","source":{"subAgent":{"thread_spawn":{"parent_thread_id":"foreign"}}}}),
        ] {
            let error = resolve_lineage("target", &indexes, |id| {
                std::future::ready(Ok(if id == "target" {
                    child("target", "parent", "active")
                } else {
                    json!({"thread":ancestor})
                }))
            })
            .await
            .unwrap_err();
            let event = lineage_error("root", error);
            assert_eq!(
                event.provider_error().unwrap().code,
                Some("CODEX_SUBAGENT_LINEAGE")
            );
            assert!(register_lineage(Vec::new(), "root", &mut indexes, &mut lifecycle).is_empty());
            assert!(!indexes.has_any_subagents());
            assert!(lifecycle.children.is_empty());
        }
    }

    #[tokio::test]
    async fn foreign_guardian_invalid_and_failed_reads_never_register_partial_ancestry() {
        let indexes = IndexState::for_root_thread("root");
        for source in [json!("vscode"), json!({"subAgent":{"other":"guardian"}})] {
            let lineage = resolve_lineage("foreign", &indexes, |_| {
                std::future::ready(Ok(json!({"thread":{"id":"foreign","source":source}})))
            })
            .await
            .unwrap();
            assert!(lineage.is_empty());
        }
        assert!(
            resolve_lineage("x", &indexes, |_| async { Ok(child("x", "x", "active")) })
                .await
                .is_err()
        );
        assert!(resolve_lineage("x", &indexes, |_| async {
            Ok(child("wrong", "root", "active"))
        })
        .await
        .is_err());
        let error = resolve_lineage("x", &indexes, |_| async {
            Err(RuntimeError::new("read failed"))
        })
        .await
        .unwrap_err();
        assert!(error.to_string().contains("read failed"));
        assert!(!indexes.has_any_subagents());
    }
}
