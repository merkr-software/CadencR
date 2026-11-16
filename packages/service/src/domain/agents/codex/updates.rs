//! Codex CLI release detection and self-update (`codex update`).
//!
//! Every Codex release, including the standalone builds, is published to npm;
//! its `latest` dist-tag is the version `codex update` installs.

use crate::domain::agents::updates::native_cli::LatestVersionFuture;
use crate::domain::agents::updates::npm::npm_dist_tag_version;

pub(crate) fn latest_version(http: &reqwest::Client) -> LatestVersionFuture<'_> {
    Box::pin(npm_dist_tag_version(http, "@openai/codex", "latest"))
}
