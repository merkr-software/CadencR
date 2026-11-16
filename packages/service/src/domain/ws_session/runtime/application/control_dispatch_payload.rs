use crate::domain::ws_session::protocol::PromptSendPayload;

pub(in crate::domain::ws_session) fn replay_payload(
    session_id: i64,
    text: &str,
    use_worktree: Option<bool>,
    internal_replay: bool,
    message_uuid: Option<uuid::Uuid>,
) -> PromptSendPayload {
    let track_prompt_receipt = internal_replay && message_uuid.is_some();
    let message_uuid = match message_uuid {
        Some(message_uuid) => Some(message_uuid.to_string()),
        None if internal_replay => None,
        None => Some(uuid::Uuid::new_v4().to_string()),
    };
    PromptSendPayload {
        session_id: session_id.to_string(),
        text: text.to_string(),
        profile: None,
        claude_profile: None,
        images: Vec::new(),
        attachments: Vec::new(),
        use_worktree,
        new_project_branch: None,
        message_uuid,
        track_prompt_receipt,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn replay_preserves_supplied_worktree_intent() {
        let payload = replay_payload(7, "start", Some(true), true, None);

        assert_eq!(payload.use_worktree, Some(true));
        assert_eq!(payload.message_uuid, None);
        assert!(!payload.track_prompt_receipt);
    }

    #[test]
    fn non_replay_requests_user_message_persistence() {
        let payload = replay_payload(7, "scheduled", None, false, None);

        assert!(payload.message_uuid.is_some());
    }

    #[test]
    fn replay_preserves_a_supplied_dispatch_identity() {
        let message_uuid = uuid::Uuid::new_v4();
        let payload = replay_payload(7, "delegated", None, true, Some(message_uuid));

        assert_eq!(payload.message_uuid, Some(message_uuid.to_string()));
        assert!(payload.track_prompt_receipt);
    }
}
