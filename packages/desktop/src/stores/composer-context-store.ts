import { useEffect } from "react";
import { create } from "zustand";
import { z } from "zod";
import { readLocalJson, writeLocalJson } from "@/lib/local-json";

/**
 * Context gathered for a composer's next message, beyond its text and image
 * attachments: a long paste, an editor selection, terminal output, a pull
 * request… Each item shows as a removable chip in the composer's context tray
 * and is appended to the prompt when it is sent.
 *
 * Keyed by composer (see `composerKeyFor`) so the Editor or the Terminal can
 * add to the conversation's composer without holding a reference to it, and
 * mirrored to localStorage so a reload keeps it with the draft.
 */
export type ComposerContextKind = "pasted" | "selection" | "terminal" | "pull_request" | "review";

const ITEM_SCHEMA = z.object({
  id: z.string(),
  kind: z.enum(["pasted", "selection", "terminal", "pull_request", "review"]),
  label: z.string(),
  detail: z.string().optional(),
  /** Text appended to the prompt; `language` fences it as code. */
  content: z.string(),
  language: z.string().optional(),
  /** Review comments this item carries; removed from the Git pane once it is sent. */
  commentIds: z.array(z.number()).optional(),
});

export type ComposerContextItem = z.infer<typeof ITEM_SCHEMA>;

const EMPTY: ComposerContextItem[] = [];
const STORAGE_PREFIX = "cadencr:composer-context:";

interface ComposerContextStore {
  items: Record<string, ComposerContextItem[]>;
  add: (key: string, item: Omit<ComposerContextItem, "id">) => void;
  /** Remove these items (by id), e.g. the ones a send just carried. */
  remove: (key: string, ...ids: string[]) => void;
  /** Load a composer's items from localStorage once; later calls are no-ops. */
  hydrate: (key: string) => void;
}

const ITEMS_SCHEMA = z.array(ITEM_SCHEMA);

function read(key: string): ComposerContextItem[] {
  return (
    readLocalJson(
      STORAGE_PREFIX + key,
      ITEMS_SCHEMA,
      "Couldn't restore the context attached to this draft; it was reset.",
    ) ?? EMPTY
  );
}

function write(key: string, items: ComposerContextItem[]): void {
  writeLocalJson(
    STORAGE_PREFIX + key,
    items.length === 0 ? null : items,
    "Couldn't save the attached context for after a reload",
  );
}

let nextId = 0;

export const useComposerContextStore = create<ComposerContextStore>((set, get) => ({
  items: {},
  add: (key, item) => {
    const current = get().items[key] ?? read(key);
    nextId += 1;
    const next = [...current, { ...item, id: `${Date.now()}-${nextId}` }];
    write(key, next);
    set({ items: { ...get().items, [key]: next } });
  },
  remove: (key, ...ids) => {
    const next = (get().items[key] ?? read(key)).filter((item) => !ids.includes(item.id));
    write(key, next);
    set({ items: { ...get().items, [key]: next } });
  },
  hydrate: (key) => {
    if (get().items[key] !== undefined) return;
    set({ items: { ...get().items, [key]: read(key) } });
  },
}));

/** A composer's items, hydrated from localStorage the first time it mounts. */
export function useComposerContextItems(key: string): ComposerContextItem[] {
  const items = useComposerContextStore((state) => state.items[key]);
  useEffect(() => {
    // Several pieces of one composer read the tray; only the first reads storage.
    if (items === undefined) useComposerContextStore.getState().hydrate(key);
  }, [items, key]);
  return items ?? EMPTY;
}

/** The composer of a conversation: one per feature (its root pane owns input). */
export function composerKeyFor(featureId: number | undefined): string {
  return `feature-${featureId ?? "new"}`;
}

/** Render the items as prompt text appended after the user's own words. */
export function appendComposerContext(text: string, items: ComposerContextItem[]): string {
  if (items.length === 0) return text;
  const blocks = items.map((item) => {
    const heading = `**${item.label}${item.detail ? ` — ${item.detail}` : ""}**`;
    if (item.kind === "pull_request" || item.kind === "review")
      return `${heading}\n${item.content}`;
    const fence = item.content.includes("```") ? "````" : "```";
    return `${heading}\n${fence}${item.language ?? ""}\n${item.content}\n${fence}`;
  });
  return [text, ...blocks].filter((part) => part.trim().length > 0).join("\n\n");
}
