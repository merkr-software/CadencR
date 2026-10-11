use crate::binding::{MirrorReceipt, PublicationBinding};
use crate::github::{CreateDraftRequest, Release, ReleaseClient};
use crate::PublisherError;

pub(super) fn resolve_release(
    client: &impl ReleaseClient,
    binding: &PublicationBinding,
    commit: &str,
    prior: Option<&MirrorReceipt>,
) -> Result<Release, PublisherError> {
    let release = match client.find_release(&binding.tag)? {
        Some(release) => release,
        None if prior.is_some() => {
            return Err(PublisherError::new(
                "mirror receipt refers to a missing release",
            ))
        }
        None => match client.create_draft(
            CreateDraftRequest::builder()
                .tag(&binding.tag)
                .commit(commit)
                .body(&binding.body)
                .build(),
        ) {
            Ok(release) => release,
            Err(primary) => client.find_release(&binding.tag)?.ok_or(primary)?,
        },
    };
    validate_bound_release(&release, &binding.tag, commit, &binding.body)?;
    if !release.draft {
        return Err(PublisherError::new(
            "refusing non-draft or published release",
        ));
    }
    if prior.is_some_and(|receipt| receipt.release_id != release.id) {
        return Err(PublisherError::new(
            "mirror receipt release id conflicts with GitHub",
        ));
    }
    Ok(release)
}

pub(crate) fn validate_bound_release(
    release: &Release,
    tag: &str,
    commit: &str,
    body: &str,
) -> Result<(), PublisherError> {
    if release.prerelease {
        return Err(PublisherError::new("release must not be a prerelease"));
    }
    if release.tag_name != tag {
        return Err(PublisherError::new(
            "release tag does not match publication plan",
        ));
    }
    if release.target_commitish != commit {
        return Err(PublisherError::new("release target commit does not match"));
    }
    if release.body != body {
        return Err(PublisherError::new(
            "release body does not match immutable binding",
        ));
    }
    if release.id == 0 {
        return Err(PublisherError::new("release id is invalid"));
    }
    Ok(())
}

pub(crate) fn validate_published_release(
    release: &Release,
    tag: &str,
    commit: &str,
    body: &str,
    expected_id: u64,
) -> Result<(), PublisherError> {
    validate_bound_release(release, tag, commit, body)?;
    if release.id != expected_id {
        return Err(PublisherError::new(
            "mirror receipt release id conflicts with GitHub",
        ));
    }
    if release.draft {
        return Err(PublisherError::new("release is not published"));
    }
    Ok(())
}

pub(super) fn revalidate_release(
    client: &impl ReleaseClient,
    release: &Release,
    commit: &str,
    body: &str,
) -> Result<(), PublisherError> {
    let current = client
        .find_release(&release.tag_name)?
        .ok_or_else(|| PublisherError::new("draft release disappeared during mirroring"))?;
    validate_bound_release(&current, &release.tag_name, commit, body)?;
    if !current.draft {
        return Err(PublisherError::new(
            "refusing non-draft or published release",
        ));
    }
    if current.id != release.id {
        return Err(PublisherError::new(
            "draft release identity changed during mirroring",
        ));
    }
    Ok(())
}

/// Drafts may not have created their tag yet; an existing ref must match.
pub(super) fn verify_tag(
    client: &impl ReleaseClient,
    tag: &str,
    commit: &str,
) -> Result<(), PublisherError> {
    if client
        .get_tag_commit(tag)?
        .is_some_and(|actual| actual != commit)
    {
        return Err(PublisherError::new(
            "release tag commit does not match registry commit",
        ));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use std::io::{Read, Write};
    use std::net::{TcpListener, TcpStream};
    use std::sync::atomic::{AtomicBool, Ordering};
    use std::sync::{Arc, Mutex};
    use std::time::Duration;

    use serde_json::json;

    use crate::github::GitHubClient;
    use crate::StageRequest;

    const REPOSITORY: &str = "cadencr/registry";
    const COMMIT: &str = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
    const TAG: &str = "provider-acme-v1.0.0";

    #[derive(Default)]
    struct State {
        release: Option<serde_json::Value>,
        lose_create: bool,
        creates: usize,
        uploads: usize,
        assets: Vec<(u64, String, Vec<u8>)>,
        saw_auth: bool,
        unauthenticated: usize,
    }

    #[test]
    fn real_client_mirrors_recovers_lost_create_and_replays_without_posts() {
        let (root, submission) = super::super::fixture::staged();
        let (base, state, stop, server) = server();
        let client = GitHubClient::fixture(REPOSITORY, "secret-token", base.clone(), base).unwrap();
        let request = || {
            StageRequest::builder()
                .submission(&submission)
                .repository(REPOSITORY)
                .directory(root.path())
                .build()
        };
        let first = super::super::mirror(request(), COMMIT, &client).unwrap();
        assert_eq!(first.status, "draft_verified");
        let before = {
            let state = state.lock().unwrap();
            assert!(state.saw_auth);
            assert_eq!(state.unauthenticated, 0);
            assert_eq!(state.creates, 1);
            assert_eq!(state.uploads, 2);
            assert!(state.assets.iter().any(|(_, _, bytes)| bytes == b"archive"));
            assert!(state.assets.iter().any(|(_, name, bytes)| {
                name == "publication-plan.json" && bytes.ends_with(b"\n")
            }));
            (state.creates, state.uploads)
        };
        assert_eq!(
            super::super::mirror(request(), COMMIT, &client).unwrap(),
            first
        );
        let state = state.lock().unwrap();
        assert_eq!((state.creates, state.uploads), before);
        drop(state);
        stop.store(true, Ordering::Release);
        TcpStream::connect(server.0).unwrap();
        server.1.join().unwrap();
    }

    type ServerFixture = (
        String,
        Arc<Mutex<State>>,
        Arc<AtomicBool>,
        (std::net::SocketAddr, std::thread::JoinHandle<()>),
    );

    fn server() -> ServerFixture {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let address = listener.local_addr().unwrap();
        let state = Arc::new(Mutex::new(State {
            lose_create: true,
            ..State::default()
        }));
        let stop = Arc::new(AtomicBool::new(false));
        let shared = Arc::clone(&state);
        let stopping = Arc::clone(&stop);
        let handle = std::thread::spawn(move || {
            while !stopping.load(Ordering::Acquire) {
                let (mut stream, _) = listener.accept().unwrap();
                stream
                    .set_read_timeout(Some(Duration::from_secs(2)))
                    .unwrap();
                if stopping.load(Ordering::Acquire) {
                    break;
                }
                serve(&mut stream, &shared);
            }
        });
        (format!("http://{address}"), state, stop, (address, handle))
    }

    fn serve(stream: &mut TcpStream, shared: &Mutex<State>) {
        let Some((head, body)) = read_request(stream) else {
            return;
        };
        let first = head.lines().next().unwrap_or_default();
        let mut state = shared.lock().unwrap();
        let authenticated = head
            .to_ascii_lowercase()
            .contains("authorization: bearer secret-token");
        state.saw_auth |= authenticated;
        if !authenticated {
            state.unauthenticated += 1;
        }
        if first.starts_with("GET /repos/cadencr/registry/git/ref/tags/") {
            respond(stream, "404 Not Found", "application/json", b"{}");
        } else if first.starts_with("GET /repos/cadencr/registry/releases?") {
            let value = if let Some(release) = &state.release {
                json!([release])
            } else {
                json!([])
            };
            json_response(stream, "200 OK", &value);
        } else if first.starts_with("POST /repos/cadencr/registry/releases ") {
            state.creates += 1;
            let draft: serde_json::Value = serde_json::from_slice(&body).unwrap();
            let release = json!({
                "id":7,
                "draft":true,
                "prerelease":false,
                "tag_name":draft["tag_name"],
                "target_commitish":draft["target_commitish"],
                "body":draft["body"]
            });
            state.release = Some(release.clone());
            if state.lose_create {
                state.lose_create = false;
            } else {
                json_response(stream, "201 Created", &release);
            }
        } else if first.starts_with("GET /repos/cadencr/registry/releases/7/assets?") {
            let assets: Vec<_> = state
                .assets
                .iter()
                .map(|(id, name, bytes)| asset(*id, name, bytes.len()))
                .collect();
            json_response(stream, "200 OK", &assets);
        } else if first.starts_with("POST /repos/cadencr/registry/releases/7/assets?name=") {
            let name = first
                .split("name=")
                .nth(1)
                .and_then(|value| value.split_whitespace().next())
                .unwrap()
                .replace("%2E", ".");
            state.uploads += 1;
            let id = state.uploads as u64;
            state.assets.push((id, name.clone(), body));
            json_response(
                stream,
                "201 Created",
                &asset(id, &name, state.assets.last().unwrap().2.len()),
            );
        } else if let Some(id) = first
            .strip_prefix("GET /repos/cadencr/registry/releases/assets/")
            .and_then(|value| value.split_whitespace().next())
            .and_then(|value| value.parse::<u64>().ok())
        {
            let bytes = state
                .assets
                .iter()
                .find(|item| item.0 == id)
                .unwrap()
                .2
                .clone();
            respond(stream, "200 OK", "application/octet-stream", &bytes);
        } else {
            respond(
                stream,
                "500 Internal Server Error",
                "text/plain",
                b"unexpected",
            );
        }
    }

    fn read_request(stream: &mut TcpStream) -> Option<(String, Vec<u8>)> {
        let mut bytes = Vec::new();
        let mut buffer = [0_u8; 8192];
        while bytes.len() < 512 * 1024 {
            let count = stream.read(&mut buffer).ok()?;
            if count == 0 {
                return None;
            }
            bytes.extend_from_slice(&buffer[..count]);
            if let Some(split) = bytes.windows(4).position(|value| value == b"\r\n\r\n") {
                let body_start = split + 4;
                let head = String::from_utf8(bytes[..split].to_vec()).ok()?;
                let length = head
                    .lines()
                    .find_map(|line| {
                        line.to_ascii_lowercase()
                            .strip_prefix("content-length:")?
                            .trim()
                            .parse::<usize>()
                            .ok()
                    })
                    .unwrap_or(0);
                while bytes.len() < body_start + length {
                    let count = stream.read(&mut buffer).ok()?;
                    if count == 0 {
                        return None;
                    }
                    bytes.extend_from_slice(&buffer[..count]);
                }
                return Some((head, bytes[body_start..body_start + length].to_vec()));
            }
        }
        None
    }

    fn asset(id: u64, name: &str, size: usize) -> serde_json::Value {
        json!({"id":id,"name":name,"state":"uploaded","browser_download_url":format!("https://github.com/{REPOSITORY}/releases/download/{TAG}/{name}"),"size":size})
    }

    fn json_response(stream: &mut TcpStream, status: &str, value: &impl serde::Serialize) {
        respond(
            stream,
            status,
            "application/json",
            &serde_json::to_vec(value).unwrap(),
        );
    }

    fn respond(stream: &mut TcpStream, status: &str, content_type: &str, body: &[u8]) {
        write!(stream, "HTTP/1.1 {status}\r\nContent-Type: {content_type}\r\nContent-Length: {}\r\nConnection: close\r\n\r\n", body.len()).unwrap();
        stream.write_all(body).unwrap();
    }
}
