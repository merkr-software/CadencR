use crate::domain::agents::providers::{provider_alias_metadata, valid_provider_ids};

pub(super) fn tool_description(name: &str) -> &'static str {
    match name {
        "project_list_sessions" => "List recent CadencR sessions in the current project. Use before spawning to avoid duplicate work.",
        "project_read_session" => "Read a current-project session with pagination and filters. Use include_tool_details only when tool payloads are needed.",
        "project_read_session_tail" => "Recovery/debug read after a cursor. Followed gates and awaited replies arrive automatically; never poll a child tail in the normal orchestration flow.",
        "project_get_session_status" => "Read one recovery status snapshot. Followed agent events arrive automatically; never poll status to wait for a child.",
        "project_get_worktree_status" => "Inspect worktree path, branch, and dirty-file ownership for current-project sessions.",
        "project_find_related_sessions" => "Search same-project session history for related work before spawning or editing.",
        "project_compare_sessions" => "Compare two current-project sessions and their worktree status.",
        "project_link_sessions" => "Record an explicit relationship between current-project sessions.",
        "project_list_agent_providers" => "List canonical CadencR provider ids, models, and each model's available thinking levels for project_spawn_session.",
        "project_spawn_session" => "Create another CadencR session in a target project. Use follow to receive gates and completion reactively: these events steer the current parent turn, so do not poll status, tails, or pending gates. Spawns into the caller's own project unless project_id or project_path selects another one (call workspace_list_projects first). Use canonical provider ids and advertised thinking levels; call project_list_agent_providers when unsure.",
        "project_send_session_message" => "Send a provenance-tracked message to another current-project session. Delivery steers the active target turn by default; request next_turn explicitly only when delayed handling is intentional.",
        "project_list_pending_gates" => "Recovery only: reconcile a linked child's pending gate after a missed/stale notification. A live <cadencr-gate> already contains the complete request id, kind, options, and payload; never poll this tool.",
        "project_respond_gate" => "Answer a linked child's pending gate using the exact session id, request id, kind, and payload from the automatically delivered <cadencr-gate>.",
        _ => "Coordinate CadencR sessions in the current project.",
    }
}

pub(super) fn property_description(tool_name: &str, property: &str) -> String {
    match (tool_name, property) {
        ("project_spawn_session", "provider") => format!(
            "Canonical provider id: {}. Common aliases are normalized, but canonical ids are preferred.",
            valid_provider_ids().join(", ")
        ),
        ("project_spawn_session", "project_id") => "Target project id for the new session. Omit to spawn in the caller's own project; pass a registered id from workspace_list_projects to target another project.".into(),
        ("project_spawn_session", "project_path") => "Target project root path (alternative to project_id). It must exactly match a registered path from workspace_list_projects; if both selectors are given they must agree.".into(),
        ("project_spawn_session", "model") => model_description(),
        ("project_spawn_session", "thinking_level") => "Provider/model-specific thinking or reasoning level. Use one of the target provider/model pair's thinking_levels from project_list_agent_providers. When omitted, CadencR uses the last selection for that target provider/model, then the CLI-advertised default_thinking_level (providers driven by a configuration profile keep the profile's own level instead).".into(),
        ("project_spawn_session", "follow") => "Reactive parent subscription. When present, omitted gates/completion fields default to true. Gates, questions, permissions, and requested completion replies automatically steer the parent; do not poll. An intentional child stop is not a failure and leaves completion follow armed for a later resumed result. Use false fields only to opt out explicitly.".into(),
        ("project_spawn_session", "await_result") => "Legacy completion-follow flag. Prefer follow.completion. A requested <cadencr-reply> steers the parent automatically when the child turn ends.".into(),
        (_, "session_id") => "Target session id in the current project.".into(),
        (_, "target_session_id") => "Current-project session id receiving the operation.".into(),
        (_, "limit") => "Maximum number of rows/messages to return; tools clamp oversized values.".into(),
        (_, "cursor") => "Cursor object returned by the previous page.".into(),
        (_, "query") => "Full-text search query used to find matching messages.".into(),
        (_, "roles") => "Optional message role filters such as user, assistant, or tool.".into(),
        (_, "message_types") => "Optional message_type filters such as text, tool_call, or tool_result.".into(),
        (_, "after_message_id") => "Return messages after this message id. Recovery/debug only for followed children; do not poll.".into(),
        (_, "before_message_id") => "Return messages before this message id.".into(),
        (_, "include_tool_details") => "Include full tool payload content; omit unless needed because payloads can be large.".into(),
        (_, "include_metadata") => "Include provenance/origin metadata for returned messages.".into(),
        (_, "snippet_chars") => "Maximum characters to include in each search result snippet.".into(),
        (_, "left_session_id") => "First current-project session id to compare.".into(),
        (_, "right_session_id") => "Second current-project session id to compare.".into(),
        (_, "link_type") => "Relationship type to record between source and target sessions.".into(),
        (_, "note" | "source_note") => "Short provenance note explaining why this relationship or action exists.".into(),
        (_, "title") => "Title for the newly created session/conversation.".into(),
        (_, "initial_message") => "Initial user message sent after creation. Pass it as structured tool argument data; serialize complete arguments safely instead of interpolating this message into source code.".into(),
        (_, "permission_mode") => "Legacy/generic permission mode to persist for the spawned session.".into(),
        (_, "codex_permission_mode") => "Legacy provider access-mode compatibility field: default, autoReview, or fullAccess.".into(),
        (_, "branch") => "Worktree/branch creation options for the spawned session.".into(),
        (_, "link_to_current_session") => "Legacy gate-follow flag; prefer follow.gates. Defaults to true when follow is absent.".into(),
        _ => format!("Input parameter `{property}` for {tool_name}."),
    }
}

fn model_description() -> String {
    let guidance = valid_provider_ids()
        .into_iter()
        .filter_map(|provider_id| provider_alias_metadata(&provider_id))
        .map(|metadata| format!("{}: {}", metadata.provider_id, metadata.model_guidance))
        .collect::<Vec<_>>()
        .join(" ");
    format!("Provider-specific model id. {guidance} Call project_list_agent_providers when unsure.")
}
