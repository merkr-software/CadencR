interface PermissionPreviewSource {
  preview?: unknown;
  input?: Record<string, unknown> | null;
  fallbackToJson?: boolean;
}

const DIRECT_PREVIEW_KEYS = [
  "command",
  "cmd",
  "script",
  "file_path",
  "filepath",
  "filePath",
  "path",
  "directory",
  "dir",
  "cwd",
  "target",
  "destination",
  "source",
];

const PREFERRED_NESTED_KEYS = ["args", "arguments", "params", "metadata", "toolInput", "rawInput"];

export function getPermissionPreview(permission: PermissionPreviewSource): string | null {
  const explicit = previewString(permission.preview);
  if (explicit) return explicit;
  const input = objectValue(permission.input);
  if (!input) return null;
  return (
    previewFromInput(input) ??
    (permission.fallbackToJson === false ? null : compactJsonPreview(input))
  );
}

function previewString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value : null;
}

function previewArray(value: unknown): string | null {
  if (!Array.isArray(value)) return null;
  const joined = value.filter((entry): entry is string => typeof entry === "string").join(" ");
  return joined.length > 0 ? joined : null;
}

function previewValue(value: unknown): string | null {
  return previewString(value) ?? previewArray(value);
}

function objectValue(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function previewFromObject(record: Record<string, unknown>): string | null {
  for (const key of DIRECT_PREVIEW_KEYS) {
    const preview = previewValue(record[key]);
    if (preview) return preview;
  }
  return null;
}

function previewFromInput(input: Record<string, unknown>): string | null {
  return previewFromObject(input) ?? deepPreview(input, new Set<unknown>());
}

function deepPreview(value: unknown, seen: Set<unknown>): string | null {
  if (seen.has(value)) return null;
  const record = objectValue(value);
  if (!record) return Array.isArray(value) ? previewArray(value) : null;
  seen.add(record);
  const direct = previewFromObject(record);
  if (direct) return direct;
  for (const key of PREFERRED_NESTED_KEYS) {
    const preview = deepPreview(record[key], seen);
    if (preview) return preview;
  }
  return null;
}

function compactJsonPreview(input: Record<string, unknown>): string | null {
  if (Object.keys(input).length === 0) return null;
  try {
    return JSON.stringify(input, null, 2);
  } catch {
    return null;
  }
}
