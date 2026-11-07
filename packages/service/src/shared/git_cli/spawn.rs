//! The one constructor for captured (non-PTY) `git` processes.
//!
//! The service inherits the user's login-shell locale (`login_env` copies
//! `LANG` / `LC_ALL`), so a localized Git prints `CONFLIT`, `existe déjà`, …
//! and every parser that reads Git's human output silently stops matching.
//! Captured commands therefore force untranslated messages. Only the message
//! category changes: `LC_CTYPE` keeps the user's encoding so hooks and
//! non-ASCII paths behave as they do in a terminal. PTY-streamed Git
//! (`commands::pty_spawn`) and user terminals keep the user's locale.

use std::ffi::OsString;

/// A `tokio` `git` command with the machine-readable environment applied.
pub fn git_command() -> tokio::process::Command {
    tokio::process::Command::from(git_std_command())
}

/// Blocking counterpart of [`git_command`] for synchronous call sites.
pub fn git_std_command() -> std::process::Command {
    let mut command = std::process::Command::new("git");
    apply_machine_readable_env(
        &mut command,
        std::env::var_os("LC_ALL"),
        std::env::var_os("LC_CTYPE"),
    );
    command
}

fn apply_machine_readable_env(
    command: &mut std::process::Command,
    inherited_lc_all: Option<OsString>,
    inherited_lc_ctype: Option<OsString>,
) {
    // `LC_ALL` outranks `LC_MESSAGES`, so it has to go; its value survives as
    // the character type unless the user configured that category directly.
    if let Some(lc_all) = inherited_lc_all {
        command.env_remove("LC_ALL");
        if inherited_lc_ctype.is_none() {
            command.env("LC_CTYPE", lc_all);
        }
    }
    // gettext ignores `LANGUAGE` once messages resolve to "C"; removing it
    // also covers implementations that do not.
    command.env("LC_MESSAGES", "C");
    command.env_remove("LANGUAGE");
    // Nobody can answer a credential prompt on a captured command: fail
    // instead of blocking on the service's controlling terminal.
    command.env("GIT_TERMINAL_PROMPT", "0");
}

#[cfg(test)]
mod tests {
    use super::*;

    fn env_of(command: &std::process::Command) -> Vec<(String, Option<String>)> {
        let mut env: Vec<_> = command
            .get_envs()
            .map(|(key, value)| {
                (
                    key.to_string_lossy().into_owned(),
                    value.map(|value| value.to_string_lossy().into_owned()),
                )
            })
            .collect();
        env.sort();
        env
    }

    fn configured(lc_all: Option<&str>, lc_ctype: Option<&str>) -> Vec<(String, Option<String>)> {
        let mut command = std::process::Command::new("git");
        apply_machine_readable_env(
            &mut command,
            lc_all.map(OsString::from),
            lc_ctype.map(OsString::from),
        );
        env_of(&command)
    }

    fn value(env: &[(String, Option<String>)], key: &str) -> Option<Option<String>> {
        env.iter()
            .find(|(name, _)| name == key)
            .map(|(_, value)| value.clone())
    }

    #[test]
    fn forces_untranslated_messages_and_disables_prompts() {
        let env = configured(None, None);
        assert_eq!(value(&env, "LC_MESSAGES"), Some(Some("C".into())));
        assert_eq!(
            value(&env, "LANGUAGE"),
            Some(None),
            "LANGUAGE must be removed"
        );
        assert_eq!(value(&env, "GIT_TERMINAL_PROMPT"), Some(Some("0".into())));
        assert_eq!(value(&env, "LC_ALL"), None, "untouched when not inherited");
        assert_eq!(value(&env, "LC_CTYPE"), None);
    }

    #[test]
    fn inherited_lc_all_is_removed_but_keeps_the_encoding() {
        let env = configured(Some("fr_FR.UTF-8"), None);
        assert_eq!(value(&env, "LC_ALL"), Some(None));
        assert_eq!(value(&env, "LC_CTYPE"), Some(Some("fr_FR.UTF-8".into())));
        assert_eq!(value(&env, "LC_MESSAGES"), Some(Some("C".into())));
    }

    #[test]
    fn explicit_lc_ctype_wins_over_the_removed_lc_all() {
        let env = configured(Some("fr_FR.UTF-8"), Some("en_US.UTF-8"));
        assert_eq!(value(&env, "LC_ALL"), Some(None));
        assert_eq!(
            value(&env, "LC_CTYPE"),
            None,
            "inherited LC_CTYPE stays as is"
        );
    }

    /// End-to-end: a child that inherits a French locale (`LANG`, `LC_ALL`,
    /// `LANGUAGE`, as `login_env` passes them) still gets English messages.
    /// The inherited variables are set on the command before the override is
    /// applied, exactly as they would arrive from the service's environment.
    /// On a Git built without gettext (Apple's) this passes trivially; on a
    /// Linux distribution Git with `fr_FR` installed it exercises translation.
    #[test]
    fn localized_inherited_environment_still_yields_english_git_messages() {
        let dir = tempfile::tempdir().unwrap();
        let mut command = std::process::Command::new("git");
        command
            .env("LANG", "fr_FR.UTF-8")
            .env("LC_ALL", "fr_FR.UTF-8")
            .env("LANGUAGE", "fr");
        apply_machine_readable_env(&mut command, Some("fr_FR.UTF-8".into()), None);
        let output = command
            .args(["rev-parse", "--verify", "refs/heads/does-not-exist"])
            .current_dir(dir.path())
            .output()
            .unwrap();
        assert!(!output.status.success());
        let stderr = String::from_utf8_lossy(&output.stderr);
        assert!(stderr.contains("not a git repository"), "{stderr}");
    }
}
