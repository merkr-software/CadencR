//! Git refusals: git ran and declined the operation (dirty tree, conflict,
//! unknown branch, rejected push…). Its stderr is git's message *to the user*
//! — paths redacted or home-scrubbed by `shared::git_cli` — so it is
//! returned verbatim with a 4xx status and a stable code. Failures to run git
//! at all (spawn, PTY, unexpected output) stay `AppError::GitCommandError`
//! and are masked as 500s.
//!
//! The specific codes are recognized from git's English wording. Captured git
//! always prints it: `shared::git_cli::git_command` forces untranslated
//! messages whatever the user's locale. Any wording not listed here still
//! lands on the generic `GIT_COMMAND_FAILED` with its message, never on a
//! masked 500.

use axum::http::StatusCode;

/// Why git refused the operation. Classification is a best-effort refinement
/// of the always-available [`GitFailureKind::CommandFailed`].
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum GitFailureKind {
    /// A merge, rebase, cherry-pick or stash apply stopped on conflicts.
    MergeConflict,
    /// Local changes would be overwritten (checkout, merge, pull, rebase).
    LocalChangesConflict,
    /// The remote refused the pushed refs (non-fast-forward, hook…).
    PushRejected,
    /// Another git process holds a repository lock file.
    RepositoryLocked,
    /// The branch is checked out in another worktree.
    BranchInUse,
    /// A branch, tag, worktree path or destination already exists.
    AlreadyExists,
    /// A branch, revision or remote ref could not be resolved.
    RefNotFound,
    /// Any other refusal; the message is still git's own.
    CommandFailed,
}

/// Lowercased fragments of git's English messages, checked in order: the
/// first matching kind wins, so the more specific signatures come first.
const SIGNATURES: &[(GitFailureKind, &[&str])] = &[
    (
        GitFailureKind::MergeConflict,
        &[
            "conflict (",
            "automatic merge failed",
            "merge conflict in",
            "could not apply",
            "resolve your current index first",
            "you have not concluded your merge",
            "unmerged files",
            "needs merge",
        ],
    ),
    (
        GitFailureKind::LocalChangesConflict,
        &[
            "would be overwritten by",
            "please commit your changes or stash them",
            "you have unstaged changes",
            "your index contains uncommitted changes",
        ],
    ),
    (
        GitFailureKind::PushRejected,
        &[
            "[rejected]",
            "[remote rejected]",
            "updates were rejected",
            "failed to push some refs",
        ],
    ),
    (
        GitFailureKind::RepositoryLocked,
        &[
            ".lock': file exists",
            "another git process seems to be running",
        ],
    ),
    (
        GitFailureKind::BranchInUse,
        &[
            "is already checked out at",
            "is already used by worktree at",
        ],
    ),
    (GitFailureKind::AlreadyExists, &["already exists"]),
    (
        GitFailureKind::RefNotFound,
        &[
            "did not match any file(s) known to git",
            "unknown revision",
            "not a valid object name",
            "couldn't find remote ref",
            "invalid reference:",
            "bad revision",
            "not something we can merge",
        ],
    ),
];

impl GitFailureKind {
    /// Recognize the refusal from git's (sanitized) output.
    pub fn classify(message: &str) -> Self {
        let lowered = message.to_lowercase();
        SIGNATURES
            .iter()
            .find(|(_, fragments)| fragments.iter().any(|f| lowered.contains(f)))
            .map_or(Self::CommandFailed, |(kind, _)| *kind)
    }

    pub fn status(self) -> StatusCode {
        match self {
            Self::MergeConflict
            | Self::LocalChangesConflict
            | Self::PushRejected
            | Self::RepositoryLocked
            | Self::BranchInUse
            | Self::AlreadyExists => StatusCode::CONFLICT,
            Self::RefNotFound | Self::CommandFailed => StatusCode::UNPROCESSABLE_ENTITY,
        }
    }

    pub fn code(self) -> &'static str {
        match self {
            Self::MergeConflict => "GIT_MERGE_CONFLICT",
            Self::LocalChangesConflict => "GIT_LOCAL_CHANGES_CONFLICT",
            Self::PushRejected => "GIT_PUSH_REJECTED",
            Self::RepositoryLocked => "GIT_REPOSITORY_LOCKED",
            Self::BranchInUse => "GIT_BRANCH_IN_USE",
            Self::AlreadyExists => "GIT_ALREADY_EXISTS",
            Self::RefNotFound => "GIT_REF_NOT_FOUND",
            Self::CommandFailed => "GIT_COMMAND_FAILED",
        }
    }
}

/// A git refusal whose `message` is safe to show the user as-is.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct GitRejection {
    pub kind: GitFailureKind,
    pub message: String,
}

impl GitRejection {
    /// Classify git's message. Callers must pass already sanitized text.
    pub fn classify(message: impl Into<String>) -> Self {
        let message = message.into();
        Self {
            kind: GitFailureKind::classify(&message),
            message,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn kind(message: &str) -> GitFailureKind {
        GitFailureKind::classify(message)
    }

    #[test]
    fn classifies_real_git_refusals() {
        let cases = [
            (
                "error: Your local changes to the following files would be overwritten by checkout:\n\tsrc/a.rs\nPlease commit your changes or stash them before you switch branches.\nAborting",
                GitFailureKind::LocalChangesConflict,
            ),
            (
                "error: The following untracked working tree files would be overwritten by merge:\n\tnew.txt",
                GitFailureKind::LocalChangesConflict,
            ),
            (
                "CONFLICT (content): Merge conflict in src/a.rs\nAutomatic merge failed; fix conflicts and then commit the result.",
                GitFailureKind::MergeConflict,
            ),
            (
                "error: could not apply 1a2b3c4... change",
                GitFailureKind::MergeConflict,
            ),
            (
                " ! [rejected]        main -> main (fetch first)\nerror: failed to push some refs to 'origin'",
                GitFailureKind::PushRejected,
            ),
            (
                "fatal: Unable to create '<path>/index.lock': File exists.\n\nAnother git process seems to be running in this repository",
                GitFailureKind::RepositoryLocked,
            ),
            (
                "fatal: 'feature' is already checked out at '~/repo-wt'",
                GitFailureKind::BranchInUse,
            ),
            (
                "fatal: a branch named 'feature' already exists",
                GitFailureKind::AlreadyExists,
            ),
            (
                "error: pathspec 'nope' did not match any file(s) known to git",
                GitFailureKind::RefNotFound,
            ),
            (
                "merge-tree: no-such-branch - not something we can merge",
                GitFailureKind::RefNotFound,
            ),
            (
                "fatal: ambiguous argument 'nope': unknown revision or path not in the working tree.",
                GitFailureKind::RefNotFound,
            ),
            (
                "fatal: couldn't find remote ref refs/heads/nope",
                GitFailureKind::RefNotFound,
            ),
        ];
        for (message, expected) in cases {
            assert_eq!(kind(message), expected, "{message}");
        }
    }

    #[test]
    fn unrecognized_or_localized_refusals_stay_generic() {
        assert_eq!(
            kind("erreur : vos modifications locales seraient écrasées par l'extraction"),
            GitFailureKind::CommandFailed
        );
        assert_eq!(
            kind("fatal: not a git repository (or any of the parent directories): .git"),
            GitFailureKind::CommandFailed
        );
    }

    #[test]
    fn every_kind_is_a_client_error_with_a_git_code() {
        let kinds = [
            GitFailureKind::MergeConflict,
            GitFailureKind::LocalChangesConflict,
            GitFailureKind::PushRejected,
            GitFailureKind::RepositoryLocked,
            GitFailureKind::BranchInUse,
            GitFailureKind::AlreadyExists,
            GitFailureKind::RefNotFound,
            GitFailureKind::CommandFailed,
        ];
        for kind in kinds {
            assert!(kind.status().is_client_error(), "{kind:?}");
            assert!(kind.code().starts_with("GIT_"), "{kind:?}");
        }
    }
}
