//! `cadencr update`.
//!
//! The desktop app updates itself (electron-updater), so for an app
//! installation the CLI only asks it to check now; its update banner then
//! downloads the update and offers to restart. A server installation has no
//! app: the CLI downloads the latest server archive from the release and
//! replaces the installation itself (`server_archive`). `--check` only
//! compares the installed version with the latest release, for both.

use std::path::Path;
use std::time::Duration;

use serde::Deserialize;

use super::connection::Connection;
use super::install::Installation;
use super::resources::bundled_app_version;
use super::{block_on, launch, usage};
use crate::{operation_error, Diagnostic};

mod server_archive;

const LATEST_RELEASE_URL: &str =
    "https://api.github.com/repos/merkr-software/cadencr/releases/latest";

#[derive(Deserialize)]
struct Release {
    tag_name: String,
    assets: Vec<Asset>,
}

#[derive(Deserialize)]
struct Asset {
    name: String,
    browser_download_url: String,
}

pub(super) fn run(check: bool, archive: Option<&Path>) -> Result<Option<String>, Diagnostic> {
    let installation = Installation::detect()?;
    if check {
        return block_on(check_latest(&installed_version(&installation)?))?;
    }
    Connection::refuse_running("Stop `cadencr serve`, update, then start it again.")?;
    match installation {
        Installation::Server { root, version } => match archive {
            Some(archive) => server_archive::install_local(&root, &version, archive),
            None => block_on(update_server(&root, &version))?,
        },
        Installation::App { .. } | Installation::AppImage { .. } => {
            if archive.is_some() {
                return Err(usage("--archive only applies to a server installation"));
            }
            launch::update()?;
            Ok(Some(
                "CadencR is checking for updates; follow the download and restart in its window."
                    .to_string(),
            ))
        }
    }
}

fn installed_version(installation: &Installation) -> Result<String, Diagnostic> {
    match installation {
        Installation::Server { version, .. } => Ok(version.clone()),
        Installation::App { .. } | Installation::AppImage { .. } => bundled_app_version()
            .ok_or_else(|| {
                operation_error(
                    "CLI_UPDATE_UNAVAILABLE",
                    "this cadencr command was not built with a CadencR release",
                )
            }),
    }
}

async fn check_latest(current: &str) -> Result<Option<String>, Diagnostic> {
    let (_, latest) = latest_release(&client()?).await?;
    Ok(Some(if is_newer(&latest, current)? {
        format!(
            "CadencR {latest} is available (installed: {current}). Run `cadencr update` to install it."
        )
    } else {
        format!("CadencR {current} is up to date.")
    }))
}

async fn update_server(root: &Path, current: &str) -> Result<Option<String>, Diagnostic> {
    let client = client()?;
    let (release, latest) = latest_release(&client).await?;
    if !is_newer(&latest, current)? {
        return Ok(Some(format!("CadencR {current} is up to date.")));
    }
    let name = server_archive::asset_name(&latest)?;
    let archive = asset_url(&release, &name)?;
    let checksum = asset_url(&release, &format!("{name}.sha256"))?;
    let expected = parse_checksum(&fetch_text(&client, &checksum).await?, &name)?;
    let download = server_archive::download(&client, &archive, root, &expected).await?;
    let outcome = server_archive::install(root, &download.path, Some(&latest));
    server_archive::remove_file(&download.path)?;
    outcome?;
    Ok(Some(format!(
        "Updated CadencR from {current} to {latest}. Start it again with `cadencr serve`."
    )))
}

fn client() -> Result<reqwest::Client, Diagnostic> {
    reqwest::Client::builder()
        .user_agent(concat!("cadencr-cli/", env!("CADENCR_CLI_VERSION")))
        .connect_timeout(Duration::from_secs(30))
        .build()
        .map_err(|error| operation_error("CLI_UPDATE_FAILED", error))
}

/// The latest release and its version.
async fn latest_release(client: &reqwest::Client) -> Result<(Release, String), Diagnostic> {
    let release: Release = fetch_json(client, LATEST_RELEASE_URL).await?;
    let latest = release.tag_name.trim_start_matches('v').to_string();
    Ok((release, latest))
}

fn is_newer(candidate: &str, current: &str) -> Result<bool, Diagnostic> {
    Ok(
        parse_version(candidate)?.cmp_precedence(&parse_version(current)?)
            == std::cmp::Ordering::Greater,
    )
}

fn parse_version(text: &str) -> Result<semver::Version, Diagnostic> {
    semver::Version::parse(text)
        .map_err(|error| operation_error("CLI_UPDATE_FAILED", format!("version {text:?}: {error}")))
}

fn asset_url(release: &Release, name: &str) -> Result<String, Diagnostic> {
    release
        .assets
        .iter()
        .find(|asset| asset.name == name)
        .map(|asset| asset.browser_download_url.clone())
        .ok_or_else(|| {
            operation_error(
                "CLI_UPDATE_UNAVAILABLE",
                format!("release {} has no {name}", release.tag_name),
            )
        })
}

/// A `sha256sum` line for exactly this asset.
fn parse_checksum(text: &str, name: &str) -> Result<String, Diagnostic> {
    text.lines()
        .filter_map(|line| line.split_once("  "))
        .find(|(_, file)| file.trim() == name)
        .map(|(digest, _)| digest.to_ascii_lowercase())
        .filter(|digest| digest.len() == 64 && digest.bytes().all(|b| b.is_ascii_hexdigit()))
        .ok_or_else(|| {
            operation_error(
                "CLI_UPDATE_FAILED",
                format!("the checksum file has no valid SHA-256 for {name}"),
            )
        })
}

async fn fetch_json<T: serde::de::DeserializeOwned>(
    client: &reqwest::Client,
    url: &str,
) -> Result<T, Diagnostic> {
    serde_json::from_str(&fetch_text(client, url).await?)
        .map_err(|error| operation_error("CLI_UPDATE_FAILED", format!("{url}: {error}")))
}

async fn fetch_text(client: &reqwest::Client, url: &str) -> Result<String, Diagnostic> {
    let failed =
        |error: reqwest::Error| operation_error("CLI_UPDATE_FAILED", format!("{url}: {error}"));
    client
        .get(url)
        .timeout(Duration::from_secs(60))
        .send()
        .await
        .and_then(reqwest::Response::error_for_status)
        .map_err(failed)?
        .text()
        .await
        .map_err(failed)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn orders_releases_and_prereleases() {
        assert!(is_newer("0.17.0", "0.16.9").unwrap());
        assert!(is_newer("0.16.10", "0.16.9").unwrap());
        assert!(!is_newer("0.16.1", "0.16.1").unwrap());
        assert!(!is_newer("0.16.0", "0.16.1").unwrap());
        assert!(is_newer("0.17.0", "0.17.0-beta.1").unwrap());
        assert!(is_newer("0.17.0-beta.10", "0.17.0-beta.9").unwrap());
        assert!(!is_newer("0.17.0+build", "0.17.0").unwrap());
        assert!(is_newer("v1.0.0", "0.1.0").is_err());
        assert!(is_newer("1.0", "0.1.0").is_err());
    }

    #[test]
    fn checksums_match_the_exact_asset() {
        let digest = "a".repeat(64);
        let text = format!("{digest}  cadencr-server-1.0.0-linux-x64.tar.gz\n");
        assert_eq!(
            parse_checksum(&text, "cadencr-server-1.0.0-linux-x64.tar.gz").unwrap(),
            digest
        );
        assert!(parse_checksum(&text, "other.tar.gz").is_err());
        assert!(parse_checksum("xyz  cadencr.tar.gz\n", "cadencr.tar.gz").is_err());
    }

    #[test]
    fn a_missing_asset_is_reported() {
        let release = Release {
            tag_name: "v1.0.0".into(),
            assets: vec![Asset {
                name: "a".into(),
                browser_download_url: "https://example.invalid/a".into(),
            }],
        };
        assert_eq!(
            asset_url(&release, "a").unwrap(),
            "https://example.invalid/a"
        );
        assert_eq!(
            asset_url(&release, "b").unwrap_err().code,
            "CLI_UPDATE_UNAVAILABLE"
        );
    }
}
