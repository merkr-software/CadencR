//! Resolve the user's configured login shell for env hydration.
//!
//! The account database is the source of truth, not whatever `$SHELL` the GUI
//! launcher handed this process: `capture_login_shell_env` runs
//! `<shell> -ilc '…'`, so a wrong `$SHELL` would just re-run the wrong shell.
//! macOS reads Directory Services (`dscl`, what Terminal.app uses); Linux and
//! other Unixes read the passwd entry (`getpwuid_r`, what login(1) uses).

/// The user's login shell: account database first, then `$SHELL`, then the
/// platform default.
pub async fn resolve_login_shell() -> String {
    if let Some(shell) = account_login_shell().await {
        return shell;
    }
    match std::env::var("SHELL") {
        Ok(shell) if !shell.is_empty() => shell,
        _ => {
            let fallback = default_login_shell();
            tracing::warn!(
                "{} lookup failed and $SHELL is not set; falling back to {fallback} for env hydration",
                account_source()
            );
            fallback.to_string()
        }
    }
}

async fn account_login_shell() -> Option<String> {
    if cfg!(target_os = "macos") {
        dscl_login_shell().await
    } else {
        passwd_login_shell()
    }
}

fn account_source() -> &'static str {
    if cfg!(target_os = "macos") {
        "dscl"
    } else {
        "passwd"
    }
}

async fn dscl_login_shell() -> Option<String> {
    let user = std::env::var("USER").ok().filter(|s| !s.is_empty())?;
    let output = tokio::process::Command::new("dscl")
        .args([".", "-read", &format!("/Users/{user}"), "UserShell"])
        .output()
        .await
        .ok()?;
    if !output.status.success() {
        return None;
    }
    parse_dscl_usershell_output(&String::from_utf8_lossy(&output.stdout))
}

/// Parses `dscl`'s `UserShell: /opt/homebrew/bin/fish\n` output.
fn parse_dscl_usershell_output(text: &str) -> Option<String> {
    non_empty(text.strip_prefix("UserShell:")?)
}

/// `pw_shell` of the effective user's passwd entry (covers NSS sources such as
/// LDAP/SSSD, unlike parsing `/etc/passwd`).
#[cfg(unix)]
fn passwd_login_shell() -> Option<String> {
    use std::ffi::CStr;

    let mut buf = vec![0u8; 4096];
    loop {
        // SAFETY: `passwd` is plain old data; zeroed is a valid initial value.
        let mut pwd: libc::passwd = unsafe { std::mem::zeroed() };
        let mut result: *mut libc::passwd = std::ptr::null_mut();
        // SAFETY: every pointer refers to live, correctly sized storage owned
        // by this frame; `getpwuid_r` writes only within `buf`.
        let rc = unsafe {
            libc::getpwuid_r(
                libc::geteuid(),
                &mut pwd,
                buf.as_mut_ptr().cast(),
                buf.len(),
                &mut result,
            )
        };
        if rc == libc::ERANGE && buf.len() < 1 << 20 {
            buf.resize(buf.len() * 2, 0);
            continue;
        }
        if rc != 0 || result.is_null() || pwd.pw_shell.is_null() {
            return None;
        }
        // SAFETY: on success `pw_shell` points at a NUL-terminated string
        // inside `buf`, which outlives this borrow.
        let shell = unsafe { CStr::from_ptr(pwd.pw_shell) };
        return non_empty(&shell.to_string_lossy());
    }
}

#[cfg(not(unix))]
fn passwd_login_shell() -> Option<String> {
    None
}

fn non_empty(text: &str) -> Option<String> {
    let trimmed = text.trim();
    (!trimmed.is_empty()).then(|| trimmed.to_string())
}

fn default_login_shell() -> &'static str {
    if cfg!(target_os = "macos") {
        "/bin/zsh"
    } else {
        "/bin/bash"
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_dscl_usershell_output() {
        assert_eq!(
            parse_dscl_usershell_output("UserShell: /opt/homebrew/bin/fish\n"),
            Some("/opt/homebrew/bin/fish".to_string())
        );
    }

    #[test]
    fn rejects_malformed_or_empty_dscl_output() {
        assert_eq!(parse_dscl_usershell_output(""), None);
        assert_eq!(parse_dscl_usershell_output("no such record"), None);
        assert_eq!(parse_dscl_usershell_output("UserShell: \n"), None);
    }

    /// The Linux lookup is plain POSIX, so it runs (and is checked) on macOS
    /// too: the current user always has a passwd entry with an absolute shell.
    #[cfg(unix)]
    #[test]
    fn passwd_lookup_returns_an_absolute_shell() {
        let shell = passwd_login_shell().expect("current user has a passwd entry");
        // No value in the message: CodeQL reads passwd-derived strings as secrets.
        assert!(shell.starts_with('/'));
    }

    #[test]
    fn platform_specific_sources_and_defaults() {
        if cfg!(target_os = "macos") {
            assert_eq!(account_source(), "dscl");
            assert_eq!(default_login_shell(), "/bin/zsh");
        } else {
            assert_eq!(account_source(), "passwd");
            assert_eq!(default_login_shell(), "/bin/bash");
        }
    }
}
