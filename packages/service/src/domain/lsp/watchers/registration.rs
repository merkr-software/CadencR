//! Bounded LSP glob registration, confined to the workspace and its pinned runtime.
use std::path::{Component, Path, PathBuf};

use globset::{GlobBuilder, GlobMatcher};
use serde::Deserialize;
use serde_json::Value;

pub(super) const METHOD: &str = "workspace/didChangeWatchedFiles";
pub(super) const MAX_RULES: usize = 256;

#[derive(Clone)]
pub(super) struct Rule {
    matcher: GlobMatcher,
    pub kind: u8,
}
impl Rule {
    pub fn matches(&self, path: &Path, kind: u8) -> bool {
        self.kind & kind != 0 && self.matcher.is_match(path)
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Options {
    watchers: Vec<Watcher>,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Watcher {
    glob_pattern: Value,
    kind: Option<u8>,
}

pub(super) fn compile(options: Value, roots: &[PathBuf]) -> Result<Vec<Rule>, String> {
    let options: Options = serde_json::from_value(options).map_err(|e| e.to_string())?;
    if options.watchers.len() > MAX_RULES {
        return Err("Too many language-server file watchers".into());
    }
    options
        .watchers
        .into_iter()
        .map(|watcher| {
            let kind = watcher.kind.unwrap_or(7);
            if kind == 0 || kind > 7 {
                return Err("Invalid file watcher event mask".into());
            }
            let pattern = pattern(&watcher.glob_pattern, roots)?;
            let glob = GlobBuilder::new(&pattern)
                .literal_separator(true)
                .backslash_escape(false)
                .build()
                .map_err(|e| format!("Invalid file watcher glob: {e}"))?;
            Ok(Rule {
                matcher: glob.compile_matcher(),
                kind,
            })
        })
        .collect()
}

fn pattern(value: &Value, roots: &[PathBuf]) -> Result<String, String> {
    let (base, pattern) = match value {
        Value::String(pattern) => (roots[0].clone(), pattern.as_str()),
        Value::Object(relative) => {
            let base = relative
                .get("baseUri")
                .ok_or("File watcher base URI missing")?;
            let uri = base
                .as_str()
                .or_else(|| base.get("uri").and_then(Value::as_str))
                .ok_or("Invalid file watcher base URI")?;
            let base = reqwest::Url::parse(uri)
                .map_err(|e| e.to_string())?
                .to_file_path()
                .map_err(|()| "File watcher requires a local file URI")?;
            let pattern = relative
                .get("pattern")
                .and_then(Value::as_str)
                .ok_or("File watcher pattern missing")?;
            (base, pattern)
        }
        _ => return Err("Invalid file watcher glob pattern".into()),
    };
    if pattern.is_empty() || pattern.len() > 2048 || pattern.matches('{').count() > 4 {
        return Err("File watcher glob exceeds bounds".into());
    }
    let absolute = base.join(pattern);
    let text = absolute.to_str().ok_or("File watcher path must be UTF-8")?;
    let first_glob = text.find(['*', '?', '[', '{']).unwrap_or(text.len());
    let prefix_end = text[..first_glob]
        .rfind('/')
        .ok_or("Invalid absolute file watcher glob")?;
    let prefix = equivalent_root(normalized(Path::new(&text[..prefix_end]))?, roots);
    if !roots.iter().any(|root| prefix.starts_with(root)) {
        return Err("File watcher lies outside the workspace and pinned runtime".into());
    }
    Ok(format!("{}/{}", prefix.display(), &text[prefix_end + 1..]))
}

/// Case-folded macOS server paths can name the same directory as the canonical root.
/// Filesystem identity proves equivalence; Linux remains case-sensitive.
fn equivalent_root(prefix: PathBuf, roots: &[PathBuf]) -> PathBuf {
    use std::os::unix::fs::MetadataExt;
    for root in roots {
        let Ok(root_metadata) = std::fs::metadata(root) else {
            continue;
        };
        let mut ancestor = prefix.as_path();
        let mut suffix = Vec::new();
        loop {
            if let Ok(metadata) = std::fs::metadata(ancestor) {
                if metadata.dev() == root_metadata.dev() && metadata.ino() == root_metadata.ino() {
                    let mut result = root.clone();
                    for component in suffix.into_iter().rev() {
                        result.push(component);
                    }
                    return result;
                }
            }
            let Some(name) = ancestor.file_name() else {
                break;
            };
            suffix.push(name.to_owned());
            let Some(parent) = ancestor.parent() else {
                break;
            };
            ancestor = parent;
        }
    }
    prefix
}

/// Resolve existing ancestors as well: deleted paths and new directories still normalize.
pub(super) fn normalized(path: &Path) -> Result<PathBuf, String> {
    if !path.is_absolute()
        || path
            .components()
            .any(|p| matches!(p, Component::ParentDir | Component::CurDir))
    {
        return Err("File watcher path must be absolute without traversal".into());
    }
    let mut ancestor = path;
    let mut suffix = Vec::new();
    while !ancestor.exists() {
        suffix.push(
            ancestor
                .file_name()
                .ok_or("Invalid file watcher path")?
                .to_owned(),
        );
        ancestor = ancestor.parent().ok_or("Invalid file watcher ancestor")?;
    }
    let mut result = ancestor.canonicalize().map_err(|e| e.to_string())?;
    for name in suffix.into_iter().rev() {
        result.push(name);
    }
    Ok(result)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn globs_and_kind_masks_follow_lsp_semantics_and_confine_roots() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().canonicalize().unwrap();
        let rules = compile(
            json!({"watchers":[{"globPattern":"**/*.{ts,js}","kind":5}]}),
            &[root.clone()],
        )
        .unwrap();
        assert!(rules[0].matches(&root.join("src/main.ts"), 1));
        assert!(rules[0].matches(&root.join("main.js"), 4));
        assert!(!rules[0].matches(&root.join("main.js"), 2));
        assert!(!rules[0].matches(&root.join("main.rs"), 1));
        assert!(compile(
            json!({"watchers":[{"globPattern":"/outside/**/*"}]}),
            &[root.clone()]
        )
        .is_err());
        assert!(compile(json!({"watchers":[{"globPattern":"../escape/*"}]}), &[root]).is_err());
    }

    #[test]
    fn relative_pattern_base_uri_and_uncreated_directories_are_supported() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().canonicalize().unwrap();
        let rules = compile(
            json!({"watchers":[{"globPattern":{"baseUri":{
            "uri":reqwest::Url::from_directory_path(&root).unwrap().as_str(),"name":"root"},
            "pattern":"new/**/*.json"}}]}),
            &[root.clone()],
        )
        .unwrap();
        assert!(rules[0].matches(&root.join("new/config.json"), 2));
    }
}
