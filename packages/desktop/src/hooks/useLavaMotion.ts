import { useEffect, useMemo, useRef } from "react";
import { animationsDisabled } from "@/lib/animations/animations-disabled";
import type { ThemeHalo } from "@/lib/themes/chrome";
import { createLavaBodies, lavaBounds, stepLava, type LavaBody } from "@/lib/themes/halo-lava";

/**
 * The one place in the ambient layer that runs JavaScript per frame.
 *
 * The other two motions are CSS: `orbit` turns a box, `glow` pulses an opacity,
 * and both are compositor work the browser schedules for us. Blobs that slide
 * around each other cannot be a keyframe, so `lava` simulates and writes a
 * `transform` per halo — the cheapest property to write, and the only one that
 * does not force layout.
 *
 * Four things keep the cost bounded:
 *
 * - **20 steps a second, not 60.** The blobs are 60–70vw soft fields moving at
 *   a few `vw` per second; 20Hz is indistinguishable from 60Hz at that speed
 *   and a third of the writes. A frame that ran no step writes nothing.
 * - **The loop stops, it does not idle.** While `data-ambient-paused` is set
 *   (window hidden or unfocused) or the motion kill-switch is on, no frame is
 *   requested at all; a `MutationObserver` on `<html>` restarts it. A loop that
 *   kept waking every vsync to check would defeat the point of the pause.
 * - **No React state.** The loop writes `style.transform` on the nodes it
 *   captured; a per-frame `setState` would re-render the whole layer tree.
 * - **Seeded once per composition.** The simulation starts from the theme's own
 *   layout, so switching the motion on does not teleport the field, and it is
 *   re-seeded only when that layout changes — not when the user drags intensity
 *   or a colour, which would snap every blob back to its start.
 */
export function useLavaMotion(
  containerRef: React.RefObject<HTMLDivElement | null>,
  halos: ThemeHalo[],
  /** Travel speed in `vw` per second, or `null` when the field is not lava. */
  speed: number | null,
): void {
  // Read through refs so a pace change lands on the next tick without
  // restarting the simulation and losing where the blobs are.
  const speedRef = useRef(speed ?? 0);
  const halosRef = useRef(halos);
  useEffect(() => {
    if (speed !== null) speedRef.current = speed;
    halosRef.current = halos;
  }, [speed, halos]);

  // The geometry, not the whole halo: intensity and colour change the array on
  // every slider move, and re-seeding on those would reset the motion.
  const geometryKey = useMemo(
    () => halos.map((halo) => `${halo.size}:${halo.x}:${halo.y}`).join("|"),
    [halos],
  );

  const enabled = speed !== null;

  useEffect(() => {
    if (!enabled) return;
    const container = containerRef.current;
    if (!container) return;
    const nodes = Array.from(container.querySelectorAll<HTMLElement>(".halo"));
    if (nodes.length === 0) return;

    let viewport = { width: window.innerWidth, height: window.innerHeight };
    let bounds = lavaBounds(viewport);
    let bodies: LavaBody[] = createLavaBodies(halosRef.current, viewport);

    const reseed = (): void => {
      viewport = { width: window.innerWidth, height: window.innerHeight };
      bounds = lavaBounds(viewport);
      bodies = createLavaBodies(halosRef.current, viewport);
    };
    window.addEventListener("resize", reseed);

    let frame = 0;
    let observer: MutationObserver | null = null;
    let last = performance.now();
    let accumulator = 0;

    const paused = (): boolean =>
      document.documentElement.hasAttribute("data-ambient-paused") || animationsDisabled();

    const tick = (now: number): void => {
      const elapsed = Math.min((now - last) / 1000, 0.25);
      last = now;

      if (paused()) {
        // Stop requesting frames entirely, and wait for the attribute to clear.
        observer = new MutationObserver(() => {
          if (paused()) return;
          observer?.disconnect();
          observer = null;
          last = performance.now();
          frame = requestAnimationFrame(tick);
        });
        observer.observe(document.documentElement, {
          attributes: true,
          attributeFilter: ["data-ambient-paused", "data-animations"],
        });
        return;
      }

      const pace = (speedRef.current / 100) * viewport.width;
      accumulator += elapsed;
      let stepped = false;
      while (accumulator >= LAVA_STEP_SECONDS) {
        stepLava(bodies, LAVA_STEP_SECONDS, bounds, pace);
        accumulator -= LAVA_STEP_SECONDS;
        stepped = true;
      }

      // Only touch the DOM on a frame that actually moved something: at 20Hz
      // against a 60Hz display, two frames in three would rewrite the same
      // string.
      if (stepped) {
        for (let index = 0; index < bodies.length; index += 1) {
          const body = bodies[index];
          nodes[index].style.transform = `translate3d(${body.x}px, ${body.y}px, 0)`;
        }
      }

      frame = requestAnimationFrame(tick);
    };

    frame = requestAnimationFrame(tick);
    return () => {
      cancelAnimationFrame(frame);
      observer?.disconnect();
      window.removeEventListener("resize", reseed);
      // Hand the halos back to their theme positions, so leaving lava mode does
      // not leave them parked wherever the simulation stopped.
      for (const node of nodes) node.style.transform = "";
    };
  }, [containerRef, enabled, geometryKey]);
}

/** Simulation tick. See the note on 20Hz above. */
const LAVA_STEP_SECONDS = 1 / 20;
