//! POSIX locks are process-wide: inspecting them from another process catches
//! accidental closes of SQLite's files that same-process queries cannot detect.
#![cfg(unix)]

use cadencr_service::shared::db::{create_read_pool, create_write_pool};
use std::os::fd::AsRawFd;
use std::os::unix::fs::PermissionsExt;
use std::path::Path;
use std::process::Command;

#[test]
fn lock_probe_child() {
    let Some(path) = std::env::var_os("CADENCR_TEST_LOCK_PATH") else {
        return;
    };
    let owner: libc::pid_t = std::env::var("CADENCR_TEST_LOCK_OWNER")
        .unwrap()
        .parse()
        .unwrap();
    let path = Path::new(&path);
    // SQLite's database SHARED_FIRST and WAL write / dead-man-switch bytes.
    assert_lock(path, 1_073_741_826, owner);
    let mut shm = path.as_os_str().to_owned();
    shm.push("-shm");
    assert_lock(Path::new(&shm), 120, owner);
    assert_lock(Path::new(&shm), 128, owner);
}

fn assert_lock(path: &Path, offset: libc::off_t, owner: libc::pid_t) {
    let file = std::fs::File::open(path).unwrap();
    // SAFETY: flock contains only integer fields; every field used by F_GETLK
    // is initialized below. F_GETLK inspects locks without acquiring any.
    let mut lock: libc::flock = unsafe { std::mem::zeroed() };
    lock.l_type = libc::F_WRLCK as _;
    lock.l_whence = libc::SEEK_SET as _;
    lock.l_start = offset;
    lock.l_len = 1;
    // SAFETY: the descriptor is live and lock points to a valid flock.
    assert_ne!(
        unsafe { libc::fcntl(file.as_raw_fd(), libc::F_GETLK, &mut lock) },
        -1
    );
    assert_ne!(
        lock.l_type,
        libc::F_UNLCK as libc::c_short,
        "SQLite lock at {offset} was lost"
    );
    assert_eq!(
        lock.l_pid, owner,
        "lock must still belong to the parent SQLite process"
    );
}

fn assert_sqlite_locks(path: &Path) {
    let output = Command::new(std::env::current_exe().unwrap())
        .args(["--exact", "lock_probe_child", "--nocapture"])
        .env("CADENCR_TEST_LOCK_PATH", path)
        .env("CADENCR_TEST_LOCK_OWNER", std::process::id().to_string())
        .output()
        .unwrap();
    assert!(
        output.status.success(),
        "{}\n{}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    );
}

#[tokio::test]
async fn opening_more_pools_preserves_sqlite_locks() {
    // Retain all database artifacts, including after a failed assertion.
    let dir = tempfile::tempdir().unwrap().keep();
    let path = dir.join("locks.db");
    let db_path = path.to_str().unwrap();
    let writer = create_write_pool(db_path).await.unwrap();
    sqlx::query("CREATE TABLE entries (value TEXT)")
        .execute(&writer)
        .await
        .unwrap();
    let mut transaction = writer.begin().await.unwrap();
    sqlx::query("INSERT INTO entries VALUES ('uncommitted')")
        .execute(&mut *transaction)
        .await
        .unwrap();
    assert_sqlite_locks(&path);

    // Exercise both the metadata-only and permission-tightening paths.
    for tighten in [false, true] {
        if tighten {
            for name in ["locks.db", "locks.db-wal", "locks.db-shm"] {
                std::fs::set_permissions(dir.join(name), std::fs::Permissions::from_mode(0o644))
                    .unwrap();
            }
        }
        let reader = create_read_pool(db_path).await.unwrap();
        assert_sqlite_locks(&path);
        let other_writer = create_write_pool(db_path).await.unwrap();
        assert_sqlite_locks(&path);
        let count: i64 = sqlx::query_scalar("SELECT count(*) FROM entries")
            .fetch_one(&reader)
            .await
            .unwrap();
        assert_eq!(count, 0, "readers cannot see the uncommitted write");
        for name in ["locks.db", "locks.db-wal", "locks.db-shm"] {
            assert_eq!(
                std::fs::metadata(dir.join(name))
                    .unwrap()
                    .permissions()
                    .mode()
                    & 0o777,
                0o600
            );
        }
        reader.close().await;
        other_writer.close().await;
        assert_sqlite_locks(&path);
    }
    transaction.commit().await.unwrap();
    writer.close().await;
}

#[tokio::test]
async fn rejecting_a_hard_link_preserves_sqlite_locks() {
    let dir = tempfile::tempdir().unwrap().keep();
    let path = dir.join("locks.db");
    let writer = create_write_pool(path.to_str().unwrap()).await.unwrap();
    sqlx::query("CREATE TABLE entries (value TEXT)")
        .execute(&writer)
        .await
        .unwrap();
    let mut transaction = writer.begin().await.unwrap();
    sqlx::query("INSERT INTO entries VALUES ('uncommitted')")
        .execute(&mut *transaction)
        .await
        .unwrap();
    assert_sqlite_locks(&path);
    let alias = dir.join("alias.db");
    std::fs::hard_link(&path, &alias).unwrap();
    assert!(create_read_pool(alias.to_str().unwrap()).await.is_err());
    assert_sqlite_locks(&path);
    transaction.commit().await.unwrap();
    writer.close().await;
}
