use std::ffi::OsStr;

use tokio::process::Command;

use crate::{session_command, ChildSession};

/// Build a command that asks the user's shell to `exec` a program.
///
/// The service process is already hydrated from the user's shell environment
/// on startup. This helper still launches through `$SHELL -l -c` so provider
/// CLIs are started from the same login-shell path as a terminal launch, while
/// avoiding `-i` because interactive startup without a PTY triggers prompt and
/// keybinding plugins such as zsh/fzf.
pub fn login_shell_exec_command<I, S>(program: &OsStr, args: I) -> Command
where
    I: IntoIterator<Item = S>,
    S: AsRef<OsStr>,
{
    login_shell_session_command(program, args, None)
}

pub fn login_shell_session_command<I, S>(
    program: &OsStr,
    args: I,
    session: Option<&ChildSession>,
) -> Command
where
    I: IntoIterator<Item = S>,
    S: AsRef<OsStr>,
{
    shell_command(&login_shell_exec_script(program, args), session)
}

/// Build `$SHELL -l -c <script>`, falling back to `/bin/sh -c` when `$SHELL`
/// is unset.
pub fn login_shell_command(script: &str) -> Command {
    shell_command(script, None)
}

fn shell_command(script: &str, session: Option<&ChildSession>) -> Command {
    let (shell, login) = shell_program();
    let mut command = session_command(shell, session);
    if login {
        command.arg("-l");
    }
    command.arg("-c").arg(script);
    command
}

/// Return the script passed to `$SHELL -l -c`.
fn login_shell_exec_script<I, S>(program: &OsStr, args: I) -> String
where
    I: IntoIterator<Item = S>,
    S: AsRef<OsStr>,
{
    let mut parts = vec!["exec".to_string(), shell_quote(program)];
    parts.extend(args.into_iter().map(|arg| shell_quote(arg.as_ref())));
    parts.join(" ")
}

fn shell_program() -> (String, bool) {
    match std::env::var("SHELL") {
        Ok(shell) if !shell.trim().is_empty() => (shell, true),
        _ => ("/bin/sh".to_string(), false),
    }
}

pub fn shell_quote(value: &OsStr) -> String {
    let value = value.to_string_lossy();
    format!("'{}'", value.replace('\'', "'\\''"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::ffi::OsString;

    #[test]
    fn login_shell_exec_script_quotes_program_and_args() {
        let script = login_shell_exec_script(
            OsStr::new("/tmp/fake cli"),
            [OsString::from("arg one"), OsString::from("it's ok")],
        );

        assert_eq!(script, "exec '/tmp/fake cli' 'arg one' 'it'\\''s ok'");
    }

    #[test]
    fn login_shell_exec_command_uses_login_shell_without_interactive_flag() {
        let cmd = login_shell_exec_command(
            OsStr::new("/tmp/fake-cli"),
            [OsString::from("--flag"), OsString::from("value")],
        );
        let args = cmd
            .as_std()
            .get_args()
            .map(|arg| arg.to_string_lossy().into_owned())
            .collect::<Vec<_>>();

        assert!(args.iter().any(|arg| arg == "-c"));
        assert!(!args.iter().any(|arg| arg == "-i" || arg == "-ilc"));
    }

    #[test]
    fn login_shell_command_wraps_script_without_interactive_flag() {
        let cmd = login_shell_command("echo ok");
        let args = cmd
            .as_std()
            .get_args()
            .map(|arg| arg.to_string_lossy().into_owned())
            .collect::<Vec<_>>();

        assert!(args.windows(2).any(|args| args == ["-c", "echo ok"]));
        assert!(!args.iter().any(|arg| arg == "-i" || arg == "-ilc"));
    }
}
