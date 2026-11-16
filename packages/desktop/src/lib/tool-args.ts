export function isToolArgsObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function parseToolArgsObject(toolArgs?: string): Record<string, unknown> | null {
  if (!toolArgs) return null;
  try {
    const parsed: unknown = JSON.parse(toolArgs);
    return isToolArgsObject(parsed) ? parsed : null;
  } catch {
    // Streaming tool calls often contain partial JSON until the final delta arrives.
    return null;
  }
}

export function stringArg(
  args: Record<string, unknown> | null | undefined,
  ...keys: readonly string[]
): string | undefined {
  if (!args) return undefined;
  for (const key of keys) {
    if (typeof args[key] === "string") return args[key];
  }
  return undefined;
}
