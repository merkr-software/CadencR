//! Cap decoded JSON strings on the wire before serde allocates for them.
//! Consume and validate complete string characters, including discarded ones.
use std::io::{self, BufRead, Read};

use super::evidence::StringEvidence;

const MAX_STRING_BYTES: usize = 16 * 1024;
const MAX_DEPTH: usize = 128;

pub(super) struct CappedStrings<R> {
    input: R,
    in_string: bool,
    string_bytes: usize,
    truncated: bool,
    depth: usize,
    pending: [u8; 12],
    next: usize,
    end: usize,
    evidence: StringEvidence,
}

impl<R: BufRead> CappedStrings<R> {
    pub(super) fn new(input: R) -> Self {
        Self {
            input,
            in_string: false,
            string_bytes: 0,
            truncated: false,
            depth: 0,
            pending: [0; 12],
            next: 0,
            end: 0,
            evidence: StringEvidence::default(),
        }
    }

    pub(super) fn into_parts(self) -> (R, StringEvidence) {
        (self.input, self.evidence)
    }

    fn next_piece(&mut self) -> io::Result<bool> {
        let mut byte = [0];
        loop {
            if self.input.read(&mut byte)? == 0 {
                return Ok(false);
            }
            self.pending[0] = byte[0];
            self.next = 0;
            self.end = 1;
            if byte[0] == b'"' {
                if self.in_string {
                    self.evidence.finish_string(self.truncated);
                } else {
                    self.evidence.start_string();
                }
                self.in_string = !self.in_string;
                self.string_bytes = 0;
                self.truncated = false;
            } else if self.in_string {
                let (encoded, decoded) = self.string_character(byte[0])?;
                self.evidence.character(decoded);
                if self.truncated || self.string_bytes + decoded.len_utf8() > MAX_STRING_BYTES {
                    self.truncated = true;
                    continue;
                }
                self.string_bytes += decoded.len_utf8();
                self.end = encoded;
            } else {
                // serde_json can otherwise accumulate an unbounded stack
                // while skipping a deeply nested unknown value.
                match byte[0] {
                    b'[' | b'{' if self.depth == MAX_DEPTH => {
                        return Err(io::Error::new(
                            io::ErrorKind::InvalidData,
                            "Antigravity journal exceeds the JSON depth limit",
                        ));
                    }
                    b'[' | b'{' => self.depth += 1,
                    b']' | b'}' => self.depth = self.depth.saturating_sub(1),
                    _ => {}
                }
                self.evidence.token(byte[0]);
            }
            return Ok(true);
        }
    }

    fn string_character(&mut self, first: u8) -> io::Result<(usize, char)> {
        let len = match first {
            b'\\' => return self.escape(),
            0x20..=0x7f => return Ok((1, char::from(first))),
            0xc2..=0xdf => 2,
            0xe0..=0xef => 3,
            0xf0..=0xf4 => 4,
            _ => return Err(invalid_string()),
        };
        self.input.read_exact(&mut self.pending[1..len])?;
        let ch = std::str::from_utf8(&self.pending[..len])
            .ok()
            .and_then(|text| text.chars().next())
            .ok_or_else(invalid_string)?;
        Ok((len, ch))
    }

    fn escape(&mut self) -> io::Result<(usize, char)> {
        self.input.read_exact(&mut self.pending[1..2])?;
        match self.pending[1] {
            token @ (b'"' | b'\\' | b'/') => return Ok((2, char::from(token))),
            b'b' => return Ok((2, '\u{8}')),
            b'f' => return Ok((2, '\u{c}')),
            b'n' => return Ok((2, '\n')),
            b'r' => return Ok((2, '\r')),
            b't' => return Ok((2, '\t')),
            b'u' => {}
            _ => return Err(invalid_string()),
        }
        self.input.read_exact(&mut self.pending[2..6])?;
        let first = hex(&self.pending[2..6]).ok_or_else(invalid_string)?;
        if (0xd800..=0xdbff).contains(&first) {
            self.input.read_exact(&mut self.pending[6..12])?;
            let second = hex(&self.pending[8..12]).ok_or_else(invalid_string)?;
            if self.pending[6..8] != *br"\u" || !(0xdc00..=0xdfff).contains(&second) {
                return Err(invalid_string());
            }
            let code = 0x10000 + ((u32::from(first) - 0xd800) << 10) + (u32::from(second) - 0xdc00);
            let character = char::from_u32(code).ok_or_else(invalid_string)?;
            return Ok((12, character));
        }
        let character = char::from_u32(u32::from(first)).ok_or_else(invalid_string)?;
        Ok((6, character))
    }
}

impl<R: BufRead> Read for CappedStrings<R> {
    fn read(&mut self, output: &mut [u8]) -> io::Result<usize> {
        let mut written = 0;
        while written < output.len() {
            if self.next == self.end && !self.next_piece()? {
                break;
            }
            let count = (self.end - self.next).min(output.len() - written);
            output[written..written + count]
                .copy_from_slice(&self.pending[self.next..self.next + count]);
            self.next += count;
            written += count;
        }
        Ok(written)
    }
}

fn hex(bytes: &[u8]) -> Option<u16> {
    bytes.iter().try_fold(0u16, |value, byte| {
        let digit = char::from(*byte).to_digit(16)?;
        Some((value << 4) | digit as u16)
    })
}

fn invalid_string() -> io::Error {
    io::Error::new(io::ErrorKind::InvalidData, "invalid JSON string")
}
