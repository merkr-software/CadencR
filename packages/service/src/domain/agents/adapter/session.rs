use std::sync::Arc;

use async_trait::async_trait;
use serde_json::Value;
use tokio::sync::{mpsc, RwLock};

use super::config::{RuntimeAccessMode, RuntimeMcpServerStatus, RuntimePermissionMode};
use super::error::RuntimeError;
use super::event_types::RuntimeEvent;
use super::permission::{
    RuntimePermissionResponse, RuntimePermissionResponseKind, RuntimeToolPermissionRequest,
    RuntimeToolPermissionResult,
};

pub type RuntimeMessageRx = mpsc::Receiver<Result<RuntimeEvent, RuntimeError>>;
pub type RuntimeSessionHandle = Arc<RwLock<Box<dyn AgentRuntimeSession>>>;

#[async_trait]
pub trait RuntimeToolPermissionHandler: Send + Sync {
    async fn can_use_tool(
        &self,
        request: RuntimeToolPermissionRequest,
    ) -> RuntimeToolPermissionResult;
}

#[async_trait]
pub trait AgentRuntimeSession: Send + Sync {
    fn take_message_rx(&mut self) -> RuntimeMessageRx;
    fn context_window(&self) -> Option<u64> {
        None
    }
    fn runtime_control_endpoint(&self) -> Option<String> {
        None
    }
    async fn session_id(&self) -> Option<String>;
    async fn available_mcp_servers(&self) -> Result<Vec<RuntimeMcpServerStatus>, RuntimeError> {
        Ok(Vec::new())
    }
    async fn refresh_mcp_servers(&self) -> Result<Vec<RuntimeMcpServerStatus>, RuntimeError> {
        self.available_mcp_servers().await
    }
    async fn stream_input(&self, content: Value) -> Result<(), RuntimeError>;
    async fn stream_input_with_client_message_id(
        &self,
        content: Value,
        client_message_id: Option<String>,
    ) -> Result<(), RuntimeError> {
        let _ = client_message_id;
        self.stream_input(content).await
    }
    async fn interrupt(&self) -> Result<(), RuntimeError>;
    async fn compact(&self) -> Result<(), RuntimeError> {
        Err(RuntimeError::new(
            "compaction is not supported by this runtime",
        ))
    }
    async fn close(&mut self);
    async fn set_model(&self, model: &str) -> Result<(), RuntimeError>;
    async fn set_permission_mode(&self, mode: RuntimePermissionMode) -> Result<(), RuntimeError>;
    /// Optional provider runtime hook for access/autonomy controls that can be
    /// updated without respawning a session.
    async fn set_access_mode(&self, _mode: RuntimeAccessMode) -> Result<(), RuntimeError> {
        Err(RuntimeError::new(
            "access mode changes are not supported by this runtime",
        ))
    }
    fn applies_thinking_effort_in_place(&self) -> bool {
        false
    }
    async fn set_thinking_effort(&self, _effort: Option<String>) -> Result<(), RuntimeError> {
        Ok(())
    }
    async fn respond_permission(
        &self,
        _response: RuntimePermissionResponse,
    ) -> Result<(), RuntimeError> {
        Err(RuntimeError::new(
            "permission responses are not supported by this runtime",
        ))
    }
    fn permission_response_kind(&self, _request_id: &str) -> RuntimePermissionResponseKind {
        RuntimePermissionResponseKind::Normal
    }
    #[allow(dead_code)]
    fn pid(&self) -> Option<u32>;
}

#[cfg(test)]
pub(crate) mod test_support {
    use async_trait::async_trait;

    use super::super::config::RuntimePermissionMode;
    use super::super::error::RuntimeError;
    use super::{AgentRuntimeSession, RuntimeMessageRx};

    pub(crate) struct DummySession;

    #[async_trait]
    impl AgentRuntimeSession for DummySession {
        fn take_message_rx(&mut self) -> RuntimeMessageRx {
            let (_tx, rx) = tokio::sync::mpsc::channel(1);
            rx
        }

        async fn session_id(&self) -> Option<String> {
            Some("dummy".to_string())
        }

        async fn stream_input(&self, _content: serde_json::Value) -> Result<(), RuntimeError> {
            Ok(())
        }

        async fn interrupt(&self) -> Result<(), RuntimeError> {
            Ok(())
        }

        async fn close(&mut self) {}

        async fn set_model(&self, _model: &str) -> Result<(), RuntimeError> {
            Ok(())
        }

        async fn set_permission_mode(
            &self,
            _mode: RuntimePermissionMode,
        ) -> Result<(), RuntimeError> {
            Ok(())
        }

        async fn set_thinking_effort(&self, _effort: Option<String>) -> Result<(), RuntimeError> {
            Ok(())
        }

        fn pid(&self) -> Option<u32> {
            None
        }
    }
}

#[cfg(test)]
mod tests {
    use std::sync::atomic::{AtomicBool, Ordering};
    use std::sync::Arc;

    use async_trait::async_trait;
    use serde_json::json;
    use tokio::sync::{mpsc, Barrier, Notify, RwLock};

    use super::super::config::RuntimePermissionMode;
    use super::super::error::RuntimeError;
    use super::super::permission::{RuntimePermissionDecision, RuntimePermissionResponse};
    use super::test_support::DummySession;
    use super::{AgentRuntimeSession, RuntimeMessageRx};

    #[tokio::test]
    async fn session_default_permission_response_is_unsupported() {
        let session = DummySession;
        let error = session
            .respond_permission(RuntimePermissionResponse {
                request_id: "req".to_string(),
                decision: RuntimePermissionDecision::AllowOnce,
                option_id: None,
                feedback: None,
                updated_input: None,
            })
            .await
            .expect_err("default session permission response should be unsupported");

        assert!(error
            .to_string()
            .contains("permission responses are not supported"));
    }

    #[tokio::test]
    async fn default_available_mcp_servers_is_empty() {
        let session = DummySession;

        let servers = session.available_mcp_servers().await.unwrap();

        assert!(servers.is_empty());
    }

    struct PermissionWhileStreamingSession {
        stream_entered: Arc<Barrier>,
        release_stream: Arc<Notify>,
        permission_seen: Arc<AtomicBool>,
    }

    #[async_trait]
    impl AgentRuntimeSession for PermissionWhileStreamingSession {
        fn take_message_rx(&mut self) -> RuntimeMessageRx {
            let (_tx, rx) = mpsc::channel(1);
            rx
        }

        async fn session_id(&self) -> Option<String> {
            Some("concurrent".to_string())
        }

        async fn stream_input(&self, _content: serde_json::Value) -> Result<(), RuntimeError> {
            self.stream_entered.wait().await;
            self.release_stream.notified().await;
            Ok(())
        }

        async fn interrupt(&self) -> Result<(), RuntimeError> {
            Ok(())
        }

        async fn close(&mut self) {}

        async fn set_model(&self, _model: &str) -> Result<(), RuntimeError> {
            Ok(())
        }

        async fn set_permission_mode(
            &self,
            _mode: RuntimePermissionMode,
        ) -> Result<(), RuntimeError> {
            Ok(())
        }

        async fn respond_permission(
            &self,
            _response: RuntimePermissionResponse,
        ) -> Result<(), RuntimeError> {
            self.permission_seen.store(true, Ordering::SeqCst);
            Ok(())
        }

        fn pid(&self) -> Option<u32> {
            None
        }
    }

    #[tokio::test]
    async fn permission_response_can_run_while_prompt_stream_is_in_flight() {
        let stream_entered = Arc::new(Barrier::new(2));
        let release_stream = Arc::new(Notify::new());
        let permission_seen = Arc::new(AtomicBool::new(false));
        let query = Arc::new(RwLock::new(Box::new(PermissionWhileStreamingSession {
            stream_entered: Arc::clone(&stream_entered),
            release_stream: Arc::clone(&release_stream),
            permission_seen: Arc::clone(&permission_seen),
        }) as Box<dyn AgentRuntimeSession>));

        let stream_query = Arc::clone(&query);
        let stream_task = tokio::spawn(async move {
            let q = stream_query.read().await;
            q.stream_input(json!("prompt")).await
        });
        stream_entered.wait().await;

        let response = RuntimePermissionResponse {
            request_id: "req-second".to_string(),
            decision: RuntimePermissionDecision::AllowOnce,
            option_id: None,
            feedback: None,
            updated_input: None,
        };
        tokio::time::timeout(std::time::Duration::from_millis(100), async {
            let q = query.read().await;
            q.respond_permission(response).await
        })
        .await
        .expect("permission response should not wait for the prompt turn")
        .unwrap();
        assert!(permission_seen.load(Ordering::SeqCst));

        release_stream.notify_waiters();
        stream_task.await.unwrap().unwrap();
    }
}
