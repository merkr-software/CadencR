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

mod model;

use model::{valid_sha, RawCommit, RawContent, RawRef, RawTree};

const UPDATE_MESSAGE: &str = "Update managed provider discovery index";

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct DiscoveryHead {
    pub(crate) sha: String,
    pub(crate) bytes: Vec<u8>,
}

#[derive(bon::Builder)]
pub(crate) struct SetDiscoveryRequest<'a> {
    pub(crate) branch: &'a str,
    pub(crate) bytes: &'a [u8],
    pub(crate) expected_sha: Option<&'a str>,
}

pub(crate) trait DiscoveryClient {
    fn get_discovery(&self, branch: &str) -> Result<Option<DiscoveryHead>, PublisherError>;
    fn set_discovery(&self, request: SetDiscoveryRequest<'_>) -> Result<(), PublisherError>;
}

impl DiscoveryClient for GitHubClient {
    fn get_discovery(&self, branch: &str) -> Result<Option<DiscoveryHead>, PublisherError> {
        validate_discovery_branch(branch)?;
        let reference: RawRef = self.request.get(&format!(
            "/repos/{}/git/ref/heads/{branch}",
            self.repository
        ))?;
        let commit_sha = reference.validate(branch)?;
        let commit: RawCommit = self.request.get(&format!(
            "/repos/{}/git/commits/{commit_sha}",
            self.repository
        ))?;
        let tree_sha = commit.validate(&commit_sha)?;
        let tree: RawTree = self
            .request
            .get(&format!("/repos/{}/git/trees/{tree_sha}", self.repository))?;
        let Some(entry) = tree.validate(&tree_sha)? else {
            return Ok(None);
        };
        let content: RawContent = self.request.get(&format!(
            "/repos/{}/contents/{DISCOVERY_FILENAME}?ref={commit_sha}",
            self.repository
        ))?;
        content.validate(&entry).map(Some)
    }

    fn set_discovery(&self, request: SetDiscoveryRequest<'_>) -> Result<(), PublisherError> {
        validate_discovery_branch(request.branch)?;
        if request.bytes.len() > MAX_DISCOVERY_BYTES {
            return Err(error("GitHub discovery bytes are invalid"));
        }
        if request.expected_sha.is_some_and(|sha| !valid_sha(sha)) {
            return Err(error("GitHub discovery expected SHA is invalid"));
        }
        let body = SetBody {
            branch: request.branch,
            message: UPDATE_MESSAGE,
            content: STANDARD.encode(request.bytes),
            sha: request.expected_sha,
        };
        let expected = if request.expected_sha.is_some() {
            StatusCode::OK
        } else {
            StatusCode::CREATED
        };
        let _: serde_json::Value = self.request.put(
            &format!("/repos/{}/contents/{DISCOVERY_FILENAME}", self.repository),
            &body,
            expected,
        )?;
        Ok(())
    }
}

#[derive(Serialize)]
struct SetBody<'a> {
    branch: &'a str,
    message: &'static str,
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
