//! Why a Codex app-server stopped answering. One that exited on its own is
//! reported with how it ended and the end of its stderr (bounded, known
//! secrets masked), in the same words whichever request noticed first: its
//! stdout closing and its exit race, and either used to name the failure.

use std::collections::HashMap;

use codex_app_server_sdk_rs::{AppServerExit, CodexAppServerClient};

use crate::domain::agents::adapter::RuntimeError;
use crate::shared::cli_stderr;

/// The values to mask in the stderr of an app-server run with `env`: all of
/// a profile's values but `CODEX_HOME`, the profile directory Cadencr sets,
/// whose path is what makes a config error readable.
pub(super) fn secrets(env: Option<&HashMap<String, String>>) -> Vec<String> {
    cli_stderr::secret_values(env.into_iter().flat_map(|env| {
        env.iter()
            .filter(|(key, _)| key.as_str() != "CODEX_HOME")
            .map(|(_, value)| value.as_str())
    }))
}

/// `error`, or why `client`'s app-server died when it exited on its own.
/// Call it once `shutdown` has returned: the exit and the stderr are complete
/// only then.
pub(super) fn explain(
    client: &CodexAppServerClient,
    error: RuntimeError,
    secrets: &[String],
) -> RuntimeError {
    match client.exit() {
        Some(exit) => RuntimeError::new(describe(exit, &client.stderr_tail(), secrets)),
        None => error,
    }
}

fn describe(exit: AppServerExit, stderr_tail: &[String], secrets: &[String]) -> String {
    cli_stderr::exit_message(
        "Codex app-server",
        exit.code,
        exit.signal,
        stderr_tail,
        secrets,
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn names_the_exit_and_the_reason_with_secrets_masked() {
        let env = HashMap::from([(
            "OPENAI_BASE_URL".to_string(),
            "https://user:pw@proxy".to_string(),
        )]);
        let message = describe(
            AppServerExit {
                code: Some(1),
                signal: None,
            },
            &[
                "starting".to_string(),
                "cannot reach https://user:pw@proxy: simulated codex failure".to_string(),
            ],
            &secrets(Some(&env)),
        );
        assert_eq!(
            message,
            "Codex app-server exited with status 1: starting · cannot reach •••: simulated codex failure"
        );
    }

    #[test]
    fn the_profile_directory_stays_readable() {
        let env = HashMap::from([(
            "CODEX_HOME".to_string(),
            "/Users/me/.cadencr/codex-profiles/work".to_string(),
        )]);
        let message = describe(
            AppServerExit {
                code: Some(1),
                signal: None,
            },
            &["invalid config at /Users/me/.cadencr/codex-profiles/work/config.toml".to_string()],
            &secrets(Some(&env)),
        );
        assert!(
            message.ends_with("/Users/me/.cadencr/codex-profiles/work/config.toml"),
            "{message}"
        );
    }

    #[test]
    fn the_same_failure_reads_the_same() {
        let tail = vec!["simulated codex failure".to_string()];
        let exit = AppServerExit {
            code: Some(1),
            signal: None,
        };
        assert_eq!(describe(exit, &tail, &[]), describe(exit, &tail, &[]));
    }
}
