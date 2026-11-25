import { themeAppearanceLabel, themeDisplayLabel } from "@/lib/themes/display";
import { useUiTranslation, type UiTranslator } from "@/lib/i18n/ui";
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
import {
  defaultWorktreeModeFromSettings,
  type DefaultWorktreeMode,
} from "@/lib/default-worktree-mode";
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
  t: UiTranslator,
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
    chip: {
      icon: <MessageSquarePlusIcon />,
      label: t("palette.steps.newConversation", "New conversation"),
    },
    placeholder: t("palette.steps.projectPlaceholder", "Which project?"),
    sections: [{ id: "projects", title: t("palette.sections.projects", "Projects"), entries }],
  };
}

function worktreeModes(
  projectDefault: DefaultWorktreeMode,
  create: (worktree: WorktreePick) => () => Promise<void>,
  t: UiTranslator,
): PaletteCommand[] {
  return [
    {
      id: "wt-new",
      title:
        projectDefault === "new"
          ? t("palette.steps.worktree.newUsual", "New worktree (usual)")
          : t("palette.steps.worktree.new", "New worktree"),
      group: "Create",
      icon: <FolderGit2Icon />,
      keywords: ["branch", "isolated", "fresh"],
      description: t(
        "palette.steps.worktree.newDescription",
        "A fresh branch in its own worktree: the agent's changes stay off your checkout.",
      ),
      run: create({ mode: "new" }),
    },
    {
      id: "wt-skip",
      title:
        projectDefault === "skip"
          ? t("palette.steps.worktree.directoryUsual", "Project directory (usual)")
          : t("palette.steps.worktree.directory", "Project directory"),
      group: "Create",
      icon: <BanIcon />,
      keywords: ["no worktree", "in place", "checkout"],
      description: t(
        "palette.steps.worktree.directoryDescription",
        "Runs in the project's own checkout, on whatever branch it is on.",
      ),
      run: create({ mode: "skip" }),
    },
  ];
}

function useWorktreeStep(
  step: PaletteStep | null,
  text: string,
  projects: readonly Project[],
  ops: PaletteOperations,
  context: RankContext,
): StepView | null {
  const { t } = useUiTranslation();
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
    const modes = worktreeModes(projectDefault, create, t);
    const local = (branches.data ?? []).filter((branch) => branch.is_local);
    const branchCommands: PaletteCommand[] = local.map((branch) => ({
      id: `wt-branch-${branch.name}`,
      title: branch.name,
      group: "Create",
      icon: <GitBranchIcon />,
      keywords: ["reuse", "existing", "branch"],
      description:
        branch.attached_feature_id != null
          ? t(
              "palette.steps.worktree.attached",
              "Attaches a worktree to this branch. Conversation #{{id}} already uses it.",
              { id: branch.attached_feature_id },
            )
          : t(
              "palette.steps.worktree.reuseDescription",
              "Attaches a worktree to this existing local branch.",
            ),
      run: create({ mode: "reuse", branch: branch.name }),
    }));
    return {
      chip: {
        icon: <MessageSquarePlusIcon />,
        label: project?.name ?? t("palette.steps.newConversation", "New conversation"),
      },
      placeholder: t(
        "palette.steps.worktree.placeholder",
        "Where should it work? Type to find a branch…",
      ),
      sections: [
        {
          id: "worktree",
          title: t("palette.steps.worktree.copy", "Working copy"),
          entries: filtered(text, modes, context),
        },
        {
          id: "branches",
          title: t("palette.steps.worktree.reuse", "Reuse a local branch"),
          entries: filtered(text, branchCommands, context),
          loading: branches.isPending ? "spinner" : undefined,
          error: branches.error
            ? apiErrorMessage(
                branches.error,
                t("palette.steps.worktree.error", "Couldn't list branches"),
              )
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
    t,
    text,
  ]);
}

function themeDescription(
  appearance: ThemeDefinition["appearance"],
  followsSystem: boolean,
  t: UiTranslator,
): string {
  if (appearance === "dark") {
    return followsSystem
      ? t(
          "palette.steps.theme.darkStopsFollowing",
          "Dark theme. Picking it stops following the system appearance.",
        )
      : t("palette.steps.theme.dark", "Dark theme.");
  }
  return followsSystem
    ? t(
        "palette.steps.theme.lightStopsFollowing",
        "Light theme. Picking it stops following the system appearance.",
      )
    : t("palette.steps.theme.light", "Light theme.");
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
  const { t } = useUiTranslation();
  const theme = useTheme();
  const activeThemeRef = useRef(theme.themeId);
  activeThemeRef.current = theme.themeId;
  const themes = useMemo(() => (active ? allThemes() : []), [active]);
  const commands = useMemo<PaletteCommand[]>(
    () =>
      themes.map((definition) => {
        const label = themeDisplayLabel(definition, t);
        return {
          id: `theme-${definition.id}`,
          title:
            definition.id === theme.themeId
              ? t("palette.steps.theme.current", "{{theme}} (current)", { theme: label })
              : label,
          group: "View",
          icon: <ThemeStripes theme={definition} />,
          keywords: [
            definition.label,
            definition.appearance,
            themeAppearanceLabel(definition.appearance, t),
          ],
          description: themeDescription(definition.appearance, theme.followSystemTheme, t),
          run: () => {
            if (theme.followSystemTheme) theme.setFollowSystemTheme(false);
            theme.setTheme(definition.id as ThemeId);
          },
        };
      }),
    [t, theme, themes],
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
            chip: { icon: <PaletteIcon />, label: t("palette.steps.theme.label", "Theme") },
            placeholder: t("palette.steps.theme.placeholder", "Find a theme…"),
            sections: [
              {
                id: "themes",
                title: t("palette.steps.theme.section", "Themes"),
                entries: filtered(text, commands, context),
              },
            ],
          }
        : null,
    [active, commands, context, t, text],
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
  const { t } = useUiTranslation();
  const { step, text, projects, conversations, activeProjectId, ops, context, selectedKey } = input;
  const worktree = useWorktreeStep(step, text, projects, ops, context);
  const theme = useThemeStep(step?.kind === "theme", text, selectedKey, context);
  if (step?.kind === "new-conversation")
    return projectStep(text, projects, conversations, activeProjectId, t);
  if (step?.kind === "worktree") return worktree;
  if (step?.kind === "theme") return theme;
  return null;
}
