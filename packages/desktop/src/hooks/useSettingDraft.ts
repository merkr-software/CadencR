import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useSetting, type Setting } from "./useSetting";

export interface SettingDraft extends Omit<Setting, "setValue"> {
  /** What the user typed and the backend hasn't confirmed yet; null when nothing is pending. */
  draft: string | null;
  /** Shows `value` locally now and persists it once edits pause for the debounce. */
  setDraft: (value: string) => void;
}

/**
 * A setting edited continuously (typed into a field): the field shows the
 * draft while the user types, kept apart from the confirmed `value` so a
 * failed write drops the draft and the field falls back to what the backend
 * holds. Discrete controls (toggles, selects) use `useSetting` instead.
 */
export function useSettingDraft(key: string, debounceMs: number): SettingDraft {
  const setting = useSetting(key);
  const [draft, setDraftState] = useState<string | null>(null);
  const generationRef = useRef(0);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const flushRef = useRef<(() => void) | null>(null);
  const { setValue } = setting;

  useEffect(
    () => (): void => {
      if (timerRef.current) clearTimeout(timerRef.current);
      // Leaving within the debounce window still persists the last edit.
      flushRef.current?.();
    },
    [],
  );

  const setDraft = useCallback(
    (value: string): void => {
      const generation = ++generationRef.current;
      setDraftState(value);
      if (timerRef.current) clearTimeout(timerRef.current);
      const flush = (): void => {
        flushRef.current = null;
        timerRef.current = null;
        void setValue(value).then(() => {
          // Confirmed or failed, the field now shows the backend's value.
          if (generation === generationRef.current) setDraftState(null);
        });
      };
      flushRef.current = flush;
      timerRef.current = setTimeout(flush, debounceMs);
    },
    [debounceMs, setValue],
  );

  const { value, isLoading, isFetched, isSaving } = setting;
  return useMemo(
    () => ({ value, draft, setDraft, isLoading, isFetched, isSaving: isSaving || draft !== null }),
    [value, draft, setDraft, isLoading, isFetched, isSaving],
  );
}
