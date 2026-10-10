//! Dev-only `.env` loading and validation for the HTTP server entrypoint.
//! Release binaries never touch a `.env` (see `main`), so this is debug-build
//! scaffolding: it loads `packages/service/.env` and fails fast if a required
//! key is missing, which is the usual "I forgot to copy `.env.example`" case.

use std::path::{Path, PathBuf};

pub const SERVICE_DOTENV_DISPLAY_PATH: &str = "packages/service/.env";
pub const SERVICE_DOTENV_EXAMPLE_PATH: &str = "packages/service/.env.example";
pub const REQUIRED_DEV_ENV_KEYS: [&str; 4] = [
    "CADENCR_DB_PATH",
    "CADENCR_RUST_PORT",
    "CADENCR_FRONTEND_PORT",
    "CADENCR_AUTH_TOKEN",
];

fn service_dotenv_path(manifest_dir: impl AsRef<Path>) -> PathBuf {
    manifest_dir.as_ref().join(".env")
}

pub fn load_optional_package_dotenv(
    manifest_dir: impl AsRef<Path>,
) -> anyhow::Result<Option<PathBuf>> {
    let dotenv_path = service_dotenv_path(manifest_dir);
    if !dotenv_path.is_file() {
        return Ok(None);
    }

    // `from_path_override` so a parent process leaking CADENCR_* vars (the
    // most common case: an in-app agent shell running `cargo run` from a
    // worktree) cannot shadow the dev defaults declared in `.env`.
    dotenvy::from_path_override(&dotenv_path).map_err(|error| {
        anyhow::anyhow!("Failed to load `{SERVICE_DOTENV_DISPLAY_PATH}`: {error}")
    })?;

    Ok(Some(dotenv_path))
}

pub fn require_dev_env_file(dotenv_path: Option<PathBuf>) -> anyhow::Result<PathBuf> {
    dotenv_path.ok_or_else(|| {
        anyhow::anyhow!(
            "Missing required dev env file `{SERVICE_DOTENV_DISPLAY_PATH}`. Copy \
             `{SERVICE_DOTENV_EXAMPLE_PATH}` to `{SERVICE_DOTENV_DISPLAY_PATH}`."
        )
    })
}

pub fn validate_required_env_keys(
    display_path: &str,
    required_keys: &[&str],
) -> anyhow::Result<()> {
    let missing = required_keys
        .iter()
        .copied()
        .filter(|key| {
            std::env::var(key)
                .ok()
                .is_none_or(|value| value.trim().is_empty())
        })
        .collect::<Vec<_>>();

    if missing.is_empty() {
        return Ok(());
    }

    anyhow::bail!(
        "Missing required keys in `{display_path}`: {}.",
        missing.join(", ")
    )
}

/// Suffix of the marker `pnpm dev:configure-worktree` writes next to a database
/// it has just cloned (copy-on-write) from the main checkout. Until the service
/// has started once on it, that clone holds only data the main checkout still
/// has, so a pre-migration `VACUUM INTO` snapshot would be a full, unshared
/// copy (several GB) protecting nothing. Mirrors `FRESH_CLONE_MARKER` in
/// scripts/configure-worktree-dev.mts.
pub const FRESH_CLONE_MARKER_SUFFIX: &str = ".fresh-clone";

fn fresh_clone_marker(db_path: &Path) -> PathBuf {
    let mut marker = db_path.as_os_str().to_owned();
    marker.push(FRESH_CLONE_MARKER_SUFFIX);
    PathBuf::from(marker)
}

/// Whether to skip the pre-migration backup. Never in release builds: the
/// packaged app always refuses to migrate without a backup.
fn skip_db_backup(debug_build: bool, fresh_clone: bool) -> bool {
    debug_build && fresh_clone
}

/// The database file to back up before migrating, or `None` for a dev
/// database that is still an untouched worktree clone.
pub fn migration_backup_path(db_path: &Path) -> Option<&Path> {
    let marker = fresh_clone_marker(db_path);
    if skip_db_backup(cfg!(debug_assertions), marker.is_file()) {
        tracing::warn!(
            "{}: untouched clone of the main checkout's database, skipping this start's \
             pre-migration backup",
            marker.display()
        );
        return None;
    }
    Some(db_path)
}

/// Run once migrations succeeded: from then on the database may hold data only
/// this worktree has, so every later migration backs it up.
pub fn consume_fresh_clone_marker(db_path: &Path) -> anyhow::Result<()> {
    if !cfg!(debug_assertions) {
        return Ok(());
    }
    let marker = fresh_clone_marker(db_path);
    match std::fs::remove_file(&marker) {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(anyhow::anyhow!(
            "Failed to remove `{}`; delete it by hand so later migrations back up: {error}",
            marker.display()
        )),
    }
}

#[cfg(test)]
mod tests {
    use super::{
        consume_fresh_clone_marker, fresh_clone_marker, load_optional_package_dotenv,
        migration_backup_path, require_dev_env_file, service_dotenv_path, skip_db_backup,
        validate_required_env_keys, REQUIRED_DEV_ENV_KEYS, SERVICE_DOTENV_DISPLAY_PATH,
    };
    // The crate-wide lock: other lib tests set CADENCR_AUTH_TOKEN too.
    use crate::shared::test_env::env_lock;
    use std::fs;
    use tempfile::tempdir;

    fn clear_env(keys: &[&str]) {
        for key in keys {
            std::env::remove_var(key);
        }
    }

    #[test]
    fn package_dotenv_loads_only_manifest_dir() {
        let _guard = env_lock().lock().unwrap();
        let workspace = tempdir().unwrap();
        let manifest_dir = workspace.path().join("service");
        let env_path = service_dotenv_path(&manifest_dir);

        std::env::remove_var("SERVICE_TEST_ONLY");
        fs::create_dir(&manifest_dir).unwrap();

        assert_eq!(load_optional_package_dotenv(&manifest_dir).unwrap(), None);

        fs::write(&env_path, "SERVICE_TEST_ONLY=loaded-from-manifest\n").unwrap();

        let loaded = load_optional_package_dotenv(&manifest_dir).unwrap();

        assert_eq!(loaded, Some(env_path));
        assert_eq!(
            std::env::var("SERVICE_TEST_ONLY").unwrap(),
            "loaded-from-manifest"
        );

        std::env::remove_var("SERVICE_TEST_ONLY");
    }

    #[test]
    fn missing_dev_env_file_is_fatal() {
        let error = require_dev_env_file(None).unwrap_err();

        assert!(error.to_string().contains("packages/service/.env"));
    }

    #[test]
    fn missing_required_local_keys_are_fatal() {
        let _guard = env_lock().lock().unwrap();
        let workspace = tempdir().unwrap();
        let manifest_dir = workspace.path().join("service");
        let env_path = service_dotenv_path(&manifest_dir);
        fs::create_dir(&manifest_dir).unwrap();
        clear_env(&REQUIRED_DEV_ENV_KEYS);
        fs::write(
            &env_path,
            "CADENCR_DB_PATH=./cadencr.local.db\nCADENCR_RUST_PORT=5005\nCADENCR_AUTH_TOKEN=\n",
        )
        .unwrap();
        load_optional_package_dotenv(&manifest_dir).unwrap();

        let error = validate_required_env_keys(SERVICE_DOTENV_DISPLAY_PATH, &REQUIRED_DEV_ENV_KEYS)
            .unwrap_err();

        let message = error.to_string();
        assert!(message.contains("CADENCR_FRONTEND_PORT"));
        assert!(message.contains("CADENCR_AUTH_TOKEN"));
        clear_env(&REQUIRED_DEV_ENV_KEYS);
    }

    #[test]
    fn skips_backup_only_for_a_fresh_clone_in_debug_builds() {
        assert!(skip_db_backup(true, true));
        assert!(
            !skip_db_backup(false, true),
            "release builds always back up"
        );
        assert!(!skip_db_backup(true, false));
    }

    // Release builds never skip (see the truth table above).
    #[cfg(debug_assertions)]
    #[test]
    fn fresh_clone_marker_skips_one_start_then_backups_resume() {
        let dir = tempdir().unwrap();
        let db_path = dir.path().join("cadencr.local.db");
        let marker = fresh_clone_marker(&db_path);
        assert_eq!(marker, dir.path().join("cadencr.local.db.fresh-clone"));

        assert_eq!(migration_backup_path(&db_path), Some(db_path.as_path()));
        fs::write(&marker, "fresh").unwrap();
        assert_eq!(migration_backup_path(&db_path), None);

        consume_fresh_clone_marker(&db_path).unwrap();
        assert!(!marker.exists());
        assert_eq!(migration_backup_path(&db_path), Some(db_path.as_path()));
        consume_fresh_clone_marker(&db_path).unwrap();
    }
}
