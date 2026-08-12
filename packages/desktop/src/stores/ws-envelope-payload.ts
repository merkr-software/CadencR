import type { CommandsListPayload } from "@/lib/ws-envelope";
import type { McpServerStatus } from "./ws-session-types";
import type {
  RuntimeSessionConfigChoices,
  RuntimeSessionConfigOption,
  RuntimeSessionConfigSelectOption,
  SessionConfigSnapshotPayload,
} from "@/api/generated";

import {
  asRecord,
  optionalArray,
  optionalBoolean,
  optionalNumber,
  optionalString,
} from "./ws-envelope-payload-primitives";

export function parseCommandsListPayload(payload: unknown): CommandsListPayload | null {
  const record = asRecord(payload);
  if (!record) return null;
  const commands = optionalArray(record, "commands");
  const promptCommandPolicy = parsePromptCommandPolicy(record.prompt_command_policy);
  if (!commands) {
    return {
      commands: [],
      ...(promptCommandPolicy ? { prompt_command_policy: promptCommandPolicy } : {}),
    };
  }
  const parsed = commands
    .map(
      (
        entry,
      ): {
        name: string;
        description?: string;
        kind: "command" | "skill" | "cadencr";
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
        kind: "command" | "skill" | "cadencr";
      } => entry !== null,
    );
  return {
    commands: parsed,
    ...(promptCommandPolicy ? { prompt_command_policy: promptCommandPolicy } : {}),
  };
}

function parsePromptCommandPolicy(
  value: unknown,
): CommandsListPayload["prompt_command_policy"] | undefined {
  const policy = asRecord(value);
  if (!policy) return undefined;
  const placement = optionalString(policy, "slash_command_placement");
  const skillTrigger = optionalString(policy, "skill_reference_trigger");
  if (
    (placement !== "prompt_start" && placement !== "anywhere") ||
    (skillTrigger !== "slash" && skillTrigger !== "dollar")
  ) {
    return undefined;
  }
  return {
    slash_command_placement: placement,
    skill_reference_trigger: skillTrigger,
    user_shell: optionalBoolean(policy, "user_shell") ?? false,
  };
}

function optionalCommandKind(
  record: Record<string, unknown>,
  key: string,
): "command" | "skill" | "cadencr" | undefined {
  const value = record[key];
  return value === "command" || value === "skill" || value === "cadencr" ? value : undefined;
}

export function parseRuntimeSessionIdPayload(
  payload: unknown,
): { runtime_session_id?: string } | null {
  const record = asRecord(payload);
  if (!record) return null;
  return { runtime_session_id: optionalString(record, "runtime_session_id") };
}

export function parseSessionConfigSnapshotPayload(
  payload: unknown,
): SessionConfigSnapshotPayload | null {
  const record = asRecord(payload);
  const config = record ? asRecord(record.config) : null;
  const rawOptions = config ? optionalArray(config, "options") : undefined;
  const sessionId = record ? optionalString(record, "session_id") : undefined;
  if (!sessionId || !rawOptions) return null;
  const options = rawOptions.map(parseSessionConfigOption);
  if (options.some((option) => option === null)) return null;
  return {
    session_id: sessionId,
    config: { options: options as RuntimeSessionConfigOption[] },
  };
}

function parseSessionConfigOption(value: unknown): RuntimeSessionConfigOption | null {
  const record = asRecord(value);
  if (!record) return null;
  const id = optionalString(record, "id");
  const name = optionalString(record, "name");
  const type = optionalString(record, "type");
  if (!id || !name) return null;
  const common = {
    id,
    name,
    description: optionalString(record, "description"),
    category: optionalString(record, "category"),
    ...(record._meta !== undefined ? { _meta: record._meta } : {}),
  };
  if (type === "boolean") {
    const currentValue = optionalBoolean(record, "current_value");
    return currentValue == null
      ? null
      : { ...common, type: "boolean", current_value: currentValue };
  }
  if (type !== "select") return null;
  const currentValue = optionalString(record, "current_value");
  const choices = parseSessionConfigChoices(record.choices);
  return currentValue == null || !choices
    ? null
    : { ...common, type: "select", current_value: currentValue, choices };
}

function parseSessionConfigChoices(value: unknown): RuntimeSessionConfigChoices | null {
  const record = asRecord(value);
  const layout = record ? optionalString(record, "layout") : undefined;
  if (!record || !layout) return null;
  if (layout === "ungrouped") {
    const options = parseSessionConfigSelectOptions(record.options);
    return options ? { layout, options } : null;
  }
  if (layout !== "grouped") return null;
  const rawGroups = optionalArray(record, "groups");
  if (!rawGroups) return null;
  const groups = rawGroups.map((value) => {
    const group = asRecord(value);
    const id = group ? optionalString(group, "id") : undefined;
    const name = group ? optionalString(group, "name") : undefined;
    const options = group ? parseSessionConfigSelectOptions(group.options) : null;
    return id && name && options
      ? {
          id,
          name,
          options,
          ...(group?._meta !== undefined ? { _meta: group._meta } : {}),
        }
      : null;
  });
  if (groups.some((group) => group === null)) return null;
  return { layout, groups: groups.filter((group) => group !== null) };
}

function parseSessionConfigSelectOptions(
  value: unknown,
): RuntimeSessionConfigSelectOption[] | null {
  if (!Array.isArray(value)) return null;
  const options = value.map((entry) => {
    const option = asRecord(entry);
    const name = option ? optionalString(option, "name") : undefined;
    const optionValue = option ? optionalString(option, "value") : undefined;
    return option && name && optionValue !== undefined
      ? {
          name,
          value: optionValue,
          description: optionalString(option, "description"),
          ...(option?._meta !== undefined ? { _meta: option._meta } : {}),
        }
      : null;
  });
  return options.some((option) => option === null)
    ? null
    : options.filter((option) => option !== null);
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
  fast_mode?: boolean;
  profile?: string;
  codex_permission_mode?: string;
  access_mode?: string;
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
    fast_mode: optionalBoolean(record, "fast_mode"),
    profile: optionalString(record, "profile"),
    codex_permission_mode: optionalString(record, "codex_permission_mode"),
    access_mode: optionalString(record, "access_mode"),
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
  provider: string;
  model: string;
  context_window?: number;
} | null {
  const record = asRecord(payload);
  if (!record) return null;
  const provider = optionalString(record, "provider");
  const model = optionalString(record, "model");
  if (!provider || !model) return null;
  const contextWindow = optionalNumber(record, "context_window");
  return {
    provider,
    model,
    context_window: contextWindow && contextWindow > 0 ? contextWindow : undefined,
  };
}

export function parseProviderPayload(payload: unknown): {
  provider?: string;
  supports_prompt_receipts?: boolean;
  codex_permission_mode?: string;
  access_mode?: string;
} | null {
  const record = asRecord(payload);
  if (!record) return null;
  return {
    provider: optionalString(record, "provider"),
    supports_prompt_receipts: optionalBoolean(record, "supports_prompt_receipts"),
    codex_permission_mode: optionalString(record, "codex_permission_mode"),
    access_mode: optionalString(record, "access_mode"),
  };
}

export function parseModePayload(payload: unknown): { mode?: string } | null {
  const record = asRecord(payload);
  if (!record) return null;
  return { mode: optionalString(record, "mode") };
}

export function parseProfilePayload(payload: unknown): { profile?: string } | null {
  const record = asRecord(payload);
  if (!record) return null;
  return { profile: optionalString(record, "profile") };
}

export function parseEffortPayload(payload: unknown): { thinking_effort?: string } | null {
  const record = asRecord(payload);
  if (!record) return null;
  return { thinking_effort: optionalString(record, "thinking_effort") };
}

export function parseFastModePayload(payload: unknown): { enabled: boolean } | null {
  const record = asRecord(payload);
  if (!record) return null;
  const enabled = optionalBoolean(record, "enabled");
  return enabled == null ? null : { enabled };
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

export * from "./ws-envelope-payload-session";
