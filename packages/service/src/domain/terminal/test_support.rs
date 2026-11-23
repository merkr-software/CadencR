//! Helpers shared by the PTY socket tests (terminal bridge, Neovim socket).

use std::sync::Arc;
use std::time::Duration;

use super::service::{PtyHandle, PtyKind, PtyManager};

/// Spawn a child that never reads stdin (raw mode, so neither the line
/// discipline nor echo drains it) and wait until it is in that state.
pub(crate) async fn spawn_stuck_child(
    manager: &PtyManager,
    kind: PtyKind,
) -> (String, Arc<PtyHandle>) {
    let mut cmd = portable_pty::CommandBuilder::new("/bin/sh");
    cmd.args(["-c", "stty raw -echo; printf 'READY\\n'; exec sleep 600"]);
    let cwd = std::env::temp_dir().to_string_lossy().into_owned();
    let (pty_id, handle) = manager
        .create_pty_with_command(9, cmd, &cwd, 80, 24, kind)
        .expect("spawn stuck child");
    let (initial, mut output) = handle.subscribe_with_scrollback();
    let mut seen = initial;
    tokio::time::timeout(Duration::from_secs(5), async {
        while !seen.contains("READY") {
            seen.push_str(&output.recv().await.expect("child output"));
        }
    })
    .await
    .expect("child ready");
    (pty_id, handle)
}

/// Whether the PTY reaches `cols` x `rows` within two seconds.
pub(crate) async fn wait_for_size(handle: &PtyHandle, cols: u16, rows: u16) -> bool {
    tokio::time::timeout(Duration::from_secs(2), async {
        loop {
            let size = handle
                .master
                .lock()
                .expect("master lock")
                .get_size()
                .expect("PTY size");
            if (size.cols, size.rows) == (cols, rows) {
                return;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await
    .is_ok()
}
