import { useUiTranslation } from "@/lib/i18n/ui";
import { useId, type ReactElement } from "react";
import { Dialog, DialogTitle } from "@/components/ui/dialog";
import { PhoneSheetContent } from "@/components/PhoneSheet";
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
  const { t } = useUiTranslation();
  const { featureId, origin } = open;
  const { kind: liveKind } = useFeatureStatus(featureId);
  const requestKey = gateRequestKey(featureId, useFeaturePendingRequestId(featureId));
  const titleId = useId();
  const onCloseAutoFocus = useGateCloseFocus(origin);
  const close = (): void => usePendingGatePopoverStore.getState().closeGate(requestKey);
  return (
    <Dialog open onOpenChange={(next) => !next && close()}>
      {/* Above the mobile drawer (z-50) and its backdrop. */}
      <PhoneSheetContent
        className="z-[60]"
        aria-labelledby={titleId}
        onCloseAutoFocus={onCloseAutoFocus}
        onEscapeKeyDown={keepEscapeInDenyField}
        onKeyDown={keepTypingInQuickReply}
      >
        <DialogTitle className="sr-only">
          {t("sidebar.gatePopoverSheet.pendingRequest", "Pending request")}
        </DialogTitle>
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
      </PhoneSheetContent>
    </Dialog>
  );
}
