//! agy 1.5 has no session-free command-list RPC. Its ACP menu consists of
//! prompt commands followed by invocable skills sorted by their declared name.
//! TUI-only commands such as /exit are not valid ACP prompts.
mod manifests;

use std::collections::BTreeMap;
use std::fs;
use std::io::{self, BufRead, BufReader, Read};
use std::path::{Path, PathBuf};

use cadencr_provider_sdk::{
    is_valid_slash_command_name, sanitize_slash_command_description, SlashCommand,
    MAX_SLASH_COMMANDS,
};
use serde::Deserialize;

const COMMANDS: &[(&str, &str)] = &[
    (
        "goal",
        "Run until the specified goal is completely finished.",
    ),
    (
        "compact",
        "Compact the conversation now (summarize history to free up the context window).",
    ),
    (
        "schedule",
        "Run an instruction on a recurring schedule or as a one-time timer.",
    ),
    ("browser", "Invoke a browser agent for web tasks."),
    ("plan", "Plan carefully before executing a task."),
    ("grill-me", "Interview me to align on a plan."),
    (
        "teamwork",
        "Invoke a team of agents to autonomously tackle large projects.",
    ),
    (
        "learn",
        "Reflect on recent successes or corrections to capture reusable skills or rules.",
    ),
    (
        "boost",
        "Invoke the Boost multi-agent orchestrator for complex tasks.",
    ),
];
const ROOTS: [&str; 4] = [".agents", ".agent", "_agents", "_agent"];
const FILE_LIMIT: u64 = 256 * 1024;

pub fn commands(cwd: &Path, home: Option<&Path>) -> io::Result<Vec<SlashCommand>> {
    let root = cwd
        .ancestors()
        .find(|dir| dir.join(".git").exists())
        .unwrap_or(cwd);
    let mut workspace: Vec<_> = cwd
        .ancestors()
        .take_while(|dir| dir.starts_with(root))
        .collect();
    // Native discovery visits the repo root before nested directories.
    workspace.reverse();
    let mut skills = BTreeMap::new();
    let global = home.map(|d| d.join(".gemini/config"));
    let scan = manifests::Discovery::new(home, root, global.as_deref())?;
    for base in workspace {
        for dir in ROOTS {
            scan.customizations(&base.join(dir), base, &mut skills)?;
        }
    }
    if let Some(global) = &global {
        scan.customizations(global, global, &mut skills)?;
    }
    if let Some(home) = home {
        let builtin = home.join(".gemini/antigravity-cli/builtin/skills");
        // These are mounted for the CLI. The same installation also holds
        // skills for other Google products which are not available via ACP.
        for dir in [
            "agy-customizations",
            "antigravity_guide",
            "run-workflow",
            "native_swarm",
        ] {
            if dir != "native_swarm" || scan.plugin_enabled("swarm", true) {
                read_skill(&builtin.join(dir), &mut skills)?;
            }
        }
    }
    for &(name, _) in COMMANDS {
        skills.remove(name);
    }
    Ok(COMMANDS
        .iter()
        .map(|&(n, d)| (n.to_owned(), d.to_owned()))
        .chain(skills.into_iter().filter_map(|(n, d)| Some((n, d?))))
        .take(MAX_SLASH_COMMANDS)
        .map(|(name, description)| {
            SlashCommand::builder()
                .name(name)
                .description(description)
                .build()
        })
        .collect())
}

type Skills = BTreeMap<String, Option<String>>;

#[derive(Deserialize)]
struct Frontmatter {
    name: Option<String>,
    description: Option<String>,
    #[serde(default, rename = "disable-slash-command")]
    hidden: bool,
}

fn read_skill(dir: &Path, skills: &mut Skills) -> io::Result<()> {
    let Some(file) = optional_file(&dir.join("SKILL.md"))? else {
        return Ok(());
    };
    let mut reader = BufReader::new(file.take(FILE_LIMIT));
    let mut header = Vec::new();
    reader.read_until(b'\n', &mut header)?;
    if header.trim_ascii_end() != b"---" {
        return Ok(());
    }
    header.clear();
    let mut start = 0;
    loop {
        if reader.read_until(b'\n', &mut header)? == 0 {
            return Ok(());
        }
        let delimiter = header[start..].trim_ascii_end() == b"---";
        if !delimiter {
            start = header.len();
            continue;
        }
        if let Ok(meta) = serde_yaml_ng::from_slice::<Frontmatter>(&header[..start]) {
            let name = meta
                .name
                .as_deref()
                .filter(|n| !n.is_empty())
                .or_else(|| dir.file_name()?.to_str());
            if let Some(name) = name.filter(|s| is_valid_slash_command_name(s)) {
                skills.entry(name.to_owned()).or_insert_with(|| {
                    (!meta.hidden).then(|| {
                        sanitize_slash_command_description(
                            meta.description.as_deref().unwrap_or_default(),
                        )
                    })
                });
            }
        }
        break;
    }
    Ok(())
}

fn missing(error: &io::Error) -> bool {
    matches!(
        error.kind(),
        io::ErrorKind::NotFound | io::ErrorKind::NotADirectory
    )
}

fn optional_file(path: &Path) -> io::Result<Option<fs::File>> {
    match fs::metadata(path) {
        Ok(metadata) if metadata.is_file() => fs::File::open(path).map(Some),
        Ok(_) => Ok(None),
        Err(e) if missing(&e) => Ok(None),
        Err(e) => Err(e),
    }
}

fn read_bounded(path: &Path) -> io::Result<Option<Vec<u8>>> {
    let Some(file) = optional_file(path)? else {
        return Ok(None);
    };
    let mut bytes = Vec::new();
    file.take(FILE_LIMIT + 1).read_to_end(&mut bytes)?;
    if bytes.len() > FILE_LIMIT as usize {
        eprintln!(
            "Skipping oversized Antigravity configuration {}",
            path.display()
        );
        return Ok(None);
    }
    Ok(Some(bytes))
}

fn children(dir: &Path) -> io::Result<Vec<PathBuf>> {
    let entries = match fs::read_dir(dir) {
        Ok(e) => e,
        Err(e) if missing(&e) => return Ok(Vec::new()),
        Err(e) => return Err(e),
    };
    let mut paths: Vec<_> = entries
        .map(|e| e.map(|x| x.path()))
        .collect::<io::Result<_>>()?;
    paths.sort();
    Ok(paths)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn cold_catalog_matches_native_project_global_and_bundled_skill_discovery() {
        let temp = tempfile::tempdir().unwrap();
        let repo = temp.path().join("repo");
        let home = temp.path().join("home");
        fs::create_dir_all(repo.join(".git")).unwrap();
        let write = |base: &Path, file: &str, data: &str| {
            let path = base.join(file);
            fs::create_dir_all(path.parent().unwrap()).unwrap();
            fs::write(path, data).unwrap();
        };
        let skill = |base: &Path, dir: &str, name: &str, extra: &str| {
            write(base, &format!("{dir}/SKILL.md"), &format!("---\r\nname: {name}\r\ndescription: >-\r\n  first\r\n  second\r\n{extra}---\r\n# Skill"));
        };
        skill(&repo, ".agents/skills/dir", "shared", "");
        skill(
            &repo,
            "sub/.agent/skills/hidden",
            "hidden",
            "disable-slash-command: true\n",
        );
        skill(&repo, "_agents/skills/collision", "compact", "");
        skill(&home, ".gemini/config/skills/global", "global", "");
        skill(
            &home,
            ".gemini/antigravity-cli/builtin/skills/native_swarm",
            "swarm",
            "",
        );
        skill(
            &home,
            ".gemini/antigravity-cli/builtin/skills/other",
            "other-product",
            "",
        );
        write(
            &repo,
            ".agents/plugins/demo/plugin.json",
            r#"{"name":"demo"}"#,
        );
        skill(&repo, ".agents/plugins/demo/skills/addon", "addon", "");
        write(&repo, "_agent/plugins/broken/plugin.json", "{");
        write(
            &repo,
            ".agents/skills.json",
            r#"{"inherits":[{"path":"custom/manifest.json"}]}"#,
        );
        write(
            &repo,
            "custom/manifest.json",
            r#"{"inherits":[{"path":".agents/skills.json"}],"entries":[{"path":"custom/skills","include_only":["external","^ignored$","["]}]}"#,
        );
        skill(&repo, "custom/skills/external", "configured", "");
        skill(&repo, "custom/skills/ignored", "ignored", "");
        // Inherited selectors match leaf directory names, even when a skill
        // declares a different command name. Exclusions apply at every level.
        write(
            &repo,
            "sub/.agent/skills.json",
            r#"{"exclude":["blocked"],"inherits":[{"path":"more.json","include_only":["leaf","blocked"]},{"path":"more.json","include_only":["second"]}]}"#,
        );
        write(&repo, "sub/more.json", r#"{"entries":[{"path":"nested"}]}"#);
        skill(&repo, "sub/nested/leaf", "renamed", "");
        skill(&repo, "sub/nested/second", "from-second-path", "");
        skill(&repo, "sub/nested/blocked", "blocked-alias", "");
        skill(&repo, "sub/nested/leaf-extension", "no-substring-match", "");
        write(
            &repo,
            ".agents/plugins/disabled/plugin.json",
            r#"{"disabled":true}"#,
        );
        skill(&repo, ".agents/plugins/disabled/skills/skip", "skip", "");
        write(
            &repo,
            ".agents/plugins/overridden/plugin.json",
            r#"{"name":"alias","disabled":true}"#,
        );
        skill(
            &repo,
            ".agents/plugins/overridden/skills/enabled",
            "enabled",
            "",
        );
        write(
            &home,
            ".gemini/config/config.json",
            r#"{"plugins":{"overridden":{"enabled":true},"alias":{"enabled":false}}}"#,
        );
        let list = commands(&repo.join("sub"), Some(&home)).unwrap();
        cadencr_provider_sdk::validate_slash_commands(&list).unwrap();
        assert_eq!(
            list.iter().map(|x| x.name.as_str()).collect::<Vec<_>>(),
            [
                "goal",
                "compact",
                "schedule",
                "browser",
                "plan",
                "grill-me",
                "teamwork",
                "learn",
                "boost",
                "addon",
                "configured",
                "enabled",
                "from-second-path",
                "global",
                "renamed",
                "shared",
                "swarm"
            ]
        );
        assert_eq!(
            list.last().unwrap().description.as_deref(),
            Some("first second")
        );
    }
    #[test]
    fn a_binary_or_large_skill_body_does_not_hide_valid_frontmatter() {
        let temp = tempfile::tempdir().unwrap();
        let mut data = b"---\nname: example\ndescription: header only\n---\n".to_vec();
        data.resize(FILE_LIMIT as usize + 50, 0xff);
        fs::write(temp.path().join("SKILL.md"), data).unwrap();
        let mut skills = Skills::new();
        read_skill(temp.path(), &mut skills).unwrap();
        assert_eq!(skills["example"].as_deref(), Some("header only"));
    }

    #[test]
    fn deep_shared_manifest_graphs_reach_the_leaf() {
        let temp = tempfile::tempdir().unwrap();
        let dir = temp.path();
        fs::create_dir_all(dir.join(".agents")).unwrap();
        fs::create_dir_all(dir.join("library/example")).unwrap();
        fs::write(
            dir.join("library/example/SKILL.md"),
            "---\nname: example\n---\n",
        )
        .unwrap();
        fs::write(
            dir.join(".agents/skills.json"),
            r#"{"inherits":[{"path":"0-a.json"}]}"#,
        )
        .unwrap();
        const LEVELS: usize = 40;
        for index in 0..LEVELS {
            let next = index + 1;
            let manifest = if next == LEVELS {
                serde_json::json!({"entries":[{"path":"library"}]})
            } else {
                serde_json::json!({"inherits":[{"path":format!("{next}-a.json")},{"path":format!("{next}-b.json")}]})
            };
            for side in ["a", "b"] {
                fs::write(
                    dir.join(format!("{index}-{side}.json")),
                    manifest.to_string(),
                )
                .unwrap();
            }
        }
        assert!(commands(dir, None)
            .unwrap()
            .iter()
            .any(|c| c.name == "example"));
    }
}
