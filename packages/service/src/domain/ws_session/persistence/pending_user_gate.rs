/// The DB-backed user-input gate kinds.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum PendingUserInputKind {
    Permission,
    Question,
}

impl PendingUserInputKind {
    fn column(self) -> &'static str {
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

    fn serialize(&self) -> Result<String, serde_json::Error> {
        match self {
            Self::Permission(payload) => serde_json::to_string(payload),
            Self::Question(payload) => serde_json::to_string(payload),
        }
    }
}

impl WsSessionPersistence {
    /// Persist and broadcast a gate, then asynchronously notify a linked parent.
    pub async fn mark_awaiting_user_static(
        state: &crate::app_state::AppState,
        session_id: i64,
        feature_id: i64,
        input: &PendingUserInput<'_>,
    ) {
        let kind = input.kind().as_session_kind();
        Self::set_pending_user_input_static(&state.write_pool, session_id, input).await;
        let registered = register_gate(state, session_id, input).await;
        Self::broadcast_session_status(
            &state.session_status_tx,
            session_id,
            feature_id,
            crate::domain::session_status::AgentStatus::Question,
            Some(kind),
        );
        if let Some(payload) = registered {
            crate::domain::mcp::control::gate_notify::spawn_gate_notification(
                state.clone(),
                session_id,
                payload,
            );
        }
    }

    /// Clear the gate before broadcasting the next status.
    pub async fn mark_agent_resumed_static(
        pool: &SqlitePool,
        broadcaster: &crate::domain::session_status::SessionStatusBroadcaster,
        session_id: i64,
        feature_id: i64,
        kind: PendingUserInputKind,
        next_status: crate::domain::session_status::AgentStatus,
    ) {
        debug_assert!(matches!(next_status,
            crate::domain::session_status::AgentStatus::Agent
                | crate::domain::session_status::AgentStatus::Idle));
        Self::clear_pending_user_input_static(pool, session_id, kind).await;
        Self::broadcast_session_status(broadcaster, session_id, feature_id, next_status, None);
    }
}

fn gate_payload(input: &PendingUserInput<'_>) -> Result<serde_json::Value, serde_json::Error> {
    match input {
        PendingUserInput::Permission(payload) => serde_json::to_value(payload),
        PendingUserInput::Question(payload) => Ok((*payload).clone()),
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
    Some(crate::domain::ws_session::protocol::PermissionRequestPayload {
        request_id: raw.get("request_id").and_then(serde_json::Value::as_str)?.to_string(),
        tool_name: raw
            .get("tool_name")
            .and_then(serde_json::Value::as_str)
            .unwrap_or("AskUserQuestion")
            .to_string(),
        tool_input: raw.get("tool_input").cloned().unwrap_or(serde_json::Value::Null),
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
    })
}

async fn register_gate(
    state: &crate::app_state::AppState,
    session_id: i64,
    input: &PendingUserInput<'_>,
 ) -> Option<serde_json::Value> {
    let payload = match gate_payload(input) {
        Ok(payload) => payload,
        Err(error) => {
            error!(session_id, %error, "failed to serialize pending gate for escalation");
            return None;
        }
    };
    let Some(request_id) = payload.get("request_id").and_then(serde_json::Value::as_str) else {
        error!(session_id, "pending gate payload has no request_id; escalation unavailable");
        return None;
    };
    state
        .pending_gates
        .register(
            session_id,
            crate::domain::gate_registry::PendingGate {
                request_id: request_id.to_string(),
                kind: crate::domain::gate_registry::GateKind::from_pending(
                    input.kind(),
                    payload
                        .get("tool_name")
                        .and_then(serde_json::Value::as_str)
                        .unwrap_or_default(),
                ),
                payload: payload.clone(),
            },
        )
        .await;
    Some(payload)
}
