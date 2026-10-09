import { memo, useCallback, useEffect, useMemo, useRef, useState, type RefObject } from "react";
import { CopyIcon, CheckIcon, RotateCcwIcon, GitBranchIcon, RefreshCwIcon } from "lucide-react";
import { toast } from "sonner";
import { apiErrorMessage } from "@/lib/api-errors";
import { fetchBlob } from "@/lib/blob-ref";
import { copyAs } from "@/lib/markdown-export";
import { readBlobBase64, readPromptBlobBase64 } from "@/lib/prompt-image-cache";
import { parseUserMessageContent, type PromptAttachmentPayload } from "@/types/agent-types";
import { cn } from "@/lib/utils";
import type { AgentBlockData } from "../AgentBlock";
import { useMessageBranchActions } from "./use-message-branch-actions";
import { useWsSessionStore } from "@/stores/ws-session-store";
import { useAgentSessionContext } from "./agent-session-context";
import { CopyAsMenu } from "./CopyAsMenu";

interface UserMessageActionsProps {
  block: AgentBlockData;
  /** The rendered message bubble, serialized by "Copy as → Email". */
  bubbleRef: RefObject<HTMLDivElement | null>;
}

/**
 * On-hover action row shown under a user message: Copy (markdown), Fork, and
 * Rewind. Mirrors the agent text-block copy affordance. Rendered inside the
 * `group/usermsg` hover group owned by `UserMessageBlock`.
 */
function UserMessageActionsImpl({ block, bubbleRef }: UserMessageActionsProps) {
  const [copied, setCopied] = useState(false);
  const { canBranch, rewind, fork } = useMessageBranchActions(block);
  const { wsSessionId } = useAgentSessionContext();
  const sendPrompt = useWsSessionStore((s) => s.sendPrompt);
  const parsedContent = useMemo(() => parseUserMessageContent(block.content), [block.content]);
  const retry = useUserMessageRetry(block, wsSessionId, parsedContent, sendPrompt);
  // Virtuoso recycles stream rows, so a row can unmount inside the 1.5s window —
  // track the timer and clear it on unmount to avoid a dangling timeout.
  const copiedTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(
    () => () => {
      if (copiedTimer.current) clearTimeout(copiedTimer.current);
    },
    [],
  );

  const handleCopy = useCallback(() => {
    void copyAs("markdown", parsedContent.text);
    setCopied(true);
    if (copiedTimer.current) clearTimeout(copiedTimer.current);
    copiedTimer.current = setTimeout(() => setCopied(false), 1500);
  }, [parsedContent.text]);

  return (
    <div className="mt-2 mb-2 flex items-center gap-1 opacity-0 transition-opacity group-hover/usermsg:opacity-100">
      <ActionButton onClick={handleCopy} title="Copy as Markdown">
        {copied ? (
          <>
            <CheckIcon className="size-3 text-green-400" />
            <span className="text-green-400">Copied</span>
          </>
        ) : (
          <>
            <CopyIcon className="size-3" />
            <span>Copy</span>
          </>
        )}
      </ActionButton>
      <CopyAsMenu content={parsedContent.text} sourceRef={bubbleRef} />
      {retry.visible && (
        <ActionButton
          disabled={!retry.available || retry.retrying}
          onClick={retry.send}
          title={
            retry.retrying
              ? "Retrying delivery with the same message identity"
              : retry.available
                ? "Retry delivery with the same message identity"
                : "Retry unavailable because the original attachment data is not stored"
          }
        >
          <RefreshCwIcon className={cn("size-3", retry.retrying && "animate-spin")} />
          <span>{retry.retrying ? "Retrying" : "Retry"}</span>
        </ActionButton>
      )}
      {canBranch && (
        <>
          <ActionButton onClick={fork} title="Fork a new session from this message">
            <GitBranchIcon className="size-3" />
            <span>Fork</span>
          </ActionButton>
          <ActionButton onClick={rewind} title="Rewind the session to this message">
            <RotateCcwIcon className="size-3" />
            <span>Rewind</span>
          </ActionButton>
        </>
      )}
    </div>
  );
}

type ParsedMessage = ReturnType<typeof parseUserMessageContent>;
type SendPrompt = ReturnType<typeof useWsSessionStore.getState>["sendPrompt"];

function useUserMessageRetry(
  block: AgentBlockData,
  wsSessionId: string | null,
  content: ParsedMessage,
  sendPrompt: SendPrompt,
) {
  const [retryingMessageUuid, setRetryingMessageUuid] = useState<string | null>(null);
  const retryTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Images have a third source — the on-disk blob store the backend off-loads
  // them to — which file attachments don't, so the two lists check separately.
  const available =
    content.images.every(
      (image) =>
        image.base64 !== undefined || image.ref !== undefined || image.blobHash !== undefined,
    ) &&
    content.attachments.every(
      (attachment) => attachment.base64 !== undefined || attachment.ref !== undefined,
    );
  const visible =
    wsSessionId != null &&
    block.messageUuid != null &&
    (block.promptDeliveryState === "delivery_failed" ||
      block.promptDeliveryState === "delivery_unknown");
  const retrying = retryingMessageUuid === block.messageUuid;
  useEffect(
    () => () => {
      if (retryTimer.current) clearTimeout(retryTimer.current);
    },
    [],
  );
  const send = useCallback(() => {
    if (!wsSessionId || !block.messageUuid || !available || retrying) return;
    const messageUuid = block.messageUuid;
    setRetryingMessageUuid(messageUuid);
    if (retryTimer.current) clearTimeout(retryTimer.current);
    retryTimer.current = setTimeout(() => setRetryingMessageUuid(null), 15_000);
    // Payloads live in the blob cache rather than in the block, so rebuilding
    // the original prompt means re-encoding them — hence the async hop.
    void buildRetryAttachments(content).then(
      (payloads) => {
        sendPrompt(wsSessionId, content.text, {
          messageUuid,
          ...(payloads.length > 0 ? { attachments: payloads } : {}),
        });
      },
      (error: unknown) => {
        setRetryingMessageUuid(null);
        toast.error("Couldn't resend this message", {
          description: `${apiErrorMessage(error, "An attachment could not be rebuilt")}. Reload the conversation and try again.`,
        });
      },
    );
  }, [available, block.messageUuid, content, retrying, sendPrompt, wsSessionId]);
  return useMemo(
    () => ({ available, retrying, send, visible }),
    [available, retrying, send, visible],
  );
}

/**
 * Resolve an inline payload, or pull it back out of the in-memory prompt cache
 * or the on-disk blob store. Throws rather than resolving `undefined` for a
 * payload it can't rebuild: re-sending the prompt with its screenshot quietly
 * missing is worse than not re-sending it.
 */
async function payloadBase64(
  source: { base64?: string; ref?: string; blobHash?: string },
  label: string,
): Promise<string> {
  if (source.base64 !== undefined) return source.base64;
  // A message old enough for the image off-load to have run keeps its bytes in
  // the blob store, not in the prompt cache. Without this a failed send could
  // never be retried once maintenance had swept the row.
  if (source.blobHash !== undefined) {
    try {
      const base64 = await readBlobBase64(await fetchBlob(source.blobHash));
      if (base64.length > 0) return base64;
    } catch (error) {
      throw new Error(`${label} could not be read from storage`, { cause: error });
    }
    throw new Error(`${label} could not be read from storage`);
  }
  const restored = source.ref ? await readPromptBlobBase64(source.ref) : undefined;
  if (restored === undefined) throw new Error(`${label} is no longer held in memory`);
  return restored;
}

async function buildRetryAttachments(content: ParsedMessage): Promise<PromptAttachmentPayload[]> {
  const images = content.images.map(async (image, index) => ({
    base64: await payloadBase64(image, `Image ${index + 1}`),
    fileName: "image",
    kind: "image" as const,
    mimeType: image.mediaType,
  }));
  const files = content.attachments.map(async (attachment) => ({
    base64: await payloadBase64(attachment, attachment.fileName),
    fileName: attachment.fileName,
    kind: attachment.kind,
    mimeType: attachment.mimeType,
  }));
  return await Promise.all([...images, ...files]);
}

function ActionButton({
  onClick,
  title,
  disabled = false,
  children,
}: {
  onClick: () => void;
  title: string;
  disabled?: boolean;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={title}
      disabled={disabled}
      className={cn(
        "flex items-center gap-1 rounded px-1.5 py-0.5 text-xs text-foreground/70",
        "transition-colors hover:bg-accent hover:text-foreground",
        "disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:bg-transparent disabled:hover:text-foreground/70",
      )}
    >
      {children}
    </button>
  );
}

export const UserMessageActions = memo(UserMessageActionsImpl);
