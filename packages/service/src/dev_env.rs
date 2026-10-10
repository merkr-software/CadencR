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

/// Dev-only opt-out of the pre-migration backup. `pnpm dev:configure-worktree`
/// sets it only when it has just cloned the main checkout's database
/// (copy-on-write) into the worktree: a `VACUUM INTO` snapshot of that clone is
/// a full, unshared copy (several GB) of data the main checkout still holds.
pub const SKIP_DB_BACKUP_ENV: &str = "CADENCR_DEV_SKIP_DB_BACKUP";

/// Whether to skip the pre-migration backup. Never in release builds: the
/// packaged app always refuses to migrate without a backup.
pub fn skip_db_backup(debug_build: bool, value: Option<&str>) -> bool {
    debug_build && value.is_some_and(|value| value.trim() == "1")
}

/// The database file to back up before migrating, or `None` when this dev
/// checkout opted out via [`SKIP_DB_BACKUP_ENV`].
pub fn migration_backup_path(db_path: &Path) -> Option<&Path> {
    let value = std::env::var(SKIP_DB_BACKUP_ENV).ok();
    if skip_db_backup(cfg!(debug_assertions), value.as_deref()) {
        tracing::warn!(
            "{SKIP_DB_BACKUP_ENV}=1: pre-migration backups are disabled for this dev database"
        );
        return None;
    }
    Some(db_path)
}

#[cfg(test)]
mod tests {
    use super::{
        load_optional_package_dotenv, require_dev_env_file, service_dotenv_path, skip_db_backup,
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
    fn skips_backup_only_in_debug_builds_with_explicit_opt_in() {
        assert!(skip_db_backup(true, Some("1")));
        assert!(skip_db_backup(true, Some(" 1\n")));
        assert!(
            !skip_db_backup(false, Some("1")),
            "release builds always back up"
        );
        assert!(!skip_db_backup(true, None));
        assert!(!skip_db_backup(true, Some("0")));
        assert!(!skip_db_backup(true, Some("true")));
    }
}
