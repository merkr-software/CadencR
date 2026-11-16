use base64::Engine;
use hmac::{Hmac, KeyInit, Mac};
use sha2::Sha256;
use subtle::ConstantTimeEq;

use crate::app_state::{BROWSER_BRIDGE_TOKEN_ENV, BROWSER_BRIDGE_URL_ENV};

pub const SERVICE_AUTH_TOKEN_ENV: &str = "CADENCR_AUTH_TOKEN";

/// Credentials the desktop hands the service process at launch, which no child
/// may inherit: the API token, and the Browser bridge that drives every
/// Browser panel (Browser MCP subprocesses get a feature-scoped token
/// explicitly instead; see `domain::mcp::tools::browser_bridge_scope`).
pub const SERVICE_ONLY_ENV: [&str; 3] = [
    SERVICE_AUTH_TOKEN_ENV,
    BROWSER_BRIDGE_URL_ENV,
    BROWSER_BRIDGE_TOKEN_ENV,
];

pub fn constant_time_str_eq(left: &str, right: &str) -> bool {
    bool::from(left.as_bytes().ct_eq(right.as_bytes()))
}

/// `base64url(HMAC-SHA256(key, message))`, unpadded: the signature of the
/// service's derived credentials (control grants, scoped bridge tokens).
pub fn hmac_sha256_base64url(key: &str, message: &str) -> String {
    let mut mac =
        Hmac::<Sha256>::new_from_slice(key.as_bytes()).expect("HMAC accepts keys of any length");
    mac.update(message.as_bytes());
    base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(mac.finalize().into_bytes())
}

/// Remove [`SERVICE_ONLY_ENV`] from the process environment once the service
/// holds its own copies, so nothing it spawns inherits them. Individual spawn
/// choke points also scrub them defensively.
pub fn remove_service_only_env() {
    for key in SERVICE_ONLY_ENV {
        std::env::remove_var(key);
    }
}

/// Remove [`SERVICE_ONLY_ENV`] from a child's environment.
pub fn scrub_service_only_env(command: &mut tokio::process::Command) {
    for key in SERVICE_ONLY_ENV {
        command.env_remove(key);
    }
}

/// Remove [`SERVICE_ONLY_ENV`] from a PTY child's environment.
pub fn scrub_service_only_pty_env(command: &mut portable_pty::CommandBuilder) {
    for key in SERVICE_ONLY_ENV {
        command.env_remove(key);
    }
}

/// Populate a PTY command with the service's hydrated environment while
/// excluding credentials that belong only to the service process.
pub fn inherit_sanitized_pty_env(command: &mut portable_pty::CommandBuilder) {
    for (key, value) in std::env::vars_os() {
        if !SERVICE_ONLY_ENV.iter().any(|secret| key == *secret) {
            command.env(key, value);
        }
    }
    scrub_service_only_pty_env(command);
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_scrubbed_child_inherits_no_service_credential() {
        let mut command = tokio::process::Command::new("true");
        for key in SERVICE_ONLY_ENV {
            command.env(key, "secret");
        }
        scrub_service_only_env(&mut command);
        let set: Vec<_> = command
            .as_std()
            .get_envs()
            .filter(|(_, value)| value.is_some())
            .map(|(key, _)| key.to_owned())
            .collect();
        assert!(set.is_empty(), "{set:?}");
    }

    #[test]
    fn a_sanitized_pty_drops_every_service_credential() {
        let mut command = portable_pty::CommandBuilder::new("true");
        for key in SERVICE_ONLY_ENV {
            command.env(key, "secret");
        }
        inherit_sanitized_pty_env(&mut command);
        for key in SERVICE_ONLY_ENV {
            assert!(command.get_env(key).is_none(), "{key} leaked");
        }
        assert!(SERVICE_ONLY_ENV.contains(&"CADENCR_BROWSER_BRIDGE_TOKEN"));
    }
}
