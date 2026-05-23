//! Provisioning cases for `worktree::ensure_worktree`. The HTTP create-feature
//! handler only persists settings; the dispatcher logic exercised here lives
//! one layer below. Validation cases are in `feature_create_test.rs`.
//!
//! `ensure_worktree` writes provisioned worktrees to the Cadencr worktrees
//! root (`<data_dir>/worktrees`, platform-dependent — see `shared::app_paths`).
//! To avoid polluting the developer's home dir, these tests redirect `$HOME`
//! (and the XDG roots) to a tempdir for the duration of each test via
//! `common::worktree::HomeGuard`.

mod common;

use cadencr_service::domain::workflow::worktree::{ensure_worktree, get_setting, WorktreeMode};
use cadencr_service::shared::app_paths;

use common::git_in;
use common::worktree::{
    fresh_ws_sender, init_git_repo, insert_project_and_feature, rev_parse_head,
    set_feature_setting, worktree_pool, worktree_remove, HomeGuard,
};

#[tokio::test]
async fn ensure_worktree_skip_returns_project_dir() {
    let pool = worktree_pool().await;
    let project = tempfile::tempdir().unwrap();
    init_git_repo(project.path());
    insert_project_and_feature(&pool, "p", project.path()).await;
    set_feature_setting(&pool, 1, "worktree_mode", "skip").await;

    let (sender, _rx) = fresh_ws_sender();
    let path = ensure_worktree(&pool, &pool, 1, 1, &sender).await.unwrap();
    assert_eq!(path, project.path());
}

#[tokio::test]
async fn ensure_worktree_reuse_already_attached_returns_donor_path() {
    // Donor feature already has a worktree on `feat/shared`; the new feature
    // selects the same branch with `worktree_mode=reuse` and inherits the
    // existing worktree path verbatim.
    let pool = worktree_pool().await;
    let tmp_home = tempfile::tempdir().unwrap();
    let _guard = HomeGuard::set(tmp_home.path());

    let project = tempfile::tempdir().unwrap();
    init_git_repo(project.path());
    git_in(project.path(), &["branch", "feat/shared"]);

    let donor_wt = tmp_home.path().join("donor-wt");
    git_in(
        project.path(),
        &["worktree", "add", donor_wt.to_str().unwrap(), "feat/shared"],
    );

    insert_project_and_feature(&pool, "p", project.path()).await;
    set_feature_setting(&pool, 1, "worktree_mode", "reuse").await;
    set_feature_setting(&pool, 1, "worktree_reuse_branch", "feat/shared").await;

    let (sender, _rx) = fresh_ws_sender();
    let path = ensure_worktree(&pool, &pool, 1, 1, &sender).await.unwrap();

    let donor_canon = std::fs::canonicalize(&donor_wt).unwrap();
    let result_canon = std::fs::canonicalize(&path).unwrap_or(path.clone());
    assert_eq!(
        result_canon,
        donor_canon,
        "ensure_worktree should reuse the donor worktree path; got {}",
        path.display()
    );
}

#[tokio::test]
async fn ensure_worktree_new_with_base_branch_forks_from_base() {
    let pool = worktree_pool().await;
    let tmp_home = tempfile::tempdir().unwrap();
    let _guard = HomeGuard::set(tmp_home.path());

    let project = tempfile::tempdir().unwrap();
    init_git_repo(project.path());

    // Seed a `develop` branch with a distinguishing commit.
    git_in(project.path(), &["checkout", "-q", "-b", "develop"]);
    git_in(
        project.path(),
        &["commit", "--allow-empty", "-m", "develop-only"],
    );
    let develop_sha = rev_parse_head(project.path());
    git_in(project.path(), &["checkout", "-q", "main"]);

    insert_project_and_feature(&pool, "demoproj", project.path()).await;
    set_feature_setting(&pool, 1, "worktree_mode", "new").await;
    set_feature_setting(&pool, 1, "worktree_base_branch", "develop").await;

    let (sender, _rx) = fresh_ws_sender();
    let wt_path = ensure_worktree(&pool, &pool, 1, 1, &sender).await.unwrap();
    let head_sha = rev_parse_head(&wt_path);
    assert_eq!(head_sha, develop_sha, "new worktree must fork from develop");
    assert_eq!(
        get_setting(&pool, 1, "target_branch").await.as_deref(),
        Some("develop"),
        "fork base must become the Git target",
    );

    worktree_remove(project.path(), &wt_path);
}

#[tokio::test]
async fn ensure_worktree_new_without_base_targets_current_branch() {
    let pool = worktree_pool().await;
    let tmp_home = tempfile::tempdir().unwrap();
    let _guard = HomeGuard::set(tmp_home.path());

    let project = tempfile::tempdir().unwrap();
    init_git_repo(project.path());
    git_in(project.path(), &["checkout", "-q", "-b", "develop"]);

    insert_project_and_feature(&pool, "demoproj", project.path()).await;
    set_feature_setting(&pool, 1, "worktree_mode", "new").await;

    let (sender, _rx) = fresh_ws_sender();
    let wt_path = ensure_worktree(&pool, &pool, 1, 1, &sender).await.unwrap();
    assert_eq!(
        get_setting(&pool, 1, "target_branch").await.as_deref(),
        Some("develop"),
    );

    worktree_remove(project.path(), &wt_path);
}

#[tokio::test]
async fn ensure_worktree_reuse_unattached_branch_creates_new_worktree() {
    // Branch exists but no worktree yet — `git worktree add` must fire and
    // produce a new path under `<worktrees-root>/{project}/{safe-branch}`
    // (root is platform-specific — see `shared::app_paths`).
    let pool = worktree_pool().await;
    let tmp_home = tempfile::tempdir().unwrap();
    let _guard = HomeGuard::set(tmp_home.path());

    let project = tempfile::tempdir().unwrap();
    init_git_repo(project.path());
    git_in(project.path(), &["branch", "feat/free"]);

    insert_project_and_feature(&pool, "reuseproj", project.path()).await;
    set_feature_setting(&pool, 1, "worktree_mode", "reuse").await;
    set_feature_setting(&pool, 1, "worktree_reuse_branch", "feat/free").await;

    let (sender, _rx) = fresh_ws_sender();
    let wt_path = ensure_worktree(&pool, &pool, 1, 1, &sender).await.unwrap();

    // Both sides canonicalized — on macOS `/var/folders/...` resolves to
    // `/private/var/folders/...` and a raw `starts_with` would fail.
    let canon_home = std::fs::canonicalize(tmp_home.path()).unwrap();
    let canon_wt = std::fs::canonicalize(&wt_path).unwrap_or(wt_path.clone());
    assert!(
        canon_wt.starts_with(&canon_home),
        "worktree path must land under HOME-redirected worktrees root; got {} (home={})",
        canon_wt.display(),
        canon_home.display()
    );
    // The worktrees root canonicalizes through `/private/var/...` symlinks on
    // macOS, so compare canonical-to-canonical to avoid a spurious mismatch.
    let expected_leaf =
        std::fs::canonicalize(app_paths::worktrees_dir().unwrap().join("reuseproj"))
            .unwrap()
            .join("feat-free");
    assert_eq!(
        canon_wt, expected_leaf,
        "worktree path must use the Cadencr worktrees layout for this platform"
    );
    assert!(
        wt_path.exists(),
        "worktree directory must actually be created on disk"
    );

    worktree_remove(project.path(), &wt_path);
}

#[tokio::test]
async fn ensure_worktree_skip_does_not_set_worktree_path_setting() {
    // Skip mode returns the project dir but must NOT persist a worktree_path
    // setting (would confuse later resolves into thinking the project dir is
    // the worktree). The setting is reserved for true worktrees.
    let pool = worktree_pool().await;
    let project = tempfile::tempdir().unwrap();
    init_git_repo(project.path());

    insert_project_and_feature(&pool, "p", project.path()).await;
    set_feature_setting(&pool, 1, "skip_worktree", "true").await;

    let mode = cadencr_service::domain::workflow::worktree::read_worktree_mode(&pool, 1).await;
    assert_eq!(mode, WorktreeMode::Skip);

    let (sender, _rx) = fresh_ws_sender();
    let _ = ensure_worktree(&pool, &pool, 1, 1, &sender).await.unwrap();

    let row = sqlx::query_as::<_, (Option<String>,)>(
        "SELECT value FROM feature_settings WHERE feature_id = 1 AND key = 'worktree_path'",
    )
    .fetch_optional(&pool)
    .await
    .unwrap();
    assert!(
        row.is_none(),
        "skip mode must not persist worktree_path; got {row:?}"
    );
}

#[tokio::test]
async fn ensure_worktree_new_copies_provider_config_before_returning() {
    let pool = worktree_pool().await;
    let tmp_home = tempfile::tempdir().unwrap();
    let _guard = HomeGuard::set(tmp_home.path());

    let project = tempfile::tempdir().unwrap();
    init_git_repo(project.path());
    std::fs::create_dir_all(project.path().join(".claude")).unwrap();
    std::fs::create_dir_all(project.path().join(".codex/agents")).unwrap();
    std::fs::write(
        project.path().join(".gitignore"),
        ".claude/settings.local.json\n",
    )
    .unwrap();
    std::fs::write(
        project.path().join(".claude/settings.local.json"),
        "{\"permissions\":{}}",
    )
    .unwrap();
    std::fs::write(project.path().join(".codex/agents/reviewer.md"), "reviewer").unwrap();
    git_in(project.path(), &["add", ".gitignore"]);
    git_in(
        project.path(),
        &["commit", "-q", "-m", "ignore provider config"],
    );

    insert_project_and_feature(&pool, "copyproj", project.path()).await;
    set_feature_setting(&pool, 1, "worktree_mode", "new").await;

    let (sender, _rx) = fresh_ws_sender();
    let wt_path = ensure_worktree(&pool, &pool, 1, 1, &sender).await.unwrap();

    assert_eq!(
        std::fs::read_to_string(wt_path.join(".claude/settings.local.json")).unwrap(),
        "{\"permissions\":{}}"
    );
    assert_eq!(
        std::fs::read_to_string(wt_path.join(".codex/agents/reviewer.md")).unwrap(),
        "reviewer"
    );

    worktree_remove(project.path(), &wt_path);
}
