use std::collections::HashMap;
use std::path::{Path, PathBuf};

use sqlx::SqlitePool;

use crate::error::AppError;

use super::attribution::FeatureDir;

/// Worktree directory of every feature that owns one outright, across all
/// projects — the scan is machine-wide, so it cannot be narrowed to one project.
///
/// A directory only identifies a feature when exactly one feature answers to
/// it, so anything shared is dropped rather than guessed at: features with no
/// worktree share their project root, reused worktrees are recorded against
/// several features, and a `worktree_path` equal to the project path is a
/// non-worktree feature in disguise. Those features are not lost — their
/// servers are attributed by terminal or agent ancestry instead, for as long as
/// that process lives.
pub async fn unambiguous_worktree_dirs(pool: &SqlitePool) -> Result<Vec<FeatureDir>, AppError> {
    let rows = sqlx::query_as::<_, (i64, String, String)>(
        "SELECT fs.feature_id, TRIM(fs.value), p.path
         FROM feature_settings fs
         JOIN features f ON f.id = fs.feature_id
         JOIN projects p ON p.id = f.project_id
         WHERE fs.key = 'worktree_path'
           AND TRIM(fs.value) <> ''",
    )
    .fetch_all(pool)
    .await?;
    // Compared as directories, not strings: a trailing separator or a
    // symlinked spelling of the project root is still the project root. Each
    // path is canonicalized once; project roots repeat across rows.
    let mut project_keys: HashMap<String, PathBuf> = HashMap::new();
    let rows = rows
        .into_iter()
        .filter_map(|(feature_id, path, project_path)| {
            let key = directory_key(&path);
            let project_key = project_keys
                .entry(project_path)
                .or_insert_with_key(|project_path| directory_key(project_path));
            (key != *project_key).then_some((feature_id, path, key))
        })
        .collect();
    Ok(keep_unshared(rows))
}

fn directory_key(path: &str) -> PathBuf {
    crate::domain::git::commands::canonical_dir(Path::new(path.trim()))
}

/// Keep only the directories claimed by a single feature. Rows carry each
/// path's [`directory_key`].
fn keep_unshared(rows: Vec<(i64, String, PathBuf)>) -> Vec<FeatureDir> {
    let mut claims: HashMap<PathBuf, (String, Option<i64>)> = HashMap::new();
    for (feature_id, path, key) in rows {
        claims
            .entry(key)
            .and_modify(|(_, owner)| {
                if *owner != Some(feature_id) {
                    *owner = None;
                }
            })
            .or_insert((path, Some(feature_id)));
    }
    claims
        .into_values()
        .filter_map(|(path, owner)| owner.map(|feature_id| FeatureDir { feature_id, path }))
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use sqlx::sqlite::SqlitePoolOptions;

    #[test]
    fn a_directory_claimed_by_two_features_identifies_neither() {
        let row = |feature_id, path: &str| (feature_id, path.to_string(), directory_key(path));
        let dirs = keep_unshared(vec![
            row(1, "/w/one"),
            row(2, "/w/shared"),
            row(3, "/w/shared/"),
        ]);

        assert_eq!(dirs.len(), 1);
        assert_eq!(dirs[0].feature_id, 1);
    }

    #[tokio::test]
    async fn skips_blank_paths_and_the_project_root() {
        let pool = SqlitePoolOptions::new()
            .max_connections(1)
            .connect("sqlite::memory:")
            .await
            .unwrap();
        for ddl in [
            "CREATE TABLE projects (id INTEGER PRIMARY KEY, path TEXT)",
            "CREATE TABLE features (id INTEGER PRIMARY KEY, project_id INTEGER)",
            "CREATE TABLE feature_settings (feature_id INTEGER, key TEXT, value TEXT, PRIMARY KEY (feature_id, key))",
        ] {
            sqlx::query(ddl).execute(&pool).await.unwrap();
        }
        sqlx::query("INSERT INTO projects (id, path) VALUES (1, '/repo')")
            .execute(&pool)
            .await
            .unwrap();
        sqlx::query(
            "INSERT INTO features (id, project_id) VALUES (1, 1), (2, 1), (3, 1), (4, 1), (5, 1)",
        )
        .execute(&pool)
        .await
        .unwrap();
        sqlx::query(
            "INSERT INTO feature_settings (feature_id, key, value) VALUES
                (1, 'worktree_path', '/w/one'),
                (2, 'worktree_path', '  '),
                (3, 'worktree_path', '/repo'),
                (4, 'branch', '/w/four'),
                (5, 'worktree_path', '/repo/')",
        )
        .execute(&pool)
        .await
        .unwrap();

        let dirs = unambiguous_worktree_dirs(&pool).await.unwrap();

        assert_eq!(dirs.len(), 1);
        assert_eq!(dirs[0].feature_id, 1);
        assert_eq!(dirs[0].path, "/w/one");
    }
}
