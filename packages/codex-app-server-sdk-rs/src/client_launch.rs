use std::collections::HashMap;
use std::ffi::OsStr;

pub(crate) fn profile_aware_command(
    program: &OsStr,
    args: &[String],
    env: Option<&HashMap<String, String>>,
    env_unset: &[String],
    session: Option<&cli_discovery::ChildSession>,
) -> tokio::process::Command {
    // The service environment is hydrated from the user's login shell at
    // startup. Execute directly so profile secrets never appear in `sh -c`
    // argv, then apply the per-process overlay/removals without mutating the
    // service's global environment.
    let mut command = cli_discovery::session_command(program, session);
    command.args(args);
    if let Some(env) = env {
        command.envs(env);
    }
    for key in env_unset {
        command.env_remove(key);
    }
    command
}

#[cfg(test)]
mod tests {
    use super::profile_aware_command;
    use std::collections::HashMap;
    use std::ffi::OsStr;

    #[test]
    fn profile_env_is_not_serialized_into_process_arguments() {
        let env = HashMap::from([
            ("CODEX_HOME".to_string(), "/tmp/codex home".to_string()),
            ("TOKEN".to_string(), "it's-secret".to_string()),
        ]);
        let command = profile_aware_command(
            OsStr::new("/tmp/codex bin"),
            &["app-server".to_string()],
            Some(&env),
            &["OPENAI_API_KEY".to_string()],
            None,
        );
        let args = command
            .as_std()
            .get_args()
            .map(|arg| arg.to_string_lossy().into_owned())
            .collect::<Vec<_>>();
        assert_eq!(args, ["app-server"]);
        assert!(!args.iter().any(|arg| arg.contains("it's-secret")));
    }
}
