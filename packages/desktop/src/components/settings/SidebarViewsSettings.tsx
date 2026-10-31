import { useEffect, useMemo, useState, type ReactElement } from "react";
import { Eye, Plus, Trash2 } from "lucide-react";
import { useListProjects, type Project } from "@/api/generated";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useCrossProjectConversations } from "@/hooks/useCrossProjectConversations";
import { useSidebarViews } from "@/hooks/useSidebarViews";
import { applySidebarView, parseSidebarViewQuery, type SidebarView } from "@/lib/sidebar-views";
import { SettingsGroup } from "./SettingsGroup";
import { SETTINGS_ANCHORS } from "./settings-anchor-ids";

const NO_PROJECTS: Project[] = [];

const QUERY_HELP =
  "Queries use the Agents grid filters (/project:, /last:, /sort:, /exclude:, /pin:) plus /status:waiting|failed|working|unread|idle, /label:, /provider: and /worktree:yes|no; other words search titles.";

/**
 * Saved sidebar views: named queries over every conversation, picked from the
 * Projects header's menu. Each shows how many conversations it matches now.
 */
export function SidebarViewsSettings(): ReactElement {
  const { views, activeView, loaded, showView, saveViews } = useSidebarViews();
  const [drafts, setDrafts] = useState<readonly SidebarView[]>(views);
  // Follow the stored list (another device, the first load) between edits.
  useEffect(() => setDrafts(views), [views]);
  const update = (id: string, patch: Partial<SidebarView>) =>
    setDrafts((current) => current.map((view) => (view.id === id ? { ...view, ...patch } : view)));
  const commit = (next: readonly SidebarView[]) => {
    if (JSON.stringify(next) !== JSON.stringify(views)) saveViews(next);
  };
  const counts = useMatchCounts(drafts);

  return (
    <SettingsGroup
      id={SETTINGS_ANCHORS.sidebarViews}
      title="Saved views"
      description={`Named queries over every conversation. Pick one from the menu on the sidebar's Projects header: it replaces the project list until you pick a grouping again. ${QUERY_HELP}`}
    >
      <div className="flex flex-col divide-y divide-border/60">
        {drafts.map((view) => (
          <div
            key={view.id}
            data-sidebar-view={view.id}
            className="flex items-center gap-2 px-5 py-3"
          >
            <Input
              aria-label="View name"
              value={view.name}
              placeholder="Name"
              className="h-8 w-40 text-sm"
              onChange={(event) => update(view.id, { name: event.target.value })}
              onBlur={() => commit(drafts)}
            />
            <Input
              aria-label="View query"
              value={view.query}
              placeholder="/status:waiting /project:web-app"
              className="h-8 min-w-0 flex-1 font-mono text-xs"
              onChange={(event) => update(view.id, { query: event.target.value })}
              onBlur={() => commit(drafts)}
            />
            <span className="w-24 shrink-0 text-right text-xs tabular-nums text-muted-foreground">
              {counts.get(view.id) ?? "…"}
            </span>
            <Button
              variant={activeView?.id === view.id ? "secondary" : "ghost"}
              size="icon-sm"
              title="Show in the sidebar"
              aria-label={`Show ${view.name || "this view"} in the sidebar`}
              aria-pressed={activeView?.id === view.id}
              onClick={() => {
                commit(drafts);
                showView(activeView?.id === view.id ? null : view.id);
              }}
            >
              <Eye />
            </Button>
            <Button
              variant="ghost"
              size="icon-sm"
              title="Delete view"
              aria-label={`Delete ${view.name || "this view"}`}
              onClick={() => {
                if (activeView?.id === view.id) showView(null);
                commit(drafts.filter((candidate) => candidate.id !== view.id));
              }}
            >
              <Trash2 />
            </Button>
          </div>
        ))}
        <div className="px-5 py-3">
          <Button
            variant="outline"
            size="sm"
            disabled={!loaded}
            onClick={() =>
              commit([...drafts, { id: crypto.randomUUID(), name: "New view", query: "" }])
            }
          >
            <Plus />
            Add view
          </Button>
        </div>
      </div>
    </SettingsGroup>
  );
}

/** How many conversations each view matches right now, whatever the sidebar's filter. */
function useMatchCounts(views: readonly SidebarView[]): ReadonlyMap<string, string> {
  const { features, context, isPending } = useCrossProjectConversations("count", views.length > 0);
  const { data: projects = NO_PROJECTS } = useListProjects();
  return useMemo(() => {
    if (isPending) return new Map();
    return new Map(
      views.map((view) => {
        const count = applySidebarView(
          features,
          parseSidebarViewQuery(view.query, projects),
          context,
        ).length;
        return [view.id, count === 1 ? "1 match" : `${count} matches`];
      }),
    );
  }, [context, features, isPending, projects, views]);
}
