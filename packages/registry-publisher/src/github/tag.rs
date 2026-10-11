use serde::Serialize;

use super::{model::RawTagReference, validation::text, GitHubClient, ReleaseClient};
use crate::PublisherError;

#[derive(Serialize)]
struct CreateReference<'a> {
    #[serde(rename = "ref")]
    reference: String,
    sha: &'a str,
}

impl GitHubClient {
    pub(crate) fn ensure_publication_tag(
        &self,
        tag: &str,
        commit: &str,
    ) -> Result<(), PublisherError> {
        text(tag, "release tag")?;
        crate::validate_registry_commit(commit)?;
        ensure(
            tag,
            commit,
            || self.get_tag_commit(tag),
            || {
                let raw: RawTagReference = self.request.post(
                    &format!("/repos/{}/git/refs", self.repository),
                    &CreateReference {
                        reference: format!("refs/tags/{tag}"),
                        sha: commit,
                    },
                )?;
                let target = raw.validate(tag)?;
                if target.kind != "commit" || target.sha != commit {
                    return Err(PublisherError::new(
                        "created publication tag does not match registry commit",
                    ));
                }
                Ok(())
            },
        )
    }
}

fn ensure(
    tag: &str,
    commit: &str,
    lookup: impl Fn() -> Result<Option<String>, PublisherError>,
    create: impl FnOnce() -> Result<(), PublisherError>,
) -> Result<(), PublisherError> {
    if let Some(existing) = lookup()? {
        return require_exact(&existing, commit, tag);
    }
    let result = create();
    // Creation can succeed while its response is lost. Never retry a write or
    // trust even a successful response without an authoritative subsequent GET.
    match lookup()? {
        Some(existing) => require_exact(&existing, commit, tag),
        None => Err(result
            .err()
            .unwrap_or_else(|| PublisherError::new("created publication tag is missing"))),
    }
}

fn require_exact(existing: &str, expected: &str, tag: &str) -> Result<(), PublisherError> {
    if existing == expected {
        Ok(())
    } else {
        Err(PublisherError::new(format!(
            "publication tag {tag} conflicts with registry commit"
        )))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::Cell;

    #[test]
    fn exact_tags_are_idempotent_conflicts_never_write_and_lost_responses_are_probed() {
        let writes = Cell::new(0);
        for value in ["a", "b"] {
            let result = ensure(
                "tag",
                "a",
                || Ok(Some(value.into())),
                || {
                    writes.set(writes.get() + 1);
                    Ok(())
                },
            );
            assert_eq!(result.is_ok(), value == "a");
        }
        assert_eq!(writes.get(), 0);
        for (response_ok, destination) in [
            (true, Some("a")),
            (false, Some("a")),
            (false, Some("b")),
            (false, None),
        ] {
            let reads = Cell::new(0);
            let result = ensure(
                "tag",
                "a",
                || {
                    reads.set(reads.get() + 1);
                    Ok(if reads.get() == 1 {
                        None
                    } else {
                        destination.map(str::to_owned)
                    })
                },
                || {
                    writes.set(writes.get() + 1);
                    if response_ok {
                        Ok(())
                    } else {
                        Err(PublisherError::new("lost response"))
                    }
                },
            );
            assert_eq!(result.is_ok(), destination == Some("a"));
            assert_eq!(reads.get(), 2);
        }
        assert_eq!(writes.get(), 4);
    }
}

#[cfg(test)]
mod http_tests {
    use std::io::{Read, Write};
    use std::net::TcpListener;

    fn serve(
        statuses: Vec<(&'static str, String)>,
    ) -> (String, std::thread::JoinHandle<Vec<String>>) {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        listener.set_nonblocking(true).unwrap();
        let address = listener.local_addr().unwrap();
        let thread = std::thread::spawn(move || {
            let mut observed = Vec::new();
            for (status, body) in statuses {
                let deadline = std::time::Instant::now() + std::time::Duration::from_secs(5);
                let mut stream = loop {
                    match listener.accept() {
                        Ok((stream, _)) => break stream,
                        Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                            assert!(
                                std::time::Instant::now() < deadline,
                                "missing tag fixture request"
                            );
                            std::thread::sleep(std::time::Duration::from_millis(5));
                        }
                        Err(error) => panic!("{error}"),
                    }
                };
                stream
                    .set_read_timeout(Some(std::time::Duration::from_secs(2)))
                    .unwrap();
                let mut request = Vec::new();
                loop {
                    let mut buffer = [0; 4096];
                    let n = stream.read(&mut buffer).unwrap();
                    assert!(n > 0);
                    request.extend_from_slice(&buffer[..n]);
                    if let Some(end) = request.windows(4).position(|b| b == b"\r\n\r\n") {
                        let headers = String::from_utf8_lossy(&request[..end]).to_ascii_lowercase();
                        let length = headers
                            .lines()
                            .find_map(|h| h.strip_prefix("content-length:"))
                            .map(|n| n.trim().parse::<usize>().unwrap())
                            .unwrap_or(0);
                        if request.len() >= end + 4 + length {
                            break;
                        }
                    }
                    assert!(request.len() < 64 * 1024);
                }
                observed.push(String::from_utf8(request).unwrap());
                if status != "lost" {
                    write!(stream,"HTTP/1.1 {status}\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",body.len()).unwrap();
                }
            }
            observed
        });
        (format!("http://{address}"), thread)
    }

    #[test]
    fn exact_creation_is_one_post_followed_by_authoritative_get_even_after_lost_response() {
        let commit = "a".repeat(40);
        let reference =
            format!(r#"{{"ref":"refs/tags/v1","object":{{"type":"commit","sha":"{commit}"}}}}"#);
        for status in ["201 Created", "lost", "422 Unprocessable Entity"] {
            let (api, observed) = serve(vec![
                ("404 Not Found", "missing".into()),
                (status, reference.clone()),
                ("200 OK", reference.clone()),
            ]);
            let client = crate::github::fixture::client(api);
            client.ensure_publication_tag("v1", &commit).unwrap();
            let observed = observed.join().unwrap();
            assert_eq!(observed.len(), 3);
            assert!(observed[0].starts_with("GET /repos/acme/releases/git/ref/tags/v1 "));
            assert!(observed[1].starts_with("POST /repos/acme/releases/git/refs "));
            assert!(observed[1].contains(&format!(r#"{{"ref":"refs/tags/v1","sha":"{commit}"}}"#)));
            assert!(observed[2].starts_with("GET /repos/acme/releases/git/ref/tags/v1 "));
        }
        let (api, observed) = serve(vec![("200 OK", reference)]);
        crate::github::fixture::client(api)
            .ensure_publication_tag("v1", &commit)
            .unwrap();
        assert_eq!(observed.join().unwrap().len(), 1);
    }
}
