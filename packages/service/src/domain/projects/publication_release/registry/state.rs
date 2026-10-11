use serde_json::Value;

pub(super) use super::identity::segment;
use super::identity::{validate_login, validate_sha};
use super::models::*;
use super::transport::Transport;
use super::{conflict, PublicationRegistryPreview, PublicationRegistryResult, REGISTRY};
use crate::domain::projects::publication_release::contribution::submission::Documents;
use crate::error::AppError;

pub(super) struct Inspection {
    pub account: String,
    pub actor_id: u64,
    pub repository_id: u64,
    pub base_branch: String,
    pub base_commit: String,
}

pub(super) struct Submission<'a> {
    pub token: &'a str,
    pub preview: &'a PublicationRegistryPreview,
    pub actor_id: u64,
    pub repository_id: u64,
    pub package: &'a [u8],
    pub submission: &'a [u8],
    pub pull_request_body: &'a [u8],
}

#[cfg(test)]
mod fixture;
mod fork;
mod inspection;
mod pull;
use fork::ensure_fork;
pub(super) use inspection::inspect;
use inspection::revalidate_identity;
use pull::{find_pull, result, validate_pull};

pub(super) async fn submit_with_transport(
    transport: &Transport,
    input: Submission<'_>,
) -> Result<PublicationRegistryResult, AppError> {
    revalidate_identity(transport, &input).await?;
    let fork = ensure_fork(transport, &input).await?;
    let branch_commit = super::branch::ensure_branch(transport, &input, &fork).await?;
    if let Some(pull) = find_pull(transport, &input, fork.id, &branch_commit).await? {
        return result(pull, &input.preview.branch, true);
    }
    revalidate_identity(transport, &input).await?;
    let body = std::str::from_utf8(input.pull_request_body).map_err(|_| {
        conflict(
            "PUBLICATION_REGISTRY_PLAN_CHANGED",
            "pull request document is not UTF-8",
        )
    })?;
    let head = format!("{}:{}", input.preview.account, input.preview.branch);
    let title = format!("Add {} {}", input.preview.plugin_id, input.preview.version);
    let request = CreatePull {
        title: &title,
        head: &head,
        base: &input.preview.base_branch,
        body,
        maintainer_can_modify: false,
    };
    let created = transport
        .post::<_, Pull>(input.token, &format!("/repos/{REGISTRY}/pulls"), &request)
        .await;
    match created {
        Ok(_) => match find_pull(transport, &input, fork.id, &branch_commit).await? {
            Some(pull) => validate_pull(pull, &input, fork.id, &branch_commit, false),
            None => Err(conflict(
                "PUBLICATION_REGISTRY_PR_CONFLICT",
                "GitHub did not expose the created pull request; inspect the fork before retrying",
            )),
        },
        Err(error) => match find_pull(transport, &input, fork.id, &branch_commit).await? {
            Some(pull) => validate_pull(pull, &input, fork.id, &branch_commit, true),
            None => Err(error),
        },
    }
}

#[cfg(test)]
mod tests {
    use super::super::fixture::Expected;
    use super::fixture::*;
    use super::segment;
    use serde_json::json;

    #[tokio::test]
    async fn creates_one_exact_paired_commit_and_pull_request() {
        let mut calls = identity();
        calls.push(Expected::get("/repos/alice/cadencr-registry", fork()));
        calls.extend(create_branch(false));
        calls.push(find_pulls(json!([])));
        calls.extend(identity());
        calls.push(Expected::post(
            "/repos/merkr-software/cadencr-registry/pulls",
            json!({
                "title":"Add acme-agent 1.0.0","head":"alice:cadencr/acme-agent-1-0-0-plan-base",
                "base":"main","body":"PR body","maintainer_can_modify":false
            }),
            pull(),
        ));
        calls.push(find_pulls(json!([pull()])));
        let result = run(calls).await.unwrap();
        assert_eq!(result.pull_request_number, 42);
        assert!(!result.reused);
    }

    #[tokio::test]
    async fn exact_existing_branch_and_pull_are_reused_without_writes() {
        let preview = preview();
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
        calls.push(find_pulls(json!([pull()])));
        let result = run(calls).await.unwrap();
        assert!(result.reused);
    }

    #[tokio::test]
    async fn rejects_foreign_branch_history_before_pull_creation() {
        let preview = preview();
        let foreign = "9999999999999999999999999999999999999999";
        let mut calls = identity();
        calls.push(Expected::get("/repos/alice/cadencr-registry", fork()));
        calls.push(Expected::get(
            format!(
                "/repos/alice/cadencr-registry/git/ref/heads/{}",
                segment(&preview.branch)
            ),
            git_ref(&format!("refs/heads/{}", preview.branch), foreign),
        ));
        calls.push(Expected::get(
            format!("/repos/alice/cadencr-registry/git/commits/{foreign}"),
            commit(foreign, Some("8888888888888888888888888888888888888888")),
        ));
        assert!(run(calls).await.is_err());
    }

    #[tokio::test]
    async fn invalid_candidate_tree_is_rejected_before_ref_write() {
        for root in [
            json!({"truncated":true,"tree":[]}),
            json!({"truncated":false,"tree":[
                {"path":"packages","mode":"040000","type":"tree","sha":"1111111111111111111111111111111111111111"},
                {"path":"submissions","mode":"040000","type":"tree","sha":"2222222222222222222222222222222222222222"}
            ]}),
        ] {
            let mut calls = identity();
            calls.push(Expected::get("/repos/alice/cadencr-registry", fork()));
            calls.extend(candidate_creation());
            calls.push(Expected::get(
                format!("/repos/alice/cadencr-registry/git/commits/{COMMIT}"),
                commit(COMMIT, Some(BASE)),
            ));
            calls.push(Expected::get(
                format!("/repos/alice/cadencr-registry/compare/{BASE}...{COMMIT}"),
                json!({"files":[
                    {"filename":"packages/acme-agent-1.0.0.json","status":"added"},
                    {"filename":"submissions/acme-agent-1.0.0.json","status":"added"}
                ]}),
            ));
            calls.push(Expected::get(
                format!("/repos/alice/cadencr-registry/git/trees/{TREE}"),
                root.clone(),
            ));
            if !root["truncated"].as_bool().unwrap() {
                calls.push(Expected::get(
                    "/repos/alice/cadencr-registry/git/trees/1111111111111111111111111111111111111111",
                    json!({"truncated":false,"tree":[
                        {"path":"acme-agent-1.0.0.json","mode":"120000","type":"blob","sha":PACKAGE_BLOB}
                    ]}),
                ));
            }
            assert!(run(calls).await.is_err());
        }
    }

    #[tokio::test]
    async fn drift_after_branch_creation_performs_no_pull_write() {
        let mut calls = identity();
        calls.push(Expected::get("/repos/alice/cadencr-registry", fork()));
        calls.extend(create_branch(false));
        calls.push(find_pulls(json!([])));
        calls.push(Expected::get("/user", actor()));
        calls.push(Expected::get(
            "/repos/merkr-software/cadencr-registry",
            registry(),
        ));
        calls.push(Expected::get(
            "/repos/merkr-software/cadencr-registry/git/ref/heads/main",
            git_ref(
                "refs/heads/main",
                "7777777777777777777777777777777777777777",
            ),
        ));
        assert!(run(calls).await.is_err());
    }

    #[tokio::test]
    async fn lost_ref_and_pull_responses_recover_by_exact_read_after_write() {
        let mut calls = identity();
        calls.push(Expected::get("/repos/alice/cadencr-registry", fork()));
        calls.extend(create_branch(true));
        calls.push(find_pulls(json!([])));
        calls.extend(identity());
        calls.push(Expected::failed_post(
            "/repos/merkr-software/cadencr-registry/pulls",
            json!({
                "title":"Add acme-agent 1.0.0","head":"alice:cadencr/acme-agent-1-0-0-plan-base",
                "base":"main","body":"PR body","maintainer_can_modify":false
            }),
        ));
        calls.push(find_pulls(json!([pull()])));
        let result = run(calls).await.unwrap();
        assert!(result.reused);
    }
}
