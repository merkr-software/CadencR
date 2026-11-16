//! Wrapping internal events as `plugin/event` for every subscription of a
//! topic.
//!
//! A socket runs one source per topic; repeated subscriptions to the topic
//! join it as extra [`Member`]s, each with its own id and `seq`. Forwarded
//! frames are parsed only as far as their head — the payload stays raw JSON,
//! spliced into the wrapper without being rebuilt.

use std::borrow::Cow;
use std::sync::{Arc, Mutex, MutexGuard};

use serde::{Deserialize, Serialize};
use serde_json::json;
use serde_json::value::RawValue;
use uuid::Uuid;

use super::outbound::Outbound;
use crate::domain::ws_session::protocol::WsEnvelope;

pub struct Member {
    pub id: String,
    seq: u64,
}

impl Member {
    pub fn new(id: String) -> Self {
        Self { id, seq: 0 }
    }
}

/// The subscriptions sharing one topic's source.
pub type Members = Arc<Mutex<Vec<Member>>>;

pub fn lock(members: &Members) -> MutexGuard<'_, Vec<Member>> {
    // Push/retain/seq bumps only: a poisoned list is still consistent.
    members
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

/// An internal envelope as received from a source: its head borrowed, its
/// payload left as raw JSON.
#[derive(Deserialize)]
pub struct Frame<'a> {
    #[serde(borrow)]
    pub domain: Cow<'a, str>,
    #[serde(borrow)]
    pub action: Cow<'a, str>,
    #[serde(rename = "ref", default)]
    pub r#ref: Option<serde::de::IgnoredAny>,
    #[serde(borrow)]
    pub payload: &'a RawValue,
}

impl<'a> Frame<'a> {
    pub fn parse(text: &'a str) -> Option<Self> {
        serde_json::from_str(text).ok()
    }
}

#[derive(Serialize)]
struct Wrapped<'a, P: Serialize + ?Sized> {
    id: String,
    domain: &'static str,
    action: &'static str,
    payload: EventPayload<'a, P>,
}

#[derive(Serialize)]
struct EventPayload<'a, P: Serialize + ?Sized> {
    subscription_id: &'a str,
    topic: &'static str,
    seq: u64,
    envelope: Inner<'a, P>,
}

#[derive(Serialize)]
struct Inner<'a, P: Serialize + ?Sized> {
    domain: &'a str,
    action: &'a str,
    payload: &'a P,
}

/// Stamps `seq` per subscription and wraps internal events as `plugin/event`.
pub struct Emitter {
    out: Outbound,
    topic: &'static str,
    members: Members,
}

impl Emitter {
    pub fn new(out: Outbound, topic: &'static str, members: Members) -> Self {
        Self {
            out,
            topic,
            members,
        }
    }

    /// Emit one event to every subscription of the topic. `false` once the
    /// socket is gone.
    pub fn emit<P: Serialize + ?Sized>(&self, domain: &str, action: &str, payload: &P) -> bool {
        let mut members = lock(&self.members);
        for member in members.iter_mut() {
            member.seq += 1;
            let event = Wrapped {
                id: Uuid::new_v4().to_string(),
                domain: "plugin",
                action: "event",
                payload: EventPayload {
                    subscription_id: &member.id,
                    topic: self.topic,
                    seq: member.seq,
                    envelope: Inner {
                        domain,
                        action,
                        payload,
                    },
                },
            };
            match serde_json::to_string(&event) {
                Ok(text) => {
                    if !self.out.event(text, &member.id, self.topic) {
                        return false;
                    }
                }
                Err(error) => self.out.control(WsEnvelope::new(
                    "plugin",
                    "error",
                    json!({
                        "subscription_id": member.id,
                        "code": "PLUGIN_EVENT_INVALID",
                        "message": format!("a `{domain}/{action}` event could not be encoded: {error}"),
                    }),
                )),
            }
        }
        true
    }

    /// Forward a source frame unchanged.
    pub fn emit_frame(&self, frame: &Frame<'_>) -> bool {
        self.emit(&frame.domain, &frame.action, frame.payload)
    }

    /// The source dropped events: every subscription should refetch.
    pub fn resync(&self) -> bool {
        for member in lock(&self.members).iter() {
            self.out.owe(&member.id, self.topic);
        }
        !self.out.is_closed()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::domain::plugin_tabs::socket::outbound;
    use axum::extract::ws::Message;
    use serde_json::Value;

    #[test]
    fn frames_keep_their_payload_raw_and_every_member_gets_its_own_seq() {
        let text = r#"{"id":"x","domain":"session","action":"message","payload":{"n":1.50}}"#;
        let frame = Frame::parse(text).unwrap();
        assert!(frame.r#ref.is_none());
        assert_eq!(frame.payload.get(), r#"{"n":1.50}"#);
        let replied = r#"{"id":"x","domain":"session","action":"a","ref":"r","payload":null}"#;
        assert!(Frame::parse(replied).unwrap().r#ref.is_some());
        let (out, mut rx) = outbound::channel(8);
        let members: Members = Arc::new(Mutex::new(vec![Member::new("s1".into())]));
        let emitter = Emitter::new(out, "session.stream", members.clone());
        assert!(emitter.emit_frame(&frame));
        lock(&members).push(Member::new("s2".into()));
        assert!(emitter.emit_frame(&frame));
        let raw: Vec<String> = std::iter::from_fn(|| rx.try_recv().ok())
            .map(|message| match message {
                Message::Text(text) => text.as_str().to_string(),
                other => panic!("unexpected {other:?}"),
            })
            .collect();
        // The payload's bytes are spliced in as they came, not re-encoded.
        assert!(raw[0].contains(r#""payload":{"n":1.50}"#), "{}", raw[0]);
        let events: Vec<Value> = raw
            .iter()
            .map(|text| serde_json::from_str(text).unwrap())
            .collect();
        let seqs: Vec<(String, u64)> = events
            .iter()
            .map(|event| {
                (
                    event["payload"]["subscription_id"].as_str().unwrap().into(),
                    event["payload"]["seq"].as_u64().unwrap(),
                )
            })
            .collect();
        assert_eq!(seqs, [("s1".into(), 1), ("s1".into(), 2), ("s2".into(), 1)]);
        assert_eq!(events[0]["payload"]["envelope"]["action"], "message");
        assert_eq!(events[0]["payload"]["topic"], "session.stream");
    }
}
