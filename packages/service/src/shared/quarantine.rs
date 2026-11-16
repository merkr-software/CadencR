//! macOS Gatekeeper's download mark: an executable written by Cadencr from a
//! verified archive must not carry `com.apple.quarantine`, or its first launch
//! is blocked by an assessment prompt the user cannot see from a tab.

use std::path::Path;

/// Remove `com.apple.quarantine` from `path` itself (never a symlink's
/// target). An absent attribute is success; elsewhere than macOS a no-op.
#[cfg(target_os = "macos")]
pub fn strip(path: &Path) -> std::io::Result<()> {
    use std::os::unix::ffi::OsStrExt as _;
    let path = std::ffi::CString::new(path.as_os_str().as_bytes())
        .map_err(|error| std::io::Error::new(std::io::ErrorKind::InvalidInput, error))?;
    // SAFETY: both pointers are NUL-terminated strings that outlive the call.
    let result = unsafe {
        libc::removexattr(
            path.as_ptr(),
            c"com.apple.quarantine".as_ptr(),
            libc::XATTR_NOFOLLOW,
        )
    };
    if result == 0 {
        return Ok(());
    }
    let error = std::io::Error::last_os_error();
    if error.raw_os_error() == Some(libc::ENOATTR) {
        return Ok(());
    }
    Err(error)
}

#[cfg(not(target_os = "macos"))]
pub fn strip(_path: &Path) -> std::io::Result<()> {
    Ok(())
}

#[cfg(all(test, target_os = "macos"))]
mod tests {
    use super::*;

    #[test]
    fn strips_the_mark_and_accepts_files_without_one() {
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join("tool");
        std::fs::write(&path, b"x").unwrap();
        strip(&path).unwrap();
        let status = std::process::Command::new("xattr")
            .args(["-w", "com.apple.quarantine", "0081;00000000;Test;"])
            .arg(&path)
            .status()
            .unwrap();
        assert!(status.success());
        strip(&path).unwrap();
        let listed = std::process::Command::new("xattr")
            .arg(&path)
            .output()
            .unwrap();
        assert!(!String::from_utf8_lossy(&listed.stdout).contains("quarantine"));
        assert!(strip(&temp.path().join("missing")).is_err());
    }
}
