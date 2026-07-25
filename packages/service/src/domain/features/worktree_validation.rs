use crate::error::AppError;

/// Validate `worktree_mode` against the allowed set and enforce the
/// `reuse -> reuse_branch required` invariant. Returns the trimmed mode and
/// the trimmed reuse branch when applicable.
pub(crate) fn validate_worktree_mode(
    mode: &Option<String>,
    reuse_branch: &Option<String>,
) -> Result<(Option<String>, Option<String>), AppError> {
    let Some(mode) = mode.as_deref().map(str::trim).filter(|s| !s.is_empty()) else {
        return Ok((None, None));
    };
    if !matches!(mode, "new" | "reuse" | "skip") {
        return Err(AppError::BadRequest(format!(
            "worktree_mode must be one of 'new', 'reuse', 'skip' — got {mode:?}"
        )));
    }
    let branch = if mode == "reuse" {
        let Some(branch) = reuse_branch
            .as_deref()
            .map(str::trim)
            .filter(|s| !s.is_empty())
        else {
            return Err(AppError::BadRequest(
                "reuse_branch is required when worktree_mode is 'reuse'".into(),
            ));
        };
        Some(validate_reuse_branch(branch)?)
    } else {
        None
    };
    Ok((Some(mode.to_string()), branch))
}

pub(crate) fn validate_reuse_branch(branch: &str) -> Result<String, AppError> {
    let branch = branch.trim();
    if branch.is_empty() {
        return Err(AppError::BadRequest(
            "reuse_branch must not be blank".into(),
        ));
    }
    if branch.starts_with('-') {
        return Err(AppError::BadRequest(
            "reuse_branch must not start with '-'".into(),
        ));
    }
    if !is_valid_branch_name(branch) {
        return Err(AppError::BadRequest(format!(
            "reuse_branch is not a valid branch name: {branch:?}"
        )));
    }
    Ok(branch.to_string())
}

fn is_valid_branch_name(branch: &str) -> bool {
    if branch == "@" || branch.ends_with('/') || branch.ends_with('.') || branch.ends_with(".lock")
    {
        return false;
    }
    if branch.contains("..") || branch.contains("@{") || branch.contains("//") {
        return false;
    }
    if branch
        .chars()
        .any(|c| c.is_ascii_control() || c.is_ascii_whitespace() || "\\:?[~^*".contains(c))
    {
        return false;
    }
    branch
        .split('/')
        .all(|part| !part.is_empty() && part != "." && part != ".." && !part.starts_with('.'))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn validate_worktree_mode_accepts_unset() {
        let out = validate_worktree_mode(&None, &None).unwrap();
        assert_eq!(out, (None, None));
    }

    #[test]
    fn validate_worktree_mode_accepts_new_and_skip() {
        assert_eq!(
            validate_worktree_mode(&Some("new".into()), &None).unwrap(),
            (Some("new".into()), None)
        );
        assert_eq!(
            validate_worktree_mode(&Some("skip".into()), &None).unwrap(),
            (Some("skip".into()), None)
        );
    }

    #[test]
    fn validate_worktree_mode_rejects_unknown_value() {
        let err = validate_worktree_mode(&Some("bogus".into()), &None).unwrap_err();
        assert!(matches!(err, AppError::BadRequest(_)), "{err:?}");
    }

    #[test]
    fn validate_worktree_mode_requires_branch_when_reuse() {
        let err = validate_worktree_mode(&Some("reuse".into()), &None).unwrap_err();
        assert!(matches!(err, AppError::BadRequest(_)), "{err:?}");
        let err = validate_worktree_mode(&Some("reuse".into()), &Some("   ".into())).unwrap_err();
        assert!(matches!(err, AppError::BadRequest(_)), "{err:?}");
    }

    #[test]
    fn validate_worktree_mode_rejects_flag_branch() {
        let err = validate_worktree_mode(&Some("reuse".into()), &Some("--upload-pack=evil".into()))
            .unwrap_err();
        assert!(matches!(err, AppError::BadRequest(_)), "{err:?}");
    }

    #[test]
    fn validate_worktree_mode_rejects_invalid_branch_names() {
        for branch in [
            "feat bad",
            "feat..bad",
            "feat/.bad",
            "feat.lock",
            "feat@{bad",
        ] {
            let err =
                validate_worktree_mode(&Some("reuse".into()), &Some(branch.into())).unwrap_err();
            assert!(matches!(err, AppError::BadRequest(_)), "{err:?}");
        }
    }

    #[test]
    fn validate_worktree_mode_accepts_reuse_with_branch() {
        let out = validate_worktree_mode(&Some("reuse".into()), &Some("feat/x".into())).unwrap();
        assert_eq!(out, (Some("reuse".into()), Some("feat/x".into())));
    }

    #[test]
    fn validate_worktree_mode_trims_reuse_branch() {
        let out =
            validate_worktree_mode(&Some(" reuse ".into()), &Some(" feat/x ".into())).unwrap();
        assert_eq!(out, (Some("reuse".into()), Some("feat/x".into())));
    }
}
