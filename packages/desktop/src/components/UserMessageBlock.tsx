import { PaperclipIcon } from "lucide-react";
import { useMemo, useRef, type ReactElement, type ReactNode, type RefObject } from "react";
import { Markdown } from "@/components/Markdown";
import { UserMessageImages } from "@/components/UserMessageImages";
import { GeneratedBySessionBadge } from "@/components/GeneratedBySessionBadge";
import { CollapsibleSection } from "@/components/ui/collapsible-section";
import { cn } from "@/lib/utils";
import { parseUserMessageContent, type ParsedPromptAttachment } from "@/types/agent-types";
import type { AgentMessageOrigin } from "@/api/generated";
import type { PromptDeliveryState } from "@/types/agent";

interface UserMessageBlockProps {
  content: string;
  deliveryState?: PromptDeliveryState;
  origin?: AgentMessageOrigin | null;
  /**
   * On-hover action row (Copy / Fork / Rewind) rendered under the bubble.
   * Receives the bubble so actions can serialize the rendered message.
   */
  renderActions?: (bubbleRef: RefObject<HTMLDivElement | null>) => ReactNode;
}

const DELIVERY_BUBBLE_STYLES: Record<PromptDeliveryState, string> = {
  pending_agent: "border-amber-500/50 bg-amber-500/10",
  received_agent: "border-primary/30 bg-primary/10",
  delivery_unknown: "border-border bg-muted/40",
  delivery_failed: "border-destructive/50 bg-destructive/10",
};

export function UserMessageBlock({
  content,
  deliveryState,
  origin,
  renderActions,
}: UserMessageBlockProps): ReactElement {
  const bubbleRef = useRef<HTMLDivElement>(null);
  const {
    text: textContent,
    images,
    attachments,
  } = useMemo(() => parseUserMessageContent(content), [content]);
  const isPendingDelivery = deliveryState === "pending_agent";
  const isUnknownDelivery = deliveryState === "delivery_unknown";
  const isFailedDelivery = deliveryState === "delivery_failed";
  const isGenerated = origin?.originKind === "session_generated";

  return (
    <div className="group/usermsg my-1 flex flex-col items-end">
      <div
        ref={bubbleRef}
        data-testid="user-message-bubble"
        data-prompt-delivery-state={deliveryState}
        className={cn(
          "max-w-[80%] rounded-md border px-3 py-1.5 text-sm transition-colors duration-500 ease-[var(--ease-fluid)]",
          deliveryState ? DELIVERY_BUBBLE_STYLES[deliveryState] : "border-primary/30 bg-primary/10",
        )}
      >
        <Markdown content={textContent} className="user-message-markdown" />
        {images.length > 0 && <UserMessageImages images={images} />}
        {attachments.length > 0 && <AttachmentFileList attachments={attachments} />}
        {isGenerated && <GeneratedBySessionBadge origin={origin} />}
      </div>
      {/*
        Collapse the pending-receipt row on exit so the surrounding stream
        slides up smoothly instead of jumping when the agent acknowledges the
        message. CollapsibleSection honours the global `data-animations` kill-
        switch, so it unmounts instantly when Fluid animations are off.
      */}
      <CollapsibleSection open={isPendingDelivery}>
        <div className="mt-0.5 flex items-center gap-1.5 font-mono text-[10.5px]">
          <span
            className="size-1.5 animate-pulse rounded-full bg-amber-400/90"
            aria-hidden="true"
          />
          <span className="text-amber-300">Not received by agent yet…</span>
        </div>
      </CollapsibleSection>
      {isUnknownDelivery && (
        <div className="mt-0.5 flex items-center gap-1.5 font-mono text-[10.5px] text-muted-foreground">
          <span className="size-1.5 rounded-full bg-muted-foreground/70" aria-hidden="true" />
          <span>Agent receipt could not be confirmed</span>
        </div>
      )}
      {isFailedDelivery && (
        <div className="mt-0.5 flex items-center gap-1.5 font-mono text-[10.5px] text-destructive">
          <span className="size-1.5 rounded-full bg-destructive/80" aria-hidden="true" />
          <span>Message was not delivered to the agent</span>
        </div>
      )}
      {renderActions?.(bubbleRef)}
    </div>
  );
}

function AttachmentFileList({
  attachments,
}: {
  attachments: ParsedPromptAttachment[];
}): ReactElement {
  return (
    <div className="mt-2 flex flex-wrap gap-2">
      {attachments.map((attachment, index) => (
        <span
          key={`${attachment.fileName}:${attachment.mimeType}:${index}`}
          className="inline-flex max-w-full items-center gap-1.5 rounded-md border border-border bg-background/70 px-2 py-1 font-mono text-[11.5px] text-muted-foreground"
        >
          <PaperclipIcon className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
          <span className="truncate">{attachment.fileName}</span>
        </span>
      ))}
    </div>
  );
}
