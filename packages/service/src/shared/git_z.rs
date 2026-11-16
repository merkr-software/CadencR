//! Parsers for Git's NUL-terminated (`-z`) path listings.
//!
//! Without `-z`, Git lists one path per line, so a name holding a newline
//! splits in two; it C-quotes names holding a quote, a backslash or a control
//! character (`"tab\there.txt"`); and `--numstat` folds a rename into
//! `old => new` or `dir/{old => new}`. With `-z` every path is printed
//! verbatim and ends with NUL. Every Git command whose output names paths
//! passes `-z` and reads it through these parsers. (`git_command` also turns
//! `core.quotePath` off, so non-ASCII names stay readable in the outputs that
//! have no `-z`, such as patch headers.)

/// A `--name-only`, `ls-files` or `ls-tree --name-only` listing.
pub fn paths(output: &str) -> Vec<String> {
    records(output).map(str::to_string).collect()
}

/// One `--name-status` record.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct NameStatus {
    /// `M`, `A`, `D`, `T`, `U`, or a rename/copy with its score (`R100`).
    pub status: String,
    pub path: String,
    /// The source of a rename or copy.
    pub old_path: Option<String>,
}

/// A `--name-status -z` listing: `status\0path\0`, or `R<score>\0old\0new\0`
/// for renames and copies.
pub fn name_status(output: &str) -> Vec<NameStatus> {
    let mut records = records(output);
    let mut entries = Vec::new();
    while let Some(status) = records.next() {
        let Some(first) = records.next() else {
            break;
        };
        let (path, old_path) = if status.starts_with(['R', 'C']) {
            let Some(new) = records.next() else {
                break;
            };
            (new, Some(first.to_string()))
        } else {
            (first, None)
        };
        entries.push(NameStatus {
            status: status.to_string(),
            path: path.to_string(),
            old_path,
        });
    }
    entries
}

/// One `--numstat` record. Binary files count as zero lines, as Git's `-`
/// carries no count.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Numstat {
    pub additions: i32,
    pub deletions: i32,
    pub path: String,
    /// The source of a rename or copy.
    pub old_path: Option<String>,
}

/// A `--numstat -z` listing: `added\tdeleted\tpath\0`, or
/// `added\tdeleted\t\0old\0new\0` for renames and copies.
pub fn numstat(output: &str) -> Vec<Numstat> {
    let mut records = records(output);
    let mut entries = Vec::new();
    while let Some(record) = records.next() {
        let mut fields = record.splitn(3, '\t');
        let (Some(additions), Some(deletions), Some(path)) = (
            fields.next().and_then(count),
            fields.next().and_then(count),
            fields.next(),
        ) else {
            continue;
        };
        let (path, old_path) = if path.is_empty() {
            let (Some(old), Some(new)) = (records.next(), records.next()) else {
                break;
            };
            (new, Some(old.to_string()))
        } else {
            (path, None)
        };
        entries.push(Numstat {
            additions,
            deletions,
            path: path.to_string(),
            old_path,
        });
    }
    entries
}

fn count(value: &str) -> Option<i32> {
    if value == "-" {
        Some(0)
    } else {
        value.parse().ok()
    }
}

/// NUL-terminated records. A record is taken verbatim: a path may start with
/// a newline. Callers strip whatever framing their command adds around them.
fn records(output: &str) -> impl Iterator<Item = &str> {
    output
        .split_terminator('\0')
        .filter(|record| !record.is_empty())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::Path;
    use std::process::Command;

    /// Names Git quotes or splits without `-z`.
    const AWKWARD: [&str; 4] = [
        "café/résumé.txt",
        "with space.txt",
        "line\nbreak.txt",
        "tab\tand \"quote\".txt",
    ];

    fn git(dir: &Path, args: &[&str]) -> String {
        let output = Command::new("git")
            .args(["-c", "core.quotePath=true"])
            .args(args)
            .current_dir(dir)
            .output()
            .unwrap();
        assert!(output.status.success(), "{args:?}: {output:?}");
        String::from_utf8(output.stdout).unwrap()
    }

    /// A repository whose first commit holds every awkward name and whose
    /// working tree renames, edits and deletes them.
    fn repo() -> tempfile::TempDir {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        git(root, &["init", "-q"]);
        std::fs::create_dir_all(root.join("café")).unwrap();
        for name in AWKWARD {
            std::fs::write(root.join(name), format!("{name}\nsecond line\n")).unwrap();
        }
        git(root, &["add", "-A"]);
        git(
            root,
            &[
                "-c",
                "user.name=t",
                "-c",
                "user.email=t@t",
                "-c",
                "commit.gpgsign=false",
                "commit",
                "-qm",
                "init",
            ],
        );
        git(root, &["mv", "café/résumé.txt", "café/renamed é.txt"]);
        std::fs::write(root.join("with space.txt"), "changed\n").unwrap();
        git(root, &["rm", "-q", "line\nbreak.txt"]);
        dir
    }

    #[test]
    fn listings_keep_awkward_names_verbatim() {
        let dir = repo();
        let mut listed = paths(&git(dir.path(), &["ls-files", "-z"]));
        listed.sort();
        let mut expected = vec![
            "café/renamed é.txt",
            "tab\tand \"quote\".txt",
            "with space.txt",
        ];
        expected.sort();
        assert_eq!(listed, expected);
        // The line-based form these replace splits and quotes them.
        let quoted = git(dir.path(), &["ls-files"]);
        assert!(
            quoted.contains(r#""caf\303\251/renamed \303\251.txt""#),
            "{quoted}"
        );
    }

    #[test]
    fn name_status_pairs_renames() {
        let dir = repo();
        let entries = name_status(&git(
            dir.path(),
            &["diff", "--cached", "-M", "--name-status", "-z"],
        ));
        assert_eq!(
            entries,
            vec![
                NameStatus {
                    status: "R100".into(),
                    path: "café/renamed é.txt".into(),
                    old_path: Some("café/résumé.txt".into()),
                },
                NameStatus {
                    status: "D".into(),
                    path: "line\nbreak.txt".into(),
                    old_path: None,
                },
            ]
        );
    }

    #[test]
    fn numstat_pairs_renames_and_counts_lines() {
        let dir = repo();
        let staged = numstat(&git(
            dir.path(),
            &["diff", "--cached", "-M", "--numstat", "-z"],
        ));
        assert_eq!(staged[0].path, "café/renamed é.txt");
        assert_eq!(staged[0].old_path.as_deref(), Some("café/résumé.txt"));
        // Its contents repeat its name, newline included: three lines.
        assert_eq!(staged[1].path, "line\nbreak.txt");
        assert_eq!((staged[1].additions, staged[1].deletions), (0, 3));
        let unstaged = numstat(&git(dir.path(), &["diff", "--numstat", "-z"]));
        assert_eq!(
            unstaged,
            vec![Numstat {
                additions: 1,
                deletions: 2,
                path: "with space.txt".into(),
                old_path: None,
            }]
        );
    }

    #[test]
    fn binary_files_count_as_zero_lines() {
        assert_eq!(
            numstat("-\t-\timage.png\0"),
            vec![Numstat {
                additions: 0,
                deletions: 0,
                path: "image.png".into(),
                old_path: None,
            }]
        );
    }

    #[test]
    fn truncated_records_are_dropped() {
        assert!(name_status("R100\0old.txt\0").is_empty());
        assert!(numstat("1\t2\t\0old.txt\0").is_empty());
        assert!(paths("").is_empty());
    }
}
