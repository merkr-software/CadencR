use std::path::Path;

use crate::error::AppError;

use super::{failure, run_with_input};

/// Probe a locally available Git object using fixed argv and one stdin record.
/// Unlike rev-parse, this refuses object IDs absent from the object database.
pub async fn git_ref_resolves_readonly(reference: &str, cwd: &Path) -> Result<bool, AppError> {
    validate_reference(reference)?;
    let input = format!("{reference}\n");
    let response = run_with_input()
        .args(&["cat-file", "--batch-check=%(objectname)"])
        .cwd(cwd)
        .stdin(input.as_bytes())
        .call()
        .await?;
    parse_response(reference, &response)
}

fn validate_reference(reference: &str) -> Result<(), AppError> {
    if reference.is_empty()
        || reference.len() > 4096
        || reference.starts_with('-')
        || reference.chars().any(char::is_control)
    {
        return Err(failure("Git reference must be one nonempty record of at most 4096 bytes without controls or a leading '-'"));
    }
    Ok(())
}

fn parse_response(reference: &str, bytes: &[u8]) -> Result<bool, AppError> {
    let response =
        std::str::from_utf8(bytes).map_err(|_| failure("Git reference response is not UTF-8"))?;
    let line = response
        .strip_suffix('\n')
        .filter(|line| !line.contains(['\r', '\n']))
        .ok_or_else(|| failure("Git reference response must contain exactly one line"))?;
    if valid_oid(line) {
        return Ok(true);
    }
    if line.strip_suffix(" submodule").is_some_and(valid_oid) {
        return Ok(false);
    }
    for status in ["missing", "ambiguous"] {
        if line
            .strip_suffix(status)
            .and_then(|value| value.strip_suffix(' '))
            == Some(reference)
        {
            return Ok(false);
        }
    }
    Err(failure("Git reference response is malformed"))
}

fn valid_oid(value: &str) -> bool {
    matches!(value.len(), 40 | 64)
        && value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}

#[cfg(test)]
mod tests {
    use super::super::tests::{git, repository};
    use super::*;

    #[test]
    fn parses_exact_lowercase_object_ids_and_expected_non_resolution() {
        for length in [40, 64] {
            assert!(
                parse_response("HEAD", format!("{}\n", "a".repeat(length)).as_bytes()).unwrap()
            );
            assert!(!parse_response(
                "HEAD:gitlink",
                format!("{} submodule\n", "a".repeat(length)).as_bytes()
            )
            .unwrap());
        }
        for status in ["missing", "ambiguous"] {
            assert!(!parse_response(
                "missing name",
                format!("missing name {status}\n").as_bytes()
            )
            .unwrap());
        }
    }

    #[test]
    fn rejects_malformed_or_multiple_responses() {
        for response in [
            String::new(),
            "a".repeat(40),
            format!("{}\n", "A".repeat(40)),
            format!("{}\n", "g".repeat(40)),
            format!("{}\n\n", "a".repeat(40)),
            format!(" {}\n", "a".repeat(40)),
            "other missing\n".into(),
            "HEAD excluded\n".into(),
            "HEAD missing\r\n".into(),
            format!("{} submodule\n", "A".repeat(40)),
            "HEAD submodule\n".into(),
        ] {
            assert!(
                parse_response("HEAD", response.as_bytes()).is_err(),
                "{response:?}"
            );
        }
        assert!(parse_response("HEAD", &[0xff, b'\n']).is_err());
    }

    #[tokio::test]
    async fn rejects_injection_and_oversized_records_before_spawning() {
        let root = tempfile::tempdir().unwrap();
        let nonexistent = root.path().join("no-repository");
        for reference in [
            "",
            "--help",
            "-C/tmp",
            "HEAD\nHEAD",
            "HEAD\r",
            "HEAD\t",
            "HEAD\0",
            "HEAD\u{7f}",
        ] {
            let error = git_ref_resolves_readonly(reference, &nonexistent)
                .await
                .unwrap_err();
            assert!(error.to_string().contains("Git reference must"), "{error}");
        }
        assert!(git_ref_resolves_readonly(&"a".repeat(4097), &nonexistent)
            .await
            .unwrap_err()
            .to_string()
            .contains("Git reference must"));
        assert!(validate_reference(&"a".repeat(4096)).is_ok());
    }

    #[tokio::test]
    async fn resolves_local_remote_and_revision_expressions_without_mutation() {
        let repo = repository();
        git(repo.path(), &["update-ref", "refs/heads/topic", "HEAD"]);
        git(
            repo.path(),
            &["update-ref", "refs/remotes/origin/remote-only", "HEAD"],
        );
        for reference in [
            "HEAD",
            "HEAD^{commit}",
            "HEAD^{tree}",
            "HEAD:tracked",
            "topic",
            "origin/remote-only",
        ] {
            assert!(
                git_ref_resolves_readonly(reference, repo.path())
                    .await
                    .unwrap(),
                "{reference}"
            );
        }
        assert!(!git_ref_resolves_readonly("missing", repo.path())
            .await
            .unwrap());
        assert!(!git_ref_resolves_readonly(&"a".repeat(40), repo.path())
            .await
            .unwrap());
        assert_eq!(
            super::super::run_git_readonly_bounded(&["status", "--porcelain"], repo.path())
                .await
                .unwrap(),
            ""
        );
    }

    #[tokio::test]
    async fn reports_repository_failure_instead_of_non_resolution() {
        let root = tempfile::tempdir().unwrap();
        assert!(git_ref_resolves_readonly("HEAD", root.path())
            .await
            .is_err());
    }

    #[tokio::test]
    async fn a_gitlink_with_an_absent_object_does_not_resolve() {
        let repo = repository();
        let absent = "1111111111111111111111111111111111111111";
        git(
            repo.path(),
            &[
                "update-index",
                "--add",
                "--cacheinfo",
                "160000",
                absent,
                "gitlink",
            ],
        );
        git(
            repo.path(),
            &[
                "-c",
                "user.name=Test",
                "-c",
                "user.email=test@example.com",
                "-c",
                "commit.gpgSign=false",
                "commit",
                "-qm",
                "gitlink",
            ],
        );
        assert!(!git_ref_resolves_readonly("HEAD:gitlink", repo.path())
            .await
            .unwrap());
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn probing_a_missing_promised_object_does_not_invoke_transport() {
        let repo = repository();
        let marker = repo.path().join("transport-invoked");
        let remote = format!("ext::sh -c touch% {}", marker.display());
        for args in [
            &["config", "core.repositoryformatversion", "1"][..],
            &["config", "extensions.partialClone", "origin"],
            &["config", "remote.origin.promisor", "true"],
            &["config", "remote.origin.url", &remote],
            &["config", "protocol.ext.allow", "always"],
        ] {
            git(repo.path(), args);
        }
        std::fs::write(
            repo.path().join(".git/refs/heads/missing-object"),
            "1111111111111111111111111111111111111111\n",
        )
        .unwrap();
        assert!(!git_ref_resolves_readonly("missing-object", repo.path())
            .await
            .unwrap());
        assert!(
            !marker.exists(),
            "a read-only probe invoked the promisor transport"
        );
        let transport = std::process::Command::new("git")
            .args(["fetch", "origin"])
            .env("GIT_ALLOW_PROTOCOL", "ext")
            .current_dir(repo.path())
            .output()
            .unwrap();
        assert!(!transport.status.success());
        assert!(marker.exists(), "the marker transport fixture never ran");
    }
}
