//! Native events through the real authenticated socket, including interruption.
use super::*;
use futures::{SinkExt, StreamExt};
use tokio_tungstenite::tungstenite::{client::IntoClientRequest, Message};

type Socket =
    tokio_tungstenite::WebSocketStream<tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>>;

async fn next(ws: &mut Socket) -> Value {
    loop {
        let frame = tokio::time::timeout(Duration::from_secs(3), ws.next())
            .await
            .unwrap()
            .unwrap()
            .unwrap();
        match frame {
            Message::Text(text) => return serde_json::from_str(text.as_str()).unwrap(),
            Message::Ping(_) | Message::Pong(_) => {}
            other => panic!("unexpected {other:?}"),
        }
    }
}

async fn send(ws: &mut Socket, id: &str, action: &str, payload: Value) {
    ws.send(Message::Text(
        json!({
            "id":id, "domain":"plugin", "action":action, "payload":payload,
        })
        .to_string()
        .into(),
    ))
    .await
    .unwrap();
}

async fn reply(ws: &mut Socket, id: &str) -> Value {
    loop {
        let frame = next(ws).await;
        if frame["ref"] == id {
            return frame;
        }
    }
}

async fn subscribe(ws: &mut Socket, id: &str) -> String {
    send(
        ws,
        id,
        "subscribe",
        json!({"topic":"backend.events", "params":{"topic":"clock.tick"}}),
    )
    .await;
    let frame = reply(ws, id).await;
    assert_eq!(frame["action"], "subscribed", "{frame}");
    frame["payload"]["subscription_id"].as_str().unwrap().into()
}

async fn emit(ws: &mut Socket, id: &str) -> Value {
    send(
        ws,
        id,
        "backend.request",
        json!({
            "method":"emit", "params":{"id":id}, "plugin_id":"native", "feature_id":OTHER_FEATURE,
        }),
    )
    .await;
    let mut event = None;
    let mut answered = false;
    while event.is_none() || !answered {
        let frame = next(ws).await;
        if frame["action"] == "event" {
            event = Some(frame);
        } else if frame["ref"] == id {
            assert_eq!(frame["action"], "backend.response", "{frame}");
            answered = true;
        }
    }
    event.unwrap()
}

pub(super) async fn verify(fixture: &Fixture) {
    let token = fixture.token("events").await;
    let mut request = format!("ws://127.0.0.1:{}/api/plugin-tabs/ws", fixture.port)
        .into_client_request()
        .unwrap();
    request.headers_mut().insert(
        "sec-websocket-protocol",
        format!("cadencr-plugin.{token}").parse().unwrap(),
    );
    let (mut ws, _) = tokio_tungstenite::connect_async(request).await.unwrap();
    let id = subscribe(&mut ws, "subscribe").await;
    let event = emit(&mut ws, "first").await;
    assert_eq!(event["payload"]["subscription_id"], id);
    let native = &event["payload"]["envelope"]["payload"];
    assert_eq!(native["topic"], "clock.tick");
    assert_eq!(native["seq"], 1);
    assert_ne!(native["run_id"], "forged");
    let run_id = native["run_id"].clone();
    let seq = event["payload"]["seq"].as_u64().unwrap();

    // The authenticated identity wins over extra plugin/feature fields.
    send(
        &mut ws,
        "identity",
        "backend.request",
        json!({"method":"context", "feature_id":OTHER_FEATURE}),
    )
    .await;
    let identity = reply(&mut ws, "identity").await;
    assert_eq!(identity["payload"]["result"]["feature_id"], FEATURE);

    // A pending call does not block unsubscribe on the read loop.
    send(&mut ws, "slow", "backend.request", json!({"method":"slow"})).await;
    send(
        &mut ws,
        "unsubscribe",
        "unsubscribe",
        json!({"subscription_id":id}),
    )
    .await;
    let unsubscribed =
        tokio::time::timeout(Duration::from_millis(250), reply(&mut ws, "unsubscribe"))
            .await
            .unwrap();
    assert_eq!(unsubscribed["action"], "unsubscribed");
    assert_eq!(reply(&mut ws, "slow").await["action"], "backend.response");
    subscribe(&mut ws, "again").await;

    // The source survives a process stop, with a visible error and resync.
    fixture
        .send(
            Method::DELETE,
            &format!("/api/plugin-tabs/events/backends/{FEATURE}"),
            None,
            None,
        )
        .await;
    let mut resynced = false;
    let mut exited = false;
    while !resynced || !exited {
        let frame = next(&mut ws).await;
        resynced |= frame["action"] == "resync";
        if frame["action"] == "error" {
            assert_eq!(frame["payload"]["code"], "PLUGIN_BACKEND_EXITED");
            exited = true;
        }
    }
    assert!(resynced);
    let restarted = emit(&mut ws, "restart").await;
    let native = &restarted["payload"]["envelope"]["payload"];
    assert_ne!(native["run_id"], run_id);
    assert_eq!(native["seq"], 1);
    assert!(restarted["payload"]["seq"].as_u64().unwrap() >= seq);

    send(
        &mut ws,
        "invalid",
        "backend.request",
        json!({"method":"invalid_event"}),
    )
    .await;
    let mut failed = false;
    let mut answered = false;
    while !failed || !answered {
        let frame = next(&mut ws).await;
        failed |= frame["payload"]["code"] == "PLUGIN_BACKEND_EVENT_INVALID";
        answered |= frame["ref"] == "invalid";
    }
    fixture.set_enabled("events", false).await;
    loop {
        match tokio::time::timeout(Duration::from_secs(3), ws.next())
            .await
            .unwrap()
            .unwrap()
            .unwrap()
        {
            Message::Close(Some(frame)) => {
                assert_eq!(u16::from(frame.code), 1008);
                break;
            }
            Message::Text(_) => {}
            frame => panic!("expected policy close, got {frame:?}"),
        }
    }
}
