import type { SessionEntry } from "./ws-session-types";
import type { PromptDispatchOptions, WsEnvelope } from "@/lib/ws-envelope";
import { createAccessModeSet, createModeSet, createPromptSend } from "@/lib/ws-envelope";
import type { QueuedPrompt } from "./ws-session-types";
import { blocksPatchWithDerived } from "./ws-block-mutations";
import type { AgentBlockData } from "@/types/agent-block";
import { canReplayPermissionMode } from "@/lib/provider-modes";
import { providerAccessModeConfig } from "@/lib/provider-access-modes";
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

/**
 * Build the blocks patch that appends an inline error block to a session — the
 * `makeErrorBlock` → `blocksPatchWithDerived([...blocks, block])` dance shared by
 * every "surface this failure in the transcript" path.
 */
export function appendErrorBlockPatch(
  session: SessionEntry,
  content: string,
  options: { code?: string; idPrefix?: string } = {},
): Pick<SessionEntry, "blocks" | "rootBlocks" | "toolResultMap"> {
  const errorBlock = makeErrorBlock(session, content, options);
  return blocksPatchWithDerived(session.streamingState, [...session.blocks, errorBlock]);
}

export function buildQueuedPromptPatch(
  session: SessionEntry,
  text: string,
  options: PromptDispatchOptions = {},
): Pick<SessionEntry, "queuedPrompts"> {
  const queuedPrompt: QueuedPrompt = {
    text,
    messageUuid: options.messageUuid ?? crypto.randomUUID(),
  };
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
  // Replay an explicit choice the init reply has not acknowledged before any
  // queued `prompt.send` so the spawn picks it up. The current mode is never
  // replayed: on a reconnect it is the confirmed value from before the
  // outage, and a setting changed meanwhile waits in the outbound queue —
  // replaying the old mode after it would silently undo the user's choice.
  // A choice the provider can't run was replaced by the backend's report in
  // `handleInitialized`; it is dropped. Providers without a built-in mode
  // table get only the modes their catalog declares.
  const providerId = session.currentSelection?.providerId;
  const pendingMode = session.pendingInitPermissionMode;
  if (
    pendingMode !== null &&
    pendingMode === session.permissionMode &&
    (!providerId || canReplayPermissionMode(providerId, pendingMode))
  ) {
    envelopes.push(createModeSet(session.serverSessionId, pendingMode));
  }
  // Initialization reports the persisted mode, which can predate a chip change.
  // Replay the explicit pre-init choice before the first prompt starts Codex.
  if (session.pendingInitAccessMode && (!providerId || providerAccessModeConfig(providerId))) {
    envelopes.push(createAccessModeSet(session.serverSessionId, session.pendingInitAccessMode));
  }
  for (const prompt of session.queuedPrompts) {
    envelopes.push(
      createPromptSend(session.serverSessionId, prompt.text, {
        attachments: prompt.attachments,
        branchSetup: prompt.branchSetup,
        claudeProfile: prompt.claudeProfile,
        messageUuid: prompt.messageUuid,
      }),
    );
  }
  return envelopes;
}
