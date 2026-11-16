use std::sync::Mutex;

use serde_json::Value;

use super::CodexSession;
use crate::domain::agents::adapter::RuntimeError;

#[derive(Default)]
pub(crate) struct CompactionState(Mutex<State>);

#[derive(Default)]
struct State {
    manual: bool,
    turn: Option<String>,
}

impl CompactionState {
    pub(crate) fn is_active(&self) -> bool {
        let state = self.0.lock().expect("compaction state poisoned");
        state.manual || state.turn.is_some()
    }

    fn begin(&self) -> Result<(), RuntimeError> {
        let mut state = self.0.lock().expect("compaction state poisoned");
        if state.manual || state.turn.is_some() {
            return Err(RuntimeError::new("Compaction is already in progress"));
        }
        state.manual = true;
        Ok(())
    }

    pub(crate) fn observe(&self, method: &str, params: &Value) {
        if method != "turn/completed"
            && (!matches!(method, "item/started" | "item/completed")
                || params["item"]["type"] != "contextCompaction")
        {
            return;
        }
        let mut state = self.0.lock().expect("compaction state poisoned");
        if method == "item/started" && params["item"]["type"] == "contextCompaction" {
            state.turn = params["turnId"].as_str().map(str::to_owned);
        }
        // Manual compaction owns a whole turn. Its item completion is not a
        // permission to start a new turn: wait for turn/completed as well.
        if method == "item/completed"
            && params["item"]["type"] == "contextCompaction"
            && !state.manual
            && params["turnId"].as_str() == state.turn.as_deref()
        {
            state.turn = None;
        }
        if method == "turn/completed"
            && (state.turn.is_none() || params["turn"]["id"].as_str() == state.turn.as_deref())
        {
            *state = State::default();
        }
    }
}

impl CodexSession {
    pub(super) async fn start_compaction(&self) -> Result<(), RuntimeError> {
        self.compaction.begin()?;
        if let Err(error) = self.client.thread_compact_start(&self.thread_id).await {
            *self.compaction.0.lock().expect("compaction state poisoned") = State::default();
            return Err(error.into());
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn manual_compaction_holds_input_until_its_turn_completes() {
        let state = CompactionState::default();
        state.begin().unwrap();
        assert!(state.is_active());
        assert!(state.begin().is_err());
        let item = json!({"turnId":"compact", "item":{"type":"contextCompaction"}});
        state.observe("item/started", &item);
        state.observe("item/completed", &item);
        assert!(state.is_active());
        state.observe("turn/completed", &json!({"turn":{"id":"old"}}));
        assert!(state.is_active());
        state.observe("turn/completed", &json!({"turn":{"id":"compact"}}));
        assert!(!state.is_active());
    }

    #[test]
    fn auto_compaction_releases_steering_when_the_item_finishes() {
        let state = CompactionState::default();
        let item = json!({"turnId":"normal", "item":{"type":"contextCompaction"}});
        state.observe("item/started", &item);
        assert!(state.is_active());
        state.observe("item/completed", &item);
        assert!(!state.is_active());
    }
}
