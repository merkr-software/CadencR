use serde_json::{json, Value};
use std::path::Path;

use crate::client::CodexAppServerClient;
use crate::error::SdkError;
use crate::parse::{parse_thread_handle, parse_thread_snapshot};
use crate::types::{ThreadHandle, ThreadSnapshot};

impl CodexAppServerClient {
    pub async fn thread_start(&self, params: Value) -> Result<ThreadHandle, SdkError> {
        let result = self.request("thread/start", params).await?;
        parse_thread_handle(&result)
    }

    pub async fn thread_resume(&self, params: Value) -> Result<ThreadHandle, SdkError> {
        let result = self.request("thread/resume", params).await?;
        parse_thread_handle(&result)
    }

    pub async fn thread_fork(
        &self,
        thread_id: &str,
        cwd: &Path,
    ) -> Result<ThreadSnapshot, SdkError> {
        let params = json!({
            "threadId": thread_id,
            "cwd": cwd.to_string_lossy(),
        });
        let result = self.request("thread/fork", params).await?;
        parse_thread_snapshot(&result)
    }

    pub async fn thread_rollback(&self, thread_id: &str, num_turns: u32) -> Result<(), SdkError> {
        self.request(
            "thread/rollback",
            json!({
                "threadId": thread_id,
                "numTurns": num_turns,
            }),
        )
        .await
        .map(|_| ())
    }

    pub async fn thread_read(
        &self,
        thread_id: &str,
        include_turns: bool,
    ) -> Result<ThreadSnapshot, SdkError> {
        let result = self
            .request(
                "thread/read",
                json!({
                    "threadId": thread_id,
                    "includeTurns": include_turns,
                }),
            )
            .await?;
        parse_thread_snapshot(&result)
    }

    pub async fn thread_unsubscribe(&self, thread_id: &str) -> Result<(), SdkError> {
        self.request("thread/unsubscribe", json!({ "threadId": thread_id }))
            .await
            .map(|_| ())
    }

    pub async fn thread_compact_start(&self, thread_id: &str) -> Result<(), SdkError> {
        self.request("thread/compact/start", json!({ "threadId": thread_id }))
            .await
            .map(|_| ())
    }
}
