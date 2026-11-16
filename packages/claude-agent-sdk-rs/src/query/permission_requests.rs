use std::collections::HashSet;
use std::sync::Arc;

use tokio::sync::Mutex;

/// Tracks the CLI's open permission requests and those it cancelled, until
/// the matching detached permission task observes the cancellation and closes
/// the request. Kept apart from the turn state: a request can be open while
/// the turn state shows something else (another request, or a finished turn).
#[derive(Clone, Default)]
pub(super) struct PermissionRequests {
    inner: Arc<Mutex<RequestSets>>,
}

#[derive(Default)]
struct RequestSets {
    open: HashSet<String>,
    cancelled: HashSet<String>,
}

impl PermissionRequests {
    /// A permission request arrived; its task owns it until [`Self::close`].
    pub(super) async fn open(&self, request_id: &str) {
        self.inner.lock().await.open.insert(request_id.to_string());
    }

    /// The CLI cancelled `request_id`. Returns whether it was still open, so
    /// its task will drop the answer instead of writing it late.
    pub(super) async fn mark(&self, request_id: &str) -> bool {
        let mut requests = self.inner.lock().await;
        if !requests.open.contains(request_id) {
            return false;
        }
        requests.cancelled.insert(request_id.to_string())
    }

    pub(super) async fn take(&self, request_id: &str) -> bool {
        self.inner.lock().await.cancelled.remove(request_id)
    }

    /// The request's task is done with it.
    pub(super) async fn close(&self, request_id: &str) {
        let mut requests = self.inner.lock().await;
        requests.open.remove(request_id);
        requests.cancelled.remove(request_id);
    }
}
