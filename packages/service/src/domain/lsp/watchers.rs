//! Session-owned dynamic file watches; requests never rely on renderer capability stubs.
use std::collections::{HashMap, HashSet};
use std::path::PathBuf;
use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc, Mutex, PoisonError, RwLock,
};

use notify_debouncer_mini::notify::{self, RecommendedWatcher};
use serde_json::{json, Value};
use tokio::sync::mpsc;

pub(super) mod bridge;
mod events;
mod registration;
use registration::{Rule, METHOD};
mod state;
use state::validate;

const MAX_REGISTRATIONS: usize = 128;
const MAX_PENDING: usize = 32;

#[derive(Clone)]
enum Change {
    Add(Vec<(String, Vec<Rule>)>),
    Remove(Vec<String>),
}
struct Inner {
    roots: Vec<PathBuf>,
    active: HashMap<String, Vec<Rule>>,
    pending: HashMap<String, Change>,
    watcher: Option<RecommendedWatcher>,
    tx: mpsc::Sender<notify::Result<notify::Event>>,
    overflow: Arc<AtomicBool>,
    filter: Arc<RwLock<Vec<Rule>>>,
}
#[derive(Clone)]
pub(super) struct SessionWatchers(Arc<Mutex<Inner>>);
type FileEvents = mpsc::Receiver<notify::Result<notify::Event>>;

pub(super) struct ServerFrame {
    pub forward: Option<String>,
    pub response: Option<Value>,
    pub error: Option<String>,
}
impl SessionWatchers {
    pub fn new(roots: Vec<PathBuf>) -> Result<(Self, FileEvents), String> {
        if roots.is_empty() || roots.len() > 2 {
            return Err("Invalid LSP watcher roots".into());
        }
        let (tx, rx) = mpsc::channel(128);
        let roots = roots
            .into_iter()
            .map(|path| {
                path.canonicalize()
                    .map_err(|error| format!("LSP watcher root is unavailable: {error}"))
            })
            .collect::<Result<Vec<_>, _>>()?;
        Ok((
            Self(Arc::new(Mutex::new(Inner {
                roots,
                active: HashMap::new(),
                pending: HashMap::new(),
                watcher: None,
                tx,
                overflow: Arc::new(AtomicBool::new(false)),
                filter: Arc::new(RwLock::new(Vec::new())),
            }))),
            rx,
        ))
    }

    pub fn server_frame(&self, text: &str) -> ServerFrame {
        let unchanged = || ServerFrame {
            forward: Some(text.into()),
            response: None,
            error: None,
        };
        if !text.contains("client/registerCapability")
            && !text.contains("client/unregisterCapability")
        {
            return unchanged();
        }
        let Ok(mut message) = serde_json::from_str::<Value>(text) else {
            return unchanged();
        };
        let method = message["method"].as_str().unwrap_or_default();
        let key = match method {
            "client/registerCapability" => "registrations",
            "client/unregisterCapability" => "unregisterations",
            _ => return unchanged(),
        };
        let Some(id) = message.get("id").cloned() else {
            return unchanged();
        };
        let Some(entries) = message["params"][key].as_array() else {
            return unchanged();
        };
        let (owned, others): (Vec<_>, Vec<_>) = entries
            .iter()
            .cloned()
            .partition(|entry| entry["method"] == METHOD);
        if owned.is_empty() {
            return unchanged();
        }
        let result = self.prepare(&owned, key == "registrations", &id, !others.is_empty());
        if let Err(error) = result {
            return ServerFrame {
                forward: None,
                response: Some(failure(id, &error)),
                error: Some(error),
            };
        }
        if others.is_empty() {
            ServerFrame {
                forward: None,
                response: Some(json!({"jsonrpc":"2.0","id":id,"result":null})),
                error: None,
            }
        } else {
            message["params"][key] = Value::Array(others);
            ServerFrame {
                forward: Some(message.to_string()),
                response: None,
                error: None,
            }
        }
    }

    fn prepare(
        &self,
        entries: &[Value],
        add: bool,
        id: &Value,
        pending: bool,
    ) -> Result<(), String> {
        let mut state = self.0.lock().unwrap_or_else(PoisonError::into_inner);
        if state.roots.is_empty() {
            return Err("LSP workspace is unavailable for file watching".into());
        }
        if entries.len() > MAX_REGISTRATIONS || state.pending.len() >= MAX_PENDING {
            return Err("Language-server file watcher registration limit reached".into());
        }
        let mut ids = HashSet::new();
        let mut additions = Vec::new();
        for entry in entries {
            let id = entry["id"]
                .as_str()
                .filter(|id| !id.is_empty() && id.len() <= 512)
                .ok_or("Invalid language-server file watcher registration ID")?
                .to_string();
            if !ids.insert(id.clone()) {
                return Err("Duplicate file watcher registration ID".into());
            }
            if add {
                let rules = registration::compile(entry["registerOptions"].clone(), &state.roots)?;
                additions.push((id, rules));
            }
        }
        let change = if add {
            Change::Add(additions)
        } else {
            Change::Remove(ids.into_iter().collect())
        };
        validate(&state.active, &change)?;
        state.ensure_watcher()?;
        if pending {
            let key = id.to_string();
            if state.pending.contains_key(&key) {
                return Err("Duplicate pending capability request ID".into());
            }
            state.pending.insert(key, change);
        } else {
            state.commit(change)?;
        }
        Ok(())
    }

    /// Mixed capability requests commit only after the renderer accepts its portion.
    pub fn client_frame(&self, text: &str) -> String {
        if self
            .0
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .pending
            .is_empty()
        {
            return text.into();
        }
        let Ok(mut value) = serde_json::from_str::<Value>(text) else {
            return text.into();
        };
        if value.get("method").is_some() {
            return text.into();
        }
        let Some(id) = value.get("id") else {
            return text.into();
        };
        let mut state = self.0.lock().unwrap_or_else(PoisonError::into_inner);
        if let Some(change) = state.pending.remove(&id.to_string()) {
            if value.get("error").is_none() {
                if let Err(error) = state.commit(change) {
                    value = failure(id.clone(), &error);
                }
            }
            state.release_unused();
        }
        value.to_string()
    }

    pub fn event(&self, event: notify::Event) -> Result<Option<Value>, String> {
        if event.need_rescan() {
            return Err(
                "Language-server file watcher requires a rescan; reconnect the language server"
                    .into(),
            );
        }
        if event.paths.len() > 256 {
            return Err("Language-server file event exceeded path budget".into());
        }
        let state = self.0.lock().unwrap_or_else(PoisonError::into_inner);
        let mut seen = HashSet::new();
        let matched: Vec<_> = events::changes(event)
            .into_iter()
            .filter(|(path, kind)| {
                state.roots.iter().any(|root| path.starts_with(root))
                    && state
                        .active
                        .values()
                        .flatten()
                        .any(|rule| rule.matches(path, *kind))
                    && seen.insert((path.clone(), *kind))
            })
            .take(256)
            .collect();
        Ok((!matched.is_empty()).then(|| events::notification(matched)))
    }

    pub fn overflowed(&self) -> bool {
        self.0
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .overflow
            .swap(false, Ordering::Relaxed)
    }
}
fn failure(id: Value, message: &str) -> Value {
    json!({"jsonrpc":"2.0","id":id,"error":{"code":-32602,"message":message}})
}

#[cfg(test)]
mod tests {
    use super::*;
    fn registration(root: &std::path::Path) -> Value {
        json!({"id":"watch","method":METHOD,"registerOptions":{"watchers":[{
            "globPattern":format!("{}/**/*.ts",root.display()),"kind":7}]}})
    }
    #[tokio::test]
    async fn actual_create_modify_delete_and_unregistration_follow_session_lifetime() {
        let temp = tempfile::tempdir().unwrap();
        let (watchers, mut rx) = SessionWatchers::new(vec![temp.path().to_path_buf()]).unwrap();
        let frame = json!({"jsonrpc":"2.0","id":1,"method":"client/registerCapability",
            "params":{"registrations":[registration(temp.path())]}})
        .to_string();
        assert_eq!(
            watchers.server_frame(&frame).response.unwrap()["result"],
            Value::Null
        );
        let path = temp.path().join("actual.ts");
        // macOS FSEvents starts its stream asynchronously after watch registration.
        tokio::time::sleep(std::time::Duration::from_millis(150)).await;
        std::fs::write(&path, "first").unwrap();
        wait_for_kind(&watchers, &mut rx, 1).await;
        std::fs::write(&path, "changed").unwrap();
        wait_for_kind(&watchers, &mut rx, 2).await;
        std::fs::remove_file(&path).unwrap();
        wait_for_kind(&watchers, &mut rx, 3).await;
        assert!(watchers
            .server_frame(
                &json!({"id":2,"method":"client/unregisterCapability",
            "params":{"unregisterations":[{"id":"watch","method":METHOD}]}})
                .to_string()
            )
            .error
            .is_none());
        assert!(watchers.0.lock().unwrap().watcher.is_none());
    }
    async fn wait_for_kind(
        watchers: &SessionWatchers,
        rx: &mut mpsc::Receiver<notify::Result<notify::Event>>,
        kind: u8,
    ) {
        tokio::time::timeout(std::time::Duration::from_secs(8), async {
            loop {
                let event = rx.recv().await.unwrap().unwrap();
                if let Some(message) = watchers.event(event).unwrap() {
                    if message["params"]["changes"]
                        .as_array()
                        .unwrap()
                        .iter()
                        .any(|change| change["type"] == kind)
                    {
                        break;
                    }
                }
            }
        })
        .await
        .unwrap();
    }
    #[test]
    fn mixed_rejection_keeps_previous_state_and_preserves_other_capabilities() {
        let temp = tempfile::tempdir().unwrap();
        let (watchers, _rx) = SessionWatchers::new(vec![temp.path().to_path_buf()]).unwrap();
        let frame =
            json!({"id":"mix","method":"client/registerCapability","params":{"registrations":[
            registration(temp.path()),{"id":"other","method":"textDocument/diagnostic"}]}})
            .to_string();
        let result = watchers.server_frame(&frame);
        let forwarded: Value = serde_json::from_str(&result.forward.unwrap()).unwrap();
        assert_eq!(
            forwarded["params"]["registrations"]
                .as_array()
                .unwrap()
                .len(),
            1
        );
        assert!(watchers.0.lock().unwrap().active.is_empty());
        watchers.client_frame(&json!({"id":"mix","error":{"code":-1}}).to_string());
        assert!(watchers.0.lock().unwrap().active.is_empty());
        assert!(watchers.0.lock().unwrap().watcher.is_none());
    }
}
