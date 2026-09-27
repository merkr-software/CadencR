use std::io::{Read, Write};
use std::net::TcpListener;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use serde_json::json;

use crate::github::{Asset, Release};

#[derive(Default)]
pub(super) struct Observed {
    pub(super) paths: Vec<String>,
    pub(super) authenticated: usize,
}

pub(super) fn serve(
    release: Release,
    assets: Vec<(Asset, Vec<u8>)>,
) -> (String, Arc<Mutex<Observed>>, std::thread::JoinHandle<()>) {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    listener.set_nonblocking(true).unwrap();
    let base = format!("http://{}", listener.local_addr().unwrap());
    let observed = Arc::new(Mutex::new(Observed::default()));
    let shared = Arc::clone(&observed);
    let handle = std::thread::spawn(move || {
        let deadline = Instant::now() + Duration::from_secs(5);
        let mut lost = false;
        while shared.lock().unwrap().paths.len() < 11 {
            assert!(
                Instant::now() < deadline,
                "fixture accept deadline exceeded"
            );
            let (mut stream, _) = match listener.accept() {
                Ok(value) => value,
                Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                    std::thread::sleep(Duration::from_millis(2));
                    continue;
                }
                Err(error) => panic!("fixture accept failed: {error}"),
            };
            stream.set_nonblocking(false).unwrap();
            stream
                .set_read_timeout(Some(Duration::from_secs(1)))
                .unwrap();
            stream
                .set_write_timeout(Some(Duration::from_secs(1)))
                .unwrap();
            let request = read_request(&mut stream);
            let first = request.lines().next().unwrap();
            let mut parts = first.split_whitespace();
            assert_eq!(parts.next(), Some("GET"));
            let path = parts.next().unwrap().to_owned();
            assert!(request
                .to_ascii_lowercase()
                .contains("authorization: bearer secret-token"));
            {
                let mut state = shared.lock().unwrap();
                state.authenticated += 1;
                state.paths.push(path.clone());
            }
            if path.starts_with("/repos/cadencr/registry/releases?") && !lost {
                lost = true;
                continue;
            }
            let body = response(&path, &release, &assets);
            write!(
                stream,
                "HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                body.len()
            )
            .unwrap();
            stream.write_all(&body).unwrap();
        }
    });
    (base, observed, handle)
}

fn read_request(stream: &mut std::net::TcpStream) -> String {
    let mut bytes = Vec::new();
    loop {
        let mut chunk = [0; 4096];
        let read = stream.read(&mut chunk).unwrap();
        assert!(read > 0 && bytes.len() + read <= 64 * 1024);
        bytes.extend_from_slice(&chunk[..read]);
        if bytes.windows(4).any(|window| window == b"\r\n\r\n") {
            return String::from_utf8(bytes).unwrap();
        }
    }
}

fn response(path: &str, release: &Release, assets: &[(Asset, Vec<u8>)]) -> Vec<u8> {
    if path.starts_with("/repos/cadencr/registry/releases?") {
        return serde_json::to_vec(&json!([{
            "id": release.id, "draft": release.draft, "prerelease": release.prerelease,
            "tag_name": release.tag_name, "target_commitish": release.target_commitish,
            "body": release.body
        }]))
        .unwrap();
    }
    if path
        == format!(
            "/repos/cadencr/registry/releases/{}/assets?per_page=100&page=1",
            release.id
        )
    {
        return serde_json::to_vec(
            &assets
                .iter()
                .map(|(asset, _)| {
                    json!({"id":asset.id,"name":asset.name,"state":asset.state,
                    "browser_download_url":asset.browser_download_url,"size":asset.size})
                })
                .collect::<Vec<_>>(),
        )
        .unwrap();
    }
    if path.starts_with("/repos/cadencr/registry/git/ref/tags/") {
        return serde_json::to_vec(&json!({"ref":format!("refs/tags/{}",release.tag_name),
            "object":{"type":"commit","sha":release.target_commitish}}))
        .unwrap();
    }
    if let Some(id) = path.strip_prefix("/repos/cadencr/registry/releases/assets/") {
        let id = id.parse::<u64>().unwrap();
        return assets
            .iter()
            .find(|(asset, _)| asset.id == id)
            .unwrap()
            .1
            .clone();
    }
    panic!("unexpected fixture path: {path}");
}
