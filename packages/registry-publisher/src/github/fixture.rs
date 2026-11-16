use super::*;
use std::io::{Read, Write};
use std::net::TcpListener;
pub(crate) fn serve_json(status: &str, body: &str) -> (String, std::thread::JoinHandle<String>) {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let address = listener.local_addr().unwrap();
    let response = format!(
        "HTTP/1.1 {status}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
        body.len()
    );
    let handle = std::thread::spawn(move || {
        let (mut stream, _) = listener.accept().unwrap();
        let bytes = read_request(&mut stream);
        stream.write_all(response.as_bytes()).unwrap();
        String::from_utf8_lossy(&bytes).into_owned()
    });
    (format!("http://{address}"), handle)
}
pub(crate) fn serve_many(bodies: Vec<String>) -> String {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let address = listener.local_addr().unwrap();
    std::thread::spawn(move || {
        for body in bodies {
            let (mut stream, _) = listener.accept().unwrap();
            let request = read_request(&mut stream);
            assert!(
                request.starts_with(b"GET "),
                "scripted read fixture rejects writes"
            );
            write!(
                stream,
                "HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
                body.len()
            )
            .unwrap();
        }
    });
    format!("http://{address}")
}
pub(super) fn client(api: String) -> GitHubClient {
    GitHubClient::fixture("acme/releases", "secret-token", api.clone(), api).unwrap()
}

pub(super) fn read_request(stream: &mut std::net::TcpStream) -> Vec<u8> {
    // Accepted sockets may inherit a nonblocking listener's mode on macOS.
    stream.set_nonblocking(false).unwrap();
    stream
        .set_read_timeout(Some(std::time::Duration::from_secs(2)))
        .unwrap();
    read_request_bytes(stream)
}

fn read_request_bytes(reader: &mut impl Read) -> Vec<u8> {
    let mut bytes = Vec::new();
    loop {
        let mut chunk = [0; 4096];
        let count = reader.read(&mut chunk).unwrap();
        assert!(count > 0, "fixture request ended early");
        bytes.extend_from_slice(&chunk[..count]);
        assert!(bytes.len() <= 64 * 1024, "fixture request exceeds bound");
        if let Some(end) = bytes.windows(4).position(|window| window == b"\r\n\r\n") {
            let head = String::from_utf8_lossy(&bytes[..end]).to_ascii_lowercase();
            let length = head
                .lines()
                .find_map(|line| line.strip_prefix("content-length:"))
                .map(|value| value.trim().parse::<usize>().unwrap())
                .unwrap_or(0);
            let expected = (end + 4)
                .checked_add(length)
                .expect("fixture request length overflow");
            assert!(expected <= 64 * 1024, "fixture request exceeds bound");
            if bytes.len() >= expected {
                assert_eq!(bytes.len(), expected, "fixture request has trailing bytes");
                return bytes;
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Cursor;

    #[test]
    fn request_reader_handles_nonblocking_socket_before_fragmented_bytes_arrive() {
        use std::net::TcpStream;
        use std::time::Duration;

        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let address = listener.local_addr().unwrap();
        let (ready, wait_ready) = std::sync::mpsc::channel();
        let server = std::thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            // Exercise inherited mode deterministically on every platform.
            stream.set_nonblocking(true).unwrap();
            ready.send(()).unwrap();
            read_request(&mut stream)
        });
        let mut client = TcpStream::connect(address).unwrap();
        client
            .set_write_timeout(Some(Duration::from_secs(2)))
            .unwrap();
        wait_ready.recv_timeout(Duration::from_secs(2)).unwrap();
        std::thread::sleep(Duration::from_millis(20));
        let head = b"POST /assets HTTP/1.1\r\nContent-Length: 3\r\n\r\n";
        client.write_all(head).unwrap();
        for byte in b"abc" {
            std::thread::sleep(Duration::from_millis(10));
            client.write_all(&[*byte]).unwrap();
        }
        assert_eq!(server.join().unwrap(), [head.as_slice(), b"abc"].concat());
    }

    #[test]
    fn request_reader_collects_a_body_fragmented_across_reads() {
        let head = b"POST /assets HTTP/1.1\r\nContent-Length: 3\r\n\r\n";
        let mut reader = Cursor::new(head)
            .chain(Cursor::new(b"a"))
            .chain(Cursor::new(b"b"))
            .chain(Cursor::new(b"c"));
        assert_eq!(
            read_request_bytes(&mut reader),
            [head.as_slice(), b"abc"].concat()
        );
    }

    #[test]
    #[should_panic(expected = "fixture request ended early")]
    fn request_reader_rejects_a_truncated_body() {
        read_request_bytes(&mut Cursor::new(
            b"POST /assets HTTP/1.1\r\nContent-Length: 3\r\n\r\nab",
        ));
    }

    #[test]
    #[should_panic(expected = "fixture request exceeds bound")]
    fn request_reader_rejects_an_oversized_declared_body() {
        read_request_bytes(&mut Cursor::new(
            b"POST /assets HTTP/1.1\r\nContent-Length: 65536\r\n\r\n",
        ));
    }
}
