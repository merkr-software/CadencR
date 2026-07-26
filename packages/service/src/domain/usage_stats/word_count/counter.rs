//! Counting words in a stream of text, independent of how it arrives.

use crate::domain::agents::adapter::RuntimeContentBlock;

/// Counts words across an arbitrary sequence of text chunks.
///
/// The agent stream arrives as token-sized deltas, so counting each chunk in
/// isolation would score nearly every token as its own word. This keeps the
/// "currently inside a word" flag across `push` calls, so a word split over
/// several deltas is counted exactly once.
#[derive(Debug, Default, Clone, Copy)]
pub(super) struct WordCounter {
    words: u64,
    in_word: bool,
}

impl WordCounter {
    /// Feed a chunk, returning how many *new* words it started. A word split
    /// across chunks is counted by the chunk that opened it.
    pub fn push(&mut self, text: &str) -> u64 {
        let before = self.words;
        for ch in text.chars() {
            if ch.is_whitespace() {
                self.in_word = false;
            } else if !self.in_word {
                self.in_word = true;
                self.words += 1;
            }
        }
        self.words - before
    }
}

/// The countable text of a content block, if it has any. Tool calls and
/// unknown blocks carry no prose.
pub(super) fn block_text(block: &RuntimeContentBlock) -> Option<&str> {
    match block {
        RuntimeContentBlock::Text { text } => Some(text),
        RuntimeContentBlock::Thinking { thinking } => Some(thinking),
        RuntimeContentBlock::ToolUse { .. } | RuntimeContentBlock::Other => None,
    }
}

/// Words in a single complete string (user prompts, which never stream).
pub fn count_words(text: &str) -> u64 {
    WordCounter::default().push(text)
}

#[cfg(test)]
mod tests {
    use super::{count_words, WordCounter};
    #[test]
    fn counts_plain_text() {
        assert_eq!(count_words("hello brave new world"), 4);
        assert_eq!(count_words("  padded \n\t words  "), 2);
        assert_eq!(count_words(""), 0);
        assert_eq!(count_words("   "), 0);
    }

    #[test]
    fn does_not_split_a_word_across_chunks() {
        let mut counter = WordCounter::default();
        // Each chunk reports only the words it opened; "hello" belongs to the
        // first, and the "ld" tail adds nothing to the word "wor" opened before.
        assert_eq!(counter.push("hel"), 1);
        assert_eq!(counter.push("lo wor"), 1);
        assert_eq!(counter.push("ld"), 0);
    }
}
