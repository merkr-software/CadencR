//! Provider-neutral opt-in for an unsolicited reply after a prompt result.

use serde_json::Value;

use super::events_stream_blocks::EventIndexer;
use super::events_tool_call::MappedUpdate;
use super::turn_result::detached_result;
use crate::domain::agents::adapter::{
    RuntimeEvent, RuntimeEventKind, RuntimeEventMetadata, RuntimeStreamEvent,
};

#[derive(Clone, Copy, Default, PartialEq, Eq)]
pub(super) enum DetachedReply {
    #[default]
    Inactive,
    Awaiting,
    Streaming,
}

impl DetachedReply {
    pub(super) fn after_prompt(stop_reason: &str) -> Self {
        match stop_reason {
            "end_turn" => Self::Awaiting,
            _ => Self::Inactive,
        }
    }
}

#[derive(Clone, Copy)]
pub(super) enum DetachedUpdate {
    Chunk,
    End { pending: Option<bool> },
    WorkFinished,
}

impl DetachedUpdate {
    pub(super) fn classify(params: &Value, session_id: &str) -> Option<Self> {
        if params.get("sessionId").and_then(Value::as_str) != Some(session_id) {
            return None;
        }
        let body = params.get("update").unwrap_or(params);
        match body.get("sessionUpdate").and_then(Value::as_str) {
            Some("agent_message_chunk" | "agent_thought_chunk") => Some(Self::Chunk),
            Some("usage_update" | "session_info_update")
                if body.pointer("/_meta/cadencr/detachedReplyEnded")
                    == Some(&Value::Bool(true)) =>
            {
                Some(Self::End {
                    pending: super::background_work::pending(body),
                })
            }
            Some("session_info_update") if super::background_work::pending(body) == Some(false) => {
                Some(Self::WorkFinished)
            }
            _ => None,
        }
    }

    /// A completion marker only ends an observed detached reply. An older work
    /// hold may finish while a new prompt owns the lock and its own blocks.
    pub(super) fn apply(
        self,
        indexer: &mut EventIndexer,
        mapped: &mut MappedUpdate,
        session_id: &str,
        owns_prompt_lock: bool,
    ) {
        match self {
            Self::Chunk if indexer.detached_reply == DetachedReply::Awaiting => {
                if mapped.events.iter().any(|event| {
                    matches!(
                        event.stream_event(),
                        Some(RuntimeStreamEvent::ContentBlockDelta { .. })
                    )
                }) {
                    indexer.detached_reply = DetachedReply::Streaming;
                }
            }
            Self::End { pending } if indexer.detached_reply == DetachedReply::Streaming => {
                let pending = if indexer.turn_interrupted() {
                    Some(false)
                } else {
                    pending
                };
                finish_reply(indexer, mapped, session_id, pending);
            }
            Self::WorkFinished if indexer.background_work.is_pending() => {
                if !owns_prompt_lock || indexer.detached_reply == DetachedReply::Inactive {
                    if indexer.background_work.held_at_result() {
                        // A prior visible turn held the work. The reader checks its generation.
                        emit_result(indexer, mapped, session_id, Some(false));
                    } else {
                        emit_release(indexer, mapped);
                    }
                } else if indexer.detached_reply == DetachedReply::Awaiting
                    || indexer.turn_interrupted()
                {
                    finish_reply(indexer, mapped, session_id, Some(false));
                } else {
                    // The wake started before the standalone release arrived.
                    // Drain the work hold and let this reply's own result finish it.
                    emit_release(indexer, mapped);
                }
            }
            _ => {}
        }
    }
}

fn emit_release(indexer: &mut EventIndexer, mapped: &mut MappedUpdate) {
    let signal = indexer.background_work.observe_progress(false);
    mapped.events.push(
        RuntimeEvent::new(RuntimeEventMetadata::default(), RuntimeEventKind::Other)
            .with_background_agent(signal),
    );
}

fn finish_reply(
    indexer: &mut EventIndexer,
    mapped: &mut MappedUpdate,
    session_id: &str,
    pending: Option<bool>,
) {
    if indexer.detached_reply == DetachedReply::Streaming {
        mapped
            .events
            .extend(indexer.drain_open_blocks(Some(session_id)));
        indexer.message_started = false;
        indexer.latch_turn_model(None);
    }
    indexer.detached_reply = DetachedReply::Awaiting;
    emit_result(indexer, mapped, session_id, pending);
}

fn emit_result(
    indexer: &mut EventIndexer,
    mapped: &mut MappedUpdate,
    session_id: &str,
    pending: Option<bool>,
) {
    let signal = indexer.background_work.observe(pending);
    let result = detached_result(session_id);
    mapped.events.push(result.with_background_agent(signal));
}

#[cfg(test)]
mod tests {
    use super::super::server_request_event_loop_tests::event_loop_config;
    use super::super::server_requests::{spawn_event_loop, EventLoopConfig};
    use super::super::test_support::{
        build_in_memory_client, read_request, send_response, write_json_frame,
    };
    use super::super::turn_lifecycle::{drive_initial_prompt, PromptCancel};
    use super::*;
    use crate::domain::agents::acp::AcpClient;
    use crate::domain::agents::adapter::{BackgroundAgentSignal, RuntimeError};
    use serde_json::json;
    use std::sync::Arc;
    use std::time::Duration;
    use tokio::io::{AsyncWriteExt, BufReader, DuplexStream};
    use tokio::sync::mpsc;
    use tokio::task::JoinHandle;

    struct Harness {
        client: AcpClient,
        stdout: DuplexStream,
        stdin: BufReader<DuplexStream>,
        config: EventLoopConfig,
        tx: mpsc::Sender<Result<RuntimeEvent, RuntimeError>>,
        rx: mpsc::Receiver<Result<RuntimeEvent, RuntimeError>>,
        event_loop: JoinHandle<()>,
    }

    impl Harness {
        async fn new() -> Self {
            Self::with_steering(false).await
        }

        async fn with_steering(steering: bool) -> Self {
            let (client, stdout, stdin) = build_in_memory_client().await;
            let (tx, rx) = mpsc::channel(32);
            let mut config = event_loop_config(std::env::temp_dir());
            config.prompt_turn_lock =
                Arc::new(super::super::prompt_turn_lock::PromptTurns::new(steering));
            let event_loop = spawn_event_loop(
                client.clone(),
                client.subscribe_reliable(),
                tx.clone(),
                config.clone(),
            );
            Self {
                client,
                stdout,
                stdin,
                config,
                tx,
                rx,
                event_loop,
            }
        }

        async fn start_prompt(&mut self) -> (Value, JoinHandle<Result<(), RuntimeError>>) {
            let config = self.config.clone();
            let client = self.client.clone();
            let tx = self.tx.clone();
            let task = tokio::spawn(async move {
                drive_initial_prompt()
                    .client(&client)
                    .session_id_lock(&config.session_id)
                    .current_model_lock(&config.current_model)
                    .current_effort_lock(&config.current_effort)
                    .content(json!("fixture"))
                    .tx(&tx)
                    .indexer(&config.indexer)
                    .hooks(config.hooks.as_ref())
                    .prompt_turn_lock(&config.prompt_turn_lock)
                    .prompt_cancel(&PromptCancel::new())
                    .call()
                    .await
            });
            let request =
                tokio::time::timeout(Duration::from_secs(3), read_request(&mut self.stdin))
                    .await
                    .unwrap();
            assert_eq!(request["method"], "session/prompt");
            (request["id"].clone(), task)
        }

        async fn end_prompt(&mut self) {
            let (id, task) = self.start_prompt().await;
            send_response(&mut self.stdout, id, prompt_result()).await;
            await_prompt(task).await;
            let result = self.next().await;
            assert!(result.is_result());
            assert!(result.token_usage().is_some());
        }

        async fn send(&mut self, frame: Value) {
            write_json_frame(&mut self.stdout, frame).await;
        }

        async fn send_burst(&mut self, frames: &[Value]) {
            let burst = frames
                .iter()
                .map(|frame| format!("{frame}\n"))
                .collect::<String>();
            self.stdout.write_all(burst.as_bytes()).await.unwrap();
        }

        async fn next(&mut self) -> RuntimeEvent {
            tokio::time::timeout(Duration::from_secs(3), self.rx.recv())
                .await
                .unwrap()
                .unwrap()
                .unwrap()
        }

        async fn through_usage(&mut self, tokens: u64) -> Vec<RuntimeEvent> {
            let mut events = Vec::new();
            loop {
                let event = self.next().await;
                let found = event
                    .usage()
                    .is_some_and(|usage| usage.input_tokens == tokens);
                events.push(event);
                if found {
                    return events;
                }
            }
        }
    }

    async fn await_prompt(task: JoinHandle<Result<(), RuntimeError>>) {
        tokio::time::timeout(Duration::from_secs(3), task)
            .await
            .unwrap()
            .unwrap()
            .unwrap();
    }

    fn prompt_result() -> Value {
        json!({"stopReason":"end_turn", "usage":{"inputTokens":8, "outputTokens":2}})
    }

    fn chunk() -> Value {
        update(
            "s-1",
            json!({
                "sessionUpdate":"agent_message_chunk",
                "content":{"type":"text", "text":"streamed reply"},
            }),
        )
    }

    fn usage(session_id: &str, tokens: u64, marked: bool) -> Value {
        update(
            session_id,
            json!({
                "sessionUpdate":"usage_update", "used":tokens, "size":1000,
                "_meta":{"cadencr":{"detachedReplyEnded":marked}},
            }),
        )
    }

    fn update(session_id: &str, body: Value) -> Value {
        json!({
            "jsonrpc":"2.0", "method":"session/update",
            "params":{"sessionId":session_id, "update":body},
        })
    }

    fn release_work(session_id: &str) -> Value {
        update(
            session_id,
            json!({"sessionUpdate":"session_info_update","_meta":{"cadencr":{"backgroundWorkPending":false}}}),
        )
    }

    fn is_block_stop(event: &RuntimeEvent) -> bool {
        matches!(
            event.stream_event(),
            Some(RuntimeStreamEvent::ContentBlockStop { .. })
        )
    }

    #[tokio::test]
    async fn release_during_a_steer_leaves_it_open_and_is_not_overwritten_by_its_fallback() {
        let mut harness = Harness::with_steering(true).await;
        let (id, original) = harness.start_prompt().await;
        let (steer_id, steer) = harness.start_prompt().await;
        let mut response = prompt_result();
        response["_meta"] = json!({"cadencr":{"backgroundWorkPending":true}});
        send_response(&mut harness.stdout, id, response).await;
        await_prompt(original).await;
        assert!(harness.next().await.is_usage_accounting());
        let started = harness.next().await;
        assert!(matches!(
            started.background_agent_signal(),
            Some(BackgroundAgentSignal::Started { .. })
        ));
        harness
            .send_burst(&[release_work("s-1"), usage("s-1", 7, false)])
            .await;
        let release = harness.through_usage(7).await;
        assert!(!release.iter().any(RuntimeEvent::is_result));
        assert!(release.iter().any(|e| matches!(
            e.background_agent_signal(),
            Some(BackgroundAgentSignal::Finished { .. })
        )));

        harness
            .send_burst(&[
                json!({"jsonrpc":"2.0","id":steer_id,"error":{"code":-32602,"message":"rejected"}}),
                usage("s-1", 8, false),
            ])
            .await;
        let events = harness.through_usage(8).await;
        await_prompt(steer).await;
        let fallback = events.iter().find(|e| e.is_result()).unwrap();
        assert_eq!(fallback.raw_json()["stop_reason"], "end_turn");
        assert!(fallback.token_usage().is_none() && fallback.background_agent_signal().is_none());
    }

    #[tokio::test]
    async fn a_lost_response_fence_uses_the_last_confirmed_boundary() {
        let mut harness = Harness::with_steering(true).await;
        let (id, original) = harness.start_prompt().await;
        let (steer_id, steer) = harness.start_prompt().await;
        let mut response = prompt_result();
        response["_meta"] = json!({"cadencr":{"backgroundWorkPending":true}});
        send_response(&mut harness.stdout, id, response).await;
        await_prompt(original).await;
        assert!(harness.next().await.is_usage_accounting());
        assert!(harness.next().await.background_agent_signal().is_some());
        harness.event_loop.abort();
        assert!((&mut harness.event_loop).await.unwrap_err().is_cancelled());
        send_response(&mut harness.stdout, steer_id, prompt_result()).await;
        await_prompt(steer).await;
        let fallback = harness.next().await;
        assert_eq!(fallback.raw_json()["stop_reason"], "end_turn");
        assert!(fallback.token_usage().is_none() && fallback.background_agent_signal().is_some());
    }

    #[tokio::test]
    async fn explicit_background_work_keeps_detached_replies_eligible_after_a_non_end_turn_result()
    {
        for reason in ["max_tokens", "cancelled"] {
            let mut harness = Harness::with_steering(true).await;
            let (id, task) = harness.start_prompt().await;
            send_response(
                &mut harness.stdout,
                id,
                json!({
                    "stopReason":reason,
                    "_meta":{"cadencr":{"backgroundWorkPending":true}}
                }),
            )
            .await;
            await_prompt(task).await;
            let result = harness.next().await;
            assert!(result.is_result());
            assert!(matches!(
                result.background_agent_signal(),
                Some(BackgroundAgentSignal::Started { .. })
            ));
            let mut marker = usage("s-1", 1, true);
            marker["params"]["update"]["_meta"]["cadencr"]["backgroundWorkPending"] = json!(false);
            harness
                .send_burst(&[chunk(), marker, usage("s-1", 2, false)])
                .await;
            let events = harness.through_usage(2).await;
            let end = events.iter().find(|e| e.is_detached_reply_end()).unwrap();
            assert!(matches!(
                end.background_agent_signal(),
                Some(BackgroundAgentSignal::Finished { .. })
            ));
        }
    }

    #[tokio::test]
    async fn coalesced_result_and_work_release_preserve_accounting_and_settle_once() {
        let mut harness = Harness::new().await;
        let (id, task) = harness.start_prompt().await;
        let mut result = prompt_result();
        result["_meta"] = json!({"cadencr":{"backgroundWorkPending":true}});
        harness
            .send_burst(&[
                chunk(),
                json!({"jsonrpc":"2.0", "id":id, "result":result}),
                release_work("foreign"),
                release_work("s-1"),
                release_work("s-1"),
                usage("s-1", 7, false),
            ])
            .await;
        let events = harness.through_usage(7).await;
        await_prompt(task).await;
        let (index, receipt) = events
            .iter()
            .enumerate()
            .find(|(_, event)| event.is_result())
            .unwrap();
        assert!(index > 0 && is_block_stop(&events[index - 1]));
        assert!(receipt.token_usage().is_some());
        assert!(matches!(
            receipt.background_agent_signal(),
            Some(BackgroundAgentSignal::Started { .. })
        ));
        let mut releases = events[index + 1..].iter().filter(|event| event.is_result());
        let release = releases.next().expect("one work release");
        assert!(release.is_detached_reply_end() && release.token_usage().is_none());
        assert!(matches!(
            release.background_agent_signal(),
            Some(BackgroundAgentSignal::Finished { .. })
        ));
        assert!(releases.next().is_none());
    }

    #[tokio::test]
    async fn work_release_during_a_new_prompt_preserves_that_prompts_open_blocks() {
        let mut harness = Harness::new().await;
        let (id, first) = harness.start_prompt().await;
        let mut result = prompt_result();
        result["_meta"] = json!({"cadencr":{"backgroundWorkPending":true}});
        send_response(&mut harness.stdout, id, result).await;
        await_prompt(first).await;
        assert!(harness.next().await.is_result());

        let (id, second) = harness.start_prompt().await;
        harness
            .send_burst(&[chunk(), release_work("s-1"), usage("s-1", 7, false)])
            .await;
        let events = harness.through_usage(7).await;
        let release = events.iter().find(|e| e.is_detached_reply_end()).unwrap();
        assert!(matches!(
            release.background_agent_signal(),
            Some(BackgroundAgentSignal::Finished { .. })
        ));
        assert!(!events.iter().any(is_block_stop));
        assert!(!second.is_finished());

        send_response(&mut harness.stdout, id, prompt_result()).await;
        await_prompt(second).await;
        assert!(is_block_stop(&harness.next().await));
        let result = harness.next().await;
        assert!(result.is_result() && result.token_usage().is_some());
        assert!(result.background_agent_signal().is_none());
    }

    #[tokio::test]
    async fn unmarked_boundaries_keep_the_hold_and_a_racing_release_leaves_the_reply_open() {
        let mut harness = Harness::new().await;
        let (id, first) = harness.start_prompt().await;
        let mut result = prompt_result();
        result["_meta"] = json!({"cadencr":{"backgroundWorkPending":true}});
        send_response(&mut harness.stdout, id, result).await;
        await_prompt(first).await;
        assert!(matches!(
            harness.next().await.background_agent_signal(),
            Some(BackgroundAgentSignal::Started { .. })
        ));

        let (id, second) = harness.start_prompt().await;
        send_response(&mut harness.stdout, id, prompt_result()).await;
        await_prompt(second).await;
        assert!(matches!(
            harness.next().await.background_agent_signal(),
            Some(BackgroundAgentSignal::Started { .. })
        ));

        harness
            .send_burst(&[chunk(), usage("s-1", 1, true), usage("s-1", 2, false)])
            .await;
        let events = harness.through_usage(2).await;
        let boundary = events.iter().find(|e| e.is_detached_reply_end()).unwrap();
        assert!(matches!(
            boundary.background_agent_signal(),
            Some(BackgroundAgentSignal::Started { .. })
        ));

        harness
            .send_burst(&[chunk(), release_work("s-1"), usage("s-1", 3, false)])
            .await;
        let events = harness.through_usage(3).await;
        assert!(!events.iter().any(|e| e.is_result() || is_block_stop(e)));
        assert!(events.iter().any(|e| matches!(
            e.background_agent_signal(),
            Some(BackgroundAgentSignal::Finished { .. })
        )));

        harness
            .send(update(
                "s-1",
                json!({"sessionUpdate":"session_info_update","_meta":{"cadencr":{
                    "detachedReplyEnded":true,"backgroundWorkPending":false
                }}}),
            ))
            .await;
        assert!(!harness.next().await.is_result());
        assert!(is_block_stop(&harness.next().await));
        let final_boundary = harness.next().await;
        assert!(final_boundary.is_detached_reply_end());
        assert!(final_boundary.background_agent_signal().is_none());
    }

    #[tokio::test]
    async fn cancellation_marker_completes_a_held_detached_reply_without_a_usage_budget() {
        let mut harness = Harness::new().await;
        let cancel = PromptCancel::new();
        harness
            .config
            .indexer
            .lock()
            .unwrap()
            .watch_prompt_cancel(cancel.clone());
        let (id, task) = harness.start_prompt().await;
        let mut result = prompt_result();
        result["_meta"] = json!({"cadencr":{"backgroundWorkPending":true}});
        send_response(&mut harness.stdout, id, result).await;
        await_prompt(task).await;
        assert!(harness.next().await.is_result());
        harness.send(chunk()).await;
        loop {
            let event = harness.next().await;
            if matches!(
                event.stream_event(),
                Some(RuntimeStreamEvent::ContentBlockDelta { .. })
            ) {
                break;
            }
        }

        cancel.cancel_current_turn();
        harness
            .send(update(
                "s-1",
                json!({"sessionUpdate":"session_info_update","_meta":{"cadencr":{"detachedReplyEnded":true}}}),
            ))
            .await;
        assert!(!harness.next().await.is_result());
        assert!(is_block_stop(&harness.next().await));
        let end = harness.next().await;
        assert!(end.is_detached_reply_end());
        assert!(matches!(
            end.background_agent_signal(),
            Some(BackgroundAgentSignal::Finished { .. })
        ));
    }

    #[tokio::test]
    async fn detached_reply_ends_only_on_a_same_session_marker_after_content() {
        let mut harness = Harness::new().await;
        harness.end_prompt().await;
        harness.send(usage("s-1", 1, true)).await;
        assert_eq!(harness.through_usage(1).await.len(), 1);

        for _ in 0..2 {
            harness.send(chunk()).await;
            harness.send(usage("s-1", 2, false)).await;
            let events = harness.through_usage(2).await;
            assert!(matches!(
                events[0].stream_event(),
                Some(RuntimeStreamEvent::MessageStart { .. })
            ));
            assert!(!events.iter().any(RuntimeEvent::is_result));
            harness.send(usage("other-session", 3, true)).await;
            assert_eq!(harness.through_usage(3).await.len(), 1);
            harness.send(usage("s-1", 4, true)).await;
            assert_eq!(harness.through_usage(4).await.len(), 1);
            assert!(is_block_stop(&harness.next().await));
            let end = harness.next().await;
            assert!(end.is_result());
            assert_eq!(end.raw_json()["source"], "detached_reply");
            assert!(end.token_usage().is_none());
            assert!(end.usage().is_none());

            harness.send(usage("s-1", 5, true)).await;
            harness.send(usage("s-1", 6, false)).await;
            assert_eq!(
                harness.through_usage(6).await.len(),
                2,
                "duplicate marker must be inert"
            );
        }
    }

    #[tokio::test]
    async fn a_detached_marker_does_not_complete_an_in_flight_prompt() {
        let mut harness = Harness::new().await;
        harness.end_prompt().await;
        harness.send(chunk()).await;
        harness.send(usage("s-1", 1, false)).await;
        harness.through_usage(1).await;

        let (id, task) = harness.start_prompt().await;
        harness.send(chunk()).await;
        harness.send(usage("s-1", 2, true)).await;
        harness.send(usage("s-1", 3, false)).await;
        let events = harness.through_usage(3).await;
        assert!(!events.iter().any(RuntimeEvent::is_result));
        assert!(!task.is_finished());
        send_response(&mut harness.stdout, id, prompt_result()).await;
        await_prompt(task).await;
        assert!(is_block_stop(&harness.next().await));
        let result = harness.next().await;
        assert_eq!(result.raw_json()["stop_reason"], "end_turn");
        assert!(result.token_usage().is_some());
    }

    #[tokio::test]
    async fn immediate_post_response_chunks_in_the_same_wire_burst_are_closed() {
        let mut harness = Harness::new().await;
        let (id, task) = harness.start_prompt().await;
        let frames = [
            json!({"jsonrpc":"2.0", "id":id, "result":prompt_result()}),
            chunk(),
            usage("s-1", 1, true),
            usage("s-1", 2, false),
        ];
        harness.send_burst(&frames).await;
        let events = harness.through_usage(2).await;
        await_prompt(task).await;
        assert!(events[0].is_result());
        assert!(events[1..].iter().any(|event| matches!(
            event.stream_event(),
            Some(RuntimeStreamEvent::ContentBlockDelta { .. })
        )));
        assert_eq!(
            events
                .iter()
                .filter(|event| event.token_usage().is_some())
                .count(),
            1
        );
        assert_eq!(
            events.iter().filter(|event| is_block_stop(event)).count(),
            1
        );
        assert_eq!(events.iter().filter(|event| event.is_result()).count(), 2);
        let indexer = harness.config.indexer.lock().unwrap();
        assert!(indexer.current_text_index.is_none());
        assert!(indexer.current_thinking_index.is_none());
    }
}
