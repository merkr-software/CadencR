import type { EditorOpenFileParams } from "@cadencr/tab-sdk/protocol";
import { openFileRoute, startRoute } from "@/api/generated";
import type { BuiltinEditorAdapter } from "@/lib/editors/editor-navigation";
import { focusNeovimEditor } from "./focusNeovimEditor";

async function open(
  featureId: number,
  params: EditorOpenFileParams,
  reveal: () => void,
  isCurrent = () => true,
): Promise<void> {
  await startRoute(featureId);
  if (!isCurrent()) return;
  reveal();
  await openFileRoute(String(featureId), {
    path: params.path,
    line: params.line,
    col: params.column,
  });
}

async function focus(featureId: number, isCurrent = () => true): Promise<void> {
  if (!isCurrent()) return;
  if (focusNeovimEditor(featureId)) return;
  await new Promise<void>((resolve, reject) => {
    const observer = new MutationObserver(() => {
      if (isCurrent() && !focusNeovimEditor(featureId)) return;
      clearTimeout(timer);
      observer.disconnect();
      resolve();
    });
    observer.observe(document.body, { childList: true, subtree: true });
    const timer = setTimeout(() => {
      observer.disconnect();
      if (isCurrent()) reject(new Error("The Neovim editor did not become available."));
      else resolve();
    }, 5_000);
  });
}

/** Native behavior stays in the built-in adapter during the coexistence release. */
export const builtinNeovimEditor: BuiltinEditorAdapter = { open, focus };
