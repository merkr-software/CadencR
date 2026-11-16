import type { SessionControls } from "@/components/WebSocketSessionControls";

type EffortControls = Pick<SessionControls, "supportsConfigInheritance"> & {
  ws: Pick<SessionControls["ws"], "queueRuntimeOverride" | "setThinkingEffort">;
};

/**
 * The one path for a thinking-effort change, from the composer control or the
 * shortcut. A provider whose effort is a runtime override (Codex) gets
 * `runtime_overrides.set`; sending it `effort.set` would persist a second,
 * diverging effort. Both go through the session command queue.
 */
export function applyThinkingEffort(controls: EffortControls, effort: string | undefined): void {
  if (controls.supportsConfigInheritance) {
    controls.ws.queueRuntimeOverride({ thinking_effort: effort ?? null });
  } else {
    controls.ws.setThinkingEffort(effort);
  }
}
