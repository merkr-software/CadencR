#![cfg(any(target_os = "macos", target_os = "linux"))]

use std::fs;
use std::os::unix::fs::{MetadataExt, PermissionsExt};
use std::path::Path;
use std::process::Command;

use cadencr_service::shared::file_digest::sha256_hex;
use uuid::Uuid;

fn write_private(path: &Path, bytes: &[u8]) {
    fs::write(path, bytes).unwrap();
    fs::set_permissions(path, fs::Permissions::from_mode(0o600)).unwrap();
}

fn recovery_key(database: &Path) -> String {
    // Reconstruct what the desktop service left on disk. The binary must
    // validate the manifest for the actual file behind the supplied path.
    let metadata = fs::metadata(database).unwrap();
    let mut key = database.as_os_str().as_encoded_bytes().to_owned();
    key.push(0);
    key.extend_from_slice(&metadata.ino().to_le_bytes());
    if let Ok(Ok(created)) = metadata
        .created()
        .map(|time| time.duration_since(std::time::UNIX_EPOCH))
    {
        key.extend_from_slice(&created.as_nanos().to_le_bytes());
    }
    sha256_hex(&key)
}

#[test]
fn the_installed_cleanup_mode_succeeds_without_starting_the_service_or_consuming_quit() {
    let root = tempfile::tempdir().unwrap();
    let db_dir = root.path().join("database");
    fs::create_dir(&db_dir).unwrap();
    let database = db_dir.join("work.db");
    let original = b"fixture contents that cannot be opened as SQLite";
    fs::write(&database, original).unwrap();
    let database = fs::canonicalize(database).unwrap();
    let recovery = root.path().join("desktop-recovery");
    fs::create_dir(&recovery).unwrap();
    let epoch = Uuid::new_v4();
    let key = recovery_key(&database);
    let current = recovery.join(format!("{key}.current"));
    write_private(&current, epoch.to_string().as_bytes());
    let quit = recovery.join(format!("{epoch}.quit"));
    write_private(&quit, b"");
    let receipt = recovery.join(format!("{key}.{epoch}.stopped"));
    let settings = root.path().join("must-not-create-settings");
    let run = |epoch: Uuid| {
        Command::new(env!("CARGO_BIN_EXE_cadencr-service"))
            .arg("--internal-desktop-quit-cleanup")
            .arg(&database)
            .arg(epoch.to_string())
            .env_clear()
            .env("CADENCR_SETTINGS_DIR", &settings)
            .env("CADENCR_DB_PATH", root.path().join("wrong.db"))
            .env("CADENCR_RUST_PORT", "invalid-for-service-startup")
            .current_dir(root.path())
            .output()
            .unwrap()
    };

    let refused = run(Uuid::new_v4());
    assert!(!refused.status.success());
    assert!(!receipt.exists());

    let journal = database
        .parent()
        .unwrap()
        .join(format!(".cadencr-processes-{key}"));
    fs::create_dir(&journal).unwrap();
    let ambiguous = journal.join("unknown.json");
    write_private(&ambiguous, b"unrecognizable ownership evidence");
    let refused = run(epoch);
    assert!(!refused.status.success());
    assert!(String::from_utf8_lossy(&refused.stderr).contains("invalid process journal identifier"));
    assert!(quit.is_file() && ambiguous.is_file() && !receipt.exists());
    fs::remove_file(&ambiguous).unwrap();

    for _ in 0..2 {
        let result = run(epoch);
        assert!(
            result.status.success(),
            "{}",
            String::from_utf8_lossy(&result.stderr)
        );
    }
    assert_eq!(fs::read_to_string(&current).unwrap(), epoch.to_string());
    assert_eq!(fs::read_to_string(&receipt).unwrap(), epoch.to_string());
    assert!(quit.is_file());
    assert!(!settings.exists());
    assert!(!root.path().join("wrong.db").exists());
    assert_eq!(fs::read(&database).unwrap(), original);
}
