import { translateUi } from "@/lib/i18n/ui";
import type { ExcalidrawInitialDataState } from "@excalidraw/excalidraw/types";

export interface ParsedScene {
  initialData: ExcalidrawInitialDataState | null;
  error: string | null;
}

/**
 * Parse `.excalidraw` file content into Excalidraw `initialData`.
 *
 * `undefined` content (still loading) yields a neutral result. An empty file is
 * treated as a blank scene. Invalid JSON, or JSON that isn't a plain object
 * (a bare scalar, `null`, or an array), yields a user-facing error instead of
 * feeding garbage to Excalidraw. `scrollToContent` fits the drawing on open.
 *
 * Kept runtime-free (type-only Excalidraw import) so it stays cheap to unit-test
 * without loading the Excalidraw bundle.
 */
export function parseScene(content: string | undefined): ParsedScene {
  if (content === undefined) return { initialData: null, error: null };
  let scene: unknown;
  try {
    scene = content.trim() === "" ? {} : JSON.parse(content);
  } catch {
    return {
      initialData: null,
      error: translateUi(
        "workspace.editor.excalidraw-scene.invalidJson",
        "This .excalidraw file isn't valid JSON.",
      ),
    };
  }
  if (typeof scene !== "object" || scene === null || Array.isArray(scene)) {
    return {
      initialData: null,
      error: translateUi(
        "workspace.editor.excalidraw-scene.invalidScene",
        "This .excalidraw file isn't a valid scene.",
      ),
    };
  }
  return {
    initialData: { ...scene, scrollToContent: true } as ExcalidrawInitialDataState,
    error: null,
  };
}
