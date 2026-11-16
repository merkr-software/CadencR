import { useId } from "react";
import { ArrowUpCircle, Ban, ChevronRight, ShieldAlert } from "lucide-react";
import type { PluginTabSummary, Project } from "@/api/generated";
import { PluginTabAccessBadge } from "@/components/plugin-tabs/PluginTabAccess";
import { PluginTabIcon } from "@/components/plugin-tabs/PluginTabIcon";
import {
  backendPlatforms,
  BLOCKED_COPY,
  UNAVAILABLE_HERE,
} from "@/components/plugin-tabs/plugin-tab-access";
import { cn } from "@/lib/utils";
import {
  customTabStatus,
  enablementSummary,
  isSwitchedOnAnywhere,
  type ProjectOverride,
} from "./custom-tab-model";
import { CustomTabStatusBadge } from "./CustomTabStatusBadge";
import { CustomTabDetails } from "./CustomTabDetails";
import type { CustomTabEnablement } from "./useCustomTabEnablement";
import type { OpenCustomTabProject } from "./useOpenCustomTabProject";

export interface CustomTabCardProps {
  tab: PluginTabSummary;
  projects: Project[];
  overrides: ReadonlyMap<number, ProjectOverride>;
  enablement: CustomTabEnablement;
  opener: OpenCustomTabProject;
  /** Owned by the list, so a card scrolled out of the virtualized list and back keeps it. */
  expanded: boolean;
  onExpandedChange: (expanded: boolean) => void;
}

/**
 * One local custom tab: what it is and where it is on at a glance, the rest —
 * permissions, availability, settings, issues — one click away. An invalid
 * tab still gets its card, with the issues that keep it from running.
 */
export function CustomTabCard(props: CustomTabCardProps): React.JSX.Element {
  const { tab, projects, overrides, expanded, onExpandedChange } = props;
  const detailsId = useId();
  const projectIds = projects.map((project) => project.id);
  const status = customTabStatus(tab);
  // A blocked tab runs nowhere, whatever its switches still say.
  const summary = status === "blocked" ? "Off" : enablementSummary(tab, overrides, projectIds);
  // An invalid tab can't be consented to; its issues say why it is off.
  const paused =
    tab.status === "valid" &&
    tab.enablement.consent_required &&
    isSwitchedOnAnywhere(tab, overrides);

  return (
    <div className="overflow-hidden rounded-lg border border-border bg-card">
      <button
        type="button"
        aria-expanded={expanded}
        aria-controls={detailsId}
        onClick={() => onExpandedChange(!expanded)}
        className="flex w-full items-start gap-3 px-4 py-3 text-left transition-colors duration-100 hover:bg-accent/40 focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50"
      >
        <span className="grid size-8 shrink-0 place-items-center rounded-md bg-muted text-foreground">
          <PluginTabIcon svg={tab.icon_svg} data-testid="custom-tab-icon" />
        </span>
        <span className="min-w-0 flex-1">
          <span className="flex items-center gap-2">
            <span className="truncate text-sm font-medium">{tab.name}</span>
            {tab.version ? (
              <span className="shrink-0 font-mono text-[10.5px] text-muted-foreground">
                v{tab.version}
              </span>
            ) : null}
            <CustomTabStatusBadge status={status} />
            <PluginTabAccessBadge level={tab.access_level} />
          </span>
          <span className="mt-0.5 block truncate text-xs text-muted-foreground">
            {tab.description || tab.id}
          </span>
          {status === "unavailable" && tab.backend ? (
            <span className="mt-0.5 block text-xs text-muted-foreground">
              {UNAVAILABLE_HERE}: its backend runs on {backendPlatforms(tab.backend)} only.
            </span>
          ) : null}
          {/* Open, the details lead with the same notices and their actions. */}
          {status === "blocked" && !expanded ? (
            <span className="mt-0.5 flex items-center gap-1 text-xs font-medium text-[var(--acc-red)]">
              <Ban className="size-3.5 shrink-0" aria-hidden />
              <span className="truncate">
                {tab.blocked_reason
                  ? `${BLOCKED_COPY.title}: ${tab.blocked_reason}`
                  : BLOCKED_COPY.title}
              </span>
            </span>
          ) : null}
          {tab.pending_update && !expanded ? (
            <span className="mt-0.5 flex items-center gap-1 text-xs font-medium text-[var(--acc-orange)]">
              <ArrowUpCircle className="size-3.5 shrink-0" aria-hidden />
              <span className="truncate">
                Update <span className="font-mono">{tab.pending_update.version}</span>{" "}
                {tab.pending_update.blocked_reason
                  ? "blocked by Cadencr"
                  : "ready — review permissions"}
              </span>
            </span>
          ) : null}
        </span>
        <span className="flex shrink-0 items-center gap-2 self-center">
          {paused ? (
            <span className="flex items-center gap-1 text-xs font-medium text-[var(--acc-orange)]">
              <ShieldAlert className="size-3.5" aria-hidden />
              Needs consent
            </span>
          ) : (
            <span
              className={cn(
                "text-xs",
                summary === "Off" ? "text-muted-foreground" : "font-medium text-foreground",
              )}
            >
              {summary}
            </span>
          )}
          <ChevronRight
            aria-hidden
            className={cn(
              "size-4 text-muted-foreground transition-transform duration-150",
              expanded && "rotate-90",
            )}
          />
        </span>
      </button>
      {expanded ? (
        <div id={detailsId} className="border-t border-border/60">
          <CustomTabDetails {...props} paused={paused} />
        </div>
      ) : null}
    </div>
  );
}
