use std::collections::VecDeque;

use super::request_id;
use crate::domain::agents::adapter::{RuntimeError, RuntimeEvent};

/// The shared question UI displays one form at a time, while Codex can ask
/// several questions without waiting. Keep later forms until the first is answered.
#[derive(Default)]
pub(crate) struct PendingAsyncQuestions {
    events: VecDeque<RuntimeEvent>,
}

impl PendingAsyncQuestions {
    pub(crate) fn enqueue(&mut self, event: &RuntimeEvent) -> bool {
        if self
            .events
            .iter()
            .any(|pending| request_id(pending) == request_id(event))
        {
            return false;
        }
        self.events.push_back(event.clone());
        self.events.len() == 1
    }

    pub(crate) fn current(&self, id: &str) -> Result<RuntimeEvent, RuntimeError> {
        self.events
            .front()
            .filter(|event| request_id(event) == Some(id))
            .cloned()
            .ok_or_else(|| RuntimeError::new(format!("Unknown or queued Codex question: {id}")))
    }

    pub(crate) fn complete(&mut self, id: &str) -> Result<Option<RuntimeEvent>, RuntimeError> {
        self.current(id)?;
        Ok(self.discard(id))
    }

    pub(crate) fn contains(&self, id: &str) -> bool {
        self.events
            .iter()
            .any(|event| request_id(event) == Some(id))
    }

    /// Drop a question the user dismissed. Returns the next form to show when
    /// the dismissed one was the form on screen.
    pub(crate) fn discard(&mut self, id: &str) -> Option<RuntimeEvent> {
        let position = self
            .events
            .iter()
            .position(|event| request_id(event) == Some(id))?;
        self.events.remove(position);
        (position == 0)
            .then(|| self.events.front().cloned())
            .flatten()
    }

    pub(crate) fn clear(&mut self) {
        self.events.clear();
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::domain::agents::codex::{async_questions::question_events, event_state::IndexState};
    use serde_json::json;

    fn question(id: &str, thread: &str) -> RuntimeEvent {
        question_events(
            &json!({"threadId":thread,"item":{"id":id,"questions":[{"title":id}]}}),
            true,
            &mut IndexState::default(),
        )
        .pop()
        .unwrap()
    }

    #[test]
    fn overlapping_forms_are_delivered_once_in_order_with_original_thread() {
        let mut queue = PendingAsyncQuestions::default();
        let first = question("first", "root");
        let second = question("second", "child");
        assert!(queue.enqueue(&first));
        assert!(!queue.enqueue(&second));
        assert!(!queue.enqueue(&first));
        assert!(queue.current("codex_async_question_second").is_err());
        let next = queue
            .complete("codex_async_question_first")
            .unwrap()
            .unwrap();
        assert_eq!(request_id(&next), Some("codex_async_question_second"));
        assert_eq!(next.session_id(), Some("child"));
        assert!(queue.complete("codex_async_question_first").is_err());
        assert!(queue
            .complete("codex_async_question_second")
            .unwrap()
            .is_none());
    }

    #[test]
    fn discarding_the_shown_form_surfaces_the_next_and_a_queued_one_stays_hidden() {
        let mut queue = PendingAsyncQuestions::default();
        queue.enqueue(&question("first", "root"));
        queue.enqueue(&question("second", "root"));
        queue.enqueue(&question("third", "root"));
        assert!(queue.discard("codex_async_question_third").is_none());
        assert!(!queue.contains("codex_async_question_third"));
        let next = queue.discard("codex_async_question_first").unwrap();
        assert_eq!(request_id(&next), Some("codex_async_question_second"));
        assert!(queue.discard("codex_async_question_unknown").is_none());
        assert!(queue.contains("codex_async_question_second"));
    }

    #[test]
    fn failed_delivery_keeps_question_available_until_success_or_interrupt() {
        let mut queue = PendingAsyncQuestions::default();
        queue.enqueue(&question("first", "root"));
        // Reading for a failed send must not consume the request.
        assert!(queue.current("codex_async_question_first").is_ok());
        assert!(queue.current("codex_async_question_first").is_ok());
        queue.clear();
        assert!(queue.current("codex_async_question_first").is_err());
    }
}
