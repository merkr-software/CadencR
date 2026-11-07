//! Helpers for commands that should run as the user would run them from a
//! terminal-oriented shell setup.
//!
//! The service process hydrates its environment from the user's login shell at
//! startup. Callers here inherit that hydrated environment and only decide how
//! to invoke the user's shell. We deliberately use a **login** shell but not an
//! interactive shell: `zsh -i -c` sources prompt/keybinding plugins without a
//! real PTY, which makes plugins such as `fzf` try to restore the immutable
//! `zle` option and print `(eval):1: can't change option: zle`.

use std::path::Path;

/// Build `$SHELL -l -c <command>` in `cwd`, falling back to `/bin/sh -c` when
/// `$SHELL` is unset. The returned command inherits the already-hydrated
/// process environment by default.
pub fn command(command: &str, cwd: &Path) -> tokio::process::Command {
    let mut cmd = cli_discovery::login_shell_command(command);
    cmd.current_dir(cwd);
    crate::shared::security::scrub_service_only_env(&mut cmd);
    cmd
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::shared::test_env::{env_lock, EnvVarGuard};

    #[test]
    fn command_uses_login_shell_without_interactive_flag() {
        let _guard = env_lock().lock().expect("env lock");
        let _shell = EnvVarGuard::set("SHELL", "/bin/zsh");
        let _auth = EnvVarGuard::set("CADENCR_AUTH_TOKEN", "service-secret");
        let cmd = command("echo ok", Path::new("/tmp"));
        let args = cmd
            .as_std()
            .get_args()
            .map(|arg| arg.to_string_lossy().into_owned())
            .collect::<Vec<_>>();

        assert_eq!(args, vec!["-l", "-c", "echo ok"]);
        assert!(!args.iter().any(|arg| arg == "-i"));
        assert!(cmd
            .as_std()
            .get_envs()
            .any(|(key, value)| key == "CADENCR_AUTH_TOKEN" && value.is_none()));
    }
}
