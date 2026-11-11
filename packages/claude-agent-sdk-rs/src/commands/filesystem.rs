use super::{plugins, CommandCollector};
use crate::error::SdkError;
use std::path::{Path, PathBuf};

pub(super) fn collect_filesystem_commands(
    collector: &mut CommandCollector,
    cwd: &str,
    config_dir: Option<&Path>,
) -> Result<(), SdkError> {
    if let Some(config_dir) = config_dir {
        scan_claude_root(collector, config_dir, None)?;
        plugins::scan_installed_plugins(collector, config_dir)?;
    }
    scan_claude_root(collector, &PathBuf::from(cwd).join(".claude"), None)?;
    Ok(())
}

fn scan_claude_root(
    collector: &mut CommandCollector,
    root: &Path,
    namespace: Option<&str>,
) -> Result<(), SdkError> {
    scan_skills_dir(collector, &root.join("skills"), namespace)?;
    scan_commands_dir(collector, &root.join("commands"), namespace)
}

pub(super) fn scan_skills_dir(
    collector: &mut CommandCollector,
    skills_dir: &Path,
    namespace: Option<&str>,
) -> Result<(), SdkError> {
    if !skills_dir.is_dir() {
        return Ok(());
    }
    for entry in std::fs::read_dir(skills_dir).map_err(SdkError::IoError)? {
        let path = entry.map_err(SdkError::IoError)?.path();
        if !path.is_dir() {
            continue;
        }
        let skill_file = path.join("SKILL.md");
        if !skill_file.is_file() {
            continue;
        }
        let Some(name) = path.file_name().and_then(|name| name.to_str()) else {
            continue;
        };
        let description = read_description(&skill_file)?;
        collector.add(command_name(name, namespace), description);
    }
    Ok(())
}

pub(super) fn scan_commands_dir(
    collector: &mut CommandCollector,
    commands_dir: &Path,
    namespace: Option<&str>,
) -> Result<(), SdkError> {
    if !commands_dir.is_dir() {
        return Ok(());
    }
    scan_command_markdown_files(collector, commands_dir, namespace)
}

fn scan_command_markdown_files(
    collector: &mut CommandCollector,
    dir: &Path,
    namespace: Option<&str>,
) -> Result<(), SdkError> {
    for entry in std::fs::read_dir(dir).map_err(SdkError::IoError)? {
        let path = entry.map_err(SdkError::IoError)?.path();
        if path.is_dir() {
            scan_command_markdown_files(collector, &path, namespace)?;
            continue;
        }
        if !path.is_file() || path.extension().and_then(|ext| ext.to_str()) != Some("md") {
            continue;
        }
        let Some(name) = path.file_stem().and_then(|name| name.to_str()) else {
            continue;
        };
        let description = read_description(&path)?;
        collector.add(command_name(name, namespace), description);
    }
    Ok(())
}

fn read_description(path: &Path) -> Result<Option<String>, SdkError> {
    let content = std::fs::read_to_string(path).map_err(SdkError::IoError)?;
    Ok(frontmatter_description(&content).or_else(|| first_content_line(&content)))
}

fn command_name(name: &str, namespace: Option<&str>) -> String {
    match namespace {
        Some(namespace) => format!("{namespace}:{name}"),
        None => name.to_string(),
    }
}

fn frontmatter_description(content: &str) -> Option<String> {
    let mut lines = content.lines();
    if lines.next()? != "---" {
        return None;
    }
    for line in lines {
        if line == "---" {
            return None;
        }
        let Some((key, value)) = line.split_once(':') else {
            continue;
        };
        if key.trim() == "description" {
            return clean_yaml_scalar(value.trim());
        }
    }
    None
}

fn first_content_line(content: &str) -> Option<String> {
    let body = match content.strip_prefix("---\n") {
        Some(rest) => rest.split_once("\n---\n").map_or(content, |(_, body)| body),
        None => content,
    };
    body.lines()
        .map(str::trim)
        .find(|line| !line.is_empty())
        .map(ToOwned::to_owned)
}

fn clean_yaml_scalar(value: &str) -> Option<String> {
    let value = value.trim_matches('"').trim_matches('\'').trim();
    (!value.is_empty()).then(|| value.to_string())
}
