import { formattingLocale } from "@/lib/i18n/formatting-locale";
import { useEffect, useMemo, useState, type ReactElement } from "react";
import { Eye, Plus, Trash2 } from "lucide-react";
import { useListProjects, type Project } from "@/api/generated";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useCrossProjectConversations } from "@/hooks/useCrossProjectConversations";
import { useSidebarViews } from "@/hooks/useSidebarViews";
import { translateUi, useUiTranslation } from "@/lib/i18n/ui";
import { applySidebarView, parseSidebarViewQuery, type SidebarView } from "@/lib/sidebar-views";
import { SettingsGroup } from "./SettingsGroup";
import { SETTINGS_ANCHORS } from "./settings-anchor-ids";

const NO_PROJECTS: Project[] = [];

const QUERY_FILTERS = {
  grid: "/project:, /last:, /sort:, /exclude:, /pin:",
  status: "/status:waiting|failed|working|unread|idle",
  label: "/label:",
  provider: "/provider:",
  worktree: "/worktree:yes|no",
};

/**
 * Saved sidebar views: named queries over every conversation, picked from the
 * Projects header's menu. Each shows how many conversations it matches now.
 */
export function SidebarViewsSettings(): ReactElement {
  const { t } = useUiTranslation();
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

  const addView = (): void => {
    const name = translateUi("sidebar.settings.views.newName", "New view");
    commit([...drafts, { id: crypto.randomUUID(), name, query: "" }]);
  };

  return (
    <SettingsGroup
      id={SETTINGS_ANCHORS.sidebarViews}
      title={t("sidebar.settings.views.title", "Saved views")}
      description={t(
        "sidebar.settings.views.description",
        "Named queries over every conversation. Pick one from the menu on the sidebar's Projects header: it replaces the project list until you pick a grouping again. Queries use the Agents grid filters ({{grid}}) plus {{status}}, {{label}}, {{provider}} and {{worktree}}; other words search titles.",
        QUERY_FILTERS,
      )}
    >
      <div className="flex flex-col divide-y divide-border/60">
        {drafts.map((view) => {
          const isActive = activeView?.id === view.id;
          return (
            <SidebarViewEditor
              key={view.id}
              view={view}
              count={counts.get(view.id)}
              isActive={isActive}
              onEdit={(patch) => update(view.id, patch)}
              onCommit={() => commit(drafts)}
              onShow={() => {
                commit(drafts);
                showView(isActive ? null : view.id);
              }}
              onDelete={() => {
                if (isActive) showView(null);
                commit(drafts.filter((candidate) => candidate.id !== view.id));
              }}
            />
          );
        })}
        <div className="px-5 py-3">
          <Button variant="outline" size="sm" disabled={!loaded} onClick={addView}>
            <Plus />
            {t("sidebar.settings.views.add", "Add view")}
          </Button>
        </div>
      </div>
    </SettingsGroup>
  );
}

function SidebarViewEditor({
  view,
  count,
  isActive,
  onEdit,
  onCommit,
  onShow,
  onDelete,
}: {
  view: SidebarView;
  count: number | undefined;
  isActive: boolean;
  onEdit: (patch: Partial<SidebarView>) => void;
  onCommit: () => void;
  onShow: () => void;
  onDelete: () => void;
}): ReactElement {
  const { t, i18n } = useUiTranslation();
  return (
    <div data-sidebar-view={view.id} className="flex items-center gap-2 px-5 py-3">
      <Input
        aria-label={t("sidebar.settings.views.name", "View name")}
        value={view.name}
        placeholder={t("sidebar.settings.views.namePlaceholder", "Name")}
        className="h-8 w-40 text-sm"
        onChange={(event) => onEdit({ name: event.target.value })}
        onBlur={onCommit}
      />
      <Input
        aria-label={t("sidebar.settings.views.query", "View query")}
        value={view.query}
        placeholder="/status:waiting /project:web-app"
        className="h-8 min-w-0 flex-1 font-mono text-xs"
        onChange={(event) => onEdit({ query: event.target.value })}
        onBlur={onCommit}
      />
      <span className="w-24 shrink-0 text-right text-xs tabular-nums text-muted-foreground">
        {count === undefined
          ? "…"
          : t("sidebar.settings.views.matchCount", "{{count, number}} matches", {
              count,
              defaultValue_zero: "{{count, number}} matches",
              defaultValue_one: "{{count, number}} match",
              formatParams: { count: { locale: formattingLocale(i18n.language) } },
            })}
      </span>
      <Button
        variant={isActive ? "secondary" : "ghost"}
        size="icon-sm"
        title={t("sidebar.settings.views.show", "Show in the sidebar")}
        aria-label={
          view.name
            ? t("sidebar.settings.views.showNamed", "Show {{name}} in the sidebar", {
                name: view.name,
              })
            : t("sidebar.settings.views.showUnnamed", "Show this view in the sidebar")
        }
        aria-pressed={isActive}
        onClick={onShow}
      >
        <Eye />
      </Button>
      <Button
        variant="ghost"
        size="icon-sm"
        title={t("sidebar.settings.views.delete", "Delete view")}
        aria-label={
          view.name
            ? t("sidebar.settings.views.deleteNamed", "Delete {{name}}", { name: view.name })
            : t("sidebar.settings.views.deleteUnnamed", "Delete this view")
        }
        onClick={onDelete}
      >
        <Trash2 />
      </Button>
    </div>
  );
}

/** How many conversations each view matches right now, whatever the sidebar's filter. */
function useMatchCounts(views: readonly SidebarView[]): ReadonlyMap<string, number> {
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
        return [view.id, count];
      }),
    );
  }, [context, features, isPending, projects, views]);
}
