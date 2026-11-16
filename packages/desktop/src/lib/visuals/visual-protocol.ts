import { z } from "zod";

import { resolveApiBaseUrlSync } from "@/api/client";
import { VISUAL_FRAME_PATH } from "@/shared/visual-frame";

/**
 * Messages between the renderer and the sandboxed visual shell the service
 * serves at `/visual-frame` (`domain::visual_frame`, whose bootstrap speaks
 * the `ready`/`render` half), plus the bridge script written into each visual.
 */
export const VISUAL_MESSAGE = {
  render: "cadencr-visual:render",
  ready: "cadencr-visual:ready",
  size: "cadencr-visual:size",
  error: "cadencr-visual:error",
} as const;

/** Longest error text a visual may report. */
export const MAX_VISUAL_ERROR_LENGTH = 2000;

const visualFrameMessageSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal(VISUAL_MESSAGE.ready) }),
  z.object({ type: z.literal(VISUAL_MESSAGE.size), height: z.number().finite().nonnegative() }),
  z.object({
    type: z.literal(VISUAL_MESSAGE.error),
    message: z.string().max(MAX_VISUAL_ERROR_LENGTH),
  }),
]);

export type VisualFrameMessage = z.infer<typeof visualFrameMessageSchema>;

/** A frame's message, or `null` for anything else posted to the window. */
export function parseVisualFrameMessage(data: unknown): VisualFrameMessage | null {
  const parsed = visualFrameMessageSchema.safeParse(data);
  return parsed.success ? parsed.data : null;
}

/**
 * The shell's URL on the service the renderer talks to: the sidecar on
 * desktop, the page's own origin on a remote device (and Vite's pass-through
 * proxy in a development browser).
 */
export function visualFrameSrc(): string {
  return new URL(VISUAL_FRAME_PATH, resolveApiBaseUrlSync()).toString();
}
