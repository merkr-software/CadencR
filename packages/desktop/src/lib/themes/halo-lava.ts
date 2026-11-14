/**
 * The lava-lamp simulation: blobs that rise, sink, and slide around each other.
 *
 * This is convection, not billiards. A blob travels the full height of the play
 * area in one direction, eases into a turn at the end, and comes back. When two
 * meet they separate and steer *sideways* — neither reverses, because a blob
 * that bounced back the way it came reads as a pinball, and the whole point is
 * that both keep going.
 *
 * Kept as pure math on plain numbers so it can be tested without a DOM, and so
 * the component that runs it is only a loop and four style writes. Everything
 * here is in **pixels from the viewport centre**, which is the one space where
 * a circle is a circle — the halos are positioned in percentages of two
 * different axes, and a collision test in that space would be an ellipse.
 *
 * The bodies are the halos' *centres*. A halo's visual radius is `size / 2` in
 * `vw`, but the gradient fades to nothing at 70% of that, so the collision
 * radius is a fraction of it: blobs that touch at their faint edges read as
 * passing through each other, which is what a lava lamp does.
 */

import { clamp } from "@/lib/math";

export interface LavaBody {
  /** Offset from the viewport centre, in px. */
  x: number;
  y: number;
  /** Sideways velocity, in px per second. */
  vx: number;
  /** Collision radius, in px. */
  radius: number;
  /** `-1` rising, `+1` sinking. */
  direction: number;
  /** Vertical speed multiplier, so the four never travel in lockstep. */
  rise: number;
  /** Phase of the sideways sway, in radians. */
  sway: number;
  /** How fast that phase advances, in radians per second. */
  swayRate: number;
}

export interface LavaBounds {
  /** How far a centre may stray from the viewport centre, in px. */
  halfWidth: number;
  halfHeight: number;
}

/**
 * How much of a halo's painted radius counts as solid, for collisions.
 *
 * Deliberately small. These halos are 60–70vw across, so a quarter of the
 * painted radius is already a couple of hundred pixels; anything larger and
 * every pair is permanently in contact, which pins the blobs against the edges
 * instead of letting them travel.
 */
export const LAVA_COLLISION_RATIO = 0.25;

/**
 * Ceiling on a collision radius, as a fraction of the play area's half-height.
 *
 * A theme's halos are not all the same size — Frost's top bloom is 140vw across
 * against 62–72vw for the drifting ones — and an uncapped radius would let the
 * biggest one fill the play area and shove everything else around on its own.
 */
const MAX_RADIUS_RATIO = 0.6;

/** How far a centre may stray, as a fraction of the viewport. */
export const LAVA_TRAVEL_RATIO = 0.4;

/**
 * Vertical speed per body, as a multiple of the pace.
 *
 * Four different values rather than one: identical speeds would keep the blobs
 * in the same relative order forever, and the field would read as a single
 * rigid column sliding up and down.
 */
const RISE_MULTIPLIERS = [1, 0.68, 1.22, 0.84];

/** How hard a collision steers the pair sideways, per px of overlap per second. */
const LATERAL_PUSH = 1.5;

/**
 * How fast an overlap is resolved, per second.
 *
 * Not all at once: a deep overlap corrected in a single tick is a jump, and
 * against a boundary it is a blob pinned to the edge. Half the overlap per tick
 * at 20Hz settles in a few frames and reads as the blobs sliding apart.
 */
const SEPARATION_RATE = 10;

/** Ceiling on the sideways velocity, so repeated nudges cannot run away. */
const MAX_LATERAL = 70;

/** Amplitude of the sideways sway, in px per second squared. */
const SWAY_FORCE = 9;

/** How much of the play area, at each end, is spent easing into the turn. */
const TURN_ZONE = 0.3;

/** The slowest a blob travels while it is turning, as a fraction of its pace. */
const TURN_FLOOR = 0.15;

/**
 * The starting bodies for a set of halos.
 *
 * Positions come from the theme's own composition, so switching the motion on
 * does not teleport the field. Directions come from where each halo already
 * sits — one above the middle sinks, one below it rises — which is both
 * physically sensible and enough to keep the four out of phase. The sway phase
 * is spread by the golden angle so no two paths are the same shape.
 */
export function createLavaBodies(
  halos: { size: number; x: number; y: number }[],
  viewport: { width: number; height: number },
): LavaBody[] {
  const golden = Math.PI * (3 - Math.sqrt(5));
  const bounds = lavaBounds(viewport);
  const maxRadius = bounds.halfHeight * MAX_RADIUS_RATIO;
  return halos.map((halo, index) => ({
    // Clamped to the play area: a theme may place a halo outside it (Frost's
    // top bloom sits at y=0), and starting there would snap on the first frame.
    x: clamp(((halo.x - 50) / 100) * viewport.width, -bounds.halfWidth, bounds.halfWidth),
    y: clamp(((halo.y - 50) / 100) * viewport.height, -bounds.halfHeight, bounds.halfHeight),
    vx: 0,
    radius: Math.min((halo.size / 100) * viewport.width * 0.5 * LAVA_COLLISION_RATIO, maxRadius),
    direction: halo.y > 50 ? -1 : 1,
    rise: RISE_MULTIPLIERS[index % RISE_MULTIPLIERS.length],
    sway: index * golden,
    swayRate: 0.35 + (index % 4) * 0.11,
  }));
}

/** The play area for a viewport. */
export function lavaBounds(viewport: { width: number; height: number }): LavaBounds {
  return {
    halfWidth: viewport.width * LAVA_TRAVEL_RATIO,
    halfHeight: viewport.height * LAVA_TRAVEL_RATIO,
  };
}

/**
 * One step of the simulation.
 *
 * `dt` is seconds and is expected to be small and fixed — the caller accumulates
 * real time and steps in whole ticks, so a stalled frame does not teleport the
 * blobs across the window. `speed` is the vertical pace in px per second.
 */
export function stepLava(
  bodies: LavaBody[],
  dt: number,
  bounds: LavaBounds,
  speed: number,
): LavaBody[] {
  // Mutated in place: the array belongs to the caller's loop and is never
  // shared with React, so cloning it twice a tick would buy nothing.
  for (const body of bodies) advance(body, dt, bounds, speed);
  resolveCollisions(bodies, dt);
  return bodies;
}

/** Travel one body, easing into the turn at each end. */
function advance(body: LavaBody, dt: number, bounds: LavaBounds, speed: number): void {
  const { x, y, vx, direction, rise, sway, swayRate } = body;

  // Slow down near the ends. A hard reversal at the boundary reads as a ball
  // hitting a wall; a blob that coasts to a stop and comes back reads as one
  // that cooled at the top of the lamp.
  const room = Math.max(0, bounds.halfHeight - Math.abs(y));
  const ease = TURN_FLOOR + (1 - TURN_FLOOR) * Math.min(1, room / (bounds.halfHeight * TURN_ZONE));

  let nextY = y + direction * speed * rise * ease * dt;
  let nextDirection = direction;
  if (nextY <= -bounds.halfHeight) {
    nextY = -bounds.halfHeight;
    nextDirection = 1;
  } else if (nextY >= bounds.halfHeight) {
    nextY = bounds.halfHeight;
    nextDirection = -1;
  }

  // A slow sideways sway, so no path is a straight line. It oscillates rather
  // than accumulating, which keeps a blob near the column it started in.
  const nextSway = sway + swayRate * dt;
  let nextVx = vx + Math.sin(nextSway) * SWAY_FORCE * dt;

  let nextX = x + nextVx * dt;
  if (nextX < -bounds.halfWidth) {
    nextX = -bounds.halfWidth;
    nextVx = Math.abs(nextVx);
  } else if (nextX > bounds.halfWidth) {
    nextX = bounds.halfWidth;
    nextVx = -Math.abs(nextVx);
  }

  body.x = nextX;
  body.y = nextY;
  body.vx = clamp(nextVx, -MAX_LATERAL, MAX_LATERAL);
  body.direction = nextDirection;
  body.sway = nextSway;
}

/**
 * Push overlapping pairs apart and steer them around each other.
 *
 * Only the sideways velocity moves. The vertical one is left alone on purpose:
 * two blobs that meet should slide past and carry on, not exchange momentum.
 * One pass per step, not a solver — a blob pushed into a third one is resolved
 * on the next tick, 50ms later, which is invisible at this speed.
 */
function resolveCollisions(bodies: LavaBody[], dt: number): void {
  for (let i = 0; i < bodies.length; i += 1) {
    for (let j = i + 1; j < bodies.length; j += 1) {
      const a = bodies[i];
      const b = bodies[j];
      const dx = b.x - a.x;
      const dy = b.y - a.y;
      const distance = Math.sqrt(dx * dx + dy * dy);
      const minimum = a.radius + b.radius;
      if (distance >= minimum) continue;

      // Exactly stacked blobs have no normal to work from. Pick one from the
      // pair's order, so they separate instead of sitting on top of each other
      // forever.
      const stacked = distance === 0;
      const nx = stacked ? 1 : dx / distance;
      const ny = stacked ? 0 : dy / distance;
      const overlap = stacked ? minimum / 2 : (minimum - distance) / 2;

      const separation = overlap * Math.min(1, SEPARATION_RATE * dt);
      a.x -= nx * separation;
      a.y -= ny * separation;
      b.x += nx * separation;
      b.y += ny * separation;

      // A pair stacked straight up has no side to pick either, so the order
      // breaks that tie too — otherwise they would ride on top of each other
      // the whole way up.
      const side = nx === 0 ? 1 : Math.sign(nx);
      const push = overlap * LATERAL_PUSH * dt;
      a.vx = clamp(a.vx - side * push, -MAX_LATERAL, MAX_LATERAL);
      b.vx = clamp(b.vx + side * push, -MAX_LATERAL, MAX_LATERAL);
    }
  }
}
