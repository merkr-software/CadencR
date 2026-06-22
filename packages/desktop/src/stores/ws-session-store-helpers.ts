import type { SessionEntry } from "./ws-session-types";
import type { PromptDispatchOptions, WsEnvelope } from "@/lib/ws-envelope";
import { createModeSet, createPromptSend } from "@/lib/ws-envelope";
import type { QueuedPrompt } from "./ws-session-types";
import { blocksPatchWithDerived } from "./ws-block-mutations";
import type { LocalUserMessageOptions } from "./ws-pending-prompts";
import { movePendingPromptBlocksToTail } from "./ws-pending-prompts";
import type { AgentBlockData } from "@/components/AgentBlock";
export { buildSlashCommandsKey } from "@/lib/slash-command-key";

/**
 * Build an inline error block (rendered by `ErrorBlock`). Increments the
 * session's block counter to keep IDs unique. Caller is responsible for
 * appending the block to `session.blocks` and any additional patch (e.g.
 * lifecycle transitions, `removePendingPromptBlocks`, etc.).
 */
export function makeErrorBlock(
  session: SessionEntry,
  content: string,
  options: { code?: string; idPrefix?: string } = {},
): AgentBlockData {
  session.streamingState.counter += 1;
  return {
    id: `${options.idPrefix ?? "ws-err"}-${session.streamingState.counter}`,
    type: "error",
    content,
    ...(options.code ? { errorCode: options.code } : {}),
  };
}

export function appendLocalUserMessage(
  session: SessionEntry,
  content: string,
  options: LocalUserMessageOptions = {},
): Pick<SessionEntry, "blocks" | "rootBlocks" | "toolResultMap"> {
  session.streamingState.counter += 1;
  const block = {
    id: `ws-user-${session.streamingState.counter}`,
    type: "user_message" as const,
    content,
    isError: false,
    createdAt: new Date().toISOString(),
    ...(options.clientMessageId ? { clientMessageId: options.clientMessageId } : {}),
    ...(options.promptDeliveryState ? { promptDeliveryState: options.promptDeliveryState } : {}),
    ...(options.origin ? { origin: options.origin } : {}),
  };
  const nextBlocks = [...session.blocks, block];
  const blocks =
    options.promptDeliveryState === "pending_agent"
      ? movePendingPromptBlocksToTail(nextBlocks)
      : nextBlocks;
  return {
    ...blocksPatchWithDerived(session.streamingState, blocks),
  };
}

export function buildQueuedPromptPatch(
  session: SessionEntry,
  text: string,
  options: PromptDispatchOptions = {},
): Pick<SessionEntry, "queuedPrompts"> {
  const queuedPrompt: QueuedPrompt = { text };
  if (options.attachments && options.attachments.length > 0)
    queuedPrompt.attachments = options.attachments;
  if (options.branchSetup) queuedPrompt.branchSetup = options.branchSetup;
  if (options.claudeProfile) queuedPrompt.claudeProfile = options.claudeProfile;
  return {
    queuedPrompts: [...session.queuedPrompts, queuedPrompt],
  };
}

export function buildQueuedInitEnvelopes(session: SessionEntry): WsEnvelope[] {
  if (!session.serverSessionId) return [];

  const envelopes: WsEnvelope[] = [];
  // `session.init` already carries the FE-selected mode, so this `mode.set`
  // is only needed for the narrow window where the user toggled the chip
  // *after* `session.init` left the wire but *before* `session.initialized`
  // came back (during which `setPermissionMode` writes locally because
  // there is no `serverSessionId` yet). Sending the current local mode for
  // every value — not just `"plan"` — closes that race for `acceptEdits`,
  // `default`, `bypassPermissions`, and `auto` too. Idempotent on the
  // backend: `handle_mode_set`'s Pending branch just overwrites
  // `options.permission_mode` on the still-pending `SdkHandle`, and this
  // envelope is emitted before any queued `prompt.send` so the spawn picks
  // up the corrected mode.
  envelopes.push(createModeSet(session.serverSessionId, session.permissionMode));
  for (const prompt of session.queuedPrompts) {
    envelopes.push(
      createPromptSend(session.serverSessionId, prompt.text, {
        attachments: prompt.attachments,
        branchSetup: prompt.branchSetup,
        claudeProfile: prompt.claudeProfile,
      }),
    );
  }
  return envelopes;
}
