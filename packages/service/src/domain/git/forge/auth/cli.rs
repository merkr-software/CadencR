//! CLI credential discovery. Process output is secret even on failure.
use super::ForgeError;
use cli_discovery::{discover_all, select_best, DiscoverySpec};
use std::path::PathBuf;
use tokio::sync::OnceCell;

pub(super) async fn cli_output(
    binary: &'static str,
    args: &[&str],
) -> Result<std::process::Output, ForgeError> {
    let path = discover_forge_cli(binary).await?;
    let output = tokio::process::Command::new(&path)
        .args(args)
        .env("NO_COLOR", "1")
        .output()
        .await
        .map_err(|error| {
            ForgeError::Configuration(format!(
                "Could not run {binary} for forge authentication: {error}"
            ))
        })?;
    if !output.status.success() {
        return Err(authentication_failure(binary, &output));
    }
    Ok(output)
}

fn authentication_failure(binary: &str, output: &std::process::Output) -> ForgeError {
    // Authentication commands may print access tokens to either stream,
    // including on failure. Only the exit status is safe to expose or log.
    ForgeError::Authentication(format!(
        "{binary} did not return an authenticated token (exit {}). Run {binary} auth login and try again.",
        output.status
    ))
}

pub(super) fn stdout_token(
    binary: &str,
    output: &std::process::Output,
) -> Result<String, ForgeError> {
    std::str::from_utf8(&output.stdout)
        .map(|value| value.trim().to_string())
        .map_err(|_| ForgeError::Authentication(format!("{binary} returned a non-UTF-8 token")))
}

static GH_CLI_PATH: OnceCell<PathBuf> = OnceCell::const_new();
static GLAB_CLI_PATH: OnceCell<PathBuf> = OnceCell::const_new();

async fn discover_forge_cli(binary: &'static str) -> Result<PathBuf, ForgeError> {
    let cache = match binary {
        "gh" => &GH_CLI_PATH,
        "glab" => &GLAB_CLI_PATH,
        _ => {
            return Err(ForgeError::Configuration(format!(
                "Unsupported forge CLI: {binary}"
            )))
        }
    };
    let discovered = cache
        .get_or_try_init(|| async move {
            let spec = DiscoverySpec {
                bin_name: binary.to_string(),
                well_known_relative_to_home: vec![".local/bin".into()],
                well_known_absolute: vec![
                    "/opt/homebrew/bin".into(),
                    "/usr/local/bin".into(),
                    "/usr/bin".into(),
                ],
                version_args: vec!["--version".into()],
                version_must_contain: Some(binary.to_string()),
            };
            let candidates = discover_all(&spec, None).await;
            select_best(&candidates).map(|candidate| candidate.path.clone())
                .ok_or_else(|| {
                    ForgeError::Configuration(format!(
                        "Could not find the {binary} CLI in PATH, the login-shell PATH, or common install directories"
                    ))
                })
        })
        .await?;
    Ok(discovered.clone())
}

fn parse_glab_token(output: &str) -> Option<String> {
    output.lines().find_map(|line| {
        let line = line.trim();
        let lowercase = line.to_ascii_lowercase();
        let marker = ["token found:", "token:"]
            .into_iter()
            .find(|marker| lowercase.contains(marker))?;
        let marker_start = lowercase.find(marker)?;
        let value = &line[marker_start + marker.len()..];
        let token = value.trim().trim_matches('\'').trim_matches('"');
        (!token.is_empty()).then(|| token.to_string())
    })
}

pub(super) fn parse_glab_token_output(output: &std::process::Output) -> Option<String> {
    parse_glab_token_streams(&output.stdout, &output.stderr)
}

// `glab auth status` renders its successful human-readable report to stderr,
// while older releases used stdout and labeled the value `Token:` rather than
// `Token found:`. Accept both streams so CLI reuse survives that format change.
fn parse_glab_token_streams(stdout: &[u8], stderr: &[u8]) -> Option<String> {
    [stdout, stderr]
        .into_iter()
        .filter_map(|stream| std::str::from_utf8(stream).ok())
        .find_map(parse_glab_token)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[cfg(unix)]
    #[test]
    fn authentication_errors_never_include_cli_streams() {
        use std::os::unix::process::ExitStatusExt;
        let output = std::process::Output {
            status: std::process::ExitStatus::from_raw(256),
            stdout: b"ghp-stdout-secret".to_vec(),
            stderr: b"glpat-stderr-secret".to_vec(),
        };
        let error = authentication_failure("glab", &output).to_string();
        assert!(!error.contains("secret"));
        assert!(error.contains("glab auth login"));
    }

    #[test]
    fn parses_glab_status_token() {
        assert_eq!(
            parse_glab_token("✓ Logged in\n  Token: glpat-example\n").as_deref(),
            Some("glpat-example")
        );
    }

    #[test]
    fn parses_current_glab_status_token_from_stderr() {
        assert_eq!(
            parse_glab_token_streams(
                b"",
                b"gitlab.example.com\n  \xe2\x9c\x93 Token found: glpat-current\n"
            )
            .as_deref(),
            Some("glpat-current")
        );
    }
}
