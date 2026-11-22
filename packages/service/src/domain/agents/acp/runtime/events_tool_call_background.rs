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
//! is never finished is stopped by the runtime-end sweep. Session activity is declared
//! separately through `_meta.cadencr.backgroundWorkPending`. See
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

/// Metrics and terminal updates on a detached carrier are signal-only: its
/// original tool block already closed. Only a terminal status releases it.
pub(super) fn update_detached(
    tool_call_id: &str,
    body: &Value,
    indexer: &mut EventIndexer,
    metadata: &RuntimeEventMetadata,
) -> Option<RuntimeEvent> {
    if indexer.background_subagents.get(tool_call_id) != Some(&true) {
        return None;
    }
    let fields = subagent_meta(body)?;
    let mut patch = finish_patch(fields).unwrap_or_default();
    if let Some(model) = fields["resolvedModel"]
        .as_str()
        .map(str::trim)
        .filter(|m| !m.is_empty())
    {
        patch.model = Some(model.to_owned());
        patch.model_resolved = true;
    }
    patch.total_tokens = fields["totalTokens"].as_u64();
    if patch.status.is_some() {
        indexer.background_subagents.remove(tool_call_id);
    } else if patch.model.is_none() && patch.total_tokens.is_none() {
        return None;
    }
    let metadata = RuntimeEventMetadata {
        session_id: metadata.session_id.clone(),
        ..RuntimeEventMetadata::default()
    };
    Some(
        RuntimeEvent::new(metadata, RuntimeEventKind::Other)
            .with_subagent_updates(vec![RuntimeSubagentUpdate::new(tool_call_id, patch)]),
    )
}

fn finish_patch(fields: &Value) -> Option<RuntimeSubagentPatch> {
    let summary = fields
        .get("summary")
        .and_then(Value::as_str)
        .and_then(summarize_subagent_result);
    let (status, reason) = match fields["status"].as_str()? {
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
    use super::{detach_on_completion, observe_background_launch, update_detached};
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
            update_detached("task-1", &finish, &mut indexer, &metadata()).expect("finish update");
        assert!(event.is_subagent_signal_only());
        assert_eq!(event.session_id(), Some("s-1"));
        let patch = &event.subagent_updates()[0].patch;
        assert_eq!(patch.status, Some(RuntimeSubagentStatus::Failed));
        assert_eq!(patch.result_summary.as_deref(), Some("quota exceeded"));
        assert!(indexer.background_subagents.is_empty());
    }

    #[test]
    fn detached_metrics_are_attributed_to_the_carrier_and_survive_until_completion() {
        let mut indexer = EventIndexer::default();
        indexer.background_subagents.insert("task".into(), true);
        let metrics = json!({"_meta":{"cadencr":{"subagent":{"resolvedModel":"observed-model","totalTokens":0}}}});
        assert!(update_detached("another", &metrics, &mut indexer, &metadata()).is_none());
        let event = update_detached("task", &metrics, &mut indexer, &metadata()).unwrap();
        assert!(event.is_subagent_signal_only());
        let patch = &event.subagent_updates()[0].patch;
        assert!(patch.status.is_none());
        assert!(patch.model_resolved);
        assert_eq!(patch.model.as_deref(), Some("observed-model"));
        assert_eq!(patch.total_tokens, Some(0));
        let finished =
            json!({"_meta":{"cadencr":{"subagent":{"status":"completed","totalTokens":42}}}});
        let event = update_detached("task", &finished, &mut indexer, &metadata()).unwrap();
        let patch = &event.subagent_updates()[0].patch;
        assert_eq!(patch.status, Some(RuntimeSubagentStatus::Completed));
        assert_eq!(patch.total_tokens, Some(42));
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
        assert!(update_detached("task-2", &finish, &mut indexer, &metadata()).is_none());
        // A completion that already reports the outcome settles normally.
        assert!(detach_on_completion("task-2", &finish, "completed", &mut indexer).is_none());
        // Unknown statuses never finish a detached carrier.
        detach_on_completion("task-2", &json!({}), "completed", &mut indexer).unwrap();
        let bogus = json!({ "_meta": { "cadencr": { "subagent": { "status": "paused" } } } });
        assert!(update_detached("task-2", &bogus, &mut indexer, &metadata()).is_none());
        let cancelled =
            json!({ "_meta": { "cadencr": { "subagent": { "status": "cancelled" } } } });
        let event = update_detached("task-2", &cancelled, &mut indexer, &metadata()).unwrap();
        assert_eq!(
            event.subagent_updates()[0].patch.status,
            Some(RuntimeSubagentStatus::Stopped)
        );
    }
}
