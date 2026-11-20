//! Bounded synthesis and line-counting for untracked files. Both the diff and
//! the stat endpoints have to represent untracked files (which git itself won't
//! emit), and both must do so without reading every file fully into memory or
//! shipping a multi-MB string to the renderer. They share one binary heuristic
//! here so a file is absent from the diff iff it's absent from the stat count.

use std::path::Path;

use crate::domain::git::file_size::LARGE_FILE_BYTES;
use crate::error::AppError;

/// Number of leading bytes sniffed for git's binary heuristic.
const BINARY_SNIFF_BYTES: usize = 8192;

/// git's binary heuristic, shared by the diff-synthesis and stats-counting
/// untracked paths so the two can never disagree about which files to skip: a
/// NUL byte within the first 8 KB marks the file binary. A non-UTF-8 file with
/// no NUL is still "text" to git — it is rendered/counted lossily, not skipped.
fn head_looks_binary(head: &[u8]) -> bool {
    head[..head.len().min(BINARY_SNIFF_BYTES)].contains(&0)
}

/// Read up to `max` bytes from the start of a file without pulling the whole
/// thing into memory — used to classify a large untracked file as binary before
/// emitting its placeholder.
async fn read_head(path: &Path, max: usize) -> std::io::Result<Vec<u8>> {
    use tokio::io::AsyncReadExt;

    let mut file = tokio::fs::File::open(path).await?;
    let mut buf = vec![0u8; max];
    let mut filled = 0;
    while filled < max {
        let n = file.read(&mut buf[filled..]).await?;
        if n == 0 {
            break;
        }
        filled += n;
    }
    buf.truncate(filled);
    Ok(buf)
}

/// An untracked file deleted between the listing and the read has nothing left
/// to show (`None`); any other read failure is an error, never a file silently
/// left out of the diff or drawn as a binary.
fn unless_gone<T>(result: std::io::Result<T>, path: &Path) -> Result<Option<T>, AppError> {
    match result {
        Ok(value) => Ok(Some(value)),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(error) => Err(AppError::internal(format!(
            "cannot read untracked file {}: {error}",
            path.display()
        ))),
    }
}

/// Count the added lines of an untracked file for the stat total without
/// holding it all in memory: reads in bounded chunks, sniffs the first 8 KB for
/// a NUL byte to skip binaries ([`head_looks_binary`]), and counts newlines plus
/// a trailing unterminated line. `None` skips the file (binary, not a regular
/// file, or deleted since it was listed), matching exactly how
/// [`synthesize_untracked_new_file_diff`] treats it.
///
/// A file that cannot be read gets no count either. The count only decorates a
/// changed-file row or a stat total, and failing it would take the whole list
/// down for one file; opening that file's diff reports the read error instead
/// (see [`synthesize_untracked_new_file_diff`]).
pub(super) async fn count_untracked_lines(path: &Path) -> Option<u32> {
    // Deliberately no error here: the file's own diff reports it.
    counted_lines(path).await.unwrap_or_default()
}

async fn counted_lines(path: &Path) -> Result<Option<u32>, AppError> {
    if regular_file_metadata(path).await?.is_none() {
        return Ok(None);
    }
    Ok(unless_gone(count_lines(path).await, path)?.flatten())
}

/// Untracked entries that are not regular files once symlinks are followed —
/// a link to a directory, a dangling link — have no lines to show, like a
/// binary: `None` for them, and for a file deleted since it was listed.
async fn regular_file_metadata(path: &Path) -> Result<Option<std::fs::Metadata>, AppError> {
    Ok(unless_gone(tokio::fs::metadata(path).await, path)?.filter(|m| m.is_file()))
}

async fn count_lines(path: &Path) -> std::io::Result<Option<u32>> {
    use tokio::io::AsyncReadExt;

    let mut file = tokio::fs::File::open(path).await?;
    let mut buf = [0u8; 64 * 1024];
    let mut lines: u32 = 0;
    let mut last_byte: Option<u8> = None;
    let mut sniffed = false;
    loop {
        let n = file.read(&mut buf).await?;
        if n == 0 {
            break;
        }
        let chunk = &buf[..n];
        if !sniffed {
            if head_looks_binary(chunk) {
                return Ok(None); // binary — skip, like the diff endpoint
            }
            sniffed = true;
        }
        lines += chunk.iter().filter(|&&b| b == b'\n').count() as u32;
        last_byte = Some(chunk[n - 1]);
    }
    // A final line with no trailing newline still counts (matches `lines()`).
    if last_byte.is_some_and(|b| b != b'\n') {
        lines += 1;
    }
    Ok(Some(lines))
}

/// Build the synthetic "new file" unified diff for a single untracked file,
/// bounding the cost: a file at or above [`LARGE_FILE_BYTES`] is represented by
/// a short synthetic one-line hunk that names the file and says it's too large
/// to inline, instead of being read fully into memory and expanded to `+`-lines
/// (shipping + JSON-parsing a multi-MB string on the main thread is the exact
/// storm we're avoiding). Binary files are skipped via git's NUL heuristic
/// ([`head_looks_binary`]) — the same rule [`count_untracked_lines`] uses, so a
/// file is absent from the diff iff it's absent from the stat count. Non-UTF-8
/// *text* (no NUL) is decoded lossily and still shown, matching `git diff`.
/// Returns `None` when nothing should be emitted (binary, or deleted since it
/// was listed); an unreadable file is an error.
pub(super) async fn synthesize_untracked_new_file_diff(
    worktree_path: &Path,
    file: &str,
) -> Result<Option<String>, AppError> {
    let full_path = worktree_path.join(file);
    let Some(metadata) = regular_file_metadata(&full_path).await? else {
        return Ok(None);
    };
    if metadata.len() >= LARGE_FILE_BYTES {
        // Sniff the head so a large *binary* file is skipped (as the stats path
        // does) rather than mislabeled as text "too large to display".
        let head = read_head(&full_path, BINARY_SNIFF_BYTES).await;
        match unless_gone(head, &full_path)? {
            Some(head) if !head_looks_binary(&head) => {}
            _ => return Ok(None),
        }
        let size = format_bytes(metadata.len());
        return Ok(Some(format!(
            "diff --git a/{file} b/{file}\nnew file mode 100644\n--- /dev/null\n+++ b/{file}\n@@ -0,0 +1,1 @@\n+(untracked file too large to display inline: {size} — open it from the editor)\n"
        )));
    }

    let Some(bytes) = unless_gone(tokio::fs::read(&full_path).await, &full_path)? else {
        return Ok(None);
    };
    if head_looks_binary(&bytes) {
        return Ok(None);
    }
    let content = String::from_utf8_lossy(&bytes);
    let mut lines: Vec<&str> = content.split('\n').collect();
    if lines.last() == Some(&"") {
        lines.pop();
    }
    let line_count = lines.len();
    let added_lines: String = lines
        .iter()
        .map(|l| format!("+{l}"))
        .collect::<Vec<_>>()
        .join("\n");
    Ok(Some(format!(
        "diff --git a/{file} b/{file}\nnew file mode 100644\n--- /dev/null\n+++ b/{file}\n@@ -0,0 +1,{line_count} @@\n{added_lines}\n"
    )))
}

/// Human-readable byte count for placeholder messages. Mirrors the frontend's
/// `formatBytes` (`lib/diff-thresholds.ts`) so the two read the same.
fn format_bytes(n: u64) -> String {
    if n < 1024 {
        format!("{n} B")
    } else if n < 1024 * 1024 {
        format!("{:.1} KB", n as f64 / 1024.0)
    } else {
        format!("{:.1} MB", n as f64 / (1024.0 * 1024.0))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn synthesize_small_untracked_file_inlines_full_content() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join("hello.txt"), "line1\nline2\n").unwrap();

        let block = synthesize_untracked_new_file_diff(dir.path(), "hello.txt")
            .await
            .unwrap()
            .expect("small file is synthesized");
        assert!(block.contains("diff --git a/hello.txt b/hello.txt"));
        assert!(block.contains("@@ -0,0 +1,2 @@"));
        assert!(block.contains("+line1"));
        assert!(block.contains("+line2"));
    }

    #[tokio::test]
    async fn synthesize_large_untracked_file_is_capped_not_inlined() {
        let dir = tempfile::tempdir().unwrap();
        // A file comfortably past the large-file threshold.
        let big = "x\n".repeat(LARGE_FILE_BYTES as usize); // ~2x threshold in bytes
        std::fs::write(dir.path().join("big.log"), &big).unwrap();

        let block = synthesize_untracked_new_file_diff(dir.path(), "big.log")
            .await
            .unwrap()
            .expect("large file still appears in the diff");
        // The file is present in the list…
        assert!(block.contains("diff --git a/big.log b/big.log"));
        // …but its content is NOT inlined — the block is a bounded placeholder,
        // not a multi-MB string of `+x` lines.
        assert!(block.contains("too large to display inline"));
        assert!(
            block.len() < LARGE_FILE_BYTES as usize,
            "capped block must be far smaller than the file ({} bytes)",
            block.len()
        );
        assert!(
            !block.contains("+x\n+x"),
            "large content must not be inlined"
        );
    }

    #[tokio::test]
    async fn synthesize_binary_untracked_file_is_skipped() {
        let dir = tempfile::tempdir().unwrap();
        // NUL byte in the head → git's binary heuristic skips it, exactly as the
        // stats path does (binary untracked files aren't inlined or counted).
        std::fs::write(dir.path().join("blob.bin"), [0u8, 159, 146, 150]).unwrap();

        let block = synthesize_untracked_new_file_diff(dir.path(), "blob.bin")
            .await
            .unwrap();
        assert!(block.is_none());
    }

    #[tokio::test]
    async fn non_utf8_untracked_without_nul_has_diff_stats_parity() {
        let dir = tempfile::tempdir().unwrap();
        // Invalid UTF-8 (lone high bytes) but NO NUL: git treats this as text, so
        // it must appear in BOTH the diff and the stat count. Previously the diff
        // path (`read_to_string`) skipped it while the NUL sniff counted it — the
        // two disagreed; now they share one heuristic and can't.
        std::fs::write(
            dir.path().join("latin.txt"),
            [0xE9, 0xE8, b'\n', b'x', b'\n'],
        )
        .unwrap();

        let block = synthesize_untracked_new_file_diff(dir.path(), "latin.txt")
            .await
            .unwrap()
            .expect("non-UTF-8 text file is still synthesized, not skipped");
        assert!(block.contains("diff --git a/latin.txt b/latin.txt"));
        assert!(block.contains("@@ -0,0 +1,2 @@"));

        assert_eq!(
            count_untracked_lines(&dir.path().join("latin.txt")).await,
            Some(2),
            "same file must be counted, not skipped — diff/stats parity",
        );
    }

    #[tokio::test]
    async fn synthesize_large_binary_untracked_file_is_skipped() {
        let dir = tempfile::tempdir().unwrap();
        // Past the size threshold AND binary (all-NUL head): must be skipped, not
        // handed a text "too large to display" placeholder — matching stats.
        let big = vec![0u8; LARGE_FILE_BYTES as usize + 10];
        std::fs::write(dir.path().join("big.bin"), &big).unwrap();

        assert!(synthesize_untracked_new_file_diff(dir.path(), "big.bin")
            .await
            .unwrap()
            .is_none());
    }

    #[test]
    fn format_bytes_reads_like_the_frontend() {
        assert_eq!(format_bytes(512), "512 B");
        assert_eq!(format_bytes(2048), "2.0 KB");
        assert_eq!(format_bytes(3 * 1024 * 1024), "3.0 MB");
    }

    #[tokio::test]
    async fn count_untracked_lines_matches_lines_semantics() {
        let dir = tempfile::tempdir().unwrap();
        let cases = [
            ("trailing.txt", "a\nb\n", 2),  // trailing newline: 2 lines
            ("no_trailing.txt", "a\nb", 2), // final unterminated line counts
            ("single.txt", "a", 1),         // one line, no newline
            ("just_newline.txt", "\n", 1),  // one (empty) line
            ("empty.txt", "", 0),           // empty file: 0
        ];
        for (name, content, expected) in cases {
            std::fs::write(dir.path().join(name), content).unwrap();
            let got = count_untracked_lines(&dir.path().join(name)).await;
            assert_eq!(got, Some(expected), "line count for {name:?} ({content:?})");
        }
    }

    #[tokio::test]
    async fn count_untracked_lines_skips_binaries() {
        let dir = tempfile::tempdir().unwrap();
        // NUL byte in the first 8 KB → treated as binary and skipped.
        std::fs::write(dir.path().join("blob.bin"), b"abc\0def\n").unwrap();
        assert_eq!(
            count_untracked_lines(&dir.path().join("blob.bin")).await,
            None
        );
    }

    #[tokio::test]
    async fn count_untracked_lines_streams_multichunk_files() {
        let dir = tempfile::tempdir().unwrap();
        // Larger than the 64 KB read buffer to exercise the streaming loop and
        // cross-chunk newline counting. 100_000 lines of "x\n".
        let content = "x\n".repeat(100_000);
        std::fs::write(dir.path().join("many.txt"), &content).unwrap();
        assert_eq!(
            count_untracked_lines(&dir.path().join("many.txt")).await,
            Some(100_000)
        );
    }

    /// A file deleted since it was listed, or a link to a directory, has
    /// nothing to show. One that cannot be read fails its diff, where it used
    /// to vanish from it or show as a binary file; its line count is left out
    /// so one such file does not take the whole changed-file list down.
    #[cfg(unix)]
    #[tokio::test]
    async fn an_unreadable_untracked_file_is_an_error_not_a_skip() {
        if !crate::shared::test_dirs::permissions_bind() {
            return;
        }
        use std::os::unix::fs::PermissionsExt as _;

        let dir = tempfile::tempdir().unwrap();
        assert_eq!(
            synthesize_untracked_new_file_diff(dir.path(), "gone.txt")
                .await
                .unwrap(),
            None
        );
        assert_eq!(
            count_untracked_lines(&dir.path().join("gone.txt")).await,
            None
        );

        std::os::unix::fs::symlink(dir.path(), dir.path().join("dir-link")).unwrap();
        assert_eq!(
            synthesize_untracked_new_file_diff(dir.path(), "dir-link")
                .await
                .unwrap(),
            None
        );
        assert_eq!(
            count_untracked_lines(&dir.path().join("dir-link")).await,
            None
        );

        let locked = dir.path().join("locked.txt");
        std::fs::write(&locked, "secret\n").unwrap();
        std::fs::set_permissions(&locked, std::fs::Permissions::from_mode(0o000)).unwrap();
        let synthesized = synthesize_untracked_new_file_diff(dir.path(), "locked.txt").await;
        let counted = count_untracked_lines(&locked).await;
        std::fs::set_permissions(&locked, std::fs::Permissions::from_mode(0o644)).unwrap();
        assert!(synthesized.is_err(), "{synthesized:?}");
        assert_eq!(counted, None);
    }
}
