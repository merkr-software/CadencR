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

pub(super) async fn inspect(
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

async fn revalidate_identity(
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

async fn ensure_fork(
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

async fn find_pull(
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

fn validate_pull(
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

fn result(pull: Pull, branch: &str, reused: bool) -> Result<PublicationRegistryResult, AppError> {
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
    use base64::Engine as _;
    use serde_json::{json, Value};

    use super::super::fixture::{Expected, Script};
    use super::*;

    const BASE: &str = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    const BASE_TREE: &str = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
    const PACKAGE_BLOB: &str = "cccccccccccccccccccccccccccccccccccccccc";
    const SUBMISSION_BLOB: &str = "dddddddddddddddddddddddddddddddddddddddd";
    const TREE: &str = "eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee";
    const COMMIT: &str = "ffffffffffffffffffffffffffffffffffffffff";
    const FORK_ID: u64 = 22;

    fn preview() -> PublicationRegistryPreview {
        PublicationRegistryPreview {
            project_id: 7,
            plugin_id: "acme-agent".into(),
            version: "1.0.0".into(),
            bundle_id: "bundle".into(),
            release_notes: "notes".into(),
            account: "alice".into(),
            registry_repository: "merkr-software/cadencr-registry".into(),
            base_branch: "main".into(),
            base_commit: BASE.into(),
            branch: "cadencr/acme-agent-1-0-0-plan-base".into(),
            package_path: "packages/acme-agent-1.0.0.json".into(),
            submission_path: "submissions/acme-agent-1.0.0.json".into(),
            plan_sha256: "plan".into(),
        }
    }

    fn actor() -> Value {
        json!({"login":"alice","id":11})
    }

    fn registry() -> Value {
        json!({
            "id":1,"full_name":"merkr-software/cadencr-registry",
            "default_branch":"main","fork":false,"private":false,"archived":false,
            "owner":{"login":"merkr-software","id":99},"parent":null
        })
    }

    fn fork() -> Value {
        json!({
            "id":FORK_ID,"full_name":"alice/cadencr-registry",
            "default_branch":"main","fork":true,"private":false,"archived":false,
            "owner":{"login":"alice","id":11},"parent":{"id":1}
        })
    }

    fn git_ref(reference: &str, sha: &str) -> Value {
        json!({"ref":reference,"object":{"sha":sha,"type":"commit"}})
    }

    fn commit(sha: &str, parent: Option<&str>) -> Value {
        json!({
            "sha":sha,
            "tree":{"sha": if sha == BASE { BASE_TREE } else { TREE },"type":"tree"},
            "parents": parent.into_iter().map(|sha| json!({"sha":sha})).collect::<Vec<_>>()
        })
    }

    fn pull() -> Value {
        let preview = preview();
        json!({
            "number":42,
            "html_url":"https://github.com/merkr-software/cadencr-registry/pull/42",
            "state":"open","title":"Add acme-agent 1.0.0","draft":false,"merged_at":null,
            "body":"PR body","user":{"login":"alice","id":11},
            "head":{"ref":preview.branch,"sha":COMMIT,"repo":{"id":FORK_ID}},
            "base":{"ref":"main","sha":BASE,"repo":{"id":1}}
        })
    }

    fn identity() -> Vec<Expected> {
        vec![
            Expected::get("/user", actor()),
            Expected::get("/repos/merkr-software/cadencr-registry", registry()),
            Expected::get(
                "/repos/merkr-software/cadencr-registry/git/ref/heads/main",
                git_ref("refs/heads/main", BASE),
            ),
        ]
    }

    fn branch_validation() -> Vec<Expected> {
        let preview = preview();
        vec![
            Expected::get(
                format!("/repos/alice/cadencr-registry/git/commits/{COMMIT}"),
                commit(COMMIT, Some(BASE)),
            ),
            Expected::get(
                format!("/repos/alice/cadencr-registry/compare/{BASE}...{COMMIT}"),
                json!({"files":[
                    {"filename":preview.package_path,"status":"added"},
                    {"filename":preview.submission_path,"status":"added"}
                ]}),
            ),
            Expected::get(
                format!("/repos/alice/cadencr-registry/git/trees/{TREE}"),
                json!({"truncated":false,"tree":[
                    {"path":"packages","mode":"040000","type":"tree","sha":"1111111111111111111111111111111111111111"},
                    {"path":"submissions","mode":"040000","type":"tree","sha":"2222222222222222222222222222222222222222"}
                ]}),
            ),
            Expected::get(
                "/repos/alice/cadencr-registry/git/trees/1111111111111111111111111111111111111111",
                json!({"truncated":false,"tree":[
                    {"path":"acme-agent-1.0.0.json","mode":"100644","type":"blob","sha":PACKAGE_BLOB}
                ]}),
            ),
            Expected::get(
                "/repos/alice/cadencr-registry/git/trees/2222222222222222222222222222222222222222",
                json!({"truncated":false,"tree":[
                    {"path":"acme-agent-1.0.0.json","mode":"100644","type":"blob","sha":SUBMISSION_BLOB}
                ]}),
            ),
            Expected::get(
                format!(
                    "/repos/alice/cadencr-registry/contents/{}?ref={COMMIT}",
                    preview.package_path
                ),
                content(b"package", PACKAGE_BLOB),
            ),
            Expected::get(
                format!(
                    "/repos/alice/cadencr-registry/contents/{}?ref={COMMIT}",
                    preview.submission_path
                ),
                content(b"submission", SUBMISSION_BLOB),
            ),
        ]
    }

    fn content(bytes: &[u8], sha: &str) -> Value {
        json!({
            "sha":sha,"type":"file","encoding":"base64",
            "content":base64::engine::general_purpose::STANDARD.encode(bytes)
        })
    }

    fn candidate_creation() -> Vec<Expected> {
        let preview = preview();
        vec![
            Expected::missing(format!(
                "/repos/alice/cadencr-registry/git/ref/heads/{}",
                segment(&preview.branch)
            )),
            Expected::post(
                "/repos/alice/cadencr-registry/git/blobs",
                json!({"content":base64::engine::general_purpose::STANDARD.encode(b"package"),"encoding":"base64"}),
                json!({"sha":PACKAGE_BLOB}),
            ),
            Expected::post(
                "/repos/alice/cadencr-registry/git/blobs",
                json!({"content":base64::engine::general_purpose::STANDARD.encode(b"submission"),"encoding":"base64"}),
                json!({"sha":SUBMISSION_BLOB}),
            ),
            Expected::get(
                format!("/repos/alice/cadencr-registry/git/commits/{BASE}"),
                commit(BASE, None),
            ),
            Expected::post(
                "/repos/alice/cadencr-registry/git/trees",
                json!({"base_tree":BASE_TREE,"tree":[
                    {"path":preview.package_path,"mode":"100644","type":"blob","sha":PACKAGE_BLOB},
                    {"path":preview.submission_path,"mode":"100644","type":"blob","sha":SUBMISSION_BLOB}
                ]}),
                json!({"sha":TREE}),
            ),
            Expected::post(
                "/repos/alice/cadencr-registry/git/commits",
                json!({"message":"Add acme-agent 1.0.0","tree":TREE,"parents":[BASE]}),
                commit(COMMIT, Some(BASE)),
            ),
        ]
    }

    fn create_branch(ref_response_lost: bool) -> Vec<Expected> {
        let preview = preview();
        let mut calls = candidate_creation();
        calls.extend(branch_validation());
        let ref_body = json!({"ref":format!("refs/heads/{}",preview.branch),"sha":COMMIT});
        calls.push(if ref_response_lost {
            Expected::failed_post("/repos/alice/cadencr-registry/git/refs", ref_body)
        } else {
            Expected::post(
                "/repos/alice/cadencr-registry/git/refs",
                ref_body,
                git_ref(&format!("refs/heads/{}", preview.branch), COMMIT),
            )
        });
        calls.push(Expected::get(
            format!(
                "/repos/alice/cadencr-registry/git/ref/heads/{}",
                segment(&preview.branch)
            ),
            git_ref(&format!("refs/heads/{}", preview.branch), COMMIT),
        ));
        calls.extend(branch_validation());
        calls
    }

    fn find_pulls(value: Value) -> Expected {
        let preview = preview();
        let head = format!("alice:{}", preview.branch);
        Expected::get(
            format!(
                "/repos/merkr-software/cadencr-registry/pulls?state=all&head={}&base=main&per_page=2",
                segment(&head)
            ),
            value,
        )
    }

    async fn run(
        script: Vec<Expected>,
    ) -> Result<
        crate::domain::projects::publication_release::registry::PublicationRegistryResult,
        crate::error::AppError,
    > {
        let (fixture, transport) = Script::serve(script).await;
        let preview = preview();
        let result = submit_with_transport(
            &transport,
            Submission {
                token: "token",
                preview: &preview,
                actor_id: 11,
                repository_id: 1,
                package: b"package",
                submission: b"submission",
                pull_request_body: b"PR body",
            },
        )
        .await;
        fixture.assert_done();
        result
    }

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
    async fn rejects_foreign_fork_before_any_branch_write() {
        let mut foreign = fork();
        foreign["parent"]["id"] = json!(999);
        let mut calls = identity();
        calls.push(Expected::get("/repos/alice/cadencr-registry", foreign));
        assert!(run(calls).await.is_err());
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
