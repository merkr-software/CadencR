//! The prose of an agent reply with the markdown syntax taken out, so a
//! one-line preview (a sidebar row, a notification) reads "Implemented Added
//! bon…" rather than "## Implemented - Added `bon`…".

use std::sync::LazyLock;

use regex_lite::Regex;

/// `[text](url)` and `![alt](url)` keep only their text.
static LINK: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"!?\[([^\]]*)\]\([^)]*\)").expect("valid link pattern"));
/// What opens a heading, quote, list item or checkbox line.
static LINE_MARKER: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"^(?:#{1,6}\s+|>\s*|(?:[-*+]|\d+[.)])\s+(?:\[[ xX]\]\s+)?)+")
        .expect("valid line marker pattern")
});
/// A line made only of a rule or a table separator.
static RULE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"^[\s|:*_-]+$").expect("valid rule pattern"));

/// Markdown down to its prose: code blocks, rules and table separators go,
/// line markers, bold and code spans are stripped, links keep their text and
/// table cells their content. Stops once it holds `max_chars`: a preview never
/// needs the rest of a long reply.
pub(super) fn plain_text(markdown: &str, max_chars: usize) -> String {
    let mut text = String::new();
    let mut in_fence = false;
    for line in markdown.lines() {
        let line = line.trim();
        if line.starts_with("```") || line.starts_with("~~~") {
            in_fence = !in_fence;
            continue;
        }
        if in_fence || line.is_empty() || RULE.is_match(line) {
            continue;
        }
        let line = LINE_MARKER.replace(line, "");
        let line = LINK
            .replace_all(&line, "$1")
            .replace("**", "")
            .replace('`', "");
        let line = if line.starts_with('|') {
            line.replace('|', " ")
        } else {
            line
        };
        text.push_str(&line);
        text.push(' ');
        if text.chars().count() > max_chars {
            break;
        }
    }
    text
}

#[cfg(test)]
mod tests {
    use super::super::queries::{preview_snippet, PREVIEW_MAX_CHARS};
    use super::*;

    fn preview(markdown: &str) -> String {
        preview_snippet(&plain_text(markdown, PREVIEW_MAX_CHARS), PREVIEW_MAX_CHARS)
    }

    #[test]
    fn strips_headings_lists_and_inline_markup() {
        let markdown = "## Implemented\n\n- Added `bon = \"3.9\"` to **all** crates.\n1. See [the docs](https://bon-rs.com).";
        assert_eq!(
            preview(markdown),
            "Implemented Added bon = \"3.9\" to all crates. See the docs."
        );
    }

    #[test]
    fn drops_code_blocks_rules_and_table_separators() {
        let markdown = "Run this:\n```sh\npnpm test\n```\n---\n| a | b |\n|---|---|\nDone.";
        assert_eq!(preview(markdown), "Run this: a b Done.");
    }

    #[test]
    fn keeps_identifiers_and_checkbox_text() {
        assert_eq!(
            preview("- [x] renamed snake_case_name"),
            "renamed snake_case_name"
        );
        assert_eq!(preview("Returns `Vec<T>`."), "Returns Vec<T>.");
        assert_eq!(
            preview("Calls `__init__` when `a || b`."),
            "Calls __init__ when a || b."
        );
    }

    #[test]
    fn stops_reading_once_the_preview_is_full() {
        let markdown = format!("{}\nnever read", "word ".repeat(30));
        assert!(!plain_text(&markdown, PREVIEW_MAX_CHARS).contains("never read"));
    }
}
