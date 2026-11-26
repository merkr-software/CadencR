use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use tokio::sync::RwLock;

use super::provider::{ForgeAuthSource, ForgeCredentials, ForgeError, ForgeHostConfig};
use crate::domain::git::host::GitHost;
use crate::error::AppError;

mod cli;
use cli::cached_cli_token;
pub(crate) use cli::invalidate_cli_token;

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

    pub async fn has_any_stored_tokens(&self) -> Result<bool, ForgeError> {
        if let Some(document) = self.document.read().await.as_ref() {
            return Ok(!document.tokens.is_empty());
        }
        let path = self.path()?.to_path_buf();
        let mut cached = self.document.write().await;
        if let Some(document) = cached.as_ref() {
            return Ok(!document.tokens.is_empty());
        }
        let loaded = read_document_async(path).await?;
        let has_tokens = !loaded.tokens.is_empty();
        *cached = Some(loaded);
        Ok(has_tokens)
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
        let path = self.path()?.to_path_buf();
        let mut cached = self.document.write().await;
        let mut next = load_document_cloned(&path, &mut cached).await?;
        next.tokens.insert(
            hostname,
            StoredCredential {
                token: token.to_string(),
                username: normalized_optional(username),
            },
        );
        // Persist before updating the in-memory cache so a failed write never
        // leaves memory ahead of disk.
        write_document_async(path, next.clone()).await?;
        *cached = Some(next);
        Ok(())
    }

    pub async fn delete(&self, hostname: &str) -> Result<bool, ForgeError> {
        let hostname = normalize_hostname(hostname)?;
        let path = self.path()?.to_path_buf();
        let mut cached = self.document.write().await;
        let mut next = load_document_cloned(&path, &mut cached).await?;
        let removed = next.tokens.remove(&hostname).is_some();
        if removed {
            write_document_async(path, next.clone()).await?;
            *cached = Some(next);
        }
        Ok(removed)
    }

    async fn document(&self) -> Result<TokenDocument, ForgeError> {
        if let Some(document) = self.document.read().await.as_ref() {
            return Ok(document.clone());
        }
        let path = self.path()?.to_path_buf();
        let mut cached = self.document.write().await;
        load_document_cloned(&path, &mut cached).await
    }
}

pub fn host_configs() -> Result<BTreeMap<String, ForgeHostConfig>, AppError> {
    let Some(value) = crate::domain::settings_store::global_read(FORGE_HOSTS_SETTING)? else {
        return Ok(BTreeMap::new());
    };
    serde_json::from_str(&value).map_err(|_| {
        crate::domain::settings_store::file::invalid_settings(
            "Invalid forge host settings; fix forge_hosts via \"Edit JSON\"",
        )
    })
}

pub async fn save_host_config(hostname: &str, config: ForgeHostConfig) -> Result<(), AppError> {
    let hostname = normalize_hostname(hostname).map_err(|error| forge_to_app_error(error))?;
    let mut configs = host_configs()?;
    configs.insert(hostname, config);
    let value = serde_json::to_string(&configs)
        .map_err(|error| AppError::internal(format!("serialize forge settings: {error}")))?;
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
    let Some(token) = cached_cli_token(kind, hostname).await? else {
        return Ok(None);
    };
    Ok(Some(ForgeCredentials {
        token,
        username: config.and_then(|value| value.username.clone()),
        source: ForgeAuthSource::Cli,
    }))
}

pub(super) fn normalize_hostname(hostname: &str) -> Result<String, ForgeError> {
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
#[track_caller]
pub fn forge_to_app_error(error: ForgeError) -> AppError {
    if error.is_setup_failure() {
        AppError::BadRequest(error.to_string())
    } else if matches!(error, ForgeError::Refused(_)) {
        AppError::Conflict(error.to_string())
    } else if matches!(error, ForgeError::Timeout(_)) {
        AppError::ServiceUnavailable(error.to_string())
    } else {
        AppError::internal(error.to_string())
    }
}

async fn load_document_cloned(
    path: &Path,
    cached: &mut Option<TokenDocument>,
) -> Result<TokenDocument, ForgeError> {
    if let Some(document) = cached.as_ref() {
        return Ok(document.clone());
    }
    let loaded = read_document_async(path.to_path_buf()).await?;
    *cached = Some(loaded.clone());
    Ok(loaded)
}

async fn read_document_async(path: PathBuf) -> Result<TokenDocument, ForgeError> {
    tokio::task::spawn_blocking(move || read_document(&path))
        .await
        .map_err(|error| ForgeError::Configuration(format!("read forge token file: {error}")))?
}

async fn write_document_async(path: PathBuf, document: TokenDocument) -> Result<(), ForgeError> {
    tokio::task::spawn_blocking(move || write_document(&path, &document))
        .await
        .map_err(|error| ForgeError::Configuration(format!("write forge token file: {error}")))?
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

    #[test]
    fn a_cli_timeout_is_a_retryable_503_not_a_login_prompt() {
        let error = forge_to_app_error(ForgeError::Timeout("gh did not answer".into()));
        assert!(
            matches!(&error, AppError::ServiceUnavailable(message) if message == "gh did not answer"),
            "{error:?}"
        );
    }

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
        assert!(!store.has_any_stored_tokens().await.unwrap());
        store.save("GitHub.COM", "secret", None).await.unwrap();
        assert!(store.has_any_stored_tokens().await.unwrap());
        let credentials = store
            .stored_credentials("github.com")
            .await
            .unwrap()
            .unwrap();
        assert_eq!(credentials.token, "secret");
        assert_eq!(credentials.source, ForgeAuthSource::Stored);
        assert!(store.delete("github.com").await.unwrap());
        assert!(!store.has_any_stored_tokens().await.unwrap());
        assert!(store
            .stored_credentials("github.com")
            .await
            .unwrap()
            .is_none());
    }

    #[tokio::test]
    async fn failed_write_does_not_corrupt_in_memory_document() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("forge/tokens.json");
        let store = ForgeAuthStore::new(path.clone());
        store
            .save("github.com", "original-token", None)
            .await
            .unwrap();

        // Replace the token file with a directory so subsequent atomic writes
        // to `path` fail while the in-memory document is already warm.
        std::fs::remove_file(&path).unwrap();
        std::fs::create_dir(&path).unwrap();

        assert!(store
            .save("github.com", "corrupted-token", None)
            .await
            .is_err());
        assert!(store.save("gitlab.com", "new-token", None).await.is_err());
        assert!(store.delete("github.com").await.is_err());

        let stored = store
            .stored_credentials("github.com")
            .await
            .unwrap()
            .expect("original credential must remain intact");
        assert_eq!(stored.token, "original-token");
        assert!(store
            .stored_credentials("gitlab.com")
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
