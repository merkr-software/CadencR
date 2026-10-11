use base64::Engine as _;
use serde_json::{json, Value};

use super::super::fixture::{Expected, Script};
use super::*;

pub(super) const BASE: &str = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
pub(super) const BASE_TREE: &str = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
pub(super) const PACKAGE_BLOB: &str = "cccccccccccccccccccccccccccccccccccccccc";
pub(super) const SUBMISSION_BLOB: &str = "dddddddddddddddddddddddddddddddddddddddd";
pub(super) const TREE: &str = "eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee";
pub(super) const COMMIT: &str = "ffffffffffffffffffffffffffffffffffffffff";
pub(super) const FORK_ID: u64 = 22;

pub(super) fn preview() -> PublicationRegistryPreview {
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

pub(super) fn actor() -> Value {
    json!({"login":"alice","id":11})
}

pub(super) fn registry() -> Value {
    json!({
        "id":1,"full_name":"merkr-software/cadencr-registry",
        "default_branch":"main","fork":false,"private":false,"archived":false,
        "owner":{"login":"merkr-software","id":99},"parent":null
    })
}

pub(super) fn fork() -> Value {
    json!({
        "id":FORK_ID,"full_name":"alice/cadencr-registry",
        "default_branch":"main","fork":true,"private":false,"archived":false,
        "owner":{"login":"alice","id":11},"parent":{"id":1}
    })
}

pub(super) fn git_ref(reference: &str, sha: &str) -> Value {
    json!({"ref":reference,"object":{"sha":sha,"type":"commit"}})
}

pub(super) fn commit(sha: &str, parent: Option<&str>) -> Value {
    json!({
        "sha":sha,
        "tree":{"sha": if sha == BASE { BASE_TREE } else { TREE },"type":"tree"},
        "parents": parent.into_iter().map(|sha| json!({"sha":sha})).collect::<Vec<_>>()
    })
}

pub(super) fn pull() -> Value {
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

pub(super) fn identity() -> Vec<Expected> {
    vec![
        Expected::get("/user", actor()),
        Expected::get("/repos/merkr-software/cadencr-registry", registry()),
        Expected::get(
            "/repos/merkr-software/cadencr-registry/git/ref/heads/main",
            git_ref("refs/heads/main", BASE),
        ),
    ]
}

pub(super) fn branch_validation() -> Vec<Expected> {
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

pub(super) fn content(bytes: &[u8], sha: &str) -> Value {
    json!({
        "sha":sha,"type":"file","encoding":"base64",
        "content":base64::engine::general_purpose::STANDARD.encode(bytes)
    })
}

pub(super) fn candidate_creation() -> Vec<Expected> {
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

pub(super) fn create_branch(ref_response_lost: bool) -> Vec<Expected> {
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

pub(super) fn find_pulls(value: Value) -> Expected {
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

pub(super) async fn run(
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
