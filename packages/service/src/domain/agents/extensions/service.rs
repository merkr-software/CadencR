//! Which providers carry extensions, their resolved CLIs, and the caches the
//! extension endpoints share.

use std::collections::HashMap;
use std::future::Future;
use std::sync::{Arc, LazyLock, PoisonError};
use std::time::{Duration, Instant};

use sqlx::SqlitePool;
use tokio::sync::{Mutex, OwnedMutexGuard};

use super::mcp_registry::{McpRegistry, RegistryEntry};
use super::skills_service::SkillSnapshot;
use super::types::{ExtensionCliSummary, ExtensionSupport, McpInventoryResponse};
use super::{CliRunner, ExtensionCli, ExtensionError};
use crate::domain::agents::providers::provider_registry;

const HOST_TTL: Duration = Duration::from_secs(5 * 60);
pub const SKILLS_TTL: Duration = Duration::from_secs(10 * 60);
pub const MCP_TTL: Duration = Duration::from_secs(5 * 60);
pub const MATCH_TTL: Duration = Duration::from_secs(30 * 60);
/// A snapshot in which a CLI failed is retried soon, not after the full TTL.
pub const FAILED_TTL: Duration = Duration::from_secs(30);

/// A provider whose CLI manages extensions.
#[derive(Debug, Clone)]
pub struct ExtensionHost {
    pub provider_id: String,
    pub label: String,
    /// `None`: the CLI is not installed on this computer.
    pub cli: Option<CliRunner>,
    pub extensions: Arc<dyn ExtensionCli>,
}

impl ExtensionHost {
    pub fn summary(&self) -> ExtensionCliSummary {
        ExtensionCliSummary {
            provider_id: self.provider_id.clone(),
            label: self.label.clone(),
            installed: self.cli.is_some(),
            version: self.cli.as_ref().and_then(|cli| cli.version.clone()),
            support: self.extensions.support(),
        }
    }

    pub fn support(&self) -> ExtensionSupport {
        self.extensions.support()
    }

    /// The CLI to run as its active profile runs it, or why there is none.
    /// Take it once per operation, after the CLI's lock.
    pub fn runner(&self) -> Result<CliRunner, ExtensionError> {
        let cli = self.cli.as_ref().ok_or_else(|| {
            ExtensionError::Unsupported(format!(
                "{} is not installed on this computer.",
                self.label
            ))
        })?;
        self.extensions.for_active_profile(cli)
    }
}

pub struct Cached<T> {
    at: Instant,
    ttl: Duration,
    expired: bool,
    pub value: T,
}

impl<T: Clone> Cached<T> {
    pub fn new(value: T, ttl: Duration) -> Self {
        Self {
            at: Instant::now(),
            ttl,
            expired: false,
            value,
        }
    }

    pub fn fresh(&self) -> Option<T> {
        (!self.expired && self.at.elapsed() < self.ttl).then(|| self.value.clone())
    }

    pub fn expire(&mut self) {
        self.expired = true;
    }
}

pub struct ExtensionsService {
    pub registry: McpRegistry,
    hosts: Mutex<Option<Cached<Vec<ExtensionHost>>>>,
    pub skills: Mutex<Option<Cached<Arc<SkillSnapshot>>>>,
    /// Every CLI's MCP servers (listing health-checks each one).
    pub mcp: Mutex<Option<Cached<McpInventoryResponse>>>,
    /// Registry match per installed server identity (`None`: not listed).
    pub matches: Mutex<HashMap<String, Cached<Option<RegistryEntry>>>>,
    /// One lock per CLI: two CLIs writing their configs concurrently is fine,
    /// one CLI racing itself (remove-then-add, a refresh during an install)
    /// is not.
    cli_locks: std::sync::Mutex<HashMap<String, Arc<Mutex<()>>>>,
}

static SERVICE: LazyLock<ExtensionsService> = LazyLock::new(|| {
    let http = reqwest::Client::builder()
        .timeout(Duration::from_secs(20))
        .user_agent(concat!("Cadencr/", env!("CARGO_PKG_VERSION")))
        .build()
        .unwrap_or_default();
    ExtensionsService {
        registry: McpRegistry::new(http),
        hosts: Mutex::new(None),
        skills: Mutex::new(None),
        mcp: Mutex::new(None),
        matches: Mutex::new(HashMap::new()),
        cli_locks: std::sync::Mutex::new(HashMap::new()),
    }
});

pub fn service() -> &'static ExtensionsService {
    &SERVICE
}

impl ExtensionsService {
    /// Every provider with extension support, in registry order.
    pub async fn hosts(&self, read_pool: &SqlitePool) -> Vec<ExtensionHost> {
        let mut cached = self.hosts.lock().await;
        if let Some(hosts) = cached.as_ref().and_then(Cached::fresh) {
            return hosts;
        }
        let candidates: Vec<_> = provider_registry()
            .iter()
            .filter_map(|provider| {
                let metadata = provider.metadata();
                Some((
                    provider.id().to_string(),
                    provider.adapter().catalog_entry().label.clone(),
                    metadata.discovery()?.clone(),
                    metadata.extensions()?.clone(),
                ))
            })
            .collect();
        let hosts = futures::future::join_all(candidates.into_iter().map(
            |(provider_id, label, discovery, extensions)| async move {
                ExtensionHost {
                    cli: CliRunner::resolve(read_pool, &discovery).await,
                    provider_id,
                    label,
                    extensions,
                }
            },
        ))
        .await;
        *cached = Some(Cached::new(hosts.clone(), HOST_TTL));
        hosts
    }

    pub async fn host(
        &self,
        read_pool: &SqlitePool,
        provider_id: &str,
    ) -> Result<ExtensionHost, ExtensionError> {
        self.hosts(read_pool)
            .await
            .into_iter()
            .find(|host| host.provider_id == provider_id)
            .ok_or_else(|| {
                ExtensionError::Invalid(format!(
                    "{provider_id} does not manage skills or MCP servers"
                ))
            })
    }

    /// Held while one CLI changes or refreshes what it has installed.
    pub async fn lock_cli(&self, provider_id: &str) -> OwnedMutexGuard<()> {
        let lock = self
            .cli_locks
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .entry(provider_id.to_string())
            .or_default()
            .clone();
        lock.lock_owned().await
    }

    /// Re-read every CLI next time, keeping the old snapshot to borrow from.
    pub async fn invalidate_skills(&self) {
        if let Some(cached) = self.skills.lock().await.as_mut() {
            cached.expire();
        }
    }

    pub async fn invalidate_mcp(&self) {
        *self.mcp.lock().await = None;
    }
}

/// Run a change to completion even when the request that started it goes
/// away: dropping it halfway would kill the CLI between a remove and the
/// re-add that follows.
pub async fn detached<T: Send + 'static>(
    change: impl Future<Output = Result<T, ExtensionError>> + Send + 'static,
) -> Result<T, ExtensionError> {
    tokio::spawn(change).await.map_err(|error| {
        ExtensionError::failed(format!("The change stopped unexpectedly: {error}"))
    })?
}
