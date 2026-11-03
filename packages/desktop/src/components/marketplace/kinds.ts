import {
  Code2,
  Bot,
  Boxes,
  Palette,
  PanelTop,
  Plug,
  ScrollText,
  type LucideIcon,
} from "lucide-react";
import { PLUGIN_KINDS, type ListingKind } from "@/lib/marketplace-listings";
import { AGENT_EXTENSION_KINDS, type AgentExtensionKind } from "@/lib/agent-extensions";

interface KindMeta {
  label: string;
  plural: string;
  icon: LucideIcon;
  /** CSS class carrying the kind's tone (`--mp-kind`), see marketplace.css. */
  tone: string;
  /** One line on what installing this kind does. */
  pitch: string;
}

export type MarketplaceKind = ListingKind | AgentExtensionKind;

/**
 * Display order is user-visible: the order kinds appear in filters and shelves.
 * A plugin is no shelf of its own: it sits on the shelf of every kind it adds.
 */
export const KIND_ORDER = PLUGIN_KINDS;
/** Kinds installed into the agent CLIs, shown after Cadencr's own plugin kinds. */
export const AGENT_KIND_ORDER = AGENT_EXTENSION_KINDS;

export const KINDS: Record<MarketplaceKind, KindMeta> = {
  plugin: {
    label: "Plugin",
    plural: "Plugins",
    icon: Boxes,
    tone: "mp-kind-plugin",
    pitch: "Several contributions in one release, installed and updated together.",
  },
  lsp: {
    label: "Language server",
    plural: "Language servers",
    icon: Code2,
    tone: "mp-kind-lsp",
    pitch: "Add completions, navigation and diagnostics for your project languages.",
  },
  tab: {
    label: "Custom tab",
    plural: "Custom tabs",
    icon: PanelTop,
    tone: "mp-kind-tab",
    pitch: "Add a workspace tab with a sandboxed web interface and permissions you control.",
  },
  theme: {
    label: "Theme",
    plural: "Themes",
    icon: Palette,
    tone: "mp-kind-theme",
    pitch: "Recolor every surface of Cadencr. Declarative colors only — no code runs.",
  },
  provider: {
    label: "Provider",
    plural: "Providers",
    icon: Bot,
    tone: "mp-kind-provider",
    pitch: "Bring another coding agent into Cadencr over ACP. Runs a verified executable.",
  },
  skill: {
    label: "Skill",
    plural: "Skills",
    icon: ScrollText,
    tone: "mp-kind-skill",
    pitch: "Skill packs from each agent CLI's own plugin marketplaces, installed by that CLI.",
  },
  mcp: {
    label: "MCP server",
    plural: "MCP servers",
    icon: Plug,
    tone: "mp-kind-mcp",
    pitch:
      "Servers from the official MCP Registry, added to the agent CLIs you pick with their own commands.",
  },
};
