use std::time::Instant;

use base64::engine::general_purpose::STANDARD;
use base64::Engine as _;
use reqwest::StatusCode;
use serde::Serialize;
#[cfg(test)]
use sha1::{Digest as _, Sha1};

use super::validation::error;
use super::GitHubClient;
use crate::PublisherError;
use cadencr_registry_core::{validate_discovery_branch, DISCOVERY_FILENAME, MAX_DISCOVERY_BYTES};

mod deadline;
mod model;
pub(crate) mod write;

use deadline::Known;
use model::{valid_sha, RawBlob, RawCommit, RawContent, RawRef, RawTree, RawTreeEntry};

const UPDATE_MESSAGE: &str = "Update managed provider discovery index";

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct DiscoveryHead {
    pub(crate) sha: String,
    pub(crate) bytes: Vec<u8>,
}

/// What a read found, given the state the caller already holds.
pub(crate) enum Observed {
    /// The file is exactly what the caller already holds (`original`).
    Unchanged,
    Head(Option<DiscoveryHead>),
}

impl Observed {
    fn compared(head: Option<DiscoveryHead>, original: Option<&DiscoveryHead>) -> Self {
        if head.as_ref() == original {
            Self::Unchanged
        } else {
            Self::Head(head)
        }
    }
}

#[derive(bon::Builder)]
pub(crate) struct SetDiscoveryRequest<'a> {
    pub(crate) branch: &'a str,
    pub(crate) bytes: &'a [u8],
    pub(crate) expected_sha: Option<&'a str>,
}

/// One revocation policy file on a discovery branch, addressed by its fixed
/// path. Reads and conditional updates reuse the catalog's commit-pinned
/// machinery; only the path and commit message differ.
#[derive(bon::Builder)]
pub(crate) struct SetPolicyRequest<'a> {
    pub(crate) branch: &'a str,
    pub(crate) file: &'a str,
    pub(crate) message: &'a str,
    pub(crate) bytes: &'a [u8],
    /// The blob SHA being replaced; `None` creates the file.
    pub(crate) expected_sha: Option<&'a str>,
}

pub(crate) trait PolicyClient {
    fn get_policy_before(
        &self,
        branch: &str,
        file: &str,
        deadline: Option<Instant>,
    ) -> Result<Option<DiscoveryHead>, PublisherError>;
    /// Like [`Self::get_policy_before`], for a caller that holds `original`:
    /// an unchanged file is reported without fetching its contents.
    fn probe_policy(
        &self,
        branch: &str,
        file: &str,
        deadline: Instant,
        original: Option<&DiscoveryHead>,
    ) -> Result<Observed, PublisherError> {
        self.get_policy_before(branch, file, Some(deadline))
            .map(|head| Observed::compared(head, original))
    }
    fn set_policy(&self, request: SetPolicyRequest<'_>) -> Result<(), PublisherError>;
}

pub(crate) trait DiscoveryClient {
    fn get_discovery(&self, branch: &str) -> Result<Option<DiscoveryHead>, PublisherError>;
    fn get_discovery_before(
        &self,
        branch: &str,
        deadline: Instant,
    ) -> Result<Option<DiscoveryHead>, PublisherError> {
        super::request::check_deadline(Some(deadline))?;
        let result = self.get_discovery(branch);
        super::request::check_deadline(Some(deadline))?;
        result
    }
    /// Like [`Self::get_discovery_before`], for a caller that holds
    /// `original`: an unchanged file is reported without fetching its contents.
    fn probe_discovery(
        &self,
        branch: &str,
        deadline: Instant,
        original: Option<&DiscoveryHead>,
    ) -> Result<Observed, PublisherError> {
        self.get_discovery_before(branch, deadline)
            .map(|head| Observed::compared(head, original))
    }
    fn set_discovery(&self, request: SetDiscoveryRequest<'_>) -> Result<(), PublisherError>;
}

impl DiscoveryClient for GitHubClient {
    fn get_discovery(&self, branch: &str) -> Result<Option<DiscoveryHead>, PublisherError> {
        self.read_discovery_file(branch, DISCOVERY_FILENAME, None)
    }

    fn get_discovery_before(
        &self,
        branch: &str,
        deadline: Instant,
    ) -> Result<Option<DiscoveryHead>, PublisherError> {
        super::request::check_deadline(Some(deadline))?;
        let result = self.read_discovery_file(branch, DISCOVERY_FILENAME, Some(deadline));
        super::request::check_deadline(Some(deadline))?;
        result
    }

    fn probe_discovery(
        &self,
        branch: &str,
        deadline: Instant,
        original: Option<&DiscoveryHead>,
    ) -> Result<Observed, PublisherError> {
        super::request::check_deadline(Some(deadline))?;
        let result = self.read_discovery_entry(
            branch,
            DISCOVERY_FILENAME,
            Some(deadline),
            Some(Known::of(original)),
        );
        super::request::check_deadline(Some(deadline))?;
        result
    }

    fn set_discovery(&self, request: SetDiscoveryRequest<'_>) -> Result<(), PublisherError> {
        self.put_file(SetPolicyRequest {
            branch: request.branch,
            file: DISCOVERY_FILENAME,
            message: UPDATE_MESSAGE,
            bytes: request.bytes,
            expected_sha: request.expected_sha,
        })
    }
}

impl PolicyClient for GitHubClient {
    fn get_policy_before(
        &self,
        branch: &str,
        file: &str,
        deadline: Option<Instant>,
    ) -> Result<Option<DiscoveryHead>, PublisherError> {
        cadencr_registry_core::discovery_object_url(&self.repository, branch, file)?;
        super::request::check_deadline(deadline)?;
        let result = self.read_discovery_file(branch, file, deadline);
        super::request::check_deadline(deadline)?;
        result
    }

    fn probe_policy(
        &self,
        branch: &str,
        file: &str,
        deadline: Instant,
        original: Option<&DiscoveryHead>,
    ) -> Result<Observed, PublisherError> {
        cadencr_registry_core::discovery_object_url(&self.repository, branch, file)?;
        super::request::check_deadline(Some(deadline))?;
        let result =
            self.read_discovery_entry(branch, file, Some(deadline), Some(Known::of(original)));
        super::request::check_deadline(Some(deadline))?;
        result
    }

    fn set_policy(&self, request: SetPolicyRequest<'_>) -> Result<(), PublisherError> {
        cadencr_registry_core::discovery_object_url(
            &self.repository,
            request.branch,
            request.file,
        )?;
        self.put_file(request)
    }
}

impl GitHubClient {
    /// Create (`expected_sha: None`) or conditionally replace one file on a
    /// discovery branch. GitHub rejects a stale or already-existing target.
    fn put_file(&self, request: SetPolicyRequest<'_>) -> Result<(), PublisherError> {
        validate_discovery_branch(request.branch)?;
        if request.bytes.len() > MAX_DISCOVERY_BYTES {
            return Err(error("GitHub discovery bytes are invalid"));
        }
        if request.expected_sha.is_some_and(|sha| !valid_sha(sha)) {
            return Err(error("GitHub discovery expected SHA is invalid"));
        }
        let body = SetBody {
            branch: request.branch,
            message: request.message,
            content: STANDARD.encode(request.bytes),
            sha: request.expected_sha,
        };
        let expected = if request.expected_sha.is_some() {
            StatusCode::OK
        } else {
            StatusCode::CREATED
        };
        let _: serde_json::Value = self.request.put(
            &format!("/repos/{}/contents/{}", self.repository, request.file),
            &body,
            expected,
        )?;
        Ok(())
    }
}

#[derive(Serialize)]
struct SetBody<'a> {
    branch: &'a str,
    message: &'a str,
    content: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    sha: Option<&'a str>,
}

#[cfg(test)]
mod tests {
    use std::io::{Read, Write};
    use std::net::TcpListener;

    use crate::github::fixture::{client, serve_json};

    use super::*;

    fn blob(bytes: &[u8]) -> String {
        let mut hash = Sha1::new();
        hash.update(format!("blob {}\0", bytes.len()));
        hash.update(bytes);
        crate::hex(&hash.finalize())
    }

    fn serve_sequence(bodies: Vec<String>) -> (String, std::thread::JoinHandle<Vec<String>>) {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        listener.set_nonblocking(true).unwrap();
        let address = listener.local_addr().unwrap();
        let handle = std::thread::spawn(move || {
            let mut observed = Vec::new();
            for body in bodies {
                let mut stream = accept_bounded(&listener);
                let mut bytes = [0_u8; 16 * 1024];
                let count = stream.read(&mut bytes).unwrap();
                observed.push(String::from_utf8_lossy(&bytes[..count]).into_owned());
                write!(
                    stream,
                    "HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
                    body.len()
                )
                .unwrap();
            }
            observed
        });
        (format!("http://{address}"), handle)
    }

    fn accept_bounded(listener: &TcpListener) -> std::net::TcpStream {
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(3);
        loop {
            match listener.accept() {
                Ok((stream, _)) => {
                    stream.set_nonblocking(false).unwrap();
                    stream
                        .set_read_timeout(Some(std::time::Duration::from_secs(2)))
                        .unwrap();
                    stream
                        .set_write_timeout(Some(std::time::Duration::from_secs(2)))
                        .unwrap();
                    return stream;
                }
                Err(error)
                    if error.kind() == std::io::ErrorKind::WouldBlock
                        && std::time::Instant::now() < deadline =>
                {
                    std::thread::sleep(std::time::Duration::from_millis(5));
                }
                Err(error) => panic!("fixture accept failed: {error}"),
            }
        }
    }

    #[test]
    fn authenticated_get_walks_commit_tree_and_verifies_content() {
        let commit = "a".repeat(40);
        let tree = "b".repeat(40);
        let bytes = b"catalog\n";
        let blob = blob(bytes);
        let (api, observed) = serve_sequence(vec![
            format!(
                r#"{{"ref":"refs/heads/catalog","object":{{"type":"commit","sha":"{commit}"}}}}"#
            ),
            format!(r#"{{"sha":"{commit}","tree":{{"sha":"{tree}"}}}}"#),
            format!(
                r#"{{"sha":"{tree}","truncated":false,"tree":[null,{{"path":"unrelated"}},{{"path":"managed-index.json","mode":"100644","type":"blob","sha":"{blob}","size":{}}}]}}"#,
                bytes.len()
            ),
            format!(
                r#"{{"type":"file","path":"managed-index.json","name":"managed-index.json","encoding":"base64","sha":"{blob}","size":{},"content":"{}"}}"#,
                bytes.len(),
                STANDARD.encode(bytes)
            ),
        ]);
        assert_eq!(
            client(api).get_discovery("catalog").unwrap(),
            Some(DiscoveryHead {
                sha: blob,
                bytes: bytes.to_vec()
            })
        );
        let requests = observed.join().unwrap();
        for (request, path) in requests.iter().zip([
            "/repos/acme/releases/git/ref/heads/catalog",
            &format!("/repos/acme/releases/git/commits/{commit}"),
            &format!("/repos/acme/releases/git/trees/{tree}"),
            &format!("/repos/acme/releases/contents/managed-index.json?ref={commit}"),
        ]) {
            assert!(
                request.starts_with(&format!("GET {path} HTTP/1.1")),
                "{request}"
            );
            assert!(request.contains("authorization: Bearer secret-token"));
        }
    }

    #[test]
    fn large_discovery_uses_pinned_blob_and_catalog_sized_json_budget() {
        let commit = "a".repeat(40);
        let tree = "b".repeat(40);
        let bytes = vec![b'x'; 2 * 1024 * 1024];
        let sha = blob(&bytes);
        let (api, observed) = serve_sequence(vec![
            format!(
                r#"{{"ref":"refs/heads/catalog","object":{{"type":"commit","sha":"{commit}"}}}}"#
            ),
            format!(r#"{{"sha":"{commit}","tree":{{"sha":"{tree}"}}}}"#),
            format!(
                r#"{{"sha":"{tree}","truncated":false,"tree":[{{"path":"managed-index.json","mode":"100644","type":"blob","sha":"{sha}","size":{}}}]}}"#,
                bytes.len()
            ),
            format!(
                r#"{{"encoding":"base64","sha":"{sha}","size":{},"content":"{}"}}"#,
                bytes.len(),
                STANDARD.encode(&bytes)
            ),
        ]);
        assert_eq!(
            client(api)
                .get_discovery_before(
                    "catalog",
                    Instant::now() + std::time::Duration::from_secs(5)
                )
                .unwrap()
                .unwrap()
                .bytes,
            bytes
        );
        assert!(observed.join().unwrap()[3].starts_with(&format!(
            "GET /repos/acme/releases/git/blobs/{sha} HTTP/1.1"
        )));
    }

    /// The three Git reads that resolve `managed-index.json` to `sha`.
    fn tree_walk(sha: Option<&str>) -> Vec<String> {
        let commit = "a".repeat(40);
        let tree = "b".repeat(40);
        let entries = sha.map_or_else(String::new, |sha| {
            format!(
                r#"{{"path":"managed-index.json","mode":"100644","type":"blob","sha":"{sha}","size":3}}"#
            )
        });
        vec![
            format!(
                r#"{{"ref":"refs/heads/catalog","object":{{"type":"commit","sha":"{commit}"}}}}"#
            ),
            format!(r#"{{"sha":"{commit}","tree":{{"sha":"{tree}"}}}}"#),
            format!(r#"{{"sha":"{tree}","truncated":false,"tree":[{entries}]}}"#),
        ]
    }

    #[test]
    fn a_probe_that_finds_the_known_state_never_fetches_contents() {
        let deadline = Instant::now() + std::time::Duration::from_secs(5);
        let old = blob(b"old");
        let held = DiscoveryHead {
            sha: old.clone(),
            bytes: b"old".to_vec(),
        };
        // Same blob as the caller holds: the tree walk is the only traffic.
        let (api, observed) = serve_sequence(tree_walk(Some(&old)));
        let probed = client(api)
            .probe_discovery("catalog", deadline, Some(&held))
            .unwrap();
        assert!(matches!(probed, Observed::Unchanged));
        assert_eq!(observed.join().unwrap().len(), 3);
        // Absent file, absent expected.
        let (api, observed) = serve_sequence(tree_walk(None));
        let probed = client(api)
            .probe_discovery("catalog", deadline, None)
            .unwrap();
        assert!(matches!(probed, Observed::Unchanged));
        assert_eq!(observed.join().unwrap().len(), 3);
        // A file where none was expected is a change, and is fetched.
        let new = blob(b"new");
        let mut bodies = tree_walk(Some(&new));
        bodies.push(format!(
            r#"{{"type":"file","path":"managed-index.json","name":"managed-index.json","encoding":"base64","sha":"{new}","size":3,"content":"{}"}}"#,
            STANDARD.encode(b"new")
        ));
        let (api, observed) = serve_sequence(bodies);
        let probed = client(api)
            .probe_discovery("catalog", deadline, Some(&held))
            .unwrap();
        assert!(matches!(
            probed,
            Observed::Head(Some(head)) if head.bytes == b"new"
        ));
        assert_eq!(observed.join().unwrap().len(), 4);
    }

    #[test]
    fn missing_branch_is_an_error_but_missing_file_is_none() {
        let (api, _) = serve_json("404 Not Found", "missing");
        assert!(client(api).get_discovery("catalog").is_err());
        let commit = "a".repeat(40);
        let tree = "b".repeat(40);
        let (api, observed) = serve_sequence(vec![
            format!(
                r#"{{"ref":"refs/heads/catalog","object":{{"type":"commit","sha":"{commit}"}}}}"#
            ),
            format!(r#"{{"sha":"{commit}","tree":{{"sha":"{tree}"}}}}"#),
            format!(r#"{{"sha":"{tree}","truncated":false,"tree":[]}}"#),
        ]);
        assert_eq!(client(api).get_discovery("catalog").unwrap(), None);
        assert_eq!(observed.join().unwrap().len(), 3);
    }

    #[test]
    fn policy_files_are_read_and_written_at_their_own_fixed_path() {
        let commit = "a".repeat(40);
        let tree = "b".repeat(40);
        let bytes = b"policy\n";
        let blob = blob(bytes);
        let file = "managed-theme-blocklist.json";
        let (api, observed) = serve_sequence(vec![
            format!(
                r#"{{"ref":"refs/heads/catalog","object":{{"type":"commit","sha":"{commit}"}}}}"#
            ),
            format!(r#"{{"sha":"{commit}","tree":{{"sha":"{tree}"}}}}"#),
            format!(
                r#"{{"sha":"{tree}","truncated":false,"tree":[{{"path":"managed-index.json","mode":"100644","type":"blob","sha":"{}","size":1}},{{"path":"{file}","mode":"100644","type":"blob","sha":"{blob}","size":{}}}]}}"#,
                "d".repeat(40),
                bytes.len()
            ),
            format!(
                r#"{{"type":"file","path":"{file}","name":"{file}","encoding":"base64","sha":"{blob}","size":{},"content":"{}"}}"#,
                bytes.len(),
                STANDARD.encode(bytes)
            ),
        ]);
        let head = client(api)
            .get_policy_before("catalog", file, None)
            .unwrap()
            .unwrap();
        assert_eq!(head.bytes, bytes);
        assert!(observed.join().unwrap()[3].starts_with(&format!(
            "GET /repos/acme/releases/contents/{file}?ref={commit} HTTP/1.1"
        )));

        let (api, observed) = serve_json("200 OK", "{}");
        client(api)
            .set_policy(
                SetPolicyRequest::builder()
                    .branch("catalog")
                    .file(file)
                    .message("Update managed theme revocation policy")
                    .bytes(b"abc")
                    .expected_sha(&blob)
                    .build(),
            )
            .unwrap();
        let request = observed.join().unwrap();
        assert!(request.starts_with(&format!(
            "PUT /repos/acme/releases/contents/{file} HTTP/1.1"
        )));
        assert!(request.contains(r#""message":"Update managed theme revocation policy""#));
        assert!(request.contains(&format!(r#""sha":"{blob}""#)));
        // Only the catalog and the three policies are addressable.
        for other in [
            "other.json",
            "../managed-index.json",
            "managed-index.json/x",
        ] {
            assert!(client("http://127.0.0.1:1".into())
                .set_policy(
                    SetPolicyRequest::builder()
                        .branch("catalog")
                        .file(other)
                        .message("m")
                        .bytes(b"abc")
                        .build()
                )
                .is_err());
        }
    }

    #[test]
    fn put_body_and_compare_and_swap_status_are_exact() {
        let (api, observed) = serve_json("201 Created", "{}");
        client(api)
            .set_discovery(
                SetDiscoveryRequest::builder()
                    .branch("catalog")
                    .bytes(b"abc")
                    .build(),
            )
            .unwrap();
        let request = observed.join().unwrap();
        assert!(
            request.starts_with("PUT /repos/acme/releases/contents/managed-index.json HTTP/1.1")
        );
        assert!(request.contains(r#"{"branch":"catalog","message":"Update managed provider discovery index","content":"YWJj"}"#));

        let sha = "c".repeat(40);
        let (api, observed) = serve_json("200 OK", "{}");
        client(api)
            .set_discovery(
                SetDiscoveryRequest::builder()
                    .branch("catalog")
                    .bytes(b"abc")
                    .expected_sha(&sha)
                    .build(),
            )
            .unwrap();
        assert!(observed
            .join()
            .unwrap()
            .contains(&format!(r#""sha":"{sha}""#)));
        for status in ["200 OK", "409 Conflict"] {
            let (api, observed) = serve_json(status, "{}");
            assert!(client(api)
                .set_discovery(
                    SetDiscoveryRequest::builder()
                        .branch("catalog")
                        .bytes(b"abc")
                        .build()
                )
                .is_err());
            assert_eq!(observed.join().unwrap().matches("PUT ").count(), 1);
        }
    }
}
