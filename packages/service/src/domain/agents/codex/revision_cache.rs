//! Memoized effective-config fingerprints.
//!
//! Every prompt re-resolves the session profile, and the fingerprint behind it
//! comes from a throwaway `codex app-server` (`initialize` + `config/read`):
//! ~0.1 s paid before the prompt reaches the agent. The fingerprint only moves
//! when a config file moves, so it is reused while every layer file Codex
//! reported — and every place a project layer could appear — is unchanged.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{LazyLock, Mutex};
use std::time::{Duration, Instant, SystemTime};

use serde_json::Value;

/// Safety net for inputs no file stamp captures (managed preferences, ...).
const MAX_AGE: Duration = Duration::from_secs(600);

/// How far a file's mtime may lag the wall clock at the moment it was written.
/// Filesystems stamp from a coarse clock (a kernel tick on Linux) or round to
/// whole seconds (HFS+, ext3; FAT to two), so an edit made just after the probe
/// started can carry an mtime from just before it.
const MTIME_GRANULARITY: Duration = Duration::from_secs(2);

#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub(super) struct RevisionKey {
    env: Vec<(String, String)>,
    env_unset: Vec<String>,
    cwd: PathBuf,
    stored_revision: String,
}

impl RevisionKey {
    pub(super) fn new(
        env: &HashMap<String, String>,
        env_unset: &[String],
        cwd: &Path,
        stored_revision: &str,
    ) -> Self {
        let mut env: Vec<_> = env.iter().map(|(k, v)| (k.clone(), v.clone())).collect();
        env.sort();
        let mut env_unset = env_unset.to_vec();
        env_unset.sort();
        Self {
            env,
            env_unset,
            cwd: cwd.to_path_buf(),
            stored_revision: stored_revision.to_string(),
        }
    }
}

type FileStamp = Option<(SystemTime, u64)>;

struct CachedRevision {
    revision: String,
    stamps: Vec<(PathBuf, FileStamp)>,
    cached_at: Instant,
}

static CACHE: LazyLock<Mutex<HashMap<RevisionKey, CachedRevision>>> =
    LazyLock::new(|| Mutex::new(HashMap::new()));

pub(super) fn cached(key: &RevisionKey) -> Option<String> {
    let cache = CACHE.lock().ok()?;
    let entry = cache.get(key)?;
    let fresh = entry.cached_at.elapsed() < MAX_AGE
        && entry
            .stamps
            .iter()
            .all(|(path, stamp)| file_stamp(path) == *stamp);
    fresh.then(|| entry.revision.clone())
}

/// Remember `revision` for `key`, stamping the layer files `config` (a
/// `config/read` response with layers) was built from. A file modified since
/// `probe_started` may postdate what Codex read, so nothing is cached then —
/// "since" widened by [`MTIME_GRANULARITY`], as mtimes lag the wall clock.
pub(super) fn store(key: RevisionKey, revision: String, config: &Value, probe_started: SystemTime) {
    let edit_horizon = probe_started
        .checked_sub(MTIME_GRANULARITY)
        .unwrap_or(SystemTime::UNIX_EPOCH);
    let stamps: Vec<_> = watched_paths(config, &key.cwd)
        .into_iter()
        .map(|path| {
            let stamp = file_stamp(&path);
            (path, stamp)
        })
        .collect();
    let edited_during_probe = stamps
        .iter()
        .any(|(_, stamp)| stamp.is_some_and(|(modified, _)| modified >= edit_horizon));
    if edited_during_probe {
        return;
    }
    if let Ok(mut cache) = CACHE.lock() {
        // Profile edits and removed worktrees leave orphaned keys behind.
        cache.retain(|_, entry| entry.cached_at.elapsed() < MAX_AGE);
        cache.insert(
            key,
            CachedRevision {
                revision,
                stamps,
                cached_at: Instant::now(),
            },
        );
    }
}

fn watched_paths(config: &Value, cwd: &Path) -> Vec<PathBuf> {
    let mut paths: Vec<PathBuf> = config
        .get("layers")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(|layer| layer.pointer("/name/file")?.as_str().map(PathBuf::from))
        .collect();
    // A project layer that doesn't exist yet isn't listed; watch every place
    // one could appear so creating it invalidates the fingerprint.
    paths.extend(
        cwd.ancestors()
            .map(|dir| dir.join(".codex").join("config.toml")),
    );
    paths.sort();
    paths.dedup();
    paths
}

fn file_stamp(path: &Path) -> FileStamp {
    let metadata = std::fs::metadata(path).ok()?;
    Some((metadata.modified().ok()?, metadata.len()))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use std::fs;

    fn key_for(cwd: &Path, stored_revision: &str) -> RevisionKey {
        RevisionKey::new(&HashMap::new(), &[], cwd, stored_revision)
    }

    /// Writes `path` and pins its mtime, so tests never depend on how the
    /// filesystem clock relates to `SystemTime::now()`.
    fn write_layer(path: &Path, contents: &str, modified: SystemTime) {
        fs::write(path, contents).unwrap();
        fs::File::options()
            .write(true)
            .open(path)
            .unwrap()
            .set_modified(modified)
            .unwrap();
    }

    fn config_with_layer(file: &Path) -> Value {
        json!({ "config": {}, "layers": [{ "name": { "type": "user", "file": file } }] })
    }

    /// Stores a fingerprint for a single user layer whose mtime sits `offset`
    /// away from the probe start, and reports whether it was cached.
    fn cached_with_layer_mtime(name: &str, before: bool, offset: Duration) -> Option<String> {
        let dir = tempfile::tempdir().unwrap();
        let user_config = dir.path().join("config.toml");
        let key = key_for(dir.path(), name);
        let probe_started = SystemTime::now();
        let modified = if before {
            probe_started - offset
        } else {
            probe_started + offset
        };
        write_layer(&user_config, "model = \"a\"", modified);

        store(
            key.clone(),
            "rev-1".into(),
            &config_with_layer(&user_config),
            probe_started,
        );

        cached(&key)
    }

    const LONG_AGO: Duration = Duration::from_secs(3600);

    #[test]
    fn reuses_the_fingerprint_while_layer_files_are_unchanged() {
        assert_eq!(
            cached_with_layer_mtime("reuse", true, LONG_AGO).as_deref(),
            Some("rev-1")
        );
    }

    #[test]
    fn a_layer_edit_invalidates_the_fingerprint() {
        let dir = tempfile::tempdir().unwrap();
        let user_config = dir.path().join("config.toml");
        let probe_started = SystemTime::now();
        write_layer(&user_config, "model = \"a\"", probe_started - LONG_AGO);
        let key = key_for(dir.path(), "edit");
        store(
            key.clone(),
            "rev-1".into(),
            &config_with_layer(&user_config),
            probe_started,
        );
        assert_eq!(cached(&key).as_deref(), Some("rev-1"));

        fs::write(&user_config, "model = \"longer\"").unwrap();

        assert_eq!(cached(&key), None);
    }

    #[test]
    fn a_same_size_layer_edit_invalidates_the_fingerprint() {
        let dir = tempfile::tempdir().unwrap();
        let user_config = dir.path().join("config.toml");
        let probe_started = SystemTime::now();
        write_layer(&user_config, "model = \"a\"", probe_started - LONG_AGO);
        let key = key_for(dir.path(), "same-size");
        store(
            key.clone(),
            "rev-1".into(),
            &config_with_layer(&user_config),
            probe_started,
        );
        assert_eq!(cached(&key).as_deref(), Some("rev-1"));

        write_layer(&user_config, "model = \"b\"", probe_started - LONG_AGO / 2);

        assert_eq!(cached(&key), None);
    }

    #[test]
    fn a_new_project_layer_invalidates_the_fingerprint() {
        let dir = tempfile::tempdir().unwrap();
        let project = dir.path().join("repo");
        fs::create_dir_all(&project).unwrap();
        let key = key_for(&project, "project");
        store(
            key.clone(),
            "rev-1".into(),
            &json!({ "config": {}, "layers": [] }),
            SystemTime::now(),
        );
        assert_eq!(cached(&key).as_deref(), Some("rev-1"));

        fs::create_dir_all(dir.path().join(".codex")).unwrap();
        fs::write(dir.path().join(".codex").join("config.toml"), "x = 1").unwrap();

        assert_eq!(cached(&key), None);
    }

    #[test]
    fn a_layer_edited_during_the_probe_is_not_cached() {
        let dir = tempfile::tempdir().unwrap();
        let user_config = dir.path().join("config.toml");
        let key = key_for(dir.path(), "racy");
        let probe_started = SystemTime::now();
        fs::write(&user_config, "model = \"a\"").unwrap();

        store(
            key.clone(),
            "rev-1".into(),
            &config_with_layer(&user_config),
            probe_started,
        );

        assert_eq!(cached(&key), None);
    }

    #[test]
    fn a_layer_stamped_after_the_probe_started_is_not_cached() {
        assert_eq!(
            cached_with_layer_mtime("after", false, Duration::from_millis(1)),
            None
        );
    }

    /// Linux stamps mtimes from the coarse tick clock: a write right after
    /// the probe started can read a few milliseconds earlier than it.
    #[test]
    fn an_edit_behind_a_coarse_mtime_clock_is_not_cached() {
        assert_eq!(
            cached_with_layer_mtime("coarse-tick", true, Duration::from_millis(4)),
            None
        );
    }

    /// Second-granularity filesystems round a write down to the whole second.
    #[test]
    fn an_edit_rounded_down_to_the_second_is_not_cached() {
        assert_eq!(
            cached_with_layer_mtime("whole-second", true, Duration::from_millis(999)),
            None
        );
    }

    #[test]
    fn a_layer_older_than_the_mtime_granularity_is_cached() {
        let offset = MTIME_GRANULARITY + Duration::from_millis(1);
        assert_eq!(
            cached_with_layer_mtime("settled", true, offset).as_deref(),
            Some("rev-1")
        );
    }

    #[test]
    fn keys_ignore_env_ordering() {
        let cwd = Path::new("/tmp");
        let a = HashMap::from([("A".to_string(), "1".to_string()), ("B".into(), "2".into())]);
        let b = HashMap::from([("B".to_string(), "2".to_string()), ("A".into(), "1".into())]);
        assert_eq!(
            RevisionKey::new(&a, &["X".into(), "Y".into()], cwd, "r"),
            RevisionKey::new(&b, &["Y".into(), "X".into()], cwd, "r")
        );
    }
}
