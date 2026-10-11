use super::*;

pub(in super::super) async fn inspect(
    transport: &Transport,
    token: &str,
    documents: &Documents,
) -> Result<Inspection, AppError> {
    let actor: User = transport.get(token, "/user").await?;
    validate_login(&actor.login)?;
    if actor.login.eq_ignore_ascii_case("merkr-software") {
        return Err(conflict(
            "PUBLICATION_REGISTRY_DIRECT_WRITE_REFUSED",
            "the registry owner account cannot use fork automation",
        ));
    }
    let repository: Repository = transport.get(token, &format!("/repos/{REGISTRY}")).await?;
    validate_registry(&repository)?;
    let reference: GitRef = transport
        .get(
            token,
            &format!(
                "/repos/{REGISTRY}/git/ref/heads/{}",
                segment(&repository.default_branch)
            ),
        )
        .await?;
    validate_base_ref(&reference, &repository.default_branch)?;
    let base: GitCommit = transport
        .get(
            token,
            &format!("/repos/{REGISTRY}/git/commits/{}", reference.object.sha),
        )
        .await?;
    audit_base_tree(transport, token, &base.tree.sha).await?;
    let filename = &documents.filename;
    for path in [
        format!("packages/{filename}"),
        format!("submissions/{filename}"),
    ] {
        if transport
            .get_optional::<Value>(
                token,
                &format!(
                    "/repos/{REGISTRY}/contents/{path}?ref={}",
                    reference.object.sha
                ),
            )
            .await?
            .is_some()
        {
            return Err(conflict(
                "PUBLICATION_REGISTRY_VERSION_EXISTS",
                format!("registry path {path} already exists and is immutable"),
            ));
        }
    }
    Ok(Inspection {
        account: actor.login,
        actor_id: actor.id,
        repository_id: repository.id,
        base_branch: repository.default_branch,
        base_commit: reference.object.sha,
    })
}

pub(super) async fn revalidate_identity(
    transport: &Transport,
    input: &Submission<'_>,
) -> Result<(), AppError> {
    let actor: User = transport.get(input.token, "/user").await?;
    validate_login(&actor.login)?;
    let repo: Repository = transport
        .get(input.token, &format!("/repos/{REGISTRY}"))
        .await?;
    let reference: GitRef = transport
        .get(
            input.token,
            &format!(
                "/repos/{REGISTRY}/git/ref/heads/{}",
                segment(&input.preview.base_branch)
            ),
        )
        .await?;
    validate_registry(&repo)?;
    validate_base_ref(&reference, &input.preview.base_branch)?;
    if actor.id != input.actor_id
        || actor.login != input.preview.account
        || repo.id != input.repository_id
        || repo.default_branch != input.preview.base_branch
        || reference.object.sha != input.preview.base_commit
    {
        return Err(conflict(
            "PUBLICATION_REGISTRY_PLAN_CHANGED",
            "registry actor, repository, or base changed; preview it again",
        ));
    }
    Ok(())
}

fn validate_registry(repository: &Repository) -> Result<(), AppError> {
    if repository.full_name != REGISTRY
        || repository.fork
        || repository.private
        || repository.archived
    {
        return Err(conflict(
            "PUBLICATION_REGISTRY_REMOTE_IDENTITY_MISMATCH",
            "the fixed registry repository identity is invalid",
        ));
    }
    Ok(())
}

fn validate_base_ref(reference: &GitRef, branch: &str) -> Result<(), AppError> {
    validate_sha(&reference.object.sha)?;
    if reference.reference != format!("refs/heads/{branch}") || reference.object.kind != "commit" {
        return Err(conflict(
            "PUBLICATION_REGISTRY_REMOTE_IDENTITY_MISMATCH",
            "registry base reference identity is invalid",
        ));
    }
    Ok(())
}

async fn audit_base_tree(
    transport: &Transport,
    token: &str,
    root_sha: &str,
) -> Result<(), AppError> {
    let root: GitTree = transport
        .get(token, &format!("/repos/{REGISTRY}/git/trees/{root_sha}"))
        .await?;
    if root.truncated {
        return Err(conflict(
            "PUBLICATION_REGISTRY_LAYOUT_INVALID",
            "GitHub truncated the registry base tree",
        ));
    }
    for directory in ["packages", "submissions"] {
        let matches = root
            .tree
            .iter()
            .filter(|entry| entry.path == directory)
            .collect::<Vec<_>>();
        if matches.len() != 1 || matches[0].mode != "040000" || matches[0].kind != "tree" {
            return Err(conflict(
                "PUBLICATION_REGISTRY_LAYOUT_INVALID",
                format!("registry {directory} is not exactly one directory"),
            ));
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::super::super::fixture::{Expected, Script};
    use super::super::fixture::*;
    use super::*;
    use serde_json::json;

    #[tokio::test]
    async fn preview_rejects_invalid_registry_root_tree_before_path_checks() {
        let calls = vec![
            Expected::get("/user", actor()),
            Expected::get("/repos/merkr-software/cadencr-registry", registry()),
            Expected::get(
                "/repos/merkr-software/cadencr-registry/git/ref/heads/main",
                git_ref("refs/heads/main", BASE),
            ),
            Expected::get(
                format!("/repos/merkr-software/cadencr-registry/git/commits/{BASE}"),
                commit(BASE, None),
            ),
            Expected::get(
                format!("/repos/merkr-software/cadencr-registry/git/trees/{BASE_TREE}"),
                json!({"truncated":false,"tree":[
                    {"path":"packages","mode":"120000","type":"blob","sha":"1111111111111111111111111111111111111111"},
                    {"path":"submissions","mode":"040000","type":"tree","sha":"2222222222222222222222222222222222222222"}
                ]}),
            ),
        ];
        let (fixture, transport) = Script::serve(calls).await;
        let documents = Documents {
            filename: "acme-agent-1.0.0.json".into(),
            package: b"package".to_vec(),
            submission: b"submission".to_vec(),
            markdown: b"PR body".to_vec(),
        };
        assert!(inspect(&transport, "token", &documents).await.is_err());
        fixture.assert_done();
    }

    #[tokio::test]
    async fn base_drift_is_rejected_before_fork_or_pull_access() {
        let calls = vec![
            Expected::get("/user", actor()),
            Expected::get("/repos/merkr-software/cadencr-registry", registry()),
            Expected::get(
                "/repos/merkr-software/cadencr-registry/git/ref/heads/main",
                git_ref(
                    "refs/heads/main",
                    "7777777777777777777777777777777777777777",
                ),
            ),
        ];
        assert!(run(calls).await.is_err());
    }
}
