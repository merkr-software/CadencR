//! `cadencr serve`: run the CadencR service without the desktop app, on the
//! user's own database and settings, with remote access on so paired devices
//! can use it. `cadencr pair` mints a new pairing link for it.

use std::io::Read as _;
use std::os::unix::fs::DirBuilderExt as _;
use std::path::PathBuf;

use serde_json::json;

use super::connection::{self, Connection};
use super::install::Installation;
use super::resources::ServiceResources;
use super::service_api::{PairingCode, ServiceApi};
use super::service_process::ServiceProcess;
use super::{block_on, emit, hex, say, SERVICE_PORT};
use crate::{operation_error, Diagnostic};

pub(super) struct Options {
    pub(super) remote_port: u16,
    pub(super) remote: bool,
}

pub(super) struct DataPaths {
    pub(super) database: PathBuf,
    pub(super) settings: PathBuf,
}

pub(super) fn run(options: &Options, json: bool) -> Result<Option<String>, Diagnostic> {
    Connection::refuse_running("It is already serving.")?;
    let resources = ServiceResources::locate(Installation::detect()?)?;
    ensure_port_free(SERVICE_PORT)?;
    let paths = data_paths()?;
    let token = mint_token()?;
    block_on(serve(options, &resources, &paths, token, json))?
}

pub(super) fn pair(json: bool) -> Result<Option<String>, Diagnostic> {
    let connection = Connection::require()?;
    let api = ServiceApi::new(connection.base_url(), connection.token)?;
    let code = block_on(api.pairing_code())??;
    print_pairing(&code, json)?;
    Ok(None)
}

async fn serve(
    options: &Options,
    resources: &ServiceResources,
    paths: &DataPaths,
    token: String,
    json: bool,
) -> Result<Option<String>, Diagnostic> {
    let mut service = ServiceProcess::spawn(options, resources, paths, &token)?;
    let connection = Connection::new(service.pid(), SERVICE_PORT, token);
    let api = ServiceApi::new(connection.base_url(), connection.token.clone())?;
    if let Err(error) = service.wait_until_healthy(&api).await {
        service.stop().await;
        return Err(error);
    }
    let connection_path = match connection.write() {
        Ok(path) => path,
        Err(error) => {
            service.stop().await;
            return Err(error);
        }
    };
    let outcome = match announce(options, &api, json).await {
        Ok(()) => service.run_until_stopped().await,
        Err(error) => {
            service.stop().await;
            Err(error)
        }
    };
    connection::remove(&connection_path)?;
    outcome.map(|()| Some("CadencR stopped.".to_string()))
}

async fn announce(options: &Options, api: &ServiceApi, json: bool) -> Result<(), Diagnostic> {
    let api_url = format!("http://127.0.0.1:{SERVICE_PORT}");
    if !options.remote {
        // Remote access is a saved setting the service restores at startup,
        // so leaving it alone could keep it listening on the network.
        api.disable_remote().await?;
        if json {
            return emit(&json!({ "ok": true, "code": "SERVE_READY", "api": api_url }));
        }
        say(&format!(
            "CadencR is running headless; its API listens on {api_url} (this machine only)."
        ))?;
        return say("Remote access is off. Press Ctrl+C to stop.");
    }
    let status = api.enable_remote().await?;
    let code = api.pairing_code().await?;
    let remote_port = status.port.unwrap_or(options.remote_port);
    if json {
        return emit(&json!({ "ok": true, "code": "SERVE_READY", "api": api_url,
                             "remote_port": remote_port, "pairing": code }));
    }
    say(&format!(
        "CadencR is running headless; remote devices connect on port {remote_port}."
    ))?;
    print_pairing(&code, false)?;
    say("Run `cadencr pair` for a new link. Press Ctrl+C to stop.")
}

fn print_pairing(code: &PairingCode, json: bool) -> Result<(), Diagnostic> {
    if json {
        return emit(&json!({ "ok": true, "code": "PAIRING_CODE", "pairing": code }));
    }
    let minutes = code.expires_in_secs.div_ceil(60);
    say(&format!(
        "Open one of these links on the device to pair it within {minutes} min:"
    ))?;
    for url in &code.urls {
        say(&format!("  {url}"))?;
    }
    say(&format!("Certificate fingerprint: {}", code.fingerprint))
}

/// The desktop app's service uses the same port, so a busy port almost always
/// means CadencR is open.
fn ensure_port_free(port: u16) -> Result<(), Diagnostic> {
    match std::net::TcpListener::bind(("127.0.0.1", port)) {
        Ok(listener) => {
            drop(listener);
            Ok(())
        }
        Err(error) => Err(operation_error(
            "CLI_PORT_IN_USE",
            format!(
                "cannot use port {port}: {error}. Quit the CadencR desktop app first: \
                 it runs the same service on this port."
            ),
        )),
    }
}

/// The database and settings the desktop app uses.
fn data_paths() -> Result<DataPaths, Diagnostic> {
    let resolve = |result: Result<PathBuf, String>| {
        result.map_err(|error| operation_error("CLI_PATHS_UNAVAILABLE", error))
    };
    let database = resolve(cadencr_app_paths::database_path())?;
    if let Some(dir) = database.parent() {
        std::fs::DirBuilder::new()
            .recursive(true)
            .mode(0o700)
            .create(dir)
            .map_err(|error| {
                operation_error(
                    "CLI_PATHS_UNAVAILABLE",
                    format!("{}: {error}", dir.display()),
                )
            })?;
    }
    Ok(DataPaths {
        database,
        settings: resolve(cadencr_app_paths::settings_dir())?,
    })
}

/// A fresh bearer token for this run of the service, like the desktop app's.
fn mint_token() -> Result<String, Diagnostic> {
    let mut bytes = [0_u8; 32];
    std::fs::File::open("/dev/urandom")
        .and_then(|mut random| random.read_exact(&mut bytes))
        .map_err(|error| operation_error("CLI_TOKEN_FAILED", error))?;
    Ok(hex(&bytes))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn tokens_are_fresh_hex() {
        let first = mint_token().unwrap();
        assert_eq!(first.len(), 64);
        assert!(first.bytes().all(|byte| byte.is_ascii_hexdigit()));
        assert_ne!(first, mint_token().unwrap());
    }

    #[test]
    fn a_busy_port_is_reported() {
        let listener = std::net::TcpListener::bind(("127.0.0.1", 0)).unwrap();
        let port = listener.local_addr().unwrap().port();
        assert_eq!(ensure_port_free(port).unwrap_err().code, "CLI_PORT_IN_USE");
        drop(listener);
    }
}
