//! Skills placed directly in a CLI's skills directory (`<dir>/<name>/SKILL.md`),
//! outside any marketplace. Read-only: Cadencr lists them so the inventory is
//! complete, but no CLI command installs, updates or removes them.

use std::path::Path;

use super::types::{InstalledSkill, SkillSource};

/// Every skill folder under `root`, sorted by name. A missing root is empty.
pub async fn scan(provider_id: &str, root: &Path) -> Vec<InstalledSkill> {
    let Ok(mut entries) = tokio::fs::read_dir(root).await else {
        return Vec::new();
    };
    let mut skills = Vec::new();
    while let Ok(Some(entry)) = entries.next_entry().await {
        let folder = entry.file_name().to_string_lossy().into_owned();
        if folder.starts_with('.') {
            continue;
        }
        let path = entry.path();
        let Ok(manifest) = tokio::fs::read_to_string(path.join("SKILL.md")).await else {
            continue;
        };
        let (name, description) = frontmatter(&manifest);
        skills.push(InstalledSkill {
            provider_id: provider_id.to_string(),
            id: folder.clone(),
            name: name.unwrap_or(folder),
            description,
            source: SkillSource::Local,
            version: None,
            update: None,
            enabled: None,
            scope: Some("user".to_string()),
            path: Some(path.display().to_string()),
            installed_at: None,
            updated_at: None,
        });
    }
    skills.sort_by(|a, b| a.name.cmp(&b.name));
    skills
}

/// `name` and `description` from a SKILL.md YAML front matter block.
fn frontmatter(text: &str) -> (Option<String>, Option<String>) {
    let mut lines = text.lines();
    if lines.next().map(str::trim) != Some("---") {
        return (None, None);
    }
    let (mut name, mut description) = (None, None);
    for line in lines.take_while(|line| line.trim() != "---") {
        if let Some(value) = line.strip_prefix("name:") {
            name = scalar(value);
        } else if let Some(value) = line.strip_prefix("description:") {
            description = scalar(value);
        }
    }
    (name, description)
}

fn scalar(value: &str) -> Option<String> {
    let value = value.trim();
    let value = value
        .strip_prefix('"')
        .and_then(|inner| inner.strip_suffix('"'))
        .or_else(|| {
            value
                .strip_prefix('\'')
                .and_then(|inner| inner.strip_suffix('\''))
        })
        .unwrap_or(value);
    // Block scalars (`>` / `|`) are not worth a YAML parser for a one-line hint.
    (!value.is_empty() && value != ">" && value != "|").then(|| value.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn lists_skill_folders_with_their_front_matter() {
        let root = tempfile::tempdir().unwrap();
        let skill = root.path().join("review");
        std::fs::create_dir_all(&skill).unwrap();
        std::fs::write(
            skill.join("SKILL.md"),
            "---\nname: code-review\ndescription: \"Review a diff\"\n---\nBody",
        )
        .unwrap();
        std::fs::create_dir_all(root.path().join(".system/x")).unwrap();
        std::fs::create_dir_all(root.path().join("no-manifest")).unwrap();
        let skills = scan("claude-code", root.path()).await;
        assert_eq!(skills.len(), 1);
        assert_eq!(skills[0].id, "review");
        assert_eq!(skills[0].name, "code-review");
        assert_eq!(skills[0].description.as_deref(), Some("Review a diff"));
        assert!(scan("x", &root.path().join("missing")).await.is_empty());
    }
}
