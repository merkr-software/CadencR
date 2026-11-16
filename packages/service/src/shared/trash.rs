//! Deleting user content by moving it to the OS trash.
//!
//! Nothing the user made is removed irreversibly: a file they deleted from the
//! tree, a theme they deleted from the gallery — both are recoverable from the
//! trash, which is the behavior every other app on their machine has taught
//! them to expect.

use std::path::{Path, PathBuf};

use crate::error::AppError;

/// Move a path to the OS trash, off the async runtime.
///
/// Unit tests delete outright instead (the `cfg(test)` `delete_blocking`): they work in
/// per-test temp directories, and filling the developer's Trash with them on
/// every `cargo test` — in an environment that may have no trash at all —
/// tests the OS, not us.
pub async fn move_to_trash(path: &Path) -> Result<(), AppError> {
    let owned: PathBuf = path.to_path_buf();
    tokio::task::spawn_blocking(move || delete_blocking(&owned))
        .await
        .map_err(|e| AppError::internal(format!("Blocking task failed: {e}")))?
}

#[cfg(not(test))]
fn delete_blocking(path: &Path) -> Result<(), AppError> {
    move_to_trash_blocking(path).map_err(|e| AppError::internal(format!("Trash failed: {e}")))
}

#[cfg(test)]
fn delete_blocking(path: &Path) -> Result<(), AppError> {
    let removed = if path.is_dir() {
        std::fs::remove_dir_all(path)
    } else {
        std::fs::remove_file(path)
    };
    removed.map_err(|e| AppError::internal(format!("failed to delete {}: {e}", path.display())))
}

/// On macOS we explicitly use `NSFileManager` rather than the default `Finder`
/// (AppleScript) backend, because Finder requires the
/// `com.apple.security.automation.apple-events` entitlement (granted via TCC
/// prompt or a signed/notarized bundle). Unsigned dev builds otherwise fail
/// with `errAEEventNotPermitted (-1743)`.
#[cfg(not(test))]
fn move_to_trash_blocking(path: &Path) -> Result<(), trash::Error> {
    #[cfg(target_os = "macos")]
    {
        use trash::macos::{DeleteMethod, TrashContextExtMacos};
        let mut ctx = trash::TrashContext::default();
        ctx.set_delete_method(DeleteMethod::NsFileManager);
        ctx.delete(path)
    }
    #[cfg(not(target_os = "macos"))]
    {
        trash::delete(path)
    }
}
