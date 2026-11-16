use std::collections::HashSet;

use sqlx::{AssertSqlSafe, SqlitePool};

use super::models::{ConversationIndexEntry, MessageSearchHit};
use crate::domain::features::repository::{
    LAST_ACTIVITY_COLUMN, LAST_USER_MESSAGE_JOIN, LATEST_SESSION_JOIN,
};
use crate::error::AppError;

/// Matching prompts and replies scanned before keeping one per conversation,
/// newest first, so a common word still answers quickly.
const CANDIDATE_MESSAGES: i64 = 150;
/// Words of context `snippet()` keeps around a match.
const SNIPPET_TOKENS: i64 = 16;

/// The sidebar's activity order (latest user message, else creation), so
/// the palette's Recent matches it.
fn conversation_index_sql() -> String {
    format!(
        "SELECT f.id, f.project_id, f.title, f.status, f.label, f.is_pinned, \
                COALESCE(ls.runtime_provider, f.agent_runtime_session) AS runtime_provider, \
                (SELECT fs.value FROM feature_settings fs \
                 WHERE fs.feature_id = f.id AND fs.key = 'worktree_branch' AND fs.value <> '') \
                  AS worktree_branch, \
                COALESCE(f.created_at, datetime('now')) AS created_at, \
                {LAST_ACTIVITY_COLUMN}, f.archived_at \
         FROM features f \
         {LATEST_SESSION_JOIN} \
         {LAST_USER_MESSAGE_JOIN} \
         ORDER BY datetime(last_activity_at) DESC, f.id DESC"
    )
}

/// Every conversation, active and archived, most recently touched first.
pub async fn conversation_index(
    pool: &SqlitePool,
) -> Result<Vec<ConversationIndexEntry>, AppError> {
    Ok(
        sqlx::query_as::<_, ConversationIndexEntry>(AssertSqlSafe(conversation_index_sql()))
            .fetch_all(pool)
            .await?,
    )
}

/// An FTS5 query where every word must appear, each as a prefix: `"pal"*
/// "nav"*`. Quotes keep FTS syntax (`OR`, `-`, `:`) literal. `None` when the
/// text holds no word.
pub fn fts_prefix_query(text: &str) -> Option<String> {
    let terms: Vec<String> = text
        .split_whitespace()
        .map(|word| word.replace('"', ""))
        .filter(|word| !word.is_empty())
        .map(|word| format!("\"{word}\"*"))
        .collect();
    (!terms.is_empty()).then(|| terms.join(" "))
}

// Filters sit inside the FTS query, before the LIMIT, so tool calls and
// other projects can't crowd out the matches that count. Ordering by the FTS
// rowid (not `m.id`) keeps SQLite walking the index newest first.
const MESSAGE_SEARCH_SQL: &str = r#"
SELECT m.id AS message_id, f.id AS feature_id, f.project_id, f.title AS feature_title,
       f.status AS feature_status, m.role,
       snippet(agent_messages_fts, 0, char(2), char(3), '…', ?) AS snippet, m.created_at
FROM agent_messages_fts
JOIN agent_messages m ON m.id = agent_messages_fts.rowid
JOIN agent_sessions s ON s.id = m.session_id
JOIN features f ON f.id = s.feature_id
WHERE agent_messages_fts MATCH ?
  AND m.message_type IN ('user_message', 'text')
  AND (? IS NULL OR f.project_id = ?)
  AND (? = 0 OR f.status = 'active')
ORDER BY agent_messages_fts.rowid DESC
LIMIT ?"#;

pub struct MessageSearch<'a> {
    pub fts_query: &'a str,
    pub limit: usize,
    pub project_id: Option<i64>,
    pub active_only: bool,
}

/// The newest matching prompt or reply of each conversation, newest first.
/// Thinking, tool calls and tool output stay out: the palette finds where
/// something was said, not every file an agent touched.
pub async fn search_messages(
    pool: &SqlitePool,
    search: MessageSearch<'_>,
) -> Result<Vec<MessageSearchHit>, AppError> {
    let rows = sqlx::query_as::<_, MessageSearchHit>(MESSAGE_SEARCH_SQL)
        .bind(SNIPPET_TOKENS)
        .bind(search.fts_query)
        .bind(search.project_id)
        .bind(search.project_id)
        .bind(search.active_only)
        .bind(CANDIDATE_MESSAGES)
        .fetch_all(pool)
        .await?;
    let mut seen = HashSet::new();
    Ok(rows
        .into_iter()
        .filter(|hit| seen.insert(hit.feature_id))
        .take(search.limit)
        .collect())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::domain::features::models::FeatureStatus;

    async fn migrated_pool() -> SqlitePool {
        let pool = SqlitePool::connect("sqlite::memory:").await.unwrap();
        crate::shared::migrate::run_migrations(
            &crate::shared::migrate::MigrationContext::pool_only(&pool),
        )
        .await
        .unwrap();
        pool
    }

    async fn insert(pool: &SqlitePool, sql: &'static str, binds: &[&str]) -> i64 {
        let mut query = sqlx::query_scalar::<_, i64>(sql);
        for value in binds {
            query = query.bind(*value);
        }
        query.fetch_one(pool).await.unwrap()
    }

    /// A conversation with one session; returns (feature id, session id).
    async fn conversation(
        pool: &SqlitePool,
        project: i64,
        title: &str,
        status: &str,
    ) -> (i64, i64) {
        let feature = insert(
            pool,
            "INSERT INTO features (project_id, title, status) VALUES (?, ?, ?) RETURNING id",
            &[&project.to_string(), title, status],
        )
        .await;
        let session = insert(
            pool,
            "INSERT INTO agent_sessions (feature_id, agent_type) VALUES (?, 'claude') RETURNING id",
            &[&feature.to_string()],
        )
        .await;
        (feature, session)
    }

    async fn message(pool: &SqlitePool, session: i64, role: &str, kind: &str, content: &str) {
        insert(
            pool,
            "INSERT INTO agent_messages (session_id, role, message_type, content) \
             VALUES (?, ?, ?, ?) RETURNING id",
            &[&session.to_string(), role, kind, content],
        )
        .await;
    }

    async fn project(pool: &SqlitePool, name: &str) -> i64 {
        insert(
            pool,
            "INSERT INTO projects (name, path) VALUES (?, ?) RETURNING id",
            &[name, &format!("/tmp/{name}")],
        )
        .await
    }

    fn search(query: &str) -> MessageSearch<'_> {
        MessageSearch {
            fts_query: query,
            limit: 8,
            project_id: None,
            active_only: false,
        }
    }

    #[test]
    fn fts_prefix_query_requires_every_word_as_a_prefix() {
        assert_eq!(
            fts_prefix_query("  pal  nav ").as_deref(),
            Some(r#""pal"* "nav"*"#)
        );
        assert_eq!(
            fts_prefix_query(r#"a"b OR -c"#).as_deref(),
            Some(r#""ab"* "OR"* "-c"*"#)
        );
        assert_eq!(fts_prefix_query(" \" "), None);
    }

    #[tokio::test]
    async fn conversation_index_lists_archived_conversations_with_their_branch() {
        let pool = migrated_pool().await;
        let project = project(&pool, "p").await;
        let (active, _) = conversation(&pool, project, "Active one", "active").await;
        let (archived, _) = conversation(&pool, project, "Old one", "archived").await;
        sqlx::query("INSERT INTO feature_settings (feature_id, key, value) VALUES (?, 'worktree_branch', 'feat/old')")
            .bind(archived)
            .execute(&pool)
            .await
            .unwrap();

        let index = conversation_index(&pool).await.unwrap();

        let ids: Vec<i64> = index.iter().map(|entry| entry.id).collect();
        assert!(ids.contains(&active) && ids.contains(&archived));
        let old = index.iter().find(|entry| entry.id == archived).unwrap();
        assert_eq!(old.status, FeatureStatus::Archived);
        assert_eq!(old.worktree_branch.as_deref(), Some("feat/old"));
    }

    #[tokio::test]
    async fn search_messages_keeps_the_newest_prompt_or_reply_per_conversation() {
        let pool = migrated_pool().await;
        let project = project(&pool, "p").await;
        let (palette, session) = conversation(&pool, project, "Palette", "active").await;
        message(
            &pool,
            session,
            "user",
            "user_message",
            "improve the command palette",
        )
        .await;
        message(
            &pool,
            session,
            "assistant",
            "text",
            "the palette now ranks titles",
        )
        .await;
        message(
            &pool,
            session,
            "assistant",
            "tool_call",
            "palette tool call",
        )
        .await;
        let (_, other) = conversation(&pool, project, "Other", "active").await;
        message(&pool, other, "assistant", "thinking", "palette thoughts").await;

        let hits = search_messages(&pool, search(&fts_prefix_query("palet").unwrap()))
            .await
            .unwrap();

        assert_eq!(hits.len(), 1);
        assert_eq!(hits[0].feature_id, palette);
        assert_eq!(hits[0].role, "assistant");
        assert!(hits[0].snippet.contains("\u{2}palette\u{3}"));
    }

    #[tokio::test]
    async fn search_messages_filters_by_project_and_archive_state() {
        let pool = migrated_pool().await;
        let first = project(&pool, "first").await;
        let second = project(&pool, "second").await;
        let (_, archived) = conversation(&pool, first, "Archived", "archived").await;
        message(
            &pool,
            archived,
            "user",
            "user_message",
            "deploy the worktree",
        )
        .await;
        let (live, active) = conversation(&pool, second, "Live", "active").await;
        message(&pool, active, "user", "user_message", "deploy again").await;
        let query = fts_prefix_query("deploy").unwrap();

        let all = search_messages(&pool, search(&query)).await.unwrap();
        let active_only = MessageSearch {
            active_only: true,
            ..search(&query)
        };
        let in_first = MessageSearch {
            project_id: Some(first),
            ..search(&query)
        };

        assert_eq!(all.len(), 2);
        let active_hits = search_messages(&pool, active_only).await.unwrap();
        assert_eq!(
            active_hits
                .iter()
                .map(|hit| hit.feature_id)
                .collect::<Vec<_>>(),
            vec![live]
        );
        let first_hits = search_messages(&pool, in_first).await.unwrap();
        assert_eq!(first_hits.len(), 1);
        assert_eq!(first_hits[0].feature_status, FeatureStatus::Archived);
    }

    #[tokio::test]
    async fn search_messages_filters_before_capping_candidates() {
        let pool = migrated_pool().await;
        let first = project(&pool, "first").await;
        let second = project(&pool, "second").await;
        let (old, quiet) = conversation(&pool, first, "Old", "active").await;
        message(&pool, quiet, "user", "user_message", "deploy once").await;
        let (_, busy) = conversation(&pool, second, "Busy", "active").await;
        for _ in 0..=CANDIDATE_MESSAGES {
            message(&pool, busy, "assistant", "tool_call", "deploy tool").await;
            message(&pool, busy, "assistant", "text", "deploy reply").await;
        }
        let query = fts_prefix_query("deploy").unwrap();
        let in_first = MessageSearch {
            project_id: Some(first),
            ..search(&query)
        };

        let hits = search_messages(&pool, in_first).await.unwrap();

        assert_eq!(
            hits.iter().map(|hit| hit.feature_id).collect::<Vec<_>>(),
            vec![old]
        );
    }
}
