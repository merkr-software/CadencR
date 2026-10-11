use super::*;

pub(super) async fn find_pull(
    transport: &Transport,
    input: &Submission<'_>,
    fork_id: u64,
    sha: &str,
) -> Result<Option<Pull>, AppError> {
    let head = format!("{}:{}", input.preview.account, input.preview.branch);
    let path = format!(
        "/repos/{REGISTRY}/pulls?state=all&head={}&base={}&per_page=2",
        segment(&head),
        segment(&input.preview.base_branch)
    );
    let pulls: Vec<Pull> = transport.get(input.token, &path).await?;
    if pulls.len() > 1 {
        return Err(conflict(
            "PUBLICATION_REGISTRY_PR_CONFLICT",
            "multiple pull requests use the deterministic branch",
        ));
    }
    pulls
        .into_iter()
        .next()
        .map(|pull| verify_pull(pull, input, fork_id, sha))
        .transpose()
}

fn verify_pull(
    pull: Pull,
    input: &Submission<'_>,
    fork_id: u64,
    sha: &str,
) -> Result<Pull, AppError> {
    let body = std::str::from_utf8(input.pull_request_body).map_err(|_| {
        conflict(
            "PUBLICATION_REGISTRY_PLAN_CHANGED",
            "pull request document is not UTF-8",
        )
    })?;
    let title = format!("Add {} {}", input.preview.plugin_id, input.preview.version);
    if pull.state != "open"
        || pull.draft
        || pull.merged_at.is_some()
        || pull.user.id != input.actor_id
        || pull.title != title
        || pull.body.as_deref() != Some(body)
        || pull.head.repo.id != fork_id
        || pull.head.reference != input.preview.branch
        || pull.head.sha != sha
        || pull.base.repo.id != input.repository_id
        || pull.base.reference != input.preview.base_branch
        || pull.base.sha != input.preview.base_commit
    {
        return Err(conflict(
            "PUBLICATION_REGISTRY_PR_CONFLICT",
            "an existing pull request is closed or differs from the reviewed plan",
        ));
    }
    Ok(pull)
}

pub(super) fn validate_pull(
    pull: Pull,
    input: &Submission<'_>,
    fork_id: u64,
    sha: &str,
    reused: bool,
) -> Result<PublicationRegistryResult, AppError> {
    result(
        verify_pull(pull, input, fork_id, sha)?,
        &input.preview.branch,
        reused,
    )
}

pub(super) fn result(
    pull: Pull,
    branch: &str,
    reused: bool,
) -> Result<PublicationRegistryResult, AppError> {
    let expected = format!("https://github.com/{REGISTRY}/pull/{}", pull.number);
    if pull.html_url != expected {
        return Err(conflict(
            "PUBLICATION_REGISTRY_PR_CONFLICT",
            "GitHub returned an invalid pull request URL",
        ));
    }
    Ok(PublicationRegistryResult {
        pull_request_url: pull.html_url,
        pull_request_number: pull.number,
        branch: branch.into(),
        reused,
    })
}

#[cfg(test)]
mod tests {
    use super::super::super::fixture::Expected;
    use super::super::fixture::*;
    use super::segment;
    use serde_json::json;

    #[tokio::test]
    async fn closed_or_foreign_pull_is_never_reused() {
        for mutation in ["closed", "foreign"] {
            let preview = preview();
            let mut candidate = pull();
            if mutation == "closed" {
                candidate["state"] = json!("closed");
            } else {
                candidate["user"]["id"] = json!(404);
            }
            let mut calls = identity();
            calls.push(Expected::get("/repos/alice/cadencr-registry", fork()));
            calls.push(Expected::get(
                format!(
                    "/repos/alice/cadencr-registry/git/ref/heads/{}",
                    segment(&preview.branch)
                ),
                git_ref(&format!("refs/heads/{}", preview.branch), COMMIT),
            ));
            calls.extend(branch_validation());
            calls.push(find_pulls(json!([candidate])));
            assert!(run(calls).await.is_err());
        }
    }
}
