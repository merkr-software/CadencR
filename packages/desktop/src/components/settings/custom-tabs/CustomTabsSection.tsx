import { useCallback, useEffect, useMemo, useState } from "react";
import { Virtuoso } from "react-virtuoso";
import { useNavigate, useSearch } from "@tanstack/react-router";
import { Plus, Puzzle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { SettingsGroup } from "@/components/settings/SettingsGroup";
import { SettingsPageSection } from "../SettingsPageSection";
import { ErrorRow, LoadingRow } from "@/components/settings/SettingsStateRows";
import { apiErrorMessage } from "@/lib/api-errors";
import { CUSTOM_TABS_SECTION_ID } from "./custom-tab-model";
import { CreateCustomTabDialog } from "./CreateCustomTabDialog";
import { CustomTabCard } from "./CustomTabCard";
import { CustomTabConsentDialog } from "./CustomTabConsentDialog";
import { KeptDraftsProvider } from "./kept-drafts";
import { useCustomTabEnablement } from "./useCustomTabEnablement";
import { useCustomTabsData, type CustomTabsData } from "./useCustomTabsData";
import { useOpenCustomTabProject } from "./useOpenCustomTabProject";

/**
 * Settings → Custom tabs: the local tabs, where each is on, what it may read,
 * its settings, and the way to make a new one.
 *
 * URL contract: `/settings?section=custom-tabs` scrolls here;
 * `&action=create` also opens the create dialog, and the param is then dropped
 * so a reload or Back does not open it again.
 */
export function CustomTabsSection(): React.JSX.Element {
  const data = useCustomTabsData();
  const enablement = useCustomTabEnablement();
  const opener = useOpenCustomTabProject();
  const [creating, setCreating] = useCreateFromUrl();
  const [expanded, setExpanded] = useExpandedCards();
  // The empty state carries its own Create button; anywhere else the header does.
  const empty = !data.isLoading && !data.error && data.tabs.length === 0;

  return (
    <SettingsPageSection pageId="custom-tabs">
      <SettingsGroup
        bare
        title="Your custom tabs"
        action={
          !empty ? (
            <Button size="sm" className="gap-1.5" onClick={() => setCreating(true)}>
              <Plus className="size-3.5" aria-hidden />
              Create custom tab
            </Button>
          ) : undefined
        }
      >
        <CustomTabsList
          data={data}
          onCreate={() => setCreating(true)}
          render={(tab) => (
            <CustomTabCard
              tab={tab}
              projects={data.projects}
              overrides={data.overridesFor(tab.id)}
              enablement={enablement}
              opener={opener}
              expanded={expanded.get(tab.id) ?? data.tabs.length === 1}
              onExpandedChange={(open) => setExpanded(tab.id, open)}
            />
          )}
        />
      </SettingsGroup>
      {creating ? <CreateCustomTabDialog onClose={() => setCreating(false)} /> : null}
      <CustomTabConsentDialog
        request={enablement.request}
        accepting={enablement.accepting}
        onAccept={enablement.accept}
        onCancel={enablement.cancel}
      />
    </SettingsPageSection>
  );
}

function CustomTabsList({
  data,
  onCreate,
  render,
}: {
  data: CustomTabsData;
  onCreate: () => void;
  render: (tab: CustomTabsData["tabs"][number]) => React.JSX.Element;
}): React.JSX.Element {
  if (data.isLoading) return <LoadingRow label="Loading custom tabs…" />;
  if (data.error) {
    return <ErrorRow label={apiErrorMessage(data.error, "Could not load your custom tabs.")} />;
  }
  if (data.tabs.length === 0) return <CustomTabsEmptyState onCreate={onCreate} />;
  return (
    <KeptDraftsProvider>
      {data.projectsError ? (
        <div className="mb-3">
          <ErrorRow
            label={`Per-project choices could not be loaded, so the projects shown below may be wrong: ${apiErrorMessage(data.projectsError, "unknown error")}`}
          />
        </div>
      ) : null}
      <VirtualCards tabs={data.tabs} render={render} />
    </KeptDraftsProvider>
  );
}

/**
 * The cards, virtualized against the Settings page's own scroller: a card is
 * as tall as its open details, so it scrolls with the page rather than in a
 * box of its own.
 */
function VirtualCards({
  tabs,
  render,
}: {
  tabs: CustomTabsData["tabs"];
  render: (tab: CustomTabsData["tabs"][number]) => React.JSX.Element;
}): React.JSX.Element {
  // `undefined` until the anchor mounts; `null` when nothing above it scrolls.
  const [scroller, setScroller] = useState<HTMLElement | null | undefined>(undefined);
  const anchor = useCallback((node: HTMLDivElement | null) => {
    if (node) setScroller(scrollParentOf(node));
  }, []);
  return (
    <div ref={anchor}>
      {scroller === undefined ? null : (
        <Virtuoso
          customScrollParent={scroller ?? undefined}
          useWindowScroll={scroller === null}
          data={tabs}
          computeItemKey={(_, tab) => tab.id}
          increaseViewportBy={600}
          itemContent={(index, tab) => <div className={index > 0 ? "pt-2" : ""}>{render(tab)}</div>}
        />
      )}
    </div>
  );
}

/** The nearest ancestor that scrolls vertically. Read once, when the list mounts. */
function scrollParentOf(node: HTMLElement): HTMLElement | null {
  for (let parent = node.parentElement; parent; parent = parent.parentElement) {
    if (/(auto|scroll)/.test(getComputedStyle(parent).overflowY)) return parent;
  }
  return null;
}

/** Which cards the user opened or closed; a lone tab starts open. */
function useExpandedCards(): [ReadonlyMap<string, boolean>, (id: string, open: boolean) => void] {
  const [expanded, setExpandedMap] = useState<ReadonlyMap<string, boolean>>(() => new Map());
  const setExpanded = useCallback(
    (id: string, open: boolean) => setExpandedMap((previous) => new Map(previous).set(id, open)),
    [],
  );
  return [expanded, setExpanded];
}

function CustomTabsEmptyState({ onCreate }: { onCreate: () => void }): React.JSX.Element {
  return (
    <div className="flex flex-col items-center gap-2 rounded-lg border border-dashed border-border px-6 py-10 text-center">
      <span className="mb-1 grid size-10 place-items-center rounded-md border border-border bg-card text-muted-foreground">
        <Puzzle className="size-5" aria-hidden />
      </span>
      <h4 className="text-sm font-semibold text-foreground">No custom tabs yet</h4>
      <p className="max-w-sm text-xs leading-relaxed text-pretty text-muted-foreground">
        Build the view you keep wishing a conversation had: a graph of the changes, a dashboard,
        your team&apos;s tools. Cadencr sets up a starter tab and an agent to build it with you.
      </p>
      <Button size="sm" className="mt-2 gap-1.5" onClick={onCreate}>
        <Plus className="size-3.5" aria-hidden />
        Create custom tab
      </Button>
    </div>
  );
}

/** `action=create` in the URL opens the dialog once, then leaves the URL. */
function useCreateFromUrl(): [boolean, (open: boolean) => void] {
  const navigate = useNavigate();
  const [creating, setCreating] = useState(false);
  // The settings route validates `action` (`parseSettingsSearch`).
  const requested = useSearch({ strict: false, select: (search) => search.action === "create" });

  useEffect(() => {
    if (!requested) return;
    setCreating(true);
    void navigate({
      to: "/settings",
      search: { section: CUSTOM_TABS_SECTION_ID },
      replace: true,
    });
  }, [navigate, requested]);

  return useMemo<[boolean, (open: boolean) => void]>(() => [creating, setCreating], [creating]);
}
