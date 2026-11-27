import { translateUi, useUiTranslation } from "@/lib/i18n/ui";
import { useEffect, useRef, type ReactElement, type RefObject } from "react";
import {
  ArrowDown,
  ArrowUp,
  Folder,
  GripVertical,
  HistoryIcon,
  InboxIcon,
  LoaderIcon,
  PinIcon,
  type LucideIcon,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import type { SidebarDisplayForm } from "@/components/SidebarDisplayOptions";
import { useSetSidebarSectionOrder, useSidebarSectionReorder } from "@/hooks/useSidebarSections";
import type { SidebarConfig, SidebarSectionId } from "@/lib/sidebar-config";
import { shiftSection } from "@/lib/sidebar-sections";
import { cn } from "@/lib/utils";

export function sectionOrderDescription(): string {
  return translateUi(
    "sidebar.displayOptions.sectionOrderDescription",
    "The order of the blocks and the project list, top to bottom. Drag a section here or by its header in the sidebar.",
  );
}

interface SectionMeta {
  label: string;
  icon: LucideIcon;
  /** The switch that shows the block, for the ones that can be turned off. */
  shownBy?: "forMe" | "workingBlock" | "recentBlock";
}

const SECTION_META: Record<SidebarSectionId, SectionMeta> = {
  "for-me": {
    get label() {
      return translateUi("sidebar.sectionOrder.forme.forMe.label", "For me");
    },
    icon: InboxIcon,
    shownBy: "forMe",
  },
  working: {
    get label() {
      return translateUi("sidebar.sectionOrder.working.inProgress.label", "In progress");
    },
    icon: LoaderIcon,
    shownBy: "workingBlock",
  },
  recent: {
    get label() {
      return translateUi("sidebar.sectionOrder.recent.recent.label", "Recent");
    },
    icon: HistoryIcon,
    shownBy: "recentBlock",
  },
  pinned: {
    get label() {
      return translateUi("sidebar.sectionOrder.pinned.pinned.label", "Pinned");
    },
    icon: PinIcon,
  },
  projects: {
    get label() {
      return translateUi("sidebar.sectionOrder.projects.projects.label", "Projects");
    },
    icon: Folder,
  },
};

/**
 * "Block order": every section of the sidebar in its current order, each
 * movable by dragging or by its arrow buttons. Blocks turned off keep their
 * place, marked Off, so turning one back on puts it where it was.
 */
export function SidebarSectionOrderList({ form }: { form: SidebarDisplayForm }): ReactElement {
  const { t } = useUiTranslation();
  const order = form.config.sectionOrder;
  return (
    <ol
      aria-label={t("sidebar.displayOptions.blockOrder", "Block order")}
      className="flex flex-col overflow-hidden rounded-md border border-border/60"
    >
      {order.map((id, index) => (
        <SectionOrderItem
          key={id}
          id={id}
          order={order}
          first={index === 0}
          last={index === order.length - 1}
          off={isOff(form.config, id)}
        />
      ))}
    </ol>
  );
}

function isOff(config: SidebarConfig, id: SidebarSectionId): boolean {
  const shownBy = SECTION_META[id].shownBy;
  return shownBy !== undefined && !config[shownBy];
}

function SectionOrderItem({
  id,
  order,
  first,
  last,
  off,
}: {
  id: SidebarSectionId;
  order: readonly SidebarSectionId[];
  first: boolean;
  last: boolean;
  off: boolean;
}): ReactElement {
  const { t } = useUiTranslation();
  const { label, icon: Icon } = SECTION_META[id];
  const reorder = useSidebarSectionReorder(id);
  const setOrder = useSetSidebarSectionOrder();
  const { upRef, downRef, move } = useArrowMoves(order, first, last, (direction) =>
    setOrder(shiftSection(order, id, direction)),
  );
  return (
    <li
      {...reorder.handle}
      {...reorder.target}
      className={cn(
        "relative flex h-8 items-center gap-1.5 bg-background/40 pl-1 pr-0.5 text-xs",
        "not-last:border-b not-last:border-border/50",
      )}
    >
      <GripVertical aria-hidden className="size-3.5 shrink-0 cursor-grab text-muted-foreground" />
      <Icon aria-hidden className="size-3 shrink-0 text-muted-foreground" />
      <span className={cn("min-w-0 flex-1 truncate", off && "text-muted-foreground")}>{label}</span>
      {off && (
        <span className="shrink-0 text-[10px] text-muted-foreground">
          {t("sidebar.sectionOrder.off", "Off")}
        </span>
      )}
      <Button
        type="button"
        variant="ghost"
        size="icon-xs"
        ref={upRef}
        disabled={first}
        aria-label={t("sidebar.sectionOrder.moveBlockUp", "Move {{label}} up", { label })}
        title={t("sidebar.sectionOrder.moveUp", "Move up")}
        onClick={() => move("up")}
      >
        <ArrowUp />
      </Button>
      <Button
        type="button"
        variant="ghost"
        size="icon-xs"
        ref={downRef}
        disabled={last}
        aria-label={t("sidebar.sectionOrder.moveBlockDown", "Move {{label}} down", { label })}
        title={t("sidebar.sectionOrder.moveDown", "Move down")}
        onClick={() => move("down")}
      >
        <ArrowDown />
      </Button>
    </li>
  );
}

type Direction = "up" | "down";

/**
 * Keeps the focus on a section's arrows as it moves, so they can be pressed
 * again: moving the list item (or disabling the button at either end) would
 * drop it to the page. Once the saved order arrives, the pressed arrow takes
 * it back, or the other one when the section reached the end.
 */
function useArrowMoves(
  order: readonly SidebarSectionId[],
  first: boolean,
  last: boolean,
  shift: (direction: Direction) => void,
): {
  upRef: RefObject<HTMLButtonElement | null>;
  downRef: RefObject<HTMLButtonElement | null>;
  move: (direction: Direction) => void;
} {
  const upRef = useRef<HTMLButtonElement>(null);
  const downRef = useRef<HTMLButtonElement>(null);
  const pressed = useRef<Direction | null>(null);
  useEffect(() => {
    const direction = pressed.current;
    if (!direction) return;
    pressed.current = null;
    const atEnd = direction === "up" ? first : last;
    const keepsUp = direction === "up" ? !atEnd : atEnd;
    (keepsUp ? upRef : downRef).current?.focus();
  }, [order, first, last]);
  return {
    upRef,
    downRef,
    move: (direction) => {
      pressed.current = direction;
      shift(direction);
    },
  };
}
