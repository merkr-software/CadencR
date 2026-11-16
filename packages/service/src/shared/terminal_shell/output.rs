//! Forward a shell's startup-file and terminal output as lines.

use std::os::fd::{AsRawFd, OwnedFd};
use std::sync::atomic::{AtomicBool, Ordering};

use tokio::sync::mpsc::Sender;

const MAX_PENDING_OUTPUT_BYTES: usize = 16 * 1024;
/// How often a quiet reader checks whether its run was abandoned.
const POLL_TIMEOUT_MS: libc::c_int = 100;

struct Source {
    fd: OwnedFd,
    pending: String,
    open: bool,
}

/// Read `sources` until each reaches end-of-file, sending complete lines in
/// the order they arrive. One thread polls both, so startup-file output stays
/// ahead of the script's. `abandoned` stops it early: a runtime shutting down
/// waits for this thread, and a process that escaped the group may hold the
/// terminal open for good.
pub(super) fn forward_output(
    sources: Vec<OwnedFd>,
    abandoned: &AtomicBool,
    output_tx: &Sender<String>,
) {
    let mut sources = sources
        .into_iter()
        .map(|fd| Source {
            fd,
            pending: String::new(),
            open: true,
        })
        .collect::<Vec<_>>();
    while sources.iter().any(|source| source.open) && !abandoned.load(Ordering::Acquire) {
        if let Err(error) = read_ready_sources(&mut sources, output_tx) {
            tracing::warn!(%error, "stopped reading shell output");
            break;
        }
    }
    for source in &mut sources {
        flush_remaining(&mut source.pending, output_tx);
    }
}

/// Wait for output and read whatever is ready.
fn read_ready_sources(sources: &mut [Source], output_tx: &Sender<String>) -> std::io::Result<()> {
    let mut poll_fds = sources
        .iter()
        .filter(|source| source.open)
        .map(|source| libc::pollfd {
            fd: source.fd.as_raw_fd(),
            events: libc::POLLIN,
            revents: 0,
        })
        .collect::<Vec<_>>();
    // SAFETY: `poll_fds` is a live, correctly sized array of pollfd.
    let ready = unsafe {
        libc::poll(
            poll_fds.as_mut_ptr(),
            poll_fds.len() as libc::nfds_t,
            POLL_TIMEOUT_MS,
        )
    };
    if ready < 0 {
        let error = std::io::Error::last_os_error();
        if error.kind() == std::io::ErrorKind::Interrupted {
            return Ok(());
        }
        return Err(error);
    }
    for (source, polled) in sources
        .iter_mut()
        .filter(|source| source.open)
        .zip(&poll_fds)
    {
        if polled.revents != 0 {
            read_source(source, output_tx);
        }
    }
    Ok(())
}

fn read_source(source: &mut Source, output_tx: &Sender<String>) {
    let mut buffer = [0_u8; 4096];
    // SAFETY: reads at most `buffer.len()` bytes into a buffer we own.
    let count = unsafe {
        libc::read(
            source.fd.as_raw_fd(),
            buffer.as_mut_ptr().cast(),
            buffer.len(),
        )
    };
    if count < 0 && std::io::Error::last_os_error().kind() == std::io::ErrorKind::Interrupted {
        return;
    }
    // macOS reports a closed PTY as end-of-file, Linux as EIO.
    if count <= 0 {
        source.open = false;
        flush_remaining(&mut source.pending, output_tx);
        return;
    }
    source
        .pending
        .push_str(&String::from_utf8_lossy(&buffer[..count as usize]));
    flush_complete_segments(&mut source.pending, output_tx);
    flush_oversized_pending(&mut source.pending, output_tx);
}

fn flush_remaining(pending: &mut String, output_tx: &Sender<String>) {
    if !pending.is_empty() {
        let line = std::mem::take(pending).trim_end_matches('\r').to_string();
        let _ = output_tx.blocking_send(line);
    }
}

fn flush_complete_segments(pending: &mut String, output_tx: &Sender<String>) {
    let mut consumed = 0;
    while let Some(relative_index) = pending[consumed..].find(['\n', '\r']) {
        let index = consumed + relative_index;
        let line = pending[consumed..index].to_string();
        if output_tx.blocking_send(line).is_err() {
            return;
        }
        consumed = index + 1;
    }
    if consumed > 0 {
        pending.drain(..consumed);
    }
}

fn flush_oversized_pending(pending: &mut String, output_tx: &Sender<String>) {
    if pending.len() <= MAX_PENDING_OUTPUT_BYTES {
        return;
    }
    let line = std::mem::take(pending);
    let _ = output_tx.blocking_send(line);
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    fn collect(rx: &mut tokio::sync::mpsc::Receiver<String>) -> Vec<String> {
        std::iter::from_fn(|| rx.try_recv().ok()).collect()
    }

    #[test]
    fn forwards_each_source_until_end_of_file() {
        let (startup_rx, mut startup_tx) = std::io::pipe().unwrap();
        let (terminal_rx, mut terminal_tx) = std::io::pipe().unwrap();
        startup_tx.write_all(b"rc line\npartial rc").unwrap();
        terminal_tx.write_all(b"script line\r\n").unwrap();
        drop((startup_tx, terminal_tx));
        let (tx, mut rx) = tokio::sync::mpsc::channel(16);

        forward_output(
            vec![startup_rx.into(), terminal_rx.into()],
            &AtomicBool::new(false),
            &tx,
        );

        let mut lines = collect(&mut rx);
        lines.retain(|line| !line.is_empty());
        lines.sort();
        assert_eq!(lines, ["partial rc", "rc line", "script line"]);
    }

    #[test]
    fn an_abandoned_reader_stops_although_a_writer_remains() {
        let (terminal_rx, held_open) = std::io::pipe().unwrap();
        let (tx, _rx) = tokio::sync::mpsc::channel(16);
        let started = std::time::Instant::now();

        forward_output(vec![terminal_rx.into()], &AtomicBool::new(true), &tx);

        assert!(started.elapsed() < std::time::Duration::from_secs(1));
        drop(held_open);
    }
}
