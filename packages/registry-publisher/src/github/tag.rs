use serde::Serialize;

use std::time::Instant;

use super::{model::RawTagReference, validation::text, GitHubClient, ReleaseClient};
use crate::convergence::{converge, Converged, ReadBack, Verdict};
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
        ensure()
            .tag(tag)
            .commit(commit)
            .pacing(&ReadBack::production())
            .lookup(|| self.get_tag_commit(tag))
            .lookup_before(|deadline| self.get_tag_commit_before(tag, deadline))
            .create(|| {
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
            })
            .call()
    }
}

/// Create `tag` at `commit` once, trusting only an authoritative GET.
///
/// After an accepted create, an absent tag is replication lag and is waited
/// out within `pacing`; the expected commit is success and any other commit is
/// a conflicting writer, refused at once. After a failed or lost create, one
/// probe reconciles: only the exact tag counts, otherwise the write's own error.
#[bon::builder]
fn ensure(
    tag: &str,
    commit: &str,
    pacing: &ReadBack,
    lookup: impl Fn() -> Result<Option<String>, PublisherError>,
    lookup_before: impl Fn(Instant) -> Result<Option<String>, PublisherError>,
    create: impl FnOnce() -> Result<(), PublisherError>,
) -> Result<(), PublisherError> {
    if let Some(existing) = lookup()? {
        return require_exact(&existing, commit, tag);
    }
    // Never retry a write or trust even a successful response without an
    // authoritative subsequent GET.
    match create() {
        Ok(()) => {
            let converged = converge(pacing, &lookup_before, |found| {
                Ok(match found {
                    None => Verdict::Stale,
                    Some(existing) if existing == commit => Verdict::Done(()),
                    Some(_) => Verdict::Foreign,
                })
            })?;
            match converged {
                Converged::Done(()) => Ok(()),
                Converged::Foreign => Err(conflict(tag)),
                Converged::Stale(reads) => Err(PublisherError::new(format!(
                    "publication tag {tag} was created but {reads} authoritative reads over {}s \
                     still returned the stale pre-write state (tag absent); re-run to verify \
                     once the tag is visible",
                    pacing.budget.as_secs()
                ))),
            }
        }
        Err(primary) => match lookup()? {
            Some(existing) => require_exact(&existing, commit, tag),
            None => Err(primary),
        },
    }
}

fn require_exact(existing: &str, expected: &str, tag: &str) -> Result<(), PublisherError> {
    if existing == expected {
        Ok(())
    } else {
        Err(conflict(tag))
    }
}

fn conflict(tag: &str) -> PublisherError {
    PublisherError::new(format!(
        "publication tag {tag} conflicts with registry commit"
    ))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::convergence::VirtualClock;
    use std::cell::Cell;

    fn ensure_with(
        pacing: &ReadBack,
        lookup: impl Fn() -> Result<Option<String>, PublisherError>,
        create: impl FnOnce() -> Result<(), PublisherError>,
    ) -> Result<(), PublisherError> {
        ensure()
            .tag("tag")
            .commit("a")
            .pacing(pacing)
            .lookup(&lookup)
            .lookup_before(|_| lookup())
            .create(create)
            .call()
    }

    /// `ensure` over a virtual clock; the reads are scripted by `lookup`.
    fn ensure_paced(
        clock: &VirtualClock,
        lookup: impl Fn() -> Result<Option<String>, PublisherError>,
        create: impl FnOnce() -> Result<(), PublisherError>,
    ) -> Result<(), PublisherError> {
        ensure_with(&clock.read_back(), lookup, create)
    }

    /// Absent on the first read, then `lag` more absent reads, then `then`.
    fn lagging(
        lag: usize,
        then: &'static str,
    ) -> impl Fn() -> Result<Option<String>, PublisherError> {
        let reads = Cell::new(0);
        move || {
            reads.set(reads.get() + 1);
            Ok((reads.get() > 1 + lag).then(|| then.to_owned()))
        }
    }

    #[test]
    fn a_created_tag_that_reads_absent_is_waited_out_then_accepted() {
        let clock = VirtualClock::new();
        let writes = Cell::new(0);
        ensure_paced(&clock, lagging(3, "a"), || {
            writes.set(writes.get() + 1);
            Ok(())
        })
        .unwrap();
        assert_eq!(writes.get(), 1);
        let backoff: Vec<_> = [250, 500, 1000]
            .map(std::time::Duration::from_millis)
            .into();
        assert_eq!(*clock.waits.borrow(), backoff);
    }

    #[test]
    fn a_created_tag_that_never_shows_fails_with_a_stale_message_after_the_budget() {
        let clock = VirtualClock::new();
        let message = ensure_paced(&clock, lagging(usize::MAX - 1, "a"), || Ok(()))
            .unwrap_err()
            .to_string();
        assert!(message.contains("stale pre-write state"), "{message}");
        assert!(message.contains("tag absent"), "{message}");
        let waited: std::time::Duration = clock.waits.borrow().iter().sum();
        assert!(waited <= std::time::Duration::from_secs(30), "{waited:?}");
        assert!(waited > std::time::Duration::from_secs(15), "{waited:?}");
    }

    #[test]
    fn a_foreign_commit_after_a_created_tag_stops_at_once() {
        let clock = VirtualClock::new();
        let message = ensure_paced(&clock, lagging(1, "b"), || Ok(()))
            .unwrap_err()
            .to_string();
        assert!(
            message.contains("conflicts with registry commit"),
            "{message}"
        );
        assert_eq!(clock.waits.borrow().len(), 1);
    }

    #[test]
    fn a_failed_create_is_probed_once_and_never_waited_for() {
        let clock = VirtualClock::new();
        let message = ensure_paced(&clock, lagging(5, "a"), || {
            Err(PublisherError::new("lost response"))
        })
        .unwrap_err()
        .to_string();
        assert_eq!(message, "lost response");
        assert!(clock.waits.borrow().is_empty());
    }

    #[test]
    fn exact_tags_are_idempotent_conflicts_never_write_and_lost_responses_are_probed() {
        let writes = Cell::new(0);
        for value in ["a", "b"] {
            let result = ensure_with(
                &ReadBack::production(),
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
            let result = ensure_with(
                &ReadBack::production(),
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
    use std::io::Write;
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
                let request = super::super::fixture::read_request(&mut stream);
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

    #[test]
    fn tag_and_asset_reads_are_bounded_by_the_convergence_deadline() {
        use crate::github::ReleaseClient as _;
        use std::time::{Duration, Instant};

        let client = crate::github::fixture::client("http://127.0.0.1:1".into());
        let expired = Instant::now();
        for error in [
            client.get_tag_commit_before("v1", expired).unwrap_err(),
            client.list_assets_before(7, expired).unwrap_err(),
        ] {
            assert!(error.to_string().contains("deadline exceeded"), "{error}");
        }
        // A server that sends headers and then stalls cannot outlive it.
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let api = format!("http://{}", listener.local_addr().unwrap());
        let server = std::thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            let _ = crate::github::fixture::read_request(&mut stream);
            write!(
                stream,
                "HTTP/1.1 200 OK\r\nContent-Length: 2\r\nConnection: close\r\n\r\n"
            )
            .unwrap();
            std::thread::sleep(Duration::from_millis(800));
        });
        let client = crate::github::fixture::client(api);
        let started = Instant::now();
        let deadline = started + Duration::from_millis(250);
        assert!(client.get_tag_commit_before("v1", deadline).is_err());
        assert!(started.elapsed() < Duration::from_millis(600));
        server.join().unwrap();
    }
}
