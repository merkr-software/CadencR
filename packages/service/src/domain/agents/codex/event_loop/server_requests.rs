//! Server → client JSON-RPC requests from the Codex app-server. Only the
//! allow-listed methods in [`CodexServerRequestMethod`] reach the user as a
//! prompt; anything else is answered with JSON-RPC method-not-found so Codex
//! never receives a fabricated approval.

use serde_json::Value;

use super::super::event_json::thread_id;
use super::super::event_system::{permission_request_event, request_key};
use super::super::events::provider_error_event;
use super::super::permissions::PendingCodexRequest;
use super::super::responses::response_value;
use super::super::server_request_method::{CodexServerRequestMethod, JSON_RPC_METHOD_NOT_FOUND};
use super::super::trusted_mcp::trusted_cadencr_browser_permission_response;
use super::EventLoop;

const UNANSWERED_REQUEST_CODE: &str = "CODEX_SERVER_REQUEST_UNANSWERED";

impl EventLoop {
    /// Returns `false` once the runtime consumer is gone.
    pub(super) async fn server_request(&self, id: Value, method: &str, params: Value) -> bool {
        let Some(kind) = CodexServerRequestMethod::parse(method) else {
            return self.reject_unsupported_request(id, method, &params).await;
        };
        if self.auto_allow_trusted(&id, kind, &params).await {
            return true;
        }
        let event = permission_request_event(&id, kind, &params);
        self.pending_requests.lock().await.insert(
            request_key(&id),
            PendingCodexRequest {
                id,
                method: kind,
                params,
            },
        );
        self.tx.send(Ok(event)).await.is_ok()
    }

    async fn auto_allow_trusted(
        &self,
        id: &Value,
        kind: CodexServerRequestMethod,
        params: &Value,
    ) -> bool {
        let Some(response) =
            trusted_cadencr_browser_permission_response(self.browser_trust, id, kind, params)
        else {
            return false;
        };
        let result = response_value(kind, params, &response);
        match self.client.respond_server_request(id.clone(), result).await {
            Ok(()) => true,
            Err(error) => {
                // Falls back to prompting the user, who can still answer it.
                tracing::warn!(
                    %error,
                    "failed to auto-allow trusted Cadencr browser MCP permission"
                );
                false
            }
        }
    }

    async fn reject_unsupported_request(&self, id: Value, method: &str, params: &Value) -> bool {
        tracing::warn!(
            method,
            request_id = %id,
            "rejecting unsupported Codex server request with method-not-found"
        );
        let message = unsupported_request_message(method);
        let Err(error) = self
            .client
            .reject_server_request(id, JSON_RPC_METHOD_NOT_FOUND, &message)
            .await
        else {
            return true;
        };
        tracing::warn!(%error, method, "failed to reject unsupported Codex server request");
        let event = provider_error_event(
            thread_id(params),
            format!("Cadencr could not answer Codex request `{method}`: {error}"),
            UNANSWERED_REQUEST_CODE,
        );
        self.tx.send(Ok(event)).await.is_ok()
    }
}

fn unsupported_request_message(method: &str) -> String {
    format!("Method not found: Cadencr does not handle Codex server request `{method}`")
}

#[cfg(test)]
mod tests {
    use super::unsupported_request_message;

    #[test]
    fn unsupported_request_message_names_the_method() {
        assert_eq!(
            unsupported_request_message("item/tool/call"),
            "Method not found: Cadencr does not handle Codex server request `item/tool/call`"
        );
    }
}
