//! Newline-delimited reads with a length cap, so a backend that never writes
//! `\n` cannot make the service buffer without bound.

use std::io;

use tokio::io::{AsyncBufRead, AsyncBufReadExt};

#[derive(Debug, PartialEq, Eq)]
pub(super) enum Line {
    Text(Vec<u8>),
    /// Longer than the cap; its bytes were discarded up to the next `\n`.
    TooLong,
}

/// The next line without its `\n` (and without a trailing `\r`, like the
/// SDK's framing: protocol §3); `None` at end of stream.
pub(super) async fn next_line<R: AsyncBufRead + Unpin>(
    reader: &mut R,
    max: usize,
) -> io::Result<Option<Line>> {
    let mut line = Vec::new();
    let mut too_long = false;
    loop {
        let available = reader.fill_buf().await?;
        if available.is_empty() {
            return Ok(match (too_long, line.is_empty()) {
                (true, _) => Some(Line::TooLong),
                (false, true) => None,
                (false, false) => Some(Line::Text(trim_cr(line))),
            });
        }
        let newline = available.iter().position(|byte| *byte == b'\n');
        let chunk = &available[..newline.unwrap_or(available.len())];
        if !too_long {
            if line.len() + chunk.len() > max {
                too_long = true;
                line = Vec::new();
            } else {
                line.extend_from_slice(chunk);
            }
        }
        let consumed = newline.map_or(available.len(), |index| index + 1);
        reader.consume(consumed);
        if newline.is_some() {
            return Ok(Some(if too_long {
                Line::TooLong
            } else {
                Line::Text(trim_cr(line))
            }));
        }
    }
}

fn trim_cr(mut line: Vec<u8>) -> Vec<u8> {
    if line.last() == Some(&b'\r') {
        line.pop();
    }
    line
}

#[cfg(test)]
mod tests {
    use super::*;
    use tokio::io::BufReader;

    #[tokio::test]
    async fn splits_lines_and_drops_overlong_ones() {
        let input: &[u8] = b"one\r\ntoo-long-line\nthree\nlast\r";
        let mut reader = BufReader::with_capacity(4, input);
        let mut lines = Vec::new();
        while let Some(line) = next_line(&mut reader, 8).await.unwrap() {
            lines.push(line);
        }
        assert_eq!(
            lines,
            [
                Line::Text(b"one".to_vec()),
                Line::TooLong,
                Line::Text(b"three".to_vec()),
                Line::Text(b"last".to_vec()),
            ]
        );
    }
}
