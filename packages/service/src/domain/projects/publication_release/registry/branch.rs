use base64::Engine as _;

use super::conflict;
use super::identity::validate_sha;
use super::models::*;
use super::state::Submission;
use super::transport::Transport;
use crate::error::AppError;

pub(super) async fn ensure_branch(
    transport: &Transport,
    input: &Submission<'_>,
    fork: &Repository,
) -> Result<String, AppError> {
    let ref_path = format!(
        "/repos/{}/git/ref/heads/{}",
        fork.full_name,
        super::state::segment(&input.preview.branch)
    );
    if let Some(reference) = transport
        .get_optional::<GitRef>(input.token, &ref_path)
        .await?
    {
        validate_ref(&reference, input)?;
        validate_branch(transport, input, fork, &reference.object.sha).await?;
        return Ok(reference.object.sha);
    }
    create_new_branch(transport, input, fork, &ref_path).await
}

async fn create_new_branch(
    transport: &Transport,
    input: &Submission<'_>,
    fork: &Repository,
    ref_path: &str,
) -> Result<String, AppError> {
    let package_blob = create_blob(transport, input.token, &fork.full_name, input.package).await?;
    let submission_blob =
        create_blob(transport, input.token, &fork.full_name, input.submission).await?;
    let base: GitCommit = transport
        .get(
            input.token,
            &format!(
                "/repos/{}/git/commits/{}",
                fork.full_name, input.preview.base_commit
            ),
        )
        .await?;
    let tree = transport
        .post::<_, CreatedSha>(
            input.token,
            &format!("/repos/{}/git/trees", fork.full_name),
            &CreateTree {
                base_tree: &base.tree.sha,
                tree: vec![
                    TreeEntry {
                        path: &input.preview.package_path,
                        mode: "100644",
                        kind: "blob",
                        sha: &package_blob,
                    },
                    TreeEntry {
                        path: &input.preview.submission_path,
                        mode: "100644",
                        kind: "blob",
                        sha: &submission_blob,
                    },
                ],
            },
        )
        .await?;
    let message = format!("Add {} {}", input.preview.plugin_id, input.preview.version);
    let commit = transport
        .post::<_, GitCommit>(
            input.token,
            &format!("/repos/{}/git/commits", fork.full_name),
            &CreateCommit {
                message: &message,
                tree: &tree.sha,
                parents: [&input.preview.base_commit],
            },
        )
        .await?;
    validate_branch(transport, input, fork, &commit.sha).await?;
    let reference = format!("refs/heads/{}", input.preview.branch);
    let create_error = transport
        .post::<_, GitRef>(
            input.token,
            &format!("/repos/{}/git/refs", fork.full_name),
            &CreateRef {
                reference: &reference,
                sha: &commit.sha,
            },
        )
        .await
        .err();
    let actual =
        match transport
            .get_optional::<GitRef>(input.token, ref_path)
            .await?
        {
            Some(value) => value,
            None => match create_error {
                Some(error) => return Err(error),
                None => return Err(conflict(
                    "PUBLICATION_REGISTRY_BRANCH_CONFLICT",
                    "GitHub did not expose the created branch; inspect the fork before retrying",
                )),
            },
        };
    validate_ref(&actual, input)?;
    if actual.object.sha != commit.sha {
        return Err(conflict(
            "PUBLICATION_REGISTRY_BRANCH_CONFLICT",
            "GitHub created the deterministic branch at an unexpected commit",
        ));
    }
    validate_branch(transport, input, fork, &actual.object.sha).await?;
    Ok(actual.object.sha)
}

fn validate_ref(reference: &GitRef, input: &Submission<'_>) -> Result<(), AppError> {
    validate_sha(&reference.object.sha)?;
    if reference.reference != format!("refs/heads/{}", input.preview.branch)
        || reference.object.kind != "commit"
    {
        return Err(conflict(
            "PUBLICATION_REGISTRY_BRANCH_CONFLICT",
            "the deterministic branch reference identity is invalid",
        ));
    }
    Ok(())
}

async fn create_blob(
    transport: &Transport,
    token: &str,
    repo: &str,
    bytes: &[u8],
) -> Result<String, AppError> {
    let content = base64::engine::general_purpose::STANDARD.encode(bytes);
    Ok(transport
        .post::<_, CreatedSha>(
            token,
            &format!("/repos/{repo}/git/blobs"),
            &CreateBlob {
                content: &content,
                encoding: "base64",
            },
        )
        .await?
        .sha)
}

async fn validate_branch(
    transport: &Transport,
    input: &Submission<'_>,
    fork: &Repository,
    sha: &str,
) -> Result<(), AppError> {
    let commit: GitCommit = transport
        .get(
            input.token,
            &format!("/repos/{}/git/commits/{sha}", fork.full_name),
        )
        .await?;
    if commit.parents.len() != 1 || commit.parents[0].sha != input.preview.base_commit {
        return Err(conflict(
            "PUBLICATION_REGISTRY_BRANCH_CONFLICT",
            "the deterministic branch has foreign history",
        ));
    }
    let comparison: Comparison = transport
        .get(
            input.token,
            &format!(
                "/repos/{}/compare/{}...{sha}",
                fork.full_name, input.preview.base_commit
            ),
        )
        .await?;
    let mut files = comparison.files.ok_or_else(|| {
        conflict(
            "PUBLICATION_REGISTRY_BRANCH_CONFLICT",
            "GitHub omitted the branch file list",
        )
    })?;
    files.sort_by(|a, b| a.filename.cmp(&b.filename));
    let mut expected = vec![
        input.preview.package_path.clone(),
        input.preview.submission_path.clone(),
    ];
    expected.sort();
    if files.len() != 2
        || files.iter().map(|file| &file.filename).ne(expected.iter())
        || files.iter().any(|file| file.status != "added")
    {
        return Err(conflict(
            "PUBLICATION_REGISTRY_BRANCH_CONFLICT",
            "the deterministic branch does not contain only the exact paired additions",
        ));
    }
    verify_tree_modes(transport, input, fork, &commit.tree.sha).await?;
    verify_content(
        transport,
        input,
        fork,
        &input.preview.package_path,
        input.package,
        sha,
    )
    .await?;
    verify_content(
        transport,
        input,
        fork,
        &input.preview.submission_path,
        input.submission,
        sha,
    )
    .await
}

async fn verify_tree_modes(
    transport: &Transport,
    input: &Submission<'_>,
    fork: &Repository,
    root_sha: &str,
) -> Result<(), AppError> {
    let root: GitTree = transport
        .get(
            input.token,
            &format!("/repos/{}/git/trees/{root_sha}", fork.full_name),
        )
        .await?;
    if root.truncated {
        return Err(conflict(
            "PUBLICATION_REGISTRY_BRANCH_CONFLICT",
            "GitHub truncated the branch tree",
        ));
    }
    for (directory, path) in [
        ("packages", &input.preview.package_path),
        ("submissions", &input.preview.submission_path),
    ] {
        let parent = root
            .tree
            .iter()
            .find(|entry| entry.path == directory && entry.mode == "040000" && entry.kind == "tree")
            .ok_or_else(|| {
                conflict(
                    "PUBLICATION_REGISTRY_BRANCH_CONFLICT",
                    format!("branch {directory} parent is not a directory"),
                )
            })?;
        let subtree: GitTree = transport
            .get(
                input.token,
                &format!("/repos/{}/git/trees/{}", fork.full_name, parent.sha),
            )
            .await?;
        let filename = path.strip_prefix(&format!("{directory}/")).unwrap_or(path);
        if subtree.truncated
            || !subtree.tree.iter().any(|entry| {
                entry.path == filename && entry.mode == "100644" && entry.kind == "blob"
            })
        {
            return Err(conflict(
                "PUBLICATION_REGISTRY_BRANCH_CONFLICT",
                format!("branch {path} is not a regular file"),
            ));
        }
    }
    Ok(())
}

async fn verify_content(
    transport: &Transport,
    input: &Submission<'_>,
    fork: &Repository,
    path: &str,
    expected: &[u8],
    sha: &str,
) -> Result<(), AppError> {
    let content: Content = transport
        .get(
            input.token,
            &format!("/repos/{}/contents/{path}?ref={sha}", fork.full_name),
        )
        .await?;
    if content.kind != "file"
        || content.encoding.as_deref() != Some("base64")
        || content.sha.is_empty()
    {
        return Err(conflict(
            "PUBLICATION_REGISTRY_BRANCH_CONFLICT",
            "branch content is not a regular GitHub file",
        ));
    }
    let encoded = content.content.ok_or_else(|| {
        conflict(
            "PUBLICATION_REGISTRY_BRANCH_CONFLICT",
            "GitHub omitted branch content",
        )
    })?;
    let decoded = base64::engine::general_purpose::STANDARD
        .decode(encoded.replace('\n', ""))
        .map_err(|_| {
            conflict(
                "PUBLICATION_REGISTRY_BRANCH_CONFLICT",
                "GitHub returned invalid branch content",
            )
        })?;
    if decoded != expected {
        return Err(conflict(
            "PUBLICATION_REGISTRY_BRANCH_CONFLICT",
            "branch content differs from the reviewed plan",
        ));
    }
    Ok(())
}
