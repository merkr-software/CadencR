use serde::{Deserialize, Serialize};

/// Messages sent from the client to the server over the terminal WebSocket.
#[derive(Debug, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum ClientMessage {
    Write { data: String },
    Resize { cols: u16, rows: u16 },
    Kill,
}

/// Messages sent from the server to the client over the terminal WebSocket.
#[derive(Debug, Serialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum ServerMessage {
    Data {
        data: String,
    },
    Exit {
        code: i32,
    },
    Ready {
        pty_id: String,
        /// Working directory the PTY was spawned in. The frontend uses this to
        /// detect terminals running outside the feature's current worktree.
        cwd: String,
    },
    Reconnected {
        scrollback: String,
        alive: bool,
        /// Original cwd of the PTY (None if the PTY handle is gone).
        cwd: Option<String>,
    },
    Error {
        message: String,
    },
    /// Client input the PTY could not take (the process exited, the write
    /// failed). Not fatal for the socket: the client shows it and carries on.
    InputError {
        message: String,
    },
}

impl ServerMessage {
    pub fn to_json(&self) -> String {
        serde_json::to_string(self).expect("ServerMessage serialization should not fail")
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn input_error_has_its_own_type_tag() {
        let message = ServerMessage::InputError {
            message: "Terminal input closed: the process has exited".to_string(),
        };
        assert_eq!(
            message.to_json(),
            r#"{"type":"input_error","message":"Terminal input closed: the process has exited"}"#
        );
    }
}
