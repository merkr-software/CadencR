import { memo, useState, type KeyboardEvent, type ReactNode } from "react";
import { EllipsisIcon } from "lucide-react";

import type { TabKind } from "@/stores/feature-layout-schema";
import { cn } from "@/lib/utils";

import { FeatureTabIcon } from "./FeatureTabIcon";
import { phoneTabLabel, rovingTabIndex, splitPhoneTabs } from "./phone-tab-bar";
import { PhoneTabMoreSheet } from "./PhoneTabMoreSheet";
import type { FeatureTabDef, FeatureTabs } from "./types";

interface PhoneTabBarProps {
  featureId: number;
  activeTabId: TabKind | null;
  tabIds: readonly TabKind[];
  tabs: FeatureTabs;
  onActivateTab: (tab: TabKind) => void;
  /** Take a closable (plugin) tab out of the layout. */
  onCloseTab: (tab: TabKind) => void;
}

/** The More button's place in the roving Tab stop. */
const MORE = "more" as const;

const TAB_CLASS = cn(
  "relative flex min-h-11 min-w-0 flex-1 flex-col items-center justify-center gap-1 px-1",
  "text-muted-foreground outline-none transition-colors aria-selected:text-primary",
  "focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring",
);

/**
 * The phone layout's conversation tabs, along the bottom edge (styles in
 * `phone-tab-bar.css`): Agent, Terminal, Git, Files, and More for the rest
 * (Browser, Preview, custom tabs). It drives the root pane exactly as the
 * strip does on a wider screen — same active tab, same activation handler.
 */
export const PhoneTabBar = memo(function PhoneTabBar({
  featureId,
  activeTabId,
  tabIds,
  tabs,
  onActivateTab,
  onCloseTab,
}: PhoneTabBarProps): ReactNode {
  const [moreOpen, setMoreOpen] = useState(false);
  const { bar, more } = splitPhoneTabs(tabIds, tabs);
  const moreActive = activeTabId != null && more.includes(activeTabId);
  // The bar's one Tab stop: the active tab, else its first, so it never drops
  // out of the Tab order while no tab it shows is active.
  const tabStop: TabKind | typeof MORE | null = moreActive
    ? MORE
    : activeTabId != null && bar.includes(activeTabId)
      ? activeTabId
      : (bar[0] ?? (more.length > 0 ? MORE : null));
  return (
    <div
      role="tablist"
      aria-label="Conversation tabs"
      aria-orientation="horizontal"
      data-phone-tab-bar
      className="phone-tab-bar"
      onKeyDown={moveFocusWithArrows}
    >
      {bar.map((tab) => {
        const def = tabs[tab];
        if (!def) return null;
        return (
          <PhoneTab
            key={tab}
            featureId={featureId}
            tab={tab}
            def={def}
            active={tab === activeTabId}
            tabStop={tab === tabStop}
            onActivate={onActivateTab}
          />
        );
      })}
      {more.length > 0 && (
        <button
          type="button"
          role="tab"
          aria-selected={moreActive}
          aria-haspopup="dialog"
          tabIndex={tabStop === MORE ? 0 : -1}
          className={TAB_CLASS}
          onClick={() => setMoreOpen(true)}
        >
          <EllipsisIcon aria-hidden className="size-5 shrink-0" />
          <span data-phone-tab-label className="max-w-full truncate text-[11px] font-medium">
            More
          </span>
        </button>
      )}
      <PhoneTabMoreSheet
        open={moreOpen}
        onOpenChange={setMoreOpen}
        tabIds={more}
        tabs={tabs}
        activeTabId={activeTabId}
        onActivateTab={onActivateTab}
        onCloseTab={onCloseTab}
      />
    </div>
  );
});

function PhoneTab({
  featureId,
  tab,
  def,
  active,
  tabStop,
  onActivate,
}: {
  featureId: number;
  tab: TabKind;
  def: FeatureTabDef;
  active: boolean;
  tabStop: boolean;
  onActivate: (tab: TabKind) => void;
}): ReactNode {
  return (
    <button
      type="button"
      role="tab"
      aria-selected={active}
      tabIndex={tabStop ? 0 : -1}
      data-feature-tab-kind={tab}
      data-feature-id={featureId}
      className={TAB_CLASS}
      onClick={() => onActivate(tab)}
    >
      <FeatureTabIcon def={def} className="size-5" />
      {/* The label comes first in reading order: the badge only adds to it. */}
      <span data-phone-tab-label className="max-w-full truncate text-[11px] font-medium">
        {phoneTabLabel(tab, def)}
      </span>
      {def.barBadge != null && (
        <span className="pointer-events-none absolute top-1 left-[calc(50%+0.375rem)]">
          {def.barBadge}
        </span>
      )}
    </button>
  );
}

/** Arrow keys, Home and End move focus between the bar's tabs (ARIA tabs pattern). */
function moveFocusWithArrows(event: KeyboardEvent<HTMLDivElement>): void {
  const tabsInBar = Array.from(
    event.currentTarget.querySelectorAll<HTMLElement>(":scope > [role='tab']"),
  );
  const index = tabsInBar.findIndex((element) => element === document.activeElement);
  if (index === -1) return;
  const next = rovingTabIndex(event.key, index, tabsInBar.length);
  if (next === null) return;
  event.preventDefault();
  tabsInBar[next]?.focus();
}
