use crate::{operation_error, Diagnostic};
use serde_json::json;
use std::path::Path;

pub(crate) fn run(
    request: &Path,
    directory: &Path,
    confirmation: Option<&str>,
) -> Result<Option<String>, Diagnostic> {
    let runtime = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .map_err(|_| {
            operation_error(
                "AUTHOR_RELEASE_FAILED",
                "could not initialize author release runtime",
            )
        })?;
    runtime.block_on(execute(request, directory, confirmation))
}

async fn execute(
    request: &Path,
    directory: &Path,
    confirmation: Option<&str>,
) -> Result<Option<String>, Diagnostic> {
    const CODE: &str = "AUTHOR_RELEASE_FAILED";
    let prepared =
        cadencr_registry_publisher::author_release::prepare_author_release(request, directory)
            .await
            .map_err(|_| operation_error(CODE, "author release local validation failed"))?;
    let receipt = if let Some(confirmation) = confirmation {
        prepared
            .confirm(confirmation)
            .map_err(|_| operation_error(CODE, "request SHA-256 confirmation does not match"))?;
        prepared
            .revalidate()
            .await
            .map_err(|_| operation_error(CODE, "author release assets changed"))?;
        // All local checks and exact-byte confirmation precede access to secrets.
        let token = std::env::var("CADENCR_AUTHOR_GITHUB_TOKEN")
            .ok()
            .filter(|token| !token.trim().is_empty())
            .ok_or_else(|| operation_error(CODE, "CADENCR_AUTHOR_GITHUB_TOKEN is required"))?;
        let published = prepared
            .publish(&token)
            .await
            .map_err(|error| remote_error(error, &token))?;
        json!({"ok":true,"request_sha256":prepared.request_sha256(),
            "release_url":published.release_url,"already_published":published.already_published})
    } else {
        json!({"ok":true,"local_only":true,"request_sha256":prepared.request_sha256(),"request":prepared.request()})
    };
    let bytes = format!("{receipt}\n");
    crate::output::write_stdout(bytes.as_bytes(), &mut std::io::stdout().lock())?;
    Ok(None)
}

fn remote_error(
    error: cadencr_registry_publisher::author_release::Error,
    token: &str,
) -> Diagnostic {
    use cadencr_registry_publisher::author_release::Error;
    let (code, message) = match error {
        Error::Coded { code, message, .. } => (code, message),
        Error::BadRequest(message) => ("AUTHOR_RELEASE_REJECTED", message),
        Error::Internal(_) => (
            "AUTHOR_RELEASE_FAILED",
            "author release internal failure; review the remote draft before retrying".into(),
        ),
    };
    let message = if token.is_empty() {
        message
    } else {
        message.replace(token, "[redacted]")
    };
    operation_error(code, message)
}

#[cfg(test)]
mod tests {
    use super::*;
    use clap::Parser as _;
    #[test]
    fn remote_diagnostics_preserve_actionable_messages_without_secrets_or_internal_paths() {
        use cadencr_registry_publisher::author_release::Error;
        let error = remote_error(
            Error::BadRequest("GitHub rejected secret-token permission".into()),
            "secret-token",
        );
        assert_eq!(error.code, "AUTHOR_RELEASE_REJECTED");
        assert!(error.message.contains("GitHub rejected"));
        assert!(!error.message.contains("secret-token"));
        let conflict = remote_error(
            Error::Coded {
                status: "409".parse().unwrap(),
                code: "PUBLICATION_RELEASE_CONFLICT",
                message: "GitHub release tag changed".into(),
            },
            "secret-token",
        );
        assert_eq!(conflict.code, "PUBLICATION_RELEASE_CONFLICT");
        assert_eq!(conflict.message, "GitHub release tag changed");
        let error = remote_error(
            Error::Internal("/private/local secret-token".into()),
            "secret-token",
        );
        assert!(!error.message.contains("/private/local"));
        assert!(!error.message.contains("secret-token"));
    }
    #[test]
    fn author_commands_require_explicit_inputs_and_confirmation() {
        assert!(crate::args::Cli::try_parse_from([
            "cadencr",
            "plugin",
            "inspect-release",
            "--request",
            "r",
            "--directory",
            "d"
        ])
        .is_ok());
        assert!(crate::args::Cli::try_parse_from([
            "cadencr",
            "plugin",
            "publish-release",
            "--request",
            "r",
            "--directory",
            "d"
        ])
        .is_err());
        assert!(crate::args::Cli::try_parse_from([
            "cadencr",
            "plugin",
            "publish-release",
            "--request",
            "r",
            "--directory",
            "d",
            "--confirm-request-sha256",
            "abc"
        ])
        .is_ok());
    }
    #[test]
    fn valid_local_request_requires_confirmation_before_token() {
        use sha2::{Digest as _, Sha256};
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().canonicalize().unwrap();
        let bytes = b"archive";
        std::fs::write(root.join("archive"), bytes).unwrap();
        std::fs::write(root.join("metadata"), bytes).unwrap();
        let sha: String = Sha256::digest(bytes)
            .iter()
            .map(|b| format!("{b:02x}"))
            .collect();
        let request = root.join("request.json");
        let value = json!({"schema_version":1,"repository":"acme/provider",
            "expected_repository_id":42,"expected_account":"author","tag":"v1",
            "source_commit":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
            "release_notes":"notes","prerelease":false,
            "archive":{"name":"archive","size":7,"sha256":sha},
            "metadata":{"name":"metadata","size":7,"sha256":sha}});
        std::fs::write(&request, serde_json::to_vec(&value).unwrap()).unwrap();
        let error = run(&request, &root, Some("bad")).unwrap_err();
        assert_eq!(error.message, "request SHA-256 confirmation does not match");
    }
    #[test]
    fn invalid_local_input_fails_before_credential_lookup() {
        let temp = tempfile::tempdir().unwrap();
        let error = run(&temp.path().join("missing"), temp.path(), Some("bad")).unwrap_err();
        assert_eq!(error.message, "author release local validation failed");
    }
}
