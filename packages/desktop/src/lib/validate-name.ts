import { translateUi } from "@/lib/i18n/ui";
/**
 * Reject empty names, names containing path separators, and `.` / `..`.
 *
 * Same rule the backend enforces in
 * `domain/editor/mutation_routes.rs::validate_simple_name`. Failing fast in
 * the UI avoids a round-trip; the backend remains the source of truth.
 *
 * Returns `null` on success, or a user-facing error string.
 */
export function validateSimpleName(name: string): string | null {
  if (!name.trim())
    return translateUi("workspace.editor.fileActions.nameRequired", "Name cannot be empty");
  if (name.includes("/") || name.includes("\\"))
    return translateUi(
      "workspace.editor.fileActions.nameHasPathSeparator",
      "Name cannot contain '/' or '\\'",
    );
  if (name === "." || name === "..")
    return translateUi("workspace.editor.fileActions.invalidName", "Invalid name");
  return null;
}
