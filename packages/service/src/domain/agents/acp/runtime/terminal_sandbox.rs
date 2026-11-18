//! Sandboxing helpers for ACP `terminal/create` requests.
//!
//! Two concerns split out of `terminal_registry.rs`:
//! 1. **cwd resolution** — canonicalize the requested working directory
//!    and confirm it lives under the session cwd. Anything that escapes
//!    the sandbox (or fails to canonicalize) is rejected.
//! 2. **env parsing** — accept ACP's schema-correct array shape
//!    (`[{ "name", "value" }]`, preferred) as well as the legacy object
//!    shape (`{ "FOO": "bar" }`, deprecated) for backward compat. The
//!    legacy shape emits a single `tracing::warn!` per session.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};

use serde_json::Value;
use tokio::process::Command;

const SAFE_PATH: &str = "/usr/bin:/bin:/usr/sbin:/sbin";

/// Resolve the cwd for `terminal/create`, defaulting to the session cwd
/// and rejecting anything that escapes the sandbox. The path may not
/// exist on disk yet, but it must canonicalize cleanly *and* sit under
/// `session_cwd`'s canonical form. A cwd that cannot be canonicalized is
/// rejected with `-32602` and the reason, so the agent can correct it.
pub(super) fn resolve_sandboxed_cwd(
    raw: Option<&Value>,
    session_cwd: &Path,
) -> Result<PathBuf, (i64, String)> {
    let session_canonical = std::fs::canonicalize(session_cwd).map_err(|error| {
        (
            -32602,
            format!("terminal/create: session cwd is not accessible: {error}"),
        )
    })?;
    let Some(raw) = raw.and_then(Value::as_str) else {
        return Ok(session_canonical);
    };
    let candidate = PathBuf::from(raw);
    let resolved = std::fs::canonicalize(&candidate).map_err(|error| {
        (
            -32602,
            format!("terminal/create: cwd {raw} cannot be resolved: {error}"),
        )
    })?;
    if !resolved.starts_with(&session_canonical) {
        return Err((
            -32602,
            "terminal/create: cwd outside session sandbox".to_string(),
        ));
    }
    Ok(resolved)
}

/// Parse the ACP `env` field on a `terminal/create` request.
///
/// Accepts both the schema-correct array shape (`[{ "name", "value" }, ...]`,
/// preferred) and the legacy object shape (`{ "FOO": "bar" }`, deprecated —
/// emits a single `tracing::warn!` per session via `legacy_warned`).
/// Anything else is rejected with `-32602`.
pub(super) fn parse_acp_env(
    raw: Option<&Value>,
    legacy_warned: &AtomicBool,
) -> Result<HashMap<String, String>, (i64, String)> {
    let Some(raw) = raw else {
        return Ok(HashMap::new());
    };
    if raw.is_null() {
        return Ok(HashMap::new());
    }
    if let Some(array) = raw.as_array() {
        return parse_env_array(array);
    }
    if let Some(map) = raw.as_object() {
        if !legacy_warned.swap(true, Ordering::Relaxed) {
            tracing::warn!(
                "ACP terminal/create env supplied as object; this shape is deprecated, expected [{{\"name\",\"value\"}}]"
            );
        }
        return parse_env_object(map);
    }
    Err((
        -32602,
        "terminal/create: 'env' must be an array of {name,value} or an object".to_string(),
    ))
}

/// Apply the environment for an agent-requested terminal command.
///
/// ACP `terminal/create` commands are selected by the agent/provider, not by
/// Cadencr or the user. Do not implicitly pass the service process' hydrated
/// login-shell environment here: it can contain tokens, SSH sockets, cloud
/// credentials, and other user secrets. Start from a small baseline required
/// for normal local process execution, then overlay explicit ACP env entries.
pub(super) fn apply_restricted_env(cmd: &mut Command, env: &HashMap<String, String>) {
    cmd.env_clear();
    cmd.env("PATH", SAFE_PATH);
    copy_parent_if_present(cmd, "HOME");
    copy_parent_if_present(cmd, "LANG");
    copy_parent_if_present(cmd, "LC_ALL");
    copy_parent_if_present(cmd, "LC_CTYPE");
    for (key, value) in env {
        cmd.env(key, value);
    }
}

fn copy_parent_if_present(cmd: &mut Command, key: &str) {
    if let Some(value) = std::env::var_os(key) {
        cmd.env(key, value);
    }
}

fn parse_env_array(array: &[Value]) -> Result<HashMap<String, String>, (i64, String)> {
    let mut env = HashMap::with_capacity(array.len());
    for entry in array {
        let name = entry.get("name").and_then(Value::as_str).ok_or((
            -32602,
            "terminal/create: 'env' entry missing string 'name'".to_string(),
        ))?;
        let value = entry.get("value").and_then(Value::as_str).ok_or((
            -32602,
            "terminal/create: 'env' entry missing string 'value'".to_string(),
        ))?;
        env.insert(name.to_string(), value.to_string());
    }
    Ok(env)
}

fn parse_env_object(
    map: &serde_json::Map<String, Value>,
) -> Result<HashMap<String, String>, (i64, String)> {
    let mut env = HashMap::with_capacity(map.len());
    for (key, value) in map {
        let value = value.as_str().ok_or((
            -32602,
            format!("terminal/create: 'env.{key}' must be a string"),
        ))?;
        env.insert(key.clone(), value.to_string());
    }
    Ok(env)
}

#[cfg(test)]
mod tests {
    use super::{parse_acp_env, resolve_sandboxed_cwd};
    use serde_json::json;
    use std::sync::atomic::{AtomicBool, Ordering};

    #[test]
    fn parse_acp_env_array_shape_round_trips() {
        let warned = AtomicBool::new(false);
        let v = json!([
            { "name": "FOO", "value": "1" },
            { "name": "BAR", "value": "2" },
        ]);
        let env = parse_acp_env(Some(&v), &warned).expect("ok");
        assert_eq!(env.get("FOO").map(String::as_str), Some("1"));
        assert_eq!(env.get("BAR").map(String::as_str), Some("2"));
        assert!(!warned.load(Ordering::Relaxed));
    }

    #[test]
    fn parse_acp_env_object_shape_warns_once() {
        let warned = AtomicBool::new(false);
        let v = json!({ "FOO": "1" });
        let env = parse_acp_env(Some(&v), &warned).expect("legacy ok");
        assert_eq!(env.get("FOO").map(String::as_str), Some("1"));
        assert!(warned.load(Ordering::Relaxed));
        // Second call: still parses fine (AtomicBool stays true => no double-warn).
        let _ = parse_acp_env(Some(&v), &warned).expect("legacy still ok");
    }

    #[test]
    fn parse_acp_env_rejects_non_string_array_entry() {
        let warned = AtomicBool::new(false);
        let v = json!([{ "name": "FOO", "value": 42 }]);
        let err = parse_acp_env(Some(&v), &warned).expect_err("number value rejected");
        assert_eq!(err.0, -32602);
    }

    #[test]
    fn parse_acp_env_rejects_array_entry_missing_name() {
        let warned = AtomicBool::new(false);
        let v = json!([{ "value": "1" }]);
        let err = parse_acp_env(Some(&v), &warned).expect_err("missing name rejected");
        assert_eq!(err.0, -32602);
    }

    #[test]
    fn parse_acp_env_rejects_scalar_input() {
        let warned = AtomicBool::new(false);
        let v = json!("oops");
        let err = parse_acp_env(Some(&v), &warned).expect_err("string rejected");
        assert_eq!(err.0, -32602);
    }

    #[test]
    fn parse_acp_env_treats_missing_and_null_as_empty() {
        let warned = AtomicBool::new(false);
        assert!(parse_acp_env(None, &warned).unwrap().is_empty());
        let v = serde_json::Value::Null;
        assert!(parse_acp_env(Some(&v), &warned).unwrap().is_empty());
    }

    #[test]
    fn resolve_sandboxed_cwd_defaults_to_session_when_unset() {
        let session = std::env::temp_dir();
        let resolved = resolve_sandboxed_cwd(None, &session).expect("ok");
        assert_eq!(
            resolved,
            std::fs::canonicalize(&session).expect("canonical tmp")
        );
    }

    #[test]
    fn resolve_sandboxed_cwd_accepts_subdirectory() {
        let session = std::env::temp_dir();
        let canonical_session = std::fs::canonicalize(&session).unwrap();
        let sub = canonical_session.join("acp-sandbox-test-subdir");
        let _ = std::fs::create_dir_all(&sub);
        let v = serde_json::Value::String(sub.to_string_lossy().into_owned());
        let resolved = resolve_sandboxed_cwd(Some(&v), &session).expect("subdir ok");
        assert!(resolved.starts_with(&canonical_session));
        let _ = std::fs::remove_dir(&sub);
    }

    #[test]
    fn resolve_sandboxed_cwd_rejects_outside_path() {
        let session = std::env::temp_dir();
        let v = json!("/etc");
        let err = resolve_sandboxed_cwd(Some(&v), &session).expect_err("outside-sandbox rejected");
        assert_eq!(err.0, -32602);
        assert!(err.1.contains("outside session sandbox"), "got: {}", err.1);
    }

    #[test]
    fn resolve_sandboxed_cwd_rejects_nonexistent_path() {
        let session = std::env::temp_dir();
        let canonical_session = std::fs::canonicalize(&session).unwrap();
        let bogus = canonical_session.join("definitely-not-a-real-dir-xyz123");
        let v = serde_json::Value::String(bogus.to_string_lossy().into_owned());
        let err = resolve_sandboxed_cwd(Some(&v), &session).expect_err("nonexistent rejected");
        assert_eq!(err.0, -32602);
        // It used to read "outside session sandbox", hiding the real cause.
        assert!(err.1.contains("cannot be resolved"), "got: {}", err.1);
        assert!(!err.1.contains("outside session sandbox"), "got: {}", err.1);
    }
}
