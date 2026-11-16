//! Claude Code release detection and self-update.
//!
//! Releases are published to npm under two dist-tags, and `claude update`
//! follows the `autoUpdatesChannel` from the `settings.json` of the config dir
//! it runs with (`latest` by default, or `stable`). Detection reads the same channel so
//! Cadencr never announces a version `claude update` would not install.

use crate::domain::agents::updates::native_cli::LatestVersionFuture;
use crate::domain::agents::updates::npm::npm_dist_tag_version;

const NPM_PACKAGE: &str = "@anthropic-ai/claude-code";

pub(crate) fn latest_version(http: &reqwest::Client) -> LatestVersionFuture<'_> {
    Box::pin(async move {
        let channel = configured_channel().await;
        npm_dist_tag_version(http, NPM_PACKAGE, channel).await
    })
}

async fn configured_channel() -> &'static str {
    // `claude update` runs with the service's own environment, no profile.
    let Some(path) = super::config_dir::for_env(None).map(|dir| dir.join("settings.json")) else {
        return "latest";
    };
    let Ok(contents) = tokio::fs::read(&path).await else {
        return "latest";
    };
    channel_from_settings(&contents)
}

fn channel_from_settings(contents: &[u8]) -> &'static str {
    #[derive(serde::Deserialize)]
    struct Settings {
        #[serde(rename = "autoUpdatesChannel")]
        channel: Option<String>,
    }
    match serde_json::from_slice::<Settings>(contents) {
        Ok(Settings {
            channel: Some(channel),
        }) if channel == "stable" => "stable",
        _ => "latest",
    }
}

#[cfg(test)]
mod tests {
    use super::channel_from_settings;

    #[test]
    fn follows_the_configured_release_channel() {
        assert_eq!(
            channel_from_settings(br#"{"autoUpdatesChannel":"stable"}"#),
            "stable"
        );
        assert_eq!(
            channel_from_settings(br#"{"autoUpdatesChannel":"latest"}"#),
            "latest"
        );
        assert_eq!(channel_from_settings(b"{}"), "latest");
        assert_eq!(channel_from_settings(b"not json"), "latest");
    }
}
