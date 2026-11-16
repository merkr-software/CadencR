use serde::{Deserialize, Serialize};

#[derive(Deserialize)]
pub(super) struct GitHubUser {
    pub login: String,
}

#[derive(Clone, Copy, Deserialize)]
pub(super) struct GitHubPermissions {
    #[serde(default)]
    pub push: bool,
}

#[derive(Deserialize)]
pub(super) struct GitHubRepository {
    pub id: u64,
    #[serde(default)]
    pub private: bool,
    pub permissions: Option<GitHubPermissions>,
}

#[derive(Deserialize)]
pub(super) struct GitReference {
    pub object: GitObject,
}

#[derive(Deserialize)]
pub(super) struct GitObject {
    #[serde(rename = "type")]
    pub kind: String,
    pub sha: String,
}

#[derive(Deserialize)]
pub(super) struct AnnotatedTag {
    pub object: GitObject,
}

#[derive(Clone, Deserialize)]
pub(super) struct Release {
    pub id: u64,
    pub tag_name: String,
    pub target_commitish: String,
    pub name: Option<String>,
    pub body: Option<String>,
    pub draft: bool,
    pub prerelease: bool,
}

#[derive(Clone, Deserialize)]
pub(super) struct Asset {
    pub id: u64,
    pub name: String,
    pub size: u64,
    pub state: String,
    pub digest: Option<String>,
}

#[derive(Serialize)]
pub(super) struct CreateRelease<'a> {
    pub tag_name: &'a str,
    pub target_commitish: &'a str,
    pub name: &'a str,
    pub body: &'a str,
    pub draft: bool,
    pub prerelease: bool,
    pub make_latest: &'static str,
}

#[derive(Serialize)]
pub(super) struct PublishRelease {
    pub draft: bool,
    pub make_latest: &'static str,
}
