use super::*;

fn requests(h: &Harness) -> Vec<Value> {
    std::fs::read_to_string(h.repo.join("queue-rpc.jsonl"))
        .unwrap()
        .lines()
        .map(|line| serde_json::from_str(line).unwrap())
        .collect()
}

async fn wait_idle(h: &Harness, session: i64) {
    tokio::time::timeout(Duration::from_secs(10), async {
        loop {
            let status: String = sqlx::query_scalar("SELECT status FROM agent_sessions WHERE id=?")
                .bind(session)
                .fetch_one(&h.pool)
                .await
                .unwrap();
            if status != "running" {
                break;
            }
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
    })
    .await
    .unwrap();
}

pub(super) async fn deferred_retransmissions_run_once(h: &Harness) {
    let (mut socket, session) = h.session(true).await;
    send(
        &mut socket,
        "compact",
        json!({"session_id":session.to_string()}),
    )
    .await;
    until(&mut socket, "compact.started").await;
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
    h.wait_empty(session).await;
    wait_idle(h, session).await;
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
    wait_idle(h, session).await;
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
        let barrier = h.repo.join("pause-resume");
        std::fs::write(&barrier, "").unwrap();
        if reject_resume {
            std::fs::write(h.repo.join("fail-resume-once"), "").unwrap();
        }
        send(
            &mut socket,
            "compact",
            json!({"session_id":session.to_string()}),
        )
        .await;
        tokio::time::timeout(Duration::from_secs(5), async {
            while !requests(h)
                .iter()
                .any(|r| r["method"] == "thread/resume" && r["params"]["threadId"] == runtime_id)
            {
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
        })
        .await
        .unwrap();
        let queued = tokio::time::timeout(
            Duration::from_secs(2),
            h.enqueue(session, "queued during initialization"),
        )
        .await;
        // Release the subprocess even when acceptance unexpectedly blocked.
        std::fs::remove_file(&barrier).unwrap();
        let queued =
            queued.expect("enqueue must not start another runtime while compaction initializes");
        assert_eq!(h.state(queued).await, "pending");
        h.wait_empty(session).await;
        wait_idle(h, session).await;
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
    let runtime_id: String =
        sqlx::query_scalar("SELECT runtime_session_id FROM agent_sessions WHERE id=?")
            .bind(session)
            .fetch_one(&h.pool)
            .await
            .unwrap();
    std::fs::write(h.repo.join("slow-compact-ack"), "").unwrap();
    send(
        &mut socket,
        "compact",
        json!({"session_id":session.to_string()}),
    )
    .await;
    tokio::time::timeout(Duration::from_secs(5), async {
        while !requests(h)
            .iter()
            .any(|r| r["method"] == "thread/compact/start" && r["params"]["threadId"] == runtime_id)
        {
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await
    .unwrap();
    let queued = h.enqueue(session, "after compact late ack").await;
    h.wait_empty(session).await;
    assert_eq!(h.state(queued).await, "delivered");
    socket.close(None).await.unwrap();
}
