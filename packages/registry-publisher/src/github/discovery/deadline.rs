use super::*;

/// A file state the caller already holds, by blob.
#[derive(Clone, Copy)]
pub(super) enum Known<'a> {
    Absent,
    Blob(&'a str),
}

impl<'a> Known<'a> {
    pub(super) fn of(head: Option<&'a DiscoveryHead>) -> Self {
        head.map_or(Self::Absent, |head| Self::Blob(&head.sha))
    }
}

impl GitHubClient {
    /// The blob of `file` on `branch`, resolved through the branch's commit
    /// tree so every request is pinned to one commit.
    pub(super) fn read_discovery_file(
        &self,
        branch: &str,
        file: &str,
        deadline: Option<Instant>,
    ) -> Result<Option<DiscoveryHead>, PublisherError> {
        let (commit_sha, entry) = self.resolve_entry(branch, file, deadline)?;
        entry
            .map(|entry| self.fetch_entry(&commit_sha, &entry, file, deadline))
            .transpose()
    }

    /// Like [`Self::read_discovery_file`] for a caller that holds `known`:
    /// when the tree still shows exactly that state, the contents are not
    /// fetched.
    pub(super) fn read_discovery_entry(
        &self,
        branch: &str,
        file: &str,
        deadline: Option<Instant>,
        known: Option<Known<'_>>,
    ) -> Result<Observed, PublisherError> {
        let (commit_sha, entry) = self.resolve_entry(branch, file, deadline)?;
        let Some(entry) = entry else {
            return Ok(match known {
                Some(Known::Absent) => Observed::Unchanged,
                _ => Observed::Head(None),
            });
        };
        if matches!(known, Some(Known::Blob(sha)) if sha == entry.sha) {
            return Ok(Observed::Unchanged);
        }
        self.fetch_entry(&commit_sha, &entry, file, deadline)
            .map(|head| Observed::Head(Some(head)))
    }

    /// The commit at the head of `branch` and the tree entry of `file` in it.
    fn resolve_entry(
        &self,
        branch: &str,
        file: &str,
        deadline: Option<Instant>,
    ) -> Result<(String, Option<RawTreeEntry>), PublisherError> {
        validate_discovery_branch(branch)?;
        let reference: RawRef = self.request.get_with_deadline(
            &format!("/repos/{}/git/ref/heads/{branch}", self.repository),
            deadline,
        )?;
        let commit_sha = reference.validate(branch)?;
        let commit: RawCommit = self.request.get_with_deadline(
            &format!("/repos/{}/git/commits/{commit_sha}", self.repository),
            deadline,
        )?;
        let tree_sha = commit.validate(&commit_sha)?;
        let tree: RawTree = self.request.get_with_deadline(
            &format!("/repos/{}/git/trees/{tree_sha}", self.repository),
            deadline,
        )?;
        let entry = tree.validate(&tree_sha, file)?;
        Ok((commit_sha, entry))
    }

    fn fetch_entry(
        &self,
        commit_sha: &str,
        entry: &RawTreeEntry,
        file: &str,
        deadline: Option<Instant>,
    ) -> Result<DiscoveryHead, PublisherError> {
        // Contents responses omit base64 data above 1 MiB; pin the Git blob
        // discovered in the reviewed commit tree instead, retaining SHA checks.
        if entry.size > 1024 * 1024 {
            let blob: RawBlob = self.request.get_catalog_blob_with_deadline(
                &format!("/repos/{}/git/blobs/{}", self.repository, entry.sha),
                deadline,
            )?;
            return blob.validate(entry, file);
        }
        let content: RawContent = self.request.get_with_deadline(
            &format!(
                "/repos/{}/contents/{file}?ref={commit_sha}",
                self.repository
            ),
            deadline,
        )?;
        content.validate(entry, file)
    }
}

#[cfg(test)]
mod tests {
    use std::io::{Read, Write};
    use std::net::TcpListener;
    use std::time::Duration;

    use crate::github::fixture::client;

    use super::*;

    #[test]
    fn expired_deadline_precedes_any_api_request() {
        let error = client("http://127.0.0.1:1".into())
            .get_discovery_before("catalog", Instant::now())
            .unwrap_err();
        assert!(error.to_string().contains("deadline exceeded"));
    }

    #[test]
    fn deadline_covers_response_body_not_just_headers() {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let api = format!("http://{}", listener.local_addr().unwrap());
        let server = std::thread::spawn(move || {
            listener.set_nonblocking(true).unwrap();
            let accept_deadline = Instant::now() + Duration::from_secs(3);
            let mut stream = loop {
                match listener.accept() {
                    Ok((stream, _)) => break stream,
                    Err(error)
                        if error.kind() == std::io::ErrorKind::WouldBlock
                            && Instant::now() < accept_deadline =>
                    {
                        std::thread::sleep(Duration::from_millis(5));
                    }
                    Err(error) => panic!("fixture accept failed: {error}"),
                }
            };
            stream
                .set_read_timeout(Some(Duration::from_secs(2)))
                .unwrap();
            stream
                .set_write_timeout(Some(Duration::from_secs(2)))
                .unwrap();
            let mut request = [0; 4096];
            assert!(stream.read(&mut request).unwrap() > 0);
            stream
                .write_all(b"HTTP/1.1 200 OK\r\nContent-Length: 2\r\nConnection: close\r\n\r\n")
                .unwrap();
            std::thread::sleep(Duration::from_millis(800));
            // Sending nothing else makes success impossible and bounds fixture lifetime.
        });
        let client = client(api);
        let start = Instant::now();
        assert!(client
            .get_discovery_before("catalog", start + Duration::from_millis(250))
            .is_err());
        assert!(start.elapsed() < Duration::from_millis(600));
        server.join().unwrap();
    }

    #[test]
    fn all_discovery_requests_share_one_deadline() {
        use std::sync::atomic::{AtomicBool, Ordering};
        use std::sync::Arc;

        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        listener.set_nonblocking(true).unwrap();
        let api = format!("http://{}", listener.local_addr().unwrap());
        let done = Arc::new(AtomicBool::new(false));
        let server_done = Arc::clone(&done);
        let server = std::thread::spawn(move || {
            let commit = "a".repeat(40);
            let tree = "b".repeat(40);
            let bodies = [
                format!(
                    r#"{{"ref":"refs/heads/catalog","object":{{"type":"commit","sha":"{commit}"}}}}"#
                ),
                format!(r#"{{"sha":"{commit}","tree":{{"sha":"{tree}"}}}}"#),
                format!(r#"{{"sha":"{tree}","truncated":false,"tree":[]}}"#),
            ];
            let mut paths = Vec::new();
            for body in bodies {
                let accept_deadline = Instant::now() + Duration::from_secs(3);
                let mut stream = loop {
                    if server_done.load(Ordering::Acquire) {
                        return paths;
                    }
                    match listener.accept() {
                        Ok((stream, _)) => break stream,
                        Err(error)
                            if error.kind() == std::io::ErrorKind::WouldBlock
                                && Instant::now() < accept_deadline =>
                        {
                            std::thread::sleep(Duration::from_millis(5));
                        }
                        Err(error) => panic!("fixture accept failed: {error}"),
                    }
                };
                stream
                    .set_read_timeout(Some(Duration::from_secs(2)))
                    .unwrap();
                stream
                    .set_write_timeout(Some(Duration::from_secs(2)))
                    .unwrap();
                let mut request = [0; 4096];
                let count = match stream.read(&mut request) {
                    Ok(0) => return paths,
                    Ok(count) => count,
                    Err(_) if server_done.load(Ordering::Acquire) => return paths,
                    Err(error) => panic!("fixture read failed: {error}"),
                };
                paths.push(String::from_utf8_lossy(&request[..count]).into_owned());
                std::thread::sleep(Duration::from_millis(200));
                // Any hop may finish after the shared client deadline.
                if write!(
                    stream,
                    "HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
                    body.len()
                )
                .is_err()
                {
                    return paths;
                }
            }
            paths
        });
        let client = client(api);
        let start = Instant::now();
        let result = client.get_discovery_before("catalog", start + Duration::from_millis(500));
        let elapsed = start.elapsed();
        done.store(true, Ordering::Release);
        let paths = server.join().unwrap();
        assert!(
            result.is_err(),
            "three independent request budgets would incorrectly succeed"
        );
        assert!(elapsed < Duration::from_secs(2));
        let expected = [
            "GET /repos/acme/releases/git/ref/heads/catalog ".to_owned(),
            format!("GET /repos/acme/releases/git/commits/{} ", "a".repeat(40)),
            format!("GET /repos/acme/releases/git/trees/{} ", "b".repeat(40)),
        ];
        assert!(paths.len() <= expected.len());
        for (path, expected) in paths.iter().zip(expected) {
            assert!(path.starts_with(&expected), "unexpected request: {path}");
        }
    }
}
