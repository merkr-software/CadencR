use super::*;

pub(super) async fn invalid_settings_refuse_cold_and_reused_codex_prompts(h: &Harness) {
    use cadencr_service::domain::settings_store;

    let dir = settings_store::global_dir();
    std::fs::create_dir_all(&dir).unwrap();
    let path = settings_store::paths::global_file(&dir);
    let (mut warm, warm_id) = h.session(false).await;
    prompt(&mut warm, warm_id, "warmup").await;
    until(&mut warm, "ended").await;
    let (mut cold, cold_id) = h.session(false).await;
    let before = turn_requests(h);

    // The warm-up can persist the last-used selection to the fixture file.
    if let Err(error) = std::fs::remove_file(&path) {
        assert_eq!(error.kind(), std::io::ErrorKind::NotFound);
    }
    std::fs::create_dir(&path).unwrap();
    expect_settings_refusal(&mut cold, cold_id, "SETTINGS_READ_FAILED").await;
    expect_settings_refusal(&mut warm, warm_id, "SETTINGS_READ_FAILED").await;
    std::fs::remove_dir(&path).unwrap();

    for invalid in ["{ broken", r#"{"workspace_mcp_enabled":[]}"#] {
        std::fs::write(&path, invalid).unwrap();
        expect_settings_refusal(&mut cold, cold_id, "SETTINGS_INVALID").await;
        expect_settings_refusal(&mut warm, warm_id, "SETTINGS_INVALID").await;
    }
    assert_eq!(turn_requests(h), before);
    let rejected: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM agent_messages m WHERE m.session_id IN (?, ?) AND m.delivery_state='delivery_failed'
         AND NOT EXISTS (SELECT 1 FROM agent_message_dispatches d WHERE d.message_id=m.id)",
    ).bind(cold_id).bind(warm_id).fetch_one(&h.pool).await.unwrap();
    assert_eq!(rejected, 6);
    assert!(h.queue(cold_id).await.is_empty() && h.queue(warm_id).await.is_empty());

    std::fs::write(&path, "{}").unwrap();
    prompt(&mut cold, cold_id, "manual cold send").await;
    until(&mut cold, "ended").await;
    prompt(&mut warm, warm_id, "manual warm send").await;
    until(&mut warm, "ended").await;
    assert_eq!(turn_requests(h), before + 2);
    assert!(h
        .user_messages(cold_id)
        .await
        .ends_with(&["manual cold send".to_owned()]));
    assert!(h
        .user_messages(warm_id)
        .await
        .ends_with(&["manual warm send".to_owned()]));

    let completion = ProviderGate::arm(&h.repo, "held-turn-completion");
    prompt(&mut warm, warm_id, "hold").await;
    completion.wait().await;
    std::fs::write(&path, "{ broken again").unwrap();
    expect_settings_refusal(&mut warm, warm_id, "SETTINGS_INVALID").await;
    assert_eq!(turn_requests(h), before + 3);
    send(
        &mut warm,
        "interrupt",
        json!({"session_id":warm_id.to_string()}),
    )
    .await;
    until(&mut warm, "ended").await;
    assert!(requests(h)
        .iter()
        .any(|request| request["method"] == "turn/interrupt"));
    completion.release();
    std::fs::remove_file(path).unwrap();
    cold.close(None).await.unwrap();
    warm.close(None).await.unwrap();
}

fn turn_requests(h: &Harness) -> usize {
    requests(h)
        .iter()
        .filter(|request| {
            matches!(
                request["method"].as_str(),
                Some("turn/start" | "turn/steer")
            )
        })
        .count()
}

async fn expect_settings_refusal(socket: &mut Socket, session: i64, code: &str) {
    let envelope = WsEnvelope::new(
        "session",
        "prompt.send",
        json!({
            "session_id":session.to_string(),
            "text":"Do not send during settings repair",
            "message_uuid":uuid::Uuid::new_v4().to_string()
        }),
    );
    let id = envelope.id.clone();
    socket
        .send(Message::Text(String::from(envelope).into()))
        .await
        .unwrap();
    tokio::time::timeout(Duration::from_secs(10), async {
        loop {
            if let Message::Text(text) = socket.next().await.unwrap().unwrap() {
                let event: Value = serde_json::from_str(&text).unwrap();
                if event["ref"] == id {
                    assert_eq!(event["action"], "error", "{event}");
                    assert_eq!(event["payload"]["code"], code, "{event}");
                    break;
                }
            }
        }
    })
    .await
    .expect("settings refusal");
}

fn requests(h: &Harness) -> Vec<Value> {
    std::fs::read_to_string(h.repo.join("queue-rpc.jsonl"))
        .unwrap()
        .lines()
        .map(|line| serde_json::from_str(line).unwrap())
        .collect()
}

pub(super) async fn completed_turn_with_late_ack_drains_queue(h: &Harness) {
    let (mut socket, session) = h.session(false).await;
    // The first turn's reply is required before the service starts reading
    // the runtime's stream. Warm up so it can process the next turn's events.
    prompt(&mut socket, session, "warmup").await;
    until(&mut socket, "ended").await;
    until(&mut socket, "mcp_servers").await;

    let reply = ProviderGate::arm(&h.repo, "turn-start-reply");
    let (slow, later) = tokio::join!(h.enqueue(session, "slow-ack"), async {
        reply.wait().await;
        let ended = until(&mut socket, "ended").await;
        assert_eq!(ended["payload"]["reason"], "turn_complete");
        // The post-turn MCP refresh follows the completion-triggered drain.
        until(&mut socket, "mcp_servers").await;
        let later =
            tokio::time::timeout(Duration::from_secs(2), h.enqueue(session, "after slow ack"))
                .await
                .expect("enqueue must return while the previous delivery is unacknowledged");
        let queue = h.queue(session).await;
        assert_eq!(queue.len(), 2, "{queue:?}");
        assert_eq!(queue[0]["content"], "slow-ack");
        assert_eq!(queue[0]["status"], "delivering");
        assert_eq!(queue[1]["id"], later);
        assert_eq!(queue[1]["status"], "pending");
        reply.release();
        later
    });
    h.wait_empty(session).await;
    assert_eq!(h.state(slow).await, "delivered");
    assert_eq!(h.state(later).await, "delivered");
    socket.close(None).await.unwrap();
}

pub(super) async fn deferred_retransmissions_run_once(h: &Harness) {
    let (mut socket, session) = h.session(true).await;
    let completion = ProviderGate::arm(&h.repo, "compact-turn-completion");
    send(
        &mut socket,
        "compact",
        json!({"session_id":session.to_string()}),
    )
    .await;
    until(&mut socket, "compact.started").await;
    completion.wait().await;
    let message_uuid = uuid::Uuid::new_v4().to_string();
    let payload = json!({"session_id":session.to_string(),"text":"same logical request","message_uuid":message_uuid});
    send(&mut socket, "prompt.send", payload.clone()).await;
    send(&mut socket, "prompt.send", payload.clone()).await;
    // A later message on the same connection proves both retries were handled.
    prompt(&mut socket, session, "queue barrier").await;
    tokio::time::timeout(Duration::from_secs(2), async {
        while h.queue(session).await.len() < 2 {
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await
    .unwrap();
    assert_eq!(h.queue(session).await.len(), 2);
    completion.release();
    h.wait_empty(session).await;
    h.wait_idle(session).await;
    send(&mut socket, "prompt.send", payload).await;
    prompt(&mut socket, session, "after replay").await;
    tokio::time::timeout(Duration::from_secs(5), async {
        loop {
            if requests(h)
                .iter()
                .any(|r| r["params"]["input"][0]["text"] == "after replay")
            {
                break;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await
    .unwrap();
    h.wait_idle(session).await;
    let delivered: Vec<Value> = requests(h)
        .into_iter()
        .filter(|r| r["params"]["input"][0]["text"] == "same logical request")
        .collect();
    assert_eq!(
        delivered.len(),
        1,
        "a retransmitted request must execute once"
    );
    let persisted_uuid: String = sqlx::query_scalar(
        "SELECT message_uuid FROM agent_messages WHERE session_id=? AND content='same logical request'",
    ).bind(session).fetch_one(&h.pool).await.unwrap();
    assert_eq!(persisted_uuid, message_uuid);
    assert_eq!(
        h.user_messages(session)
            .await
            .iter()
            .filter(|text| *text == "same logical request")
            .count(),
        1
    );
    socket.close(None).await.unwrap();
}

pub(super) async fn queue_waits_for_compaction_initialization(h: &Harness) {
    for reject_resume in [false, true] {
        let (mut socket, session) = h.session(true).await;
        let runtime_id: String =
            sqlx::query_scalar("SELECT runtime_session_id FROM agent_sessions WHERE id=?")
                .bind(session)
                .fetch_one(&h.pool)
                .await
                .unwrap();
        let resume = ProviderGate::arm(&h.repo, "resume-reply");
        if reject_resume {
            std::fs::write(h.repo.join("fail-resume-once"), "").unwrap();
        }
        send(
            &mut socket,
            "compact",
            json!({"session_id":session.to_string()}),
        )
        .await;
        resume.wait().await;
        let queued = tokio::time::timeout(
            Duration::from_secs(2),
            h.enqueue(session, "queued during initialization"),
        )
        .await;
        let queued =
            queued.expect("enqueue must not start another runtime while compaction initializes");
        assert_eq!(h.state(queued).await, "pending");
        resume.release();
        h.wait_empty(session).await;
        h.wait_idle(session).await;
        let resume_count = requests(h)
            .iter()
            .filter(|r| r["method"] == "thread/resume" && r["params"]["threadId"] == runtime_id)
            .count();
        assert_eq!(resume_count, if reject_resume { 2 } else { 1 });
        assert_eq!(h.state(queued).await, "delivered");
        socket.close(None).await.unwrap();
    }
}

pub(super) async fn completed_compaction_with_late_ack_drains_queue(h: &Harness) {
    let (mut socket, session) = h.session(true).await;
    let reply = ProviderGate::arm(&h.repo, "compact-reply");
    let completion = ProviderGate::arm(&h.repo, "compact-turn-completion");
    send(
        &mut socket,
        "compact",
        json!({"session_id":session.to_string()}),
    )
    .await;
    reply.wait().await;
    let queued = tokio::time::timeout(
        Duration::from_secs(2),
        h.enqueue(session, "after compact late ack"),
    )
    .await
    .expect("enqueue must not wait for the provider's compaction reply");
    assert_eq!(h.state(queued).await, "pending");
    completion.wait().await;
    completion.release();
    let ended = until(&mut socket, "ended").await;
    assert_eq!(ended["payload"]["reason"], "turn_complete");
    assert_eq!(h.state(queued).await, "pending");
    reply.release();
    h.wait_empty(session).await;
    assert_eq!(h.state(queued).await, "delivered");
    socket.close(None).await.unwrap();
}
