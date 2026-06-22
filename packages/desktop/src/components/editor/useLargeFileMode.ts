import { useCallback, useState } from "react";
import { LARGE_FILE_OPEN_BYTES } from "@/lib/editor-thresholds";

interface UseLargeFileModeArgs {
  /** Backend-supplied flag — authoritative when present. */
  large: boolean | undefined;
  /** Loaded file content, used only as a defensive fallback for older services. */
  content: string | undefined;
}

interface UseLargeFileModeResult {
  /** True while the file should open read-only with language features disabled. */
  largeMode: boolean;
  /** True when the underlying file qualifies as large (regardless of opt-in). */
  isLarge: boolean;
  /** User opted into full editing — escapes large mode for this mount. */
  editAnyway: () => void;
}

/**
 * Decides whether a freshly-read file opens in read-only "large-file mode".
 *
 * The backend `large` flag is authoritative; the content-length check is a
 * defensive fallback for services that predate the flag. Once the user clicks
 * "Edit anyway" we force the full editor for the lifetime of this mount.
 */
export function useLargeFileMode({ large, content }: UseLargeFileModeArgs): UseLargeFileModeResult {
  const [forceFull, setForceFull] = useState(false);
  const isLarge = large ?? (content !== undefined && content.length >= LARGE_FILE_OPEN_BYTES);
  const largeMode = isLarge && !forceFull;
  const editAnyway = useCallback(() => setForceFull(true), []);
  return { largeMode, isLarge, editAnyway };
}
