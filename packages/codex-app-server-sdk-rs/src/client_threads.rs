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

    /// Replace the thread's history with the turns before `before_turn_id`
    /// (that turn and every later one are dropped). History only: files are
    /// left as they are.
    pub async fn thread_revert(
        &self,
        thread_id: &str,
        before_turn_id: &str,
    ) -> Result<(), SdkError> {
        self.request(
            "thread/revert",
            json!({
                "threadId": thread_id,
                "beforeTurnId": before_turn_id,
            }),
        )
        .await
        .map(|_| ())
    }

    /// Stop a command the thread still runs (Codex keeps a command running
    /// past its turn, as a background terminal), with every process it
    /// started. `process_id` is the command item's `processId`. Returns
    /// whether a running command was stopped.
    pub async fn thread_background_terminal_terminate(
        &self,
        thread_id: &str,
        process_id: &str,
    ) -> Result<bool, SdkError> {
        let result = self
            .request(
                "thread/backgroundTerminals/terminate",
                json!({
                    "threadId": thread_id,
                    "processId": process_id,
                }),
            )
            .await?;
        Ok(result
            .get("terminated")
            .and_then(Value::as_bool)
            .unwrap_or(false))
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

    /// Archive a thread: it leaves the thread list but is not deleted.
    pub async fn thread_archive(&self, thread_id: &str) -> Result<(), SdkError> {
        self.request("thread/archive", json!({ "threadId": thread_id }))
            .await
            .map(|_| ())
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

    /// Run a user-authored shell command through Codex's native user-shell
    /// route. Codex owns execution, transcript events, and context insertion.
    pub async fn thread_shell_command(
        &self,
        thread_id: &str,
        command: &str,
    ) -> Result<(), SdkError> {
        self.request(
            "thread/shellCommand",
            thread_shell_command_params(thread_id, command),
        )
        .await
        .map(|_| ())
    }
}

fn thread_shell_command_params(thread_id: &str, command: &str) -> Value {
    json!({
        "threadId": thread_id,
        "command": command,
    })
}

#[cfg(test)]
mod tests {
    use super::thread_shell_command_params;
    use serde_json::json;

    #[test]
    fn shell_command_uses_v2_schema_fields() {
        assert_eq!(
            thread_shell_command_params("thread-1", "printf hello | cat"),
            json!({
                "threadId": "thread-1",
                "command": "printf hello | cat",
            })
        );
    }
}
