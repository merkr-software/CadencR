import { Plug, Network } from "lucide-react";
import { AgentIcon } from "@/components/AgentIcon";
import { SETTINGS_ANCHORS as A } from "./settings-anchor-ids";
import {
  settingsIcon,
  settingsKeywords,
  settingsLabel,
  type SettingsNavGroup,
  type SettingsPageMeta,
  type SettingsTranslator,
} from "./settings-catalog-types";

export function agentsSettings(t: SettingsTranslator): SettingsNavGroup {
  return {
    ...settingsLabel(t, "settings.nav.groups.agents", "Agents"),
    pages: [agentsPage(t), providersPage(t), mcpPage(t)],
  };
}

function agentsPage(t: SettingsTranslator): SettingsPageMeta {
  return {
    id: "agents",
    label: "Agents",
    icon: settingsIcon(AgentIcon),
    description:
      "What applies to every agent, whichever provider runs it. New conversations start on the model you last used; switch it from the composer.",
    aliases: ["auto-naming"],
    entries: [
      {
        ...settingsLabel(
          t,
          "settings.nav.agents.entries.conversation-names.label",
          "Conversation names",
        ),
        anchor: A.autoNaming,
        keywords: settingsKeywords(
          t,
          "settings.nav.agents.entries.conversation-names.keywords",
          "auto-naming, title, naming model, naming prompt",
        ),
      },
    ],
  };
}

function providersPage(t: SettingsTranslator): SettingsPageMeta {
  return {
    id: "providers",
    label: "Providers",
    icon: settingsIcon(Plug),
    description:
      "The agent CLIs Cadencr runs: their versions, which install is used, profiles, models and permissions.",
    entries: [
      {
        ...settingsLabel(
          t,
          "settings.nav.providers.entries.provider-versions-updates.label",
          "Provider versions & updates",
        ),
        keywords: settingsKeywords(
          t,
          "settings.nav.providers.entries.provider-versions-updates.keywords",
          "upgrade, cli version",
        ),
      },
      {
        ...settingsLabel(t, "settings.nav.providers.entries.claude-code.label", "Claude Code"),
        anchor: A.providerConfig,
        keywords: settingsKeywords(
          t,
          "settings.nav.providers.entries.claude-code.keywords",
          "profiles, custom models, bypass permissions, binary",
        ),
      },
      {
        ...settingsLabel(t, "settings.nav.providers.entries.codex.label", "Codex"),
        anchor: A.providerConfig,
        keywords: settingsKeywords(
          t,
          "settings.nav.providers.entries.codex.keywords",
          "profiles, access mode",
        ),
      },
      {
        ...settingsLabel(t, "settings.nav.providers.entries.opencode.label", "OpenCode"),
        anchor: A.providerConfig,
        keywords: settingsKeywords(t, "settings.nav.providers.entries.opencode.keywords", "binary"),
      },
      {
        ...settingsLabel(
          t,
          "settings.nav.providers.entries.installed-providers.label",
          "Installed providers",
        ),
        anchor: A.providerConfig,
        keywords: settingsKeywords(
          t,
          "settings.nav.providers.entries.installed-providers.keywords",
          "connector, plugin, access mode",
        ),
      },
      {
        ...settingsLabel(
          t,
          "settings.nav.providers.entries.build-a-provider-connector.label",
          "Build a provider connector",
        ),
        anchor: A.providerConnector,
        keywords: settingsKeywords(
          t,
          "settings.nav.providers.entries.build-a-provider-connector.keywords",
          "acp, plugin, developer",
        ),
      },
    ],
  };
}

function mcpPage(t: SettingsTranslator): SettingsPageMeta {
  return {
    id: "mcp",
    label: "MCP servers",
    icon: settingsIcon(Network),
    description:
      "Cadencr's own tool servers, offered to every agent you run. A change takes effect on the agent's next turn.",
    entries: [
      {
        ...settingsLabel(
          t,
          "settings.nav.mcp.entries.browser-tools-for-agents.label",
          "Browser tools for agents",
        ),
        keywords: settingsKeywords(
          t,
          "settings.nav.mcp.entries.browser-tools-for-agents.keywords",
          "cadencr-browser, mcp",
        ),
      },
      {
        ...settingsLabel(
          t,
          "settings.nav.mcp.entries.project-coordination-for-agents.label",
          "Project coordination for agents",
        ),
        keywords: settingsKeywords(
          t,
          "settings.nav.mcp.entries.project-coordination-for-agents.keywords",
          "cadencr-project, spawn",
        ),
      },
      {
        ...settingsLabel(
          t,
          "settings.nav.mcp.entries.workspace-memory-for-agents.label",
          "Workspace memory for agents",
        ),
        keywords: settingsKeywords(
          t,
          "settings.nav.mcp.entries.workspace-memory-for-agents.keywords",
          "cadencr-workspace, history",
        ),
      },
    ],
  };
}
