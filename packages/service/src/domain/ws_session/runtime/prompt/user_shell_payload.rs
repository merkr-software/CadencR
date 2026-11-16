//! Persisted payload for a Cadencr-managed user shell transcript.

use serde::{Deserialize, Serialize};

const MAX_RETAINED_OUTPUT_BYTES: usize = 64 * 1024;
const MAX_CONTEXT_OUTPUT_BYTES: usize = 12 * 1024;
const OUTPUT_TRUNCATION_MARKER: &str = "[... earlier shell output truncated ...]\n";
const RESTART_INTERRUPTION_MESSAGE: &str = "Shell command interrupted because Cadencr restarted.";

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub(in crate::domain::ws_session) enum ManagedShellStrategy {
    CadencrManaged,
}

impl ManagedShellStrategy {
    pub const fn as_str(self) -> &'static str {
        "cadencr_managed"
    }
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub(in crate::domain::ws_session) enum ShellContextState {
    Pending,
    Claimed,
    Delivered,
}

impl ShellContextState {
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Pending => "pending",
            Self::Claimed => "claimed",
            Self::Delivered => "delivered",
        }
    }
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub(in crate::domain::ws_session) enum ManagedShellStatus {
    Running,
    Completed,
    Failed,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
struct ManagedShellMetadata {
    strategy: ManagedShellStrategy,
    context_state: ShellContextState,
    #[serde(skip_serializing_if = "Option::is_none")]
    delivery_id: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub(in crate::domain::ws_session) struct ManagedShellPayload {
    pub command: String,
    pub cwd: String,
    pub output: String,
    pub status: ManagedShellStatus,
    #[serde(rename = "exitCode", skip_serializing_if = "Option::is_none")]
    pub exit_code: Option<i32>,
    #[serde(rename = "outputTruncated", default, skip_serializing_if = "is_false")]
    pub output_truncated: bool,
    #[serde(rename = "__cadencr_user_shell")]
    metadata: ManagedShellMetadata,
}

impl ManagedShellPayload {
    pub fn running(command: &str, cwd: &str) -> Self {
        Self {
            command: command.to_string(),
            cwd: cwd.to_string(),
            output: String::new(),
            status: ManagedShellStatus::Running,
            exit_code: None,
            output_truncated: false,
            metadata: ManagedShellMetadata {
                strategy: ManagedShellStrategy::CadencrManaged,
                context_state: ShellContextState::Pending,
                delivery_id: None,
            },
        }
    }

    pub fn append_output(&mut self, chunk: &str) {
        if self.output.len() + chunk.len() <= MAX_RETAINED_OUTPUT_BYTES {
            self.output.push_str(chunk);
            return;
        }
        let tail_capacity = MAX_RETAINED_OUTPUT_BYTES - OUTPUT_TRUNCATION_MARKER.len();
        let tail = if chunk.len() >= tail_capacity {
            utf8_suffix(chunk, tail_capacity).to_string()
        } else {
            let previous = utf8_suffix(&self.output, tail_capacity - chunk.len());
            format!("{previous}{chunk}")
        };
        self.output = format!("{OUTPUT_TRUNCATION_MARKER}{tail}");
        self.output_truncated = true;
    }

    pub fn finish(&mut self, exit_code: Option<i32>, error: Option<&str>) {
        self.exit_code = exit_code;
        if let Some(error) = error {
            self.status = ManagedShellStatus::Failed;
            if !self.output.is_empty() && !self.output.ends_with('\n') {
                self.append_output("\n");
            }
            self.append_output(error);
            return;
        }
        self.status = if exit_code == Some(0) {
            ManagedShellStatus::Completed
        } else {
            ManagedShellStatus::Failed
        };
    }

    pub fn context_output(&self) -> (String, bool) {
        if self.output.len() <= MAX_CONTEXT_OUTPUT_BYTES {
            return (self.output.clone(), self.output_truncated);
        }
        let output = format!(
            "{OUTPUT_TRUNCATION_MARKER}{}",
            utf8_suffix(
                &self.output,
                MAX_CONTEXT_OUTPUT_BYTES - OUTPUT_TRUNCATION_MARKER.len(),
            )
        );
        (output, true)
    }

    pub fn claimed_delivery_id(&self) -> Option<&str> {
        if self.metadata.context_state != ShellContextState::Claimed {
            return None;
        }
        self.metadata.delivery_id.as_deref()
    }

    pub fn recover_after_restart(&mut self, claimed_delivery_received: bool) -> bool {
        if self.status == ManagedShellStatus::Running {
            self.finish(None, Some(RESTART_INTERRUPTION_MESSAGE));
            self.reset_context_claim();
            return true;
        }
        if self.metadata.context_state != ShellContextState::Claimed {
            return false;
        }
        if claimed_delivery_received {
            self.metadata.context_state = ShellContextState::Delivered;
        } else {
            self.reset_context_claim();
        }
        true
    }

    fn reset_context_claim(&mut self) {
        self.metadata.context_state = ShellContextState::Pending;
        self.metadata.delivery_id = None;
    }
}

const fn is_false(value: &bool) -> bool {
    !*value
}

fn utf8_suffix(value: &str, max_bytes: usize) -> &str {
    if value.len() <= max_bytes {
        return value;
    }
    let mut start = value.len() - max_bytes;
    while !value.is_char_boundary(start) {
        start += 1;
    }
    &value[start..]
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn retained_and_context_output_are_bounded() {
        let mut payload = ManagedShellPayload::running("yes", "/tmp");
        payload.append_output(&"x".repeat(MAX_RETAINED_OUTPUT_BYTES * 2));
        assert!(payload.output_truncated);
        assert!(payload.output.len() <= MAX_RETAINED_OUTPUT_BYTES);
        assert!(payload.context_output().0.len() <= MAX_CONTEXT_OUTPUT_BYTES);
    }

    #[test]
    fn failed_payload_keeps_output_and_error() {
        let mut payload = ManagedShellPayload::running("false", "/tmp");
        payload.append_output("before");
        payload.finish(None, Some("spawn failed"));

        assert_eq!(payload.status, ManagedShellStatus::Failed);
        assert_eq!(payload.output, "before\nspawn failed");
    }

    #[test]
    fn restart_recovery_fails_running_commands_with_bounded_output() {
        let mut payload = ManagedShellPayload::running("yes", "/tmp");
        payload.append_output(&"x".repeat(MAX_RETAINED_OUTPUT_BYTES));

        assert!(payload.recover_after_restart(false));

        assert_eq!(payload.status, ManagedShellStatus::Failed);
        assert!(payload.output.contains(RESTART_INTERRUPTION_MESSAGE));
        assert!(payload.output.len() <= MAX_RETAINED_OUTPUT_BYTES);
        assert_eq!(payload.metadata.context_state, ShellContextState::Pending);
        assert_eq!(payload.metadata.delivery_id, None);
    }
}
