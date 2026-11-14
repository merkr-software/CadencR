//! The `cadencr-service` child of `cadencr serve`.

use std::process::{ExitStatus, Stdio};
use std::time::Duration;

use tokio::io::AsyncBufReadExt as _;
use tokio::process::{Child, ChildStdin, Command};
use tokio::signal::unix::{signal, Signal, SignalKind};

use super::resources::ServiceResources;
use super::serve::{DataPaths, Options};
use super::service_api::ServiceApi;
use super::SERVICE_PORT;
use crate::{operation_error, Diagnostic};

/// Startup runs migrations and recovery first, which can take a while on a
/// large database.
const HEALTH_TIMEOUT: Duration = Duration::from_secs(300);
const STOP_TIMEOUT: Duration = Duration::from_secs(30);
/// Startup progress lines meant for the desktop splash screen.
const PHASE_PREFIX: &str = "CADENCR_PHASE";

pub(super) struct ServiceProcess {
    child: Child,
    /// Held open: the service exits when it closes (`--exit-with-parent`), so
    /// it never outlives this CLI however the CLI ends.
    _stdin: Option<ChildStdin>,
    /// Listened to from the spawn on, so Ctrl+C during startup also stops
    /// the service cleanly.
    signals: StopSignals,
}

/// Ctrl+C, SIGTERM (`systemctl stop`), and SIGHUP when the terminal or SSH
/// session goes away: each stops the service and removes the connection file.
struct StopSignals {
    interrupt: Signal,
    terminate: Signal,
    hangup: Signal,
}

impl StopSignals {
    fn listen() -> Result<Self, Diagnostic> {
        let listen =
            |kind| signal(kind).map_err(|error| operation_error("CLI_RUNTIME_FAILED", error));
        Ok(Self {
            interrupt: listen(SignalKind::interrupt())?,
            terminate: listen(SignalKind::terminate())?,
            hangup: listen(SignalKind::hangup())?,
        })
    }

    async fn recv(&mut self) {
        tokio::select! {
            _ = self.interrupt.recv() => {}
            _ = self.terminate.recv() => {}
            _ = self.hangup.recv() => {}
        }
    }
}

impl ServiceProcess {
    pub(super) fn spawn(
        options: &Options,
        resources: &ServiceResources,
        paths: &DataPaths,
        token: &str,
    ) -> Result<Self, Diagnostic> {
        let signals = StopSignals::listen()?;
        let mut command = Command::new(&resources.service);
        command
            .arg("--db-path")
            .arg(&paths.database)
            .arg("--settings-dir")
            .arg(&paths.settings)
            .arg("--port")
            .arg(SERVICE_PORT.to_string())
            .arg("--remote-port")
            .arg(options.remote_port.to_string())
            .arg("--renderer-dir")
            .arg(&resources.renderer)
            .arg("--exit-with-parent")
            .env("CADENCR_AUTH_TOKEN", token)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::inherit())
            .kill_on_drop(true);
        if let Some(version) = &resources.app_version {
            command.arg("--app-version").arg(version);
        }
        let mut child = command.spawn().map_err(|error| {
            operation_error(
                "CLI_SERVICE_START_FAILED",
                format!("cannot start {}: {error}", resources.service.display()),
            )
        })?;
        if let Some(stdout) = child.stdout.take() {
            tokio::spawn(forward_output(stdout));
        }
        let stdin = child.stdin.take();
        Ok(Self {
            child,
            _stdin: stdin,
            signals,
        })
    }

    pub(super) fn pid(&self) -> u32 {
        self.child.id().unwrap_or_default()
    }

    pub(super) async fn wait_until_healthy(&mut self, api: &ServiceApi) -> Result<(), Diagnostic> {
        let deadline = tokio::time::Instant::now() + HEALTH_TIMEOUT;
        loop {
            if api.healthy().await {
                return Ok(());
            }
            if let Some(status) = self.exited()? {
                return Err(stopped_error(status));
            }
            if tokio::time::Instant::now() >= deadline {
                return Err(operation_error(
                    "CLI_SERVICE_START_FAILED",
                    "the service did not become ready in time",
                ));
            }
            let stopped = tokio::select! {
                () = tokio::time::sleep(Duration::from_millis(250)) => false,
                () = self.signals.recv() => true,
            };
            if stopped {
                self.stop().await;
                return Err(Diagnostic {
                    code: "CLI_SERVE_INTERRUPTED",
                    message: "stopped before the service was ready".to_string(),
                    exit_code: 130,
                });
            }
        }
    }

    /// Runs until Ctrl+C, SIGTERM or the service's own exit.
    pub(super) async fn run_until_stopped(&mut self) -> Result<(), Diagnostic> {
        tokio::select! {
            status = self.child.wait() => {
                let status = status.map_err(|error| operation_error("CLI_SERVICE_STOPPED", error))?;
                if status.success() { Ok(()) } else { Err(stopped_error(status)) }
            }
            () = self.signals.recv() => { self.stop().await; Ok(()) }
        }
    }

    /// Asks the service to shut down gracefully, then kills it if it hangs.
    pub(super) async fn stop(&mut self) {
        if let Some(pid) = self
            .child
            .id()
            .and_then(|pid| libc::pid_t::try_from(pid).ok())
        {
            // SAFETY: signals our own child process.
            unsafe { libc::kill(pid, libc::SIGTERM) };
        }
        match tokio::time::timeout(STOP_TIMEOUT, self.child.wait()).await {
            Ok(Ok(_)) => {}
            Ok(Err(error)) => eprintln!("warning: could not wait for the service: {error}"),
            Err(_) => {
                eprintln!("warning: the service did not stop in time; killing it");
                if let Err(error) = self.child.kill().await {
                    eprintln!("warning: could not kill the service: {error}");
                }
            }
        }
    }

    fn exited(&mut self) -> Result<Option<ExitStatus>, Diagnostic> {
        self.child
            .try_wait()
            .map_err(|error| operation_error("CLI_SERVICE_STOPPED", error))
    }
}

fn stopped_error(status: ExitStatus) -> Diagnostic {
    operation_error(
        "CLI_SERVICE_STOPPED",
        format!("the service stopped ({status}); its log is above"),
    )
}

/// The service's stdout goes to stderr, so this CLI's own stdout carries only
/// its messages (one JSON object per line with `--json`). It is drained to the
/// end, invalid UTF-8 included: a closed pipe would make the service's next
/// write fail.
async fn forward_output(stdout: tokio::process::ChildStdout) {
    let mut reader = tokio::io::BufReader::new(stdout);
    let mut line = Vec::new();
    loop {
        line.clear();
        match reader.read_until(b'\n', &mut line).await {
            Ok(0) => break,
            Ok(_) => {
                let text = String::from_utf8_lossy(&line);
                let text = text.trim_end_matches(['\n', '\r']);
                if !text.starts_with(PHASE_PREFIX) {
                    eprintln!("{text}");
                }
            }
            Err(error) => {
                eprintln!("warning: cannot read the service output: {error}");
                // Keep the pipe drained so the service never blocks on it.
                if let Err(error) = tokio::io::copy(&mut reader, &mut tokio::io::sink()).await {
                    eprintln!("warning: stopped draining the service output: {error}");
                }
                break;
            }
        }
    }
}
