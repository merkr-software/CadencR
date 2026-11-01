import { Bot, Boxes, Palette, PanelTop, type LucideIcon } from "lucide-react";
import { PLUGIN_KINDS, type ListingKind } from "@/lib/marketplace-listings";

interface KindMeta {
  label: string;
  plural: string;
  icon: LucideIcon;
  /** CSS class carrying the kind's tone (`--mp-kind`), see marketplace.css. */
  tone: string;
  /** One line on what installing this kind does to Cadencr. */
  pitch: string;
}

/**
 * Display order is user-visible: the order kinds appear in filters and shelves.
 * A plugin is no shelf of its own: it sits on the shelf of every kind it adds.
 */
export const KIND_ORDER = PLUGIN_KINDS;

export const KINDS: Record<ListingKind, KindMeta> = {
  plugin: {
    label: "Plugin",
    plural: "Plugins",
    icon: Boxes,
    tone: "mp-kind-plugin",
    pitch: "Several contributions in one release, installed and updated together.",
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
};
