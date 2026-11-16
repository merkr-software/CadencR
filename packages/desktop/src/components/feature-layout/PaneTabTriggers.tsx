import { type ComponentProps, type ReactNode } from "react";
import { useDraggable } from "@dnd-kit/core";
import { CSS } from "@dnd-kit/utilities";
import { MinusIcon, XIcon } from "lucide-react";

import { ShortcutTooltip } from "@/components/ShortcutTooltip";
import { TabsTrigger } from "@/components/ui/tabs";
import { useShortcutKeys } from "@/hooks/useShortcutLabel";
import type { ShortcutId } from "@/lib/shortcuts/registry";
import type { TabKind } from "@/stores/feature-layout-schema";
import { cn } from "@/lib/utils";

import { FeatureTabIcon } from "./FeatureTabIcon";
import type { FeatureTabDef } from "./types";

/**
 * What a trigger's X does: `close` takes a closable (plugin) tab out of the
 * layout, `dock` returns a built-in from a floating pane to the root strip.
 * Built-ins in the root strip have no X.
 */
type TabCloseAction = "close" | "dock" | null;

export function tabCloseAction(def: FeatureTabDef, isRootPane: boolean): TabCloseAction {
  if (def.closable) return "close";
  return isRootPane ? null : "dock";
}

/** Where a tab tooltip opens, for triggers outside the strip (see `PopPaneRail`). */
type TabTooltipPlacement = Pick<
  ComponentProps<typeof ShortcutTooltip>,
  "above" | "toLeft" | "toRight"
>;

function BoundTabTooltip({
  label,
  shortcutId,
  placement,
  children,
}: {
  label: string;
  shortcutId: ShortcutId;
  placement?: TabTooltipPlacement;
  children: ReactNode;
}): ReactNode {
  const keys = useShortcutKeys(shortcutId);
  return (
    <ShortcutTooltip label={label} keys={keys} {...placement}>
      {children}
    </ShortcutTooltip>
  );
}

/** Tab tooltip: shows the tab's live registry binding when it has one. */
export function TabTooltip({
  def,
  label = def.label,
  placement,
  children,
}: {
  def: FeatureTabDef;
  label?: string;
  placement?: TabTooltipPlacement;
  children: ReactNode;
}): ReactNode {
  if (!def.shortcutId) {
    return (
      <ShortcutTooltip label={label} {...placement}>
        {children}
      </ShortcutTooltip>
    );
  }
  return (
    <BoundTabTooltip label={label} shortcutId={def.shortcutId} placement={placement}>
      {children}
    </BoundTabTooltip>
  );
}

function TabTriggerBody({ def }: { def: FeatureTabDef }): ReactNode {
  return (
    <>
      <FeatureTabIcon def={def} />
      <span data-tab-label>{def.label}</span>
      {def.badge}
    </>
  );
}

function TabCloseButton({
  def,
  action,
  onClose,
}: {
  def: FeatureTabDef;
  action: "close" | "dock";
  onClose: () => void;
}): ReactNode {
  // Docking only returns a split-out tab to the root strip, so it must not look
  // like a close.
  const Icon = action === "close" ? XIcon : MinusIcon;
  return (
    <ShortcutTooltip
      label={action === "close" ? "Close tab" : "Return to main tabs"}
      className="absolute right-1.5 top-1/2 -translate-y-1/2"
    >
      <button
        type="button"
        onClick={(e) => {
          e.stopPropagation();
          onClose();
        }}
        className="flex rounded p-0.5 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
        aria-label={
          action === "close" ? `Close ${def.label}` : `Return ${def.label} to the root tab strip`
        }
      >
        <Icon className="size-3" />
      </button>
    </ShortcutTooltip>
  );
}

interface DraggableTabTriggerProps {
  featureId: number;
  paneId: string;
  tab: TabKind;
  def: FeatureTabDef;
  closeAction: TabCloseAction;
  isFocusedPane: boolean;
  onActivate: () => void;
  onClose: () => void;
}

export function DraggableTabTrigger({
  featureId,
  paneId,
  tab,
  def,
  closeAction,
  isFocusedPane,
  onActivate,
  onClose,
}: DraggableTabTriggerProps): ReactNode {
  const { attributes, listeners, setNodeRef, transform, isDragging } = useDraggable({
    id: `tab:${paneId}:${tab}`,
    data: { kind: "pane", paneId, tab } as const,
  });

  return (
    <div
      ref={setNodeRef}
      style={{
        transform: CSS.Translate.toString(transform),
        opacity: isDragging ? 0.4 : undefined,
      }}
      className="relative inline-flex shrink-0"
    >
      <TabTooltip def={def}>
        <TabsTrigger
          value={tab}
          data-feature-tab-kind={tab}
          data-feature-id={featureId}
          data-tab-closable={closeAction ? "" : undefined}
          {...attributes}
          {...listeners}
          onClick={onActivate}
          className={cn(
            "cursor-grab active:cursor-grabbing",
            closeAction && "pr-8",
            !isFocusedPane && "data-[state=active]:after:bg-transparent",
          )}
        >
          <TabTriggerBody def={def} />
        </TabsTrigger>
      </TabTooltip>
      {closeAction && <TabCloseButton def={def} action={closeAction} onClose={onClose} />}
    </div>
  );
}

interface StaticTabTriggerProps {
  featureId: number;
  tab: TabKind;
  def: FeatureTabDef;
  /** `tabCloseAction` for the root pane: only closable tabs get an X. */
  closeAction: TabCloseAction;
  isFocusedPane: boolean;
  onActivate: () => void;
  onClose: () => void;
}

export function StaticTabTrigger({
  featureId,
  tab,
  def,
  closeAction,
  isFocusedPane,
  onActivate,
  onClose,
}: StaticTabTriggerProps): ReactNode {
  const trigger = (
    <TabTooltip def={def}>
      <TabsTrigger
        value={tab}
        data-feature-tab-kind={tab}
        data-feature-id={featureId}
        data-tab-closable={closeAction ? "" : undefined}
        onClick={onActivate}
        className={cn(
          "group",
          closeAction && "pr-8",
          !isFocusedPane && "data-[state=active]:after:bg-transparent",
        )}
      >
        <TabTriggerBody def={def} />
      </TabsTrigger>
    </TabTooltip>
  );
  if (!closeAction) return trigger;
  return (
    <div className="relative inline-flex shrink-0">
      {trigger}
      <TabCloseButton def={def} action={closeAction} onClose={onClose} />
    </div>
  );
}
