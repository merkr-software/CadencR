import { translateUi } from "@/lib/i18n/ui";
import { getFileNameLower } from "@/lib/file-language";
import {
  detectEditorLanguageId,
  isEditorLanguageId,
  type EditorLanguageId,
} from "@/lib/editor-language";

export const EDITOR_LANGUAGE_OVERRIDES_KEY = "editor_language_overrides";
export type EditorLanguagePreference = EditorLanguageId | "auto";

export interface EditorLanguageOverrides {
  version: 1;
  files: Record<string, EditorLanguageId>;
  extensions: Record<string, EditorLanguageId>;
}

export interface LanguagePickerSelection {
  preference: EditorLanguagePreference;
  applyToExtension: boolean;
}

export function isEditorLanguagePreference(value: unknown): value is EditorLanguagePreference {
  return value === "auto" || isEditorLanguageId(value);
}

export function emptyEditorLanguageOverrides(): EditorLanguageOverrides {
  return { version: 1, files: {}, extensions: {} };
}

export function normalizeLanguageOverrideFilePath(filePath: string): string {
  return filePath.replaceAll("\\", "/").replace(/^\.\//, "");
}

export function getLanguageOverrideExtension(filePath: string): string | null {
  const fileName = getFileNameLower(filePath);
  const dot = fileName.lastIndexOf(".");
  if (dot < 0 || dot === fileName.length - 1) return null;
  return fileName.slice(dot + 1);
}

export function parseEditorLanguageOverrides(raw: string | null): EditorLanguageOverrides {
  if (raw === null || raw.trim() === "") return emptyEditorLanguageOverrides();

  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch (error) {
    throw new Error(
      translateUi(
        "workspace.editor.languageOverrides.invalidJson",
        "Language overrides are not valid JSON",
      ),
      { cause: error },
    );
  }
  if (!isRecord(value) || value.version !== 1) {
    throw new Error(
      translateUi(
        "workspace.editor.languageOverrides.unsupportedFormat",
        "Language overrides use an unsupported format",
      ),
    );
  }

  return {
    version: 1,
    files: parseFiles(value.files),
    extensions: parseExtensions(value.extensions),
  };
}

export function resolveEditorLanguageId(
  filePath: string,
  overrides: EditorLanguageOverrides,
): EditorLanguageId {
  const filePreference = getOwn(overrides.files, normalizeLanguageOverrideFilePath(filePath));
  if (filePreference !== undefined) return filePreference;

  return resolveEditorLanguageAssociation(filePath, overrides);
}

export function resolveEditorLanguageAssociation(
  filePath: string,
  overrides: EditorLanguageOverrides,
): EditorLanguageId {
  const detected = detectEditorLanguageId(filePath);
  const extension = getLanguageOverrideExtension(filePath);
  return (extension && getOwn(overrides.extensions, extension)) || detected;
}

export function getLanguagePickerSelection(
  filePath: string,
  overrides: EditorLanguageOverrides,
): LanguagePickerSelection {
  const filePreference = getOwn(overrides.files, normalizeLanguageOverrideFilePath(filePath));
  if (filePreference !== undefined) {
    return { preference: filePreference, applyToExtension: false };
  }

  const extension = getLanguageOverrideExtension(filePath);
  const extensionPreference = extension ? getOwn(overrides.extensions, extension) : undefined;
  return extensionPreference
    ? { preference: extensionPreference, applyToExtension: true }
    : { preference: "auto", applyToExtension: false };
}

export function updateEditorLanguageOverrides(
  overrides: EditorLanguageOverrides,
  filePath: string,
  selection: LanguagePickerSelection,
): EditorLanguageOverrides {
  const files = { ...overrides.files };
  const extensions = { ...overrides.extensions };
  const fileKey = normalizeLanguageOverrideFilePath(filePath);
  const extension = getLanguageOverrideExtension(filePath);

  if (selection.applyToExtension && extension) {
    delete files[fileKey];
    if (selection.preference === "auto") delete extensions[extension];
    else setOwn(extensions, extension, selection.preference);
  } else if (selection.preference === "auto") {
    delete files[fileKey];
  } else {
    setOwn(files, fileKey, selection.preference);
  }

  return { version: 1, files, extensions };
}

function parseFiles(value: unknown): Record<string, EditorLanguageId> {
  if (!isRecord(value))
    throw new Error(
      translateUi(
        "workspace.editor.languageOverrides.invalidFiles",
        "Language override files must be an object",
      ),
    );
  const files: Record<string, EditorLanguageId> = {};
  for (const [filePath, preference] of Object.entries(value)) {
    if (!isEditorLanguageId(preference)) {
      throw new Error(
        translateUi(
          "workspace.editor.languageOverrides.invalidFile",
          "Invalid language override for {{path}}",
          { path: filePath },
        ),
      );
    }
    setOwn(files, filePath, preference);
  }
  return files;
}

function parseExtensions(value: unknown): Record<string, EditorLanguageId> {
  if (!isRecord(value))
    throw new Error(
      translateUi(
        "workspace.editor.languageOverrides.invalidExtensions",
        "Language override extensions must be an object",
      ),
    );
  const extensions: Record<string, EditorLanguageId> = {};
  for (const [extension, languageId] of Object.entries(value)) {
    if (!isEditorLanguageId(languageId)) {
      throw new Error(
        translateUi(
          "workspace.editor.languageOverrides.invalidExtension",
          "Invalid language override for *.{{extension}}",
          { extension },
        ),
      );
    }
    setOwn(extensions, extension.toLowerCase(), languageId);
  }
  return extensions;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function getOwn<T>(record: Record<string, T>, key: string): T | undefined {
  return Object.hasOwn(record, key) ? record[key] : undefined;
}

function setOwn<T>(record: Record<string, T>, key: string, value: T): void {
  Object.defineProperty(record, key, {
    value,
    enumerable: true,
    configurable: true,
    writable: true,
  });
}
