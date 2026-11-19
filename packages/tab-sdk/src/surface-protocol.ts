/** Immutable identity of the native surface containing this guest. */
export interface SurfaceIdentity {
  kind: "tab" | "editor";
  instanceId: string;
}

/** The editor appearance only; no general settings access. */
export interface EditorAppearance {
  fontFamily: string;
  /** CSS pixels, independent of the window's zoom factor. */
  fontSize: number;
}

/** Common arguments passed to a contribution's plugin-defined open method. */
export interface EditorOpenFileParams {
  path: string;
  /** 1-based. */
  line?: number;
  /** 1-based. */
  column?: number;
}

export function isSurfaceIdentity(value: unknown): value is SurfaceIdentity {
  return (
    typeof value === "object" &&
    value !== null &&
    "kind" in value &&
    (value.kind === "tab" || value.kind === "editor") &&
    "instanceId" in value &&
    typeof value.instanceId === "string" &&
    value.instanceId.length > 0
  );
}

export function isEditorAppearance(value: unknown): value is EditorAppearance {
  return (
    typeof value === "object" &&
    value !== null &&
    "fontFamily" in value &&
    typeof value.fontFamily === "string" &&
    value.fontFamily.length > 0 &&
    "fontSize" in value &&
    typeof value.fontSize === "number" &&
    Number.isFinite(value.fontSize) &&
    value.fontSize > 0
  );
}
