//! Background sub-agents declared through `_meta.cadencr.subagent`.
//!
//! Standard ACP has no notion of a dispatch tool call that returns while the
//! sub-agent it launched keeps working. A connector marks such a carrier with
//! `_meta.cadencr.subagent = {"background": true}` on its `tool_call` (or any
//! update before it completes). When the carrier then completes, the host keeps
//! the sub-agent `Running` and `background` (exempt from the turn-end sweep)
//! instead of settling it. A later `tool_call_update` with the same
//! `toolCallId` and `_meta.cadencr.subagent = {"status": "completed" |
//! "failed" | "cancelled", "summary"?: string}` finishes it. The declaration may
//! also ride the completing update itself (some agents only learn a task went
//! to the background when its launching call returns). A background run that
//! is never finished is stopped by the runtime-end sweep. The session itself
//! is not held "working" for it: an agent may never report the outcome. See
//! `docs/PROVIDER_SPEC/INSTALLED_ACP_PROVIDERS.md#background-sub-agents`.

use serde_json::Value;

use super::events_stream_blocks::EventIndexer;
use crate::domain::agents::adapter::{
    stop_reason, summarize_subagent_result, RuntimeEvent, RuntimeEventKind, RuntimeEventMetadata,
    RuntimeSubagentPatch, RuntimeSubagentStatus, RuntimeSubagentUpdate,
};

fn subagent_meta(body: &Value) -> Option<&Value> {
    body.pointer("/_meta/cadencr/subagent")
        .filter(|meta| meta.is_object())
}

fn finish_status(body: &Value) -> Option<&str> {
    subagent_meta(body)?.get("status").and_then(Value::as_str)
}

/// Remember a carrier the connector declared background.
pub(super) fn observe_background_launch(
    tool_call_id: &str,
    body: &Value,
    indexer: &mut EventIndexer,
) {
    let declared = subagent_meta(body)
        .and_then(|meta| meta.get("background"))
        .and_then(Value::as_bool)
        == Some(true);
    if declared {
        indexer
            .background_subagents
            .entry(tool_call_id.to_string())
            .or_insert(false);
    }
}

/// The launching call of a background carrier completed without finishing
/// the sub-agent: keep it running, detached from the turn.
pub(super) fn detach_on_completion(
    tool_call_id: &str,
    body: &Value,
    status: &str,
    indexer: &mut EventIndexer,
) -> Option<RuntimeSubagentUpdate> {
    if status != "completed" || finish_status(body).is_some() {
        return None;
    }
    let detached = indexer.background_subagents.get_mut(tool_call_id)?;
    *detached = true;
    let patch = RuntimeSubagentPatch {
        status: Some(RuntimeSubagentStatus::Running),
        background: Some(true),
        ..RuntimeSubagentPatch::default()
    };
    Some(RuntimeSubagentUpdate::new(tool_call_id, patch))
}

/// A later update finishing a detached background carrier. Its tool block
/// already closed, so the update becomes a signal-only event.
pub(super) fn finish_detached(
    tool_call_id: &str,
    body: &Value,
    indexer: &mut EventIndexer,
    metadata: &RuntimeEventMetadata,
) -> Option<RuntimeEvent> {
    if indexer.background_subagents.get(tool_call_id) != Some(&true) {
        return None;
    }
    let patch = finish_patch(body)?;
    indexer.background_subagents.remove(tool_call_id);
    let metadata = RuntimeEventMetadata {
        session_id: metadata.session_id.clone(),
        ..RuntimeEventMetadata::default()
    };
    Some(
        RuntimeEvent::new(metadata, RuntimeEventKind::Other)
            .with_subagent_updates(vec![RuntimeSubagentUpdate::new(tool_call_id, patch)]),
    )
}

fn finish_patch(body: &Value) -> Option<RuntimeSubagentPatch> {
    let summary = subagent_meta(body)
        .and_then(|meta| meta.get("summary"))
        .and_then(Value::as_str)
        .and_then(summarize_subagent_result);
    let (status, reason) = match finish_status(body)? {
        "completed" => (RuntimeSubagentStatus::Completed, None),
        "failed" => (RuntimeSubagentStatus::Failed, summary.clone()),
        "cancelled" => (
            RuntimeSubagentStatus::Stopped,
            Some(stop_reason::INTERRUPTED.to_string()),
        ),
        _ => return None,
    };
    Some(RuntimeSubagentPatch {
        status: Some(status),
        status_reason: reason,
        result_summary: summary,
        ..RuntimeSubagentPatch::default()
    })
}

#[cfg(test)]
mod tests {
    use super::{detach_on_completion, finish_detached, observe_background_launch};
    use crate::domain::agents::acp::runtime::events_stream_blocks::EventIndexer;
    use crate::domain::agents::adapter::{RuntimeEventMetadata, RuntimeSubagentStatus};
    use serde_json::json;

    fn metadata() -> RuntimeEventMetadata {
        RuntimeEventMetadata {
            session_id: Some("s-1".into()),
            ..RuntimeEventMetadata::default()
        }
    }

    #[test]
    fn declared_carrier_stays_running_then_finishes_from_meta() {
        let mut indexer = EventIndexer::default();
        let launch = json!({ "_meta": { "cadencr": { "subagent": { "background": true } } } });
        observe_background_launch("task-1", &launch, &mut indexer);

        let detached = detach_on_completion("task-1", &json!({}), "completed", &mut indexer)
            .expect("background carrier detaches");
        assert_eq!(detached.patch.status, Some(RuntimeSubagentStatus::Running));
        assert_eq!(detached.patch.background, Some(true));

        let finish = json!({ "_meta": { "cadencr": { "subagent": {
            "status": "failed", "summary": "quota exceeded"
        } } } });
        let event =
            finish_detached("task-1", &finish, &mut indexer, &metadata()).expect("finish update");
        assert!(event.is_subagent_signal_only());
        assert_eq!(event.session_id(), Some("s-1"));
        let patch = &event.subagent_updates()[0].patch;
        assert_eq!(patch.status, Some(RuntimeSubagentStatus::Failed));
        assert_eq!(patch.result_summary.as_deref(), Some("quota exceeded"));
        assert!(indexer.background_subagents.is_empty());
    }

    #[test]
    fn undeclared_or_unfinished_carriers_are_left_to_the_generic_path() {
        let mut indexer = EventIndexer::default();
        observe_background_launch("task-1", &json!({ "_meta": {} }), &mut indexer);
        assert!(detach_on_completion("task-1", &json!({}), "completed", &mut indexer).is_none());

        let launch = json!({ "_meta": { "cadencr": { "subagent": { "background": true } } } });
        observe_background_launch("task-2", &launch, &mut indexer);
        // Not yet detached: a finish update is an ordinary update.
        let finish = json!({ "_meta": { "cadencr": { "subagent": { "status": "completed" } } } });
        assert!(finish_detached("task-2", &finish, &mut indexer, &metadata()).is_none());
        // A completion that already reports the outcome settles normally.
        assert!(detach_on_completion("task-2", &finish, "completed", &mut indexer).is_none());
        // Unknown statuses never finish a detached carrier.
        detach_on_completion("task-2", &json!({}), "completed", &mut indexer).unwrap();
        let bogus = json!({ "_meta": { "cadencr": { "subagent": { "status": "paused" } } } });
        assert!(finish_detached("task-2", &bogus, &mut indexer, &metadata()).is_none());
        let cancelled =
            json!({ "_meta": { "cadencr": { "subagent": { "status": "cancelled" } } } });
        let event = finish_detached("task-2", &cancelled, &mut indexer, &metadata()).unwrap();
        assert_eq!(
            event.subagent_updates()[0].patch.status,
            Some(RuntimeSubagentStatus::Stopped)
        );
    }
}
