use std::ffi::OsString;
use std::sync::{Mutex, OnceLock};

pub fn env_lock() -> &'static Mutex<()> {
    static LOCK: OnceLock<Mutex<()>> = OnceLock::new();
    LOCK.get_or_init(|| Mutex::new(()))
}

pub fn async_env_lock() -> &'static tokio::sync::Mutex<()> {
    static LOCK: OnceLock<tokio::sync::Mutex<()>> = OnceLock::new();
    LOCK.get_or_init(|| tokio::sync::Mutex::new(()))
}

pub struct EnvVarGuard {
    key: &'static str,
    previous: Option<OsString>,
}

impl EnvVarGuard {
    pub fn set(key: &'static str, value: &str) -> Self {
        let previous = std::env::var_os(key);
        std::env::set_var(key, value);
        Self { key, previous }
    }

    pub fn remove(key: &'static str) -> Self {
        let previous = std::env::var_os(key);
        std::env::remove_var(key);
        Self { key, previous }
    }
}

impl Drop for EnvVarGuard {
    fn drop(&mut self) {
        match self.previous.as_ref() {
            Some(value) => std::env::set_var(self.key, value),
            None => std::env::remove_var(self.key),
        }
    }
}

const CHILD_MARKER: &str = "CADENCR_TEST_RERUN_CHILD";

/// Whether this process is the child [`rerun_in_child`] started.
pub fn is_rerun_child() -> bool {
    std::env::var_os(CHILD_MARKER).is_some()
}

/// Run the test at `test_path` (`concat!(module_path!(), "::name")`) again,
/// alone, in a child process with `envs` set and `removed` unset, and assert
/// it passed: for a test that needs process-wide state such as `HOME`.
pub fn rerun_in_child(test_path: &str, envs: &[(&str, &std::ffi::OsStr)], removed: &[&str]) {
    // Test names leave out the crate.
    let name = test_path
        .split_once("::")
        .map_or(test_path, |(_, name)| name);
    let mut command = std::process::Command::new(std::env::current_exe().unwrap());
    command
        .args(["--exact", name, "--nocapture"])
        .env(CHILD_MARKER, "1");
    for (key, value) in envs {
        command.env(key, value);
    }
    for key in removed {
        command.env_remove(key);
    }
    let output = command.output().expect("spawn the isolated test");
    let stdout = String::from_utf8_lossy(&output.stdout);
    assert!(
        output.status.success() && stdout.contains("1 passed"),
        "isolated test {name} failed:\n{stdout}\n{}",
        String::from_utf8_lossy(&output.stderr),
    );
}

/// A `HOME` whose `.gitconfig` points `core.excludesFile` at `patterns`.
pub fn home_with_global_excludes(patterns: &str) -> tempfile::TempDir {
    let home = tempfile::tempdir().unwrap();
    let excludes = home.path().join("global-excludes");
    std::fs::write(&excludes, patterns).unwrap();
    std::fs::write(
        home.path().join(".gitconfig"),
        format!("[core]\n\texcludesFile = {}\n", excludes.display()),
    )
    .unwrap();
    home
}
