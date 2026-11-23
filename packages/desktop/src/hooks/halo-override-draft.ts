import type { QueryClient } from "@tanstack/react-query";
import {
  parseHaloOverrides,
  THEME_HALO_OVERRIDES_SETTING_KEY,
  withOverride,
  type HaloOverride,
  type ThemeId,
} from "@/lib/themes";
import { writeSetting } from "./setting-persistence";

interface PendingHaloOverride {
  override: HaloOverride;
  timer: ReturnType<typeof setTimeout> | null;
}

// Preview state belongs to the workspace QueryClient, separately from the
// confirmed settings cache. All halo readers see the same pending theme edit.
const stores = new WeakMap<QueryClient, ReturnType<typeof createHaloOverrideDraft>>();

export function haloOverrideDraft(queryClient: QueryClient) {
  let store = stores.get(queryClient);
  if (!store) {
    store = createHaloOverrideDraft(queryClient);
    stores.set(queryClient, store);
  }
  return store;
}

function createHaloOverrideDraft(queryClient: QueryClient) {
  const pending = new Map<ThemeId, PendingHaloOverride>();
  const listeners = new Set<() => void>();
  const notify = (): void => {
    for (const listener of listeners) listener();
  };

  const flush = (themeId: ThemeId): void => {
    const edit = pending.get(themeId);
    // A null timer means this version was already submitted to the writer.
    if (!edit || edit.timer === null) return;
    clearTimeout(edit.timer);
    edit.timer = null;
    void writeSetting(queryClient, THEME_HALO_OVERRIDES_SETTING_KEY, (confirmed) => {
      if (confirmed === undefined) {
        throw new Error("Saved halo settings have not loaded. Try again after they load.");
      }
      return JSON.stringify(
        withOverride(parseHaloOverrides(confirmed).value ?? {}, themeId, edit.override),
      );
    }).then(() => {
      // Success and failure both drop the preview back to confirmed settings.
      // An older acknowledgement must never discard a more recent gesture.
      if (pending.get(themeId) !== edit) return;
      pending.delete(themeId);
      notify();
    });
  };

  return {
    subscribe: (listener: () => void): (() => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    getDraft: (themeId: ThemeId): HaloOverride | null => pending.get(themeId)?.override ?? null,
    setDraft: (themeId: ThemeId, override: HaloOverride): void => {
      const previous = pending.get(themeId);
      if (previous && previous.timer !== null) clearTimeout(previous.timer);
      pending.set(themeId, {
        override,
        timer: setTimeout(() => flush(themeId), 150),
      });
      notify();
    },
    flush,
  };
}
