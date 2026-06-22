import type { CommandsListPayload } from "@/lib/ws-envelope";
import type { AgentMessageOrigin } from "@/api/generated";
import type { McpServerStatus } from "./ws-session-types";

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : null;
}

function optionalString(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  return typeof value === "string" ? value : undefined;
}

function optionalNumber(record: Record<string, unknown>, key: string): number | undefined {
  const value = record[key];
  return typeof value === "number" ? value : undefined;
}

function optionalBoolean(record: Record<string, unknown>, key: string): boolean | undefined {
  const value = record[key];
  return typeof value === "boolean" ? value : undefined;
}

function optionalArray(record: Record<string, unknown>, key: string): unknown[] | undefined {
  const value = record[key];
  return Array.isArray(value) ? value : undefined;
}

interface ParsedPermissionOption {
  decision: "allow_once" | "allow_future" | "deny";
  optionId?: string;
  label: string;
  description: string;
  collectFeedback?: boolean;
}

export function parseCommandsListPayload(payload: unknown): CommandsListPayload | null {
  const record = asRecord(payload);
  if (!record) return null;
  const commands = optionalArray(record, "commands");
  if (!commands) return { commands: [] };
  const parsed = commands
    .map(
      (
        entry,
      ): {
        name: string;
        description?: string;
        kind: "command" | "skill";
      } | null => {
        const item = asRecord(entry);
        if (!item) return null;
        const name = optionalString(item, "name");
        if (!name) return null;
        const description = optionalString(item, "description");
        const kind = optionalCommandKind(item, "kind");
        return {
          name,
          ...(description ? { description } : {}),
          kind: kind ?? "command",
        };
      },
    )
    .filter(
      (
        entry,
      ): entry is {
        name: string;
        description?: string;
        kind: "command" | "skill";
      } => entry !== null,
    );
  return {
    commands: parsed,
  };
}

function optionalCommandKind(
  record: Record<string, unknown>,
  key: string,
): "command" | "skill" | undefined {
  const value = record[key];
  return value === "command" || value === "skill" ? value : undefined;
}

export function parseRuntimeSessionIdPayload(
  payload: unknown,
): { runtime_session_id?: string } | null {
  const record = asRecord(payload);
  if (!record) return null;
  return { runtime_session_id: optionalString(record, "runtime_session_id") };
}

export function parseMcpServersPayload(payload: unknown): { mcpServers: McpServerStatus[] } | null {
  const record = asRecord(payload);
  if (!record) return null;
  const servers = optionalArray(record, "mcp_servers");
  if (!servers) return null;
  return {
    mcpServers: servers
      .map((entry): McpServerStatus | null => {
        const item = asRecord(entry);
        if (!item) return null;
        const name = optionalString(item, "name");
        const status = optionalString(item, "status");
        if (!name || !status) return null;
        return { name, status };
      })
      .filter((entry): entry is McpServerStatus => entry !== null),
  };
}

export function parseInitializedPayload(payload: unknown): {
  session_id?: string;
  sessionDbId?: number;
  provider?: string;
  model?: string;
  thinking_effort?: string;
  codex_permission_mode?: string;
  input_tokens?: number;
  output_tokens?: number;
  context_window?: number;
  supports_prompt_receipts?: boolean;
} | null {
  const record = asRecord(payload);
  if (!record) return null;
  const explicitSessionDbId = optionalNumber(record, "session_db_id");
  const sessionId = optionalString(record, "session_id");
  return {
    session_id: sessionId,
    sessionDbId: explicitSessionDbId ?? sessionDbIdFromSessionId(sessionId),
    provider: optionalString(record, "provider"),
    model: optionalString(record, "model"),
    thinking_effort: optionalString(record, "thinking_effort"),
    codex_permission_mode: optionalString(record, "codex_permission_mode"),
    input_tokens: optionalNumber(record, "input_tokens"),
    output_tokens: optionalNumber(record, "output_tokens"),
    context_window: optionalNumber(record, "context_window"),
    supports_prompt_receipts: optionalBoolean(record, "supports_prompt_receipts"),
  };
}

function sessionDbIdFromSessionId(value: string | undefined): number | undefined {
  if (!value || !/^\d+$/.test(value)) return undefined;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : undefined;
}

export function parseModelPayload(payload: unknown): {
  model?: string;
  context_window?: number;
} | null {
  const record = asRecord(payload);
  if (!record) return null;
  const contextWindow = optionalNumber(record, "context_window");
  return {
    model: optionalString(record, "model"),
    context_window: contextWindow && contextWindow > 0 ? contextWindow : undefined,
  };
}

export function parseProviderPayload(payload: unknown): {
  provider?: string;
  supports_prompt_receipts?: boolean;
  codex_permission_mode?: string;
} | null {
  const record = asRecord(payload);
  if (!record) return null;
  return {
    provider: optionalString(record, "provider"),
    supports_prompt_receipts: optionalBoolean(record, "supports_prompt_receipts"),
    codex_permission_mode: optionalString(record, "codex_permission_mode"),
  };
}

export function parseModePayload(payload: unknown): { mode?: string } | null {
  const record = asRecord(payload);
  if (!record) return null;
  return { mode: optionalString(record, "mode") };
}

export function parseEffortPayload(payload: unknown): { thinking_effort?: string } | null {
  const record = asRecord(payload);
  if (!record) return null;
  return { thinking_effort: optionalString(record, "thinking_effort") };
}

export function parseFeatureUpdatedPayload(
  payload: unknown,
): { feature_id?: number; changed: string[] } | null {
  const record = asRecord(payload);
  if (!record) return null;
  const changed = (optionalArray(record, "changed") ?? []).filter(
    (entry): entry is string => typeof entry === "string",
  );
  return {
    feature_id: optionalNumber(record, "feature_id"),
    changed,
  };
}

export function parseCompactingPayload(payload: unknown): { active: boolean } | null {
  const record = asRecord(payload);
  if (!record) return null;
  const active = optionalBoolean(record, "active");
  return active == null ? null : { active };
}

export function parseMessageBlocksPayload(payload: unknown): { blocks: unknown[] } | null {
  const record = asRecord(payload);
  if (!record) return null;
  return { blocks: optionalArray(record, "blocks") ?? [] };
}

export function parsePermissionPayload(payload: unknown): {
  request_id?: string;
  tool_name?: string;
  tool_input: Record<string, unknown>;
  description?: string;
  pattern?: string;
  preview?: string;
  options: ParsedPermissionOption[];
} | null {
  const record = asRecord(payload);
  if (!record) return null;
  const toolInputRecord = asRecord(record.tool_input) ?? {};
  const options = (optionalArray(record, "options") ?? [])
    .map((entry): ParsedPermissionOption | null => {
      const item = asRecord(entry);
      if (!item) return null;
      const decision = optionalString(item, "decision");
      const label = optionalString(item, "label");
      const description = optionalString(item, "description");
      const collectFeedback = item.collect_feedback;
      if (!decision || !label || !description) return null;
      if (decision !== "allow_once" && decision !== "allow_future" && decision !== "deny") {
        return null;
      }
      return {
        decision,
        optionId: optionalString(item, "option_id"),
        label,
        description,
        collectFeedback: typeof collectFeedback === "boolean" ? collectFeedback : undefined,
      };
    })
    .filter((entry): entry is ParsedPermissionOption => entry !== null);
  return {
    request_id: optionalString(record, "request_id"),
    tool_name: optionalString(record, "tool_name"),
    tool_input: toolInputRecord,
    description: optionalString(record, "description"),
    pattern: optionalString(record, "pattern"),
    preview: optionalString(record, "preview"),
    options,
  };
}

export function parseErrorPayload(
  payload: unknown,
): { code?: string; message?: string; mode?: string } | null {
  const record = asRecord(payload);
  if (!record) return null;
  return {
    code: optionalString(record, "code"),
    message: optionalString(record, "message") ?? optionalString(record, "error"),
    // Optional context attached to permission-mode rejections so the FE
    // can skip the rejected mode in the Shift+Tab cycle.
    mode: optionalString(record, "mode"),
  };
}

export function parseEndedPayload(payload: unknown): { reason?: string } | null {
  const record = asRecord(payload);
  if (!record) return null;
  return { reason: optionalString(record, "reason") };
}

/**
 * Parse the `session.stream_status` envelope. Backend emits exactly one
 * of `"degraded"` or `"recovered"` for `state`; we narrow defensively
 * (anything else is ignored). Hard failures arrive on `session.error`,
 * not here.
 */
export function parseStreamStatusPayload(
  payload: unknown,
): { state: "degraded" | "recovered"; reason?: string } | null {
  const record = asRecord(payload);
  if (!record) return null;
  const state = optionalString(record, "state");
  if (state !== "degraded" && state !== "recovered") return null;
  return { state, reason: optionalString(record, "reason") };
}

export function parsePromptReceivedPayload(
  payload: unknown,
): { client_message_id?: string } | null {
  const record = asRecord(payload);
  if (!record) return null;
  return { client_message_id: optionalString(record, "client_message_id") };
}

/**
 * Parse the `session.user_message` envelope — a prompt another device just sent,
 * mirrored here so this (passive) viewer's conversation stays live.
 */
export function parseUserMessageMirrorPayload(
  payload: unknown,
): { text: string; origin?: AgentMessageOrigin } | null {
  const record = asRecord(payload);
  if (!record) return null;
  const text = optionalString(record, "text");
  if (typeof text !== "string") return null;
  const origin = parseMessageOrigin(record.origin);
  return origin ? { text, origin } : { text };
}

function parseMessageOrigin(value: unknown): AgentMessageOrigin | undefined {
  const record = asRecord(value);
  if (!record) return undefined;
  const originKind = optionalString(record, "originKind");
  if (!originKind) return undefined;
  return {
    originKind,
    sourceSessionId: optionalNumber(record, "sourceSessionId"),
    sourceFeatureId: optionalNumber(record, "sourceFeatureId"),
    sourceProjectId: optionalNumber(record, "sourceProjectId"),
    sourceMessageId: optionalNumber(record, "sourceMessageId"),
    note: optionalString(record, "note"),
    createdAt: optionalString(record, "createdAt"),
  };
}

/**
 * Parse the `session.lifecycle` envelope. Carries OS-power-driven
 * transitions (suspend / resume). Anything other than the two known kinds
 * is ignored — we'd rather drop than crash if the backend adds a new kind
 * we don't yet handle in the renderer.
 */
export function parseLifecyclePayload(
  payload: unknown,
): { kind: "suspend_requested" | "resumed" } | null {
  const record = asRecord(payload);
  if (!record) return null;
  const kind = optionalString(record, "kind");
  if (kind !== "suspend_requested" && kind !== "resumed") return null;
  return { kind };
}

export function parseGateClosedPayload(payload: unknown): {
  session_id?: string;
  request_id?: string;
  reason: "sleep" | "escape";
} | null {
  const record = asRecord(payload);
  if (!record) return null;
  const reason = optionalString(record, "reason");
  if (reason !== "sleep" && reason !== "escape") return null;
  return {
    session_id: optionalString(record, "session_id"),
    request_id: optionalString(record, "request_id"),
    reason,
  };
}

export function parseUsagePayload(payload: unknown): {
  input_tokens: number;
  output_tokens: number;
  context_window?: number;
} | null {
  const record = asRecord(payload);
  if (!record) return null;
  const contextWindow = optionalNumber(record, "context_window");
  return {
    input_tokens: optionalNumber(record, "input_tokens") ?? 0,
    output_tokens: optionalNumber(record, "output_tokens") ?? 0,
    context_window: contextWindow && contextWindow > 0 ? contextWindow : undefined,
  };
}

export function parseFeatureRenamePayload(
  payload: unknown,
): { feature_id?: number; title?: string } | null {
  const record = asRecord(payload);
  if (!record) return null;
  return {
    feature_id: optionalNumber(record, "feature_id"),
    title: optionalString(record, "title"),
  };
}

export function parseFeatureAutoNamingPayload(
  payload: unknown,
): { feature_id?: number; in_progress: boolean } | null {
  const record = asRecord(payload);
  if (!record) return null;
  return {
    feature_id: optionalNumber(record, "feature_id"),
    in_progress: record.in_progress === true,
  };
}

export function parseClearedPayload(payload: unknown): { previous_session_id?: string } | null {
  const record = asRecord(payload);
  if (!record) return null;
  return { previous_session_id: optionalString(record, "previous_session_id") };
}
