import type { ReactNode } from "react";
import { CheckIcon, XIcon } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Dialog, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { PHONE_SHEET_ROW_CLASS, PhoneSheetContent } from "@/components/PhoneSheet";
import type { TabKind } from "@/stores/feature-layout-schema";
import { cn } from "@/lib/utils";

import { FeatureTabIcon } from "./FeatureTabIcon";
import { phoneTabLabel } from "./phone-tab-bar";
import type { FeatureTabs } from "./types";

interface PhoneTabMoreSheetProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  tabIds: readonly TabKind[];
  tabs: FeatureTabs;
  activeTabId: TabKind | null;
  onActivateTab: (tab: TabKind) => void;
  onCloseTab: (tab: TabKind) => void;
}

/**
 * The tab bar's More: every tab without a slot in the bar, one 44px row
 * each, with the strip's badge and, for a custom tab, the strip's close.
 */
export function PhoneTabMoreSheet({
  open,
  onOpenChange,
  tabIds,
  tabs,
  activeTabId,
  onActivateTab,
  onCloseTab,
}: PhoneTabMoreSheetProps): ReactNode {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <PhoneSheetContent>
        <div className="px-4 pt-4 pb-2">
          <DialogTitle className="text-base">More tabs</DialogTitle>
          <DialogDescription className="sr-only">
            Open a tab that has no place in the tab bar.
          </DialogDescription>
        </div>
        <ul className="flex flex-col overflow-y-auto px-2 pb-3">
          {tabIds.map((tab) => {
            const def = tabs[tab];
            if (!def) return null;
            const label = phoneTabLabel(tab, def);
            const active = tab === activeTabId;
            return (
              <li key={tab} className="flex items-center gap-1">
                <button
                  type="button"
                  aria-current={active ? "page" : undefined}
                  className={cn(PHONE_SHEET_ROW_CLASS, "flex-1", active && "text-primary")}
                  onClick={() => {
                    onOpenChange(false);
                    onActivateTab(tab);
                  }}
                >
                  <FeatureTabIcon def={def} className="size-5" />
                  <span className="min-w-0 truncate">{label}</span>
                  {def.badge}
                  {active && <CheckIcon aria-hidden className="ml-auto size-4 shrink-0" />}
                </button>
                {def.closable && (
                  <Button
                    variant="ghost"
                    size="icon"
                    className="size-11 text-muted-foreground"
                    aria-label={`Close ${label}`}
                    onClick={() => onCloseTab(tab)}
                  >
                    <XIcon />
                  </Button>
                )}
              </li>
            );
          })}
        </ul>
      </PhoneSheetContent>
    </Dialog>
  );
}
