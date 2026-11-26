use sqlx::SqlitePool;

use crate::domain::features::repository::{manual_title_revision, update_generated_title};
use crate::domain::features::title::{
    is_default_title, GeneratedTitlePolicy, MANUAL_TITLE_SETTING_KEY,
};
use crate::error::AppError;

#[derive(Debug, PartialEq, Eq)]
pub(super) enum TitleOutcome {
    Renamed,
    ManualTitlePreserved,
}

/// A default-looking title remains eligible only until the user explicitly
/// renames it. The marker matters when a user deliberately chooses a title
/// such as "Session 42", which cannot be distinguished from a generated
/// placeholder by text alone.
pub(super) async fn has_default_title(
    pool: &SqlitePool,
    feature_id: i64,
) -> Result<bool, AppError> {
    Ok(read_title(pool, feature_id)
        .await?
        .is_some_and(|(title, manually_set)| !manually_set && is_default_title(&title)))
}

pub(super) async fn persist_title(
    pool: &SqlitePool,
    feature_id: i64,
    title: &str,
    policy: GeneratedTitlePolicy<'_>,
) -> Result<TitleOutcome, AppError> {
    if update_generated_title(pool, feature_id, title, policy).await? {
        return Ok(TitleOutcome::Renamed);
    }

    let Some((_, manually_set)) = read_title(pool, feature_id).await? else {
        return Err(AppError::NotFound(format!(
            "Conversation {feature_id} no longer exists"
        )));
    };
    let manual_title_won = match policy {
        GeneratedTitlePolicy::PreserveManualTitle => manually_set,
        GeneratedTitlePolicy::ReplaceIfManualTitleUnchanged { revision } => {
            manual_title_revision(pool, feature_id).await?.as_deref() != revision
        }
    };
    if manual_title_won {
        Ok(TitleOutcome::ManualTitlePreserved)
    } else {
        Err(AppError::database(
            "generated title update affected no rows",
        ))
    }
}

async fn read_title(
    pool: &SqlitePool,
    feature_id: i64,
) -> Result<Option<(String, bool)>, AppError> {
    Ok(sqlx::query_as(
        "SELECT f.title,
                EXISTS(
                    SELECT 1 FROM feature_settings fs
                    WHERE fs.feature_id = f.id AND fs.key = ? AND fs.value = 'true'
                )
         FROM features f
         WHERE f.id = ?",
    )
    .bind(MANUAL_TITLE_SETTING_KEY)
    .bind(feature_id)
    .fetch_optional(pool)
    .await?)
}

#[cfg(test)]
pub(super) async fn title_pool(title: &str) -> SqlitePool {
    let pool = SqlitePool::connect(":memory:").await.unwrap();
    sqlx::query("CREATE TABLE features (id INTEGER PRIMARY KEY, title TEXT NOT NULL)")
        .execute(&pool)
        .await
        .unwrap();
    sqlx::query(
        "CREATE TABLE feature_settings (
            feature_id INTEGER NOT NULL,
            key TEXT NOT NULL,
            value TEXT NOT NULL,
            PRIMARY KEY (feature_id, key)
        )",
    )
    .execute(&pool)
    .await
    .unwrap();
    sqlx::query("INSERT INTO features (id, title) VALUES (1, ?)")
        .bind(title)
        .execute(&pool)
        .await
        .unwrap();
    pool
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn manually_renamed_default_looking_title_is_not_eligible() {
        let pool = title_pool("Session 1").await;
        crate::domain::features::repository::update_title_manually(&pool, 1, "Session 42")
            .await
            .unwrap();
        assert!(!has_default_title(&pool, 1).await.unwrap());
    }

    #[tokio::test]
    async fn untouched_default_title_remains_eligible() {
        let pool = title_pool("Session 42").await;
        assert!(has_default_title(&pool, 1).await.unwrap());
    }

    #[tokio::test]
    async fn an_explicit_request_can_replace_a_legacy_manual_title() {
        let pool = title_pool("Session 42").await;
        sqlx::query("INSERT INTO feature_settings (feature_id, key, value) VALUES (1, ?, 'true')")
            .bind(MANUAL_TITLE_SETTING_KEY)
            .execute(&pool)
            .await
            .unwrap();
        assert_eq!(
            persist_title(
                &pool,
                1,
                "Generated",
                GeneratedTitlePolicy::ReplaceIfManualTitleUnchanged { revision: None }
            )
            .await
            .unwrap(),
            TitleOutcome::Renamed
        );
    }

    #[tokio::test]
    async fn a_deleted_conversation_is_not_a_preserved_title() {
        let pool = title_pool("Session 42").await;
        for policy in [
            GeneratedTitlePolicy::PreserveManualTitle,
            GeneratedTitlePolicy::ReplaceIfManualTitleUnchanged { revision: None },
        ] {
            let error = persist_title(&pool, 2, "Generated", policy)
                .await
                .unwrap_err();
            assert_eq!(error.code(), "NOT_FOUND");
        }
    }
}
