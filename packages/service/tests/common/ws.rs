use crate::common::TEST_AUTH_TOKEN;
use cadencr_service::domain::ws_session::protocol::WsEnvelope;
use futures::{SinkExt, StreamExt};
use serde_json::Value;
use std::time::Duration;
use tokio::net::TcpStream;
use tokio_tungstenite::tungstenite::client::IntoClientRequest;
use tokio_tungstenite::tungstenite::{http::HeaderValue, Message};
use tokio_tungstenite::{MaybeTlsStream, WebSocketStream};

pub type Socket = WebSocketStream<MaybeTlsStream<TcpStream>>;

pub async fn connect(base: &str) -> Socket {
    let mut request = format!("{}/ws", base.replace("http://", "ws://"))
        .into_client_request()
        .unwrap();
    request.headers_mut().insert(
        "Sec-WebSocket-Protocol",
        HeaderValue::from_str(&format!("cadencr-token.{TEST_AUTH_TOKEN}")).unwrap(),
    );
    tokio_tungstenite::connect_async(request).await.unwrap().0
}

pub async fn send(socket: &mut Socket, domain: &str, action: &str, payload: Value) {
    let envelope = WsEnvelope::new(domain, action, payload);
    socket
        .send(Message::Text(String::from(envelope).into()))
        .await
        .unwrap();
}

pub async fn next(socket: &mut Socket) -> Value {
    let deadline = tokio::time::Instant::now() + Duration::from_secs(15);
    loop {
        match tokio::time::timeout_at(deadline, socket.next())
            .await
            .expect("WS timeout")
            .expect("WS closed")
            .unwrap()
        {
            Message::Text(text) => return serde_json::from_str(&text).unwrap(),
            Message::Ping(payload) => socket.send(Message::Pong(payload)).await.unwrap(),
            Message::Close(frame) => panic!("unexpected close: {frame:?}"),
            _ => {}
        }
    }
}
