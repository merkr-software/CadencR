import {
  memo,
  useCallback,
  useEffect,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
  type ReactElement,
  type ReactNode,
} from "react";
import { PanelLeft } from "lucide-react";
import { popResize, pushResize } from "@/lib/resize-coordinator";
import { ShortcutTooltip } from "@/components/ShortcutTooltip";

interface ResizableSidebarLayoutProps {
  collapsed: boolean;
  disabled?: boolean;
  sidebar: ReactNode;
  content: ReactNode;
  onCollapsedChange: (collapsed: boolean) => void;
  defaultWidth: number;
  minWidth: number;
  maxWidth: number;
  collapsedWidth?: number;
  showCollapsedRail?: boolean;
  expandButtonLabel: string;
  expandButtonTitle: string;
  /** When set, the collapsed-rail expand button shows a `ShortcutTooltip`
   *  rendering this combo (the registry-resolved keys, see `useShortcutKeys`) under the label. */
  expandShortcutKeys?: string[];
  separatorLabel: string;
  className?: string;
}

interface DragState {
  startX: number;
  startWidth: number;
  frame: number | null;
  pendingWidth: number | null;
}

interface SidebarResizeConfig {
  defaultWidth: number;
  minWidth: number;
  maxWidth: number;
}

function clampWidth(width: number, minWidth: number, maxWidth: number): number {
  return Math.min(maxWidth, Math.max(minWidth, Math.round(width)));
}

function useSidebarResize({ defaultWidth, minWidth, maxWidth }: SidebarResizeConfig): {
  sidebarWidth: number;
  startResize: (event: ReactPointerEvent<HTMLDivElement>) => void;
} {
  const [sidebarWidth, setSidebarWidth] = useState(defaultWidth);
  const dragStateRef = useRef<DragState | null>(null);

  const onResizeMove = useCallback(
    (event: PointerEvent): void => {
      const state = dragStateRef.current;
      if (!state) return;
      const nextWidth = clampWidth(
        state.startWidth + event.clientX - state.startX,
        minWidth,
        maxWidth,
      );
      if (state.pendingWidth === nextWidth) return;
      state.pendingWidth = nextWidth;
      if (state.frame !== null) cancelAnimationFrame(state.frame);
      state.frame = requestAnimationFrame(() => {
        setSidebarWidth((current) => (current === nextWidth ? current : nextWidth));
        if (dragStateRef.current) dragStateRef.current.frame = null;
      });
    },
    [maxWidth, minWidth],
  );

  const endResize = useCallback((): void => {
    const state = dragStateRef.current;
    if (!state) return;
    if (state.frame != null) cancelAnimationFrame(state.frame);
    dragStateRef.current = null;
    popResize();
    document.body.style.cursor = "";
    document.body.style.userSelect = "";
    window.removeEventListener("pointermove", onResizeMove);
    window.removeEventListener("pointerup", endResize);
    window.removeEventListener("pointercancel", endResize);
  }, [onResizeMove]);

  const startResize = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>): void => {
      if (event.pointerType === "mouse" && event.button > 0) return;
      event.preventDefault();
      endResize();
      dragStateRef.current = {
        startX: event.clientX,
        startWidth: sidebarWidth,
        frame: null,
        pendingWidth: null,
      };
      pushResize();
      document.body.style.cursor = "col-resize";
      document.body.style.userSelect = "none";
      window.addEventListener("pointermove", onResizeMove);
      window.addEventListener("pointerup", endResize);
      window.addEventListener("pointercancel", endResize);
    },
    [endResize, onResizeMove, sidebarWidth],
  );

  useEffect(() => endResize, [endResize]);

  return { sidebarWidth, startResize };
}

function CollapsedRail({
  disabled,
  expandButtonLabel,
  expandButtonTitle,
  expandShortcutKeys,
  onExpand,
}: {
  disabled: boolean;
  expandButtonLabel: string;
  expandButtonTitle: string;
  expandShortcutKeys?: string[];
  onExpand: () => void;
}): ReactElement {
  const button = (
    <button
      type="button"
      title={expandShortcutKeys ? undefined : expandButtonTitle}
      aria-label={expandButtonLabel}
      className="inline-flex h-7 w-7 items-center justify-center rounded text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
      disabled={disabled}
      onClick={onExpand}
    >
      <PanelLeft className="h-4 w-4" />
    </button>
  );
  return (
    <div className="flex h-full w-full justify-center pt-2">
      {expandShortcutKeys ? (
        // Side-positioned: the rail is narrow (~36px), so rendering the
        // bubble below the trigger overlaps the editor pane to the right;
        // `toRight` puts the bubble in the empty editor area where nothing
        // competes for stacking.
        <ShortcutTooltip label={expandButtonTitle} keys={expandShortcutKeys} toRight>
          {button}
        </ShortcutTooltip>
      ) : (
        button
      )}
    </div>
  );
}

function ResizeSeparator({
  label,
  onPointerDown,
}: {
  label: string;
  onPointerDown: (event: ReactPointerEvent<HTMLDivElement>) => void;
}): ReactElement {
  return (
    <div
      role="separator"
      aria-orientation="vertical"
      aria-label={label}
      className="group relative cursor-col-resize bg-border"
      onPointerDown={onPointerDown}
    >
      <div className="absolute inset-y-0 -left-2 -right-2" />
      <div className="pointer-events-none absolute left-1/2 top-1/2 h-8 w-1.5 -translate-x-1/2 -translate-y-1/2 rounded-full bg-foreground/40 opacity-0 transition-opacity group-hover:opacity-100" />
    </div>
  );
}

function ResizableSidebarLayoutImpl({
  collapsed,
  disabled = false,
  sidebar,
  content,
  onCollapsedChange,
  defaultWidth,
  minWidth,
  maxWidth,
  collapsedWidth = 36,
  showCollapsedRail = true,
  expandButtonLabel,
  expandButtonTitle,
  expandShortcutKeys,
  separatorLabel,
  className = "h-full w-full",
}: ResizableSidebarLayoutProps): ReactElement {
  const { sidebarWidth, startResize } = useSidebarResize({ defaultWidth, minWidth, maxWidth });
  const shouldShowRail = collapsed && showCollapsedRail;
  const columnTemplate = collapsed
    ? `${shouldShowRail ? collapsedWidth : 0}px minmax(0, 1fr)`
    : `${sidebarWidth}px 1px minmax(0, 1fr)`;

  // Always mount the sidebar — even when collapsed — and toggle visibility
  // via CSS. This keeps any state inside the sidebar alive across
  // collapse/expand cycles. In particular, the editor file tree's pierre
  // model holds tens of thousands of paths; rebuilding it on every expand
  // (which is what happens when the sidebar unmounts) feels sluggish.
  // `display: none` is enough — pierre's virtualizer recovers via its
  // resize observer when the column un-hides.
  return (
    <div
      className={`grid overflow-hidden ${className}`}
      style={{ gridTemplateColumns: columnTemplate }}
    >
      <div
        className={`relative min-w-0 overflow-hidden ${
          shouldShowRail ? "border-r border-border bg-card" : ""
        }`}
      >
        <div className={collapsed ? "hidden" : "h-full w-full"} aria-hidden={collapsed}>
          {sidebar}
        </div>
        {collapsed && shouldShowRail && (
          <CollapsedRail
            disabled={disabled}
            expandButtonLabel={expandButtonLabel}
            expandButtonTitle={expandButtonTitle}
            expandShortcutKeys={expandShortcutKeys}
            onExpand={() => onCollapsedChange(false)}
          />
        )}
      </div>
      {!collapsed && <ResizeSeparator label={separatorLabel} onPointerDown={startResize} />}
      <div className="min-w-0 overflow-hidden">{content}</div>
    </div>
  );
}

export const ResizableSidebarLayout = memo(ResizableSidebarLayoutImpl);
