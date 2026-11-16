//! Feature-scoped Browser bridge credentials.
//!
//! The desktop bridge drives every Browser panel, so its launch token is kept
//! by the service alone. Each Browser MCP subprocess receives a token derived
//! for its pinned feature instead: the desktop recomputes it from the launch
//! token and refuses a request whose `feature_id` is not the one the token was
//! derived for. A process that reads the subprocess's environment can then only
//! reach the conversation it was started for.
//!
//! Format, mirrored by `packages/desktop/electron/main/browser-bridge-auth.ts`:
//! `fb1.<feature_id>.<base64url(HMAC-SHA256(launch token, "cadencr-browser-bridge/feature/<feature_id>"))>`.

use crate::app_state::BrowserBridgeConfig;
use crate::shared::security::hmac_sha256_base64url;

const PREFIX: &str = "fb1";

/// The bridge token for a Browser MCP subprocess pinned to `feature_id`.
pub fn feature_token(launch_token: &str, feature_id: i64) -> String {
    let signature = hmac_sha256_base64url(
        launch_token,
        &format!("cadencr-browser-bridge/feature/{feature_id}"),
    );
    format!("{PREFIX}.{feature_id}.{signature}")
}

/// `config` with its launch token replaced by the one scoped to `feature_id`.
pub fn scoped_to_feature(config: &BrowserBridgeConfig, feature_id: i64) -> BrowserBridgeConfig {
    BrowserBridgeConfig {
        url: config.url.clone(),
        token: feature_token(&config.token, feature_id),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn feature_tokens_are_stable_and_bound_to_their_feature() {
        // Same vector as browser-bridge-auth.test.ts: both sides must agree.
        assert_eq!(
            feature_token("launch-secret", 42),
            "fb1.42.OljfrXUARHvWR-yaEie8dwL9IOAF6oiZJgPLhoM1Upc"
        );
        assert_ne!(
            feature_token("launch-secret", 42),
            feature_token("launch-secret", 43)
        );
        assert_ne!(
            feature_token("launch-secret", 42),
            feature_token("other", 42)
        );
    }

    #[test]
    fn a_scoped_config_never_carries_the_launch_token() {
        let config =
            BrowserBridgeConfig::from_raw("http://127.0.0.1:9/browser-bridge", "launch-secret")
                .unwrap();
        let scoped = scoped_to_feature(&config, 7);
        assert_eq!(scoped.url, config.url);
        assert!(!scoped.token.contains("launch-secret"));
        assert!(scoped.token.starts_with("fb1.7."));
    }
}
