use crate::domain::settings_store;
use crate::domain::workspace::repository::{enabled_by_default_in, setting_enabled_by_default};
use crate::error::AppError;

const BROWSER_MCP_ENABLED_SETTING_KEY: &str = "browser_mcp_enabled";
const PROJECT_MCP_ENABLED_SETTING_KEY: &str = "project_mcp_enabled";
const WORKSPACE_MCP_ENABLED_SETTING_KEY: &str = "workspace_mcp_enabled";

pub(crate) struct McpSettings {
    pub(in crate::domain::ws_session::runtime::prompt) browser: bool,
    pub(in crate::domain::ws_session::runtime::prompt) project: bool,
    pub(in crate::domain::ws_session::runtime::prompt) workspace: bool,
}

impl McpSettings {
    pub fn read() -> Result<Self, AppError> {
        settings_store::global_inspect_document(|doc| {
            Ok(Self {
                browser: enabled_by_default_in(doc, BROWSER_MCP_ENABLED_SETTING_KEY)?,
                project: enabled_by_default_in(doc, PROJECT_MCP_ENABLED_SETTING_KEY)?,
                workspace: enabled_by_default_in(doc, WORKSPACE_MCP_ENABLED_SETTING_KEY)?,
            })
        })
    }
}

pub(in crate::domain::ws_session::runtime::prompt) fn workspace_mcp_enabled(
) -> Result<bool, AppError> {
    setting_enabled_by_default(WORKSPACE_MCP_ENABLED_SETTING_KEY)
}

#[cfg(test)]
mod tests {
    use super::*;
    use settings_store::file::{SETTINGS_INVALID, SETTINGS_READ_FAILED};

    fn flags() -> Result<[bool; 3], AppError> {
        McpSettings::read().map(|settings| [settings.browser, settings.project, settings.workspace])
    }

    #[tokio::test]
    async fn only_absent_and_explicitly_enabled_mcp_settings_allow_attachment() {
        let path = settings_store::paths::global_file(&settings_store::global_dir());
        assert_eq!(flags().unwrap(), [true; 3]);

        std::fs::create_dir(&path).unwrap();
        assert_eq!(flags().unwrap_err().code(), SETTINGS_READ_FAILED);
        std::fs::remove_dir(&path).unwrap();
        std::fs::write(&path, "{ broken").unwrap();
        assert_eq!(flags().unwrap_err().code(), SETTINGS_INVALID);

        std::fs::write(&path, "{}").unwrap();
        for (index, key) in [
            BROWSER_MCP_ENABLED_SETTING_KEY,
            PROJECT_MCP_ENABLED_SETTING_KEY,
            WORKSPACE_MCP_ENABLED_SETTING_KEY,
        ]
        .into_iter()
        .enumerate()
        {
            settings_store::global_set(key, "invalid").await.unwrap();
            assert_eq!(flags().unwrap_err().code(), SETTINGS_INVALID);
            settings_store::global_set(key, "false").await.unwrap();
            let mut expected = [true; 3];
            expected[index] = false;
            assert_eq!(flags().unwrap(), expected);
            settings_store::global_set(key, "true").await.unwrap();
            assert_eq!(flags().unwrap(), [true; 3]);
        }
    }
}
