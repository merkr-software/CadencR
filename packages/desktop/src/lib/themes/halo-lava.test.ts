import { describe, expect, it } from "vitest";
import {
  createLavaBodies,
  lavaBounds,
  LAVA_COLLISION_RATIO,
  LAVA_TRAVEL_RATIO,
  stepLava,
  type LavaBody,
} from "./halo-lava";

const VIEWPORT = { width: 1000, height: 800 };
const BOUNDS = lavaBounds(VIEWPORT);
const SPEED = 20;

function body(patch: Partial<LavaBody> = {}): LavaBody {
  return {
    x: 0,
    y: 0,
    vx: 0,
    radius: 50,
    direction: -1,
    rise: 1,
    sway: 0,
    swayRate: 0,
    ...patch,
  };
}

/** Run the simulation for `seconds` at the caller's tick rate. */
function run(bodies: LavaBody[], seconds: number, dt = 1 / 20): LavaBody[] {
  let current = bodies;
  for (let elapsed = 0; elapsed < seconds; elapsed += dt) {
    current = stepLava(current, dt, BOUNDS, SPEED);
  }
  return current;
}

describe("createLavaBodies", () => {
  it("starts every blob where the theme put it", () => {
    const bodies = createLavaBodies(
      [
        { size: 72, x: 28, y: 32 },
        { size: 66, x: 79, y: 61 },
      ],
      VIEWPORT,
    );

    // (28%, 32%) is 22% left of and 18% above centre.
    expect(bodies[0].x).toBeCloseTo(-220, 5);
    expect(bodies[0].y).toBeCloseTo(-144, 5);
    expect(bodies[1].x).toBeCloseTo(290, 5);
    expect(bodies[1].y).toBeCloseTo(88, 5);
  });

  it("sizes the collision radius from the halo's painted size", () => {
    const [first] = createLavaBodies([{ size: 72, x: 50, y: 50 }], VIEWPORT);
    // 72vw across a 1000px viewport is 720px, so 360px of radius, of which the
    // solid core is a fraction.
    expect(first.radius).toBeCloseTo(360 * LAVA_COLLISION_RATIO, 5);
  });

  it("sends a halo above the middle down and one below it up", () => {
    const bodies = createLavaBodies(
      [
        { size: 60, x: 50, y: 20 },
        { size: 60, x: 50, y: 80 },
      ],
      VIEWPORT,
    );
    expect(bodies[0].direction).toBe(1);
    expect(bodies[1].direction).toBe(-1);
  });

  it("gives the four different vertical paces and sway phases", () => {
    const bodies = createLavaBodies(
      [0, 1, 2, 3].map(() => ({ size: 60, x: 50, y: 50 })),
      VIEWPORT,
    );
    expect(new Set(bodies.map((b) => b.rise)).size).toBe(4);
    expect(new Set(bodies.map((b) => b.sway.toFixed(4))).size).toBe(4);
  });
});

describe("lavaBounds", () => {
  it("lets a centre stray a fraction of the viewport from the middle", () => {
    expect(BOUNDS.halfWidth).toBeCloseTo(VIEWPORT.width * LAVA_TRAVEL_RATIO, 5);
    expect(BOUNDS.halfHeight).toBeCloseTo(VIEWPORT.height * LAVA_TRAVEL_RATIO, 5);
  });
});

describe("rising and sinking", () => {
  it("carries a rising blob upward", () => {
    const [moved] = stepLava([body({ direction: -1 })], 0.5, BOUNDS, SPEED);
    expect(moved.y).toBeLessThan(0);
  });

  it("carries a sinking blob downward", () => {
    const [moved] = stepLava([body({ direction: 1 })], 0.5, BOUNDS, SPEED);
    expect(moved.y).toBeGreaterThan(0);
  });

  it("turns a blob around at the top and sends it back down", () => {
    const [moved] = stepLava(
      [body({ y: -BOUNDS.halfHeight + 1, direction: -1 })],
      0.5,
      BOUNDS,
      SPEED,
    );
    expect(moved.y).toBeCloseTo(-BOUNDS.halfHeight, 5);
    expect(moved.direction).toBe(1);
  });

  it("turns a blob around at the bottom and sends it back up", () => {
    const [moved] = stepLava(
      [body({ y: BOUNDS.halfHeight - 1, direction: 1 })],
      0.5,
      BOUNDS,
      SPEED,
    );
    expect(moved.y).toBeCloseTo(BOUNDS.halfHeight, 5);
    expect(moved.direction).toBe(-1);
  });

  it("eases into the turn instead of hitting the end at full speed", () => {
    const middle = stepLava([body({ y: 0, direction: -1 })], 0.5, BOUNDS, SPEED)[0];
    const nearEnd = stepLava(
      [body({ y: -BOUNDS.halfHeight + 2, direction: -1 })],
      0.5,
      BOUNDS,
      SPEED,
    )[0];

    const middleTravel = Math.abs(middle.y - 0);
    const endTravel = Math.abs(nearEnd.y - (-BOUNDS.halfHeight + 2));
    expect(endTravel).toBeLessThan(middleTravel);
  });

  it("travels the whole height in a time that reads as slow", () => {
    // A full traverse at the default pace should take tens of seconds, not
    // seconds: this is a lava lamp, not a screensaver.
    const start = body({ y: BOUNDS.halfHeight, direction: -1 });
    const after = run([start], 20)[0];
    expect(after.y).toBeLessThan(BOUNDS.halfHeight);
    expect(after.y).toBeGreaterThan(-BOUNDS.halfHeight);
  });

  it("gives the four different travel times", () => {
    const bodies = createLavaBodies(
      [0, 1, 2, 3].map(() => ({ size: 60, x: 50, y: 50 })),
      VIEWPORT,
    );
    const travelled = run(bodies, 5).map((b) => Math.abs(b.y));
    expect(new Set(travelled.map((y) => y.toFixed(1))).size).toBeGreaterThan(1);
  });
});

describe("collisions", () => {
  it("slides two overlapping blobs apart over a few ticks", () => {
    // They start 20px apart with 100px of combined radius. The overlap is
    // resolved at a rate rather than in one jump, so it takes a moment.
    const [a, b] = run([body({ x: -10, radius: 50 }), body({ x: 10, radius: 50 })], 1);
    // They end up clear of each other, and keep drifting apart: the sideways
    // nudge is a velocity, not a one-off displacement.
    expect(b.x - a.x).toBeGreaterThanOrEqual(100);
  });

  it("steers the pair sideways rather than reversing them", () => {
    const [a, b] = stepLava(
      [body({ x: -10, radius: 50 }), body({ x: 10, radius: 50 })],
      0.05,
      BOUNDS,
      SPEED,
    );
    // Each is pushed away from the other, and neither changes direction.
    expect(a.vx).toBeLessThan(0);
    expect(b.vx).toBeGreaterThan(0);
    expect(a.direction).toBe(-1);
    expect(b.direction).toBe(-1);
  });

  it("keeps both blobs travelling the way they were going", () => {
    const before = [body({ x: -10, y: 0, radius: 50 }), body({ x: 10, y: 0, radius: 50 })];
    const after = run(before, 1);
    // Both were rising; a bounce would have sent one back down.
    expect(after[0].y).toBeLessThan(0);
    expect(after[1].y).toBeLessThan(0);
  });

  it("does not touch blobs that are not touching", () => {
    const [a, b] = stepLava(
      [body({ x: -500, vx: 10 }), body({ x: 500, vx: -10 })],
      0,
      BOUNDS,
      SPEED,
    );
    expect(a.vx).toBe(10);
    expect(b.vx).toBe(-10);
  });

  it("breaks the tie when two blobs land on the exact same point", () => {
    const [a, b] = stepLava([body({ x: 0 }), body({ x: 0 })], 0.05, BOUNDS, SPEED);
    expect(Number.isFinite(a.x)).toBe(true);
    expect(Number.isFinite(b.x)).toBe(true);
    expect(a.vx).not.toBe(b.vx);
  });

  it("keeps the sideways velocity bounded however long it runs", () => {
    let bodies = createLavaBodies(
      [
        { size: 72, x: 28, y: 32 },
        { size: 66, x: 79, y: 61 },
        { size: 62, x: 49, y: 86 },
        { size: 60, x: 50, y: 50 },
      ],
      VIEWPORT,
    );
    for (let tick = 0; tick < 4000; tick += 1) {
      bodies = stepLava(bodies, 1 / 20, BOUNDS, SPEED);
    }
    for (const b of bodies) {
      expect(Number.isFinite(b.x)).toBe(true);
      expect(Number.isFinite(b.y)).toBe(true);
      expect(Math.abs(b.x)).toBeLessThanOrEqual(BOUNDS.halfWidth + 1);
      expect(Math.abs(b.y)).toBeLessThanOrEqual(BOUNDS.halfHeight + 1);
      expect(Math.abs(b.vx)).toBeLessThanOrEqual(70);
    }
  });
});
