use std::collections::VecDeque;
use std::sync::{Arc, Mutex};
use tokio::sync::broadcast;

const SCROLLBACK_CAP: usize = 50 * 1024; // 50KB

/// Ring buffer that keeps the last ~50KB of terminal output.
pub struct ScrollbackBuffer {
    buf: VecDeque<u8>,
}

impl ScrollbackBuffer {
    pub(super) fn new() -> Self {
        Self {
            buf: VecDeque::with_capacity(SCROLLBACK_CAP),
        }
    }

    pub fn append(&mut self, data: &[u8]) {
        let data = &data[data.len().saturating_sub(SCROLLBACK_CAP)..];
        let overflow = (self.buf.len() + data.len()).saturating_sub(SCROLLBACK_CAP);
        if overflow > 0 {
            self.buf.drain(..overflow);
        }
        self.buf.extend(data);
        while self.buf.front().is_some_and(|byte| byte & 0xc0 == 0x80) {
            self.buf.pop_front();
        }
    }

    pub fn contents(&self) -> String {
        let (a, b) = self.buf.as_slices();
        let mut v = Vec::with_capacity(a.len() + b.len());
        v.extend_from_slice(a);
        v.extend_from_slice(b);
        String::from_utf8_lossy(&v).into_owned()
    }
}

pub(super) fn publish_output(
    scrollback: &Arc<Mutex<ScrollbackBuffer>>,
    sender: &broadcast::Sender<String>,
    data: String,
) {
    if data.is_empty() {
        return;
    }
    let mut scrollback = scrollback.lock().unwrap_or_else(|e| e.into_inner());
    scrollback.append(data.as_bytes());
    // No receivers is normal while a client is detached.
    let _ = sender.send(data);
}

/// Decode PTY reads without replacing code points split across read boundaries.
#[derive(Default)]
pub(super) struct Utf8Output {
    pending: Vec<u8>,
}

impl Utf8Output {
    pub(super) fn push(&mut self, bytes: &[u8]) -> String {
        self.pending.extend_from_slice(bytes);
        let mut output = String::new();
        let mut consumed = 0;
        while consumed < self.pending.len() {
            match std::str::from_utf8(&self.pending[consumed..]) {
                Ok(valid) => {
                    output.push_str(valid);
                    consumed = self.pending.len();
                }
                Err(error) => {
                    let end = consumed + error.valid_up_to();
                    output.push_str(
                        std::str::from_utf8(&self.pending[consumed..end])
                            .expect("UTF-8 validator identified the valid prefix"),
                    );
                    consumed = end;
                    let Some(invalid) = error.error_len() else {
                        break;
                    };
                    output.push('\u{fffd}');
                    consumed += invalid;
                }
            }
        }
        self.pending.drain(..consumed);
        output
    }

    pub(super) fn finish(self) -> String {
        String::from_utf8_lossy(&self.pending).into_owned()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn scrollback_bounds_large_writes_without_splitting_utf8() {
        let mut scrollback = ScrollbackBuffer::new();
        scrollback.append("🦀".repeat(SCROLLBACK_CAP).as_bytes());
        let text = scrollback.contents();
        assert!(text.len() <= SCROLLBACK_CAP);
        assert!(!text.contains('�'));
        scrollback.append(b"x");
        assert!(!scrollback.contents().contains('�'));
    }

    #[test]
    fn every_utf8_split_preserves_the_stream() {
        let text = "aé日本🦀\x1b[2J";
        for split in 0..=text.len() {
            let mut decoder = Utf8Output::default();
            let first = decoder.push(&text.as_bytes()[..split]);
            let second = decoder.push(&text.as_bytes()[split..]);
            assert_eq!(first + &second + &decoder.finish(), text);
        }
    }

    #[test]
    fn invalid_bytes_and_incomplete_eof_are_lossy_but_bounded() {
        let mut decoder = Utf8Output::default();
        assert_eq!(decoder.push(&[b'a', 0xff, 0xe2]), "a�");
        assert_eq!(decoder.pending.len(), 1);
        assert_eq!(decoder.finish(), "�");
    }
}
