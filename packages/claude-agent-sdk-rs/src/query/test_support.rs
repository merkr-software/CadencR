//! Test-only helpers shared across the `query` submodules.
//!
//! This module contains **no tests** — only fixtures used by tests in
//! sibling submodules. The `inline-rust-tests` rule forbids a sibling
//! `tests.rs` for unit tests; a helpers module is structurally different.

#![cfg(test)]

use std::os::unix::fs::PermissionsExt;
use std::path::{Path, PathBuf};

use crate::mcp::McpServerConfig;

/// Write `script` to `<dir>/claude` and chmod +x. Returns the path.
///
/// Replaces the ~7-line boilerplate every mock-CLI test would otherwise
/// repeat.
pub(super) fn write_mock_cli(dir: &Path, script: &str) -> PathBuf {
    let script_path = dir.join("claude");
    std::fs::write(&script_path, script).unwrap();
    let mut perms = std::fs::metadata(&script_path).unwrap().permissions();
    perms.set_mode(0o755);
    std::fs::set_permissions(&script_path, perms).unwrap();
    script_path
}

/// Return a deterministic fake MCP config for mock-CLI tests that explicitly
/// read the SDK's pre-prompt `mcp_status` control request.
pub(super) fn mock_mcp_servers() -> std::collections::HashMap<String, McpServerConfig> {
    let mut servers = std::collections::HashMap::new();
    servers.insert(
        "chrome-devtools".to_string(),
        McpServerConfig::Stdio {
            command: "chrome-devtools".to_string(),
            args: None,
            env: None,
        },
    );
    servers.insert(
        "ios-simulator".to_string(),
        McpServerConfig::Stdio {
            command: "ios-simulator".to_string(),
            args: None,
            env: None,
        },
    );
    servers
}

/// Mock CLI script that emits a permission request, waits until the test
/// callback has started, cancels the request, then checks for stale stdin.
pub(super) fn control_cancel_permission_script(
    done_literal: &str,
    started_literal: &str,
) -> String {
    format!(
        r#"#!/usr/bin/env python3
import json, os, select, sys, time
done_path = {done_literal}
started_path = {started_literal}
init_req = json.loads(sys.stdin.readline())
print(json.dumps({{"type":"control_response","response":{{"subtype":"success","request_id":init_req["request_id"],"response":{{}}}}}}), flush=True)
next_msg = json.loads(sys.stdin.readline())
if next_msg.get("type") == "control_request":
    print(json.dumps({{"type":"control_response","response":{{"subtype":"success","request_id":next_msg["request_id"],"response":{{"mcpServers":[]}}}}}}), flush=True)
    sys.stdin.readline()
print('{{"type":"system","subtype":"init","uuid":"u1","session_id":"sess_cancel","claude_code_version":"1.0","cwd":"/tmp","tools":[],"mcp_servers":[],"model":"claude-sonnet-4-20250514","permission_mode":"default","slash_commands":[],"output_style":"stream","skills":[],"plugins":[]}}', flush=True)
print('{{"type":"control_request","request_id":"req_cancel","request":{{"subtype":"can_use_tool","tool_name":"Write","input":{{"path":"/tmp/test.txt"}}}}}}', flush=True)
deadline = time.time() + 2
while time.time() < deadline and not os.path.exists(started_path):
    time.sleep(0.01)
if not os.path.exists(started_path):
    print('{{"type":"result","subtype":"success","uuid":"u2","session_id":"sess_cancel","duration_ms":10,"duration_api_ms":5,"is_error":true,"num_turns":1,"result":"permission callback did not start","errors":null,"stop_reason":"end_turn","total_cost_usd":0.0,"usage":{{"input_tokens":1,"output_tokens":1}},"permission_denials":[],"structured_output":null}}', flush=True)
    sys.exit(0)
print('{{"type":"control_cancel_request","request_id":"req_cancel"}}', flush=True)
deadline = time.time() + 2
while time.time() < deadline and not os.path.exists(done_path):
    time.sleep(0.01)
if not os.path.exists(done_path):
    print('{{"type":"result","subtype":"success","uuid":"u2","session_id":"sess_cancel","duration_ms":10,"duration_api_ms":5,"is_error":true,"num_turns":1,"result":"permission callback did not complete","errors":null,"stop_reason":"end_turn","total_cost_usd":0.0,"usage":{{"input_tokens":1,"output_tokens":1}},"permission_denials":[],"structured_output":null}}', flush=True)
    sys.exit(0)
deadline = time.time() + 1
late = None
while time.time() < deadline:
    ready, _, _ = select.select([sys.stdin], [], [], 0.01)
    if ready:
        late = sys.stdin.readline().strip()
        break
if late:
    print(json.dumps({{"type":"result","subtype":"success","uuid":"u2","session_id":"sess_cancel","duration_ms":10,"duration_api_ms":5,"is_error":True,"num_turns":1,"result":f"late permission response: {{late}}","errors":None,"stop_reason":"end_turn","total_cost_usd":0.0,"usage":{{"input_tokens":1,"output_tokens":1}},"permission_denials":[],"structured_output":None}}), flush=True)
else:
    print('{{"type":"result","subtype":"success","uuid":"u2","session_id":"sess_cancel","duration_ms":10,"duration_api_ms":5,"is_error":false,"num_turns":1,"result":"cancelled cleanly","errors":null,"stop_reason":"end_turn","total_cost_usd":0.0,"usage":{{"input_tokens":1,"output_tokens":1}},"permission_denials":[],"structured_output":null}}', flush=True)
    "#
    )
}
