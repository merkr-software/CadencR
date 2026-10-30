import { decodeEnvelope, createSessionEnvelope, type WsEnvelope } from "./ws-envelope-contract";
export { createSessionEnvelope, type WsEnvelope } from "./ws-envelope-contract";
import type {
  CommandsGetPayload,
  GateCloseReason,
  PermissionRespondPayload,
  RuntimeConfigOverrides,
} from "@/api/generated";
export type { GateCloseReason } from "@/api/generated";
import { recordDiagnosticEvent } from "./renderer-diagnostics";
import type { PromptAttachmentPayload } from "@/types/agent-types";
import type { SlashCommandKind } from "@/lib/slash-command";
import type { PromptCommandPolicyPayload } from "@/lib/prompt-command-policy";
import { normalizeMessageUuid } from "@/lib/message-uuid";

export interface SessionConfig {
  provider?: string;
  model?: string;
  thinkingEffort?: string;
  permissionMode?: string;
  systemPrompt?: string;
  cwd?: string;
  featureId?: number;
}

type ExtensionDomain = "app" | "commands" | "plugin";

export function createEnvelope(
  domain: ExtensionDomain,
  action: string,
  payload: unknown,
): WsEnvelope {
  return {
    id: crypto.randomUUID(),
    domain,
    action,
    payload,
  };
}

export function parseEnvelope(raw: string): WsEnvelope {
  const parsed: unknown = JSON.parse(raw);
  const envelope = decodeEnvelope(parsed);
  recordDiagnosticEvent("stream", {
    domain: /^[a-z_]{1,40}$/.test(envelope.domain) ? envelope.domain : "other",
    action: /^[a-z_.]{1,80}$/.test(envelope.action) ? envelope.action : "other",
  });
  return envelope;
}

export function createSessionInit(config: SessionConfig): WsEnvelope {
  return createSessionEnvelope("init", {
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
  /** Stable Cadencr identity generated before dispatch and preserved on retries. */
  messageUuid?: string;
}

export interface PromptSendOptions extends PromptDispatchOptions {
  trackPromptReceipt?: boolean;
}

export function createPromptSend(
  sessionId: string,
  text: string,
  options: PromptSendOptions = {},
): WsEnvelope {
  const { branchSetup } = options;
  const messageUuid = options.messageUuid
    ? normalizeMessageUuid(options.messageUuid)
    : crypto.randomUUID();
  return createSessionEnvelope("prompt.send", {
    session_id: sessionId,
    text,
    ...(options.attachments && options.attachments.length > 0
      ? { attachments: options.attachments }
      : {}),
    ...(branchSetup?.kind === "worktree" ? { use_worktree: true } : {}),
    ...(branchSetup?.kind === "project_branch"
      ? { new_project_branch: { base: branchSetup.base } }
      : {}),
    message_uuid: messageUuid,
    ...(options.trackPromptReceipt ? { track_prompt_receipt: true } : {}),
    ...(options.claudeProfile ? { profile: options.claudeProfile } : {}),
  });
}

interface PermissionRespondOptions {
  updatedInput?: Record<string, unknown>;
  feedback?: string;
  optionId?: string;
  messageUuid?: string;
}

export function createPermissionRespond(
  sessionId: string,
  requestId: string,
  decision: PermissionRespondPayload["decision"],
  options: PermissionRespondOptions = {},
): WsEnvelope {
  return createSessionEnvelope("permission.respond", {
    session_id: sessionId,
    request_id: requestId,
    ...(options.messageUuid ? { message_uuid: options.messageUuid } : {}),
    decision,
    ...(options.updatedInput ? { updated_input: options.updatedInput } : {}),
    ...(options.feedback ? { feedback: options.feedback } : {}),
    ...(options.optionId ? { option_id: options.optionId } : {}),
  });
}

export function createInterrupt(sessionId: string): WsEnvelope {
  return createSessionEnvelope("interrupt", { session_id: sessionId });
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
  return createSessionEnvelope("branch.rewind", {
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
  return createSessionEnvelope("branch.fork", {
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
  return createSessionEnvelope("suspend", { session_id: sessionId });
}

export function createSessionResume(sessionId: string): WsEnvelope {
  return createSessionEnvelope("resume", { session_id: sessionId });
}

export function createGateClose(
  sessionId: string,
  requestId: string | null,
  reason: GateCloseReason,
): WsEnvelope {
  return createSessionEnvelope("gate.close", {
    session_id: sessionId,
    request_id: requestId,
    reason,
  });
}

export function createModelSet(sessionId: string, model: string, provider: string): WsEnvelope {
  return createSessionEnvelope("model.set", {
    session_id: sessionId,
    model,
    provider,
  });
}

export function createProviderSet(sessionId: string, provider: string, model?: string): WsEnvelope {
  return createSessionEnvelope("provider.set", {
    session_id: sessionId,
    provider,
    ...(model !== undefined ? { model } : {}),
  });
}

export function createModeSet(sessionId: string, mode: string): WsEnvelope {
  return createSessionEnvelope("mode.set", { session_id: sessionId, mode });
}

export function createAccessModeSet(sessionId: string, mode: string): WsEnvelope {
  return createSessionEnvelope("access_mode.set", {
    session_id: sessionId,
    mode,
  });
}

export function createEffortSet(sessionId: string, thinkingEffort?: string): WsEnvelope {
  return createSessionEnvelope("effort.set", {
    session_id: sessionId,
    thinking_effort: thinkingEffort ?? null,
  });
}

export function createFastModeSet(sessionId: string, enabled: boolean): WsEnvelope {
  return createSessionEnvelope("fast_mode.set", {
    session_id: sessionId,
    enabled,
  });
}

export function createProfileSet(sessionId: string, profile: string): WsEnvelope {
  return createSessionEnvelope("profile.set", {
    session_id: sessionId,
    profile,
  });
}
export type RuntimeConfigOverridePatch = RuntimeConfigOverrides;
export function createRuntimeOverridesSet(
  sessionId: string,
  runtimeOverrides: RuntimeConfigOverridePatch,
): WsEnvelope {
  return createSessionEnvelope("runtime_overrides.set", {
    session_id: sessionId,
    runtime_overrides: runtimeOverrides,
  });
}

export function createSessionConfigGet(sessionId: string): WsEnvelope {
  return createSessionEnvelope("config.get", { session_id: sessionId });
}

export function createSessionConfigSet(
  sessionId: string,
  configId: string,
  value: string | boolean,
): WsEnvelope {
  return createSessionEnvelope("config.set", {
    session_id: sessionId,
    config_id: configId,
    value,
  });
}

export function createDestroy(sessionId: string): WsEnvelope {
  return createSessionEnvelope("destroy", { session_id: sessionId });
}

export function createSessionClear(sessionId: string): WsEnvelope {
  return createSessionEnvelope("clear", { session_id: sessionId });
}

export function createSessionDelete(sessionId: string): WsEnvelope {
  return createSessionEnvelope("delete", { session_id: sessionId });
}

export function createSessionCompact(sessionId: string): WsEnvelope {
  return createSessionEnvelope("compact", {
    session_id: sessionId,
    message_uuid: crypto.randomUUID(),
  });
}

export function createCommandsGet(cwd: string, provider: string, profile?: string): WsEnvelope {
  return createEnvelope("commands", "get", {
    cwd,
    provider,
    ...(profile ? { profile } : {}),
  } satisfies CommandsGetPayload);
}

export interface CommandsListPayload {
  commands: Array<{
    name: string;
    description?: string;
    kind?: SlashCommandKind;
  }>;
  prompt_command_policy?: PromptCommandPolicyPayload;
}

export function createHistoryGet(projectId: number): WsEnvelope {
  return createSessionEnvelope("history.get", { project_id: projectId });
}

export function createHistoryAdd(projectId: number, content: string): WsEnvelope {
  return createSessionEnvelope("history.add", {
    project_id: projectId,
    content,
  });
}
