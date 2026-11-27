import { translateUi, useUiTranslation } from "@/lib/i18n/ui";
import {
  memo,
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type RefObject,
} from "react";
import { isAxiosError } from "axios";
import { CopyIcon, CheckIcon, RotateCcwIcon, GitBranchIcon, RefreshCwIcon } from "lucide-react";
import { toast } from "sonner";
import { apiErrorMessage } from "@/lib/api-errors";
import { fetchBlob } from "@/lib/blob-ref";
import { copyAs } from "@/lib/markdown-export";
import { readBlobBase64, readPromptBlobBase64 } from "@/lib/prompt-image-cache";
import { parseUserMessageContent, type PromptAttachmentPayload } from "@/types/agent-types";
import { cn } from "@/lib/utils";
import type { AgentBlockData } from "@/types/agent-block";
import { useMessageBranchActions, type MessageBranchActions } from "./use-message-branch-actions";
import { useWsSessionStore } from "@/stores/ws-session-store";
import { useAgentSessionContext } from "./agent-session-context";
import { CopyAsMenu } from "./CopyAsMenu";
import { MessageActionsMenu } from "./MessageActionsMenu";
import { AdaptiveMenuItem } from "@/components/PhoneSheetMenu";
import { useIsMobile } from "@/hooks/useIsMobile";
import { useLatestRef } from "@/hooks/useLatestRef";

interface UserMessageActionsProps {
  block: AgentBlockData;
  /** The rendered message bubble, serialized by "Copy as → Email". */
  bubbleRef: RefObject<HTMLDivElement | null>;
}

/**
 * On-hover action row shown under a user message: Copy (markdown), Fork, and
 * Rewind. Mirrors the agent text-block copy affordance. Rendered inside the
 * `group/usermsg` hover group owned by `UserMessageBlock`. The phone layout
 * gets one "…" (`MessageActionsMenu`) opening a sheet of the same actions.
 */
function UserMessageActionsImpl({ block, bubbleRef }: UserMessageActionsProps) {
  const { t } = useUiTranslation();
  const [copied, setCopied] = useState(false);
  const phone = useIsMobile();
  const branch = useMessageBranchActions(block);
  const { canBranch, rewind, fork } = branch;
  const { wsSessionId } = useAgentSessionContext();
  const sendPrompt = useWsSessionStore((s) => s.sendPrompt);
  const parsedContent = useMemo(() => parseUserMessageContent(block.content), [block.content]);
  const retry = useUserMessageRetry(block, wsSessionId, parsedContent, sendPrompt);
  const retryHelpId = useId();
  const needsAttachment = retry.visible && !retry.available;
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

  if (phone) {
    return (
      <PhoneUserMessageActions
        content={parsedContent.text}
        bubbleRef={bubbleRef}
        retry={retry}
        branch={branch}
      />
    );
  }

  return (
    <>
      {needsAttachment && (
        <UserMessageRetryHelp
          id={retryHelpId}
          deliveryUnknown={block.promptDeliveryState === "delivery_unknown"}
        />
      )}
      <div className="stream-hover-actions right-0 mt-1 flex items-center gap-1 opacity-0 transition-opacity group-hover/usermsg:opacity-100">
        <ActionButton
          onClick={handleCopy}
          title={t("conversation.stream.userMessageActions.copyAsMarkdown", "Copy as Markdown")}
        >
          {copied ? (
            <>
              <CheckIcon className="size-3 text-green-400" />
              <span className="text-green-400">
                {t("conversation.stream.userMessageActions.copied", "Copied")}
              </span>
            </>
          ) : (
            <>
              <CopyIcon className="size-3" />
              <span>{t("conversation.stream.userMessageActions.copy", "Copy")}</span>
            </>
          )}
        </ActionButton>
        <CopyAsMenu content={parsedContent.text} sourceRef={bubbleRef} />
        {retry.visible && (
          <UserMessageRetryButton
            retry={retry}
            descriptionId={needsAttachment ? retryHelpId : undefined}
          />
        )}
        {canBranch && (
          <>
            <ActionButton
              onClick={fork}
              title={t(
                "conversation.stream.userMessageActions.forkANewSessionFromThisMessage",
                "Fork a new session from this message",
              )}
            >
              <GitBranchIcon className="size-3" />
              <span>{t("conversation.stream.userMessageActions.fork", "Fork")}</span>
            </ActionButton>
            <ActionButton
              onClick={rewind}
              title={t(
                "conversation.stream.userMessageActions.rewindTheSessionToThisMessage",
                "Rewind the session to this message",
              )}
            >
              <RotateCcwIcon className="size-3" />
              <span>{t("conversation.stream.userMessageActions.rewind", "Rewind")}</span>
            </ActionButton>
          </>
        )}
      </div>
    </>
  );
}

/** Why Retry is unavailable: the message's attachment must be added again. */
function UserMessageRetryHelp({ id, deliveryUnknown }: { id: string; deliveryUnknown: boolean }) {
  const { t } = useUiTranslation();
  return (
    <p id={id} className="mt-1 text-xs text-muted-foreground">
      {deliveryUnknown
        ? t(
            "conversation.stream.userMessageActions.retryAfterReconnect",
            "Check the conversation after reconnecting. If delivery failed, reattach the file and resend it from the composer.",
          )
        : t(
            "conversation.stream.userMessageActions.reattachAndResend",
            "Reattach the file and resend the message from the composer.",
          )}
    </p>
  );
}

function UserMessageRetryButton({
  retry: { available, retrying, send },
  descriptionId,
}: {
  retry: ReturnType<typeof useUserMessageRetry>;
  descriptionId?: string;
}) {
  const { t } = useUiTranslation();
  const title = retrying
    ? t(
        "conversation.stream.userMessageActions.retryingDeliveryWithTheSameMessageIdentity",
        "Retrying delivery with the same message identity",
      )
    : available
      ? t(
          "conversation.stream.userMessageActions.retryDeliveryWithTheSameMessageIdentity",
          "Retry delivery with the same message identity",
        )
      : t("conversation.stream.userMessageActions.retryUnavailable", "Retry unavailable");
  return (
    <ActionButton
      disabled={!available || retrying}
      descriptionId={descriptionId}
      onClick={send}
      title={title}
    >
      <RefreshCwIcon className={cn("size-3", retrying && "animate-spin")} />
      <span>
        {retrying
          ? t("conversation.stream.userMessageActions.retrying", "Retrying")
          : t("common.retry", "Retry")}
      </span>
    </ActionButton>
  );
}

/** The phone layout's "…" and its sheet: the same handlers as the desktop row. */
function PhoneUserMessageActions({
  content,
  bubbleRef,
  retry,
  branch,
}: {
  content: string;
  bubbleRef: RefObject<HTMLDivElement | null>;
  retry: UserMessageRetry;
  branch: MessageBranchActions;
}) {
  const { t } = useUiTranslation();
  const contentRef = useLatestRef(content);
  return (
    <MessageActionsMenu contentRef={contentRef} sourceRef={bubbleRef} copyAsFormats side="end">
      {retry.visible && (
        <AdaptiveMenuItem disabled={!retry.available || retry.retrying} onSelect={retry.send}>
          <RefreshCwIcon className={cn(retry.retrying && "animate-spin")} />
          {retry.retrying
            ? t("conversation.stream.userMessageActions.retrying", "Retrying")
            : retry.available
              ? t("common.retry", "Retry")
              : t("conversation.stream.userMessageActions.retryUnavailable", "Retry unavailable")}
        </AdaptiveMenuItem>
      )}
      {branch.canBranch && (
        <>
          <AdaptiveMenuItem onSelect={branch.fork}>
            <GitBranchIcon />
            {t("conversation.stream.userMessageActions.fork", "Fork")}
          </AdaptiveMenuItem>
          <AdaptiveMenuItem onSelect={branch.rewind}>
            <RotateCcwIcon />
            {t("conversation.stream.userMessageActions.rewind", "Rewind")}
          </AdaptiveMenuItem>
        </>
      )}
    </MessageActionsMenu>
  );
}

type ParsedMessage = ReturnType<typeof parseUserMessageContent>;
type UserMessageRetry = ReturnType<typeof useUserMessageRetry>;
type SendPrompt = ReturnType<typeof useWsSessionStore.getState>["sendPrompt"];

class RetryAttachmentUnavailable extends Error {}

function useUserMessageRetry(
  block: AgentBlockData,
  wsSessionId: string | null,
  content: ParsedMessage,
  sendPrompt: SendPrompt,
) {
  const [retryingMessageUuid, setRetryingMessageUuid] = useState<string | null>(null);
  const [missingPayload, setMissingPayload] = useState<ParsedMessage | null>(null);
  const retryTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Images have a third source — the on-disk blob store the backend off-loads
  // them to — which file attachments don't, so the two lists check separately.
  const available =
    content !== missingPayload &&
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
        if (retryTimer.current) clearTimeout(retryTimer.current);
        setRetryingMessageUuid(null);
        if (error instanceof RetryAttachmentUnavailable) setMissingPayload(content);
        toast.error(
          translateUi(
            "conversation.stream.userMessageActions.couldnTResendThisMessage",
            "Couldn't resend this message",
          ),
          {
            description: apiErrorMessage(
              error,
              translateUi(
                "conversation.stream.userMessageActions.attachmentRebuild",
                "An attachment could not be rebuilt",
              ),
            ),
          },
        );
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
      if (isAxiosError(error) && error.response?.status === 404) {
        throw new RetryAttachmentUnavailable(
          translateUi(
            "conversation.stream.userMessageActions.noLongerInStorage",
            "{{label}} is no longer in storage",
            { label },
          ),
          { cause: error },
        );
      }
      throw new Error(
        translateUi(
          "conversation.stream.userMessageActions.couldNotBeReadFromStorage",
          "{{label}} could not be read from storage",
          { label },
        ),
        { cause: error },
      );
    }
    throw new RetryAttachmentUnavailable(
      translateUi(
        "conversation.stream.userMessageActions.hasNoSavedBytes",
        "{{label}} has no saved bytes",
        { label },
      ),
    );
  }
  const restored = source.ref ? await readPromptBlobBase64(source.ref) : undefined;
  if (restored === undefined)
    throw new RetryAttachmentUnavailable(
      translateUi(
        "conversation.stream.userMessageActions.isNoLongerHeldInMemory",
        "{{label}} is no longer held in memory",
        { label },
      ),
    );
  return restored;
}

async function buildRetryAttachments(content: ParsedMessage): Promise<PromptAttachmentPayload[]> {
  const images = content.images.map(async (image, index) => ({
    base64: await payloadBase64(
      image,
      translateUi("conversation.stream.userMessageActions.image", "Image {{position}}", {
        position: index + 1,
      }),
    ),
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
  descriptionId,
  disabled = false,
  children,
}: {
  onClick: () => void;
  title: string;
  descriptionId?: string;
  disabled?: boolean;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={title}
      aria-describedby={descriptionId}
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
