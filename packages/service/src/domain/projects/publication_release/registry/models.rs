use serde::{Deserialize, Serialize};

#[derive(Deserialize)]
pub(super) struct User {
    pub login: String,
    pub id: u64,
}

#[derive(Deserialize)]
pub(super) struct Repository {
    pub id: u64,
    pub full_name: String,
    pub default_branch: String,
    pub fork: bool,
    pub private: bool,
    pub archived: bool,
    pub owner: User,
    pub parent: Option<RepositoryIdentity>,
}

#[derive(Deserialize)]
pub(super) struct RepositoryIdentity {
    pub id: u64,
}

#[derive(Deserialize)]
pub(super) struct GitRef {
    #[serde(rename = "ref")]
    pub reference: String,
    pub object: GitObject,
}

#[derive(Deserialize)]
pub(super) struct GitObject {
    pub sha: String,
    #[serde(rename = "type", default)]
    pub kind: String,
}

#[derive(Deserialize)]
pub(super) struct GitCommit {
    pub sha: String,
    pub tree: GitObject,
    #[serde(default)]
    pub parents: Vec<GitObject>,
}

#[derive(Serialize)]
pub(super) struct CreateFork {
    pub default_branch_only: bool,
}

#[derive(Serialize)]
pub(super) struct CreateRef<'a> {
    #[serde(rename = "ref")]
    pub reference: &'a str,
    pub sha: &'a str,
}

#[derive(Serialize)]
pub(super) struct CreateBlob<'a> {
    pub content: &'a str,
    pub encoding: &'static str,
}

#[derive(Deserialize)]
pub(super) struct CreatedSha {
    pub sha: String,
}

#[derive(Serialize)]
pub(super) struct CreateTree<'a> {
    pub base_tree: &'a str,
    pub tree: Vec<TreeEntry<'a>>,
}

#[derive(Serialize)]
pub(super) struct TreeEntry<'a> {
    pub path: &'a str,
    pub mode: &'static str,
    #[serde(rename = "type")]
    pub kind: &'static str,
    pub sha: &'a str,
}

#[derive(Serialize)]
pub(super) struct CreateCommit<'a> {
    pub message: &'a str,
    pub tree: &'a str,
    pub parents: [&'a str; 1],
}

#[derive(Serialize)]
pub(super) struct CreatePull<'a> {
    pub title: &'a str,
    pub head: &'a str,
    pub base: &'a str,
    pub body: &'a str,
    pub maintainer_can_modify: bool,
}

#[derive(Deserialize)]
pub(super) struct Pull {
    pub number: u64,
    pub html_url: String,
    pub state: String,
    pub title: String,
    pub draft: bool,
    pub merged_at: Option<String>,
    pub body: Option<String>,
    pub user: User,
    pub head: PullRef,
    pub base: PullRef,
}

#[derive(Deserialize)]
pub(super) struct PullRef {
    #[serde(rename = "ref")]
    pub reference: String,
    pub sha: String,
    pub repo: RepositoryIdentity,
}

#[derive(Deserialize)]
pub(super) struct Content {
    pub sha: String,
    pub content: Option<String>,
    pub encoding: Option<String>,
    #[serde(rename = "type")]
    pub kind: String,
}

#[derive(Deserialize)]
pub(super) struct Comparison {
    pub files: Option<Vec<ChangedFile>>,
}

#[derive(Deserialize)]
pub(super) struct ChangedFile {
    pub filename: String,
    pub status: String,
}

#[derive(Deserialize)]
pub(super) struct GitTree {
    pub truncated: bool,
    pub tree: Vec<GitTreeEntry>,
}

#[derive(Deserialize)]
pub(super) struct GitTreeEntry {
    pub path: String,
    pub mode: String,
    #[serde(rename = "type")]
    pub kind: String,
    pub sha: String,
}
