//! OpenCode's resolved MCP config, read once per session start.
//!
//! Starting a session needs it twice and concurrently: for the MCP status list
//! and for the browser trust. Each read is a login shell running
//! `opencode debug config`, so concurrent askers share one read; an asker after
//! it finished (a later status refresh) reads again.

use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

use futures::future::{BoxFuture, FutureExt, Shared};
use opencode_sdk_rs::OpenCodeMcpServerStatus;

pub(super) type ResolvedServers = Result<Arc<Vec<OpenCodeMcpServerStatus>>, String>;

type Read = Shared<BoxFuture<'static, ResolvedServers>>;

#[derive(Default)]
pub(super) struct ResolvedMcpConfig {
    in_flight: Mutex<Option<(PathBuf, Read)>>,
}

impl ResolvedMcpConfig {
    /// The servers of OpenCode's resolved config for `cwd`, or why it could not
    /// be read ([`opencode_sdk_rs::list_mcp_servers_from_resolved_config`]).
    pub(super) async fn servers(&self, cwd: &Path) -> ResolvedServers {
        let read = self.join_or_start(cwd);
        let servers = read.clone().await;
        let mut in_flight = self.lock();
        if in_flight
            .as_ref()
            .is_some_and(|(_, current)| current.ptr_eq(&read))
        {
            *in_flight = None;
        }
        servers
    }

    fn join_or_start(&self, cwd: &Path) -> Read {
        let mut in_flight = self.lock();
        if let Some((path, read)) = in_flight.as_ref() {
            if path == cwd {
                return read.clone();
            }
        }
        let path = cwd.to_path_buf();
        let read = {
            let path = path.clone();
            async move {
                opencode_sdk_rs::list_mcp_servers_from_resolved_config(Some(&path))
                    .await
                    .map(Arc::new)
                    .map_err(|error| error.to_string())
            }
            .boxed()
            .shared()
        };
        *in_flight = Some((path, read.clone()));
        read
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, Option<(PathBuf, Read)>> {
        self.in_flight
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    // The read itself is never polled here: it would run the OpenCode CLI.
    #[test]
    fn concurrent_askers_of_one_folder_share_one_read() {
        let config = ResolvedMcpConfig::default();
        let cwd = Path::new("/nonexistent-cadencr-opencode-cwd");
        let first = config.join_or_start(cwd);
        assert!(first.ptr_eq(&config.join_or_start(cwd)));
        assert!(!config.join_or_start(Path::new("/elsewhere")).ptr_eq(&first));
    }
}
