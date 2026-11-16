use super::SessionRow;

/// The DB-backed user-input gate kinds.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum PendingUserInputKind {
    Permission,
    Question,
}

impl PendingUserInputKind {
    pub(super) fn column(self) -> &'static str {
        match self {
            Self::Permission => "pending_permission",
            Self::Question => "pending_questions",
        }
    }

    pub fn as_session_kind(self) -> crate::domain::session_status::PendingKind {
        match self {
            Self::Permission => crate::domain::session_status::PendingKind::Permission,
            Self::Question => crate::domain::session_status::PendingKind::Question,
        }
    }
}

#[derive(Debug)]
pub enum PendingUserInput<'a> {
    Permission(&'a crate::domain::ws_session::protocol::PermissionRequestPayload),
    Question(&'a serde_json::Value),
}

impl SessionRow {
    pub fn pending_gate_payload(
        &self,
    ) -> Option<(
        PendingUserInputKind,
        crate::domain::ws_session::protocol::PermissionRequestPayload,
    )> {
        if let Some(payload) = self
            .pending_permission
            .as_deref()
            .and_then(parse_permission_payload)
        {
            return Some((PendingUserInputKind::Permission, payload));
        }
        self.pending_questions
            .as_deref()
            .and_then(parse_question_payload)
            .map(|payload| (PendingUserInputKind::Question, payload))
    }
}

impl<'a> PendingUserInput<'a> {
    pub fn kind(&self) -> PendingUserInputKind {
        match self {
            Self::Permission(_) => PendingUserInputKind::Permission,
            Self::Question(_) => PendingUserInputKind::Question,
        }
    }

    pub(super) fn serialize(&self) -> Result<String, serde_json::Error> {
        match self {
            Self::Permission(payload) => serde_json::to_string(payload),
            Self::Question(payload) => serde_json::to_string(payload),
        }
    }
}

fn parse_permission_payload(
    value: &str,
) -> Option<crate::domain::ws_session::protocol::PermissionRequestPayload> {
    serde_json::from_str(value).ok()
}

fn parse_question_payload(
    value: &str,
) -> Option<crate::domain::ws_session::protocol::PermissionRequestPayload> {
    if let Some(payload) = parse_permission_payload(value) {
        return Some(payload);
    }
    let raw: serde_json::Value = serde_json::from_str(value).ok()?;
    Some(
        crate::domain::ws_session::protocol::PermissionRequestPayload {
            request_id: raw
                .get("request_id")
                .and_then(serde_json::Value::as_str)?
                .to_string(),
            tool_name: raw
                .get("tool_name")
                .and_then(serde_json::Value::as_str)
                .unwrap_or("AskUserQuestion")
                .to_string(),
            tool_input: raw
                .get("tool_input")
                .cloned()
                .unwrap_or(serde_json::Value::Null),
            description: raw
                .get("description")
                .and_then(serde_json::Value::as_str)
                .map(ToOwned::to_owned),
            pattern: raw
                .get("pattern")
                .and_then(serde_json::Value::as_str)
                .map(ToOwned::to_owned),
            preview: raw
                .get("preview")
                .and_then(serde_json::Value::as_str)
                .map(ToOwned::to_owned),
            options: Vec::new(),
        },
    )
}
