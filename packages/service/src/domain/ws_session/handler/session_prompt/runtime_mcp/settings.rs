use sqlx::SqlitePool;

const BROWSER_MCP_ENABLED_SETTING_KEY: &str = "browser_mcp_enabled";
const PROJECT_MCP_ENABLED_SETTING_KEY: &str = "project_mcp_enabled";
const WORKSPACE_MCP_ENABLED_SETTING_KEY: &str = "workspace_mcp_enabled";

pub(in crate::domain::ws_session::handler::session_prompt) async fn browser_mcp_enabled(
    read_pool: &SqlitePool,
) -> bool {
    enabled_by_default_setting(read_pool, BROWSER_MCP_ENABLED_SETTING_KEY).await
}

pub(in crate::domain::ws_session::handler::session_prompt) async fn project_mcp_enabled(
    read_pool: &SqlitePool,
) -> bool {
    enabled_by_default_setting(read_pool, PROJECT_MCP_ENABLED_SETTING_KEY).await
}

pub(in crate::domain::ws_session::handler::session_prompt) async fn workspace_mcp_enabled(
    read_pool: &SqlitePool,
) -> bool {
    enabled_by_default_setting(read_pool, WORKSPACE_MCP_ENABLED_SETTING_KEY).await
}

async fn enabled_by_default_setting(read_pool: &SqlitePool, key: &str) -> bool {
    !matches!(
        crate::domain::workspace::repository::get_setting(read_pool, key).await,
        Ok(Some(value)) if value == "false"
    )
}

#[cfg(test)]
mod project_setting_red_test {
    use super::{project_mcp_enabled, PROJECT_MCP_ENABLED_SETTING_KEY};
    use crate::domain::workspace::repository::set_setting;

    #[tokio::test]
    async fn project_mcp_enabled_defaults_on_and_off_only_for_explicit_false() {
        let pool = super::tests::settings_pool().await;
        assert!(project_mcp_enabled(&pool).await);

        set_setting(&pool, PROJECT_MCP_ENABLED_SETTING_KEY, "false")
            .await
            .expect("set false");
        assert!(!project_mcp_enabled(&pool).await);
    }
}

#[cfg(test)]
pub(super) mod tests {
    use super::{
        browser_mcp_enabled, workspace_mcp_enabled, BROWSER_MCP_ENABLED_SETTING_KEY,
        WORKSPACE_MCP_ENABLED_SETTING_KEY,
    };
    use crate::domain::workspace::repository::set_setting;
    use sqlx::sqlite::SqlitePoolOptions;
    use sqlx::SqlitePool;

    pub(super) async fn settings_pool() -> SqlitePool {
        let pool = SqlitePoolOptions::new()
            .max_connections(1)
            .connect("sqlite::memory:")
            .await
            .expect("connect in-memory db");
        sqlx::query("CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT)")
            .execute(&pool)
            .await
            .expect("create settings table");
        pool
    }

    #[tokio::test]
    async fn browser_mcp_enabled_defaults_on_and_off_only_for_explicit_false() {
        let pool = settings_pool().await;
        assert!(browser_mcp_enabled(&pool).await);

        set_setting(&pool, BROWSER_MCP_ENABLED_SETTING_KEY, "false")
            .await
            .expect("set false");
        assert!(!browser_mcp_enabled(&pool).await);

        set_setting(&pool, BROWSER_MCP_ENABLED_SETTING_KEY, "true")
            .await
            .expect("set true");
        assert!(browser_mcp_enabled(&pool).await);
    }

    #[tokio::test]
    async fn workspace_mcp_enabled_defaults_on_and_off_only_for_explicit_false() {
        let pool = settings_pool().await;
        assert!(workspace_mcp_enabled(&pool).await);

        set_setting(&pool, WORKSPACE_MCP_ENABLED_SETTING_KEY, "false")
            .await
            .expect("set false");
        assert!(!workspace_mcp_enabled(&pool).await);

        set_setting(&pool, WORKSPACE_MCP_ENABLED_SETTING_KEY, "true")
            .await
            .expect("set true");
        assert!(workspace_mcp_enabled(&pool).await);
    }
}
