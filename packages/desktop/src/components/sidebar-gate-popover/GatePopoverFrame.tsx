import { type ReactElement } from "react";
import { GatePopoverHeader } from "@/components/sidebar-gate-popover/GatePopoverHeader";
import { PendingGateBody } from "@/components/sidebar-gate/PendingGateBody";
import { useGatePlanGuard } from "@/hooks/useGatePlanGuard";
import { useSetSidebarOption } from "@/hooks/useSidebarSettings";
import { useSidebarSample } from "@/lib/sidebar-sample-context";
import type { GatePopoverOrigin } from "@/stores/pending-gate-popover-store";
import { useSidebarOption } from "@/stores/sidebar-config-store";
import type { PendingKind } from "@/types/agent";

interface GatePopoverFrameProps {
  featureId: number;
  kind: PendingKind;
  origin: GatePopoverOrigin;
  /** The phone's bottom sheet: larger targets. */
  touch: boolean;
  /** Names the header's title, which labels the popover or sheet. */
  titleId: string;
  /** Close, remembering the request so it doesn't open by itself again. */
  onClose: () => void;
  onOpenConversation: () => void;
}

/**
 * What a quick reply shows, popover or sheet: the shell's header, the request's
 * body (which answers it) and, while the newest request opens by itself, the
 * way to stop that.
 */
export function GatePopoverFrame({
  featureId,
  kind,
  origin,
  touch,
  titleId,
  onClose,
  onOpenConversation,
}: GatePopoverFrameProps): ReactElement | null {
  // A plan gets no quick reply, even where no row said so: this closes it.
  if (useGatePlanGuard(featureId)) return null;
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <GatePopoverHeader
        featureId={featureId}
        kind={kind}
        touch={touch}
        titleId={titleId}
        onOpenConversation={onOpenConversation}
        onClose={onClose}
      />
      <div className="min-h-0 flex-1 overflow-y-auto">
        {/* Keyed by origin: a popover the user takes over (shortcut, arrows) moves focus in; a hovered one never does. */}
        <PendingGateBody
          key={origin}
          featureId={featureId}
          autoFocus={origin === "user"}
          onOpenConversation={onOpenConversation}
          touch={touch}
        />
      </div>
      {touch ? null : <AutoOpenOptOut onClose={onClose} />}
    </div>
  );
}

/** "Auto" mode's way out, kept inside the card that interrupts. */
function AutoOpenOptOut({ onClose }: { onClose: () => void }): ReactElement | null {
  const mode = useSidebarOption("gatePopover");
  const setOption = useSetSidebarOption();
  // The display options preview shows the card, but must not rewrite the user's setting.
  const isSample = useSidebarSample() !== null;
  if (mode !== "auto" || isSample) return null;
  return (
    <footer className="border-t border-border/60 px-3 py-1.5">
      <button
        type="button"
        className="text-[11px] text-muted-foreground underline-offset-2 hover:text-foreground hover:underline focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
        onClick={() => {
          setOption("gatePopover", "click");
          onClose();
        }}
      >
        Don't open automatically
      </button>
    </footer>
  );
}
