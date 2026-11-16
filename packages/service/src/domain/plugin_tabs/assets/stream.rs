//! A response body owns its selected revision until completion or cancellation.
use super::super::managed::storage::RevisionLease;
use axum::body::Body;
use futures::StreamExt as _;
use tokio_util::io::ReaderStream;

pub(super) fn body(file: tokio::fs::File, lease: Option<RevisionLease>) -> Body {
    Body::from_stream(ReaderStream::new(file).map(move |chunk| {
        // Capture the lease, not merely its path: lookup, opening and every
        // streamed chunk must refer to the same immutable managed revision.
        let _retain_revision = &lease;
        chunk
    }))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::domain::plugin_tabs::managed::storage::{self, fixtures::fixture_revision};
    use std::path::{Path, PathBuf};

    fn install(temp: &Path, root: &Path, revision: usize) -> PathBuf {
        let (receipt, archive, files, _) =
            fixture_revision(&temp.join(format!("fixture-{revision}")), revision);
        storage::commit(root, &receipt, &archive, &files).unwrap();
        storage::directory(root, "graph").unwrap().unwrap()
    }

    #[tokio::test]
    async fn body_retains_selected_revision_through_updates_until_consumed() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().join("managed");
        let first = install(temp.path(), &root, 0);
        let selected = storage::lease(&root, "graph").unwrap().unwrap();
        let file = tokio::fs::File::open(first.join("dist/index.html"))
            .await
            .unwrap();
        let response = body(file, Some(selected));
        for revision in 1..5 {
            install(temp.path(), &root, revision);
        }
        assert!(first.exists());
        let bytes = axum::body::to_bytes(response, 1024).await.unwrap();
        assert_eq!(&bytes[..], b"<html>Graph</html>");
        install(temp.path(), &root, 5);
        assert!(!first.exists());
    }

    #[tokio::test]
    async fn cancellation_releases_the_revision_without_process_lifetime_pinning() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().join("managed");
        let first = install(temp.path(), &root, 0);
        let selected = storage::lease(&root, "graph").unwrap().unwrap();
        let file = tokio::fs::File::open(first.join("dist/index.html"))
            .await
            .unwrap();
        let response = body(file, Some(selected));
        storage::deactivate(&root, "graph").unwrap();
        assert!(first.exists());
        drop(response);
        install(temp.path(), &root, 1);
        assert!(!first.exists());
    }
}
