//! Markdown command files (`.claude/commands`, `.cursor/commands`), read the
//! way Cursor Agent 2026.10.22's loader reads them: top-level `*.md` files
//! only (a symlinked file counts, a directory does not), empty or unreadable
//! files and files over 1 MiB skipped, id = file name without `.md`, title =
//! the first line's Markdown heading text or the trimmed first line, else the
//! id. Frontmatter is not parsed (a file starting with `---` is titled `---`).

use std::path::Path;

/// Cursor skips larger command and skill files.
pub const MAX_FILE_BYTES: u64 = 1024 * 1024;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CommandFile {
    pub id: String,
    pub title: String,
}

/// The command files of one directory, in name order (Cursor uses the
/// unsorted directory order, which is name order on APFS).
pub fn command_files(directory: &Path) -> Vec<CommandFile> {
    let Ok(entries) = std::fs::read_dir(directory) else {
        return Vec::new();
    };
    let mut names: Vec<String> = entries
        .filter_map(Result::ok)
        .filter(|entry| !entry.path().is_dir())
        .filter_map(|entry| entry.file_name().into_string().ok())
        .filter(|name| name.ends_with(".md"))
        .collect();
    names.sort();
    names
        .into_iter()
        .filter_map(|name| {
            let content = read_text(&directory.join(&name))?;
            let id = name.strip_suffix(".md").unwrap_or(&name).to_string();
            if js_trim(&id).is_empty() {
                return None;
            }
            let title = content
                .split('\n')
                .next()
                .and_then(extract_title)
                .unwrap_or_else(|| id.clone());
            Some(CommandFile { id, title })
        })
        .collect()
}

/// Non-empty text of a file Cursor would read (lossy UTF-8, like Node).
pub fn read_text(path: &Path) -> Option<String> {
    let metadata = std::fs::metadata(path).ok()?;
    if metadata.len() > MAX_FILE_BYTES {
        return None;
    }
    let bytes = std::fs::read(path).ok()?;
    let text = String::from_utf8_lossy(&bytes).into_owned();
    (!text.is_empty()).then_some(text)
}

/// `/^#+\s*(.+)$/` (JS: `.` and `$` stop at line terminators), else the
/// trimmed line; `None` when that is empty.
fn extract_title(line: &str) -> Option<String> {
    let rest = line.trim_start_matches('#');
    if rest.len() < line.len() {
        // `.+` must run to the end without a terminator; `\s*` may only
        // swallow whitespace (terminators included) before it.
        let tail_start = rest
            .char_indices()
            .rfind(|&(_, ch)| is_js_line_terminator(ch))
            .map_or(0, |(index, ch)| index + ch.len_utf8());
        let (head, tail) = rest.split_at(tail_start);
        if !tail.is_empty() && head.chars().all(is_js_space) {
            let title = js_trim(tail);
            return (!title.is_empty()).then(|| title.to_string());
        }
    }
    let trimmed = js_trim(line);
    (!trimmed.is_empty()).then(|| trimmed.to_string())
}

fn is_js_line_terminator(ch: char) -> bool {
    matches!(ch, '\n' | '\r' | '\u{2028}' | '\u{2029}')
}

/// JavaScript's `\s` / `String.prototype.trim` set.
pub fn is_js_space(ch: char) -> bool {
    ch == '\u{feff}' || (ch.is_whitespace() && ch != '\u{85}')
}

pub fn js_trim(text: &str) -> &str {
    text.trim_matches(is_js_space)
}

#[cfg(test)]
mod tests {
    use super::{command_files, extract_title, CommandFile};

    #[test]
    fn titles_follow_cursors_first_line_rule() {
        assert_eq!(
            extract_title("# Heading line").as_deref(),
            Some("Heading line")
        );
        assert_eq!(extract_title("### Deep").as_deref(), Some("Deep"));
        assert_eq!(
            extract_title("Do the foo thing.").as_deref(),
            Some("Do the foo thing.")
        );
        assert_eq!(extract_title("---").as_deref(), Some("---"));
        assert_eq!(extract_title("crlf line\r").as_deref(), Some("crlf line"));
        // A CRLF heading misses the regex (`.` stops at `\r`): trimmed line.
        assert_eq!(extract_title("# Title\r").as_deref(), Some("# Title"));
        assert_eq!(extract_title("\u{feff}plain").as_deref(), Some("plain"));
        assert_eq!(extract_title("   "), None);
        assert_eq!(extract_title("#  "), None);
    }

    #[test]
    fn reads_top_level_markdown_files_in_name_order() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        std::fs::create_dir(root.join("sub")).unwrap();
        std::fs::write(root.join("sub/nested.md"), "Nested").unwrap();
        std::fs::write(root.join("foo.md"), "Do the foo thing.\nmore").unwrap();
        std::fs::write(root.join("Has Space.md"), "Spaced").unwrap();
        std::fs::write(root.join("empty.md"), "").unwrap();
        std::fs::write(root.join("blank.md"), "   \n\nsecond").unwrap();
        std::fs::write(root.join("notes.txt"), "not md").unwrap();
        let listed = command_files(root);
        let expected = [
            ("Has Space", "Spaced"),
            ("blank", "blank"),
            ("foo", "Do the foo thing."),
        ];
        assert_eq!(
            listed,
            expected
                .iter()
                .map(|(id, title)| CommandFile {
                    id: id.to_string(),
                    title: title.to_string()
                })
                .collect::<Vec<_>>()
        );
        assert!(command_files(&root.join("missing")).is_empty());
    }
}
