//! OpenCode release detection and self-update (`opencode upgrade`).
//!
//! `opencode upgrade` detects its own install method (curl, npm, brew…); the
//! npm `latest` dist-tag tracks the same releases: `opencode-ai` for 1.x,
//! `@opencode/cli` for 2.x (`opencode-ai` stays on the last 1.x release).

use crate::domain::agents::updates::native_cli::LatestVersionFuture;
use crate::domain::agents::updates::npm::npm_dist_tag_version;

pub(crate) fn latest_version(http: &reqwest::Client) -> LatestVersionFuture<'_> {
    Box::pin(async move {
        // The installed version check reports a CLI that cannot be resolved;
        // the release line then defaults to 1.x.
        let generation = opencode_sdk_rs::resolve_installation()
            .await
            .map_or(opencode_sdk_rs::OpenCodeGeneration::V1, |installation| {
                installation.generation
            });
        let package = match generation {
            opencode_sdk_rs::OpenCodeGeneration::V2 => "@opencode/cli",
            opencode_sdk_rs::OpenCodeGeneration::V1 => "opencode-ai",
        };
        npm_dist_tag_version(http, package, "latest").await
    })
}
