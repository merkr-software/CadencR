//! Send a best-effort liveness signal from the MCP subprocess after discovery.

use std::path::PathBuf;
use std::time::Duration;

use tokio::net::UnixStream;
use tokio::sync::mpsc;
use tokio::task::JoinHandle;

use super::{wait_for_close, SOCKET_ENV};

const REPORT_TIMEOUT: Duration = Duration::from_secs(1);

pub(crate) struct Reporter {
    requests: mpsc::Sender<()>,
    task: JoinHandle<()>,
}

impl Reporter {
    pub(crate) fn from_env() -> Option<Self> {
        std::env::var_os(SOCKET_ENV).map(|path| Self::start(path.into()))
    }

    pub(super) fn start(path: PathBuf) -> Self {
        let (requests, receiver) = mpsc::channel(1);
        let task = tokio::spawn(report_connections(path, receiver));
        Self { requests, task }
    }

    pub(crate) fn tools_listed(&self) {
        // A full queue already holds the signal. A closed queue needs no report.
        match self.requests.try_send(()) {
            Ok(())
            | Err(mpsc::error::TrySendError::Full(()) | mpsc::error::TrySendError::Closed(())) => {}
        }
    }
}

impl Drop for Reporter {
    fn drop(&mut self) {
        self.task.abort();
    }
}

async fn report_connections(path: PathBuf, mut requests: mpsc::Receiver<()>) {
    while requests.recv().await.is_some() {
        let mut stream =
            match tokio::time::timeout(REPORT_TIMEOUT, UnixStream::connect(&path)).await {
                Ok(Ok(stream)) => stream,
                Ok(Err(error)) => {
                    tracing::warn!(%error, "could not report the MCP connection to its runtime");
                    continue;
                }
                Err(error) => {
                    tracing::warn!(%error, "MCP connection reporting timed out");
                    continue;
                }
            };
        tokio::select! {
            () = wait_for_close(&mut stream) => {},
            () = async { while requests.recv().await.is_some() {} } => return,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io;
    use tokio::io::AsyncReadExt;
    use tokio::net::UnixListener;
    use tokio::time::timeout;

    const TIMEOUT: Duration = Duration::from_secs(2);

    #[tokio::test]
    async fn a_subsequent_catalog_can_report_after_the_first_connection_fails() {
        let directory = tempfile::tempdir_in("/tmp").unwrap();
        let path = directory.path().join("status");
        let reporter = Reporter::start(path.clone());
        reporter.tools_listed();
        // The missing path fails synchronously in the worker's poll of connect
        // on this single-threaded executor, before this test can resume.
        drop(
            timeout(TIMEOUT, reporter.requests.reserve())
                .await
                .unwrap()
                .unwrap(),
        );

        let listener = UnixListener::bind(path).unwrap();
        reporter.tools_listed();
        let (mut peer, _) = timeout(TIMEOUT, listener.accept()).await.unwrap().unwrap();
        drop(reporter);
        let error = timeout(TIMEOUT, peer.read_u8()).await.unwrap().unwrap_err();
        assert_eq!(error.kind(), io::ErrorKind::UnexpectedEof);
    }
}
