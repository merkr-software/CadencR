//! One plugin socket's subscriptions: the `plugin` domain protocol and the
//! lifetime of every internal source a subscription starts.
//!
//! A socket runs at most one source per topic. The first subscription to a
//! topic starts it; later ones join it (and get a `plugin/resync`, having
//! missed its snapshot); the last one to leave stops it. A source that keeps
//! a sender registered elsewhere (the git watcher, the feature sender
//! registry) carries a [`Cleanup`] that unregisters it, so nothing the plugin
//! subscribed to outlives it.

use std::collections::HashMap;
use std::sync::{Arc, Mutex};

use axum::extract::ws::Message;
use futures::future::BoxFuture;
use serde_json::{json, Value};
use tokio::sync::mpsc;
use tokio::task::JoinHandle;

use super::emitter::{lock, Emitter, Member, Members};
use super::outbound::Outbound;
use super::topics::{self, Topic};
use crate::app_state::AppState;
use crate::domain::plugin_tabs::grants::Grant;
use crate::domain::ws_session::protocol::WsEnvelope;

/// A guest has no reason to hold more subscriptions than this at once (they
/// share at most one source per topic).
pub const MAX_SUBSCRIPTIONS: usize = 32;

/// What a source registered outside its own task.
pub enum Cleanup {
    None,
    GitWatcher(mpsc::UnboundedSender<Message>),
    FeatureObserver(mpsc::Sender<Message>),
}

/// A source ready to run: its forwarder is spawned only once the
/// `subscribed` reply is queued, so no event can precede it.
pub struct Started {
    pub run: BoxFuture<'static, ()>,
    pub cleanup: Cleanup,
}

struct Source {
    task: JoinHandle<()>,
    cleanup: Cleanup,
    members: Members,
}

impl Source {
    async fn stop(self, state: &AppState) {
        self.task.abort();
        match self.cleanup {
            Cleanup::None => {}
            Cleanup::GitWatcher(sender) => state.git_watcher.unsubscribe_sender(&sender).await,
            Cleanup::FeatureObserver(sender) => state.ws_feature_senders.unobserve(&sender),
        }
    }
}

pub struct Subscriptions {
    state: AppState,
    grant: Grant,
    out: Outbound,
    sources: HashMap<Topic, Source>,
    next_id: u64,
}

impl Subscriptions {
    pub fn new(state: AppState, grant: Grant, out: Outbound) -> Self {
        Self {
            state,
            grant,
            out,
            sources: HashMap::new(),
            next_id: 0,
        }
    }

    /// Handle one client text frame.
    pub async fn handle(&mut self, text: &str) {
        let envelope = match WsEnvelope::try_from(text.to_string()) {
            Ok(envelope) => envelope,
            Err(error) => {
                self.error(None, "PARSE_ERROR", &format!("invalid envelope: {error}"));
                return;
            }
        };
        if envelope.domain != "plugin" {
            let message = format!(
                "a plugin socket only accepts the `plugin` domain, not `{}`",
                envelope.domain
            );
            self.error(Some(&envelope.id), "PLUGIN_DOMAIN_DENIED", &message);
            return;
        }
        match envelope.action.as_str() {
            "subscribe" => self.subscribe(&envelope).await,
            "unsubscribe" => self.unsubscribe(&envelope).await,
            other => {
                let message = format!("unknown plugin action `{other}`");
                self.error(Some(&envelope.id), "PLUGIN_ACTION_UNKNOWN", &message);
            }
        }
    }

    /// Over the inbound budget: one error per window, the frame unread.
    pub fn rate_limited(&self) {
        self.error(
            None,
            "RATE_LIMITED",
            "too many plugin socket messages; slow down",
        );
    }

    async fn subscribe(&mut self, envelope: &WsEnvelope) {
        let topic_name = envelope.payload.get("topic").and_then(Value::as_str);
        let Some(topic) = topic_name.and_then(Topic::parse) else {
            let message = format!("unknown topic {}", topic_name.unwrap_or("(missing)"));
            self.error(Some(&envelope.id), "PLUGIN_TOPIC_UNKNOWN", &message);
            return;
        };
        if !self.grant.has_scope(topic.scope()) {
            let message = format!("`{}` requires {}", topic.name(), topic.scope().as_str());
            self.error(Some(&envelope.id), "PLUGIN_SCOPE_DENIED", &message);
            return;
        }
        let count: usize = self
            .sources
            .values()
            .map(|source| lock(&source.members).len())
            .sum();
        if count >= MAX_SUBSCRIPTIONS {
            let message = format!("at most {MAX_SUBSCRIPTIONS} subscriptions per socket");
            self.error(Some(&envelope.id), "PLUGIN_SUBSCRIPTION_LIMIT", &message);
            return;
        }
        self.next_id += 1;
        let subscription_id = format!("s{}", self.next_id);
        if let Some(source) = self.sources.get(&topic) {
            // The running source emits under this lock: queue the reply and the
            // owed resync before the new member becomes visible, so none of its
            // events can precede them.
            let mut members = lock(&source.members);
            self.subscribed(&envelope.id, &subscription_id);
            self.out.owe(&subscription_id, topic.name());
            members.push(Member::new(subscription_id.clone()));
            return;
        }
        let members: Members = Arc::new(Mutex::new(vec![Member::new(subscription_id.clone())]));
        let emitter = Emitter::new(self.out.clone(), topic.name(), members.clone());
        match topics::start(topic, &self.state, &self.grant, emitter).await {
            Ok(started) => {
                self.subscribed(&envelope.id, &subscription_id);
                let source = Source {
                    task: tokio::spawn(started.run),
                    cleanup: started.cleanup,
                    members,
                };
                self.sources.insert(topic, source);
            }
            Err((code, message)) => self.error(Some(&envelope.id), code, &message),
        }
    }

    async fn unsubscribe(&mut self, envelope: &WsEnvelope) {
        let id = envelope
            .payload
            .get("subscription_id")
            .and_then(Value::as_str)
            .unwrap_or_default();
        let Some(topic) = self.sources.iter().find_map(|(topic, source)| {
            let mut members = lock(&source.members);
            let before = members.len();
            members.retain(|member| member.id != id);
            (members.len() < before).then_some(*topic)
        }) else {
            let message = format!("no subscription `{id}`");
            self.error(Some(&envelope.id), "PLUGIN_SUBSCRIPTION_UNKNOWN", &message);
            return;
        };
        self.out.forgive(id);
        let empty = self
            .sources
            .get(&topic)
            .is_some_and(|source| lock(&source.members).is_empty());
        if let Some(source) = empty.then(|| self.sources.remove(&topic)).flatten() {
            source.stop(&self.state).await;
        }
        self.out.control(WsEnvelope::reply(
            &envelope.id,
            "plugin",
            "unsubscribed",
            json!({ "subscription_id": id }),
        ));
    }

    /// Stop every source (socket closing).
    pub async fn close_all(&mut self) {
        for (_, source) in self.sources.drain() {
            source.stop(&self.state).await;
        }
    }

    fn subscribed(&self, ref_id: &str, subscription_id: &str) {
        self.out.control(WsEnvelope::reply(
            ref_id,
            "plugin",
            "subscribed",
            json!({ "subscription_id": subscription_id }),
        ));
    }

    fn error(&self, ref_id: Option<&str>, code: &str, message: &str) {
        let payload = json!({ "code": code, "message": message });
        let envelope = match ref_id {
            Some(ref_id) => WsEnvelope::reply(ref_id, "plugin", "error", payload),
            None => WsEnvelope::new("plugin", "error", payload),
        };
        self.out.control(envelope);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::domain::feature_events::FeatureEventAction;
    use crate::domain::plugin_tabs::grants::{GrantRequest, GrantStore};
    use crate::domain::plugin_tabs::policy::Scope;
    use crate::domain::plugin_tabs::socket::outbound;
    use crate::domain::plugin_tabs::test_support::{insert_project, pool};
    use std::time::Duration;

    struct Harness {
        state: AppState,
        subs: Subscriptions,
        rx: mpsc::Receiver<Message>,
        project: i64,
        feature: i64,
    }

    async fn harness(scopes: Vec<Scope>) -> Harness {
        let pool = pool().await;
        let project = insert_project(&pool, "p").await;
        let feature: i64 = sqlx::query_scalar(
            "INSERT INTO features (project_id, title) VALUES (?, 'f') RETURNING id",
        )
        .bind(project)
        .fetch_one(&pool)
        .await
        .unwrap();
        let state = AppState::with_pool(pool);
        let grant = GrantStore::default()
            .mint(
                GrantRequest::builder()
                    .plugin_id("graph".into())
                    .project_id(project)
                    .feature_id(feature)
                    .scopes(scopes)
                    .permissions_hash("h".into())
                    .build(),
            )
            .grant;
        let (out, rx) = outbound::channel(64);
        Harness {
            subs: Subscriptions::new(state.clone(), grant, out),
            state,
            rx,
            project,
            feature,
        }
    }

    async fn next(rx: &mut mpsc::Receiver<Message>) -> WsEnvelope {
        let message = tokio::time::timeout(Duration::from_secs(2), rx.recv())
            .await
            .expect("a message")
            .expect("open");
        match message {
            Message::Text(text) => WsEnvelope::try_from(text.to_string()).unwrap(),
            other => panic!("unexpected {other:?}"),
        }
    }

    fn request(action: &str, payload: Value) -> String {
        String::from(WsEnvelope::new("plugin", action, payload))
    }

    fn text(envelope: WsEnvelope) -> Message {
        Message::Text(String::from(envelope).into())
    }

    async fn subscribe(h: &mut Harness, topic: &str) -> String {
        h.subs
            .handle(&request("subscribe", json!({ "topic": topic })))
            .await;
        let reply = next(&mut h.rx).await;
        assert_eq!(reply.action, "subscribed", "{:?}", reply.payload);
        reply.payload["subscription_id"]
            .as_str()
            .unwrap()
            .to_string()
    }

    #[tokio::test]
    async fn refuses_other_domains_unknown_topics_and_missing_scopes() {
        let mut h = harness(vec![Scope::GitRead]).await;
        h.subs
            .handle(&String::from(WsEnvelope::new(
                "session",
                "prompt.send",
                json!({}),
            )))
            .await;
        assert_eq!(
            next(&mut h.rx).await.payload["code"],
            "PLUGIN_DOMAIN_DENIED"
        );
        h.subs
            .handle(&request("subscribe", json!({"topic": "nope"})))
            .await;
        assert_eq!(
            next(&mut h.rx).await.payload["code"],
            "PLUGIN_TOPIC_UNKNOWN"
        );
        h.subs
            .handle(&request("subscribe", json!({"topic": "session.stream"})))
            .await;
        assert_eq!(next(&mut h.rx).await.payload["code"], "PLUGIN_SCOPE_DENIED");
        h.subs.handle("not json").await;
        assert_eq!(next(&mut h.rx).await.payload["code"], "PARSE_ERROR");
    }

    #[tokio::test]
    async fn session_stream_observes_read_only_events_and_detaches_on_unsubscribe() {
        let mut h = harness(vec![Scope::AgentObserve]).await;
        let id = subscribe(&mut h, "session.stream").await;
        let registry = &h.state.ws_feature_senders;
        assert!(
            registry.get_senders(h.feature).await.is_empty(),
            "not a viewer"
        );
        let (driver, _driver_rx) = mpsc::unbounded_channel();
        registry.register(h.feature, driver.clone()).await;
        for envelope in [
            WsEnvelope::reply("x", "session", "model.set.ok", json!({})),
            WsEnvelope::new("session", "message", json!({"n": 1})),
            WsEnvelope::new("session", "draft.saved", json!({})),
            WsEnvelope::new("session", "message", json!({"n": 2})),
        ] {
            registry
                .send_and_mirror(h.feature, &driver, text(envelope))
                .await;
        }
        for seq in [1, 2] {
            let event = next(&mut h.rx).await;
            assert_eq!(
                (event.domain.as_str(), event.action.as_str()),
                ("plugin", "event")
            );
            assert_eq!(event.payload["seq"], seq);
            assert_eq!(event.payload["subscription_id"], id.as_str());
            assert_eq!(event.payload["topic"], "session.stream");
            assert_eq!(event.payload["envelope"]["action"], "message");
            assert_eq!(event.payload["envelope"]["payload"]["n"], seq);
        }
        h.subs
            .handle(&request("unsubscribe", json!({"subscription_id": id})))
            .await;
        assert_eq!(next(&mut h.rx).await.action, "unsubscribed");
        registry
            .send_and_mirror(
                h.feature,
                &driver,
                text(WsEnvelope::new("session", "message", json!({}))),
            )
            .await;
        assert!(h.rx.try_recv().is_err(), "detached");
    }

    #[tokio::test]
    async fn repeated_subscriptions_share_one_source_until_the_last_leaves() {
        let mut h = harness(vec![Scope::AgentObserve, Scope::FeaturesRead]).await;
        let first = subscribe(&mut h, "session.stream").await;
        let second = subscribe(&mut h, "session.stream").await;
        assert_ne!(first, second);
        assert_eq!(h.subs.sources.len(), 1);
        let registry = h.state.ws_feature_senders.clone();
        registry.notify_observers(
            h.feature,
            &text(WsEnvelope::new("session", "message", json!({}))),
        );
        let event = next(&mut h.rx).await;
        assert_eq!(event.payload["subscription_id"], first.as_str());
        // The joiner missed the snapshot: it is resynced ahead of its first event.
        let resync = next(&mut h.rx).await;
        assert_eq!(
            (
                resync.action.as_str(),
                resync.payload["subscription_id"].as_str()
            ),
            ("resync", Some(second.as_str()))
        );
        let event = next(&mut h.rx).await;
        assert_eq!(
            (
                event.payload["subscription_id"].as_str(),
                event.payload["seq"].as_u64()
            ),
            (Some(second.as_str()), Some(1))
        );
        h.subs
            .handle(&request("unsubscribe", json!({"subscription_id": first})))
            .await;
        assert_eq!(next(&mut h.rx).await.action, "unsubscribed");
        assert_eq!(h.subs.sources.len(), 1, "one member left");
        subscribe(&mut h, "feature.events").await;
        let events = &h.state.feature_events_tx;
        events.emit(99, Some(h.project + 1), FeatureEventAction::Created);
        events.emit(h.feature, Some(h.project), FeatureEventAction::Updated);
        let event = next(&mut h.rx).await;
        assert_eq!(event.payload["topic"], "feature.events");
        assert_eq!(
            event.payload["envelope"]["payload"]["feature_id"],
            h.feature
        );
        h.subs.close_all().await;
        assert!(h.subs.sources.is_empty());
        registry.notify_observers(
            h.feature,
            &text(WsEnvelope::new("session", "message", json!({}))),
        );
        assert!(h.rx.try_recv().is_err(), "every source detached");
    }
}
