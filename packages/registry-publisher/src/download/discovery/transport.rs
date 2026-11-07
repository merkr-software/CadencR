use super::DiscoveryObservation;
use crate::download::stream_to_file_with;
use crate::{DownloadRequest, Downloaded, PublisherError};
use reqwest::blocking::Client;
use reqwest::header::{ACCEPT_ENCODING, CACHE_CONTROL, PRAGMA};
#[cfg(test)]
use reqwest::redirect::Policy;
use std::time::Duration;
use url::Url;

#[bon::builder]
pub(super) fn download_with(
    client: &Client,
    url: Url,
    request: &DownloadRequest<'_>,
    expected: &str,
    previous: Option<&str>,
    remaining: Duration,
) -> Result<DiscoveryObservation, PublisherError> {
    let response = client
        .get(url)
        .header(ACCEPT_ENCODING, "identity")
        .header(CACHE_CONTROL, "no-cache")
        .header(PRAGMA, "no-cache")
        .timeout(remaining)
        .send()
        .map_err(|_| PublisherError::new("public discovery: request failed"))?;
    if response.status().is_redirection() {
        return Err(PublisherError::new(
            "public discovery: redirect is not permitted",
        ));
    }
    stream_to_file_with(response, request, |value, declared| {
        classify(value, declared, expected, previous)
    })
    .map_err(|error| PublisherError::new(format!("public discovery: {error}")))
}

pub(crate) fn classify(
    value: Downloaded,
    declared: Option<u64>,
    expected: &str,
    previous: Option<&str>,
) -> Result<DiscoveryObservation, PublisherError> {
    if declared.is_some_and(|size| size != value.size) {
        return Err(PublisherError::new("incomplete response"));
    }
    if value.sha256 == expected {
        Ok(DiscoveryObservation::Candidate(value))
    } else if previous == Some(value.sha256.as_str()) {
        Ok(DiscoveryObservation::Previous)
    } else {
        Err(PublisherError::new("unrecognized content digest"))
    }
}

#[cfg(test)]
mod tests {
    use std::io::{Read, Write};
    use std::net::TcpListener;

    use sha2::{Digest as _, Sha256};
    use tempfile::tempdir;

    use super::*;

    fn serve(response: Vec<u8>) -> (Url, std::thread::JoinHandle<String>) {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        listener.set_nonblocking(true).unwrap();
        let address = listener.local_addr().unwrap();
        let handle = std::thread::spawn(move || {
            let deadline = std::time::Instant::now() + std::time::Duration::from_secs(3);
            let mut stream = loop {
                match listener.accept() {
                    Ok((stream, _)) => break stream,
                    Err(error)
                        if error.kind() == std::io::ErrorKind::WouldBlock
                            && std::time::Instant::now() < deadline =>
                    {
                        std::thread::sleep(std::time::Duration::from_millis(5));
                    }
                    Err(error) => panic!("fixture accept failed: {error}"),
                }
            };
            stream.set_nonblocking(false).unwrap();
            stream
                .set_read_timeout(Some(std::time::Duration::from_secs(2)))
                .unwrap();
            stream
                .set_write_timeout(Some(std::time::Duration::from_secs(2)))
                .unwrap();
            let mut request = [0_u8; 4096];
            let count = stream.read(&mut request).unwrap();
            stream.write_all(&response).unwrap();
            String::from_utf8_lossy(&request[..count]).into_owned()
        });
        (
            Url::parse(&format!("http://{address}/discovery")).unwrap(),
            handle,
        )
    }

    fn request<'a>(output: std::path::PathBuf, sha256: &'a str) -> DownloadRequest<'a> {
        DownloadRequest {
            url: "unused after validation",
            sha256,
            output,
            max_bytes: 3,
        }
    }

    #[test]
    fn transport_refuses_redirect_status_oversize_and_removes_hash_mismatch() {
        let client = Client::builder().redirect(Policy::none()).build().unwrap();
        let directory = tempdir().unwrap();
        let expected = crate::hex(&Sha256::digest(b"abc"));
        for (name, response) in [
            (
                "redirect",
                b"HTTP/1.1 302 Found\r\nLocation: /other\r\nContent-Length: 0\r\n\r\n".to_vec(),
            ),
            (
                "status",
                b"HTTP/1.1 404 Nope\r\nContent-Length: 0\r\n\r\n".to_vec(),
            ),
            (
                "oversize",
                b"HTTP/1.1 200 OK\r\nContent-Length: 4\r\n\r\nabcd".to_vec(),
            ),
            (
                "encoding",
                b"HTTP/1.1 200 OK\r\nContent-Encoding: gzip\r\nContent-Length: 3\r\n\r\nabc"
                    .to_vec(),
            ),
            (
                "truncation",
                b"HTTP/1.1 200 OK\r\nContent-Length: 3\r\n\r\nab".to_vec(),
            ),
            (
                "mismatch",
                b"HTTP/1.1 200 OK\r\nContent-Length: 3\r\n\r\nabd".to_vec(),
            ),
        ] {
            let (url, observed) = serve(response);
            let output = directory.path().join(name);
            assert!(download_with()
                .client(&client)
                .url(url)
                .request(&request(output.clone(), &expected))
                .expected(&expected)
                .maybe_previous(None)
                .remaining(Duration::from_secs(2))
                .call()
                .is_err());
            assert!(!output.exists());
            assert!(observed
                .join()
                .unwrap()
                .contains("accept-encoding: identity"));
        }
    }

    #[test]
    fn transport_streams_exact_body_and_hash() {
        let client = Client::builder().redirect(Policy::none()).build().unwrap();
        let expected = crate::hex(&Sha256::digest(b"abc"));
        let (url, observed) = serve(b"HTTP/1.1 200 OK\r\nContent-Length: 3\r\n\r\nabc".to_vec());
        let directory = tempdir().unwrap();
        let output = directory.path().join("managed-index.json");
        let result = download_with()
            .client(&client)
            .url(url)
            .request(&request(output.clone(), &expected))
            .expected(&expected)
            .maybe_previous(None)
            .remaining(Duration::from_secs(2))
            .call()
            .unwrap();
        assert_eq!(
            result,
            DiscoveryObservation::Candidate(Downloaded {
                sha256: expected,
                size: 3
            })
        );
        assert_eq!(std::fs::read(output).unwrap(), b"abc");
        assert!(observed
            .join()
            .unwrap()
            .starts_with("GET /discovery HTTP/1.1"));
    }
    #[test]
    fn transport_only_classifies_complete_known_previous_bodies() {
        let client = Client::builder().redirect(Policy::none()).build().unwrap();
        let directory = tempdir().unwrap();
        let expected = crate::hex(&Sha256::digest(b"candidate"));
        for previous in [b"old".as_slice(), b"longer previous catalog".as_slice()] {
            let digest = crate::hex(&Sha256::digest(previous));
            let response = format!(
                "HTTP/1.1 200 OK\r\nContent-Length: {}\r\n\r\n",
                previous.len()
            )
            .into_bytes();
            let (url, observed) = serve([response, previous.to_vec()].concat());
            let request = DownloadRequest {
                url: "validated",
                sha256: &expected,
                output: directory.path().join("previous"),
                max_bytes: cadencr_registry_core::MAX_DISCOVERY_BYTES as u64,
            };
            assert_eq!(
                download_with()
                    .client(&client)
                    .url(url)
                    .request(&request)
                    .expected(&expected)
                    .maybe_previous(Some(&digest))
                    .remaining(Duration::from_secs(2))
                    .call()
                    .unwrap(),
                DiscoveryObservation::Previous
            );
            std::fs::remove_file(&request.output).unwrap();
            let headers = observed.join().unwrap();
            assert!(headers.contains("cache-control: no-cache"));
            assert!(headers.contains("pragma: no-cache"));
            let (url, observed) = serve(
                [
                    format!(
                        "HTTP/1.1 200 OK\r\nContent-Length: {}\r\n\r\n",
                        previous.len()
                    )
                    .into_bytes(),
                    previous.to_vec(),
                ]
                .concat(),
            );
            assert!(download_with()
                .client(&client)
                .url(url)
                .request(&request)
                .expected(&expected)
                .maybe_previous(None)
                .remaining(Duration::from_secs(2))
                .call()
                .is_err());
            assert!(!request.output.exists());
            observed.join().unwrap();
        }
    }
    #[test]
    fn shared_remaining_timeout_aborts_raw_body_and_removes_output() {
        let client = Client::builder().redirect(Policy::none()).build().unwrap();
        let expected = crate::hex(&Sha256::digest(b"abc"));
        let (warm, warm_request) =
            serve(b"HTTP/1.1 200 OK\r\nContent-Length: 3\r\n\r\nabc".to_vec());
        let directory = tempdir().unwrap();
        let warm_output = directory.path().join("warm");
        download_with()
            .client(&client)
            .url(warm)
            .request(&request(warm_output, &expected))
            .expected(&expected)
            .maybe_previous(None)
            .remaining(Duration::from_secs(2))
            .call()
            .unwrap();
        warm_request.join().unwrap();
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        listener.set_nonblocking(true).unwrap();
        let url = Url::parse(&format!(
            "http://{}/discovery",
            listener.local_addr().unwrap()
        ))
        .unwrap();
        let server = std::thread::spawn(move || {
            let accept_deadline = std::time::Instant::now() + Duration::from_secs(2);
            let mut stream = loop {
                match listener.accept() {
                    Ok((stream, _)) => break stream,
                    Err(error)
                        if error.kind() == std::io::ErrorKind::WouldBlock
                            && std::time::Instant::now() < accept_deadline =>
                    {
                        std::thread::sleep(Duration::from_millis(5))
                    }
                    Err(error) => panic!("fixture accept failed: {error}"),
                }
            };
            stream.set_nonblocking(false).unwrap();
            stream
                .set_read_timeout(Some(Duration::from_secs(2)))
                .unwrap();
            stream
                .set_write_timeout(Some(Duration::from_secs(2)))
                .unwrap();
            let mut bytes = [0; 4096];
            assert!(stream.read(&mut bytes).unwrap() > 0);
            stream
                .write_all(b"HTTP/1.1 200 OK\r\nContent-Length: 3\r\n\r\na")
                .unwrap();
            std::thread::sleep(Duration::from_millis(700));
        });
        let output = directory.path().join("deadline");
        let started = std::time::Instant::now();
        let error = download_with()
            .client(&client)
            .url(url)
            .request(&request(output.clone(), &expected))
            .expected(&expected)
            .maybe_previous(None)
            .remaining(Duration::from_millis(200))
            .call()
            .unwrap_err();
        assert!(started.elapsed() < Duration::from_millis(600));
        assert!(
            error
                .to_string()
                .contains("public discovery: archive download: response stream failed"),
            "unexpected discovery error: {error}"
        );
        assert!(!output.exists());
        server.join().unwrap();
    }
}
