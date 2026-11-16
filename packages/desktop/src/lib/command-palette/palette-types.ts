import type { ReactNode } from "react";
import type { ConversationIndexEntry, MessageSearchHit, Project } from "@/api/generated";
import type { NextActionKind } from "@/lib/next-actions";
import type { AttentionState } from "@/lib/sidebar-attention";
import type { ShortcutId } from "@/lib/shortcuts/registry";
import type { PrefixMode } from "./palette-query";
import type { MatchRange } from "./palette-score";
import type { PaletteCommandGroup } from "./palette-shortcut-commands";

/** A sub-view the palette can switch to instead of closing. */
export type PaletteStep =
  | { kind: "new-conversation" }
  | { kind: "worktree"; projectId: number }
  | { kind: "theme" };

export interface PaletteCommand {
  /** Stable id, unique across commands. */
  id: string;
  title: string;
  group: PaletteCommandGroup;
  /** A 16px glyph element. */
  icon: ReactNode;
  keywords?: readonly string[];
  /** Shortcut whose live binding the row shows. */
  shortcutId?: ShortcutId;
  /** One line for the preview pane. */
  description?: string;
  /** Runs once the palette has closed and handed focus back. */
  run?: () => void | Promise<void>;
  /** Opens a sub-view instead of closing. */
  step?: PaletteStep;
  /** Runs inside the palette, which stays open (widen the scope…). */
  stay?: () => void;
  /** Switches the palette's search mode, keeping it open. */
  mode?: PrefixMode;
}

export interface ConversationEntry {
  kind: "conversation";
  key: string;
  conversation: ConversationIndexEntry;
  attention: AttentionState;
  /** Set in the "Needs you" section: what to do there. */
  nextAction?: NextActionKind;
  ranges: readonly MatchRange[];
}

export interface ProjectEntry {
  kind: "project";
  key: string;
  project: Project;
  activeCount: number;
  archivedCount: number;
  ranges: readonly MatchRange[];
}

export interface CommandEntry {
  kind: "command";
  key: string;
  command: PaletteCommand;
  ranges: readonly MatchRange[];
}

export interface FileEntry {
  kind: "file";
  key: string;
  path: string;
  /** Matched character indexes in `path`. */
  positions: readonly number[];
}

export interface MessageEntry {
  kind: "message";
  key: string;
  hit: MessageSearchHit;
}

export type PaletteEntry =
  | ConversationEntry
  | ProjectEntry
  | CommandEntry
  | FileEntry
  | MessageEntry;

export interface PaletteSection {
  id: string;
  title: string;
  entries: readonly PaletteEntry[];
  /**
   * Rows still on their way: skeleton rows while a whole list loads, a
   * "Searching…" line while a search request runs.
   */
  loading?: "skeleton" | "spinner";
  /** Why the section is empty, shown in place of rows. */
  error?: string;
}
