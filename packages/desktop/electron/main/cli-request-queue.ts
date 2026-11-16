import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import type { CliRendererItem } from "../../src/shared/cli-bridge";
import { parseCliRequestArgv } from "./cli-request";

/** At most this many unhandled requests wait for the renderer; older ones drop. */
const MAX_PENDING = 32;

type CliRendererItemInput =
  | Omit<Extract<CliRendererItem, { kind: "open" }>, "id">
  | Omit<Extract<CliRendererItem, { kind: "add" }>, "id">
  | Omit<Extract<CliRendererItem, { kind: "error" }>, "id">
  | Omit<Extract<CliRendererItem, { kind: "update" }>, "id">;

/**
 * Requests waiting for the renderer. Main pushes and pings; the renderer pulls
 * (on mount, then on each ping), so a request that arrives before the window
 * has loaded is never lost and none is delivered twice.
 */
export class CliRequestQueue {
  private items: CliRendererItem[] = [];
  /** Requests dropped since the last drain, reported with the next one. */
  private dropped = 0;

  constructor(private readonly notify: () => void) {}

  push(item: CliRendererItemInput): void {
    this.items.push({ ...item, id: randomUUID() });
    if (this.items.length > MAX_PENDING) {
      const excess = this.items.length - MAX_PENDING;
      this.items = this.items.slice(excess);
      this.dropped += excess;
      console.warn(`[cli] dropped ${excess} unhandled cadencr command request(s)`);
    }
    this.notify();
  }

  drain(): CliRendererItem[] {
    const items = this.items;
    this.items = [];
    if (this.dropped === 0) return items;
    const dropped = this.dropped;
    this.dropped = 0;
    const message = `Cadencr skipped the ${dropped} oldest cadencr command request(s): more than ${MAX_PENDING} arrived before it could act on them.`;
    return [{ kind: "error", id: randomUUID(), message }, ...items];
  }
}

type PathKind = "file" | "directory";

async function statPathKind(target: string): Promise<PathKind | { error: string }> {
  try {
    const stats = await fs.stat(target);
    if (stats.isDirectory()) return "directory";
    if (stats.isFile()) return "file";
    return { error: `${target} is neither a file nor a folder.` };
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    return { error: `Cadencr could not read ${target}: ${detail}` };
  }
}

/**
 * Acts on the `cadencr` command's request in `argv`, if there is one. Returns
 * whether a request was present, so the caller knows to bring the app forward.
 */
export async function handleCliArgv(
  argv: readonly string[],
  queue: CliRequestQueue,
): Promise<boolean> {
  const parsed = parseCliRequestArgv(argv);
  if (!parsed) return false;
  if (!parsed.ok) {
    console.warn(`[cli] ${parsed.message}`);
    queue.push({ kind: "error", message: parsed.message });
    return true;
  }
  const { request } = parsed;
  switch (request.action) {
    case "focus":
      return true;
    case "update":
      // Through the renderer, which runs the "Check for updates" button's path
      // once it listens: a check started before it does would go unseen.
      queue.push({ kind: "update" });
      return true;
    case "open": {
      const kind = await statPathKind(request.path);
      if (typeof kind === "object") queue.push({ kind: "error", message: kind.error });
      else queue.push({ kind: "open", path: request.path, pathKind: kind, line: request.line });
      return true;
    }
    case "add": {
      const kind = await statPathKind(request.path);
      if (typeof kind === "object") queue.push({ kind: "error", message: kind.error });
      else if (kind !== "directory")
        queue.push({ kind: "error", message: `${request.path} is not a folder.` });
      else queue.push({ kind: "add", path: request.path });
      return true;
    }
  }
}
