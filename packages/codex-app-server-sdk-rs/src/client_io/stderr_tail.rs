//! The end of an app-server's stderr, kept so a caller can say why the
//! process died. Lines are kept raw: they can quote credentials from the
//! app-server's config or environment, so nothing here logs them.

use std::collections::VecDeque;

/// Lines kept; older ones are dropped.
const MAX_LINES: usize = 20;
/// Characters kept per line; a longer line keeps its end.
const MAX_LINE_CHARS: usize = 1024;

#[derive(Debug, Default)]
pub(crate) struct StderrTail {
    lines: VecDeque<String>,
}

impl StderrTail {
    pub(crate) fn push(&mut self, line: &str) {
        if self.lines.len() == MAX_LINES {
            self.lines.pop_front();
        }
        self.lines.push_back(line_end(line));
    }

    pub(crate) fn lines(&self) -> Vec<String> {
        self.lines.iter().cloned().collect()
    }
}

fn line_end(line: &str) -> String {
    let count = line.chars().count();
    if count <= MAX_LINE_CHARS {
        return line.to_string();
    }
    line.chars().skip(count - MAX_LINE_CHARS).collect()
}

#[cfg(test)]
mod tests {
    use super::{StderrTail, MAX_LINES, MAX_LINE_CHARS};

    #[test]
    fn keeps_the_last_lines_and_the_end_of_long_ones() {
        let mut tail = StderrTail::default();
        for index in 0..MAX_LINES + 5 {
            tail.push(&format!("line {index}"));
        }
        let long = format!("{}end", "x".repeat(MAX_LINE_CHARS * 2));
        tail.push(&long);

        let lines = tail.lines();
        assert_eq!(lines.len(), MAX_LINES);
        assert_eq!(lines[0], "line 6");
        let last = lines.last().unwrap();
        assert_eq!(last.chars().count(), MAX_LINE_CHARS);
        assert!(last.ends_with("end"));
    }

    #[test]
    fn multibyte_lines_are_cut_on_character_boundaries() {
        let mut tail = StderrTail::default();
        tail.push(&"é".repeat(MAX_LINE_CHARS + 3));
        assert_eq!(tail.lines()[0].chars().count(), MAX_LINE_CHARS);
    }
}
