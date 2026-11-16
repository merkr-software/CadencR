import {
  memo,
  useContext,
  useEffect,
  useId,
  useRef,
  type ReactElement,
  type RefObject,
} from "react";
import { MessageCircleQuestionIcon, ShieldAlertIcon } from "lucide-react";
import { Popover, PopoverAnchor, PopoverContent } from "@/components/ui/popover";
import { GatePopoverFrame } from "@/components/sidebar-gate-popover/GatePopoverFrame";
import {
  keepEscapeInDenyField,
  keepTypingInQuickReply,
} from "@/components/sidebar-gate-popover/gate-content-events";
import {
  effectiveGateKind,
  PENDING_KIND_TEXT_CLASS,
  PLAN_READY_LABEL,
  triggerPendingKind,
} from "@/components/sidebar-pending-gate";
import { useFeaturePendingGate } from "@/hooks/useFeaturePendingGate";
import { useGateCloseFocus } from "@/hooks/useGateCloseFocus";
import { usePendingGatePopoverOpen } from "@/hooks/usePendingGatePopoverOpen";
import { useSidebarEdgeAnchor } from "@/hooks/useSidebarEdgeAnchor";
import { useUsesGateSheet } from "@/hooks/useUsesGateSheet";
import { GATE_TRIGGER_ATTRIBUTES } from "@/lib/pending-gate-surface";
import { useSidebarSample } from "@/lib/sidebar-sample-context";
import {
  useGatePopoverOriginOn,
  usePendingGatePopoverStore,
} from "@/stores/pending-gate-popover-store";
import { useFeatureStatus } from "@/stores/session-status-selectors";
import { useSidebarOption } from "@/stores/sidebar-config-store";
import { SidebarSurfaceContext, type SidebarSurface } from "@/stores/sidebar-surface-store";
import type { PendingKind } from "@/types/agent";
import { cn } from "@/lib/utils";

interface SidebarPendingGatePopoverProps {
  featureId: number;
  allowAutoOpen: boolean;
  /** The conversation is the one open: its popover closes, and stays shut by itself. */
  isActive: boolean;
  onOpenConversation: () => void;
}

/**
 * The status icon of a conversation that awaits the user, and its quick reply.
 * A plan, or the "Off" mode, leaves a plain icon: the row opens the
 * conversation as usual. Otherwise the icon opens the reply: a popover beside
 * the sidebar on desktop, a bottom sheet on a phone (see
 * `usePendingGatePopoverOpen` for when it opens by itself).
 */
export const SidebarPendingGatePopover = memo(function SidebarPendingGatePopover({
  featureId,
  allowAutoOpen,
  isActive,
  onOpenConversation,
}: SidebarPendingGatePopoverProps): ReactElement {
  const mode = useSidebarOption("gatePopover");
  const { kind: livePendingKind } = useFeatureStatus(featureId);
  // Shares its query with the request line: a plan is only known once fetched.
  const { gate } = useFeaturePendingGate({
    featureId,
    enabled: mode !== "off",
  });
  const gateKind = gate ? effectiveGateKind(gate) : null;
  const isPlan = gateKind === "plan";
  const requestId = gate?.request_id;
  useEffect(() => {
    if (requestId) usePendingGatePopoverStore.getState().markPlanRequest(requestId, isPlan);
  }, [requestId, isPlan]);
  const kind = triggerPendingKind(livePendingKind, gateKind);

  if (isPlan || mode === "off") return <PlainStatusIcon kind={kind} isPlan={isPlan} />;
  return (
    <QuickReply
      featureId={featureId}
      kind={kind}
      allowAutoOpen={allowAutoOpen}
      isActive={isActive}
      gateReady={gate !== undefined}
      onOpenConversation={onOpenConversation}
    />
  );
});

const ICON_CLASS = "inline-flex size-3.5 shrink-0 items-center justify-center rounded-sm";

function KindIcon({ kind }: { kind: PendingKind }): ReactElement {
  return kind === "permission" ? (
    <ShieldAlertIcon className="sidebar-pending-indicator size-3.5" />
  ) : (
    <MessageCircleQuestionIcon className="sidebar-pending-indicator size-3.5" />
  );
}

/** The icon without a quick reply behind it: clicks fall through to the row. */
function PlainStatusIcon({ kind, isPlan }: { kind: PendingKind; isPlan: boolean }): ReactElement {
  return (
    <span
      role="img"
      aria-label={
        isPlan
          ? PLAN_READY_LABEL
          : kind === "permission"
            ? "Pending permission"
            : "Pending question"
      }
      className={cn(ICON_CLASS, PENDING_KIND_TEXT_CLASS[kind])}
    >
      <KindIcon kind={kind} />
    </span>
  );
}

function QuickReply({
  featureId,
  kind,
  allowAutoOpen,
  isActive,
  gateReady,
  onOpenConversation,
}: {
  featureId: number;
  kind: PendingKind;
  allowAutoOpen: boolean;
  isActive: boolean;
  gateReady: boolean;
  onOpenConversation: () => void;
}): ReactElement {
  const surface = useContext(SidebarSurfaceContext);
  // A preview sample's popover is part of the preview: using it keeps the display options open.
  const isSample = useSidebarSample() !== null;
  const triggerRef = useRef<HTMLButtonElement>(null);
  const anchorRef = useSidebarEdgeAnchor(triggerRef);
  const titleId = useId();
  const popover = usePendingGatePopoverOpen(featureId, allowAutoOpen, { isActive, gateReady });
  const usesSheet = useUsesGateSheet();
  const sheetOrigin = useGatePopoverOriginOn(featureId, "sheet");
  // The closing animation outlives the open state: keep showing what it showed.
  const lastOriginRef = useRef(popover.origin);
  if (popover.origin) lastOriginRef.current = popover.origin;
  const shownOrigin = popover.origin ?? lastOriginRef.current;
  const onCloseAutoFocus = useGateCloseFocus(popover.origin);

  const trigger = (
    <GateTrigger
      ref={triggerRef}
      featureId={featureId}
      surface={surface}
      kind={kind}
      expanded={usesSheet ? sheetOrigin !== null : popover.open}
      roomy={usesSheet}
      // A click takes over a card that opened by itself or by hovering, and closes only its own.
      onToggle={() => popover.onOpenChange(usesSheet || popover.origin !== "user")}
      hoverHandlers={usesSheet ? undefined : popover.hoverHandlers}
    />
  );
  if (usesSheet) return trigger;

  return (
    <Popover open={popover.open} onOpenChange={popover.onOpenChange}>
      {/* Not a PopoverTrigger: Radix's trigger re-registers itself as the anchor
          whenever its node remounts, stranding the popover on a detached node. */}
      <PopoverAnchor virtualRef={anchorRef} />
      {trigger}
      <PopoverContent
        side="right"
        align="start"
        sideOffset={8}
        collisionPadding={12}
        // Keep `bg-popover`: solid outside frost; frost themes blur via theme-frost.css.
        className={cn(
          "flex w-[22rem] max-w-[calc(100vw-1.5rem)] flex-col overflow-hidden bg-popover p-0",
          "max-h-[min(var(--radix-popover-content-available-height),40rem)]",
          kind === "permission" && "border-amber-500/40",
        )}
        data-sidebar-sample={isSample ? "" : undefined}
        aria-labelledby={titleId}
        onClick={(event) => event.stopPropagation()}
        onKeyDown={keepTypingInQuickReply}
        // The body moves focus in when the user opened it; an automatic one never takes focus.
        onOpenAutoFocus={(event) => event.preventDefault()}
        // Focus moving elsewhere (the composer of the conversation just opened) never dismisses.
        onFocusOutside={(event) => event.preventDefault()}
        // An automatic popover is a notification card: only X, Escape, an answer or
        // opening its conversation close it, not a click elsewhere.
        onPointerDownOutside={(event) => {
          if (shownOrigin === "auto") event.preventDefault();
        }}
        // Escape closes the topmost card wherever focus is (Radix consumes that one
        // Escape either way; keeping the card would swallow every later one, the
        // composer's Stop included). In the deny field it only cancels the field.
        onEscapeKeyDown={keepEscapeInDenyField}
        onCloseAutoFocus={onCloseAutoFocus}
        {...popover.hoverHandlers}
      >
        {shownOrigin ? (
          <GatePopoverFrame
            featureId={featureId}
            kind={kind}
            origin={shownOrigin}
            touch={false}
            titleId={titleId}
            onClose={popover.close}
            onOpenConversation={() => {
              popover.close();
              onOpenConversation();
            }}
          />
        ) : null}
      </PopoverContent>
    </Popover>
  );
}

/** The status icon as the quick reply's toggle: 14px, with a larger invisible target. */
function GateTrigger({
  ref,
  featureId,
  surface,
  kind,
  expanded,
  roomy,
  onToggle,
  hoverHandlers,
}: {
  ref: RefObject<HTMLButtonElement | null>;
  featureId: number;
  surface: SidebarSurface;
  kind: PendingKind;
  expanded: boolean;
  /** A phone's thumb-sized target. */
  roomy: boolean;
  onToggle: () => void;
  hoverHandlers: ReturnType<typeof usePendingGatePopoverOpen>["hoverHandlers"];
}): ReactElement {
  return (
    <button
      ref={ref}
      type="button"
      aria-label={kind === "permission" ? "Pending permission" : "Pending question"}
      aria-haspopup="dialog"
      aria-expanded={expanded}
      {...{
        [GATE_TRIGGER_ATTRIBUTES.trigger]: "",
        [GATE_TRIGGER_ATTRIBUTES.featureId]: featureId,
        [GATE_TRIGGER_ATTRIBUTES.surface]: surface,
      }}
      className={cn(
        ICON_CLASS,
        "relative hover:bg-sidebar-accent",
        // The icon stays 14px; its target grows without moving the row's layout.
        "before:absolute before:content-['']",
        roomy ? "before:-inset-[13px]" : "before:-inset-[5px]",
        "focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring",
        PENDING_KIND_TEXT_CLASS[kind],
      )}
      onClick={(event) => {
        event.stopPropagation();
        onToggle();
      }}
      onPointerDown={(event) => event.stopPropagation()}
      {...hoverHandlers}
    >
      <KindIcon kind={kind} />
    </button>
  );
}
