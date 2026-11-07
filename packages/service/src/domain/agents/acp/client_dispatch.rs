//! Inbound dispatch for the official ACP SDK connection: turns agent
//! notifications and server-initiated requests into [`AcpEvent`]s.

use std::collections::HashMap;
use std::sync::{Arc, Mutex as StdMutex};

use agent_client_protocol::{Dispatch, HandleDispatchFrom, Handled, Responder};
use serde_json::Value;

use crate::domain::agents::acp::client::server_request_key;
use crate::domain::agents::acp::event_hub::AcpEventHub;
use crate::domain::agents::acp::incoming::{AcpNotification, AcpServerRequest};
use crate::domain::agents::acp::types::AcpEvent;

pub(super) type ServerResponders = Arc<StdMutex<HashMap<String, Responder<Value>>>>;

#[derive(Clone)]
pub(super) struct EventDispatchHandler {
    events: AcpEventHub,
    server_responders: ServerResponders,
}

impl EventDispatchHandler {
    pub(super) fn new(events: AcpEventHub, server_responders: ServerResponders) -> Self {
        Self {
            events,
            server_responders,
        }
    }

    fn dispatch_request(
        &self,
        request: agent_client_protocol::UntypedMessage,
        responder: Responder<Value>,
    ) -> Result<(), agent_client_protocol::Error> {
        // Runtime events retain JSON IDs, including the distinction between
        // numeric IDs and strings containing the same digits.
        let id = serde_json::to_value(responder.id())
            .map_err(|_| agent_client_protocol::Error::internal_error())?;
        let (method, params) = request.into_parts();
        let key = server_request_key(&id);
        self.server_responders
            .lock()
            .map_err(|_| agent_client_protocol::Error::internal_error())?
            .insert(key.clone(), responder);
        let event = AcpServerRequest::from_parts(id, method, params);
        if self.events.send(AcpEvent::ServerRequest(event)) {
            return Ok(());
        }
        // No reliable subscriber took it (none subscribed, the runtime queue
        // overflowed, or only best-effort observers saw it — they never
        // answer): fail it now rather than leave the agent waiting forever.
        let responder = self
            .server_responders
            .lock()
            .map_err(|_| agent_client_protocol::Error::internal_error())?
            .remove(&key);
        if let Some(responder) = responder {
            responder.respond_with_internal_error("ACP server request had no active receiver")?;
        }
        Ok(())
    }
}

impl HandleDispatchFrom<agent_client_protocol::Agent> for EventDispatchHandler {
    async fn handle_dispatch_from(
        &mut self,
        message: Dispatch,
        _connection: agent_client_protocol::ConnectionTo<agent_client_protocol::Agent>,
    ) -> Result<Handled<Dispatch>, agent_client_protocol::Error> {
        match message {
            Dispatch::Notification(notification) => {
                let (method, params) = notification.into_parts();
                let event = AcpNotification::from_parts(method, params);
                self.events.send(AcpEvent::Notification(event));
                Ok(Handled::Yes)
            }
            Dispatch::Request(request, responder) => {
                self.dispatch_request(request, responder)?;
                Ok(Handled::Yes)
            }
            Dispatch::Response(result, router) => Ok(Handled::No {
                message: Dispatch::Response(result, router),
                retry: false,
            }),
        }
    }

    fn describe_chain(&self) -> impl std::fmt::Debug {
        "CadencrAcpEventDispatchHandler"
    }
}
