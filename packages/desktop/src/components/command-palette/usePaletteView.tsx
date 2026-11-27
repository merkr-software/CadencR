import { useUiTranslation, type UiTranslator } from "@/lib/i18n/ui";
import { useCallback, useEffect, useMemo, useState, type KeyboardEvent } from "react";
import { GlobeIcon, HashIcon, ListIcon } from "lucide-react";
import { useGlobalShortcutById } from "@/hooks/useShortcut";
import {
  MESSAGE_SEARCH_MIN_CHARS,
  MESSAGES_MODE_MIN_CHARS,
} from "@/lib/command-palette/palette-query";
import {
  commandEntry,
  rankCommands,
  type RankContext,
} from "@/lib/command-palette/palette-ranking";
import { queryTokens } from "@/lib/command-palette/palette-score";
import { getFileName } from "@/lib/file-language";
import type {
  PaletteCommand,
  PaletteEntry,
  PaletteSection,
} from "@/lib/command-palette/palette-types";
import { itemActions } from "./palette-item-actions";
import { MODE_ICON, modeLabel } from "./PaletteInputRow";
import { usePaletteCommands } from "./usePaletteCommands";
import {
  usePaletteFiles,
  usePaletteFrecency,
  usePaletteMessages,
  usePaletteSources,
} from "./usePaletteData";
import { usePaletteFlow, type PaletteFlow } from "./usePaletteFlow";
import { usePaletteOperations } from "./usePaletteOperations";
import { usePaletteSections } from "./usePaletteSections";
import { usePaletteSteps } from "./usePaletteSteps";

export interface PaletteSurfaceProps {
  activeProjectId: number | null;
  activeFeatureId: number | null;
  finish: (action?: () => void) => void;
  /** Lets the dialog's Esc step back instead of closing; returns whether it did. */
  backRef: React.MutableRefObject<(() => boolean) | null>;
}

/** Rows offered when nothing matched: other places to look. */
function fallbackCommands(flow: PaletteFlow, t: UiTranslator): PaletteCommand[] {
  const text = flow.text.trim();
  const commands: PaletteCommand[] = [];
  if (flow.view.kind !== "search" || text.length === 0) return commands;
  if (flow.mode !== "messages" && text.length >= MESSAGE_SEARCH_MIN_CHARS) {
    commands.push({
      id: "fallback-messages",
      title: t("palette.fallback.messages.title", "Search messages for “{{query}}”", {
        query: text,
      }),
      group: "Navigate",
      icon: <HashIcon />,
      description: t(
        "palette.fallback.messages.description",
        "Look for these words in prompts and replies, archives included.",
      ),
      stay: () => flow.setMode("messages", text),
    });
  }
  if (flow.scope !== "all") {
    commands.push({
      id: "fallback-scope",
      title: t("palette.fallback.everything.title", "Search everything"),
      group: "Navigate",
      icon: <GlobeIcon />,
      description: t(
        "palette.fallback.everything.description",
        "Every project and archived conversations too.",
      ),
      stay: () => flow.setScope("all"),
    });
  }
  return commands;
}

function useSurfaceData(props: PaletteSurfaceProps) {
  const sources = usePaletteSources();
  const { frecency, recordUse } = usePaletteFrecency();
  const ops = usePaletteOperations(props.activeFeatureId);
  const flow = usePaletteFlow({
    ops,
    activeFeatureId: props.activeFeatureId,
    conversations: sources.conversations,
    recordUse,
    finish: props.finish,
  });
  const commandContext = useMemo(
    () => ({
      activeProjectId: props.activeProjectId,
      activeFeatureId: props.activeFeatureId,
      projects: sources.projects,
      createConversation: (projectId: number) => void ops.createConversation({ projectId }),
      addProject: () => void ops.addProject(),
      installCli: () => void ops.installCli(),
    }),
    [ops, props.activeFeatureId, props.activeProjectId, sources.projects],
  );
  const commands = usePaletteCommands(commandContext);
  const searching = flow.view.kind === "search";
  const messages = usePaletteMessages(flow.text, {
    enabled: searching && (flow.mode === "messages" || flow.mode === "all"),
    minChars: flow.mode === "messages" ? MESSAGES_MODE_MIN_CHARS : MESSAGE_SEARCH_MIN_CHARS,
    scope: flow.scope,
    projectId: props.activeProjectId,
    limit: flow.mode === "messages" ? 25 : 6,
  });
  const files = usePaletteFiles(flow.text, {
    enabled:
      searching &&
      props.activeFeatureId != null &&
      (flow.mode === "files" || (flow.mode === "all" && flow.text.trim().length >= 2)),
    projectId: props.activeProjectId,
    featureId: props.activeFeatureId,
    limit: flow.mode === "files" ? 40 : 4,
  });
  return { sources, frecency, ops, flow, commands, messages, files };
}

export function usePaletteView(props: PaletteSurfaceProps) {
  const { t } = useUiTranslation();
  const { sources, frecency, ops, flow, commands, messages, files } = useSurfaceData(props);
  const [now] = useState(() => Date.now());
  const rankContext = useMemo<RankContext>(
    () => ({
      now,
      activeProjectId: props.activeProjectId,
      activeFeatureId: props.activeFeatureId,
      scope: flow.scope,
      frecency,
      attention: sources.attention,
      projectNames: sources.projectNames,
    }),
    [
      flow.scope,
      frecency,
      now,
      props.activeFeatureId,
      props.activeProjectId,
      sources.attention,
      sources.projectNames,
    ],
  );
  const searchSections = usePaletteSections({
    mode: flow.mode,
    text: flow.text,
    context: rankContext,
    sources,
    commands,
    messages,
    files,
  });
  const stepView = usePaletteSteps({
    step: flow.view.kind === "step" ? flow.view.step : null,
    text: flow.text,
    selectedKey: flow.selectedKey,
    projects: sources.projects,
    conversations: sources.conversations,
    activeProjectId: props.activeProjectId,
    ops,
    context: rankContext,
  });
  const actionView = useActionView(
    flow,
    ops,
    props.activeFeatureId,
    sources.conversations,
    rankContext,
  );
  const sections: readonly PaletteSection[] =
    flow.view.kind === "actions" ? actionView : (stepView?.sections ?? searchSections);

  const fallback = useMemo(
    () => fallbackCommands(flow, t).map((command) => commandEntry(command)),
    [flow, t],
  );
  const { selectedKey, selected } = useSelection(sections, fallback, flow.selectedKey);
  useEffect(() => {
    props.backRef.current = flow.back;
  }, [flow.back, props.backRef]);

  const onKeyDown = usePaletteKeys(flow, selected, props.activeProjectId);
  const chip =
    flow.view.kind === "actions"
      ? { icon: <ListIcon />, label: entryLabel(flow.view.entry) }
      : (stepView?.chip ??
        (flow.mode === "all"
          ? null
          : { icon: MODE_ICON[flow.mode], label: modeLabel(flow.mode, t) }));
  const scopeApplies =
    flow.view.kind === "search" && (flow.mode === "all" || flow.mode === "messages");
  const empty = emptyCopy(flow, props.activeFeatureId != null, t);
  return {
    sources,
    flow,
    now,
    sections,
    fallback,
    selectedKey,
    selected,
    onKeyDown,
    chip,
    placeholder: placeholderFor(flow, stepView?.placeholder, t),
    scope: scopeApplies ? flow.scope : null,
    empty,
  };
}

/** Tab opens the selection's actions, ⌥S cycles the scope, Backspace in an empty field steps back. */
function usePaletteKeys(
  flow: PaletteFlow,
  selected: PaletteEntry | null,
  activeProjectId: number | null,
) {
  useGlobalShortcutById(
    "palette-actions",
    (event) => {
      event.preventDefault();
      if (selected && flow.view.kind === "search")
        flow.push({ kind: "actions", entry: selected, query: flow.text.trim() });
    },
    { enabled: flow.view.kind === "search" },
  );
  useGlobalShortcutById(
    "palette-scope",
    (event) => {
      event.preventDefault();
      flow.cycleScope(activeProjectId != null);
    },
    { enabled: flow.view.kind === "search" },
  );

  const onKeyDown = useCallback(
    (event: KeyboardEvent<HTMLInputElement>) => {
      if (event.key === "Backspace" && event.currentTarget.value === "" && flow.back())
        event.preventDefault();
    },
    [flow],
  );
  return onKeyDown;
}

/**
 * The selected row: the one the user moved to while it is still listed, else
 * the first row (results changed under it).
 */
function useSelection(
  sections: readonly PaletteSection[],
  fallback: readonly PaletteEntry[],
  wanted: string,
): { selectedKey: string; selected: PaletteEntry | null } {
  return useMemo(() => {
    const byKey = new Map<string, PaletteEntry>();
    for (const section of sections)
      for (const entry of section.entries) byKey.set(entry.key, entry);
    for (const entry of fallback) if (!byKey.has(entry.key)) byKey.set(entry.key, entry);
    const first =
      sections.find((section) => section.entries.length > 0)?.entries[0] ?? fallback[0] ?? null;
    const selected = byKey.get(wanted) ?? first;
    return { selectedKey: selected?.key ?? "", selected };
  }, [fallback, sections, wanted]);
}

function useActionView(
  flow: PaletteFlow,
  ops: ReturnType<typeof usePaletteOperations>,
  activeFeatureId: number | null,
  conversations: Parameters<typeof itemActions>[1]["conversations"],
  context: RankContext,
): PaletteSection[] {
  const { t } = useUiTranslation();
  return useMemo(() => {
    if (flow.view.kind !== "actions") return [];
    const { entry, query } = flow.view;
    const actions = itemActions(entry, {
      t,
      ops,
      activeFeatureId,
      conversations,
      primary: () => flow.activate(entry, query),
    });
    const tokens = queryTokens(flow.text);
    const entries =
      tokens.length === 0
        ? actions.map((command) => commandEntry(command))
        : rankCommands(tokens, actions, context, 20).entries;
    return [{ id: "actions", title: t("palette.actions.title", "Actions"), entries }];
  }, [activeFeatureId, context, conversations, flow, ops, t]);
}

function entryLabel(entry: PaletteEntry): string {
  switch (entry.kind) {
    case "conversation":
      return entry.conversation.title;
    case "project":
      return entry.project.name;
    case "command":
      return entry.command.title;
    case "file":
      return getFileName(entry.path);
    case "message":
      return entry.hit.feature_title;
  }
}

function placeholderFor(
  flow: PaletteFlow,
  stepPlaceholder: string | undefined,
  t: UiTranslator,
): string {
  if (flow.view.kind === "actions") return t("palette.placeholder.actions", "Filter actions…");
  if (stepPlaceholder) return stepPlaceholder;
  if (flow.mode === "commands") return t("palette.placeholder.commands", "Run a command…");
  if (flow.mode === "files")
    return t("palette.placeholder.files", "Go to a file in this worktree…");
  if (flow.mode === "messages")
    return t("palette.placeholder.messages", "Find words said in any conversation…");
  return t("palette.placeholder.all", "Search conversations, projects, commands…  {{prefixes}}", {
    prefixes: "> @ #",
  });
}

function emptyCopy(
  flow: PaletteFlow,
  hasConversation: boolean,
  t: UiTranslator,
): { title: string; hint: string } {
  const text = flow.text.trim();
  if (flow.mode === "files" && !hasConversation) {
    return {
      title: t("palette.empty.noConversation.title", "No conversation open"),
      hint: t(
        "palette.empty.noConversation.hint",
        "Files are searched in the open conversation's worktree.",
      ),
    };
  }
  if (flow.mode === "messages" && text.length < MESSAGES_MODE_MIN_CHARS) {
    return {
      title: t("palette.empty.messages.title", {
        count: MESSAGES_MODE_MIN_CHARS,
        defaultValue_one: "Type at least {{count}} letter",
        defaultValue_other: "Type at least {{count}} letters",
      }),
      hint: t(
        "palette.empty.messages.hint",
        "Every word must appear; each one matches as a prefix.",
      ),
    };
  }
  if (text.length === 0)
    return {
      title: t("palette.empty.start.title", "Nothing here yet"),
      hint: t("palette.empty.start.hint", "Start a conversation and it will show up here."),
    };
  return {
    title: t("palette.empty.noMatch.title", "Nothing matches “{{query}}”", { query: text }),
    hint: t("palette.empty.noMatch.hint", "Try fewer words, or another place to look:"),
  };
}
