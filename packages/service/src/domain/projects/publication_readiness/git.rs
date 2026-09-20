use super::{fail, pass, warning};
use std::path::Path;
use std::process::Output;
use std::time::Duration;
use tokio::io::AsyncReadExt;

use crate::domain::projects::models::PublicationReadinessCheck as Check;

const GIT_TIMEOUT: Duration = Duration::from_secs(3);
const MAX_GIT_OUTPUT_BYTES: u64 = 64 * 1024;

pub(super) async fn checks(root: &Path) -> Vec<Check> {
    let (top, head, status) = tokio::join!(
        git(root, &["rev-parse", "--show-toplevel"]),
        git(root, &["rev-parse", "--verify", "HEAD"]),
        git(root, &["status", "--porcelain", "--untracked-files=normal"]),
    );
    vec![
        match top {
            Ok(output) if output.status.success() && Path::new(String::from_utf8_lossy(&output.stdout).trim()) == root => pass("git_root", "Git repository", "Project root is the Git repository root."),
            _ => fail("git_root", "Git repository", "Project must be a dedicated Git repository root, not a directory inside another repository."),
        },
        if head.as_ref().is_ok_and(|output| output.status.success()) { pass("git_head", "Git revision", "Repository has a committed HEAD revision.") } else { fail("git_head", "Git revision", "Repository does not have a readable committed HEAD revision.") },
        match status {
            Ok(output) if output.status.success() && output.stdout.is_empty() => pass("git_clean", "Git worktree", "Git worktree is clean."),
            Ok(output) if output.status.success() => warning("git_clean", "Git worktree", "Git worktree has local changes; review and commit intended release content."),
            _ => fail("git_clean", "Git worktree", "Git worktree status could not be inspected locally."),
        },
    ]
}

async fn git(root: &Path, args: &[&str]) -> Result<Output, ()> {
    let mut command = tokio::process::Command::new("git");
    command
        .args([
            "-c",
            "core.fsmonitor=false",
            "-c",
            "core.hooksPath=/dev/null",
        ])
        .args(args)
        .env("GIT_OPTIONAL_LOCKS", "0")
        .current_dir(root)
        .kill_on_drop(true)
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped());
    let mut child = command.spawn().map_err(|_| ())?;
    let stdout = child.stdout.take().ok_or(())?;
    let stderr = child.stderr.take().ok_or(())?;
    let collect = async move {
        let mut stdout_bytes = Vec::new();
        let mut stderr_bytes = Vec::new();
        let mut stdout = stdout.take(MAX_GIT_OUTPUT_BYTES + 1);
        let mut stderr = stderr.take(MAX_GIT_OUTPUT_BYTES + 1);
        let (stdout_result, stderr_result, status_result) = tokio::join!(
            stdout.read_to_end(&mut stdout_bytes),
            stderr.read_to_end(&mut stderr_bytes),
            child.wait(),
        );
        stdout_result.map_err(|_| ())?;
        stderr_result.map_err(|_| ())?;
        if stdout_bytes.len() as u64 > MAX_GIT_OUTPUT_BYTES
            || stderr_bytes.len() as u64 > MAX_GIT_OUTPUT_BYTES
        {
            return Err(());
        }
        Ok(Output {
            status: status_result.map_err(|_| ())?,
            stdout: stdout_bytes,
            stderr: stderr_bytes,
        })
    };
    tokio::time::timeout(GIT_TIMEOUT, collect)
        .await
        .map_err(|_| ())?
}

#[cfg(test)]
mod tests {
    use super::checks;
    use crate::domain::projects::models::PublicationCheckStatus as Status;
    use std::path::Path;
    use std::process::Command;

    #[tokio::test]
    async fn distinguishes_head_clean_dirty_and_nested_root() {
        let root = tempfile::tempdir().unwrap();
        run_git(root.path(), &["init", "-q"]);
        assert!(checks(root.path())
            .await
            .iter()
            .any(|check| check.id == "git_head" && check.status == Status::Fail));
        std::fs::write(root.path().join("file"), "one").unwrap();
        run_git(root.path(), &["add", "file"]);
        run_git(
            root.path(),
            &[
                "-c",
                "commit.gpgSign=false",
                "-c",
                "user.name=Test",
                "-c",
                "user.email=test@example.com",
                "commit",
                "-qm",
                "initial",
            ],
        );
        let canonical = root.path().canonicalize().unwrap();
        assert!(checks(&canonical)
            .await
            .iter()
            .all(|check| check.status == Status::Pass));
        std::fs::write(root.path().join("file"), "two").unwrap();
        assert!(checks(&canonical)
            .await
            .iter()
            .any(|check| check.id == "git_clean" && check.status == Status::Warning));
        let nested = canonical.join("nested");
        std::fs::create_dir(&nested).unwrap();
        assert!(checks(&nested)
            .await
            .iter()
            .any(|check| check.id == "git_root" && check.status == Status::Fail));
    }

    fn run_git(root: &Path, args: &[&str]) {
        assert!(Command::new("git")
            .args(args)
            .current_dir(root)
            .status()
            .unwrap()
            .success());
    }
}
