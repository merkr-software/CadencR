use std::path::{Path, PathBuf};
use std::process::{Command, Output};

use sqlx::sqlite::SqlitePoolOptions;
use tempfile::TempDir;

use crate::app_state::AppState;
use crate::domain::git::repository;

pub(super) struct RepoFixture {
    pub(super) root: TempDir,
    pub(super) project: PathBuf,
    pub(super) feature: PathBuf,
}

impl RepoFixture {
    pub(super) fn new() -> Self {
        let root = tempfile::tempdir().unwrap();
        let project = root.path().join("project");
        let feature = root.path().join("feature");
        std::fs::create_dir_all(&project).unwrap();
        run_git(&project, &["init", "-q", "-b", "main"]);
        run_git(&project, &["config", "user.email", "test@example.com"]);
        run_git(&project, &["config", "user.name", "Test"]);
        run_git(&project, &["config", "commit.gpgsign", "false"]);
        for (path, contents) in [
            ("seed.txt", "seed\n"),
            ("conflict.txt", "base\n"),
            ("first.txt", "base first\n"),
            ("second.txt", "base second\n"),
        ] {
            std::fs::write(project.join(path), contents).unwrap();
        }
        run_git(&project, &["add", "."]);
        run_git(&project, &["commit", "-q", "-m", "initial"]);
        let feature_arg = feature.to_string_lossy().to_string();
        run_git(
            &project,
            &[
                "worktree",
                "add",
                "-q",
                "-b",
                "feature/test",
                &feature_arg,
                "main",
            ],
        );
        Self {
            root,
            project,
            feature,
        }
    }

    pub(super) async fn state(&self, target: &str) -> AppState {
        self.state_with_worktree(target, true).await
    }

    pub(super) async fn state_without_worktree(&self, target: &str) -> AppState {
        self.state_with_worktree(target, false).await
    }

    async fn state_with_worktree(&self, target: &str, configure_worktree: bool) -> AppState {
        let pool = SqlitePoolOptions::new()
            .max_connections(1)
            .connect("sqlite::memory:")
            .await
            .unwrap();
        sqlx::query(
            "CREATE TABLE projects (id INTEGER PRIMARY KEY, name TEXT, path TEXT, branch_prefix TEXT DEFAULT 'feature/')",
        )
        .execute(&pool)
        .await
        .unwrap();
        sqlx::query(
            "CREATE TABLE features (id INTEGER PRIMARY KEY, project_id INTEGER NOT NULL, title TEXT, status TEXT NOT NULL DEFAULT 'active', type TEXT NOT NULL DEFAULT 'ws-session')",
        )
        .execute(&pool)
        .await
        .unwrap();
        sqlx::query(
            "CREATE TABLE feature_settings (feature_id INTEGER, key TEXT, value TEXT, PRIMARY KEY(feature_id, key))",
        )
        .execute(&pool)
        .await
        .unwrap();
        sqlx::query(crate::domain::git::linked_branches::repository::TEST_SCHEMA)
            .execute(&pool)
            .await
            .unwrap();
        sqlx::query("INSERT INTO projects (id, name, path) VALUES (1, 'repo', ?)")
            .bind(self.project.to_string_lossy().as_ref())
            .execute(&pool)
            .await
            .unwrap();
        sqlx::query("INSERT INTO features (id, project_id, title) VALUES (1, 1, 'feature')")
            .execute(&pool)
            .await
            .unwrap();
        if configure_worktree {
            repository::set_feature_setting(
                &pool,
                1,
                "worktree_path",
                self.feature.to_string_lossy().as_ref(),
            )
            .await
            .unwrap();
        }
        repository::set_feature_setting(&pool, 1, "target_branch", target)
            .await
            .unwrap();
        AppState::with_pool(pool)
    }

    pub(super) fn create_conflicting_histories(&self) {
        self.commit_feature_file("conflict.txt", "feature\n", "feature conflict");
        self.commit_main_file("conflict.txt", "main\n", "main conflict");
    }

    pub(super) fn create_two_commit_rebase_conflict(&self) {
        self.commit_feature_file("first.txt", "feature first\n", "feature first");
        self.commit_feature_file("second.txt", "feature second\n", "feature second");
        self.write_project("first.txt", "main first\n");
        self.write_project("second.txt", "main second\n");
        self.git_project(&["add", "first.txt", "second.txt"]);
        self.git_project(&["commit", "-q", "-m", "main both"]);
    }

    pub(super) fn create_remote_only_tip(&self) {
        self.git_project(&["checkout", "-q", "-b", "remote-build"]);
        self.commit_main_file("remote-only.txt", "remote\n", "remote-only");
        self.git_project(&["update-ref", "refs/remotes/origin/main", "remote-build"]);
        self.git_project(&["checkout", "-q", "main"]);
        self.git_project(&["branch", "-D", "remote-build"]);
    }

    pub(super) fn create_current_branch_remote_only_tip(&self) {
        self.git_project(&[
            "remote",
            "add",
            "origin",
            "https://example.com/repository.git",
        ]);
        self.git_feature(&["config", "branch.feature/test.remote", "origin"]);
        self.git_feature(&[
            "config",
            "branch.feature/test.merge",
            "refs/heads/feature/test",
        ]);
        self.git_project(&["checkout", "-q", "-b", "remote-feature", "feature/test"]);
        self.commit_main_file("upstream-only.txt", "upstream\n", "upstream-only");
        self.git_project(&[
            "update-ref",
            "refs/remotes/origin/feature/test",
            "remote-feature",
        ]);
        self.git_project(&["checkout", "-q", "main"]);
        self.git_project(&["branch", "-D", "remote-feature"]);
    }

    pub(super) fn create_tracked_target_remote_only_tip(&self) {
        self.create_remote_only_tip();
        self.git_project(&[
            "remote",
            "add",
            "origin",
            "https://example.com/repository.git",
        ]);
        self.git_project(&["config", "branch.main.remote", "origin"]);
        self.git_project(&["config", "branch.main.merge", "refs/heads/main"]);
    }

    pub(super) fn commit_feature_file(&self, path: &str, contents: &str, message: &str) {
        self.write_feature(path, contents);
        self.git_feature(&["add", path]);
        self.git_feature(&["commit", "-q", "-m", message]);
    }

    pub(super) fn commit_main_file(&self, path: &str, contents: &str, message: &str) {
        self.write_project(path, contents);
        self.git_project(&["add", path]);
        self.git_project(&["commit", "-q", "-m", message]);
    }

    pub(super) fn write_feature(&self, path: &str, contents: &str) {
        std::fs::write(self.feature.join(path), contents).unwrap();
    }

    fn write_project(&self, path: &str, contents: &str) {
        std::fs::write(self.project.join(path), contents).unwrap();
    }

    pub(super) fn git_feature(&self, args: &[&str]) {
        assert_git(self.git_output_feature(args), args);
    }

    pub(super) fn git_project(&self, args: &[&str]) {
        assert_git(git_output(&self.project, args), args);
    }

    pub(super) fn git_output_feature(&self, args: &[&str]) -> Output {
        git_output(&self.feature, args)
    }

    pub(super) fn rev_parse_feature(&self, name: &str) -> String {
        rev_parse(&self.feature, name)
    }

    pub(super) fn rev_parse_project(&self, name: &str) -> String {
        rev_parse(&self.project, name)
    }

    pub(super) fn project_status(&self) -> String {
        let output = git_output(&self.project, &["status", "--porcelain"]);
        assert!(output.status.success());
        String::from_utf8(output.stdout).unwrap()
    }

    pub(super) fn assert_feature_ancestor(&self, ancestor: &str) {
        self.git_feature(&["merge-base", "--is-ancestor", ancestor, "HEAD"]);
    }
}

fn run_git(cwd: &Path, args: &[&str]) {
    assert_git(git_output(cwd, args), args);
}

fn git_output(cwd: &Path, args: &[&str]) -> Output {
    Command::new("git")
        .args(args)
        .current_dir(cwd)
        .env("GIT_CONFIG_NOSYSTEM", "1")
        .env("HOME", cwd)
        .output()
        .expect("git must be available")
}

fn assert_git(output: Output, args: &[&str]) {
    assert!(
        output.status.success(),
        "git {} failed: {}{}",
        args.join(" "),
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    );
}

fn rev_parse(cwd: &Path, name: &str) -> String {
    let output = git_output(cwd, &["rev-parse", name]);
    assert!(
        output.status.success(),
        "git rev-parse {name} failed: {}",
        String::from_utf8_lossy(&output.stderr)
    );
    String::from_utf8(output.stdout).unwrap().trim().to_string()
}
