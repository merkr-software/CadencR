/**
 * localStorage persistence for the unread/failed marks of `unread-store.ts`,
 * and the pull request actions marked done, so a reload or a restart keeps
 * every pending "review this" and "this failed", and never brings back a
 * dismissed "Fix CI". Still per-client: nothing goes to the backend, and a
 * remote phone and the host each keep their own.
 */
import { toast } from "sonner";
import { z } from "zod";
import { parseJsonSetting } from "@/lib/json-setting";

/** Bump the version when the stored shape changes; an old key is then ignored. */
const UNREAD_MARKS_STORAGE_KEY = "cadencr:unread-marks:v1";

export interface UnreadMarks {
  /** Feature IDs with an unread agent completion (value is always `true`). */
  byFeature: Record<number, true>;
  /** Feature IDs whose last turn failed off-screen (value is always `true`). */
  failedByFeature: Record<number, true>;
  /** When each marked feature was first marked, as an increasing counter. */
  markedOrder: Record<number, number>;
  /** The pull request action marked done per feature, as its `prActionKey`. */
  prAcks: Record<number, string>;
}

const featureIdSchema = z.number().int().nonnegative();

/**
 * Every marked feature, oldest mark first, with what it has unseen; then the
 * pull request actions marked done (absent from values saved before them).
 */
const storedMarksSchema = z.object({
  marks: z.array(z.tuple([featureIdSchema, z.enum(["unread", "failed", "both"])])),
  prAcks: z.array(z.tuple([featureIdSchema, z.string().min(1)])).optional(),
});

type StoredMarks = z.infer<typeof storedMarksSchema>;

const EMPTY_MARKS: UnreadMarks = {
  byFeature: {},
  failedByFeature: {},
  markedOrder: {},
  prAcks: {},
};

/** Rebuild the store's records; the stored order becomes 1..n. */
function toMarks(stored: StoredMarks): UnreadMarks {
  const marks: UnreadMarks = {
    byFeature: {},
    failedByFeature: {},
    markedOrder: {},
    prAcks: Object.fromEntries(stored.prAcks ?? []),
  };
  stored.marks.forEach(([id, kind], index) => {
    if (kind !== "failed") marks.byFeature[id] = true;
    if (kind !== "unread") marks.failedByFeature[id] = true;
    marks.markedOrder[id] = index + 1;
  });
  return marks;
}

interface RestoredMarks {
  marks: UnreadMarks;
  /** Why the stored marks were dropped, or null when they restored (or there were none). */
  error: string | null;
}

/** Parse a stored value; anything unreadable falls back to no marks, with the reason. */
function parseUnreadMarks(raw: string | null): RestoredMarks {
  const parsed = parseJsonSetting(raw, storedMarksSchema, "ordered unread/failed marks");
  if (parsed.value) return { marks: toMarks(parsed.value), error: null };
  return { marks: EMPTY_MARKS, error: parsed.error };
}

let pendingRestoreError: string | null = null;

/** Read the marks this window left before its last reload. Never throws. */
export function loadUnreadMarks(): UnreadMarks {
  if (typeof window === "undefined") return EMPTY_MARKS;
  let raw: string | null;
  try {
    raw = window.localStorage.getItem(UNREAD_MARKS_STORAGE_KEY);
  } catch (error: unknown) {
    console.error("Could not read saved unread marks.", error);
    pendingRestoreError = "Could not restore unread and failed marks.";
    return EMPTY_MARKS;
  }
  const { marks, error } = parseUnreadMarks(raw);
  if (error) {
    console.error(`Dropped corrupt saved unread marks: ${error}`, raw);
    pendingRestoreError = "Saved unread and failed marks were unreadable, so they were cleared.";
    // Drop the bad value so the next reload doesn't report it again.
    try {
      window.localStorage.removeItem(UNREAD_MARKS_STORAGE_KEY);
    } catch (removeError: unknown) {
      console.error("Could not clear corrupt saved unread marks.", removeError);
    }
  }
  return marks;
}

/**
 * Toast a restore failure once the app can show it. The store hydrates while
 * modules load, before `<Toaster>` subscribes, and sonner drops anything
 * emitted earlier; a zero-delay timeout from a mounted effect runs after every
 * effect of the commit, the toaster's included.
 */
export function reportUnreadRestoreError(): void {
  const message = pendingRestoreError;
  if (!message) return;
  pendingRestoreError = null;
  window.setTimeout(() => toast.error(message), 0);
}

function toStored(marks: UnreadMarks): StoredMarks {
  const { byFeature, failedByFeature, markedOrder, prAcks } = marks;
  const ids = Object.keys(markedOrder)
    .map(Number)
    .sort((a, b) => (markedOrder[a] ?? 0) - (markedOrder[b] ?? 0));
  return {
    marks: ids.map((id) => [
      id,
      byFeature[id] && failedByFeature[id] ? "both" : failedByFeature[id] ? "failed" : "unread",
    ]),
    prAcks: Object.entries(prAcks).map(([id, key]) => [Number(id), key]),
  };
}

let reportedSaveError = false;

/** Write the marks; a full or disabled storage is reported once per window. */
export function saveUnreadMarks(marks: UnreadMarks): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(UNREAD_MARKS_STORAGE_KEY, JSON.stringify(toStored(marks)));
  } catch (error: unknown) {
    console.error("Could not save unread marks.", error);
    if (reportedSaveError) return;
    reportedSaveError = true;
    toast.error("Could not save unread and failed marks; they won't survive a reload.");
  }
}
