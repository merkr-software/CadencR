//! How every Codex app-server is launched: the profile's environment, the
//! features Cadencr relies on, and what the service keeps to itself.

use std::collections::HashMap;
use std::path::PathBuf;

use codex_app_server_sdk_rs::AppServerSpawnOptions;

use super::DEFAULT_MODE_REQUEST_USER_INPUT_FEATURE;

/// The service's own log filter. Inherited, it makes Codex write its INFO
/// logs to stderr, hundreds of lines per run that crowd out the lines
/// explaining a crash. A profile that sets it on purpose still passes it on.
const SERVICE_LOG_FILTER: &str = "RUST_LOG";

pub(super) fn app_server_spawn_options(
    env: Option<HashMap<String, String>>,
    mut env_unset: Vec<String>,
    cwd: Option<PathBuf>,
) -> AppServerSpawnOptions {
    let profile_sets_filter = env
        .as_ref()
        .is_some_and(|env| env.contains_key(SERVICE_LOG_FILTER));
    if !profile_sets_filter && !env_unset.iter().any(|key| key == SERVICE_LOG_FILTER) {
        env_unset.push(SERVICE_LOG_FILTER.to_string());
    }
    AppServerSpawnOptions::builder()
        .maybe_env(env)
        .env_unset(env_unset)
        .maybe_cwd(cwd)
        .enable_features(vec![DEFAULT_MODE_REQUEST_USER_INPUT_FEATURE.to_string()])
        .build()
}

#[cfg(test)]
mod tests {
    use std::collections::HashMap;

    use super::app_server_spawn_options;

    #[test]
    fn enables_request_user_input_in_default_mode() {
        let options = app_server_spawn_options(None, Vec::new(), None);
        assert!(options
            .enable_features
            .contains(&"default_mode_request_user_input".to_string()));
    }

    #[test]
    fn leaves_live_request_timeout_to_sdk_default() {
        let options = app_server_spawn_options(None, Vec::new(), None);
        assert!(options.request_timeout.is_none());
    }

    #[test]
    fn codex_does_not_inherit_the_service_log_filter() {
        let options = app_server_spawn_options(None, vec!["OPENAI_API_KEY".into()], None);
        assert_eq!(options.env_unset, ["OPENAI_API_KEY", "RUST_LOG"]);

        let profile = HashMap::from([("CODEX_HOME".to_string(), "/tmp/codex".to_string())]);
        let options = app_server_spawn_options(Some(profile), Vec::new(), None);
        assert_eq!(options.env_unset, ["RUST_LOG"]);

        let options = app_server_spawn_options(None, vec!["RUST_LOG".into()], None);
        assert_eq!(options.env_unset, ["RUST_LOG"]);
    }

    #[test]
    fn a_profile_that_sets_the_log_filter_keeps_it() {
        let profile = HashMap::from([("RUST_LOG".to_string(), "debug".to_string())]);
        let options = app_server_spawn_options(Some(profile), Vec::new(), None);
        assert!(options.env_unset.is_empty());
        assert_eq!(
            options.env.as_ref().and_then(|env| env.get("RUST_LOG")),
            Some(&"debug".to_string())
        );
    }
}
