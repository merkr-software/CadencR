import { useCallback, useEffect, useMemo, useRef, useState } from "react";

export interface SyncedSettingInput {
  value: string;
  setValue: (value: string) => void;
}

/**
 * Local text-input state seeded from a remote (autosaved) setting value.
 *
 * Keeps the field responsive while typing without letting a slower remote
 * echo clobber in-flight edits: once the user types, `dirtyRef` blocks the
 * remote value from overwriting local state until either the remote catches
 * up to what was typed or `resetKey` changes (e.g. switching projects), which
 * forces a re-seed from the new remote value.
 */
export function useSyncedSettingInput(
  remoteValue: string | undefined,
  resetKey: string,
): SyncedSettingInput {
  const [value, setStoredValue] = useState(remoteValue ?? "");
  const dirtyRef = useRef(false);
  const resetKeyRef = useRef(resetKey);

  useEffect((): void => {
    if (resetKeyRef.current !== resetKey) {
      resetKeyRef.current = resetKey;
      dirtyRef.current = false;
      setStoredValue(remoteValue ?? "");
      return;
    }
    if (remoteValue === undefined) return;
    if (dirtyRef.current && remoteValue !== value) return;
    dirtyRef.current = false;
    if (remoteValue !== value) setStoredValue(remoteValue);
  }, [remoteValue, resetKey, value]);

  const setValue = useCallback((next: string): void => {
    dirtyRef.current = true;
    setStoredValue(next);
  }, []);

  return useMemo(() => ({ value, setValue }), [value, setValue]);
}
