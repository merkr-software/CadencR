import type { BrowserWindow } from "electron";
import { z } from "zod";
import {
  INITIAL_UPDATE_SNAPSHOT,
  reduceUpdateSnapshot,
  UPDATE_STATE_CHANNEL,
  updateEventSchema,
  type UpdateEvent,
  type UpdateSnapshot,
} from "../../src/shared/update-state";
import { sendToWindow } from "./safe-send";

/**
 * Source of truth for the auto-updater's state. Every updater event goes
 * through `apply`, which publishes the whole new snapshot; a renderer that
 * mounts later (reload, new window) reads `snapshot()` and then follows.
 */
export class UpdateStateAuthority {
  private current: UpdateSnapshot = INITIAL_UPDATE_SNAPSHOT;

  constructor(private readonly getWindow: () => BrowserWindow | null) {}

  snapshot(): UpdateSnapshot {
    return this.current;
  }

  apply(event: UpdateEvent): UpdateSnapshot {
    const next = reduceUpdateSnapshot(this.current, event);
    if (next === this.current) return next;
    this.current = next;
    sendToWindow(this.getWindow(), UPDATE_STATE_CHANNEL, next);
    return next;
  }
}

/** Dev-build test hook: a JSON array of `UpdateEvent`s to replay at startup. */
export const DEV_UPDATE_EVENTS_ENV = "CADENCR_DEV_UPDATE_EVENTS";

/**
 * Dev builds have no update feed. To exercise the updater UI (and its survival
 * across renderer reloads), `CADENCR_DEV_UPDATE_EVENTS` seeds the main-process
 * state with events. Throws on a malformed value so a typo fails loudly.
 */
export function devUpdateEvents(env: NodeJS.ProcessEnv): UpdateEvent[] {
  const raw = env[DEV_UPDATE_EVENTS_ENV];
  if (!raw) return [];
  return z.array(updateEventSchema).parse(JSON.parse(raw));
}
