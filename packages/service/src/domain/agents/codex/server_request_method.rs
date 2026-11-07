//! Allow-list of the Codex app-server requests (server → client) Cadencr can
//! answer. Every request Codex sends is parsed here first: a method outside
//! this list is rejected with JSON-RPC `-32601` instead of being shown as a
//! generic approval and answered with a guessed `{"decision": ...}` payload.
//!
//! Source of truth: `codex app-server generate-json-schema` →
//! `ServerRequest.json`. Methods present there but deliberately unsupported
//! (`item/tool/call` dynamic tools, `account/chatgptAuthTokens/refresh`,
//! `attestation/generate`, experimental `currentTime/read`) take the
//! method-not-found path: Cadencr registers no dynamic tools and does not own
//! ChatGPT auth tokens.

use super::legacy_permissions::LegacyPermissionMethod;

/// JSON-RPC 2.0 "Method not found".
pub(super) const JSON_RPC_METHOD_NOT_FOUND: i64 = -32601;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) enum CodexServerRequestMethod {
    CommandExecutionApproval,
    FileChangeApproval,
    PermissionsApproval,
    ToolUserInput,
    McpElicitation,
    Legacy(LegacyPermissionMethod),
}

impl CodexServerRequestMethod {
    pub(super) fn parse(method: &str) -> Option<Self> {
        if let Some(legacy) = LegacyPermissionMethod::parse(method) {
            return Some(Self::Legacy(legacy));
        }
        match method {
            "item/commandExecution/requestApproval" => Some(Self::CommandExecutionApproval),
            "item/fileChange/requestApproval" => Some(Self::FileChangeApproval),
            "item/permissions/requestApproval" => Some(Self::PermissionsApproval),
            "item/tool/requestUserInput" => Some(Self::ToolUserInput),
            "mcpServer/elicitation/request" => Some(Self::McpElicitation),
            _ => None,
        }
    }
}

#[cfg(test)]
pub(super) fn method(name: &str) -> CodexServerRequestMethod {
    CodexServerRequestMethod::parse(name).expect("allow-listed Codex server request")
}

#[cfg(test)]
mod tests {
    use super::CodexServerRequestMethod;
    use crate::domain::agents::codex::legacy_permissions::LegacyPermissionMethod;

    #[test]
    fn parses_every_supported_codex_server_request() {
        let cases = [
            (
                "item/commandExecution/requestApproval",
                CodexServerRequestMethod::CommandExecutionApproval,
            ),
            (
                "item/fileChange/requestApproval",
                CodexServerRequestMethod::FileChangeApproval,
            ),
            (
                "item/permissions/requestApproval",
                CodexServerRequestMethod::PermissionsApproval,
            ),
            (
                "item/tool/requestUserInput",
                CodexServerRequestMethod::ToolUserInput,
            ),
            (
                "mcpServer/elicitation/request",
                CodexServerRequestMethod::McpElicitation,
            ),
            (
                "execCommandApproval",
                CodexServerRequestMethod::Legacy(LegacyPermissionMethod::ExecCommandApproval),
            ),
            (
                "applyPatchApproval",
                CodexServerRequestMethod::Legacy(LegacyPermissionMethod::ApplyPatchApproval),
            ),
        ];
        for (name, expected) in cases {
            assert_eq!(
                CodexServerRequestMethod::parse(name),
                Some(expected),
                "{name}"
            );
        }
    }

    #[test]
    fn rejects_requests_cadencr_cannot_answer() {
        for name in [
            "item/tool/call",
            "account/chatgptAuthTokens/refresh",
            "attestation/generate",
            "currentTime/read",
            "item/tool/requestApproval",
            "server/ping",
            "",
        ] {
            assert_eq!(CodexServerRequestMethod::parse(name), None, "{name}");
        }
    }
}
