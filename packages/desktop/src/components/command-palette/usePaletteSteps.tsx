import { useEffect, useMemo, useRef } from "react";
import {
  BanIcon,
  FolderGit2Icon,
  GitBranchIcon,
  MessageSquarePlusIcon,
  PaletteIcon,
} from "lucide-react";
import {
  useGetProjectSettings,
  useListBranches,
  type ConversationIndexEntry,
  type Project,
} from "@/api/generated";
import { useTheme } from "@/hooks/useTheme";
import { apiErrorMessage } from "@/lib/api-errors";
import {
  commandEntry,
  commandKey,
  listProjects,
  rankCommands,
  rankProjects,
  type RankContext,
} from "@/lib/command-palette/palette-ranking";
import { queryTokens } from "@/lib/command-palette/palette-score";
import type {
  PaletteCommand,
  PaletteSection,
  PaletteStep,
} from "@/lib/command-palette/palette-types";
import { defaultWorktreeModeFromSettings } from "@/lib/default-worktree-mode";
import { allThemes, applyThemeToDocument, type ThemeDefinition, type ThemeId } from "@/lib/themes";
import type { PaletteOperations, WorktreePick } from "./usePaletteOperations";

export interface StepView {
  chip: { icon: React.ReactNode; label: string };
  placeholder: string;
  sections: PaletteSection[];
}

/** Commands ranked by `text`, or in their own order when it is empty. */
function filtered(text: string, commands: readonly PaletteCommand[], context: RankContext) {
  const tokens = queryTokens(text);
  return tokens.length === 0
    ? commands.map((command) => commandEntry(command))
    : rankCommands(tokens, commands, context, 60).entries;
}

function projectStep(
  text: string,
  projects: readonly Project[],
  conversations: readonly ConversationIndexEntry[],
  activeProjectId: number | null,
): StepView {
  const ordered = [
    ...projects.filter((project) => project.id === activeProjectId),
    ...projects.filter((project) => project.id !== activeProjectId),
  ];
  const tokens = queryTokens(text);
  const entries =
    tokens.length > 0
      ? rankProjects(tokens, ordered, conversations, 50).entries
      : listProjects(ordered, conversations);
  return {
    chip: { icon: <MessageSquarePlusIcon />, label: "New conversation" },
    placeholder: "Which project?",
    sections: [{ id: "projects", title: "Projects", entries }],
  };
}

function useWorktreeStep(
  step: PaletteStep | null,
  text: string,
  projects: readonly Project[],
  ops: PaletteOperations,
  context: RankContext,
): StepView | null {
  const projectId = step?.kind === "worktree" ? step.projectId : null;
  const settings = useGetProjectSettings(projectId ?? 0, { query: { enabled: projectId != null } });
  const branches = useListBranches(
    { project_id: projectId ?? 0 },
    { query: { enabled: projectId != null } },
  );
  return useMemo(() => {
    if (projectId == null) return null;
    const project = projects.find((candidate) => candidate.id === projectId);
    const projectDefault = defaultWorktreeModeFromSettings(settings.data);
    const create = (worktree: WorktreePick) => () =>
      ops.createConversation({ projectId, worktree, projectDefault });
    const modes: PaletteCommand[] = [
      {
        id: "wt-new",
        title: projectDefault === "new" ? "New worktree (usual)" : "New worktree",
        group: "Create",
        icon: <FolderGit2Icon />,
        keywords: ["branch", "isolated", "fresh"],
        description:
          "A fresh branch in its own worktree: the agent's changes stay off your checkout.",
        run: create({ mode: "new" }),
      },
      {
        id: "wt-skip",
        title: projectDefault === "skip" ? "Project directory (usual)" : "Project directory",
        group: "Create",
        icon: <BanIcon />,
        keywords: ["no worktree", "in place", "checkout"],
        description: "Runs in the project's own checkout, on whatever branch it is on.",
        run: create({ mode: "skip" }),
      },
    ];
    const local = (branches.data ?? []).filter((branch) => branch.is_local);
    const branchCommands: PaletteCommand[] = local.map((branch) => ({
      id: `wt-branch-${branch.name}`,
      title: branch.name,
      group: "Create",
      icon: <GitBranchIcon />,
      keywords: ["reuse", "existing", "branch"],
      description:
        branch.attached_feature_id != null
          ? `Attaches a worktree to this branch. Conversation #${branch.attached_feature_id} already uses it.`
          : "Attaches a worktree to this existing local branch.",
      run: create({ mode: "reuse", branch: branch.name }),
    }));
    return {
      chip: { icon: <MessageSquarePlusIcon />, label: project?.name ?? "New conversation" },
      placeholder: "Where should it work? Type to find a branch…",
      sections: [
        { id: "worktree", title: "Working copy", entries: filtered(text, modes, context) },
        {
          id: "branches",
          title: "Reuse a local branch",
          entries: filtered(text, branchCommands, context),
          loading: branches.isPending ? "spinner" : undefined,
          error: branches.error
            ? apiErrorMessage(branches.error, "Couldn't list branches")
            : undefined,
        },
      ],
    };
  }, [
    branches.data,
    branches.error,
    branches.isPending,
    context,
    ops,
    projectId,
    projects,
    settings.data,
    text,
  ]);
}

/** Icon-sized color stripes; the picker's `ThemeSwatch` is a card. */
function ThemeStripes({ theme }: { theme: ThemeDefinition }) {
  const { background, foreground, primary, accent } = theme.swatch;
  return (
    <span className="cp-theme-swatch" aria-hidden>
      {[background, accent, primary, foreground].map((color, index) => (
        <span key={index} style={{ background: color }} />
      ))}
    </span>
  );
}

/**
 * The theme list, previewed live as the selection moves; leaving without a
 * pick puts the active theme back.
 */
function useThemeStep(
  active: boolean,
  text: string,
  selectedKey: string,
  context: RankContext,
): StepView | null {
  const theme = useTheme();
  const activeThemeRef = useRef(theme.themeId);
  activeThemeRef.current = theme.themeId;
  const themes = useMemo(() => (active ? allThemes() : []), [active]);
  const commands = useMemo<PaletteCommand[]>(
    () =>
      themes.map((definition) => ({
        id: `theme-${definition.id}`,
        title: definition.id === theme.themeId ? `${definition.label} (current)` : definition.label,
        group: "View",
        icon: <ThemeStripes theme={definition} />,
        keywords: [definition.appearance],
        description: `${definition.appearance === "dark" ? "Dark" : "Light"} theme.${
          theme.followSystemTheme ? " Picking it stops following the system appearance." : ""
        }`,
        run: () => {
          if (theme.followSystemTheme) theme.setFollowSystemTheme(false);
          theme.setTheme(definition.id as ThemeId);
        },
      })),
    [theme, themes],
  );
  const previewByKey = useMemo(
    () =>
      new Map(
        themes.map((definition) => [
          commandKey(`theme-${definition.id}`),
          definition.id as ThemeId,
        ]),
      ),
    [themes],
  );
  const previewId = previewByKey.get(selectedKey) ?? null;
  // A local preview while the selection moves, never written: closing the
  // palette puts the confirmed theme back, and a picked one shows once saved.
  useEffect(() => {
    if (!active || !previewId) return;
    applyThemeToDocument(previewId);
  }, [active, previewId]);
  useEffect(() => {
    if (!active) return undefined;
    return () => applyThemeToDocument(activeThemeRef.current);
  }, [active]);
  return useMemo(
    () =>
      active
        ? {
            chip: { icon: <PaletteIcon />, label: "Theme" },
            placeholder: "Find a theme…",
            sections: [
              { id: "themes", title: "Themes", entries: filtered(text, commands, context) },
            ],
          }
        : null,
    [active, commands, context, text],
  );
}

export interface PaletteStepsInput {
  step: PaletteStep | null;
  text: string;
  selectedKey: string;
  projects: readonly Project[];
  conversations: readonly ConversationIndexEntry[];
  activeProjectId: number | null;
  ops: PaletteOperations;
  context: RankContext;
}

/** The view of the current step, or `null` in the plain search. */
export function usePaletteSteps(input: PaletteStepsInput): StepView | null {
  const { step, text, projects, conversations, activeProjectId, ops, context, selectedKey } = input;
  const worktree = useWorktreeStep(step, text, projects, ops, context);
  const theme = useThemeStep(step?.kind === "theme", text, selectedKey, context);
  if (step?.kind === "new-conversation")
    return projectStep(text, projects, conversations, activeProjectId);
  if (step?.kind === "worktree") return worktree;
  if (step?.kind === "theme") return theme;
  return null;
}
