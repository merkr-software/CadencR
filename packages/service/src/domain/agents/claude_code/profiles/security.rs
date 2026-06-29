//! Profile env-var security: keys a profile may never set, and response-time
//! redaction of secret-looking values.

use std::collections::HashMap;

/// Env keys a profile is never allowed to set. These are process-level
/// injection vectors (dynamic linker, git transports, resolver shim) or
/// host-shadowing vars; accepting them would let a compromised HTTP client
/// hijack the spawned CLI or any tool it invokes.
const DENIED_ENV_KEYS: &[&str] = &[
    "LD_PRELOAD",
    "LD_LIBRARY_PATH",
    "DYLD_INSERT_LIBRARIES",
    "DYLD_LIBRARY_PATH",
    "DYLD_FRAMEWORK_PATH",
    "GIT_SSH_COMMAND",
    "GIT_EXEC_PATH",
    "GIT_EXTERNAL_DIFF",
    "PATH",
    "SHELL",
    "NODE_OPTIONS",
    "PYTHONPATH",
    "SSL_CERT_FILE",
    "HOSTALIASES",
];

pub fn is_denied_env_key(key: &str) -> bool {
    DENIED_ENV_KEYS.iter().any(|d| d.eq_ignore_ascii_case(key))
}

/// Response-only redaction: replace values whose keys look like credentials
/// with `"***"` so DevTools / screenshots / logs don't leak them. The runtime
/// path (`resolve_active_profile_env`) returns the unredacted map directly.
pub fn redact_env_for_response(env: &HashMap<String, String>) -> HashMap<String, String> {
    env.iter()
        .map(|(k, v)| {
            if looks_like_secret_key(k) {
                (k.clone(), "***".to_string())
            } else {
                (k.clone(), v.clone())
            }
        })
        .collect()
}

fn looks_like_secret_key(key: &str) -> bool {
    let upper = key.to_ascii_uppercase();
    ["TOKEN", "KEY", "SECRET", "PASSWORD", "AUTH", "CREDENTIAL"]
        .iter()
        .any(|needle| upper.contains(needle))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn denies_injection_vectors_case_insensitively() {
        assert!(is_denied_env_key("LD_PRELOAD"));
        assert!(is_denied_env_key("path"));
        assert!(is_denied_env_key("GIT_SSH_COMMAND"));
        assert!(!is_denied_env_key("ANTHROPIC_API_KEY"));
        assert!(!is_denied_env_key("AWS_REGION"));
    }

    #[test]
    fn redact_hides_secret_like_values() {
        let mut env = HashMap::new();
        env.insert("ANTHROPIC_API_KEY".into(), "sk-live-secret".into());
        env.insert("GITHUB_TOKEN".into(), "ghp_xxx".into());
        env.insert("AUTH_BEARER".into(), "bearer xxx".into());
        env.insert("API_PASSWORD".into(), "hunter2".into());
        env.insert("OAUTH_SECRET".into(), "s3cr3t".into());
        env.insert("AWS_CREDENTIAL_PROVIDER".into(), "iam".into());

        let redacted = redact_env_for_response(&env);
        for (k, v) in &redacted {
            assert_eq!(v, "***", "{k} was not redacted: {v}");
        }
    }

    #[test]
    fn redact_keeps_non_secret_values() {
        let mut env = HashMap::new();
        env.insert("ANTHROPIC_BASE_URL".into(), "https://proxy".into());
        env.insert("AWS_REGION".into(), "us-east-1".into());
        env.insert("CLAUDE_CODE_USE_BEDROCK".into(), "1".into());

        let redacted = redact_env_for_response(&env);
        assert_eq!(redacted.get("ANTHROPIC_BASE_URL").unwrap(), "https://proxy");
        assert_eq!(redacted.get("AWS_REGION").unwrap(), "us-east-1");
        assert_eq!(redacted.get("CLAUDE_CODE_USE_BEDROCK").unwrap(), "1");
    }

    #[test]
    fn redact_is_case_insensitive() {
        let mut env = HashMap::new();
        env.insert("lowercase_token".into(), "v".into());
        env.insert("MixedCase_Key".into(), "v".into());
        let redacted = redact_env_for_response(&env);
        assert_eq!(redacted.get("lowercase_token").unwrap(), "***");
        assert_eq!(redacted.get("MixedCase_Key").unwrap(), "***");
    }
}
