use serde::{Deserialize, Serialize};
use utoipa::ToSchema;

// --- Commands payloads ---

#[derive(Debug, Clone, Serialize, Deserialize, ToSchema)]
pub struct CommandsGetPayload {
    pub cwd: String,
    /// Runtime provider for the active session (e.g. `"claude_code"`,
    /// `"opencode"`). Required so command discovery is scoped to the active
    /// provider instead of falling back to shared filesystem scans.
    pub provider: String,
    #[serde(default)]
    pub profile: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, ToSchema)]
pub struct SlashCommandPayload {
    pub name: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    pub kind: SlashCommandKindPayload,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, ToSchema)]
#[serde(rename_all = "snake_case")]
pub enum SlashCommandKindPayload {
    Command,
    Skill,
    /// Cadencr virtual orchestration skill (`/cadencr:*`); rendered specially by
    /// the composer and disabled when its project MCP dependency is off.
    Cadencr,
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize, ToSchema)]
#[serde(rename_all = "snake_case")]
pub enum PromptCommandPlacementPayload {
    #[default]
    PromptStart,
    Anywhere,
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize, ToSchema)]
#[serde(rename_all = "snake_case")]
pub enum SkillReferenceTriggerPayload {
    #[default]
    Slash,
    Dollar,
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize, ToSchema)]
pub struct PromptCommandPolicyPayload {
    pub slash_command_placement: PromptCommandPlacementPayload,
    pub skill_reference_trigger: SkillReferenceTriggerPayload,
    #[serde(default)]
    pub user_shell: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, ToSchema)]
pub struct CommandsListPayload {
    pub commands: Vec<SlashCommandPayload>,
    #[serde(default)]
    pub prompt_command_policy: PromptCommandPolicyPayload,
    /// `true` when the server is currently re-resolving the catalog in
    /// the background (the FE returned cached data instantly; a fresh
    /// `commands.updated` envelope will follow when the probe
    /// completes). The FE renders a small spinner / loader while this
    /// is set so the user knows the picker is being refreshed.
    #[serde(default)]
    pub refreshing: bool,
    /// Why the provider's own commands are missing from `commands` (its
    /// discovery failed or timed out). Shown in the `/` menu.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

/// Server → Client: live slash-command catalog the agent advertised
/// over the runtime stream (today: ACP `available_commands_update`).
///
/// Emitted whenever a `RuntimeEventKind::SlashCommandsUpdated` arrives
/// on a session's runtime channel. The full catalog is sent every time
/// — frontends should replace, not merge.
#[derive(Debug, Clone, Serialize, Deserialize, ToSchema)]
pub struct CommandsUpdatedPayload {
    pub commands: Vec<SlashCommandPayload>,
    /// Same as the `error` of `CommandsListPayload`; absent on live pushes.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}
