//! The Port monitor's native backend (docs/TAB_BACKEND_PROTOCOL.md). Cadencr
//! starts it from the tab folder on the tab's first `client.backend.request()`
//! and stops it once the tab has been closed for a while.

use std::process::ExitCode;

fn main() -> ExitCode {
    cadencr_tab_backend::serve(port_monitor::PortMonitor::default())
}
