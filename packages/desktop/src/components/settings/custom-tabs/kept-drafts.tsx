import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type Dispatch,
  type SetStateAction,
} from "react";
import type { Draft } from "./config-draft";

/**
 * Unsaved settings drafts, held above the virtualized card list: a card
 * scrolled out of it unmounts its form, and must find its draft on the way
 * back. One draft per slot (a tab's scope, or one project of it), tagged with
 * the stored values it was started from: once those change (an edit
 * elsewhere), the draft is retired and the form starts over from them. A
 * successful save retires it explicitly (`reset`), since a masked answer
 * (a replaced secret) can read the same as before.
 */
interface KeptDraft {
  version: string;
  draft: Draft;
}

const KeptDraftsContext = createContext<Map<string, KeptDraft> | null>(null);

/** A slot's save in flight and its last inline error. */
interface SlotSave {
  saving: boolean;
  error: string | null;
}

const IDLE: SlotSave = { saving: false, error: null };

interface SaveStore {
  saves: Record<string, SlotSave>;
  update: (id: string, change: Partial<SlotSave>) => void;
}

const KeptSavesContext = createContext<SaveStore | null>(null);

function useSaveStore(): SaveStore {
  const [saves, setSaves] = useState<Record<string, SlotSave>>({});
  const update = useCallback(
    (id: string, change: Partial<SlotSave>) =>
      setSaves((previous) => ({ ...previous, [id]: { ...(previous[id] ?? IDLE), ...change } })),
    [],
  );
  return useMemo(() => ({ saves, update }), [saves, update]);
}

export function KeptDraftsProvider({ children }: { children: React.ReactNode }): React.JSX.Element {
  const [drafts] = useState(() => new Map<string, KeptDraft>());
  const saves = useSaveStore();
  return (
    <KeptDraftsContext.Provider value={drafts}>
      <KeptSavesContext.Provider value={saves}>{children}</KeptSavesContext.Provider>
    </KeptDraftsContext.Provider>
  );
}

/**
 * Saves per slot, held with the drafts while a provider is mounted above (in
 * the component otherwise): a card scrolled out of the list and back while
 * its save runs must come back locked, or an edit made meanwhile would be
 * reset when that save reloads.
 */
export function useKeptSaves(): {
  of: (id: string) => SlotSave;
  update: SaveStore["update"];
} {
  const kept = useContext(KeptSavesContext);
  const local = useSaveStore();
  const store = kept ?? local;
  return useMemo(
    () => ({ of: (id: string) => store.saves[id] ?? IDLE, update: store.update }),
    [store],
  );
}

/**
 * The form's edits (over what is stored), kept in `slot` while a provider is
 * mounted above, for as long as the stored values are still `version`.
 * `reset` drops them, in the kept copy too, so it holds for a form that
 * scrolled out of view while saving.
 */
export function useKeptDraft(
  slot: { id: string; version: string } | undefined,
): [Draft, Dispatch<SetStateAction<Draft>>, () => void] {
  const drafts = useContext(KeptDraftsContext);
  const [draft, setDraft] = useState<Draft>(() => {
    const kept = slot ? drafts?.get(slot.id) : undefined;
    return kept && kept.version === slot?.version ? kept.draft : {};
  });
  const id = slot?.id;
  const version = slot?.version;
  useEffect(() => {
    if (drafts && id !== undefined && version !== undefined) drafts.set(id, { version, draft });
  }, [drafts, id, version, draft]);
  const reset = useCallback(() => {
    if (drafts && id !== undefined) drafts.delete(id);
    setDraft({});
  }, [drafts, id]);
  return [draft, setDraft, reset];
}
