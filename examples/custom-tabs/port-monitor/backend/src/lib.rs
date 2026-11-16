//! The Port monitor's methods. It does what a page cannot: list the TCP ports
//! listening on this computer, with the process behind each, and send a
//! signal to a process. It runs with the user's rights — which is why `stop`
//! refuses anything running outside this conversation's folder. A folder is
//! not a conversation: conversations without their own worktree share the
//! project folder, and its processes.
//!
//! | Method    | Params     | Result                   |
//! |-----------|------------|--------------------------|
//! | `context` | none       | `{title}`                |
//! | `ports`   | none       | `{ports: [PortEntry]}`   |
//! | `stop`    | `{pid}`    | `{stopped: pid}`         |

#[cfg(not(unix))]
compile_error!("the Port monitor backend supports macOS and Linux only");

#[cfg(any(test, not(target_os = "linux")))]
mod lsof;
mod ports;
#[cfg(any(test, target_os = "linux"))]
mod proc_net;
#[cfg(target_os = "linux")]
mod procfs;
mod stop;

use std::sync::OnceLock;

use cadencr_tab_backend::{Context, Error, Handler};
use serde::Deserialize;
use serde_json::{json, Value};

use ports::Folder;

/// The backend of one run: one conversation, so its folder is resolved once,
/// on the first request that needs it.
#[derive(Default)]
pub struct PortMonitor {
    folder: OnceLock<Folder>,
}

impl PortMonitor {
    fn folder(&self, cx: &Context) -> &Folder {
        self.folder
            .get_or_init(|| Folder::new(&cx.hello().worktree))
    }
}

impl Handler for PortMonitor {
    /// Every request goes through here. A failure is answered to the page
    /// (which shows it) and noted in the log, shown in the tab's Activity.
    fn handle(&self, cx: &Context) -> Result<Value, Error> {
        let result = match cx.method() {
            "context" => context(cx),
            "ports" => ports::list(self.folder(cx)).map(|ports| json!({ "ports": ports })),
            "stop" => stop::stop(cx, self.folder(cx)),
            other => Err(Error::unknown_method(other)),
        };
        if let Err(error) = &result {
            eprintln!("[port-monitor] {} failed: {error}", cx.method());
        }
        result
    }
}

#[derive(Deserialize)]
struct Feature {
    title: String,
}

/// The conversation, read through the Cadencr API with the backend's own
/// token (`features:read`, this conversation only).
fn context(cx: &Context) -> Result<Value, Error> {
    let feature: Feature = cx
        .api()?
        .get(&format!("/api/features/{}", cx.hello().feature_id))?;
    Ok(json!({ "title": feature.title }))
}
