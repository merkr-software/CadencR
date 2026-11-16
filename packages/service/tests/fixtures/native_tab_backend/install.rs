//! The one native backend fixture every custom-tab test launches: the
//! protocol-speaking program in `backend.rs`, compiled once per source change
//! with `rustc` and hard-linked into tab folders.
//!
//! Why compiled at test time: a backend must now be a native executable
//! inside its tab folder (scripts and `PATH` programs are refused), and a
//! Cargo `[[bin]]` of the service would ship with — and be built by — every
//! service build, while being invisible to the lib's unit tests
//! (`CARGO_BIN_EXE_*` exists only for integration tests). One std-only file
//! and the `rustc` running the tests anyway keep production untouched and
//! serve unit and integration tests alike. The Rust linker ad-hoc signs its
//! arm64 output, so the fixture also passes the Apple-silicon signature check.
//!
//! Included with `#[path]` by `src/domain/plugin_tabs/backend.rs` (unit
//! tests) and `tests/plugin_tab_runtime_test.rs`; later tests (marketplace
//! installs) should reuse it the same way.

use std::path::{Path, PathBuf};
use std::sync::OnceLock;

const SOURCE: &str = include_str!("backend.rs");

/// Put the fixture at `dir/relative`, creating parents. Its behavior follows
/// the file name (see `backend.rs`): `silent`, `future`, `chatty`, `early`, `deaf`, or
/// anything else for the full protocol.
pub fn install(dir: &Path, relative: &str) -> PathBuf {
    let target = dir.join(relative);
    std::fs::create_dir_all(target.parent().expect("a file path")).expect("create bin dir");
    let built = built();
    // Never copy over an earlier link to the cache: `copy` onto the same inode
    // would truncate the cached build itself.
    match std::fs::remove_file(&target) {
        Ok(()) => {}
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
        Err(error) => panic!("cannot replace {}: {error}", target.display()),
    }
    // One inode for every copy: macOS assesses a new executable on its first
    // launch, which a fresh copy per test would pay again (and could push a
    // run past the 5 s `ready` deadline).
    if std::fs::hard_link(built, &target).is_err() {
        std::fs::copy(built, &target).expect("copy the native backend fixture");
    }
    target
}

fn built() -> &'static Path {
    static BUILT: OnceLock<PathBuf> = OnceLock::new();
    BUILT.get_or_init(build)
}

fn build() -> PathBuf {
    use std::hash::{Hash, Hasher};
    let mut hasher = std::collections::hash_map::DefaultHasher::new();
    SOURCE.hash(&mut hasher);
    let dir = std::env::temp_dir()
        .join("cadencr-native-tab-backend")
        .join(format!("{:016x}", hasher.finish()));
    let binary = dir.join("native-tab-backend");
    if binary.is_file() {
        return binary;
    }
    std::fs::create_dir_all(&dir).expect("create the fixture cache");
    let source = dir.join(format!("backend-{}.rs", std::process::id()));
    std::fs::write(&source, SOURCE).expect("write the fixture source");
    let partial = dir.join(format!("native-tab-backend-{}.partial", std::process::id()));
    let output = std::process::Command::new(rustc())
        .args([
            "--edition",
            "2021",
            "-C",
            "opt-level=1",
            "-C",
            "debuginfo=0",
        ])
        .args([
            "--crate-name",
            "native_tab_backend",
            "--crate-type",
            "bin",
            "-o",
        ])
        .arg(&partial)
        .arg(&source)
        .output()
        .expect("run rustc for the native backend fixture");
    assert!(
        output.status.success(),
        "the native backend fixture does not compile:\n{}",
        String::from_utf8_lossy(&output.stderr)
    );
    // Concurrent test processes may race here; the rename is atomic.
    std::fs::rename(&partial, &binary).expect("publish the fixture binary");
    let _ = std::fs::remove_file(&source);
    // Its first launch, outside any test deadline (see `install`).
    let warmed = std::process::Command::new(&binary)
        .stdin(std::process::Stdio::null())
        .status()
        .expect("run the native backend fixture");
    assert!(warmed.success(), "the fixture exits 0 when stdin closes");
    binary
}

/// The `rustc` of the toolchain running the tests.
fn rustc() -> PathBuf {
    if let Some(rustc) = std::env::var_os("RUSTC") {
        return rustc.into();
    }
    std::env::var_os("CARGO")
        .map(|cargo| PathBuf::from(cargo).with_file_name("rustc"))
        .filter(|rustc| rustc.is_file())
        .unwrap_or_else(|| "rustc".into())
}
