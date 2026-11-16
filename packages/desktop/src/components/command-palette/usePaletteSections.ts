import { useMemo } from "react";
import type { MessageSearchHit } from "@/api/generated";
import { MESSAGE_SEARCH_MIN_CHARS, type PaletteMode } from "@/lib/command-palette/palette-query";
import {
  commandEntry,
  emptyStateSections,
  rankCommands,
  rankConversations,
  rankProjects,
  type RankContext,
} from "@/lib/command-palette/palette-ranking";
import { queryTokens } from "@/lib/command-palette/palette-score";
import type { PaletteCommandGroup } from "@/lib/command-palette/palette-shortcut-commands";
import type {
  FileEntry,
  MessageEntry,
  PaletteCommand,
  PaletteSection,
} from "@/lib/command-palette/palette-types";
import type { FileHit, PaletteSources, RemoteResults } from "./usePaletteData";
import type { PaletteCommandSet } from "./usePaletteCommands";

const GROUP_ORDER: readonly PaletteCommandGroup[] = [
  "Create",
  "Navigate",
  "Conversation",
  "Git",
  "Agent",
  "View",
  "Settings",
];

function commandSectionsByGroup(commands: readonly PaletteCommand[]): PaletteSection[] {
  return GROUP_ORDER.map((group) => ({
    id: `group-${group}`,
    title: group,
    entries: commands
      .filter((command) => command.group === group)
      .map((command) => commandEntry(command)),
  })).filter((section) => section.entries.length > 0);
}

const messageEntries = (hits: readonly MessageSearchHit[]): MessageEntry[] =>
  hits.map((hit) => ({ kind: "message", key: `message:${hit.message_id}`, hit }));

const fileEntries = (hits: readonly FileHit[]): FileEntry[] =>
  hits.map((hit) => ({
    kind: "file",
    key: `file:${hit.path}`,
    path: hit.path,
    positions: hit.positions,
  }));

function remoteSection<T>(
  id: string,
  title: string,
  results: RemoteResults<T>,
  toEntries: (items: readonly T[]) => PaletteSection["entries"],
): PaletteSection {
  return {
    id,
    title,
    entries: toEntries(results.items),
    loading: results.loading ? "spinner" : undefined,
    error: results.error ?? undefined,
  };
}

function conversationsState(sources: PaletteSources): Pick<PaletteSection, "loading" | "error"> {
  return {
    loading: sources.conversationsLoading ? "skeleton" : undefined,
    error: sources.conversationsError ?? undefined,
  };
}

/**
 * Conversations, projects and commands ordered by how well their best row
 * matched, so "commit" leads with the command.
 */
function rankedSections(
  tokens: readonly string[],
  sources: PaletteSources,
  commands: PaletteCommandSet,
  context: RankContext,
): PaletteSection[] {
  const conversations = rankConversations(tokens, sources.conversations, context, 12);
  const projects = rankProjects(tokens, sources.projects, sources.conversations, 4);
  const commandHits = rankCommands(tokens, commands.all, context, 6);
  return [
    {
      top: conversations.top,
      section: {
        id: "conversations",
        title: "Conversations",
        entries: conversations.entries,
        ...conversationsState(sources),
      },
    },
    {
      top: projects.top,
      section: { id: "projects", title: "Projects", entries: projects.entries },
    },
    {
      top: commandHits.top,
      section: { id: "commands", title: "Commands", entries: commandHits.entries },
    },
  ]
    .sort((a, b) => b.top - a.top)
    .map(({ section }) => section);
}

/** What is searched in memory: recomputed on typing, never when a request settles. */
function localSections(
  mode: PaletteMode,
  tokens: readonly string[],
  sources: PaletteSources,
  commands: PaletteCommandSet,
  context: RankContext,
): PaletteSection[] {
  if (mode === "commands") {
    return tokens.length === 0
      ? commandSectionsByGroup(commands.all)
      : [
          {
            id: "commands",
            title: "Commands",
            entries: rankCommands(tokens, commands.all, context, 40).entries,
          },
        ];
  }
  if (mode !== "all") return [];
  if (tokens.length > 0) return rankedSections(tokens, sources, commands, context);
  const empty = emptyStateSections(
    {
      conversations: sources.conversations,
      nextActions: sources.nextActions,
      suggestions: commands.suggestions,
    },
    context,
  );
  // Nothing to show yet: a skeleton (or the error) where Recent will be.
  if (
    sources.conversations.length === 0 &&
    (sources.conversationsLoading || sources.conversationsError)
  ) {
    return [
      { id: "recent", title: "Recent", entries: [], ...conversationsState(sources) },
      ...empty,
    ];
  }
  return empty;
}

interface SectionInputs {
  mode: PaletteMode;
  text: string;
  context: RankContext;
  sources: PaletteSources;
  commands: PaletteCommandSet;
  messages: RemoteResults<MessageSearchHit>;
  files: RemoteResults<FileHit>;
}

/**
 * The search's result groups. Files and message hits arrive later and go
 * below the local groups, so they never shift the rows the user is aiming at.
 */
export function usePaletteSections(inputs: SectionInputs): PaletteSection[] {
  const { mode, text, context, sources, commands, messages, files } = inputs;
  const tokens = useMemo(() => queryTokens(text), [text]);
  const local = useMemo(
    () => localSections(mode, tokens, sources, commands, context),
    [commands, context, mode, sources, tokens],
  );
  return useMemo(() => {
    if (mode === "files") return [remoteSection("files", "Files", files, fileEntries)];
    if (mode === "messages")
      return [remoteSection("messages", "Messages", messages, messageEntries)];
    if (mode !== "all" || tokens.length === 0) return local;
    const sections = [...local];
    if (context.activeFeatureId != null)
      sections.push(remoteSection("files", "Files", files, fileEntries));
    if (text.trim().length >= MESSAGE_SEARCH_MIN_CHARS) {
      sections.push(remoteSection("messages", "In messages", messages, messageEntries));
    }
    return sections;
  }, [context.activeFeatureId, files, local, messages, mode, text, tokens.length]);
}
