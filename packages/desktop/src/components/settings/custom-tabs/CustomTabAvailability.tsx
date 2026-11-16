import { useId, useState } from "react";
import { Virtuoso } from "react-virtuoso";
import type { PluginTabSummary, Project } from "@/api/generated";
import { Switch } from "@/components/ui/switch";
import {
  UsageSegmentedControl,
  type SegmentedOption,
} from "@/components/usage/UsageSegmentedControl";
import {
  canTurnOn,
  overrideOf,
  triStateOf,
  type ProjectOverride,
  type TriState,
} from "./custom-tab-model";
import { enablementKey, type CustomTabEnablement } from "./useCustomTabEnablement";
import { cn } from "@/lib/utils";

/** The list grows with the workspace up to this height (`max-h-64`), then scrolls. */
const MAX_LIST_HEIGHT_PX = 256;
/** A two-line row with its segmented control, until Virtuoso measures them. */
const ESTIMATED_ROW_HEIGHT_PX = 49;

const TRI_STATE_OPTIONS: readonly SegmentedOption<TriState>[] = [
  { value: "inherit", label: "Inherit" },
  { value: "on", label: "On" },
  { value: "off", label: "Off" },
];

/**
 * Where the tab shows: one global switch, and a per-project choice that either
 * follows it (Inherit) or overrides it. An invalid tab can be switched off but
 * never on — the service would refuse it.
 */
export function CustomTabAvailability({
  tab,
  projects,
  overrides,
  enablement,
}: {
  tab: PluginTabSummary;
  projects: Project[];
  overrides: ReadonlyMap<number, ProjectOverride>;
  enablement: Pick<CustomTabEnablement, "change" | "pendingKey">;
}): React.JSX.Element {
  const switchId = useId();
  const global = tab.enablement.global === true;
  const invalid = !canTurnOn(tab);
  const globalPending = enablement.pendingKey === enablementKey(tab.id, null);

  return (
    <div className="space-y-3">
      <div className="flex items-start justify-between gap-6">
        <label htmlFor={switchId} className="min-w-0 cursor-pointer">
          <span className="block text-sm font-medium leading-tight">Enable in all projects</span>
          <span className="mt-0.5 block text-xs leading-snug text-muted-foreground">
            Projects set to Inherit below follow this switch.
          </span>
        </label>
        <Switch
          id={switchId}
          checked={global}
          disabled={globalPending || (invalid && !global)}
          onCheckedChange={(checked) => enablement.change(tab, null, checked)}
        />
      </div>
      {projects.length === 0 ? (
        <p className="text-xs text-muted-foreground">No projects yet.</p>
      ) : (
        <ProjectList
          projects={projects}
          renderRow={(project) => (
            <ProjectRow
              project={project}
              isAuthoring={project.plugin_id === tab.id}
              override={overrides.get(project.id) ?? null}
              global={global}
              invalid={invalid}
              pending={enablement.pendingKey === enablementKey(tab.id, project.id)}
              onChange={(state) => enablement.change(tab, project.id, overrideOf(state))}
            />
          )}
        />
      )}
    </div>
  );
}

/**
 * Virtualized: the list grows with the user's projects, and every row mounts a
 * segmented control. As tall as its rows up to `MAX_LIST_HEIGHT_PX`.
 */
function ProjectList({
  projects,
  renderRow,
}: {
  projects: Project[];
  renderRow: (project: Project) => React.ReactNode;
}): React.JSX.Element {
  const [listHeight, setListHeight] = useState(projects.length * ESTIMATED_ROW_HEIGHT_PX);
  return (
    <Virtuoso
      role="list"
      aria-label="Per-project availability"
      className="rounded-lg border border-border/60 bg-card"
      style={{ height: Math.min(listHeight, MAX_LIST_HEIGHT_PX) + 2 }}
      data={projects}
      computeItemKey={(_, project) => project.id}
      totalListHeightChanged={setListHeight}
      itemContent={(index, project) => (
        <div role="listitem" className={cn(index > 0 && "border-t border-border/50")}>
          {renderRow(project)}
        </div>
      )}
    />
  );
}

function ProjectRow({
  project,
  isAuthoring,
  override,
  global,
  invalid,
  pending,
  onChange,
}: {
  project: Project;
  isAuthoring: boolean;
  override: ProjectOverride;
  global: boolean;
  invalid: boolean;
  pending: boolean;
  onChange: (state: TriState) => void;
}): React.JSX.Element {
  const state = triStateOf(override);
  return (
    <div className="flex items-center gap-3 px-3 py-2">
      <div className="min-w-0 flex-1">
        <p className="truncate text-xs font-medium">{project.name}</p>
        <p className="truncate text-[11px] text-muted-foreground">
          {isAuthoring ? "Where this tab is built · " : null}
          {state === "inherit" ? `Follows all projects: ${global ? "on" : "off"}` : "Own choice"}
        </p>
      </div>
      <UsageSegmentedControl
        ariaLabel={`${project.name} availability`}
        value={state}
        // An invalid tab can be turned off, never (back) on.
        options={TRI_STATE_OPTIONS.map((option) => ({
          ...option,
          disabled: invalid && state !== "on" && option.value === "on",
        }))}
        disabled={pending}
        className="shrink-0"
        onChange={(next) => next !== state && onChange(next)}
      />
    </div>
  );
}
