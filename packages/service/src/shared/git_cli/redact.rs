//! Absolute paths out of Git's messages. A worktree, repository or home path
//! must not reach a response body, remote devices included, while the
//! diagnostic Git writes around it must.

/// Quotes Git and shells put around a path.
const QUOTES: [char; 3] = ['\'', '"', '`'];

/// Replace every absolute path in `text` with `<path>`.
///
/// A path starts with `/` at the start of a line or after a space, a quote,
/// `(`, `[`, `=`, `,` or `;`, and holds at least two segments. It runs across
/// spaces and apostrophes (`Client O'Connor/Secret Folder`) until one of:
/// - `: ` or a final `:`, Git's `<path>: <diagnostic>` layout, which keeps the
///   diagnostic;
/// - a quote followed by a space, punctuation or the end of the line: the
///   closing quote of a quoted path;
/// - the end of the line.
///
/// An unquoted path followed by plain words takes those words with it: hiding
/// a few words more is the safe failure. A URL (`https://host/…`) has no
/// boundary before its slashes and stays.
pub(super) fn redact_paths(text: &str) -> String {
    text.split_inclusive('\n').map(redact_line).collect()
}

fn redact_line(line: &str) -> String {
    let chars: Vec<char> = line.chars().collect();
    let mut out = String::with_capacity(line.len());
    let mut at = 0;
    while at < chars.len() {
        match path_end(&chars, at) {
            Some(end) => {
                out.push_str("<path>");
                at = end;
            }
            None => {
                out.push(chars[at]);
                at += 1;
            }
        }
    }
    out
}

/// Where the absolute path starting at `start` ends, when one starts there.
fn path_end(chars: &[char], start: usize) -> Option<usize> {
    if chars[start] != '/' || !starts_a_path(start.checked_sub(1).map(|at| chars[at])) {
        return None;
    }
    // `//…` is a URL authority or a separator, not a path.
    match chars.get(start + 1) {
        Some(next) if *next != '/' && !next.is_whitespace() => {}
        _ => return None,
    }
    let mut end = start + 1;
    while end < chars.len() {
        let next = chars.get(end + 1).copied();
        match chars[end] {
            '\n' | '\r' => break,
            ':' if ends_a_word(next) => break,
            quote if QUOTES.contains(&quote) && ends_a_word(next) => break,
            _ => end += 1,
        }
    }
    // One segment (`/tmp`) names no one's folder.
    chars[start + 1..end].contains(&'/').then_some(end)
}

fn starts_a_path(before: Option<char>) -> bool {
    match before {
        None => true,
        Some(c) => c.is_whitespace() || QUOTES.contains(&c) || "([=,;".contains(c),
    }
}

/// Whether the character after a `:` or a quote ends the path there.
fn ends_a_word(next: Option<char>) -> bool {
    next.is_none_or(|c| c.is_whitespace() || ":,.;)]".contains(c))
}

#[cfg(test)]
mod tests {
    use super::*;

    /// No fragment of an absolute path survives — spaces and apostrophes in
    /// folder names included — and Git's diagnostic after the path stays.
    #[test]
    fn redaction_hides_whole_paths_and_keeps_the_diagnostic() {
        let cases = [
            (
                "fatal: bad config line 1 in file /Users/someone/Customer Project/Hidden Folder/config",
                "fatal: bad config line 1 in file <path>",
            ),
            (
                "fatal: bad config line 1 in file /Users/someone/Client O'Connor/Secret Folder/config",
                "fatal: bad config line 1 in file <path>",
            ),
            (
                "fatal: /Users/someone/My Repo/.git/worktrees/wt x/index: index file smaller than expected",
                "fatal: <path>: index file smaller than expected",
            ),
            (
                "fatal: not a git repository: /tmp/Client Work/repo/.git/worktrees/feature x",
                "fatal: not a git repository: <path>",
            ),
            (
                "fatal: '/Users/someone/O'Connor Repo/wt' is not a working tree",
                "fatal: '<path>' is not a working tree",
            ),
            (
                "error: unable to read \"/srv/a b/c.txt\": Permission denied\nhint: retry",
                "error: unable to read \"<path>\": Permission denied\nhint: retry",
            ),
            (
                "fatal: unable to access 'https://github.com/acme/widgets.git/': denied",
                "fatal: unable to access 'https://github.com/acme/widgets.git/': denied",
            ),
            (
                "error: pathspec 'src/main.rs' did not match any file(s) known to git",
                "error: pathspec 'src/main.rs' did not match any file(s) known to git",
            ),
            ("fatal: cannot use /tmp as a repository", "fatal: cannot use /tmp as a repository"),
        ];
        for (input, expected) in cases {
            assert_eq!(redact_paths(input), expected, "{input}");
        }
    }
}
