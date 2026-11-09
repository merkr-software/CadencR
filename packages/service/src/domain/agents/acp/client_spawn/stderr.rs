//! The agent's stderr: read line by line, bounded, and logged only when the
//! provider's policy allows its contents to be exposed.

use tokio::io::{AsyncBufRead, AsyncBufReadExt, AsyncRead, BufReader};
use tokio::task::JoinHandle;

use crate::domain::agents::acp::error::AcpError;

pub(super) fn spawn_stderr_reader<R>(
    stderr: R,
    max_line_bytes: usize,
    log_contents: bool,
) -> JoinHandle<()>
where
    R: AsyncRead + Send + Unpin + 'static,
{
    tokio::spawn(async move {
        let mut reader = BufReader::new(stderr);
        loop {
            match read_bounded_line(&mut reader, max_line_bytes).await {
                Ok(Some(line)) => {
                    if log_contents {
                        tracing::warn!(target: "acp", "{line}");
                    }
                }
                Ok(None) => break,
                Err(error) => {
                    tracing::warn!(%error, "ACP stderr read failed");
                    break;
                }
            }
        }
    })
}

async fn read_bounded_line<R>(
    reader: &mut R,
    max_line_bytes: usize,
) -> Result<Option<String>, AcpError>
where
    R: AsyncBufRead + Unpin,
{
    let mut line = Vec::new();
    loop {
        let available = reader.fill_buf().await?;
        if available.is_empty() {
            if line.is_empty() {
                return Ok(None);
            }
            break;
        }

        let newline = available.iter().position(|byte| *byte == b'\n');
        let take = newline.map_or(available.len(), |index| index + 1);
        if line.len().saturating_add(take) > max_line_bytes {
            reader.consume(take);
            return Err(AcpError::Protocol(format!(
                "ACP line exceeded {max_line_bytes} bytes"
            )));
        }
        line.extend_from_slice(&available[..take]);
        reader.consume(take);
        if newline.is_some() {
            break;
        }
    }
    while matches!(line.last(), Some(b'\n' | b'\r')) {
        line.pop();
    }
    Ok(Some(String::from_utf8_lossy(&line).to_string()))
}
