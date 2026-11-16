//! OpenCode release detection and self-update (`opencode upgrade`).
//!
//! `opencode upgrade` detects its own install method (curl, npm, brew…); the
//! npm `latest` dist-tag of `opencode-ai` tracks the same releases.

use crate::domain::agents::updates::native_cli::LatestVersionFuture;
use crate::domain::agents::updates::npm::npm_dist_tag_version;

pub(crate) fn latest_version(http: &reqwest::Client) -> LatestVersionFuture<'_> {
    Box::pin(npm_dist_tag_version(http, "opencode-ai", "latest"))
}
