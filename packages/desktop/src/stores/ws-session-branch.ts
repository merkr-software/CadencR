import { toast } from "sonner";

import { getListFeaturesQueryKey } from "@/api/generated";
import { messageIdFromBlockId } from "@/components/AgentBlock";
import { queryClient } from "@/lib/queryClient";
import { createFork, createRewind, type WsEnvelope } from "@/lib/ws-envelope";

import { blocksPatchWithDerived } from "./ws-block-mutations";
import { isRecord } from "./ws-message-processing";
import { updateSession, type WsSessionStore } from "./ws-session-types";

/**
 * Rewind / Fork dispatch + reply handling. The originating client drives the
 * full UX through a request-response (`sendRequest`); other devices react to
 * the ref-less broadcast in `ws-envelope-handler`. No optimistic updates — the
 * store mutates only on the backend's confirmation.
 */
export interface BranchDeps {
  get: () => WsSessionStore;
  set: (partial: Partial<WsSessionStore>) => void;
  sendRequest: (sessionId: string, envelope: WsEnvelope) => Promise<unknown>;
}

let prefillNonce = 0;
let forkNonce = 0;

function isBranchError(reply: Record<string, unknown>): boolean {
  return typeof reply.code === "string" && typeof reply.message === "string";
}

function isNeedsConfirm(reply: Record<string, unknown>): boolean {
  return reply.kind === "rewind" && typeof reply.reason === "string";
}

export async function rewindToMessage(
  deps: BranchDeps,
  sessionId: string,
  messageId: number,
  confirmDiscard = false,
): Promise<void> {
  const session = deps.get().sessions[sessionId];
  if (!session) return;
  const toastId = `branch-${sessionId}`;
  toast.loading("Rewinding…", { id: toastId });

  const reply = await deps.sendRequest(
    sessionId,
    createRewind(session.serverSessionId, messageId, { confirmDiscard }),
  );
  if (!isRecord(reply)) {
    toast.error("Rewind failed or timed out.", { id: toastId });
    return;
  }
  if (isBranchError(reply)) {
    toast.error(String(reply.message), { id: toastId });
    return;
  }
  if (isNeedsConfirm(reply)) {
    toast.dismiss(toastId);
    deps.set({
      branchConfirm: { sessionId, messageId, kind: "rewind", reason: String(reply.reason) },
    });
    return;
  }

  truncateBlocksAtMessage(deps.get, deps.set, sessionId, messageId);
  deps.set({
    composerPrefill: {
      sessionId,
      text: typeof reply.draftText === "string" ? reply.draftText : "",
      nonce: ++prefillNonce,
    },
  });
  // A checkpoint that existed but failed to restore is distinct from one that
  // never existed — surface the failure rather than the benign "no checkpoint".
  const codeRestoreError =
    typeof reply.codeRestoreError === "string" && reply.codeRestoreError.length > 0
      ? reply.codeRestoreError
      : null;
  if (codeRestoreError) {
    toast.warning("Rewound, but restoring the code failed.", {
      id: toastId,
      description: codeRestoreError,
    });
  } else {
    toast.success("Rewound — edit and re-send.", {
      id: toastId,
      description:
        reply.codeRestored === true
          ? "Code and conversation rewound."
          : "Conversation rewound (no code checkpoint for this message).",
    });
  }
}

export async function forkFromMessage(
  deps: BranchDeps,
  sessionId: string,
  messageId: number,
): Promise<void> {
  const session = deps.get().sessions[sessionId];
  if (!session) return;
  const toastId = `branch-${sessionId}`;
  toast.loading("Forking…", { id: toastId });

  const reply = await deps.sendRequest(sessionId, createFork(session.serverSessionId, messageId));
  if (!isRecord(reply)) {
    toast.error("Fork failed or timed out.", { id: toastId });
    return;
  }
  if (isBranchError(reply)) {
    toast.error(String(reply.message), { id: toastId });
    return;
  }

  const newFeatureId = typeof reply.newFeatureId === "number" ? reply.newFeatureId : null;
  const projectId = typeof reply.projectId === "number" ? reply.projectId : null;
  if (newFeatureId == null || projectId == null) {
    toast.error("Fork did not return a new feature.", { id: toastId });
    return;
  }

  // Surface the new feature in every sidebar, then navigate this client to it.
  // (Other devices learn about it via the `feature.created` broadcast.)
  void queryClient.invalidateQueries({
    queryKey: getListFeaturesQueryKey({ project_id: projectId }),
  });
  deps.set({
    forkNavigation: { sessionId, projectId, featureId: newFeatureId, nonce: ++forkNonce },
  });

  toast.success("Forked into a new session.", {
    id: toastId,
    description: "Opening the fork — your message is waiting as a draft.",
  });
}

export function resolveBranchConfirm(deps: BranchDeps, confirmed: boolean): void {
  const pending = deps.get().branchConfirm;
  deps.set({ branchConfirm: null });
  if (!pending || !confirmed) return;
  if (pending.kind === "rewind") {
    void rewindToMessage(deps, pending.sessionId, pending.messageId, true);
  }
}

/**
 * Drop the cut message block and everything after it, recomputing the derived
 * `rootBlocks` / `toolResultMap`. Shared by the originating client and the
 * other-device broadcast handler.
 *
 * We locate the cut block by its DB id — stamped as `messageDbId` on a live
 * `ws-user-*` block, or encoded in `msg-<id>` after a reload — and keep every
 * block *before* it. Index slicing (not an `id < messageId` filter) is
 * essential: in a session chatted in live, earlier turns are still id-less
 * live/streaming blocks, and a numeric filter would drop them all, wiping
 * preceding turns from the view even though the backend preserves them.
 */
export function truncateBlocksAtMessage(
  get: () => WsSessionStore,
  set: (partial: Partial<WsSessionStore>) => void,
  sessionId: string,
  messageId: number,
): void {
  const session = get().sessions[sessionId];
  if (!session) return;
  const cutIndex = session.blocks.findIndex(
    (block) => (block.messageDbId ?? messageIdFromBlockId(block.id)) === messageId,
  );
  if (cutIndex === -1) return; // cut block not in this view; a reload reconciles it
  const keep = session.blocks.slice(0, cutIndex);
  if (keep.length === session.blocks.length) return;
  set(updateSession(get(), sessionId, blocksPatchWithDerived(session.streamingState, keep)));
}
