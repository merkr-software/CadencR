/**
 * Wire contract of the macOS notch island, shared by the three processes it
 * spans: the app renderer (the single source of agent state, which composes
 * snapshots), the Electron main process (which validates and relays them) and
 * the notch renderer (which only draws what it is handed).
 *
 * Every payload crossing IPC is parsed with these schemas on the receiving
 * side of the main process — the notch window never trusts the app renderer
 * blindly, and vice versa.
 */
import { z } from "zod";

const title = z.string().min(1).max(200);
const text = z.string().max(600);
const id = z.number().int().positive();
const epochMs = z.number().int().nonnegative();
/** Provider icons are bundled assets: a same-origin path or an inline data URL. */
export function isBundledIconSrc(src: string): boolean {
  return src.startsWith("/") || src.startsWith("./") || src.startsWith("data:image/");
}
const iconSrc = z.string().max(200_000).refine(isBundledIconSrc, {
  message: "Provider icon must be a bundled asset.",
});

export const NOTCH_ACTION_KINDS = [
  "bash",
  "edit",
  "read",
  "search",
  "web",
  "agent",
  "mcp",
  "tool",
] as const;
export type NotchActionKind = (typeof NOTCH_ACTION_KINDS)[number];

export const notchAgentSchema = z.object({
  featureId: id,
  projectId: id,
  title,
  projectName: z.string().max(200),
  status: z.enum(["running", "question", "done"]),
  /** Only set while `status === "question"`. */
  pendingKind: z.enum(["permission", "question"]).nullable(),
  providerLabel: z.string().max(80).nullable(),
  providerIconSrc: iconSrc.nullable(),
  providerIconMono: z.boolean(),
  /** Server-stamped start of the running turn — anchors the live timer. */
  turnStartedAtMs: epochMs.nullable(),
  /** Latest activity; for a finished agent, when it finished. */
  lastActivityAtMs: epochMs.nullable(),
  lastAction: z.object({ kind: z.enum(NOTCH_ACTION_KINDS), label: text }).nullable(),
  /** Start of the agent's latest reply. */
  preview: text.nullable(),
  unread: z.boolean(),
});
export type NotchAgent = z.infer<typeof notchAgentSchema>;
export type NotchAgentStatus = NotchAgent["status"];

export const NOTCH_MAX_AGENTS = 24;

export const notchSnapshotSchema = z.object({
  agents: z.array(notchAgentSchema).max(NOTCH_MAX_AGENTS),
});
export type NotchSnapshot = z.infer<typeof notchSnapshotSchema>;

export const notchNotificationSchema = z.object({
  id: z.string().min(1).max(80),
  /** `null` for the Settings preview, which has no conversation to open. */
  featureId: id.nullable(),
  projectId: id.nullable(),
  status: z.enum(["completed", "needs_input", "error"]),
  title,
  body: text,
});
/** The island enriches a notification (provider, project) from its latest snapshot. */
export type NotchNotification = z.infer<typeof notchNotificationSchema>;

/** The Settings preview: no conversation behind it, and never muted by a snooze. */
export function isNotchPreview(notification: NotchNotification): boolean {
  return notification.featureId == null;
}

export const notchFeatureRefSchema = z.object({ featureId: id, projectId: id });
export type NotchFeatureRef = z.infer<typeof notchFeatureRefSchema>;

/** How long the island can be snoozed for, in minutes. */
export const NOTCH_SNOOZE_MINUTES = [5, 30, 60, 90, 120] as const;
export type NotchSnoozeMinutes = (typeof NOTCH_SNOOZE_MINUTES)[number];
/** A snooze length, or `null` to resume. */
export const notchSnoozeSchema = z.literal(NOTCH_SNOOZE_MINUTES).nullable();

/** Window-relative rectangle (CSS px == DIP) the pointer must stay inside. */
export const notchHotRectSchema = z.object({
  x: z.number().finite(),
  y: z.number().finite(),
  width: z.number().finite().nonnegative(),
  height: z.number().finite().nonnegative(),
});
export type NotchHotRect = z.infer<typeof notchHotRectSchema>;

/** Display targets for the island; built-in mode falls back to primary when disconnected. */
export const notchDisplayModeSchema = z.enum(["builtin_always", "both", "primary"]);
export type NotchDisplayMode = z.infer<typeof notchDisplayModeSchema>;

/** Compact appearance on displays without a hardware cutout; peeks keep their full size. */
export const notchPrimaryStyleSchema = z.enum(["none", "strip_4", "strip_8", "builtin"]);
export type NotchPrimaryStyle = z.infer<typeof notchPrimaryStyleSchema>;

/** The user's notch settings, pushed by the app renderer that reads them. */
export const notchPrefsSchema = z.object({
  displayMode: notchDisplayModeSchema.default("builtin_always"),
  primaryStyle: notchPrimaryStyleSchema.default("strip_8"),
  /** Keep the compact island (ears) out while agents are tracked; off → hover and peeks only. */
  alwaysOn: z.boolean(),
  /** Keep the logo moving in the compact island; off → it only animates while open. */
  alwaysAnimate: z.boolean(),
});
export type NotchPrefs = z.infer<typeof notchPrefsSchema>;

export const DEFAULT_NOTCH_PREFS: NotchPrefs = {
  displayMode: "builtin_always",
  primaryStyle: "strip_8",
  alwaysOn: true,
  alwaysAnimate: false,
};

/** Everything the app renderer decides about the island in one message. */
export const notchConfigSchema = z.object({ enabled: z.boolean(), prefs: notchPrefsSchema });
export type NotchConfig = z.infer<typeof notchConfigSchema>;

export interface NotchGeometry {
  /** Virtual compact width in DIP, matching the built-in cutout's physical pixels. */
  compactWidth?: number;
  /** Width of the cutout (or of the virtual notch drawn on a notchless screen). */
  notchWidth: number;
  /** Height of the cutout — equal to the menu bar on notched displays. */
  notchHeight: number;
  /** False when this display has no hardware notch and the island is virtual. */
  hardware: boolean;
  windowWidth: number;
  windowHeight: number;
}

/** What the island receives once its renderer is up. */
export interface NotchReadyPayload {
  geometry: NotchGeometry | null;
  snapshot: NotchSnapshot;
  prefs: NotchPrefs;
  /** Epoch ms the island stays muted until; `null` when it isn't snoozed. */
  snoozedUntil: number | null;
}

/** The island renderer's bridge, exposed by `electron/preload/notch.ts`. */
export interface NotchBridge {
  ready: () => Promise<NotchReadyPayload>;
  setHotRect: (rect: NotchHotRect) => Promise<void>;
  openFeature: (ref: NotchFeatureRef) => Promise<void>;
  dismiss: (ref: NotchFeatureRef) => Promise<void>;
  /** Close the island under the pointer until the pointer leaves it. */
  collapse: () => Promise<void>;
  snooze: (minutes: NotchSnoozeMinutes | null) => Promise<void>;
  onSnapshot: (cb: (snapshot: NotchSnapshot) => void) => () => void;
  onNotification: (cb: (notification: NotchNotification) => void) => () => void;
  onHover: (cb: (hovering: boolean) => void) => () => void;
  onGeometry: (cb: (geometry: NotchGeometry | null) => void) => () => void;
  onPrefs: (cb: (prefs: NotchPrefs) => void) => () => void;
  onSnooze: (cb: (snoozedUntil: number | null) => void) => () => void;
}

export interface NotchCapabilities {
  /** The island exists only in the macOS desktop shell. */
  supported: boolean;
  /** A display with a hardware notch is connected right now. */
  hardware: boolean;
}
