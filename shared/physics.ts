// Movement and line of fire, shared by the server (which decides) and the
// browser (which predicts its own movement with the very same function, so
// a replay of unacknowledged inputs lands exactly where the server will).
// Pure functions over plain numbers; no allocation in the hot paths beyond
// small return tuples.
import { ACCEL, BODY_CROUCH, BODY_STAND, CROUCH_MULT, EYE_CROUCH, EYE_STAND, HEAD_R, RADIUS, TICK_S, WALK_MULT } from "./content.ts";
import { CELL, MAP, boxAtCell, type Box, type GameMap } from "./map.ts";

export interface Body {
  x: number;
  z: number;
  vx: number;
  vz: number;
}

/** Facing as a unit vector. yaw 0 looks north (-z); positive yaw turns left, as three.js does. */
export function aimDir(yaw: number, pitch: number): [number, number, number] {
  const c = Math.cos(pitch);
  return [-Math.sin(yaw) * c, Math.sin(pitch), -Math.cos(yaw) * c];
}

/** The velocity a player wants from forward/right input at a given top speed. */
export function wishVelocity(f: number, r: number, yaw: number, speed: number): [number, number] {
  const fx = -Math.sin(yaw);
  const fz = -Math.cos(yaw);
  const rx = Math.cos(yaw);
  const rz = -Math.sin(yaw);
  let wx = fx * f + rx * r;
  let wz = fz * f + rz * r;
  const len = Math.hypot(wx, wz);
  if (len > 0) {
    wx = (wx / len) * speed;
    wz = (wz / len) * speed;
  }
  return [wx, wz];
}

export const topSpeed = (weaponSpeed: number, crouch: boolean, walk: boolean): number =>
  weaponSpeed * (crouch ? CROUCH_MULT : walk ? WALK_MULT : 1);

function overlaps(x: number, z: number, b: Box): boolean {
  return x + RADIUS > b.x0 && x - RADIUS < b.x1 && z + RADIUS > b.z0 && z - RADIUS < b.z1;
}

/** Every box near a point: the 3×3 cells around it. */
function nearby(x: number, z: number, map: GameMap, out: Box[]): Box[] {
  out.length = 0;
  const c = Math.floor(x / CELL);
  const r = Math.floor(z / CELL);
  for (let dr = -1; dr <= 1; dr++)
    for (let dc = -1; dc <= 1; dc++) {
      const b = boxAtCell(c + dc, r + dr, map);
      if (b) out.push(b);
    }
  return out;
}
const scratch: Box[] = [];

/**
 * One tick of movement. The body is a square of half-width RADIUS, moved one
 * axis at a time and stopped flush against whatever it meets, so it slides
 * along walls and can't tunnel (a tick moves at most ~0.2 m, far less than a
 * cell). Players don't block each other.
 */
export function step(b: Body, wish: [number, number], dt = TICK_S, map: GameMap = MAP): void {
  const maxDv = ACCEL * dt;
  const dvx = wish[0] - b.vx;
  const dvz = wish[1] - b.vz;
  const dv = Math.hypot(dvx, dvz);
  if (dv <= maxDv) {
    b.vx = wish[0];
    b.vz = wish[1];
  } else {
    b.vx += (dvx / dv) * maxDv;
    b.vz += (dvz / dv) * maxDv;
  }
  if (Math.abs(b.vx) < 1e-4) b.vx = 0;
  if (Math.abs(b.vz) < 1e-4) b.vz = 0;

  let nx = b.x + b.vx * dt;
  for (const box of nearby(nx, b.z, map, scratch)) {
    if (!overlaps(nx, b.z, box)) continue;
    nx = b.vx > 0 ? box.x0 - RADIUS - 1e-6 : box.x1 + RADIUS + 1e-6;
    b.vx = 0;
  }
  b.x = nx;
  let nz = b.z + b.vz * dt;
  for (const box of nearby(b.x, nz, map, scratch)) {
    if (!overlaps(b.x, nz, box)) continue;
    nz = b.vz > 0 ? box.z0 - RADIUS - 1e-6 : box.z1 + RADIUS + 1e-6;
    b.vz = 0;
  }
  b.z = nz;
  // round so a saved and reloaded state (JSON) continues bit-for-bit, and prediction agrees with the server
  b.x = Math.round(b.x * 1e4) / 1e4;
  b.z = Math.round(b.z * 1e4) / 1e4;
  b.vx = Math.round(b.vx * 1e4) / 1e4;
  b.vz = Math.round(b.vz * 1e4) / 1e4;
}

export const eyeHeight = (crouch: boolean): number => (crouch ? EYE_CROUCH : EYE_STAND);
export const bodyTop = (crouch: boolean): number => (crouch ? BODY_CROUCH : BODY_STAND);

/** Ray against an axis-aligned box (slab method): entry distance, or Infinity. */
export function rayBox(o: readonly number[], d: readonly number[], b: Box): number {
  let t0 = 0;
  let t1 = Infinity;
  const lo = [b.x0, b.y0, b.z0];
  const hi = [b.x1, b.y1, b.z1];
  for (let i = 0; i < 3; i++) {
    if (Math.abs(d[i]) < 1e-9) {
      if (o[i] < lo[i] || o[i] > hi[i]) return Infinity;
      continue;
    }
    let a = (lo[i] - o[i]) / d[i];
    let c = (hi[i] - o[i]) / d[i];
    if (a > c) [a, c] = [c, a];
    t0 = Math.max(t0, a);
    t1 = Math.min(t1, c);
    if (t0 > t1) return Infinity;
  }
  return t0;
}

/**
 * How far a ray travels before it meets the map: walls, crates, or leaving
 * the map's height. Walks the grid cell by cell (Amanatides and Woo), so it
 * only tests the boxes on its path.
 */
export function rayMap(o: readonly number[], d: readonly number[], maxT: number, map: GameMap = MAP): number {
  // the floor
  let limit = maxT;
  if (d[1] < 0) limit = Math.min(limit, -o[1] / d[1]);
  let c = Math.floor(o[0] / CELL);
  let r = Math.floor(o[2] / CELL);
  const sc = d[0] > 0 ? 1 : -1;
  const sr = d[2] > 0 ? 1 : -1;
  const tdc = Math.abs(d[0]) < 1e-9 ? Infinity : CELL / Math.abs(d[0]);
  const tdr = Math.abs(d[2]) < 1e-9 ? Infinity : CELL / Math.abs(d[2]);
  let tc = Math.abs(d[0]) < 1e-9 ? Infinity : ((d[0] > 0 ? (c + 1) * CELL : c * CELL) - o[0]) / d[0];
  let tr = Math.abs(d[2]) < 1e-9 ? Infinity : ((d[2] > 0 ? (r + 1) * CELL : r * CELL) - o[2]) / d[2];
  let t = 0;
  while (t <= limit) {
    if (c < 0 || r < 0 || c >= map.cols || r >= map.rows) return Math.min(t, limit);
    const b = boxAtCell(c, r, map);
    if (b) {
      const hit = rayBox(o, d, b);
      if (hit <= limit) return hit;
    }
    if (tc < tr) {
      t = tc;
      tc += tdc;
      c += sc;
    } else {
      t = tr;
      tr += tdr;
      r += sr;
    }
  }
  return limit;
}

/** Can an eye at `a` see a point at `b`? */
export function clearLine(a: readonly number[], b: readonly number[], map: GameMap = MAP): boolean {
  const d = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
  const len = Math.hypot(d[0], d[1], d[2]);
  if (len < 1e-6) return true;
  const u = [d[0] / len, d[1] / len, d[2] / len];
  return rayMap(a, u, len, map) >= len - 1e-3;
}

export type HitZone = "head" | "body" | "legs";

/**
 * A ray against one player's hitbox at a given position: a vertical cylinder
 * for the body (and legs below LEG_TOP) and a sphere for the head. Returns
 * the distance and zone, or null.
 */
export function rayPlayer(o: readonly number[], d: readonly number[], x: number, z: number, crouch: boolean, legTop: number): { t: number; zone: HitZone } | null {
  let best: { t: number; zone: HitZone } | null = null;
  // head sphere
  const top = bodyTop(crouch);
  const hy = top + HEAD_R * 0.9;
  const ox = o[0] - x;
  const oy = o[1] - hy;
  const oz = o[2] - z;
  const bq = ox * d[0] + oy * d[1] + oz * d[2];
  const cq = ox * ox + oy * oy + oz * oz - HEAD_R * HEAD_R;
  const disc = bq * bq - cq;
  if (disc >= 0) {
    const t = -bq - Math.sqrt(disc);
    if (t >= 0) best = { t, zone: "head" };
  }
  // body cylinder, radius a little under the movement square
  const R = RADIUS * 0.9;
  const a = d[0] * d[0] + d[2] * d[2];
  if (a > 1e-9) {
    const b2 = ox * d[0] + oz * d[2];
    const c2 = ox * ox + oz * oz - R * R;
    const disc2 = b2 * b2 - a * c2;
    if (disc2 >= 0) {
      const sq = Math.sqrt(disc2);
      for (const t of [(-b2 - sq) / a, (-b2 + sq) / a]) {
        if (t < 0) continue;
        const y = o[1] + d[1] * t;
        if (y >= 0 && y <= top) {
          if (!best || t < best.t) best = { t, zone: y < legTop ? "legs" : "body" };
          break;
        }
      }
    }
  }
  return best;
}
