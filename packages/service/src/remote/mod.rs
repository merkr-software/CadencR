//! Remote access: a second axum listener bound on `0.0.0.0:<remote_port>` over
//! self-signed TLS that serves the existing API plus the built SPA, so another
//! device can use the workspace. Started/stopped at runtime and torn down on
//! quit. The loopback listener (the local `file://` renderer) is untouched.

pub mod live;
mod net;
pub mod pairing;
pub mod paths;
mod secrets;
pub(crate) mod secure_fs;
mod spa;
mod tls;
mod tunnel;

pub use spa::spa_service;
pub use tunnel::{load_tunnel_host, sanitize_tunnel_host};

use std::net::{IpAddr, SocketAddr};
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;

use tokio::sync::Mutex;
use tokio::task::JoinHandle;

use crate::app_state::AppState;
use live::LiveSessions;
use pairing::PairingCodes;
use tunnel::{allowed_hosts, allowed_origins};

/// Per-listener context baked into the remote router at `start` and read by the
/// remote auth middleware and WebSocket handlers. Its presence (via an
/// `Extension`) is also how shared handlers tell the remote listener apart from
/// the loopback one.
#[derive(Clone)]
pub struct RemoteContext {
    /// Exact `Host` values accepted on the remote listener (DNS-rebinding
    /// defense). Never a wildcard.
    pub allowed_hosts: Arc<Vec<String>>,
    /// Exact `Origin` values accepted on remote WebSocket upgrades.
    pub allowed_origins: Arc<Vec<String>>,
    /// Pepper for device-token hashing.
    pub pepper: Arc<Vec<u8>>,
}

/// Setting key persisting whether remote access auto-starts at launch.
pub const REMOTE_ENABLED_SETTING: &str = "remote_access_enabled";

/// Setting key holding an optional tunnel hostname (e.g. Tailscale). When set,
/// it's added to the `Host`/`Origin` allowlist so tunneled requests aren't 421'd.
pub const REMOTE_TUNNEL_HOST_SETTING: &str = "remote_tunnel_host";

/// How long the remote listener gets to drain in-flight connections on stop.
/// Kept under the desktop shell's 2 s SIGTERM grace (`sidecar.ts`) so quit
/// isn't truncated by a hung remote WebSocket.
const GRACEFUL_SHUTDOWN: Duration = Duration::from_millis(1500);

/// Immutable wiring the controller needs to bring a listener up.
#[derive(Clone)]
pub struct RemoteConfig {
    /// Built SPA directory; `None` in dev (Vite serves the renderer).
    pub renderer_dir: Option<PathBuf>,
    /// Port for the `0.0.0.0` TLS listener.
    pub remote_port: u16,
    /// Where cert/key/pepper live (`~/.cadencr/remote/`).
    pub data_dir: PathBuf,
}

/// What the host UI needs to render the connect screen.
#[derive(Debug, Clone)]
pub struct RemoteInfo {
    pub fingerprint: String,
    pub port: u16,
    pub lan_ips: Vec<IpAddr>,
}

#[derive(Debug)]
pub enum RemoteError {
    /// No SPA dir — remote serving only works in packaged builds.
    NoRendererDir,
    /// The SPA dir is set but has no built `index.html`. Starting anyway would
    /// serve empty 404s for every page load — which browsers download as a
    /// 0-byte file rather than show as an error — so we refuse loudly instead.
    /// Typically means the frontend wasn't built into the renderer dir yet.
    RendererIndexMissing(PathBuf),
    Tls(anyhow::Error),
    /// Loading/generating the device-token pepper failed.
    Secrets(anyhow::Error),
    /// The listener failed to bind (e.g. the port is already in use).
    BindFailed,
}

impl std::fmt::Display for RemoteError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            RemoteError::NoRendererDir => {
                write!(
                    f,
                    "remote access requires a packaged build (no renderer dir)"
                )
            }
            RemoteError::RendererIndexMissing(path) => {
                write!(
                    f,
                    "remote access needs a built frontend: no index.html at {}",
                    path.display()
                )
            }
            RemoteError::Tls(err) => write!(f, "TLS setup failed: {err}"),
            RemoteError::Secrets(err) => write!(f, "secret setup failed: {err}"),
            RemoteError::BindFailed => {
                write!(f, "could not bind the remote listener (port may be in use)")
            }
        }
    }
}

impl std::error::Error for RemoteError {}

#[derive(Default)]
struct RemoteRuntime {
    handle: Option<axum_server::Handle<SocketAddr>>,
    join: Option<JoinHandle<()>>,
    info: Option<RemoteInfo>,
}

/// Owns the lifecycle of the remote listener. Stored as `Arc<RemoteController>`
/// in `AppState` (interior-mutable via the `Mutex`), mirroring the other shared
/// registries.
pub struct RemoteController {
    config: RemoteConfig,
    runtime: Mutex<RemoteRuntime>,
    pairing: PairingCodes,
    live: Arc<LiveSessions>,
}

impl RemoteController {
    pub fn new(config: RemoteConfig) -> Self {
        Self {
            config,
            runtime: Mutex::new(RemoteRuntime::default()),
            pairing: PairingCodes::default(),
            live: Arc::new(LiveSessions::default()),
        }
    }

    /// Pairing-code store shared between the loopback `pairing-code` endpoint
    /// (mint) and the remote `pair` endpoint (consume).
    pub fn pairing(&self) -> &PairingCodes {
        &self.pairing
    }

    /// Live remote-session registry, used to force-close a device's open
    /// sockets on revoke.
    pub fn live(&self) -> Arc<LiveSessions> {
        Arc::clone(&self.live)
    }

    /// Start the listener. Idempotent: returns the current info if already
    /// running. Requires a renderer dir (packaged build).
    pub async fn start(&self, state: &AppState) -> Result<RemoteInfo, RemoteError> {
        let mut rt = self.runtime.lock().await;
        if let Some(info) = &rt.info {
            return Ok(info.clone());
        }

        let renderer_dir = resolve_renderer_dir(self.config.renderer_dir.as_deref())?;

        let lan_ips = net::lan_ipv4s();
        let tls = tls::load_or_generate(&self.config.data_dir, cert_sans(&lan_ips))
            .await
            .map_err(RemoteError::Tls)?;
        let pepper = secrets::load_or_generate_pepper(&self.config.data_dir)
            .map_err(RemoteError::Secrets)?;

        // Bind the TCP socket up front so the real port is known *before* the
        // router (and its `Host` allowlist) is built: with `remote_port = 0` the
        // OS assigns the port, and the allowlist must carry the bound port or
        // every request is 421'd. Binding here also surfaces "port in use"
        // synchronously instead of racing the serve task.
        let addr = SocketAddr::from(([0, 0, 0, 0], self.config.remote_port));
        let listener = std::net::TcpListener::bind(addr).map_err(|err| {
            tracing::error!("remote listener failed to bind {addr}: {err}");
            RemoteError::BindFailed
        })?;
        let bound_addr = listener.local_addr().map_err(|_| RemoteError::BindFailed)?;
        listener.set_nonblocking(true).map_err(|err| {
            tracing::error!("remote listener failed to enter nonblocking mode: {err}");
            RemoteError::BindFailed
        })?;
        let port = bound_addr.port();

        let tunnel_host = load_tunnel_host(&state.read_pool).await;
        let context = RemoteContext {
            allowed_hosts: Arc::new(allowed_hosts(&lan_ips, port, tunnel_host.as_deref())),
            allowed_origins: Arc::new(allowed_origins(&lan_ips, port, tunnel_host.as_deref())),
            pepper: Arc::new(pepper),
        };

        let router = crate::api::build_remote_router(state.clone(), &renderer_dir, context);
        let handle = axum_server::Handle::<SocketAddr>::new();
        let server_handle = handle.clone();
        let config = tls.config;

        let join = tokio::spawn(async move {
            // `from_tcp_rustls` reuses the already-bound listener (so the port
            // can't drift from the allowlist). `with_connect_info` lets the
            // rate-limit middleware read each request's source IP.
            let server = match axum_server::from_tcp_rustls(listener, config) {
                Ok(server) => server,
                Err(err) => {
                    tracing::error!("remote listener failed to start: {err}");
                    return;
                }
            };
            let result = server
                .handle(server_handle)
                .serve(router.into_make_service_with_connect_info::<SocketAddr>())
                .await;
            if let Err(err) = result {
                tracing::error!("remote listener stopped with error: {err}");
            }
        });

        let info = RemoteInfo {
            fingerprint: tls.fingerprint,
            port,
            lan_ips,
        };
        tracing::info!("remote access listening on {bound_addr}");
        rt.handle = Some(handle);
        rt.join = Some(join);
        rt.info = Some(info.clone());
        Ok(info)
    }

    /// Stop the listener (graceful, bounded) and clear state. No-op when off.
    pub async fn stop(&self) {
        let mut rt = self.runtime.lock().await;
        if let Some(handle) = rt.handle.take() {
            handle.graceful_shutdown(Some(GRACEFUL_SHUTDOWN));
        }
        if let Some(join) = rt.join.take() {
            let _ = join.await;
        }
        if rt.info.take().is_some() {
            tracing::info!("remote access stopped");
        }
    }

    /// Current listener info, or `None` when off.
    pub async fn status(&self) -> Option<RemoteInfo> {
        self.runtime.lock().await.info.clone()
    }
}

/// Resolve the SPA dir for serving, refusing if it's unset (dev / non-packaged)
/// or set but missing a built `index.html`. Both cases would otherwise leave the
/// SPA fallback returning empty, type-less 404s for every page load, which a
/// browser surfaces as a 0-byte file download instead of a usable error.
fn resolve_renderer_dir(renderer_dir: Option<&Path>) -> Result<PathBuf, RemoteError> {
    let dir = renderer_dir.ok_or(RemoteError::NoRendererDir)?;
    let index = dir.join("index.html");
    if !index.is_file() {
        return Err(RemoteError::RendererIndexMissing(index));
    }
    Ok(dir.to_path_buf())
}

/// SANs for the self-signed cert: loopback plus each detected LAN IP. Cosmetic
/// for TOFU (the browser warns regardless), but keeps the warning honest.
fn cert_sans(lan_ips: &[IpAddr]) -> Vec<String> {
    let mut sans = vec!["localhost".to_string(), "127.0.0.1".to_string()];
    sans.extend(lan_ips.iter().map(IpAddr::to_string));
    sans
}

/// Whether remote access should auto-start at launch (persisted setting).
pub async fn is_enabled(pool: &sqlx::SqlitePool) -> bool {
    matches!(
        crate::domain::workspace::repository::get_setting(pool, REMOTE_ENABLED_SETTING).await,
        Ok(Some(value)) if value == "true"
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn renderer_dir_must_contain_index_html() {
        // Unset (dev / non-packaged) → NoRendererDir.
        assert!(matches!(
            resolve_renderer_dir(None),
            Err(RemoteError::NoRendererDir)
        ));

        // Set but no built index.html (e.g. the frontend wasn't built into the
        // dir) → refuse, rather than start and serve 0-byte 404 "downloads".
        let dir = tempfile::tempdir().unwrap();
        assert!(matches!(
            resolve_renderer_dir(Some(dir.path())),
            Err(RemoteError::RendererIndexMissing(_))
        ));

        // A real built SPA dir resolves.
        std::fs::write(dir.path().join("index.html"), "<!doctype html>").unwrap();
        assert_eq!(
            resolve_renderer_dir(Some(dir.path())).unwrap(),
            dir.path().to_path_buf()
        );
    }
}
