import path from "node:path";
import { fileURLToPath } from "node:url";

export type RendererTarget = { kind: "url" | "file"; value: string };

/** A renderer capability belongs to one document origin, never to all loopback/file URLs. */
export function matchesRendererTarget(rawUrl: string, target: RendererTarget): boolean {
  try {
    const url = new URL(rawUrl);
    if (url.username || url.password) return false;
    if (target.kind === "url") {
      const expected = new URL(target.value);
      return url.protocol === "http:" && url.origin === expected.origin;
    }
    return (
      url.protocol === "file:" &&
      !url.hostname &&
      path.resolve(fileURLToPath(url)) === path.resolve(target.value)
    );
  } catch {
    return false;
  }
}

export interface RendererFrame {
  processId: number;
  routingId: number;
  url: string;
}

export function isMainRendererFrame(
  frame: RendererFrame | null | undefined,
  mainFrame: RendererFrame,
  target: RendererTarget,
): boolean {
  return (
    frame != null &&
    frame.processId === mainFrame.processId &&
    frame.routingId === mainFrame.routingId &&
    matchesRendererTarget(frame.url, target) &&
    matchesRendererTarget(mainFrame.url, target)
  );
}
