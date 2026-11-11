use crate::error::AppError;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/// Reject names that contain path separators or traversal segments. The new
/// name is always a single path component — the caller chooses the parent.
pub(super) fn validate_simple_name(name: &str) -> Result<(), AppError> {
    if name.is_empty() {
        return Err(AppError::BadRequest("Name cannot be empty".to_string()));
    }
    if name.contains('/') || name.contains('\\') || name == "." || name == ".." {
        return Err(AppError::BadRequest(
            "Name must be a single path component".to_string(),
        ));
    }
    Ok(())
}

pub(super) use crate::shared::no_replace_rename::rename_no_replace;

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    pub(super) fn validate_simple_name_rejects_separators_and_traversal() {
        assert!(validate_simple_name("foo.txt").is_ok());
        assert!(validate_simple_name("").is_err());
        assert!(validate_simple_name("a/b").is_err());
        assert!(validate_simple_name("a\\b").is_err());
        assert!(validate_simple_name("..").is_err());
        assert!(validate_simple_name(".").is_err());
    }

    #[test]
    fn rename_no_replace_moves_file_and_directory() {
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("file");
        let moved_file = dir.path().join("moved-file");
        std::fs::write(&file, "content").unwrap();
        rename_no_replace(&file, &moved_file).unwrap();
        assert_eq!(std::fs::read_to_string(&moved_file).unwrap(), "content");

        let folder = dir.path().join("folder");
        let moved_folder = dir.path().join("moved-folder");
        std::fs::create_dir(&folder).unwrap();
        std::fs::write(folder.join("nested"), "content").unwrap();
        rename_no_replace(&folder, &moved_folder).unwrap();
        assert_eq!(
            std::fs::read_to_string(moved_folder.join("nested")).unwrap(),
            "content"
        );
    }
}
