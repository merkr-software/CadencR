use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use tokio::sync::RwLock;

use super::provider::{ForgeAuthSource, ForgeCredentials, ForgeError, ForgeHostConfig};
use crate::domain::git::host::GitHost;
use crate::error::AppError;

mod cli;
use cli::{cli_output, parse_glab_token_output, stdout_token};

pub const FORGE_HOSTS_SETTING: &str = "forge_hosts";

#[derive(Debug, Clone, Serialize, Deserialize)]
struct StoredCredential {
    token: String,
    username: Option<String>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
struct TokenDocument {
    tokens: BTreeMap<String, StoredCredential>,
}

pub struct ForgeAuthStore {
    /// `Err` when no per-user data dir resolves: every token operation then
    /// fails closed instead of writing secrets relative to the working dir.
    path: Result<PathBuf, String>,
    document: RwLock<Option<TokenDocument>>,
}

impl Default for ForgeAuthStore {
    fn default() -> Self {
        Self {
            path: forge_data_dir().map(|dir| dir.join("tokens.json")),
            document: RwLock::new(None),
        }
    }
}

impl ForgeAuthStore {
    pub fn new(path: PathBuf) -> Self {
        Self {
            path: Ok(path),
            document: RwLock::new(None),
        }
    }

    fn path(&self) -> Result<&Path, ForgeError> {
        self.path.as_deref().map_err(|error| {
            ForgeError::Configuration(format!("resolve forge token directory: {error}"))
        })
    }

    pub async fn stored_credentials(
        &self,
        hostname: &str,
    ) -> Result<Option<ForgeCredentials>, ForgeError> {
        let hostname = normalize_hostname(hostname)?;
        let document = self.document().await?;
        Ok(document
            .tokens
            .get(&hostname)
            .cloned()
            .map(|stored| ForgeCredentials {
                token: stored.token,
                username: stored.username,
                source: ForgeAuthSource::Stored,
            }))
    }

    pub async fn save(
        &self,
        hostname: &str,
        token: &str,
        username: Option<String>,
    ) -> Result<(), ForgeError> {
        let hostname = normalize_hostname(hostname)?;
        let token = token.trim();
        if token.is_empty() {
            return Err(ForgeError::Authentication(
                "Forge token cannot be empty".into(),
            ));
        }
        let path = self.path()?;
        let mut cached = self.document.write().await;
        let document = load_document(path, &mut cached)?;
        document.tokens.insert(
            hostname,
            StoredCredential {
                token: token.to_string(),
                username: normalized_optional(username),
            },
        );
        write_document(path, document)
    }

    pub async fn delete(&self, hostname: &str) -> Result<bool, ForgeError> {
        let hostname = normalize_hostname(hostname)?;
        let path = self.path()?;
        let mut cached = self.document.write().await;
        let document = load_document(path, &mut cached)?;
        let removed = document.tokens.remove(&hostname).is_some();
        if removed {
            write_document(path, document)?;
        }
        Ok(removed)
    }

    async fn document(&self) -> Result<TokenDocument, ForgeError> {
        if let Some(document) = self.document.read().await.as_ref() {
            return Ok(document.clone());
        }
        let path = self.path()?;
        let mut cached = self.document.write().await;
        Ok(load_document(path, &mut cached)?.clone())
    }
}

pub fn host_configs() -> Result<BTreeMap<String, ForgeHostConfig>, AppError> {
    let Some(value) = crate::domain::settings_store::global_get(FORGE_HOSTS_SETTING) else {
        return Ok(BTreeMap::new());
    };
    serde_json::from_str(&value)
        .map_err(|error| AppError::Internal(format!("parse forge host settings: {error}")))
}

pub async fn save_host_config(hostname: &str, config: ForgeHostConfig) -> Result<(), AppError> {
    let hostname = normalize_hostname(hostname).map_err(forge_to_app_error)?;
    let mut configs = host_configs()?;
    configs.insert(hostname, config);
    let value = serde_json::to_string(&configs)
        .map_err(|error| AppError::Internal(format!("serialize forge settings: {error}")))?;
    crate::domain::settings_store::global_set(FORGE_HOSTS_SETTING, &value).await
}

pub async fn resolve_credentials(
    store: &ForgeAuthStore,
    hostname: &str,
    kind: GitHost,
    config: Option<&ForgeHostConfig>,
) -> Result<Option<ForgeCredentials>, ForgeError> {
    if let Some(mut stored) = store.stored_credentials(hostname).await? {
        if stored.username.is_none() {
            stored.username = config.and_then(|value| value.username.clone());
        }
        return Ok(Some(stored));
    }
    if !config.is_some_and(|value| value.use_cli_auth) {
        return Ok(None);
    }
    let token = match kind {
        GitHost::GitHub => {
            let output = cli_output("gh", &["auth", "token", "--hostname", hostname]).await?;
            stdout_token("gh", &output)?
        }
        GitHost::GitLab => {
            let output = cli_output(
                "glab",
                &["auth", "status", "--hostname", hostname, "--show-token"],
            )
            .await?;
            parse_glab_token_output(&output).ok_or_else(|| {
                ForgeError::Authentication(
                    "glab authenticated successfully but did not expose a token".into(),
                )
            })?
        }
        GitHost::Bitbucket => {
            return Err(ForgeError::Configuration(
                "Bitbucket has no supported CLI token source; enter an API token".into(),
            ))
        }
        GitHost::Other => {
            return Err(ForgeError::Configuration(
                "Choose a forge kind for this self-hosted remote".into(),
            ))
        }
    };
    if token.trim().is_empty() {
        return Ok(None);
    }
    Ok(Some(ForgeCredentials {
        token: token.trim().to_string(),
        username: config.and_then(|value| value.username.clone()),
        source: ForgeAuthSource::Cli,
    }))
}

pub fn normalize_hostname(hostname: &str) -> Result<String, ForgeError> {
    let hostname = hostname.trim().trim_end_matches('.').to_ascii_lowercase();
    let invalid = hostname.is_empty()
        || hostname.contains('/')
        || hostname.contains('@')
        || hostname.contains(char::is_whitespace)
        || hostname.starts_with('-');
    if invalid {
        return Err(ForgeError::Configuration(
            "Forge hostname is invalid".into(),
        ));
    }
    Ok(hostname)
}

/// A forge failure as an HTTP answer: 4xx when the user has to change something,
/// 5xx when the forge or the network is having a moment.
///
/// That is the same question [`ForgeError::is_setup_failure`] answers for the PR
/// pane, so it is asked once here rather than kept as a second exhaustive match
/// that has to be remembered whenever a variant is added.
pub fn forge_to_app_error(error: ForgeError) -> AppError {
    if error.is_setup_failure() {
        AppError::BadRequest(error.to_string())
    } else if matches!(error, ForgeError::Refused(_)) {
        AppError::Conflict(error.to_string())
    } else {
        AppError::Internal(error.to_string())
    }
}

fn read_document(path: &Path) -> Result<TokenDocument, ForgeError> {
    if !path.exists() {
        return Ok(TokenDocument::default());
    }
    crate::remote::secure_fs::ensure_owner_only(path)
        .map_err(|error| ForgeError::Configuration(format!("secure forge token file: {error}")))?;
    let bytes = std::fs::read(path)
        .map_err(|error| ForgeError::Configuration(format!("read forge token file: {error}")))?;
    serde_json::from_slice(&bytes)
        .map_err(|error| ForgeError::Configuration(format!("parse forge token file: {error}")))
}

fn load_document<'a>(
    path: &Path,
    cached: &'a mut Option<TokenDocument>,
) -> Result<&'a mut TokenDocument, ForgeError> {
    if cached.is_none() {
        *cached = Some(read_document(path)?);
    }
    Ok(cached.as_mut().expect("forge token document initialized"))
}

fn write_document(path: &Path, document: &TokenDocument) -> Result<(), ForgeError> {
    let parent = path.parent().ok_or_else(|| {
        ForgeError::Configuration("Forge token file has no parent directory".into())
    })?;
    crate::remote::secure_fs::create_dir_owner_only(parent)
        .map_err(|error| ForgeError::Configuration(format!("create forge token dir: {error}")))?;
    let bytes = serde_json::to_vec_pretty(document).map_err(|error| {
        ForgeError::Configuration(format!("serialize forge token file: {error}"))
    })?;
    crate::remote::secure_fs::write_secret(path, &bytes)
        .map_err(|error| ForgeError::Configuration(format!("write forge token file: {error}")))
}

/// `~/.cadencr/forge` on macOS, `$XDG_DATA_HOME/cadencr/forge` on Linux.
fn forge_data_dir() -> Result<PathBuf, String> {
    crate::shared::app_paths::data_dir().map(|dir| dir.join("forge"))
}

pub(super) fn normalized_optional(value: Option<String>) -> Option<String> {
    value.and_then(|value| {
        let value = value.trim().to_string();
        (!value.is_empty()).then_some(value)
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[cfg(target_os = "macos")]
    #[test]
    fn macos_keeps_tokens_under_the_legacy_root() {
        let home = dirs::home_dir().unwrap();
        assert_eq!(
            forge_data_dir().unwrap(),
            home.join(".cadencr").join("forge")
        );
    }

    #[tokio::test]
    async fn unresolvable_data_dir_fails_closed() {
        let store = ForgeAuthStore {
            path: Err("no home".into()),
            document: RwLock::new(None),
        };
        assert!(matches!(
            store.save("github.com", "secret", None).await,
            Err(ForgeError::Configuration(_))
        ));
        assert!(store.stored_credentials("github.com").await.is_err());
    }

    #[tokio::test]
    async fn token_store_round_trips_and_deletes() {
        let dir = tempfile::tempdir().unwrap();
        let store = ForgeAuthStore::new(dir.path().join("forge/tokens.json"));
        store.save("GitHub.COM", "secret", None).await.unwrap();
        let credentials = store
            .stored_credentials("github.com")
            .await
            .unwrap()
            .unwrap();
        assert_eq!(credentials.token, "secret");
        assert_eq!(credentials.source, ForgeAuthSource::Stored);
        assert!(store.delete("github.com").await.unwrap());
        assert!(store
            .stored_credentials("github.com")
            .await
            .unwrap()
            .is_none());
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn token_file_is_owner_only() {
        use std::os::unix::fs::PermissionsExt;

        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("forge/tokens.json");
        let store = ForgeAuthStore::new(path.clone());
        store.save("github.com", "secret", None).await.unwrap();
        assert_eq!(
            std::fs::metadata(path).unwrap().permissions().mode() & 0o777,
            0o600
        );
    }
}
