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

use axum_server::tls_rustls::RustlsAcceptor;
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
    /// Tunnel authority accepted by this running listener, fixed at startup.
    pub tunnel_host: Option<String>,
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
    /// The TLS server could not be built on the bound socket, or its serve
    /// task exited before it started accepting connections.
    ServeFailed(std::io::Error),
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
            RemoteError::ServeFailed(err) => {
                write!(f, "remote listener failed to start: {err}")
            }
        }
    }
}

impl std::error::Error for RemoteError {}

type ServeTask = JoinHandle<std::io::Result<()>>;

#[derive(Default)]
struct RemoteRuntime {
    handle: Option<axum_server::Handle<SocketAddr>>,
    join: Option<ServeTask>,
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
    /// running. Requires a renderer dir (packaged build). Returns only once the
    /// serve task is accepting connections, so a startup failure is an `Err`
    /// here and never a "running" status.
    pub async fn start(&self, state: &AppState) -> Result<RemoteInfo, RemoteError> {
        let mut rt = self.runtime.lock().await;
        self.start_locked(&mut rt, state).await
    }

    /// Stop the listener and clear state. No-op when off. Force-closes every
    /// live remote WebSocket: upgraded sockets are no longer tracked by the
    /// server, so graceful shutdown alone would leave them open.
    pub async fn stop(&self) {
        let mut rt = self.runtime.lock().await;
        self.stop_locked(&mut rt).await;
    }

    /// Restart a running listener so it picks up new configuration; `Ok(None)`
    /// when it isn't running. The lock is held across stop + start so a
    /// concurrent enable/disable can't interleave. On `Err` the listener is off.
    pub async fn restart(&self, state: &AppState) -> Result<Option<RemoteInfo>, RemoteError> {
        let mut rt = self.runtime.lock().await;
        self.reap_exited(&mut rt);
        if rt.info.is_none() {
            return Ok(None);
        }
        self.stop_locked(&mut rt).await;
        self.start_locked(&mut rt, state).await.map(Some)
    }

    /// Current listener info, or `None` when off (including when the serve
    /// task has exited on its own since it started).
    pub async fn status(&self) -> Option<RemoteInfo> {
        let mut rt = self.runtime.lock().await;
        self.reap_exited(&mut rt);
        rt.info.clone()
    }

    async fn start_locked(
        &self,
        rt: &mut RemoteRuntime,
        state: &AppState,
    ) -> Result<RemoteInfo, RemoteError> {
        self.reap_exited(rt);
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

        let (listener, bound_addr) = bind_listener(self.config.remote_port)?;
        let port = bound_addr.port();

        let tunnel_host = load_tunnel_host(&state.read_pool).await;
        let context = RemoteContext {
            allowed_hosts: Arc::new(allowed_hosts(&lan_ips, port, tunnel_host.as_deref())),
            allowed_origins: Arc::new(allowed_origins(&lan_ips, port, tunnel_host.as_deref())),
            pepper: Arc::new(pepper),
        };
        let router = crate::api::build_remote_router(state.clone(), &renderer_dir, context);

        // `from_tcp_rustls` reuses the already-bound listener (so the port
        // can't drift from the allowlist). Built here rather than in the serve
        // task so its failure reaches the caller.
        let server = axum_server::from_tcp_rustls(listener, tls.config).map_err(|err| {
            tracing::error!("remote listener failed to start: {err}");
            RemoteError::ServeFailed(err)
        })?;
        let handle = axum_server::Handle::<SocketAddr>::new();
        // Sessions upgraded on this listener must not be born cancelled by the
        // previous listener's stop.
        self.live.reopen();
        let mut join = tokio::spawn(serve(server, handle.clone(), router));
        if let Err(err) = wait_until_listening(&handle, &mut join).await {
            self.live.cancel_all();
            return Err(err);
        }

        let info = RemoteInfo {
            fingerprint: tls.fingerprint,
            port,
            lan_ips,
            tunnel_host,
        };
        tracing::info!("remote access listening on {bound_addr}");
        rt.handle = Some(handle);
        rt.join = Some(join);
        rt.info = Some(info.clone());
        Ok(info)
    }

    async fn stop_locked(&self, rt: &mut RemoteRuntime) {
        // Close upgraded sockets first; they don't hold up graceful shutdown.
        self.live.cancel_all();
        if let Some(handle) = rt.handle.take() {
            handle.graceful_shutdown(Some(GRACEFUL_SHUTDOWN));
        }
        // A serve error is logged by the task itself; only a panic is left.
        if let Some(join) = rt.join.take() {
            if let Err(err) = join.await {
                tracing::error!("remote listener task failed: {err}");
            }
        }
        if rt.info.take().is_some() {
            tracing::info!("remote access stopped");
        }
    }

    /// Clear the runtime if the serve task exited on its own (serve error or
    /// panic), closing the sockets it upgraded, so status stops reporting a
    /// listener that is no longer accepting connections.
    fn reap_exited(&self, rt: &mut RemoteRuntime) {
        if !rt.join.as_ref().is_some_and(JoinHandle::is_finished) {
            return;
        }
        tracing::error!("remote listener exited unexpectedly; marking remote access off");
        self.live.cancel_all();
        rt.handle = None;
        rt.join = None;
        rt.info = None;
    }
}

/// Bind the TCP socket up front so the real port is known *before* the router
/// (and its `Host` allowlist) is built: with `remote_port = 0` the OS assigns
/// the port, and the allowlist must carry the bound port or every request is
/// 421'd. Binding here also surfaces "port in use" synchronously.
fn bind_listener(remote_port: u16) -> Result<(std::net::TcpListener, SocketAddr), RemoteError> {
    let addr = SocketAddr::from(([0, 0, 0, 0], remote_port));
    let listener = std::net::TcpListener::bind(addr).map_err(|err| {
        tracing::error!("remote listener failed to bind {addr}: {err}");
        RemoteError::BindFailed
    })?;
    let bound_addr = listener.local_addr().map_err(|err| {
        tracing::error!("remote listener has no local address: {err}");
        RemoteError::BindFailed
    })?;
    listener.set_nonblocking(true).map_err(|err| {
        tracing::error!("remote listener failed to enter nonblocking mode: {err}");
        RemoteError::BindFailed
    })?;
    Ok((listener, bound_addr))
}

/// The serve task. `with_connect_info` lets the rate-limit middleware read each
/// request's source IP.
async fn serve(
    server: axum_server::Server<SocketAddr, RustlsAcceptor>,
    handle: axum_server::Handle<SocketAddr>,
    router: axum::Router,
) -> std::io::Result<()> {
    let result = server
        .handle(handle)
        .serve(router.into_make_service_with_connect_info::<SocketAddr>())
        .await;
    if let Err(err) = &result {
        tracing::error!("remote listener stopped with error: {err}");
    }
    result
}

/// Resolve once the serve task is accepting connections, or with the reason it
/// exited first.
async fn wait_until_listening(
    handle: &axum_server::Handle<SocketAddr>,
    join: &mut ServeTask,
) -> Result<SocketAddr, RemoteError> {
    tokio::select! {
        listening = handle.listening() => match listening {
            Some(addr) => Ok(addr),
            // The server reports `None` only when its setup failed; the task
            // then returns that error.
            None => Err(serve_exit_error(join.await)),
        },
        exited = &mut *join => Err(serve_exit_error(exited)),
    }
}

fn serve_exit_error(exited: Result<std::io::Result<()>, tokio::task::JoinError>) -> RemoteError {
    let err = match exited {
        Ok(Err(err)) => err,
        Ok(Ok(())) => std::io::Error::other("serve task exited before listening"),
        Err(join_err) => std::io::Error::other(format!("serve task failed: {join_err}")),
    };
    RemoteError::ServeFailed(err)
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

    /// A controller over a built renderer dir and an OS-assigned port. The
    /// returned dirs must outlive the test.
    async fn test_state(remote_port: u16) -> (AppState, tempfile::TempDir, tempfile::TempDir) {
        let renderer = tempfile::tempdir().unwrap();
        std::fs::write(renderer.path().join("index.html"), "<!doctype html>").unwrap();
        let data = tempfile::tempdir().unwrap();
        let pool = sqlx::SqlitePool::connect("sqlite::memory:").await.unwrap();
        let mut state = AppState::with_pool(pool);
        state.remote = Arc::new(RemoteController::new(RemoteConfig {
            renderer_dir: Some(renderer.path().to_owned()),
            remote_port,
            data_dir: data.path().to_owned(),
        }));
        (state, renderer, data)
    }

    #[tokio::test]
    async fn stop_force_closes_live_remote_sessions() {
        let (state, _renderer, _data) = test_state(0).await;
        state.remote.start(&state).await.unwrap();
        let (open_socket, _) = state.remote.live().register(1);

        state.remote.stop().await;

        assert!(open_socket.token.is_cancelled());
        assert!(state.remote.status().await.is_none());
        // An upgrade still in flight when the listener stopped is closed as it
        // registers.
        let (late, _) = state.remote.live().register(1);
        assert!(late.token.is_cancelled());

        // A new listener accepts sessions again.
        state.remote.start(&state).await.unwrap();
        let (fresh, _) = state.remote.live().register(1);
        assert!(!fresh.token.is_cancelled());
        state.remote.stop().await;
        assert!(fresh.token.is_cancelled());
    }

    #[tokio::test]
    async fn start_reports_bind_failure_and_stays_off() {
        let taken = std::net::TcpListener::bind("0.0.0.0:0").unwrap();
        let port = taken.local_addr().unwrap().port();
        let (state, _renderer, _data) = test_state(port).await;

        let result = state.remote.start(&state).await;

        assert!(matches!(result, Err(RemoteError::BindFailed)));
        assert!(state.remote.status().await.is_none());
    }

    #[tokio::test]
    async fn startup_error_from_the_serve_task_reaches_the_caller() {
        let handle = axum_server::Handle::<SocketAddr>::new();
        let mut join: ServeTask =
            tokio::spawn(async { Err(std::io::Error::other("tls acceptor exploded")) });

        let result = wait_until_listening(&handle, &mut join).await;

        match result {
            Err(RemoteError::ServeFailed(err)) => {
                assert!(err.to_string().contains("tls acceptor exploded"));
            }
            other => panic!("expected ServeFailed, got {other:?}"),
        }
    }

    #[tokio::test]
    async fn status_reports_off_once_the_serve_task_exits() {
        let (state, _renderer, _data) = test_state(0).await;
        state.remote.start(&state).await.unwrap();
        let (open_socket, _) = state.remote.live().register(1);
        {
            let mut rt = state.remote.runtime.lock().await;
            rt.handle.as_ref().unwrap().shutdown();
            let join = rt.join.as_mut().unwrap();
            join.await.unwrap().unwrap();
        }

        assert!(state.remote.status().await.is_none());
        assert!(open_socket.token.is_cancelled());
        // `start` brings a fresh listener up instead of returning stale info.
        state.remote.start(&state).await.unwrap();
        assert!(state.remote.status().await.is_some());
        state.remote.stop().await;
    }

    #[tokio::test]
    async fn failed_restart_leaves_the_listener_off() {
        let (state, renderer, _data) = test_state(0).await;
        state.remote.start(&state).await.unwrap();
        std::fs::remove_file(renderer.path().join("index.html")).unwrap();

        let result = state.remote.restart(&state).await;

        assert!(matches!(result, Err(RemoteError::RendererIndexMissing(_))));
        assert!(state.remote.status().await.is_none());
        // Restarting a stopped listener is a no-op.
        assert!(state.remote.restart(&state).await.unwrap().is_none());
    }

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
