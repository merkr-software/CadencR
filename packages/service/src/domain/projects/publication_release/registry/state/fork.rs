use super::*;

pub(super) async fn ensure_fork(
    transport: &Transport,
    input: &Submission<'_>,
) -> Result<Repository, AppError> {
    let path = format!(
        "/repos/{}/cadencr-registry",
        segment(&input.preview.account)
    );
    if let Some(repo) = transport.get_optional(input.token, &path).await? {
        return validate_fork(repo, input);
    }
    let create_error = transport
        .post::<_, Repository>(
            input.token,
            &format!("/repos/{REGISTRY}/forks"),
            &CreateFork {
                default_branch_only: true,
            },
        )
        .await
        .err();
    for _ in 0..6 {
        if let Some(repo) = transport.get_optional(input.token, &path).await? {
            return validate_fork(repo, input);
        }
        tokio::time::sleep(std::time::Duration::from_millis(500)).await;
    }
    if let Some(error) = create_error {
        if !matches!(&error, AppError::Coded { code, .. } if *code == "PUBLICATION_REGISTRY_REMOTE_CONFLICT")
        {
            return Err(error);
        }
    }
    Err(AppError::coded(
        axum::http::StatusCode::SERVICE_UNAVAILABLE,
        "PUBLICATION_REGISTRY_FORK_PENDING",
        "GitHub fork is still being created; retry after inspecting it",
    ))
}

fn validate_fork(repo: Repository, input: &Submission<'_>) -> Result<Repository, AppError> {
    let expected_name = format!("{}/cadencr-registry", input.preview.account);
    if !repo.fork
        || repo.private
        || repo.archived
        || repo.id == input.repository_id
        || repo.full_name != expected_name
        || repo.owner.login != input.preview.account
        || repo.owner.id != input.actor_id
        || repo.parent.as_ref().map(|parent| parent.id) != Some(input.repository_id)
    {
        return Err(conflict(
            "PUBLICATION_REGISTRY_FORK_CONFLICT",
            "the personal cadencr-registry repository is not the expected owned fork",
        ));
    }
    Ok(repo)
}

#[cfg(test)]
mod tests {
    use super::super::super::fixture::Expected;
    use super::super::fixture::*;
    use serde_json::json;

    #[tokio::test]
    async fn rejects_foreign_fork_before_any_branch_write() {
        let mut foreign = fork();
        foreign["parent"]["id"] = json!(999);
        let mut calls = identity();
        calls.push(Expected::get("/repos/alice/cadencr-registry", foreign));
        assert!(run(calls).await.is_err());
    }

    #[tokio::test]
    async fn an_already_pending_fork_is_polled_without_any_branch_write() {
        let mut calls = identity();
        calls.push(Expected::missing("/repos/alice/cadencr-registry"));
        calls.push(Expected::conflicting_post(
            "/repos/merkr-software/cadencr-registry/forks",
            json!({"default_branch_only":true}),
        ));
        for _ in 0..6 {
            calls.push(Expected::missing("/repos/alice/cadencr-registry"));
        }
        let error = run(calls).await.unwrap_err();
        assert!(error.to_string().contains("still being created"));
    }
}
