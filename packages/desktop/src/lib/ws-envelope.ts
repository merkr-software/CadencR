import type { PromptAttachmentPayload } from "@/types/agent-types";

/**
 * WebSocket envelope utilities for communicating with the Rust Axum WS endpoint.
 *
 * Mirrors the WsEnvelope struct in packages/service/src/domain/ws_session/protocol.rs.
 */

export interface WsEnvelope {
  id: string;
  domain: string;
  action: string;
  ref?: string;
  payload: unknown;
}

export interface SessionConfig {
  provider?: string;
  model?: string;
  thinkingEffort?: string;
  permissionMode?: string;
  systemPrompt?: string;
  cwd?: string;
  featureId?: number;
}

export type GateCloseReason = "sleep" | "escape";

export function createEnvelope(domain: string, action: string, payload: unknown): WsEnvelope {
  return {
    id: crypto.randomUUID(),
    domain,
    action,
    payload,
  };
}

export function parseEnvelope(raw: string): WsEnvelope {
  const parsed = JSON.parse(raw);
  if (!parsed.domain || !parsed.action) {
    throw new Error("Invalid envelope: missing domain or action");
  }
  return parsed as WsEnvelope;
}

export function createSessionInit(config: SessionConfig): WsEnvelope {
  return createEnvelope("session", "init", {
    provider: config.provider ?? null,
    model: config.model ?? null,
    thinking_effort: config.thinkingEffort ?? null,
    permission_mode: config.permissionMode ?? null,
    system_prompt: config.systemPrompt ?? null,
    cwd: config.cwd ?? null,
    feature_id: config.featureId ?? null,
  });
}

/**
 * First-prompt branch provisioning, resolved from the worktree-mode picker.
 * The backend acts on this *after* auto-naming the feature, so the new branch
 * (worktree or project-path) carries the prompt-derived name:
 *   - `worktree` → backend `ensure_worktree` (reads persisted feature settings).
 *   - `project_branch` → backend forks a project-path branch named after the
 *     feature ("From branch"); `base` of `null` forks from the current HEAD.
 */
export type FirstPromptBranchSetup =
  | { kind: "worktree" }
  | { kind: "project_branch"; base: string | null };

export interface PromptDispatchOptions {
  attachments?: PromptAttachmentPayload[];
  branchSetup?: FirstPromptBranchSetup;
  claudeProfile?: string;
  /**
   * Client-generated reference for this user message, echoed back by the
   * backend in `prompt_persisted` with the persisted DB id so the live block
   * can be stamped (enables rewind/fork without a reload). Independent of
   * `clientMessageId` (which is receipt/steering-only) — always sent.
   */
  userMessageRef?: string;
}

export interface PromptSendOptions extends PromptDispatchOptions {
  clientMessageId?: string;
  replay?: boolean;
}

export function createPromptSend(
  sessionId: string,
  text: string,
  options: PromptSendOptions = {},
): WsEnvelope {
  const { branchSetup } = options;
  return createEnvelope("session", "prompt.send", {
    session_id: sessionId,
    text,
    ...(options.attachments && options.attachments.length > 0
      ? { attachments: options.attachments }
      : {}),
    ...(branchSetup?.kind === "worktree" ? { use_worktree: true } : {}),
    ...(branchSetup?.kind === "project_branch"
      ? { new_project_branch: { base: branchSetup.base } }
      : {}),
    ...(options.clientMessageId ? { client_message_id: options.clientMessageId } : {}),
    ...(options.userMessageRef ? { user_message_ref: options.userMessageRef } : {}),
    ...(options.replay ? { replay: true } : {}),
    ...(options.claudeProfile ? { profile: options.claudeProfile } : {}),
  });
}

interface PermissionRespondOptions {
  updatedInput?: Record<string, unknown>;
  feedback?: string;
  optionId?: string;
}

export function createPermissionRespond(
  sessionId: string,
  requestId: string,
  decision: "allow_once" | "allow_future" | "deny",
  options: PermissionRespondOptions = {},
): WsEnvelope {
  return createEnvelope("session", "permission.respond", {
    session_id: sessionId,
    request_id: requestId,
    decision,
    ...(options.updatedInput ? { updated_input: options.updatedInput } : {}),
    ...(options.feedback ? { feedback: options.feedback } : {}),
    ...(options.optionId ? { option_id: options.optionId } : {}),
  });
}

export function createInterrupt(sessionId: string): WsEnvelope {
  return createEnvelope("session", "interrupt", { session_id: sessionId });
}

/**
 * Rewind the conversation **and** code back to the state before `messageId`,
 * in place. `confirmDiscard` acknowledges a dirty worktree (the backend asks
 * first and replies `branch.needs_confirm` until it is set). The chosen
 * message's text comes back as a draft — it is NOT re-sent.
 */
export function createRewind(
  sessionId: string,
  messageId: number,
  options: { confirmDiscard?: boolean } = {},
): WsEnvelope {
  return createEnvelope("session", "branch.rewind", {
    session_id: sessionId,
    message_id: messageId,
    confirm_discard: options.confirmDiscard ?? false,
  });
}

/**
 * Fork the conversation into a new session in the same worktree, keeping only
 * the context before `messageId` (no code rollback). The chosen message's text
 * becomes the new session's draft.
 */
export function createFork(sessionId: string, messageId: number): WsEnvelope {
  return createEnvelope("session", "branch.fork", {
    session_id: sessionId,
    message_id: messageId,
  });
}

/**
 * Suspend / resume envelopes — sent per active session when Electron's
 * `powerMonitor` fires. Provider-neutral: the backend handler interrupts the
 * live runtime and persists the runtime session id regardless of which
 * provider it belongs to. See `domain::ws_session::handler::session_control`.
 */
export function createSessionSuspend(sessionId: string): WsEnvelope {
  return createEnvelope("session", "suspend", { session_id: sessionId });
}

export function createSessionResume(sessionId: string): WsEnvelope {
  return createEnvelope("session", "resume", { session_id: sessionId });
}

export function createGateClose(
  sessionId: string,
  requestId: string | null,
  reason: GateCloseReason,
): WsEnvelope {
  return createEnvelope("session", "gate.close", {
    session_id: sessionId,
    request_id: requestId,
    reason,
  });
}

export function createModelSet(sessionId: string, model: string): WsEnvelope {
  return createEnvelope("session", "model.set", {
    session_id: sessionId,
    model,
  });
}

export function createProviderSet(sessionId: string, provider: string): WsEnvelope {
  return createEnvelope("session", "provider.set", {
    session_id: sessionId,
    provider,
  });
}

export function createModeSet(sessionId: string, mode: string): WsEnvelope {
  return createEnvelope("session", "mode.set", { session_id: sessionId, mode });
}

export function createCodexPermissionModeSet(sessionId: string, mode: string): WsEnvelope {
  return createEnvelope("session", "codex_permission_mode.set", {
    session_id: sessionId,
    mode,
  });
}

export function createEffortSet(sessionId: string, thinkingEffort?: string): WsEnvelope {
  return createEnvelope("session", "effort.set", {
    session_id: sessionId,
    thinking_effort: thinkingEffort ?? null,
  });
}

export function createProfileSet(sessionId: string, profile: string): WsEnvelope {
  return createEnvelope("session", "profile.set", {
    session_id: sessionId,
    profile,
  });
}

export function createDestroy(sessionId: string): WsEnvelope {
  return createEnvelope("session", "destroy", { session_id: sessionId });
}

export function createSessionClear(sessionId: string): WsEnvelope {
  return createEnvelope("session", "clear", { session_id: sessionId });
}

export function createSessionDelete(sessionId: string): WsEnvelope {
  return createEnvelope("session", "delete", { session_id: sessionId });
}

export function createSessionCompact(sessionId: string): WsEnvelope {
  return createEnvelope("session", "compact", { session_id: sessionId });
}

export function createCommandsGet(cwd: string, provider: string): WsEnvelope {
  return createEnvelope("commands", "get", { cwd, provider });
}

export interface CommandsListPayload {
  commands: Array<{
    name: string;
    description?: string;
    kind?: "command" | "skill";
  }>;
}

export function createHistoryGet(projectId: number): WsEnvelope {
  return createEnvelope("session", "history.get", { project_id: projectId });
}

export function createHistoryAdd(projectId: number, content: string): WsEnvelope {
  return createEnvelope("session", "history.add", {
    project_id: projectId,
    content,
  });
}
