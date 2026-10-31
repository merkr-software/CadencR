import type { ReactNode } from "react";
import type { LucideIcon } from "lucide-react";

import type { ShortcutId } from "@/lib/shortcuts/registry";
import type { BuiltinTabKind, PluginTabKind, TabKind } from "@/stores/feature-layout-schema";

/**
 * Per-tab metadata supplied by ws-session consumers.
 *
 * The `content` is mounted exactly once at the top of `<FeatureLayoutShell>`
 * and projected via `createPortal` into whichever pane currently hosts it —
 * hence the runtime guarantee that PTY/CodeMirror/agent-WS state survive
 * pane moves.
 */
interface FeatureTabDefBase {
  label: string;
  /** Optional badge rendered inside the tab trigger (git stats, terminal pane count, …). */
  badge?: ReactNode;
  /** Registry shortcut whose live binding the tab tooltip shows (rebinds included). */
  shortcutId?: ShortcutId;
  /** Tab body. Rendered once; portaled into the active pane. */
  content: ReactNode;
  /**
   * Show an X on the trigger that takes the tab out of the layout
   * (`removeTab`). Plugin tabs set it; built-ins never do — their X in a
   * floating pane docks them back to the root strip instead.
   */
  closable?: boolean;
}

/**
 * Exactly one icon source: a lucide component (built-ins), or a ready-made
 * node (plugin tabs: an SVG mask of the manifest icon), rendered inside a
 * `size-4` box. See `FeatureTabIcon`.
 */
type FeatureTabIconSource =
  | { Icon: LucideIcon; iconNode?: never }
  | { Icon?: never; iconNode: ReactNode };

export type FeatureTabDef = FeatureTabDefBase & FeatureTabIconSource;

/**
 * Every built-in is always provided; a plugin tab has an entry only while its
 * plugin is available. Layout tabs without an entry are hidden, not dropped.
 */
export type FeatureTabs = Record<BuiltinTabKind, FeatureTabDef> &
  Partial<Record<PluginTabKind, FeatureTabDef>>;

export interface FeatureTabActivationHandlers {
  onTerminalActivate?: () => void;
  onEditorActivate?: () => void;
}

export type DragSource = { kind: "pane"; paneId: string; tab: TabKind };

export type DropTarget =
  | { kind: "pane-edge"; paneId: string; edge: "top" | "right" | "bottom" | "left" }
  | { kind: "pane-strip"; paneId: string };
