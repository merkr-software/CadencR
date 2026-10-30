//! Optional transport recipient for application work that can run headlessly.
use axum::extract::ws::Message;
use tokio::sync::mpsc::{error::SendError, UnboundedSender};

pub(crate) trait OutputTarget: Send + Sync {
    fn recipient(&self) -> Option<&UnboundedSender<Message>>;

    fn send(&self, message: Message) -> Result<(), SendError<Message>> {
        match self.recipient() {
            Some(sender) => sender.send(message),
            None => Ok(()),
        }
    }

    fn report_error(&self, code: &'static str, message: &str, correlation_id: &str) {
        use crate::domain::ws_session::protocol::{
            SessionErrorPayload, WsEnvelope, WsSessionEvent,
        };
        let envelope = WsEnvelope::session_reply(
            correlation_id,
            &WsSessionEvent::Error(SessionErrorPayload {
                code: code.into(),
                message: message.into(),
                ..Default::default()
            }),
        )
        .expect("command error should serialize");
        let _ = self.send(Message::Text(String::from(envelope).into()));
    }
    fn report_warning(&self, code: &'static str, message: &str, correlation_id: &str) {
        use crate::domain::ws_session::protocol::{
            SessionWarningPayload, WsEnvelope, WsSessionEvent,
        };
        let envelope = WsEnvelope::session_reply(
            correlation_id,
            &WsSessionEvent::Warning(SessionWarningPayload {
                code: code.into(),
                message: message.into(),
            }),
        )
        .expect("command warning should serialize");
        let _ = self.send(Message::Text(String::from(envelope).into()));
    }
}

impl OutputTarget for UnboundedSender<Message> {
    fn recipient(&self) -> Option<&UnboundedSender<Message>> {
        Some(self)
    }
}

#[derive(Clone, Default)]
pub(crate) struct SessionOutput {
    recipient: Option<UnboundedSender<Message>>,
    warnings: std::sync::Arc<std::sync::Mutex<Vec<CommandError>>>,
}

impl SessionOutput {
    pub(crate) fn headless() -> Self {
        Self::default()
    }

    pub(crate) fn take_warnings(&self) -> Vec<CommandError> {
        std::mem::take(
            &mut *self
                .warnings
                .lock()
                .unwrap_or_else(|error| error.into_inner()),
        )
    }
}

impl From<UnboundedSender<Message>> for SessionOutput {
    fn from(sender: UnboundedSender<Message>) -> Self {
        Self {
            recipient: Some(sender),
            ..Default::default()
        }
    }
}

impl OutputTarget for SessionOutput {
    fn recipient(&self) -> Option<&UnboundedSender<Message>> {
        self.recipient.as_ref()
    }

    fn report_error(&self, code: &'static str, message: &str, correlation_id: &str) {
        if let Some(recipient) = &self.recipient {
            recipient.report_error(code, message, correlation_id);
        } else {
            self.warnings
                .lock()
                .unwrap_or_else(|error| error.into_inner())
                .push(CommandError::new(code, message));
        }
    }
    fn report_warning(&self, code: &'static str, message: &str, correlation_id: &str) {
        if let Some(recipient) = &self.recipient {
            recipient.report_warning(code, message, correlation_id);
        } else {
            self.warnings
                .lock()
                .unwrap_or_else(|error| error.into_inner())
                .push(CommandError::new(code, message));
        }
    }
}

/// A command can notify its transport when the provider has accepted it,
/// before subsequent persistence warnings are collected.
pub(crate) struct CommandOutput {
    pub(crate) recipient: SessionOutput,
    pub(crate) correlation_id: String,
}

impl CommandOutput {
    pub(crate) fn permission_accepted(&self) {
        let Some(recipient) = self.recipient.recipient() else {
            return;
        };
        use crate::domain::ws_session::protocol::{
            SessionAcknowledgedPayload, WsEnvelope, WsSessionEvent,
        };
        let envelope = WsEnvelope::session_reply(
            &self.correlation_id,
            &WsSessionEvent::Acknowledged(SessionAcknowledgedPayload {
                action: "permission.respond".into(),
            }),
        )
        .expect("permission acknowledgement should serialize");
        let _ = recipient.send(Message::Text(String::from(envelope).into()));
    }
}

#[derive(Debug)]
pub(crate) struct CommandError {
    pub(crate) code: &'static str,
    pub(crate) message: String,
}

impl CommandError {
    pub(crate) fn new(code: &'static str, message: impl ToString) -> Self {
        Self {
            code,
            message: message.to_string(),
        }
    }
}

impl std::fmt::Display for CommandError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}", self.message)
    }
}
