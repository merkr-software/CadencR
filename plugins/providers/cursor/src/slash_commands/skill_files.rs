//! `SKILL.md` discovery, the way Cursor Agent 2026.10.22's loader walks a
//! skill root: recursive (depth ≤ 10) below the root, skipping dot
//! directories, `node_modules`, `__pycache__`, `dist` and `build`, never
//! leaving the root's real path (a user root also follows one level of
//! symlinked directories), deduplicated by real path across roots, and with
//! Codex's bundled system skills excluded. A skill's id is its folder name;
//! two folders of the same name in one root use their relative path joined
//! with `-`, and a remaining clash gets `-2`, `-3`….

use std::cmp::Ordering;
use std::collections::{HashMap, HashSet};
use std::path::{Component, Path, PathBuf};

use super::command_files::{is_js_space, read_text};
use super::frontmatter;

const MAX_DEPTH: usize = 10;
const SKIPPED_DIRECTORIES: &[&str] = &["node_modules", "__pycache__", "dist", "build"];
/// `(config dir, subdir)` of every skill root Cursor knows.
const SKILL_ROOTS: &[(&str, &str)] = &[
    (".cursor", "skills"),
    (".claude", "skills"),
    (".codex", "skills"),
    (".grok", "skills"),
    (".agents", "skills"),
    (".cursor", "skills-cursor"),
];
/// Codex's bundled skills, which Cursor does not list.
const CODEX_SYSTEM_SKILLS: &[&str] = &[
    "imagegen",
    "openai-docs",
    "opneai-docs",
    "plugin-creator",
    "skill-creator",
    "skill-installer",
];

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SkillFile {
    pub id: String,
    pub description: String,
}

/// The listable skills of `root`. `follow_links` is set for user roots.
pub fn skill_files(root: &Path, follow_links: bool, seen: &mut HashSet<PathBuf>) -> Vec<SkillFile> {
    let Ok(real_root) = std::fs::canonicalize(root) else {
        return Vec::new();
    };
    let mut found = Vec::new();
    let mut visited = HashSet::new();
    walk(
        root,
        &real_root,
        0,
        false,
        follow_links,
        &mut visited,
        &mut found,
    );
    found.sort_by(|a: &(PathBuf, PathBuf), b| locale_order(&a.0, &b.0));
    let distinct: Vec<PathBuf> = found
        .into_iter()
        .filter(|(path, _)| !is_excluded(path))
        .filter(|(_, real)| seen.insert(real.clone()))
        .map(|(path, _)| path)
        .collect();
    let mut folder_counts: HashMap<String, usize> = HashMap::new();
    for path in &distinct {
        *folder_counts.entry(folder_name(path)).or_default() += 1;
    }
    let mut used = HashSet::new();
    distinct
        .iter()
        .filter_map(|path| {
            let folder = folder_name(path);
            let base = if folder_counts[&folder] > 1 {
                relative_id(root, path).unwrap_or(folder)
            } else {
                folder
            };
            let mut id = base.clone();
            let mut suffix = 2;
            while !used.insert(id.clone()) {
                id = format!("{base}-{suffix}");
                suffix += 1;
            }
            parse_skill(&id, &read_text(path)?)
        })
        .collect()
}

fn walk(
    dir: &Path,
    real_root: &Path,
    depth: usize,
    followed: bool,
    follow_links: bool,
    visited: &mut HashSet<PathBuf>,
    found: &mut Vec<(PathBuf, PathBuf)>,
) {
    if depth > MAX_DEPTH {
        return;
    }
    let Ok(real) = std::fs::canonicalize(dir) else {
        return;
    };
    if (!followed && !real.starts_with(real_root)) || !visited.insert(real) {
        return;
    }
    let Ok(entries) = std::fs::read_dir(dir) else {
        return;
    };
    for entry in entries.filter_map(Result::ok) {
        let path = entry.path();
        let is_link = entry.file_type().is_ok_and(|kind| kind.is_symlink());
        let name = entry.file_name().to_string_lossy().into_owned();
        if path.is_dir() {
            if !followed && !name.starts_with('.') && !SKIPPED_DIRECTORIES.contains(&name.as_str())
            {
                let follow = follow_links && is_link;
                walk(
                    &path,
                    real_root,
                    depth + 1,
                    follow,
                    follow_links,
                    visited,
                    found,
                );
            }
        } else if name == "SKILL.md" {
            if let Ok(real) = std::fs::canonicalize(&path) {
                if (followed && !is_link) || real.starts_with(real_root) {
                    found.push((path, real));
                }
            }
        }
    }
}

/// Paths under a dot directory of a skill root, and Codex system skills.
fn is_excluded(path: &Path) -> bool {
    let segments: Vec<String> = path
        .components()
        .filter_map(|component| match component {
            Component::Normal(part) => Some(part.to_string_lossy().into_owned()),
            _ => None,
        })
        .collect();
    let root_at = segments.windows(2).position(|pair| {
        SKILL_ROOTS
            .iter()
            .any(|(config, subdir)| pair[0] == *config && pair[1] == *subdir)
    });
    if root_at.is_some_and(|at| segments[at + 2..].iter().any(|s| s.starts_with('.'))) {
        return true;
    }
    let Some(codex) = segments.iter().rposition(|segment| segment == ".codex") else {
        return false;
    };
    if segments.get(codex + 1).map(String::as_str) != Some("skills") {
        return false;
    }
    let skill = match segments.last().map(String::as_str) {
        Some("SKILL.md") => segments.iter().rev().nth(1),
        _ => segments.last(),
    };
    skill.is_some_and(|name| CODEX_SYSTEM_SKILLS.contains(&name.as_str()))
}

fn folder_name(path: &Path) -> String {
    path.parent()
        .and_then(Path::file_name)
        .map(|name| name.to_string_lossy().into_owned())
        .unwrap_or_default()
}

fn relative_id(root: &Path, path: &Path) -> Option<String> {
    let relative = path.parent()?.strip_prefix(root).ok()?;
    let id = relative
        .components()
        .map(|component| component.as_os_str().to_string_lossy().into_owned())
        .collect::<Vec<_>>()
        .join("-");
    (!id.is_empty()).then_some(id)
}

/// An approximation of `String.prototype.localeCompare` for paths:
/// case-insensitive, punctuation before digits before letters.
fn locale_order(a: &Path, b: &Path) -> Ordering {
    let key = |path: &Path| {
        path.to_string_lossy()
            .chars()
            .map(|ch| {
                let class = if ch.is_alphabetic() {
                    2
                } else if ch.is_numeric() {
                    1
                } else {
                    0
                };
                (class, ch.to_lowercase().next().unwrap_or(ch))
            })
            .collect::<Vec<_>>()
    };
    key(a).cmp(&key(b)).then_with(|| a.cmp(b))
}

/// Cursor's `parseSkillMarkdown`: hidden skills and invalid YAML give `None`.
fn parse_skill(id: &str, content: &str) -> Option<SkillFile> {
    let (matter, body) = frontmatter::split(content);
    let front = match matter.map(frontmatter::parse) {
        Some(Ok(front)) => front,
        Some(Err(_)) => return None,
        None => frontmatter::SkillFrontmatter::default(),
    };
    if !front.surfaces.is_empty() && !front.surfaces.iter().any(|surface| surface == "cli") {
        return None;
    }
    if front.not_user_invocable {
        return None;
    }
    let description = front
        .description
        .filter(|description| !description.is_empty())
        .or_else(|| first_body_line(body))
        .unwrap_or_else(|| front.name.unwrap_or_else(|| id.to_string()));
    Some(SkillFile {
        id: id.to_string(),
        description,
    })
}

fn first_body_line(body: &str) -> Option<String> {
    for line in body.split('\n') {
        if line.starts_with('#') {
            let heading = line.trim_start_matches('#').trim_matches(is_js_space);
            if !heading.is_empty() {
                return Some(heading.to_string());
            }
        } else {
            let trimmed = line.trim_matches(is_js_space);
            if !trimmed.is_empty() && !line.starts_with("---") {
                return Some(trimmed.to_string());
            }
        }
    }
    None
}

#[cfg(test)]
mod tests {
    use super::{is_excluded, parse_skill, skill_files};
    use std::collections::HashSet;
    use std::path::Path;

    fn write(root: &Path, relative: &str, content: &str) {
        let path = root.join(relative);
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(path, content).unwrap();
    }

    fn ids_and_descriptions(root: &Path, follow: bool) -> Vec<(String, String)> {
        skill_files(root, follow, &mut HashSet::new())
            .into_iter()
            .map(|skill| (skill.id, skill.description))
            .collect()
    }

    #[test]
    fn walks_a_root_like_cursor() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().join(".cursor/skills");
        write(&root, "a/dup/SKILL.md", "---\ndescription: dup a\n---\n");
        write(&root, "b/dup/SKILL.md", "---\ndescription: dup b\n---\n");
        write(
            &root,
            "deep/er/nested/SKILL.md",
            "---\ndescription: deep\n---\n",
        );
        write(&root, "noname/SKILL.md", "Body line for noname.\n");
        write(
            &root,
            "hidden/SKILL.md",
            "---\nuser-invocable: false\n---\n",
        );
        write(
            &root,
            "ide/SKILL.md",
            "---\nmetadata:\n  surfaces: [ide]\n---\n",
        );
        write(&root, "broken/SKILL.md", "---\ndescription: a: b\n---\n");
        write(&root, ".dot/x/SKILL.md", "---\ndescription: dot\n---\n");
        write(
            &root,
            "node_modules/nm/SKILL.md",
            "---\ndescription: nm\n---\n",
        );
        write(&root, "empty-dir/readme.md", "not a skill");
        let listed = ids_and_descriptions(&root, false);
        let expected = [
            ("a-dup", "dup a"),
            ("b-dup", "dup b"),
            ("nested", "deep"),
            ("noname", "Body line for noname."),
        ];
        assert_eq!(
            listed,
            expected
                .iter()
                .map(|(id, d)| (id.to_string(), d.to_string()))
                .collect::<Vec<_>>()
        );
    }

    #[cfg(unix)]
    #[test]
    fn user_roots_follow_symlinked_skills_and_dedupe_real_paths() {
        let dir = tempfile::tempdir().unwrap();
        let shared = dir.path().join("shared/finish-job");
        write(&shared, "SKILL.md", "---\ndescription: Finish\n---\n");
        let user = dir.path().join("home/.claude/skills");
        std::fs::create_dir_all(&user).unwrap();
        std::os::unix::fs::symlink(&shared, user.join("finish-job")).unwrap();
        let other = dir.path().join("home/.agents/skills");
        std::fs::create_dir_all(&other).unwrap();
        std::os::unix::fs::symlink(&shared, other.join("finish-job")).unwrap();

        assert!(
            ids_and_descriptions(&user, false).is_empty(),
            "project roots stay inside"
        );
        let mut seen = HashSet::new();
        let first = skill_files(&user, true, &mut seen);
        assert_eq!(first.len(), 1);
        assert_eq!(first[0].id, "finish-job");
        assert!(
            skill_files(&other, true, &mut seen).is_empty(),
            "same real path"
        );
    }

    #[test]
    fn excludes_dot_paths_and_codex_system_skills() {
        assert!(is_excluded(Path::new(
            "/h/.codex/skills/skill-creator/SKILL.md"
        )));
        assert!(!is_excluded(Path::new("/h/.codex/skills/mine/SKILL.md")));
        assert!(is_excluded(Path::new("/r/.cursor/skills/x/.y/SKILL.md")));
        assert!(!is_excluded(Path::new("/r/.cursor/skills/x/SKILL.md")));
    }

    #[test]
    fn descriptions_fall_back_to_the_body_then_the_name() {
        let parse = |content: &str| parse_skill("id", content).unwrap().description;
        assert_eq!(parse("---\nname: n\n---\n# Heading\nbody"), "Heading");
        assert_eq!(parse("---\nname: n\n---\n\n---\nline"), "line");
        assert_eq!(parse("---\nname: n\n---\n"), "n");
        assert_eq!(parse("---\ndescription: 7\n---\n"), "id");
        assert!(parse_skill("id", "---\nmetadata:\n  surfaces: cli, ide\n---\n").is_some());
    }
}
