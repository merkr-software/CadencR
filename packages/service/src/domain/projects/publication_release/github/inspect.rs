use super::models::{AnnotatedTag, GitReference};
use super::state::{conflict, is_sha};
use super::transport::Transport;
use crate::error::AppError;

const MAX_TAG_DEPTH: usize = 8;

pub(super) async fn resolve_tag_commit(
    transport: &Transport,
    token: &str,
    repository: &str,
    tag: &str,
) -> Result<String, AppError> {
    let encoded = percent_encoding::utf8_percent_encode(tag, percent_encoding::NON_ALPHANUMERIC);
    let reference: GitReference = transport
        .get_json(
            token,
            &format!("/repos/{repository}/git/ref/tags/{encoded}"),
        )
        .await?;
    let mut object = reference.object;
    for _ in 0..MAX_TAG_DEPTH {
        match object.kind.as_str() {
            "commit" if is_sha(&object.sha) => return Ok(object.sha),
            "tag" if is_sha(&object.sha) => {
                let tag: AnnotatedTag = transport
                    .get_json(
                        token,
                        &format!("/repos/{repository}/git/tags/{}", object.sha),
                    )
                    .await?;
                object = tag.object;
            }
            _ => return Err(conflict("GitHub release tag does not resolve to a commit")),
        }
    }
    Err(conflict("GitHub annotated tag chain is too deep"))
}
