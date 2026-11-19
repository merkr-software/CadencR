//! `commands` and `backend`: what a tab may run beyond its page.
//!
//! A command is a program Cadencr runs for the tab, without a shell, in the
//! conversation's folder. Listing one names *which* program, not what it does
//! with its arguments, and the tab chooses those: most everyday programs can
//! run arbitrary code from them (`git -c alias.x='!sh …' x`, `find -exec`,
//! `awk 'BEGIN{system(…)}'`, `ssh -o ProxyCommand`, `tar --to-command`,
//! `rsync -e`, `make -f`). A tab that runs commands is therefore as trusted as
//! native code, and consent to it requires the same explicit trust. The
//! general-purpose launchers (shells, interpreters, package runners, privilege
//! tools) are still refused, only so that a manifest cannot hide "runs
//! anything" behind an honest-looking list — not as a sandbox. A backend is a
//! native executable the tab ships for each platform it supports and Cadencr
//! starts; it runs with the user's rights and is not limited here beyond where
//! its files are.

use std::collections::BTreeSet;

use super::issues::{TabFindings, TabIssueCode as Code};
use super::manifest::{TabBackend, TabCommand};
use super::platform::TabPlatform;
use super::validate::{is_clean_relative_path, text_within};
use super::SUPPORTED_BACKEND_PROTOCOLS;

pub const MAX_COMMANDS: usize = 16;
pub const MAX_REASONING_CHARS: usize = 280;
const MAX_PROGRAM_CHARS: usize = 64;

/// Programs whose purpose is to run whatever they are handed. Compared
/// case-insensitively, without a Windows executable suffix, and without a
/// version suffix too (`python3.12`, `node18`, `php-8.2` are their
/// interpreters). Refusing them keeps the listed programs honest; it does not
/// confine the others (see the module docs).
pub const DENIED_PROGRAMS: &[&str] = &[
    // shells
    "sh",
    "bash",
    "zsh",
    "fish",
    "dash",
    "ksh",
    "csh",
    "tcsh",
    "ash",
    "nu",
    "pwsh",
    "powershell",
    "cmd",
    "wscript",
    "cscript",
    "mshta",
    "wsl",
    "osascript",
    // interpreters and runtimes
    "node",
    "nodejs",
    "deno",
    "bun",
    "python",
    "python2",
    "python3",
    "py",
    "pyw",
    "pythonw",
    "pypy",
    "pypy3",
    "ruby",
    "rubyw",
    "irb",
    "perl",
    "wperl",
    "php",
    "lua",
    "luajit",
    "java",
    "jshell",
    "tclsh",
    "wish",
    "rscript",
    "julia",
    "dotnet",
    // package runners
    "npx",
    "npm",
    "pnpm",
    "yarn",
    "bunx",
    "corepack",
    "uv",
    "uvx",
    "pipx",
    "pip",
    "pip3",
    // launchers and privilege tools
    "env",
    "sudo",
    "doas",
    "su",
    "runas",
    "xargs",
    "nohup",
    "nice",
    "timeout",
    "time",
    "watch",
    "exec",
    "open",
    "start",
    "launchctl",
    "rundll32",
    "regsvr32",
    "systemd-run",
    "script",
    // Linux launchers, sandbox escapes, and scheduling wrappers
    "xdg-open",
    "gio",
    "setsid",
    "pkexec",
    "busybox",
    "flatpak-spawn",
    "nsenter",
    "unshare",
    "chroot",
    "firejail",
    "stdbuf",
    "ionice",
    "taskset",
    "chrt",
    "flock",
];

/// `^[A-Za-z0-9][A-Za-z0-9._+-]{0,63}$`: a file name, never a path.
pub fn is_valid_program_name(program: &str) -> bool {
    let bytes = program.as_bytes();
    let allowed =
        |byte: &u8| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'_' | b'+' | b'-');
    !bytes.is_empty()
        && bytes.len() <= MAX_PROGRAM_CHARS
        && bytes[0].is_ascii_alphanumeric()
        && bytes.iter().all(allowed)
}

/// Whether `program` is a general-purpose launcher a tab may never list.
pub fn is_denied_program(program: &str) -> bool {
    let lower = program.to_ascii_lowercase();
    let stem = [".exe", ".cmd", ".bat", ".com", ".ps1"]
        .iter()
        .find_map(|suffix| lower.strip_suffix(suffix))
        .unwrap_or(&lower);
    let unversioned =
        stem.trim_end_matches(|c: char| c.is_ascii_digit() || matches!(c, '.' | '-' | '_'));
    DENIED_PROGRAMS.contains(&stem) || DENIED_PROGRAMS.contains(&unversioned)
}

pub(super) fn validate_commands(commands: &[TabCommand], findings: &mut TabFindings) {
    if commands.len() > MAX_COMMANDS {
        findings.error(
            Code::CommandsTooMany,
            "commands",
            format!("at most {MAX_COMMANDS} commands"),
        );
    }
    let mut seen = BTreeSet::new();
    for (index, command) in commands.iter().enumerate() {
        let field = format!("commands[{index}]");
        let program = command.program.as_str();
        if !is_valid_program_name(program) {
            findings.error(
                Code::CommandInvalid,
                format!("{field}.program"),
                "must be a bare program name such as `git`, without a path or arguments",
            );
        } else if is_denied_program(program) {
            findings.error(
                Code::CommandNotAllowed,
                format!("{field}.program"),
                format!("`{program}` runs arbitrary code; a tab that needs it must ship a backend"),
            );
        } else if !seen.insert(program.to_ascii_lowercase()) {
            findings.error(
                Code::CommandDuplicate,
                format!("{field}.program"),
                format!("`{program}` is listed twice"),
            );
        }
        if !reasoning_ok(command.reasoning.as_deref()) {
            findings.error(
                Code::CommandReasoningRequired,
                format!("{field}.reasoning"),
                format!("explain in 1–{MAX_REASONING_CHARS} characters why the tab runs it; it is shown at consent time"),
            );
        }
    }
}

pub(super) fn validate_backend(backend: &TabBackend, findings: &mut TabFindings) {
    if !SUPPORTED_BACKEND_PROTOCOLS.contains(&backend.protocol) {
        findings.error(
            Code::BackendProtocolUnsupported,
            "backend.protocol",
            format!(
                "this Cadencr speaks backend protocol {}; got {}",
                supported_backend_protocols(),
                backend.protocol
            ),
        );
    }
    if backend.binary.is_empty() {
        findings.error(
            Code::BackendBinaryRequired,
            "backend.binary",
            format!(
                "declare at least one native executable, keyed by platform ({})",
                TabPlatform::list()
            ),
        );
    }
    for (key, path) in &backend.binary {
        let field = format!("backend.binary.{key}");
        if TabPlatform::parse(key).is_none() {
            findings.error(
                Code::BackendPlatformUnknown,
                field.as_str(),
                format!(
                    "`{key}` is not a supported platform; use {} (Windows is not supported yet)",
                    TabPlatform::list()
                ),
            );
        }
        if !is_clean_relative_path(path) {
            findings.error(
                Code::PathInvalid,
                field,
                "must be a normalized relative path inside the tab folder, without `..`, `.`, backslashes or a leading `/`",
            );
        }
    }
    if !reasoning_ok(backend.reasoning.as_deref()) {
        findings.error(
            Code::BackendReasoningRequired,
            "backend.reasoning",
            format!("explain in 1–{MAX_REASONING_CHARS} characters what the backend does; it is shown at consent time"),
        );
    }
}

/// `1`, or `1, 2`: the protocol versions this host speaks, for messages.
pub fn supported_backend_protocols() -> String {
    SUPPORTED_BACKEND_PROTOCOLS
        .iter()
        .map(u32::to_string)
        .collect::<Vec<_>>()
        .join(", ")
}

/// A consent-time reasoning: 1–[`MAX_REASONING_CHARS`] characters of text
/// once trimmed, without NUL.
pub fn reasoning_ok(reasoning: Option<&str>) -> bool {
    reasoning.is_some_and(|text| text_within(text, MAX_REASONING_CHARS) && !text.contains('\0'))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::tab::test_support::codes;

    fn command(program: &str, reasoning: Option<&str>) -> TabCommand {
        TabCommand {
            program: program.into(),
            reasoning: reasoning.map(str::to_string),
        }
    }

    fn check_commands(commands: &[TabCommand]) -> TabFindings {
        let mut findings = TabFindings::default();
        validate_commands(commands, &mut findings);
        findings
    }

    fn check_backend(
        protocol: u32,
        binary: &[(&str, &str)],
        reasoning: Option<&str>,
    ) -> TabFindings {
        let mut findings = TabFindings::default();
        validate_backend(
            &TabBackend {
                protocol,
                binary: binary
                    .iter()
                    .map(|(key, path)| (key.to_string(), path.to_string()))
                    .collect(),
                reasoning: reasoning.map(str::to_string),
            },
            &mut findings,
        );
        findings
    }

    #[test]
    fn reasoning_is_bounded_text_without_nul() {
        assert!(reasoning_ok(Some("Lists ports.")));
        assert!(reasoning_ok(Some(&"x".repeat(MAX_REASONING_CHARS))));
        for refused in [None, Some(" "), Some("a\0b")] {
            assert!(!reasoning_ok(refused), "{refused:?}");
        }
        assert!(!reasoning_ok(Some(&"x".repeat(MAX_REASONING_CHARS + 1))));
    }

    #[test]
    fn plain_tools_with_reasoning_are_valid() {
        let findings = check_commands(&[
            command("git", Some("history")),
            command("kubectl", Some("pods")),
            command("clang-format", Some("format")),
            command("g++", Some("compile")),
        ]);
        assert!(findings.is_valid(), "{findings:?}");
    }

    #[test]
    fn launchers_are_refused_whatever_their_spelling() {
        for program in [
            "bash",
            "Node",
            "python3",
            "npx",
            "PowerShell.exe",
            "cmd.EXE",
            "sudo",
        ] {
            assert_eq!(
                codes(&check_commands(&[command(program, Some("r"))]).errors),
                ["COMMAND_NOT_ALLOWED"],
                "{program}"
            );
        }
        for versioned in [
            "python3.12",
            "node18",
            "ruby3.2",
            "perl5.36",
            "php-8.2",
            "lua5.4",
            "Python3.11.EXE",
        ] {
            assert!(is_denied_program(versioned), "{versioned}");
        }
        for windows in ["pythonw.exe", "wscript", "mshta.exe", "rundll32.EXE"] {
            assert!(is_denied_program(windows), "{windows}");
        }
        for linux in [
            "xdg-open",
            "pkexec",
            "flatpak-spawn",
            "nsenter",
            "BusyBox",
            "setsid",
        ] {
            assert!(is_denied_program(linux), "{linux}");
        }
        assert!(!is_denied_program("gitk"));
        assert!(!is_denied_program("nodemon-free"));
    }

    #[test]
    fn programs_are_bare_names_and_unique() {
        for program in [
            "",
            "/usr/bin/git",
            "bin/git",
            "git status",
            "-rf",
            "..",
            "git;rm",
        ] {
            assert_eq!(
                codes(&check_commands(&[command(program, Some("r"))]).errors),
                ["COMMAND_INVALID"],
                "{program:?}"
            );
        }
        let duplicate = check_commands(&[command("git", Some("a")), command("GIT", Some("b"))]);
        assert_eq!(codes(&duplicate.errors), ["COMMAND_DUPLICATE"]);
        let unexplained = check_commands(&[command("git", None), command("jq", Some(" "))]);
        assert_eq!(
            codes(&unexplained.errors),
            ["COMMAND_REASONING_REQUIRED", "COMMAND_REASONING_REQUIRED"]
        );
        let many: Vec<TabCommand> = (0..17)
            .map(|n| command(&format!("t{n}"), Some("r")))
            .collect();
        assert_eq!(codes(&check_commands(&many).errors), ["COMMANDS_TOO_MANY"]);
    }

    #[test]
    fn v2_native_backends_are_accepted() {
        let findings = check_backend(
            2,
            &[("linux-x86_64", "bin/linux-x86_64/backend")],
            Some("Publishes realtime updates."),
        );
        assert!(findings.is_valid(), "{findings:?}");
    }

    #[test]
    fn backends_name_a_native_binary_per_known_platform() {
        let all = [
            ("darwin-aarch64", "bin/darwin-aarch64/backend"),
            ("darwin-x86_64", "bin/darwin-x86_64/backend"),
            ("linux-x86_64", "bin/linux-x86_64/backend"),
        ];
        assert!(check_backend(1, &all, Some("r")).is_valid());
        assert!(check_backend(1, &all[2..], Some("r")).is_valid());
        let unsupported = check_backend(3, &all, Some("r"));
        assert_eq!(codes(&unsupported.errors), ["BACKEND_PROTOCOL_UNSUPPORTED"]);
        assert!(unsupported.errors[0]
            .message
            .contains("protocol 1, 2; got 3"));
        assert_eq!(
            codes(&check_backend(1, &[], None).errors),
            ["BACKEND_BINARY_REQUIRED", "BACKEND_REASONING_REQUIRED"]
        );
        let windows = check_backend(1, &[("windows-x86_64", "bin/b.exe")], Some("r"));
        assert_eq!(codes(&windows.errors), ["BACKEND_PLATFORM_UNKNOWN"]);
        assert_eq!(
            windows.errors[0].field.as_deref(),
            Some("backend.binary.windows-x86_64")
        );
        for path in [
            "../escape",
            "/usr/bin/node",
            "bin\\x.exe",
            "C:/x",
            "",
            "bin/",
        ] {
            assert_eq!(
                codes(&check_backend(1, &[("linux-x86_64", path)], Some("r")).errors),
                ["PATH_INVALID"],
                "{path:?}"
            );
        }
    }
}
