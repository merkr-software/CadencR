//! Validate the task-spawn metadata shared by live routing and recovery.
use serde_json::{json, Value};

use super::super::event_json::metadata;
use crate::domain::agents::adapter::{RuntimeError, RuntimeEvent, RuntimeEventKind};

pub(in crate::domain::agents::codex) fn thread_spawn_parent(
    thread: &Value,
) -> Result<Option<&str>, RuntimeError> {
    let Some(spawn) = thread.get("source").and_then(subagent_spawn_source) else {
        return Ok(None); // A root, guardian, review or compaction thread is not a task.
    };
    if !spawn.is_object() {
        return Err(RuntimeError::new("Invalid Codex thread_spawn metadata"));
    }
    let native = parent_id(spawn.get("parent_thread_id"))?;
    let top_level = parent_id(thread.get("parentThreadId"))?;
    if matches!((native, top_level), (Some(a), Some(b)) if a != b) {
        return Err(RuntimeError::new(
            "Conflicting Codex descendant parent identities",
        ));
    }
    native
        .or(top_level)
        .map(Some)
        .ok_or_else(|| RuntimeError::new("Missing Codex descendant parent identity"))
}

fn parent_id(value: Option<&Value>) -> Result<Option<&str>, RuntimeError> {
    match value {
        None | Some(Value::Null) => Ok(None),
        Some(Value::String(id)) if !id.trim().is_empty() => Ok(Some(id)),
        _ => Err(RuntimeError::new(
            "Invalid Codex descendant parent identity",
        )),
    }
}

pub(in crate::domain::agents::codex) fn subagent_spawn_source(source: &Value) -> Option<&Value> {
    let subagent = source.get("subAgent").or_else(|| source.get("subagent"))?;
    subagent
        .get("thread_spawn")
        .or_else(|| subagent.get("threadSpawn"))
}

pub(in crate::domain::agents::codex) fn lineage_error(
    thread: &str,
    error: RuntimeError,
) -> RuntimeEvent {
    let message = format!("Cannot recover Codex descendant ancestry: {error}");
    RuntimeEvent::new(
        metadata(thread, json!({"type":"error","message":message})),
        RuntimeEventKind::ProviderError {
            message,
            code: Some("CODEX_SUBAGENT_LINEAGE".into()),
            parent_tool_use_id: None,
        },
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rejects_missing_malformed_and_conflicting_parents_but_allows_non_tasks() {
        for spawn in [
            json!({}),
            json!(null),
            json!({"parent_thread_id":""}),
            json!({"parent_thread_id":42}),
        ] {
            assert!(
                thread_spawn_parent(&json!({"source":{"subAgent":{"thread_spawn":spawn}}}))
                    .is_err()
            );
        }
        let thread = json!({"parentThreadId":"root", "source":{"subAgent":{"thread_spawn":{"parent_thread_id":"foreign"}}}});
        assert!(thread_spawn_parent(&thread).is_err());
        assert_eq!(
            thread_spawn_parent(&json!({"source":"vscode"})).unwrap(),
            None
        );
        assert_eq!(
            thread_spawn_parent(&json!({"source":{"subAgent":{"other":"guardian"}}})).unwrap(),
            None
        );
    }

    #[test]
    fn accepts_native_top_level_and_matching_dual_parent_metadata() {
        for spawn in [json!({}), json!({"parent_thread_id":"root"})] {
            let thread =
                json!({"parentThreadId":"root", "source":{"subagent":{"threadSpawn":spawn}}});
            assert_eq!(thread_spawn_parent(&thread).unwrap(), Some("root"));
        }
        let thread = json!({"source":{"subAgent":{"thread_spawn":{"parent_thread_id":"root"}}}});
        assert_eq!(thread_spawn_parent(&thread).unwrap(), Some("root"));
    }
}
