//! Shared builders for this module's inline tests.
//!
//! Every test module here needs the same two things — a descriptor value and a
//! file that is actually runnable — so they live once. Tests stay inline beside
//! the code they cover (`.claude/rules/inline-rust-tests.md`); only the
//! scaffolding is shared, following `acp/runtime/test_support.rs`.

use std::path::Path;

use serde_json::json;

use super::descriptor::ProviderDescriptor;

/// A minimal valid descriptor value: one agent entry plus a local executable.
pub fn descriptor_json(id: &str, command: &str) -> serde_json::Value {
    json!({
        "schema_version": 1,
        "agent": {
            "id": id,
            "name": format!("{id} agent"),
            "version": "1.0.0",
            "description": "an ACP agent",
        },
        "installation": { "executable": { "command": command } },
    })
}

pub fn descriptor(value: serde_json::Value) -> ProviderDescriptor {
    serde_json::from_value(value).expect("descriptor should deserialize")
}

/// Write an executable file into `dir` and return its absolute path, so a
/// descriptor pointing at it resolves without a quarantine.
pub fn runnable_binary(dir: &Path) -> String {
    let path = dir.join("agent-bin");
    std::fs::write(
        &path,
        br###"#!/bin/sh
if [ "$1" = "models" ]; then
  printf '%s\n' '[{"id":"model","name":"Model","category":"model","type":"select","currentValue":"fixture/default","options":[{"value":"fixture/default","name":"Fixture Default"}]}]'
  exit 0
fi
exit 0
"###,
    )
    .expect("write test binary");
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o755))
            .expect("mark test binary executable");
    }
    path.to_string_lossy().into_owned()
}
