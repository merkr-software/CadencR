import { useState, type ReactElement, type ReactNode } from "react";
import {
  ActivityIcon,
  BugIcon,
  CheckIcon,
  FolderGit2Icon,
  Loader2Icon,
  PlusIcon,
  Repeat2Icon,
  RotateCwIcon,
  Settings2Icon,
  SparklesIcon,
} from "lucide-react";

import type { PluginTabSummary } from "@/api/generated";
import { ShortcutTooltip } from "@/components/ShortcutTooltip";
import { useOpenCustomTabProject } from "@/components/settings/custom-tabs/useOpenCustomTabProject";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { apiErrorMessage, toastError } from "@/lib/api-errors";
import { noteUserLayoutChange } from "@/lib/auto-layout/auto-layout-controller";
import { SuppressBrowserViewWhileOpen } from "@/lib/browser-suppression";
import { desktopBridge } from "@/lib/desktop-bridge";
import { pluginTabInstanceId } from "@/lib/plugin-tabs/instance-id";
import { refreshPluginTabsOrToast, reloadLivePluginTab } from "@/lib/plugin-tabs/live-instances";
import { setPluginTabActivityOpen } from "@/lib/plugin-tabs/runtime-store";
import { activateBuiltinFeatureTab, showReplacementTab } from "@/lib/plugin-tabs/builtin-fallback";
import {
  BUILTIN_TAB_LABELS,
  isReplaceableTab,
  NO_TAB_REPLACEMENTS,
  type ReplaceableTab,
} from "@/lib/plugin-tabs/tab-replacements";
import { pluginIdOfTab, pluginTabKind } from "@/stores/feature-layout-schema";
import {
  activateFeatureTab,
  getFocusedTab,
  selectFeatureLayout,
  useFeatureLayoutStore,
} from "@/stores/feature-layout-store";

import { PluginTabAccessMark } from "./PluginTabAccess";
import { PluginTabIcon } from "./PluginTabIcon";
import { ACCESS_LEVEL_COPY, backendUnavailableHere, UNAVAILABLE_HERE } from "./plugin-tab-access";
import { useReplacementsHere, useTabReplacementChoices } from "./tab-replacement";
import { usePlacedPluginTabsKey, useProjectPluginTabs } from "./usePluginTabDefs";
import { usePluginTabNavigation, type PluginTabNavigation } from "./usePluginTabNavigation";

interface PluginTabAddMenuProps {
  featureId: number;
  projectId: number;
}

/**
 * The root strip's "+": add one of the project's custom tabs to this feature
 * (or jump to it when it is already placed), manage or create custom tabs,
 * and — when a custom tab is focused — reload it or open its DevTools.
 */
export function PluginTabAddMenu({ featureId, projectId }: PluginTabAddMenuProps): ReactElement {
  const [open, setOpen] = useState(false);
  const navigation = usePluginTabNavigation();
  return (
    <DropdownMenu open={open} onOpenChange={setOpen}>
      <ShortcutTooltip label="Add custom tab" alignRight disabled={open}>
        <DropdownMenuTrigger asChild>
          <Button variant="ghost" size="icon" className="size-7" aria-label="Add custom tab">
            <PlusIcon className="size-4" />
          </Button>
        </DropdownMenuTrigger>
      </ShortcutTooltip>
      <DropdownMenuContent align="end" className="w-72">
        {/* The menu portals over the pane area, where a native guest would cover it. */}
        <SuppressBrowserViewWhileOpen />
        {open && (
          <PluginTabMenuBody featureId={featureId} projectId={projectId} navigation={navigation} />
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function PluginTabMenuBody({
  featureId,
  projectId,
  navigation,
}: PluginTabAddMenuProps & { navigation: PluginTabNavigation }): ReactElement {
  const query = useProjectPluginTabs(projectId, true);
  const placed = usePlacedPluginTabsKey(featureId, true);
  const focusedTab = useFeatureLayoutStore((state) =>
    getFocusedTab(selectFeatureLayout(featureId)(state)),
  );
  const replacements = useReplacementsHere(
    featureId,
    useTabReplacementChoices() ?? NO_TAB_REPLACEMENTS,
    query.data,
  );
  const focusedSlot = focusedTab && isReplaceableTab(focusedTab) ? focusedTab : null;
  const focusedReplacement = focusedSlot ? replacements.get(focusedSlot) : undefined;
  const focusedPluginId = focusedTab ? pluginIdOfTab(focusedTab) : null;
  const focused =
    focusedReplacement && !focusedReplacement.fallback
      ? focusedReplacement.summary
      : (query.data?.find((tab) => tab.id === focusedPluginId) ?? null);
  const placedIds = new Set(placed.split("|"));
  // A blocked tab is never effective.
  const enabledTabs = query.data?.filter((tab) => tab.enablement.effective) ?? [];
  const bySummary = new Map(
    [...replacements].map(([slot, { summary, fallback }]) => [summary.id, { slot, fallback }]),
  );
  const replacementOf = (tab: PluginTabSummary): TabReplacementHere | null =>
    bySummary.get(tab.id) ?? null;

  return (
    <>
      <DropdownMenuLabel className="text-xs text-muted-foreground">Custom tabs</DropdownMenuLabel>
      <AvailableTabs
        state={query}
        tabs={enabledTabs}
        isPlaced={(tab) => {
          const here = replacementOf(tab);
          return here ? !here.fallback : placedIds.has(pluginTabKind(tab.id));
        }}
        replacing={replacementOf}
        onSelect={(tab) => {
          // A replacement opens in the built-in's place, taking it back if
          // the built-in shows there now, rather than as a second tab.
          const here = replacementOf(tab);
          if (here) {
            showReplacementTab(featureId, here.slot);
            activateFeatureTab(featureId, here.slot);
            return;
          }
          // A structural user edit: drops any auto-layout undo snapshot, which
          // would otherwise restore a layout without this tab.
          noteUserLayoutChange(featureId, { structural: true });
          useFeatureLayoutStore.getState().addTab(featureId, pluginTabKind(tab.id));
        }}
      />
      {(focused || focusedReplacement) && <DropdownMenuSeparator />}
      {focused && <FocusedTabActions featureId={featureId} tab={focused} />}
      {focusedSlot && focusedReplacement && (
        <ReplacementSwitch
          featureId={featureId}
          slot={focusedSlot}
          label={focusedReplacement.summary.label}
          fallback={focusedReplacement.fallback}
        />
      )}
      <DropdownMenuSeparator />
      <DropdownMenuItem onSelect={navigation.openSettings}>
        <Settings2Icon />
        Manage custom tabs…
      </DropdownMenuItem>
      <DropdownMenuItem onSelect={navigation.openCreate}>
        <SparklesIcon />
        Create custom tab…
      </DropdownMenuItem>
    </>
  );
}

interface TabsQueryState {
  isLoading: boolean;
  error: unknown;
}

/** The built-in place a custom tab holds in this conversation. */
interface TabReplacementHere {
  slot: ReplaceableTab;
  /** The built-in shows there now. */
  fallback: boolean;
}

/** Switch a replaced built-in's place between the custom tab and the built-in. */
function ReplacementSwitch({
  featureId,
  slot,
  label,
  fallback,
}: {
  featureId: number;
  slot: ReplaceableTab;
  label: string;
  fallback: boolean;
}): ReactElement {
  const builtin = BUILTIN_TAB_LABELS[slot];
  return (
    <DropdownMenuItem
      onSelect={() =>
        fallback ? showReplacementTab(featureId, slot) : activateBuiltinFeatureTab(featureId, slot)
      }
    >
      <Repeat2Icon />
      {fallback ? `Show ${label} instead of ${builtin}` : `Show the built-in ${builtin}`}
    </DropdownMenuItem>
  );
}

function AvailableTabs({
  state,
  tabs,
  isPlaced,
  replacing,
  onSelect,
}: {
  state: TabsQueryState;
  tabs: readonly PluginTabSummary[];
  isPlaced: (tab: PluginTabSummary) => boolean;
  /** The built-in whose place the tab holds here, if any. */
  replacing: (tab: PluginTabSummary) => TabReplacementHere | null;
  onSelect: (tab: PluginTabSummary) => void;
}): ReactNode {
  if (state.isLoading) {
    return (
      <MenuNote>
        <Loader2Icon className="size-3.5 animate-spin" aria-hidden />
        Loading custom tabs…
      </MenuNote>
    );
  }
  if (state.error) {
    return (
      <MenuNote tone="error">
        {apiErrorMessage(state.error, "Custom tabs could not be listed")}
      </MenuNote>
    );
  }
  if (tabs.length === 0) {
    return <MenuNote>No custom tab is on for this project yet.</MenuNote>;
  }
  return tabs.map((tab) => {
    const placed = isPlaced(tab);
    // Listed, so the user sees why it does not open; an already placed one
    // still jumps to its tab, which explains the same.
    const unavailable = backendUnavailableHere(tab);
    const here = replacing(tab);
    const note = unavailable ? UNAVAILABLE_HERE : here ? replacementNote(here) : tab.description;
    return (
      <DropdownMenuItem
        key={tab.id}
        onSelect={() => onSelect(tab)}
        disabled={unavailable && !placed}
        className="items-start"
        aria-label={placed ? `${tab.label} (open)` : tab.label}
      >
        <PluginTabIcon svg={tab.icon_svg} className="mt-0.5" />
        <span className="min-w-0 flex-1">
          <span className="flex items-center gap-1.5">
            <span className="truncate">{tab.label}</span>
            <PluginTabAccessMark level={tab.access_level} />
          </span>
          {note ? <span className="line-clamp-2 text-xs text-muted-foreground">{note}</span> : null}
        </span>
        {placed ? <CheckIcon className="mt-0.5 size-4" aria-hidden /> : null}
      </DropdownMenuItem>
    );
  });
}

function replacementNote({ slot, fallback }: TabReplacementHere): string {
  const builtin = BUILTIN_TAB_LABELS[slot];
  return fallback
    ? `Replaces ${builtin}; the built-in shows here now`
    : `Shown in place of ${builtin}`;
}

function FocusedTabActions({
  featureId,
  tab,
}: {
  featureId: number;
  tab: PluginTabSummary;
}): ReactElement {
  const instanceId = pluginTabInstanceId(featureId, tab.id);
  const projectOpener = useOpenCustomTabProject();
  return (
    <>
      <DropdownMenuLabel className="truncate text-xs text-muted-foreground">
        {tab.label}
      </DropdownMenuLabel>
      <DropdownMenuItem
        onSelect={() => {
          // A tab showing a state (not built, invalid…) has no guest: re-read it.
          if (!reloadLivePluginTab(instanceId)) refreshPluginTabsOrToast();
        }}
      >
        <RotateCwIcon />
        Reload
      </DropdownMenuItem>
      {tab.access_level !== "ui" && (
        <DropdownMenuItem
          onSelect={() => setPluginTabActivityOpen(instanceId)}
          title={ACCESS_LEVEL_COPY[tab.access_level].summary}
        >
          <ActivityIcon />
          Activity…
        </DropdownMenuItem>
      )}
      <DropdownMenuItem
        onSelect={() => {
          void desktopBridge.pluginTabs
            .openDevTools(instanceId)
            .catch((error: unknown) => toastError(error, "DevTools could not be opened"));
        }}
      >
        <BugIcon />
        Open DevTools
      </DropdownMenuItem>
      {tab.authoring_project_id != null && (
        <DropdownMenuItem
          disabled={projectOpener.openingId === tab.id}
          onSelect={() => projectOpener.open(tab.id, "Could not open the custom tab's project")}
        >
          <FolderGit2Icon />
          Open source project
        </DropdownMenuItem>
      )}
    </>
  );
}

function MenuNote({
  children,
  tone = "muted",
}: {
  children: ReactNode;
  tone?: "muted" | "error";
}): ReactElement {
  return (
    <p
      className={
        tone === "error"
          ? "flex items-center gap-2 px-2 py-1.5 text-xs text-destructive"
          : "flex items-center gap-2 px-2 py-1.5 text-xs text-muted-foreground"
      }
    >
      {children}
    </p>
  );
}
