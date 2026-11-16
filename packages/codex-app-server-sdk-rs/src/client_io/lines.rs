use tokio::io::{AsyncBufRead, AsyncBufReadExt};

use crate::error::SdkError;

pub(super) async fn read_bounded_line<R>(
    reader: &mut R,
    max_line_bytes: usize,
) -> Result<Option<String>, SdkError>
where
    R: AsyncBufRead + Unpin,
{
    let mut bytes = Vec::new();
    loop {
        let available = reader.fill_buf().await?;
        if available.is_empty() {
            if bytes.is_empty() {
                return Ok(None);
            }
            break;
        }

        let newline = available.iter().position(|byte| *byte == b'\n');
        let take = newline.unwrap_or(available.len());
        let found_newline = newline.is_some();
        let consume = newline.map_or(take, |position| position + 1);

        if bytes.len().saturating_add(take) > max_line_bytes {
            reader.consume(consume);
            return Err(SdkError::Protocol(format!(
                "app-server line exceeded {max_line_bytes} bytes"
            )));
        }
        bytes.extend_from_slice(&available[..take]);
        reader.consume(consume);
        if found_newline {
            break;
        }
    }
    if bytes.last() == Some(&b'\r') {
        bytes.pop();
    }
    String::from_utf8(bytes)
        .map(Some)
        .map_err(|error| SdkError::Protocol(format!("invalid UTF-8 from app-server: {error}")))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::client::DEFAULT_MAX_LINE_BYTES;
    use tokio::io::BufReader;

    #[tokio::test]
    async fn bounded_line_reads_line_without_newline() {
        let mut reader = BufReader::new(&b"hello"[..]);
        assert_eq!(
            read_bounded_line(&mut reader, 1024).await.unwrap(),
            Some("hello".to_string())
        );
        assert_eq!(read_bounded_line(&mut reader, 1024).await.unwrap(), None);
    }

    #[tokio::test]
    async fn bounded_line_rejects_oversized_messages() {
        let mut reader = BufReader::new(&b"abcdef\n"[..]);
        let error = read_bounded_line(&mut reader, 3)
            .await
            .expect_err("line should exceed limit");
        assert!(error.to_string().contains("exceeded"));
    }

    #[tokio::test]
    async fn default_limit_accepts_base64_screenshot_sized_messages() {
        let frame = vec![b'a'; 10 * 1024 * 1024];
        let mut reader = BufReader::new(frame.as_slice());

        let decoded = read_bounded_line(&mut reader, DEFAULT_MAX_LINE_BYTES)
            .await
            .expect("image-sized JSONL frame should fit within the default limit")
            .expect("reader should return the frame");

        assert_eq!(decoded.len(), frame.len());
    }
}
