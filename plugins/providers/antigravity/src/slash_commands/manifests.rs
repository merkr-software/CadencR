//! Discover native skills and plugins using exact directory-name filters.
use std::collections::{BTreeSet, HashSet};
use std::io;
use std::path::{Path, PathBuf};

use serde::{de::DeserializeOwned, Deserialize};
use serde_json::Value;

use super::files::{children, optional, read_bounded};
use super::{read_skill, Skills};

#[derive(Default, Deserialize)]
#[serde(default)]
struct Manifest {
    entries: Vec<Entry>,
    inherits: Vec<Entry>,
    exclude: Vec<String>,
}
#[derive(Deserialize)]
struct Entry {
    path: String,
    #[serde(default)]
    include_only: Vec<String>,
    #[serde(default)]
    exclude: Vec<String>,
}

#[derive(Clone, Copy)]
enum Kind {
    Skills,
    Plugins,
}
impl Kind {
    fn directory(self) -> &'static str {
        match self {
            Self::Skills => "skills",
            Self::Plugins => "plugins",
        }
    }
}

pub(super) struct Discovery<'a> {
    home: Option<&'a Path>,
    root: &'a Path,
    settings: Value,
}

impl<'a> Discovery<'a> {
    pub(super) fn new(
        home: Option<&'a Path>,
        root: &'a Path,
        global: Option<&Path>,
    ) -> io::Result<Self> {
        let settings = match global {
            Some(p) => read_json(&p.join("config.json"))?,
            None => None,
        };
        Ok(Self {
            home,
            root,
            settings: settings.unwrap_or(Value::Null),
        })
    }

    pub(super) fn plugin_enabled(&self, name: &str, default: bool) -> bool {
        self.settings["plugins"]
            .get(name)
            .and_then(|p| p["enabled"].as_bool())
            .unwrap_or(default)
    }

    pub(super) fn customizations(
        &self,
        dir: &Path,
        base: &Path,
        skills: &mut Skills,
    ) -> io::Result<()> {
        for kind in [Kind::Skills, Kind::Plugins] {
            let name = kind.directory();
            self.scan(&dir.join(name), kind, &Selection::default(), skills)?;
            self.manifest(&dir.join(format!("{name}.json")), base, kind, skills)?;
        }
        Ok(())
    }

    fn resolve(&self, name: &str, base: &Path) -> PathBuf {
        if let (Some(home), Some(path)) = (self.home, name.strip_prefix("~/")) {
            return home.join(path);
        }
        let local = base.join(name);
        if local.exists() {
            local
        } else {
            self.root.join(name)
        }
    }

    fn manifest(
        &self,
        file: &Path,
        base: &Path,
        kind: Kind,
        skills: &mut Skills,
    ) -> io::Result<()> {
        let mut pending = vec![(file.to_owned(), Selection::default())];
        let mut seen = HashSet::new();
        while let Some((file, mut selection)) = pending.pop() {
            let Some(path) = optional(&file, file.canonicalize())? else {
                continue;
            };
            if !seen.insert((path.clone(), selection.clone())) {
                continue;
            }
            let Some(manifest) = read_json::<Manifest>(&path)? else {
                continue;
            };
            selection.exclude.extend(manifest.exclude);
            for entry in manifest.entries {
                self.scan(
                    &self.resolve(&entry.path, base),
                    kind,
                    &selection.restrict(&entry),
                    skills,
                )?;
            }
            // Direct entries win over inherited entries, in declaration order.
            pending.extend(
                manifest
                    .inherits
                    .into_iter()
                    .rev()
                    .map(|entry| (self.resolve(&entry.path, base), selection.restrict(&entry))),
            );
        }
        Ok(())
    }

    fn scan(
        &self,
        dir: &Path,
        kind: Kind,
        filter: &Selection,
        skills: &mut Skills,
    ) -> io::Result<()> {
        for path in children(dir)? {
            let Some(name) = path.file_name().and_then(|s| s.to_str()) else {
                continue;
            };
            if !filter.accepts(name) {
                continue;
            }
            match kind {
                Kind::Skills => read_skill(&path, skills)?,
                Kind::Plugins => {
                    for file in [
                        "plugin.json",
                        ".antigravity-plugin/plugin.json",
                        ".gemini-plugin/plugin.json",
                    ] {
                        if let Some(manifest) = read_json::<Value>(&path.join(file))? {
                            if self
                                .plugin_enabled(name, manifest["disabled"].as_bool() != Some(true))
                            {
                                self.scan(
                                    &path.join("skills"),
                                    Kind::Skills,
                                    &Selection::default(),
                                    skills,
                                )?;
                            }
                            break;
                        }
                    }
                }
            }
        }
        Ok(())
    }
}

// agy skips an invalid customization and continues loading the other roots.
fn read_json<T: DeserializeOwned>(file: &Path) -> io::Result<Option<T>> {
    let Some(bytes) = read_bounded(file)? else {
        return Ok(None);
    };
    Ok(match serde_json::from_slice(&bytes) {
        Ok(value) => Some(value),
        Err(error) => {
            eprintln!(
                "Skipping invalid Antigravity configuration {} at line {}, column {}",
                file.display(),
                error.line(),
                error.column()
            );
            None
        }
    })
}

#[derive(Clone, Default, Eq, Hash, PartialEq)]
struct Selection {
    include: Option<BTreeSet<String>>,
    exclude: BTreeSet<String>,
}

impl Selection {
    fn restrict(&self, entry: &Entry) -> Self {
        let mut result = self.clone();
        if !entry.include_only.is_empty() {
            result.include = Some(
                entry
                    .include_only
                    .iter()
                    .filter(|name| self.include.as_ref().is_none_or(|set| set.contains(*name)))
                    .cloned()
                    .collect(),
            );
        }
        result.exclude.extend(entry.exclude.iter().cloned());
        result
    }

    fn accepts(&self, name: &str) -> bool {
        self.include.as_ref().is_none_or(|set| set.contains(name)) && !self.exclude.contains(name)
    }
}
