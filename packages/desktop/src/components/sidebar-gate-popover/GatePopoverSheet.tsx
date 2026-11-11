import { useId, type ReactElement } from "react";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import { GatePopoverFrame } from "@/components/sidebar-gate-popover/GatePopoverFrame";
import { triggerPendingKind } from "@/components/sidebar-pending-gate";
import {
  keepEscapeInDenyField,
  keepTypingInQuickReply,
} from "@/components/sidebar-gate-popover/gate-content-events";
import { useGateCloseFocus } from "@/hooks/useGateCloseFocus";
import { useFeatureStatus } from "@/stores/session-status-selectors";
import {
  gateRequestKey,
  usePendingGatePopoverStore,
  type OpenGatePopover,
} from "@/stores/pending-gate-popover-store";
import { useFeaturePendingRequestId } from "@/stores/pending-gate-popover-selectors";
import { cn } from "@/lib/utils";

/** The sheet sits above the mobile drawer (z-50) and its backdrop. */
const SHEET_CLASS = cn(
  "z-[60] flex flex-col gap-0 overflow-hidden p-0",
  "top-auto bottom-0 left-0 w-full max-w-none translate-x-0 translate-y-0 sm:max-w-none",
  "rounded-t-2xl rounded-b-none border-x-0 border-b-0",
  "max-h-[85dvh] pb-[env(safe-area-inset-bottom)]",
  "data-[state=open]:slide-in-from-bottom data-[state=closed]:slide-out-to-bottom",
  "data-[state=open]:zoom-in-100 data-[state=closed]:zoom-out-100",
);

/**
 * A phone's quick reply: a bottom sheet over the conversation (the drawer's
 * rows are mostly off screen, so nothing could anchor a popover). Hosted once,
 * outside any row, so it survives the drawer closing under it.
 */
export function GatePopoverSheet({
  onOpenConversation,
}: {
  onOpenConversation: (featureId: number) => void;
}): ReactElement | null {
  const open = usePendingGatePopoverStore((state) =>
    state.open?.surface === "sheet" ? state.open : null,
  );
  if (!open) return null;
  return <OpenSheet open={open} onOpenConversation={onOpenConversation} />;
}

function OpenSheet({
  open,
  onOpenConversation,
}: {
  open: OpenGatePopover;
  onOpenConversation: (featureId: number) => void;
}): ReactElement {
  const { featureId, origin } = open;
  const { kind: liveKind } = useFeatureStatus(featureId);
  const requestKey = gateRequestKey(featureId, useFeaturePendingRequestId(featureId));
  const titleId = useId();
  const onCloseAutoFocus = useGateCloseFocus(origin);
  const close = (): void => usePendingGatePopoverStore.getState().closeGate(requestKey);
  return (
    <Dialog open onOpenChange={(next) => !next && close()}>
      <DialogContent
        showCloseButton={false}
        className={SHEET_CLASS}
        aria-labelledby={titleId}
        onOpenAutoFocus={(event) => event.preventDefault()}
        onCloseAutoFocus={onCloseAutoFocus}
        onEscapeKeyDown={keepEscapeInDenyField}
        onKeyDown={keepTypingInQuickReply}
      >
        <DialogTitle className="sr-only">Pending request</DialogTitle>
        <GatePopoverFrame
          featureId={featureId}
          kind={triggerPendingKind(liveKind, null)}
          origin={origin}
          touch
          titleId={titleId}
          onClose={close}
          onOpenConversation={() => {
            close();
            onOpenConversation(featureId);
          }}
        />
      </DialogContent>
    </Dialog>
  );
}
