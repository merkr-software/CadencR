//! Release lookup through the public npm registry.
//!
//! Several agent CLIs publish every release to npm even when users install a
//! standalone build, which makes the registry a cheap, stable release feed.
//! Only the per-tag manifest is fetched: full package documents reach tens of
//! megabytes for CLIs with nightly channels.

use serde::Deserialize;

use super::UpdateError;

const REGISTRY: &str = "https://registry.npmjs.org";

#[derive(Deserialize)]
struct TaggedManifest {
    version: String,
}

/// Version currently published under `tag` (e.g. `latest`, `stable`).
pub async fn npm_dist_tag_version(
    http: &reqwest::Client,
    package: &str,
    tag: &str,
) -> Result<String, UpdateError> {
    let url = format!("{REGISTRY}/{package}/{tag}");
    let response = http
        .get(&url)
        .header(reqwest::header::ACCEPT, "application/json")
        .send()
        .await
        .map_err(|error| {
            UpdateError::failed(format!("could not reach the npm registry: {error}"))
        })?;
    if !response.status().is_success() {
        return Err(UpdateError::failed(format!(
            "npm registry answered {} for {package}@{tag}",
            response.status()
        )));
    }
    let manifest: TaggedManifest = response.json().await.map_err(|error| {
        UpdateError::failed(format!(
            "unexpected npm manifest for {package}@{tag}: {error}"
        ))
    })?;
    Ok(manifest.version)
}
