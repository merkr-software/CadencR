mod claude;
mod codex;
mod opencode;
mod persistence;
mod state;
mod types;

use anyhow::Context;
use sqlx::{Row, SqlitePool};

use crate::domain::imports::models::{PROVIDER_CLAUDE_CODE, PROVIDER_CODEX_CLI, PROVIDER_OPENCODE};

use types::{HistoryLocations, ImportBatch, ImportWindow, SessionSource};

#[derive(Clone, Copy)]
enum Provider {
    Claude,
    Codex,
    Opencode,
}

impl Provider {
    const ALL: [Self; 3] = [Self::Claude, Self::Codex, Self::Opencode];

    fn id(self) -> &'static str {
        match self {
            Self::Claude => PROVIDER_CLAUDE_CODE,
            Self::Codex => PROVIDER_CODEX_CLI,
            Self::Opencode => PROVIDER_OPENCODE,
        }
    }
}

/// Import the provider-native history that predates token recording.
///
/// This runs synchronously before the HTTP listener starts. That boundary is
/// intentional: Codex reports cumulative counters, so its imported checkpoint
/// must exist before a resumed session can publish another total.
pub async fn run_once(pool: &SqlitePool) {
    run_with_locations(pool, HistoryLocations::from_environment()).await;
}

async fn run_with_locations(pool: &SqlitePool, locations: HistoryLocations) {
    let mut announced = false;
    for provider in Provider::ALL {
        if let Err(error) = run_provider(pool, &locations, provider, &mut announced).await {
            let message = format!("{} token history import failed: {error}", provider.id());
            tracing::warn!(provider = provider.id(), %error, "provider token history import failed");
            if let Err(state_error) = state::mark_failed(pool, provider.id(), &message).await {
                tracing::warn!(%state_error, "failed to persist usage import error");
            }
            super::health::record_failure(&message);
        }
    }
}

async fn run_provider(
    pool: &SqlitePool,
    locations: &HistoryLocations,
    provider: Provider,
    announced: &mut bool,
) -> anyhow::Result<()> {
    let Some(window) = state::begin(pool, provider.id()).await? else {
        return Ok(());
    };
    if !*announced {
        println!("CADENCR_PHASE importing_usage");
        *announced = true;
    }
    let sources = load_sources(pool, provider.id()).await?;
    let batch = scan_provider(locations, provider, sources, window).await?;
    let imported = persistence::persist(pool, provider.id(), batch).await?;
    tracing::info!(
        provider = provider.id(),
        imported,
        "provider token history import completed"
    );
    Ok(())
}

async fn scan_provider(
    locations: &HistoryLocations,
    provider: Provider,
    sources: Vec<SessionSource>,
    window: ImportWindow,
) -> anyhow::Result<ImportBatch> {
    if sources.is_empty() {
        return Ok(ImportBatch::default());
    }
    match provider {
        Provider::Claude => {
            let root = locations
                .claude_projects_root
                .clone()
                .context("Claude Code history directory is unavailable")?;
            tokio::task::spawn_blocking(move || claude::scan(&root, &sources, &window))
                .await
                .context("Claude Code history scan panicked")?
        }
        Provider::Codex => {
            let root = locations
                .codex_sessions_root
                .clone()
                .context("Codex history directory is unavailable")?;
            tokio::task::spawn_blocking(move || codex::scan(&root, &sources, &window))
                .await
                .context("Codex history scan panicked")?
        }
        Provider::Opencode => {
            opencode::scan(&locations.opencode_databases, &sources, &window).await
        }
    }
}

async fn load_sources(
    pool: &SqlitePool,
    provider_id: &str,
) -> Result<Vec<SessionSource>, sqlx::Error> {
    let rows = sqlx::query(
        "SELECT s.id, s.runtime_session_id,
                COALESCE(s.model, '') AS model_id,
                COALESCE(s.thinking_effort, '') AS thinking_effort
         FROM agent_sessions s
         WHERE COALESCE(NULLIF(s.runtime_provider, ''), NULLIF(s.agent_type, '')) = ?
           AND NULLIF(s.runtime_session_id, '') IS NOT NULL",
    )
    .bind(provider_id)
    .fetch_all(pool)
    .await?;
    rows.into_iter()
        .map(|row| {
            Ok(SessionSource {
                session_id: row.try_get("id")?,
                runtime_session_id: row.try_get("runtime_session_id")?,
                model_id: row.try_get("model_id")?,
                thinking_effort: row.try_get("thinking_effort")?,
            })
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use chrono::{Duration, Utc};
    use sqlx::sqlite::SqlitePoolOptions;

    use super::*;
    use crate::domain::usage_stats::repository;

    #[tokio::test]
    async fn startup_import_is_idempotent_and_marks_each_provider_complete() {
        let pool = SqlitePoolOptions::new()
            .max_connections(1)
            .connect("sqlite::memory:")
            .await
            .unwrap();
        sqlx::migrate!("./migrations").run(&pool).await.unwrap();
        sqlx::query("INSERT INTO projects (name, path) VALUES ('p', '/tmp/p')")
            .execute(&pool)
            .await
            .unwrap();
        sqlx::query("INSERT INTO features (project_id, title) VALUES (1, 'f')")
            .execute(&pool)
            .await
            .unwrap();
        sqlx::query(
            "INSERT INTO agent_sessions
                 (feature_id, agent_type, runtime_provider, runtime_session_id, model)
             VALUES (1, 'session', 'claude_code', 'claude-session', 'fallback')",
        )
        .execute(&pool)
        .await
        .unwrap();
        let root = tempfile::tempdir().unwrap();
        let directory = root.path().join("encoded-worktree");
        std::fs::create_dir_all(&directory).unwrap();
        let timestamp = (Utc::now() - Duration::days(1)).to_rfc3339();
        std::fs::write(
            directory.join("claude-session.jsonl"),
            format!(
                "{{\"type\":\"assistant\",\"timestamp\":\"{timestamp}\",\"message\":{{\"id\":\"msg-1\",\"model\":\"opus\",\"usage\":{{\"input_tokens\":10,\"output_tokens\":2}}}}}}\n"
            ),
        )
        .unwrap();
        let locations = HistoryLocations {
            claude_projects_root: Some(root.path().to_path_buf()),
            codex_sessions_root: None,
            opencode_databases: Vec::new(),
        };

        run_with_locations(&pool, locations.clone()).await;
        run_with_locations(&pool, locations).await;

        let rows = repository::list_recent(&pool, 30).await.unwrap();
        assert_eq!(rows.len(), 1);
        assert_eq!((rows[0].input_tokens, rows[0].output_tokens), (10, 2));
        for provider in Provider::ALL {
            assert!(state::completed(&pool, provider.id()).await);
        }
    }
}
