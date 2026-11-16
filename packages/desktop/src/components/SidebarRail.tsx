import { memo, useCallback, useMemo, type CSSProperties, type ReactElement } from "react";
import { Link } from "@tanstack/react-router";
import { PanelLeft, Settings } from "lucide-react";
import type { Feature } from "@/api/generated";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { attentionSummary } from "@/components/ProjectAttentionBadges";
import { useSidebarAttention } from "@/components/SidebarAttentionProvider";
import { ProjectBadge } from "@/components/ProjectBadge";
import { SidebarStatusIndicator } from "@/components/SidebarStatusIndicator";
import { useCrossProjectNavigate } from "@/hooks/useCrossProjectNavigate";
import { useOrderedProjects } from "@/hooks/useOrderedProjects";
import { useProjectColor } from "@/hooks/useProjectColor";
import { useRouteFeatureIds } from "@/hooks/useRouteFeatureIds";
import { SIDEBAR_EXPANDED_PROJECTS_KEY, usePersistedIdSet } from "@/hooks/usePersistedIdSet";
import type { ProjectAttentionCounts, ResolvedAttention } from "@/hooks/useResolvedAttention";
import { HAS_MAC_WINDOW_CONTROLS } from "@/lib/mac-window-controls";
import { ATTENTION_LABEL, needsUser } from "@/lib/sidebar-attention";
import { cn } from "@/lib/utils";
import { useSidebarOption } from "@/stores/sidebar-config-store";
import { SidebarSurfaceContext } from "@/stores/sidebar-surface-store";
import { useShortcutLabel } from "@/hooks/useShortcutLabel";

/**
 * The collapsed sidebar's 48px rail (A3), so collapsing never hides what
 * agents are doing: projects with their aggregated badges, every conversation
 * with something going on, or only the ones waiting on you. A waiting
 * conversation's glyph opens its gate popover, so a request can be answered
 * without reopening the sidebar. Desktop only.
 */
export function SidebarRail({ onExpand }: { onExpand: () => void }): ReactElement | null {
  const content = useSidebarOption("rail");
  const { featureId: activeFeatureId } = useRouteFeatureIds();
  const toggleSidebarCombo = useShortcutLabel("toggle-sidebar");
  const settingsCombo = useShortcutLabel("open-settings");
  if (content === "none") return null;
  return (
    <TooltipProvider delayDuration={300}>
      <nav
        aria-label="Collapsed sidebar"
        data-sidebar-rail={content}
        className={cn(
          "glass-surface flex h-full w-12 shrink-0 flex-col items-center gap-1 bg-sidebar pb-2",
          // The traffic lights straddle the rail's edge, so on Mac its hairline
          // starts under the titlebar band instead of cutting through them.
          HAS_MAC_WINDOW_CONTROLS
            ? "relative before:absolute before:top-18 before:right-0 before:bottom-0 before:w-px before:bg-border/60"
            : "border-r border-border/60",
        )}
      >
        <div
          className={cn("titlebar-drag w-full shrink-0", HAS_MAC_WINDOW_CONTROLS ? "h-18" : "h-2")}
        />
        <Button
          variant="ghost"
          size="icon"
          className="size-8 shrink-0 text-muted-foreground hover:text-foreground"
          title={`Expand sidebar (${toggleSidebarCombo})`}
          aria-label="Expand sidebar"
          onClick={onExpand}
        >
          <PanelLeft className="size-4" />
        </Button>
        <div className="flex min-h-0 w-full flex-1 flex-col items-center gap-1 overflow-y-auto py-1">
          {content === "projects" ? (
            <RailProjects onExpand={onExpand} />
          ) : (
            <SidebarSurfaceContext.Provider value="rail">
              <RailConversations
                activeFeatureId={activeFeatureId}
                attentionOnly={content === "attention"}
              />
            </SidebarSurfaceContext.Provider>
          )}
        </div>
        {/* The sidebar footer's Settings entry, kept reachable while collapsed:
            the titlebar stays free of chrome so the page title owns it. */}
        <Button
          asChild
          variant="ghost"
          size="icon"
          className="size-8 shrink-0 text-muted-foreground hover:text-foreground"
          title={`Settings (${settingsCombo})`}
        >
          <Link to="/settings" aria-label="Settings">
            <Settings className="size-4" />
          </Link>
        </Button>
      </nav>
    </TooltipProvider>
  );
}

function RailProjects({ onExpand }: { onExpand: () => void }): ReactElement {
  const { projects } = useOrderedProjects();
  const { byProject } = useSidebarAttention();
  const { setMember } = usePersistedIdSet(SIDEBAR_EXPANDED_PROJECTS_KEY);
  const open = useCallback(
    (projectId: number) => {
      setMember(projectId, true);
      onExpand();
    },
    [onExpand, setMember],
  );
  return (
    <>
      {projects.map((project) => (
        <RailProject
          key={project.id}
          projectId={project.id}
          name={project.name}
          counts={byProject.get(project.id)}
          onOpen={open}
        />
      ))}
    </>
  );
}

export const RailProject = memo(function RailProject({
  projectId,
  name,
  counts,
  onOpen,
}: {
  projectId: number;
  name: string;
  counts: ProjectAttentionCounts | undefined;
  onOpen: (projectId: number) => void;
}): ReactElement {
  const summary = counts ? attentionSummary(counts) : "";
  const ring = counts ? ringClass(counts) : "";
  const tint = useProjectTint(projectId);
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          aria-label={summary ? `${name}: ${summary}` : name}
          onClick={() => onOpen(projectId)}
          style={tint}
          className={cn(
            "sidebar-rail-tile relative size-8 shrink-0",
            ring && `ring-2 ring-offset-1 ring-offset-sidebar ${ring}`,
          )}
        >
          <ProjectBadge projectId={projectId} size="md" fallback={name.slice(0, 1)} />
          {counts && <StrongCount counts={counts} />}
        </button>
      </TooltipTrigger>
      <TooltipContent side="right">
        <span className="font-medium text-foreground">{name}</span>
        {summary && <span className="block">{summary}</span>}
      </TooltipContent>
    </Tooltip>
  );
});

/** How many of the project's conversations need an action, as a corner pill. */
function StrongCount({ counts }: { counts: ProjectAttentionCounts }): ReactElement | null {
  const strong = counts.waiting + counts.failed;
  if (strong === 0) return null;
  return (
    <span
      aria-hidden
      className={cn(
        "absolute -bottom-1 -right-1 inline-flex h-3.5 min-w-3.5 items-center justify-center rounded-full px-0.5",
        "text-[9px] font-semibold leading-none tabular-nums text-background",
        counts.waiting > 0 ? "bg-amber-400" : "bg-(--acc-red)",
      )}
    >
      {strong}
    </span>
  );
}

/** The ring reads the most urgent state at a glance, like a row's status slot. */
function ringClass(counts: ProjectAttentionCounts): string {
  if (counts.waiting > 0) return "ring-amber-400";
  if (counts.failed > 0) return "ring-(--acc-red)";
  if (counts.working > 0) return "ring-blue-500/70";
  if (counts.unread > 0) return "ring-(--acc-green)/70";
  return "";
}

/** A rail tile's tint (`sidebar-rows.css`): the rail reads by project at a glance. */
function useProjectTint(projectId: number): CSSProperties {
  const color = useProjectColor(projectId);
  return useMemo(() => ({ "--project-tint": `#${color}` }) as CSSProperties, [color]);
}

export function RailEmptyLine({ attentionOnly }: { attentionOnly: boolean }): ReactElement {
  return (
    <span className="px-1 pt-1 text-center text-[10px] leading-tight text-muted-foreground">
      {attentionOnly ? "Nothing waiting" : "All quiet"}
    </span>
  );
}

function RailConversations({
  activeFeatureId,
  attentionOnly,
}: {
  activeFeatureId: number | null;
  attentionOnly: boolean;
}): ReactElement {
  const { items, queue, loadingStates } = useSidebarAttention();
  const navigate = useCrossProjectNavigate(activeFeatureId, noop);
  const shown = attentionOnly ? queue : items;
  if (shown.length === 0) {
    return (attentionOnly ? loadingStates.some(needsUser) : loadingStates.length > 0) ? (
      <Skeleton aria-label="Loading conversations" className="size-8 shrink-0 rounded-md" />
    ) : (
      <RailEmptyLine attentionOnly={attentionOnly} />
    );
  }
  return (
    <>
      {shown.map((item) => (
        <RailConversation
          key={item.feature.id}
          item={item}
          isActive={item.feature.id === activeFeatureId}
          onOpen={navigate}
        />
      ))}
    </>
  );
}

function noop(): void {}

export const RailConversation = memo(function RailConversation({
  item,
  isActive,
  onOpen,
}: {
  item: ResolvedAttention;
  isActive: boolean;
  onOpen: (feature: Feature) => void;
}): ReactElement {
  const { feature, state } = item;
  const attention = useMemo(() => ({ state, sourceFeatureId: feature.id }), [state, feature.id]);
  const open = useCallback(() => onOpen(feature), [onOpen, feature]);
  const tint = useProjectTint(feature.project_id);
  return (
    <div data-sidebar-flash-target className="relative shrink-0 rounded-md">
      <Tooltip>
        <TooltipTrigger asChild>
          <button
            type="button"
            aria-label={`${feature.title}: ${ATTENTION_LABEL[state]}`}
            data-active={isActive || undefined}
            onClick={open}
            style={tint}
            className="sidebar-rail-tile size-8"
          >
            {feature.title.slice(0, 1) || "#"}
          </button>
        </TooltipTrigger>
        <TooltipContent side="right">
          <span className="font-medium text-foreground">{feature.title}</span>
          <span className="block">{ATTENTION_LABEL[state]}</span>
        </TooltipContent>
      </Tooltip>
      <span className="absolute -bottom-0.5 -right-0.5 rounded-full bg-sidebar">
        <SidebarStatusIndicator
          attention={attention}
          isActive={isActive}
          onOpenConversation={open}
        />
      </span>
    </div>
  );
});
