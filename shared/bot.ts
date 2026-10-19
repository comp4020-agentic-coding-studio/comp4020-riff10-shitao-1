// Bots: seat-fillers that move, shoot back, and play the bomb, so a room is
// playable and testable by one person. A bot is just another producer of
// Inputs: it reads the same state everyone sees and the server applies what
// it decides through applyInput, exactly as for a human. It gets no special
// knowledge (it only reacts to enemies in its line of sight) and is held
// back by a reaction delay and aim error so a person can beat it.
import { WEAPONS, inaccuracy, type BuyItem } from "./content.ts";
import { CELL, MAP, walkable, type SiteId } from "./map.ts";
import { bodyTop, clearLine, eyeHeight } from "./physics.ts";
import { CROUCH, FIRE, USE, WALK, type Input, type Player, type RoomState } from "./protocol.ts";
import { buyOpen, playerSide, price, rand, weaponInHand } from "./sim.ts";

export interface BotMem {
  seq: number;
  site: SiteId;
  /** the enemy it's reacting to, and since which tick it has seen them */
  target?: string;
  seenAt?: number;
  /** a slowly wandering aim error, radians */
  ex?: number;
  ey?: number;
  path?: number[];
  goal?: number;
  /** after a burst, hold fire until this tick */
  holdUntil?: number;
  round?: number;
  /** an enemy it has stopped trading long-range shots with, until a tick */
  ignore?: string;
  ignoreUntil?: number;
}

const REACT_TICKS = 11;
const STANDOFF_TICKS = 32 * 4;
const SIGHT = 45;
const cellOf = (x: number, z: number): number => Math.floor(z / CELL) * MAP.cols + Math.floor(x / CELL);
const centre = (i: number): [number, number] => [((i % MAP.cols) + 0.5) * CELL, (Math.floor(i / MAP.cols) + 0.5) * CELL];

/** Breadth-first path over walkable cells; diagonals only where both sides are open, so a body never clips a corner. */
export function path(from: number, to: number): number[] {
  if (from === to) return [to];
  const prev = new Int32Array(MAP.cols * MAP.rows).fill(-1);
  prev[from] = from;
  const q = [from];
  for (let h = 0; h < q.length; h++) {
    const i = q[h];
    if (i === to) break;
    const c = i % MAP.cols;
    const r = Math.floor(i / MAP.cols);
    for (const [dc, dr] of [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [1, -1], [-1, 1], [-1, -1]]) {
      const nc = c + dc;
      const nr = r + dr;
      if (!walkable(nc, nr)) continue;
      if (dc && dr && (!walkable(c + dc, r) || !walkable(c, r + dr))) continue;
      const n = nr * MAP.cols + nc;
      if (prev[n] >= 0) continue;
      prev[n] = i;
      q.push(n);
    }
  }
  if (prev[to] < 0) return [];
  const out: number[] = [];
  for (let i = to; i !== from; i = prev[i]) out.push(i);
  return out.reverse();
}

const yawTo = (dx: number, dz: number): number => Math.atan2(-dx, -dz);

/** A cell inside a site to hold or plant on, varied per bot so they don't stack. */
function siteCell(site: SiteId, p: Player): number {
  const r = MAP.sites[site];
  const cells: number[] = [];
  for (let z = r.z0 + CELL / 2; z < r.z1; z += CELL)
    for (let x = r.x0 + CELL / 2; x < r.x1; x += CELL) {
      const i = cellOf(x, z);
      if (walkable(i % MAP.cols, Math.floor(i / MAP.cols))) cells.push(i);
    }
  let h = 0;
  for (const ch of p.id) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return cells[h % cells.length];
}

function goalFor(s: RoomState, p: Player, mem: BotMem): { cell: number; use: boolean } | null {
  const side = playerSide(s, p);
  const b = s.bomb;
  if (side === "T") {
    if (b.k === "carried" && b.by === p.id) {
      const cell = siteCell(mem.site, p);
      const inSite = cellOf(p.x, p.z) === cell || (MAP.sites[mem.site] && p.x >= MAP.sites[mem.site].x0 && p.x <= MAP.sites[mem.site].x1 && p.z >= MAP.sites[mem.site].z0 && p.z <= MAP.sites[mem.site].z1);
      return { cell, use: !!inSite && cellOf(p.x, p.z) === cell };
    }
    if (b.k === "dropped") return { cell: cellOf(b.x, b.z), use: false };
    if (b.k === "planted") return { cell: siteCell(b.site, p), use: false };
    return { cell: siteCell(mem.site, p), use: false };
  }
  if (b.k === "planted") return { cell: cellOf(b.x, b.z), use: Math.hypot(b.x - p.x, b.z - p.z) < 1.2 };
  return { cell: siteCell(mem.site, p), use: false };
}

/** The input a bot sends this tick. */
export function botInput(s: RoomState, p: Player, mem: BotMem): Input {
  mem.seq = (mem.seq ?? 0) + 1;
  const base: Input = { s: mem.seq, f: 0, r: 0, yaw: p.yaw, pitch: 0, b: 0, vt: s.tick };
  if (!p.alive || s.phase.k === "freeze" || s.phase.k === "halftime" || s.phase.k === "ended") return base;
  if (mem.round !== s.round) {
    mem.round = s.round;
    mem.site = rand(s) < 0.5 ? "A" : "B";
    mem.path = undefined;
    mem.goal = undefined;
  }
  const eye = [p.x, eyeHeight(p.crouch), p.z];
  // the nearest enemy it can actually see
  let seen: Player | null = null;
  let best = SIGHT;
  for (const q of Object.values(s.players)) {
    if (!q.alive || q.team === p.team || q.team === null) continue;
    if (q.id === mem.ignore && s.tick < (mem.ignoreUntil ?? 0)) continue;
    const d = Math.hypot(q.x - p.x, q.z - p.z);
    if (d >= best) continue;
    if (!clearLine(eye, [q.x, eyeHeight(q.crouch) - 0.15, q.z])) continue;
    seen = q;
    best = d;
  }
  if (seen) {
    if (mem.target !== seen.id) {
      mem.target = seen.id;
      mem.seenAt = s.tick;
      mem.ex = (rand(s) - 0.5) * 0.16;
      mem.ey = (rand(s) - 0.5) * 0.1;
    }
    // aim error settles over about a second of tracking
    const settle = Math.min(1, (s.tick - (mem.seenAt ?? s.tick)) / 32);
    mem.ex = (mem.ex ?? 0) * 0.97 + (rand(s) - 0.5) * 0.006;
    mem.ey = (mem.ey ?? 0) * 0.97 + (rand(s) - 0.5) * 0.004;
    const err = 1 - 0.75 * settle;
    const dx = seen.x - p.x;
    const dz = seen.z - p.z;
    // centre mass, as most players aim; headshots come from the error, not the intent
    const ty = bodyTop(seen.crouch) * 0.7 - eye[1];
    const yaw = yawTo(dx, dz) + (mem.ex ?? 0) * err;
    const pitch = Math.atan2(ty, Math.hypot(dx, dz)) + (mem.ey ?? 0) * err;
    const ready = s.tick - (mem.seenAt ?? s.tick) >= REACT_TICKS;
    const w = WEAPONS[weaponInHand(p)];
    // stop to shoot, as a person counter-strafing would; tap at range, spray up close
    const still = Math.hypot(p.vx, p.vz);
    const accurate = inaccuracy(w, still, false) < 0.02 || best < 8;
    const burst = best < 10 ? 8 : 3;
    let b = best > 18 ? CROUCH : 0;
    // a semi-automatic needs the trigger let go between shots, as a person's finger does
    const trigger = w.auto || !(p.lastB & FIRE);
    if (ready && accurate && trigger && s.tick >= (mem.holdUntil ?? 0) && s.phase.k !== "over") {
      b |= FIRE;
      if (p.spray >= burst) mem.holdUntil = s.tick + 8;
    }
    // a long-range standoff that isn't going anywhere: give up on it and keep moving
    if (s.tick - (mem.seenAt ?? s.tick) > STANDOFF_TICKS && best > 20) {
      mem.ignore = seen.id;
      mem.ignoreUntil = s.tick + STANDOFF_TICKS;
    }
    return { ...base, yaw: ((yaw % (Math.PI * 2)) + Math.PI * 2) % (Math.PI * 2), pitch, b };
  }
  mem.target = undefined;
  const goal = goalFor(s, p, mem);
  if (!goal) return base;
  const here = cellOf(p.x, p.z);
  if (mem.goal !== goal.cell || !mem.path?.length || (mem.path[0] !== here && !mem.path.includes(here) && Math.abs(mem.path[0] - here) > MAP.cols + 1)) {
    mem.goal = goal.cell;
    mem.path = path(here, goal.cell);
  }
  while (mem.path.length > 1 && mem.path[0] === here) mem.path.shift();
  const [gx, gz] = centre(mem.path[0] ?? goal.cell);
  const dx = gx - p.x;
  const dz = gz - p.z;
  const dist = Math.hypot(dx, dz);
  if (mem.path.length <= 1 && dist < 0.4) {
    // arrived: hold, look around, plant or defuse
    const look = (p.yaw + 0.01) % (Math.PI * 2);
    return { ...base, yaw: look, b: goal.use ? USE | CROUCH : 0 };
  }
  if (dist < 0.35 && mem.path.length > 1) mem.path.shift();
  const near = s.bomb.k === "planted" && playerSide(s, p) === "CT";
  return { ...base, f: 1, yaw: yawTo(dx, dz), b: near ? 0 : dist < 1 && mem.path.length <= 1 ? WALK : 0 };
}

/** What a bot buys at the start of a round, in order: a rifle and armour when it can, an SMG on a half-buy, armour on an eco. */
export function botBuys(s: RoomState, p: Player): BuyItem[] {
  if (buyOpen(s, p)) return [];
  const side = playerSide(s, p);
  const rifle = side === "T" ? "ak" : "m5";
  const out: BuyItem[] = [];
  let money = p.money;
  const take = (item: BuyItem): void => {
    const c = price(s, p, item);
    if (typeof c === "number" && c <= money) {
      out.push(item);
      money -= c;
    }
  };
  const rc = WEAPONS[rifle].cost;
  if (!p.primary && money >= rc + 650) take(rifle);
  else if (!p.primary && money >= 1200 + 650 + 1000) take("vex");
  if (money >= 1000) take("helmet");
  else if (money >= 650) take("vest");
  if (side === "CT" && money >= 400) take("kit");
  return out;
}
