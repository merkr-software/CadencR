//! Stream readers for callers that drive a child's pipes themselves (the
//! background git runner), sharing [`super::read_bounded`]'s limits.

use tokio::io::{AsyncRead, AsyncReadExt};

use super::{read_bounded, BoundedCommandError, OutputStream, Overflow};

/// Read an async stream to its end, keeping only its last 1 MiB: for a
/// stream read for diagnostics, like a command's stderr.
pub(crate) async fn read_stream_tail(
    reader: impl AsyncRead + Unpin,
) -> Result<Vec<u8>, BoundedCommandError> {
    read_bounded(reader, OutputStream::Stderr, Overflow::KeepTail, 0).await
}

/// Hand at most `max_bytes` of `reader` to `on_chunk` as it arrives, without
/// holding it. Returns whether the end of the stream was reached: `false`
/// when `on_chunk` broke or `max_bytes` were read first.
pub(crate) async fn feed_capped(
    mut reader: impl AsyncRead + Unpin,
    max_bytes: usize,
    mut on_chunk: impl FnMut(&[u8]) -> std::ops::ControlFlow<()>,
) -> std::io::Result<bool> {
    let mut buffer = vec![0_u8; 64 * 1024];
    let mut read = 0_usize;
    while read < max_bytes {
        let want = buffer.len().min(max_bytes - read);
        let count = reader.read(&mut buffer[..want]).await?;
        if count == 0 {
            return Ok(true);
        }
        read += count;
        if on_chunk(&buffer[..count]).is_break() {
            return Ok(false);
        }
    }
    Ok(false)
}

/// Read an async stream up to `limit` bytes, returning
/// [`BoundedCommandError::is_output_exceeded`] as soon as the limit is passed.
pub(crate) async fn read_stream_capped(
    reader: impl AsyncRead + Unpin,
    limit: usize,
    initial_capacity: usize,
) -> Result<Vec<u8>, BoundedCommandError> {
    read_bounded(
        reader,
        OutputStream::Stdout,
        Overflow::Fail(limit),
        initial_capacity.min(limit),
    )
    .await
}
