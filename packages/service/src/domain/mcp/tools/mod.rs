pub mod audit;
pub mod browser;
pub mod browser_bridge;
pub mod helpers;
pub mod messages;
pub mod project;
pub mod project_compare;
pub mod project_control;
pub mod project_links;
pub mod project_list;
pub mod project_search;
pub mod project_tail;
pub mod project_worktree;
pub mod session_graph;
pub mod workspace;
pub mod workspace_activity;
pub mod workspace_projects;

// Reserved for the future `cadencr-workspace` MCP server. These conversation
// tools are intentionally disabled in `cadencr-browser` until that server
// exists.
pub mod list_conversations;
pub mod read_conversation;
