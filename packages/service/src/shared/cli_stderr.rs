//! What an agent CLI's stderr may say in an error shown to the user: why the
//! process died, from its last lines, bounded, without terminal escapes, and
//! with the secret values Cadencr knows about masked. The same failure always
//! reads the same, so a retried probe does not change the message.

use std::process::ExitStatus;

/// Characters of stderr an error message carries at most.
const MAX_EXCERPT_CHARS: usize = 300;
/// Shorter values ("eu", "1") are not secrets, and masking them would garble
/// the text.
const MIN_SECRET_CHARS: usize = 6;
const MASK: &str = "•••";
const LINE_SEPARATOR: &str = " · ";

/// "<process> exited with status 1: <the end of its stderr>".
pub(crate) fn exit_message<S: AsRef<str>>(
    process: &str,
    code: Option<i32>,
    signal: Option<i32>,
    stderr_lines: &[S],
    secrets: &[String],
) -> String {
    let ended = match (code, signal) {
        (Some(code), _) => format!("exited with status {code}"),
        (None, Some(signal)) => format!("was killed by signal {signal}"),
        (None, None) => "exited".to_string(),
    };
    match excerpt(stderr_lines, secrets) {
        Some(excerpt) => format!("{process} {ended}: {excerpt}"),
        None => format!("{process} {ended}"),
    }
}

/// [`exit_message`] for a one-shot command that ran and failed, from its
/// exit `status` and everything it wrote to `stderr`.
pub(crate) fn command_failure(
    process: &str,
    status: &ExitStatus,
    stderr: &str,
    secrets: &[String],
) -> String {
    let (code, signal) = exit_parts(status);
    let lines: Vec<&str> = stderr.lines().collect();
    exit_message(process, code, signal, &lines, secrets)
}

/// The exit code and terminating signal of `status`.
fn exit_parts(status: &ExitStatus) -> (Option<i32>, Option<i32>) {
    #[cfg(unix)]
    {
        use std::os::unix::process::ExitStatusExt;
        (status.code(), status.signal())
    }
    #[cfg(not(unix))]
    {
        (status.code(), None)
    }
}

/// The values to mask: those of `env` (a profile's variables) and of every
/// variable of this process whose name looks like a credential, since a
/// child inherits them. Longest first, so a secret that contains another is
/// masked whole.
pub(crate) fn secret_values<'a>(env: impl IntoIterator<Item = &'a str>) -> Vec<String> {
    let mut secrets: Vec<String> = env
        .into_iter()
        .map(str::to_string)
        .chain(
            std::env::vars()
                .filter(|(key, _)| looks_like_secret_key(key))
                .map(|(_, value)| value),
        )
        .filter(|value| value.chars().count() >= MIN_SECRET_CHARS)
        .collect();
    secrets.sort_by(|left, right| right.len().cmp(&left.len()).then_with(|| left.cmp(right)));
    secrets.dedup();
    secrets
}

/// Whether an env variable's name says it holds a credential.
pub(crate) fn looks_like_secret_key(key: &str) -> bool {
    let upper = key.to_ascii_uppercase();
    ["TOKEN", "KEY", "SECRET", "PASSWORD", "AUTH", "CREDENTIAL"]
        .iter()
        .any(|needle| upper.contains(needle))
}

/// The last non-empty lines of `lines`, joined, within `MAX_EXCERPT_CHARS`
/// (a longer last line keeps its end); `None` when there is nothing to say.
fn excerpt<S: AsRef<str>>(lines: &[S], secrets: &[String]) -> Option<String> {
    let lines: Vec<String> = lines
        .iter()
        .map(|line| mask(strip_terminal_escapes(line.as_ref()).trim(), secrets))
        .filter(|line| !line.is_empty())
        .collect();
    let mut kept: Vec<String> = Vec::new();
    let mut used = 0;
    for line in lines.iter().rev() {
        let separator = if kept.is_empty() {
            0
        } else {
            LINE_SEPARATOR.chars().count()
        };
        let length = line.chars().count();
        if used + separator + length <= MAX_EXCERPT_CHARS {
            kept.push(line.clone());
            used += separator + length;
            continue;
        }
        if kept.is_empty() {
            let end: String = line
                .chars()
                .skip(length - (MAX_EXCERPT_CHARS - 1))
                .collect();
            kept.push(format!("…{end}"));
        }
        break;
    }
    kept.reverse();
    (!kept.is_empty()).then(|| kept.join(LINE_SEPARATOR))
}

fn mask(line: &str, secrets: &[String]) -> String {
    secrets.iter().fold(line.to_string(), |line, secret| {
        line.replace(secret.as_str(), MASK)
    })
}

/// `line` without ANSI escape sequences (colors, cursor moves).
fn strip_terminal_escapes(line: &str) -> String {
    let mut out = String::with_capacity(line.len());
    let mut chars = line.chars().peekable();
    while let Some(char) = chars.next() {
        if char != '\u{1b}' {
            out.push(char);
            continue;
        }
        if chars.peek() == Some(&'[') {
            chars.next();
            // Parameters and intermediates, then one final byte in `@..=~`.
            for next in chars.by_ref() {
                if ('@'..='~').contains(&next) {
                    break;
                }
            }
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn says_how_the_process_ended_and_why() {
        assert_eq!(
            exit_message(
                "Codex app-server",
                Some(1),
                None,
                &["simulated codex failure"],
                &[]
            ),
            "Codex app-server exited with status 1: simulated codex failure"
        );
        assert_eq!(
            exit_message::<&str>("Codex app-server", None, Some(9), &[], &[]),
            "Codex app-server was killed by signal 9"
        );
        assert_eq!(exit_message("x", None, None, &["", "  "], &[]), "x exited");
    }

    #[test]
    fn keeps_the_last_lines_without_escapes() {
        let lines = [
            "\u{1b}[2m2026-11-08T18:00:00Z\u{1b}[0m \u{1b}[31mERROR\u{1b}[0m loading config",
            "",
            "Error: invalid value for `model`",
        ];
        assert_eq!(
            excerpt(&lines, &[]).as_deref(),
            Some("2026-11-08T18:00:00Z ERROR loading config · Error: invalid value for `model`")
        );
    }

    #[test]
    fn stays_within_the_bound_and_keeps_the_end() {
        let older = "a".repeat(200);
        let last = "b".repeat(200);
        assert_eq!(excerpt(&[older.as_str(), last.as_str()], &[]), Some(last));

        let long = format!("{}cause", "x".repeat(1000));
        let excerpt = excerpt(&[long.as_str()], &[]).unwrap();
        assert_eq!(excerpt.chars().count(), MAX_EXCERPT_CHARS);
        assert!(excerpt.starts_with('…') && excerpt.ends_with("cause"));
    }

    #[test]
    fn masks_secrets_before_cutting() {
        let secrets = vec!["sk-live-123456".to_string()];
        let line = format!("{}token sk-live-123456 rejected", "x".repeat(400));
        let excerpt = excerpt(&[line.as_str()], &secrets).unwrap();
        assert!(!excerpt.contains("sk-live"), "{excerpt}");
        assert!(excerpt.ends_with("token ••• rejected"), "{excerpt}");
    }

    #[test]
    fn a_secret_containing_another_is_masked_whole() {
        let secrets = secret_values(["sk-abc123", "sk-abc123456"]);
        assert_eq!(
            excerpt(&["key sk-abc123456 rejected"], &secrets).as_deref(),
            Some("key ••• rejected")
        );
    }

    #[test]
    fn only_long_values_and_credential_names_count_as_secrets() {
        let secrets = secret_values(["https://user:pass@proxy", "eu"]);
        assert!(secrets.contains(&"https://user:pass@proxy".to_string()));
        assert!(!secrets.contains(&"eu".to_string()));
        assert!(looks_like_secret_key("OPENAI_API_KEY"));
        assert!(looks_like_secret_key("github_token"));
        assert!(!looks_like_secret_key("HOME"));
    }
}
