//! An atomic rename that never replaces an existing destination
//! (`RENAME_NOREPLACE` on Linux, `RENAME_EXCL` on macOS).
#[cfg(unix)]
use std::ffi::CString;
use std::path::Path;

#[cfg(unix)]
fn path_c_string(path: &Path) -> std::io::Result<CString> {
    use std::os::unix::ffi::OsStrExt;

    CString::new(path.as_os_str().as_bytes())
        .map_err(|_| std::io::Error::from(std::io::ErrorKind::InvalidInput))
}

/// Atomically rename without replacing an existing destination.
pub fn rename_no_replace(source: &Path, destination: &Path) -> std::io::Result<()> {
    #[cfg(any(target_os = "linux", target_os = "android"))]
    {
        let source = path_c_string(source)?;
        let destination = path_c_string(destination)?;
        // SAFETY: both pointers come from live `CString` values and remain
        // valid for the duration of the call.
        let result = unsafe {
            libc::renameat2(
                libc::AT_FDCWD,
                source.as_ptr(),
                libc::AT_FDCWD,
                destination.as_ptr(),
                libc::RENAME_NOREPLACE,
            )
        };
        if result == 0 {
            Ok(())
        } else {
            Err(std::io::Error::last_os_error())
        }
    }
    #[cfg(any(target_os = "macos", target_os = "ios"))]
    {
        let source = path_c_string(source)?;
        let destination = path_c_string(destination)?;
        // SAFETY: both pointers come from live `CString` values and remain
        // valid for the duration of the call.
        let result =
            unsafe { libc::renamex_np(source.as_ptr(), destination.as_ptr(), libc::RENAME_EXCL) };
        if result == 0 {
            Ok(())
        } else {
            Err(std::io::Error::last_os_error())
        }
    }
    #[cfg(windows)]
    {
        std::fs::rename(source, destination)
    }
    #[cfg(all(
        unix,
        not(any(
            target_os = "linux",
            target_os = "android",
            target_os = "macos",
            target_os = "ios"
        ))
    ))]
    {
        let _ = (source, destination);
        Err(std::io::Error::new(
            std::io::ErrorKind::Unsupported,
            "atomic no-replace rename is unsupported on this platform",
        ))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rename_no_replace_preserves_existing_destination() {
        let dir = tempfile::tempdir().unwrap();
        let source = dir.path().join("source");
        let destination = dir.path().join("destination");
        std::fs::write(&source, "source").unwrap();
        std::fs::write(&destination, "destination").unwrap();

        let error = rename_no_replace(&source, &destination).unwrap_err();
        assert_eq!(error.kind(), std::io::ErrorKind::AlreadyExists);
        assert_eq!(std::fs::read_to_string(&source).unwrap(), "source");
        assert_eq!(
            std::fs::read_to_string(&destination).unwrap(),
            "destination"
        );
    }
}
