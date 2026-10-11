use crate::binding::PublicationBinding;
use crate::github::{Release, ReleaseClient};
use crate::mirror::artifacts::validated_assets;
use crate::mirror::release::{validate_bound_release, validate_published_release};
use crate::promote::local::require_same_assets;
use crate::PublisherError;

pub(super) fn publish_bound_draft(
    client: &impl ReleaseClient,
    binding: &PublicationBinding,
    commit: &str,
    id: u64,
    assets: &[crate::github::Asset],
) -> Result<Release, PublisherError> {
    let release = revalidate_draft(client, binding, commit, id)?;
    require_same_assets(
        assets,
        &validated_assets(client.list_assets(release.id)?, &binding.expected, true)?,
    )?;
    verify_exact_tag(
        client,
        &binding.tag,
        commit,
        "immediately before publication",
    )?;
    match client.publish_draft(release.id) {
        Ok(release) => Ok(release),
        Err(primary) => match client.find_release(&binding.tag)? {
            Some(recovered)
                if validate_published_release(
                    &recovered,
                    &binding.tag,
                    commit,
                    &binding.body,
                    release.id,
                )
                .is_ok() =>
            {
                Ok(recovered)
            }
            _ => Err(primary),
        },
    }
}

pub(super) fn validate_bound_id(
    release: &Release,
    binding: &PublicationBinding,
    commit: &str,
    expected_id: u64,
) -> Result<(), PublisherError> {
    validate_bound_release(release, &binding.tag, commit, &binding.body)?;
    if release.id != expected_id {
        return Err(PublisherError::new(
            "mirror receipt release id conflicts with GitHub",
        ));
    }
    Ok(())
}

pub(super) fn revalidate_draft(
    client: &impl ReleaseClient,
    binding: &PublicationBinding,
    commit: &str,
    id: u64,
) -> Result<Release, PublisherError> {
    let release = client
        .find_release(&binding.tag)?
        .ok_or_else(|| PublisherError::new("release changed before publication"))?;
    validate_bound_id(&release, binding, commit, id)?;
    if !release.draft {
        return Err(PublisherError::new("release changed before publication"));
    }
    Ok(release)
}

pub(super) fn validate_final(
    client: &impl ReleaseClient,
    binding: &PublicationBinding,
    commit: &str,
    id: u64,
) -> Result<(), PublisherError> {
    let release = client
        .find_release(&binding.tag)?
        .ok_or_else(|| PublisherError::new("published release disappeared"))?;
    validate_published_release(&release, &binding.tag, commit, &binding.body, id)
}

pub(crate) fn verify_exact_tag(
    client: &impl ReleaseClient,
    tag: &str,
    commit: &str,
    timing: &str,
) -> Result<(), PublisherError> {
    if client.get_tag_commit(tag)?.as_deref() != Some(commit) {
        return Err(PublisherError::new(format!(
            "release tag commit does not match {timing}"
        )));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::github::{Asset, GitHubClient};
    use crate::mirror::fixture::{run as mirror, staged, FakeClient};
    use crate::{DownloadRequest, Downloaded, Downloader, StageRequest};
    use serde_json::json;
    use sha2::{Digest as _, Sha256};
    use std::io::{Read, Write};
    use std::net::TcpListener;
    use std::sync::{
        atomic::{AtomicBool, Ordering},
        Arc,
    };
    use std::time::Duration;

    struct PublicBytes(Vec<(Asset, Vec<u8>)>);
    impl Downloader for PublicBytes {
        fn download(&self, request: DownloadRequest<'_>) -> Result<Downloaded, PublisherError> {
            let (_, bytes) = self
                .0
                .iter()
                .find(|(a, _)| a.browser_download_url == request.url)
                .ok_or_else(|| PublisherError::new("unexpected public URL"))?;
            std::fs::write(&request.output, bytes).unwrap();
            Ok(Downloaded {
                sha256: crate::hex(&Sha256::digest(bytes)),
                size: bytes.len() as u64,
            })
        }
    }

    fn read_request(stream: &mut std::net::TcpStream) -> String {
        // macOS accepts may inherit the listener's nonblocking mode.
        stream.set_nonblocking(false).unwrap();
        stream
            .set_read_timeout(Some(Duration::from_secs(2)))
            .unwrap();
        let mut bytes = Vec::new();
        loop {
            let mut part = [0; 4096];
            let read = stream.read(&mut part).unwrap();
            assert!(read > 0 && bytes.len() + read <= 64 * 1024);
            bytes.extend_from_slice(&part[..read]);
            if let Some(end) = bytes.windows(4).position(|w| w == b"\r\n\r\n") {
                let head = String::from_utf8_lossy(&bytes[..end]).to_ascii_lowercase();
                let length = head
                    .lines()
                    .find_map(|l| l.strip_prefix("content-length:"))
                    .map(|s| s.trim().parse::<usize>().unwrap())
                    .unwrap_or(0);
                if bytes.len() >= end + 4 + length {
                    return String::from_utf8(bytes).unwrap();
                }
            }
        }
    }

    #[test]
    fn request_reader_handles_inherited_nonblocking_mode_before_bytes_arrive() {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let address = listener.local_addr().unwrap();
        let (ready, wait_ready) = std::sync::mpsc::channel();
        let server = std::thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            stream.set_nonblocking(true).unwrap();
            ready.send(()).unwrap();
            read_request(&mut stream)
        });
        let mut client = std::net::TcpStream::connect(address).unwrap();
        wait_ready.recv_timeout(Duration::from_secs(2)).unwrap();
        std::thread::sleep(Duration::from_millis(20));
        let request = "GET / HTTP/1.1\r\nHost: localhost\r\n\r\n";
        client.write_all(request.as_bytes()).unwrap();
        assert_eq!(server.join().unwrap(), request);
    }

    fn serve(
        release: Release,
        assets: Vec<(Asset, Vec<u8>)>,
        stop: Arc<AtomicBool>,
    ) -> (String, std::thread::JoinHandle<(usize, usize)>) {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        listener.set_nonblocking(true).unwrap();
        let base = format!("http://{}", listener.local_addr().unwrap());
        let server = std::thread::spawn(move || {
            let mut draft = true;
            let mut patches = 0;
            let mut downloads = 0;
            while !stop.load(Ordering::SeqCst) {
                let (mut stream, _) = match listener.accept() {
                    Ok(value) => value,
                    Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                        std::thread::sleep(Duration::from_millis(1));
                        continue;
                    }
                    Err(error) => panic!("accept: {error}"),
                };
                let request = read_request(&mut stream);
                assert!(request.contains("authorization: Bearer fixture-token"));
                let route = request.lines().next().unwrap();
                let body = if route.starts_with("PATCH /repos/cadencr/registry/releases/7 ") {
                    assert_eq!(
                        request.split("\r\n\r\n").nth(1).unwrap(),
                        r#"{"draft":false,"make_latest":"false"}"#
                    );
                    patches += 1;
                    draft = false;
                    continue; // GitHub persisted the PATCH, but its response was lost.
                } else if route.starts_with("GET /repos/cadencr/registry/releases?") {
                    serde_json::to_vec(&json!([{"id":release.id,"draft":draft,"prerelease":false,
                        "tag_name":release.tag_name,"target_commitish":release.target_commitish,
                        "body":release.body}]))
                    .unwrap()
                } else if route.starts_with("GET /repos/cadencr/registry/git/ref/tags/") {
                    serde_json::to_vec(&json!({"ref":format!("refs/tags/{}",release.tag_name),
                        "object":{"type":"commit","sha":release.target_commitish}}))
                    .unwrap()
                } else if route.starts_with("GET /repos/cadencr/registry/releases/7/assets?") {
                    serde_json::to_vec(&assets.iter().map(|(a,_)| json!({"id":a.id,"name":a.name,
                        "state":a.state,"size":a.size,"browser_download_url":a.browser_download_url}))
                        .collect::<Vec<_>>()).unwrap()
                } else {
                    let asset = assets
                        .iter()
                        .find(|(a, _)| {
                            route
                                == format!(
                                    "GET /repos/cadencr/registry/releases/assets/{} HTTP/1.1",
                                    a.id
                                )
                        })
                        .expect(route);
                    downloads += 1;
                    asset.1.clone()
                };
                write!(
                    stream,
                    "HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                    body.len()
                )
                .unwrap();
                stream.write_all(&body).unwrap();
            }
            (patches, downloads)
        });
        (base, server)
    }

    #[test]
    fn concrete_client_recovers_lost_promotion_and_replays_without_patch_or_private_download() {
        let (root, submission) = staged();
        let fixture = FakeClient::default();
        mirror(&root, &submission, &fixture).unwrap();
        let release = fixture.release.borrow().clone().unwrap();
        let assets = fixture.assets.borrow().clone();
        let stop = Arc::new(AtomicBool::new(false));
        let (base, server) = serve(release.clone(), assets.clone(), stop.clone());
        let client =
            GitHubClient::fixture("cadencr/registry", "fixture-token", base.clone(), base).unwrap();
        let run = || {
            crate::promote::promote(
                StageRequest::builder()
                    .submission(&submission)
                    .repository("cadencr/registry")
                    .directory(root.path())
                    .build(),
                crate::promote::PromotionExpectation::builder()
                    .registry_commit(&release.target_commitish)
                    .release_tag(&release.tag_name)
                    .build(),
                &client,
                &PublicBytes(assets.clone()),
            )
        };
        let first = run();
        let second = if first.is_ok() { Some(run()) } else { None };
        stop.store(true, Ordering::SeqCst);
        let counts = server.join().unwrap();
        let first = first.unwrap();
        assert_eq!(second.unwrap().unwrap(), first);
        assert_eq!(counts, (1, assets.len()));
    }
}
