import type { SessionEntry } from "./ws-session-types";
import type { PromptDispatchOptions, WsEnvelope } from "@/lib/ws-envelope";
import { createModeSet, createPromptSend } from "@/lib/ws-envelope";
import type { QueuedPrompt } from "./ws-session-types";
import { blocksPatchWithDerived } from "./ws-block-mutations";
import type { AgentBlockData } from "@/components/AgentBlock";
import { getProviderModes } from "@/lib/provider-modes";
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
  // Installed ACP providers intentionally expose no host-owned permission
  // modes: permissions are negotiated by the ACP runtime, not declared by a
  // package descriptor. Avoid replaying the built-in frontend fallback
  // (`acceptEdits`) to such providers after initialization. An empty provider
  // is kept for older `session.initialized` payloads, where preserving the
  // existing replay behavior is safer than dropping a legitimate selection.
  if (!session.runtimeProvider || getProviderModes(session.runtimeProvider).length > 0) {
    envelopes.push(createModeSet(session.serverSessionId, session.permissionMode));
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
