//! `slash-commands`: the `/` catalog Cursor's ACP server would advertise in
//! `available_commands_update` for a directory, rebuilt from the filesystem
//! without starting `agent acp` (a session would persist under
//! `~/.cursor/acp-sessions`).
//!
//! Cursor Agent 2026.10.22 (`custom-commands.ts` in its bundle, checked
//! against live `available_commands_update` frames) sends, in order:
//!
//! 1. `copy-request-id`, its one built-in ACP command;
//! 2. team and "global" commands from Cursor's dashboard API — not
//!    reproducible offline, so absent here (the host appends them from the
//!    last live session);
//! 3. command files of `.claude/commands`, `.cursor/commands` (project
//!    root), then `~/.claude/commands`, `~/.cursor/commands`; a later file
//!    with the same id replaces the earlier one's description in place.
//!    Description: `<title> (project)` or `<title> (user)`;
//! 4. skills of `~/.cursor/skills-cursor` (built-in), then `.cursor`,
//!    `.claude`, `.codex`, `.grok`, `.agents` `skills/` of the project root,
//!    then the same under `~`. Description: `<description> (builtin skill)`,
//!    `(project skill)` or `(user skill)`, same replace-in-place rule.
//!
//! The project root is the nearest ancestor of the session cwd holding a
//! `.git` entry, else the cwd. Names Cursor cannot invoke (with whitespace)
//! are dropped and duplicates keep their first entry — the same
//! normalization the proxy applies to live updates (`normalize_live_update`).

mod command_files;
mod frontmatter;
mod skill_files;

use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};

use cadencr_provider_sdk::meta::{merge_meta, slash_command_kind_meta};
use cadencr_provider_sdk::{
    is_valid_slash_command_name, sanitize_slash_command_description, SlashCommand,
    SlashCommandKind, MAX_SLASH_COMMANDS,
};
use serde_json::{Map, Value};

use command_files::command_files;
use skill_files::skill_files;

const COPY_REQUEST_ID: (&str, &str) = ("copy-request-id", "Copy the last request ID to clipboard");
/// Cursor's skill scope suffixes (`getSkillScopeIndicator`).
const SKILL_SUFFIXES: &[&str] = &[
    " (project skill)",
    " (user skill)",
    " (builtin skill)",
    " (skill)",
];
const SKILL_DIRECTORIES: &[&str] = &[".cursor", ".claude", ".codex", ".grok", ".agents"];

/// Insertion-ordered map where a later insert replaces the value in place,
/// like the JavaScript `Map` Cursor's loader fills.
#[derive(Default)]
struct Ordered {
    entries: Vec<(String, String)>,
    index: HashMap<String, usize>,
}

impl Ordered {
    fn set(&mut self, id: String, description: String) {
        match self.index.get(&id) {
            Some(&at) => self.entries[at].1 = description,
            None => {
                self.index.insert(id.clone(), self.entries.len());
                self.entries.push((id, description));
            }
        }
    }
}

/// The catalog for `cwd`; `home` is the user's home directory.
pub fn cursor_slash_commands(cwd: &Path, home: Option<&Path>) -> Vec<SlashCommand> {
    let root = project_root(cwd);
    let mut commands = Ordered::default();
    let mut command_roots = vec![
        (root.join(".claude/commands"), "(project)"),
        (root.join(".cursor/commands"), "(project)"),
    ];
    if let Some(home) = home {
        command_roots.push((home.join(".claude/commands"), "(user)"));
        command_roots.push((home.join(".cursor/commands"), "(user)"));
    }
    for (directory, scope) in command_roots {
        for file in command_files(&directory) {
            commands.set(file.id, format!("{} {scope}", file.title));
        }
    }

    let mut skill_roots = Vec::new();
    if let Some(home) = home {
        skill_roots.push((home.join(".cursor/skills-cursor"), "(builtin skill)", false));
    }
    for directory in SKILL_DIRECTORIES {
        skill_roots.push((
            root.join(directory).join("skills"),
            "(project skill)",
            false,
        ));
    }
    if let Some(home) = home {
        for directory in SKILL_DIRECTORIES {
            skill_roots.push((home.join(directory).join("skills"), "(user skill)", true));
        }
    }
    let mut skills = Ordered::default();
    let mut seen = HashSet::new();
    for (directory, scope, follow_links) in skill_roots {
        for skill in skill_files(&directory, follow_links, &mut seen) {
            skills.set(skill.id, format!("{} {scope}", skill.description));
        }
    }

    let listed = std::iter::once((
        COPY_REQUEST_ID.0.to_string(),
        COPY_REQUEST_ID.1.to_string(),
        SlashCommandKind::Command,
    ))
    .chain(
        commands
            .entries
            .into_iter()
            .map(|(id, d)| (id, d, SlashCommandKind::Command)),
    )
    .chain(
        skills
            .entries
            .into_iter()
            .map(|(id, d)| (id, d, SlashCommandKind::Skill)),
    );
    let mut names = HashSet::new();
    listed
        .filter(|(name, _, _)| is_valid_slash_command_name(name) && names.insert(name.clone()))
        .map(|(name, description, kind)| {
            SlashCommand::builder()
                .name(name)
                .description(sanitize_slash_command_description(&description))
                .kind(kind)
                .build()
        })
        .take(MAX_SLASH_COMMANDS)
        .collect()
}

/// Cursor's `findGitRoot`: the nearest ancestor with a `.git` entry, never
/// the filesystem root itself; else `cwd`.
fn project_root(cwd: &Path) -> PathBuf {
    let mut current = cwd;
    loop {
        if current.join(".git").exists() {
            return current.to_path_buf();
        }
        match current.parent() {
            Some(parent) if parent != current && parent.parent().is_some() => current = parent,
            _ => return cwd.to_path_buf(),
        }
    }
}

/// Normalize a live `available_commands_update` like `slash-commands` does:
/// drop names that cannot be invoked, keep the first of duplicate names, and
/// mark skills with `_meta.cadencr.kind` so both lists group alike.
pub fn normalize_live_update(update: &mut Map<String, Value>) {
    let Some(Value::Array(commands)) = update.get_mut("availableCommands") else {
        return;
    };
    let mut names = HashSet::new();
    commands.retain(|command| {
        command
            .get("name")
            .and_then(Value::as_str)
            .is_some_and(|name| is_valid_slash_command_name(name) && names.insert(name.to_string()))
    });
    for command in commands.iter_mut() {
        let is_skill = command
            .get("description")
            .and_then(Value::as_str)
            .is_some_and(|description| SKILL_SUFFIXES.iter().any(|s| description.ends_with(s)));
        if let (true, Some(object)) = (is_skill, command.as_object_mut()) {
            merge_meta(object, slash_command_kind_meta(SlashCommandKind::Skill));
        }
    }
}

#[cfg(test)]
mod tests {
    use super::{cursor_slash_commands, normalize_live_update, project_root};
    use cadencr_provider_sdk::{validate_slash_commands, SlashCommandKind};
    use serde_json::json;
    use std::path::Path;

    fn write(root: &Path, relative: &str, content: &str) {
        let path = root.join(relative);
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(path, content).unwrap();
    }

    fn listing(cwd: &Path, home: &Path) -> Vec<(String, String, SlashCommandKind)> {
        let commands = cursor_slash_commands(cwd, Some(home));
        validate_slash_commands(&commands).expect("host-valid output");
        commands
            .into_iter()
            .map(|c| (c.name, c.description.unwrap_or_default(), c.kind))
            .collect()
    }

    /// The repo2 probe of `docs/PROVIDER_SPEC/CURSOR.md`, minus server-side
    /// commands, with a temporary home instead of the real one.
    #[test]
    fn reproduces_cursors_live_list() {
        let dir = tempfile::tempdir().unwrap();
        let (repo, home) = (dir.path().join("repo"), dir.path().join("home"));
        std::fs::create_dir_all(repo.join(".git")).unwrap();
        std::fs::create_dir_all(repo.join("src/deep")).unwrap();
        write(&repo, ".claude/commands/foo.md", "Claude foo\n");
        write(&repo, ".cursor/commands/foo.md", "Cursor foo\n");
        write(&repo, ".cursor/commands/bar.md", "Command bar\n");
        write(&repo, ".cursor/commands/Has Space.md", "Spaced\n");
        write(
            &repo,
            ".agents/skills/bar/SKILL.md",
            "---\ndescription: Skill bar\n---\n",
        );
        write(
            &repo,
            ".cursor/skills/finish-job/SKILL.md",
            "---\ndescription: Project\n---\n",
        );
        write(
            &repo,
            ".grok/skills/g/SKILL.md",
            "---\ndescription: |\n  one\n  two\n---\n",
        );
        write(
            &home,
            ".cursor/skills-cursor/loop/SKILL.md",
            "---\ndescription: Loop\n---\n",
        );
        write(
            &home,
            ".claude/skills/finish-job/SKILL.md",
            "---\ndescription: User\n---\n",
        );
        write(&home, ".cursor/commands/mine.md", "# Mine\n");

        let listed = listing(&repo.join("src/deep"), &home);
        let expected = [
            (
                "copy-request-id",
                "Copy the last request ID to clipboard",
                SlashCommandKind::Command,
            ),
            ("foo", "Cursor foo (project)", SlashCommandKind::Command),
            ("bar", "Command bar (project)", SlashCommandKind::Command),
            ("mine", "Mine (user)", SlashCommandKind::Command),
            ("loop", "Loop (builtin skill)", SlashCommandKind::Skill),
            ("finish-job", "User (user skill)", SlashCommandKind::Skill),
            ("g", "one\ntwo\n (project skill)", SlashCommandKind::Skill),
        ];
        let expected: Vec<_> = expected
            .iter()
            .map(|(n, d, k)| (n.to_string(), d.to_string(), *k))
            .collect();
        assert_eq!(listed, expected);
    }

    #[test]
    fn the_project_root_is_the_nearest_git_ancestor() {
        let dir = tempfile::tempdir().unwrap();
        let repo = dir.path().join("repo");
        std::fs::create_dir_all(repo.join("a/b")).unwrap();
        std::fs::write(repo.join(".git"), "gitdir: /elsewhere").unwrap();
        assert_eq!(project_root(&repo.join("a/b")), repo);
        let loose = dir.path().join("loose");
        std::fs::create_dir_all(&loose).unwrap();
        assert_eq!(project_root(&loose), loose);
    }

    #[test]
    fn live_updates_get_the_same_normalization() {
        let mut update = json!({
            "sessionUpdate": "available_commands_update",
            "availableCommands": [
                { "name": "bar", "description": "Command bar (project)" },
                { "name": "Has Space", "description": "Spaced (project)" },
                { "name": "bar", "description": "Skill bar (project skill)" },
                { "name": "loop", "description": "Loop (builtin skill)" },
                { "description": "nameless" }
            ]
        });
        normalize_live_update(update.as_object_mut().unwrap());
        assert_eq!(
            update["availableCommands"],
            json!([
                { "name": "bar", "description": "Command bar (project)" },
                {
                    "name": "loop",
                    "description": "Loop (builtin skill)",
                    "_meta": { "cadencr": { "kind": "skill" } }
                }
            ])
        );
    }
}
