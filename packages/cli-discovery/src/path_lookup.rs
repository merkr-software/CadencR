//! Resolve a bare program name on `PATH`, as a shell would, without a shell.
//!
//! On Windows each `PATHEXT` extension is tried in order.

use std::ffi::OsString;
use std::path::PathBuf;

use crate::walk::is_executable;

/// The first executable file named `program` in an absolute `PATH` entry.
/// `program` must be a bare file name; anything holding a separator is refused.
/// Callers that need the user's Terminal `PATH` set it first (the service runs
/// with its login-shell `PATH`).
pub fn find_on_path(program: &str) -> Option<PathBuf> {
    find_in(program, &std::env::var_os("PATH")?)
}

fn find_in(program: &str, path: &OsString) -> Option<PathBuf> {
    if program.is_empty() || program.contains(['/', '\\']) {
        return None;
    }
    let names = candidate_names(program);
    std::env::split_paths(path)
        .filter(|dir| dir.is_absolute())
        .flat_map(|dir| names.iter().map(move |name| dir.join(name)))
        .find(|candidate| is_executable(candidate))
}

#[cfg(windows)]
fn candidate_names(program: &str) -> Vec<String> {
    let extensions = std::env::var("PATHEXT").unwrap_or_else(|_| ".COM;.EXE;.BAT;.CMD".into());
    let mut names = vec![program.to_string()];
    names.extend(
        extensions
            .split(';')
            .filter(|extension| !extension.is_empty())
            .map(|extension| format!("{program}{extension}")),
    );
    names
}

#[cfg(not(windows))]
fn candidate_names(program: &str) -> Vec<String> {
    vec![program.to_string()]
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;
    use std::os::unix::fs::PermissionsExt;

    #[test]
    fn finds_the_first_executable_and_refuses_paths() {
        let first = tempfile::tempdir().unwrap();
        let second = tempfile::tempdir().unwrap();
        std::fs::write(first.path().join("tool"), "x").unwrap();
        let executable = second.path().join("tool");
        std::fs::write(&executable, "x").unwrap();
        std::fs::set_permissions(&executable, std::fs::Permissions::from_mode(0o755)).unwrap();
        let path = std::env::join_paths([
            "relative",
            first.path().to_str().unwrap(),
            second.path().to_str().unwrap(),
        ])
        .unwrap();
        assert_eq!(find_in("tool", &path), Some(executable));
        assert_eq!(find_in("missing", &path), None);
        assert_eq!(find_in("../tool", &path), None);
        assert_eq!(find_in("", &path), None);
    }
}
