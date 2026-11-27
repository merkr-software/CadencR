import { z } from "zod";

/**
 * The auto-updater's state. The Electron main process owns it (it alone sees
 * electron-updater's events) and publishes every change as a whole
 * `UpdateSnapshot`; the renderer only mirrors the latest snapshot, so a
 * renderer reload or a new window reads the same state back.
 */
export type UpdateStatus =
  | "idle"
  | "checking"
  | "available"
  | "downloading"
  | "downloaded"
  | "up-to-date"
  | "error"
  /**
   * In-app updates are disabled for an unrecognized/custom Linux install.
   * Official AppImage, DEB, and RPM packages all use electron-updater.
   */
  | "unsupported";

const unsupportedReasonSchema = z.enum(["unsupported-install", "dev-build"]);
type UnsupportedUpdateReason = z.infer<typeof unsupportedReasonSchema>;

export interface UpdateSnapshot {
  /** Grows with every change, so a reader can drop a snapshot older than the one it holds. */
  revision: number;
  status: UpdateStatus;
  version: string | null;
  /** Markdown body fetched from the GitHub release, or `null` if not yet/never available. */
  changelogMarkdown: string | null;
  /** True while the main process is fetching the changelog for `version` from GitHub. */
  changelogLoading: boolean;
  /** Download percent, 0–100. */
  progress: number;
  error: string | null;
  /** Stable reason for resolving an unsupported install in the current UI language. */
  unsupportedReason: UnsupportedUpdateReason | null;
  /** Optional opaque detail from a development snapshot. */
  unsupportedMessage: string | null;
  /**
   * The user asked to install the downloaded update once no agent is
   * mid-turn. Kept here so it survives a renderer reload; the renderer, which
   * sees agent status, starts the install. Cleared by a cancel or the install.
   */
  installWhenAgentsFinish: boolean;
}

/** Main → renderer: every new `UpdateSnapshot`. */
export const UPDATE_STATE_CHANNEL = "update:state";

/** One thing the main process learned about the update, from electron-updater or a check. */
export const updateEventSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("checking") }),
  z.object({ kind: z.literal("available"), version: z.string() }),
  /** Markdown body for `version`, fetched from GitHub. `null` on miss/failure. */
  z.object({ kind: z.literal("changelog"), version: z.string(), markdown: z.string().nullable() }),
  z.object({ kind: z.literal("not-available"), version: z.string() }),
  z.object({ kind: z.literal("error"), message: z.string() }),
  z.object({
    kind: z.literal("download-progress"),
    percent: z.number(),
    bytesPerSecond: z.number(),
  }),
  z.object({ kind: z.literal("downloaded"), version: z.string() }),
  z.object({
    kind: z.literal("unsupported"),
    reason: unsupportedReasonSchema,
    message: z.string().optional(),
  }),
  /** The user set or cleared the wish to install once agents finish. */
  z.object({ kind: z.literal("install-when-agents-finish"), pending: z.boolean() }),
]);
export type UpdateEvent = z.infer<typeof updateEventSchema>;

export const INITIAL_UPDATE_SNAPSHOT: UpdateSnapshot = {
  revision: 0,
  status: "idle",
  version: null,
  changelogMarkdown: null,
  changelogLoading: false,
  progress: 0,
  error: null,
  unsupportedReason: null,
  unsupportedMessage: null,
  installWhenAgentsFinish: false,
};

type UpdateFields = Omit<UpdateSnapshot, "revision">;

/** The fields an event sets, or `null` when it does not apply. */
function eventFields(prev: UpdateSnapshot, event: UpdateEvent): Partial<UpdateFields> | null {
  switch (event.kind) {
    case "checking":
      return { status: "checking", error: null };
    case "available":
      return {
        status: "downloading",
        version: event.version,
        changelogMarkdown: null,
        changelogLoading: true,
        progress: 0,
        error: null,
      };
    case "changelog":
      // A changelog for an earlier update cycle arrives too late to matter.
      return prev.version === event.version
        ? { changelogMarkdown: event.markdown, changelogLoading: false }
        : null;
    case "not-available":
      return { status: "up-to-date", version: event.version, error: null };
    case "download-progress":
      return { status: "downloading", progress: event.percent, error: null };
    case "downloaded":
      return { status: "downloaded", version: event.version, progress: 100, error: null };
    case "error":
      return { status: "error", error: event.message };
    case "unsupported":
      return {
        status: "unsupported",
        unsupportedReason: event.reason,
        unsupportedMessage: event.message ?? null,
        error: null,
      };
    case "install-when-agents-finish":
      // Only a downloaded update can wait to be installed; clearing always applies.
      return event.pending && prev.status !== "downloaded"
        ? null
        : { installWhenAgentsFinish: event.pending };
  }
}

/**
 * Fold one event into the snapshot. Returns `prev` itself when nothing
 * changed (a repeated `checking`, `unsupported` announce or progress tick),
 * so the main process publishes only real changes.
 */
/** Statuses in which an update is on its way or ready: a wish to install it can wait. */
const UPDATE_IN_FLIGHT: ReadonlySet<UpdateStatus> = new Set([
  "checking",
  "downloading",
  "downloaded",
]);

export function reduceUpdateSnapshot(prev: UpdateSnapshot, event: UpdateEvent): UpdateSnapshot {
  const fields = eventFields(prev, event);
  if (!fields) return prev;
  // A failed check or "up to date" leaves nothing to install: the wish is settled
  // rather than left to install some later update the user never confirmed.
  if (fields.status !== undefined && !UPDATE_IN_FLIGHT.has(fields.status)) {
    fields.installWhenAgentsFinish = false;
  }
  const keys = Object.keys(fields) as (keyof UpdateFields)[];
  if (keys.every((key) => fields[key] === prev[key])) return prev;
  return { ...prev, ...fields, revision: prev.revision + 1 };
}
