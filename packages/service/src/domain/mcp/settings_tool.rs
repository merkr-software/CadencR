/// Which orchestration server a settings tool call comes from. The project
/// server only reaches the caller's own project; the workspace server reaches
/// any registered project by id.
#[derive(Debug, Clone, Copy)]
pub(crate) enum SettingsTool {
    Project,
    Workspace,
}

impl SettingsTool {
    pub(crate) fn server_name(self) -> &'static str {
        match self {
            Self::Project => "cadencr-project",
            Self::Workspace => "cadencr-workspace",
        }
    }

    pub(crate) fn get_tool_name(self) -> &'static str {
        match self {
            Self::Project => "project_get_settings",
            Self::Workspace => "workspace_get_settings",
        }
    }

    pub(crate) fn update_tool_name(self) -> &'static str {
        match self {
            Self::Project => "project_update_settings",
            Self::Workspace => "workspace_update_settings",
        }
    }

    pub(crate) fn read_endpoint(self) -> &'static str {
        match self {
            Self::Project => "/internal/mcp/project/settings",
            Self::Workspace => "/internal/mcp/workspace/settings",
        }
    }

    pub(crate) fn update_endpoint(self) -> &'static str {
        match self {
            Self::Project => "/internal/mcp/project/update-settings",
            Self::Workspace => "/internal/mcp/workspace/update-settings",
        }
    }

    /// The scope a read targets when the agent names none.
    pub(crate) fn default_read_scope(self) -> &'static str {
        match self {
            Self::Project => "project",
            Self::Workspace => "global",
        }
    }

    pub(crate) fn allows_cross_project(self) -> bool {
        matches!(self, Self::Workspace)
    }
}
