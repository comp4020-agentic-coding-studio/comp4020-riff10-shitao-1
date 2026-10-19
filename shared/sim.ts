// The authoritative match simulation. Pure functions over a
// JSON-serialisable RoomState, so it runs (and is tested) without a browser
// or a socket. The server owns the only live copy of each room and calls
// these in order, one command or one tick at a time, which is what
// serialises every outcome: a browser only ever sends intentions (an Input
// per tick, or a Command), and nothing here trusts it for a result.
import {
  BOMB_DAMAGE,
  BOMB_RADIUS,
  BOMB_S,
  BUY_AFTER_FREEZE_S,
  DEFUSE_KIT_S,
  DEFUSE_RANGE,
  DEFUSE_REWARD,
  DEFUSE_S,
  FREEZE_S,
  GEAR,
  HALFTIME_S,
  HALF_ROUNDS,
  HELMET_ONLY,
  LEG_MULT,
  LEG_TOP,
  MAX_BOTS,
  MAX_IDENTITIES,
  MAX_MONEY,
  MAX_PLAYERS,
  MAX_ROUNDS,
  OBJECTIVE_WIN_REWARD,
  OVER_S,
  PICKUP_RANGE,
  PING_KINDS,
  PLANT_REWARD,
  PLANT_S,
  PLANT_TEAM_BONUS,
  ROUNDS_TO_WIN,
  ROUND_S,
  START_MONEY,
  SWITCH_S,
  TICK_HZ,
  WARMUP_MONEY,
  WARMUP_RESPAWN_S,
  WEAPONS,
  WIN_REWARD,
  inaccuracy,
  isBuyItem,
  isWeapon,
  lossBonus,
  secs,
  sprayOffset,
  type BuyItem,
  type Slot,
  type WeaponDef,
  type WeaponId,
} from "./content.ts";
import { MAP, calloutAt, inRect, siteAt, type Side } from "./map.ts";
import { aimDir, eyeHeight, rayMap, rayPlayer, step, topSpeed, wishVelocity } from "./physics.ts";
import { CROUCH, FIRE, SCHEMA_VERSION, USE, WALK, type Command, type Fx, type Input, type Player, type RoomState, type RoundEnd, type Team } from "./protocol.ts";
import { botInput, botBuys, type BotMem } from "./bot.ts";

export const TEAM_SIZE = 5;
const RECEIPTS = 32;
const FEED = 6;
/** furthest back the server rewinds other players for a shot: a quarter second */
export const MAX_REWIND = secs(0.25);
const LAG_FRAMES = MAX_REWIND + 4;
const PING_EVERY = secs(1);

export type EvValue = string | number | boolean;
export interface Ev {
  actor: string;
  name: string;
  action: string;
  [k: string]: EvValue;
}

/** What one command or tick changed, for the server to log, broadcast and save. */
export interface Changes {
  events: Ev[];
  fx: Fx[];
  meta: boolean;
  gone: string[];
  /** a round or match boundary: save before telling anyone */
  boundary: boolean;
}
export const newChanges = (): Changes => ({ events: [], fx: [], meta: false, gone: [], boundary: false });

/** Where every player stood at the end of recent ticks: [x, z, crouch, alive]. Never saved. */
export interface Lag {
  frames: Map<number, Map<string, [number, number, number, number]>>;
}
export const newLag = (): Lag => ({ frames: new Map() });

/** Everything a tick needs besides the state: none of it is saved. */
export interface TickCtx {
  lag: Lag;
  /** the inputs a human's connection may spend this tick, in order (the server budgets them) */
  inputs: (p: Player) => Input[];
  brains: Map<string, BotMem>;
}
export const newCtx = (inputs: TickCtx["inputs"] = () => []): TickCtx => ({ lag: newLag(), inputs, brains: new Map() });

export type Result = { ok: true } | { ok: false; reason: string };
const ok: Result = { ok: true };
const no = (reason: string): Result => ({ ok: false, reason });

// ---- small helpers --------------------------------------------------------

/** xorshift32 over the room's own seed: replays and reloads draw the same numbers. */
export function rand(s: RoomState): number {
  let x = s.rng | 0 || 0x9e3779b9;
  x ^= x << 13;
  x ^= x >>> 17;
  x ^= x << 5;
  s.rng = x >>> 0;
  return s.rng / 4294967296;
}

export const sideOf = (s: Pick<RoomState, "half">, team: Team): Side => ((team === 0) !== (s.half === 1) ? "T" : "CT");
export const teamOf = (s: Pick<RoomState, "half">, side: Side): Team => (sideOf(s, 0) === side ? 0 : 1);
export const playerSide = (s: RoomState, p: Player): Side | null => (p.team === null ? null : sideOf(s, p.team));

export const weaponInHand = (p: Player): WeaponId => (p.slot === "primary" ? p.primary : p.slot === "secondary" ? p.secondary : null) ?? "knife";

const event = (ch: Changes, p: Player | null, action: string, fields: Record<string, EvValue> = {}): void => {
  ch.events.push({ actor: p?.id ?? "room", name: p?.name ?? "room", action, ...fields });
};

const sorted = (s: RoomState): Player[] => Object.values(s.players).sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
export const members = (s: RoomState, team: Team): Player[] => sorted(s).filter((p) => p.team === team);
/** Who holds a seat on a team right now: bots, and humans who are connected. */
const seated = (s: RoomState, team: Team): Player[] => members(s, team).filter((p) => p.bot || p.connected);
const fullAmmo = (w: WeaponId): { mag: number; reserve: number } => ({ mag: WEAPONS[w].mag, reserve: WEAPONS[w].reserve });
const addMoney = (p: Player, n: number): void => {
  p.money = Math.max(0, Math.min(MAX_MONEY, p.money + n));
};

export function cleanName(raw: unknown): string {
  const t = typeof raw === "string" ? raw : "";
  const n = t.replace(/[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u2028-\u202e\u2066-\u2069]/g, "").trim().slice(0, 16);
  return n || "Player";
}

// ---- rooms and players ----------------------------------------------------

export function createRoom(code: string, seed: number, fill = 0): RoomState {
  return {
    v: SCHEMA_VERSION,
    code,
    rng: seed >>> 0 || 1,
    tick: 0,
    seq: 0,
    phase: { k: "warmup", until: null },
    round: 0,
    half: 0,
    score: [0, 0],
    losses: [0, 0],
    history: [],
    bomb: { k: "none" },
    fill: Math.max(0, Math.min(TEAM_SIZE, Math.floor(fill))),
    hostId: null,
    feed: [],
    players: {},
    nextBot: 1,
    tokens: {},
    receipts: {},
  };
}

function newPlayer(id: string, name: string, team: Team | null, bot: boolean, tick: number): Player {
  return {
    id,
    name,
    team,
    bot,
    connected: !bot,
    alive: false,
    x: 0,
    z: 0,
    vx: 0,
    vz: 0,
    yaw: 0,
    pitch: 0,
    crouch: false,
    hp: 0,
    armour: 0,
    helmet: false,
    kit: false,
    money: START_MONEY,
    primary: null,
    secondary: "p9",
    ammo: { p9: fullAmmo("p9") },
    slot: "secondary",
    pc: 0,
    nextFire: 0,
    busyUntil: 0,
    reloading: false,
    spray: 0,
    lastShot: -1000,
    act: null,
    ack: 0,
    respawnAt: 0,
    lastB: 0,
    nextPing: 0,
    stats: { kills: 0, deaths: 0, damage: 0, obj: 0 },
    joinedTick: tick,
  };
}

/** The team a newcomer is balanced onto: fewer people, then a coin. */
function autoTeam(s: RoomState): Team {
  const humans = (t: Team): number => members(s, t).filter((p) => !p.bot && p.connected).length;
  const total = (t: Team): number => seated(s, t).length;
  if (humans(0) !== humans(1)) return humans(0) < humans(1) ? 0 : 1;
  if (total(0) !== total(1)) return total(0) < total(1) ? 0 : 1;
  return rand(s) < 0.5 ? 0 : 1;
}

const roomFor = (s: RoomState, team: Team): boolean => members(s, team).filter((p) => !p.bot && p.connected).length < TEAM_SIZE;

/** Put a player into play mid-phase if the phase allows it (warmup and freeze do; a live round doesn't). */
function enterPlay(s: RoomState, p: Player): void {
  if (p.team === null) return;
  if (s.phase.k === "warmup" || s.phase.k === "freeze") {
    const side = sideOf(s, p.team);
    const taken = sorted(s).filter((q) => q.alive && q.team === p.team).length;
    spawn(s, p, taken);
    if (s.phase.k === "warmup") p.money = WARMUP_MONEY;
    void side;
  } else {
    p.alive = false;
  }
}

/** A player arrives (or comes back). Null when the room has no seat for them. */
export function join(s: RoomState, id: string, token: string, rawName: string, ch: Changes): Player | null {
  const name = cleanName(rawName);
  const existing = s.players[id];
  if (existing) {
    existing.connected = true;
    existing.name = name;
    if (existing.team !== null && !existing.alive && (s.phase.k === "warmup" || s.phase.k === "freeze")) enterPlay(s, existing);
    if (!s.hostId || !s.players[s.hostId]?.connected) s.hostId = id;
    event(ch, existing, "rejoin", { team: existing.team ?? "none" });
    ch.meta = true;
    return existing;
  }
  const connected = Object.values(s.players).filter((p) => !p.bot && p.connected).length;
  if (connected >= MAX_PLAYERS) return null;
  // forget the longest-gone identities past the cap, so departed players never fill a room
  const humans = Object.values(s.players).filter((p) => !p.bot);
  if (humans.length >= MAX_IDENTITIES) {
    const gone = humans.filter((p) => !p.connected).sort((a, b) => a.joinedTick - b.joinedTick);
    for (const g of gone.slice(0, humans.length - MAX_IDENTITIES + 1)) forget(s, g.id, ch);
  }
  let team: Team | null = autoTeam(s);
  if (!roomFor(s, team)) team = roomFor(s, (1 - team) as Team) ? ((1 - team) as Team) : null;
  const p = newPlayer(id, name, team, false, s.tick);
  s.players[id] = p;
  s.tokens[id] = token;
  s.receipts[id] = [];
  if (!s.hostId || !s.players[s.hostId]?.connected) s.hostId = id;
  enterPlay(s, p);
  event(ch, p, "join", { team: team ?? "none", side: team === null ? "none" : sideOf(s, team) });
  if (s.phase.k === "warmup") rebalanceBots(s, ch);
  ch.meta = true;
  return p;
}

function forget(s: RoomState, id: string, ch: Changes): void {
  delete s.players[id];
  delete s.tokens[id];
  delete s.receipts[id];
  ch.gone.push(id);
}

/** A connection closed. The player keeps their seat, side, money and gear; their body stands still until they're back. */
export function leave(s: RoomState, id: string, ch: Changes): void {
  const p = s.players[id];
  if (!p) return;
  p.connected = false;
  p.vx = p.vz = 0;
  p.lastB = 0;
  p.act = null;
  if (s.hostId === id) s.hostId = sorted(s).find((q) => !q.bot && q.connected)?.id ?? null;
  event(ch, p, "leave");
  ch.meta = true;
}

function spawn(s: RoomState, p: Player, index: number): void {
  if (p.team === null) return;
  const side = sideOf(s, p.team);
  const spots = MAP.spawns[side];
  const at = spots[index % spots.length];
  Object.assign(p, { x: at.x, z: at.z, vx: 0, vz: 0, yaw: at.yaw, pitch: 0, crouch: false, alive: true, hp: 100, act: null, reloading: false, busyUntil: 0, spray: 0 });
  if (!p.secondary) p.secondary = "p9";
  // a new round tops up the guns you kept
  for (const w of [p.primary, p.secondary]) if (w) p.ammo[w] = fullAmmo(w);
  p.slot = p.primary ? "primary" : "secondary";
}

function strip(p: Player): void {
  p.primary = null;
  p.secondary = null;
  p.ammo = {};
  p.armour = 0;
  p.helmet = false;
  p.kit = false;
  p.slot = "knife";
}

/** Bots fill each team up to `fill` seats, and give way to humans. Only between rounds, so a bot never vanishes mid-fight. */
function rebalanceBots(s: RoomState, ch: Changes): void {
  for (const team of [0, 1] as Team[]) {
    const seats = seated(s, team);
    const humans = seats.filter((p) => !p.bot).length;
    const want = Math.max(0, Math.min(TEAM_SIZE - humans, s.fill - humans));
    const bots = seats.filter((p) => p.bot);
    for (let i = bots.length; i < want; i++) {
      const total = Object.values(s.players).filter((p) => p.bot).length;
      if (total >= MAX_BOTS) break;
      const id = `bot-${s.nextBot++}`;
      const p = newPlayer(id, BOT_NAMES[(s.nextBot - 2) % BOT_NAMES.length], team, true, s.tick);
      s.players[id] = p;
      enterPlay(s, p);
      event(ch, p, "bot_join", { team, side: sideOf(s, team) });
    }
    for (const b of bots.slice(want).reverse()) {
      if (s.bomb.k === "carried" && s.bomb.by === b.id) s.bomb = { k: "dropped", x: b.x, z: b.z };
      event(ch, b, "bot_leave");
      forget(s, b.id, ch);
    }
  }
  ch.meta = true;
}
const BOT_NAMES = ["Kestrel", "Magpie", "Wren", "Plover", "Curlew", "Bittern", "Shrike", "Lapwing", "Tern", "Godwit"];

// ---- the round machine ----------------------------------------------------

const bothSides = (s: RoomState): boolean => seated(s, 0).length > 0 && seated(s, 1).length > 0;

function startMatch(s: RoomState, ch: Changes): void {
  s.round = 0;
  s.half = 0;
  s.score = [0, 0];
  s.losses = [0, 0];
  s.history = [];
  s.feed = [];
  for (const p of Object.values(s.players)) {
    strip(p);
    p.money = START_MONEY;
    p.stats = { kills: 0, deaths: 0, damage: 0, obj: 0 };
  }
  event(ch, null, "match_start", { t: seated(s, 0).length, ct: seated(s, 1).length });
  startRound(s, ch);
}

function startRound(s: RoomState, ch: Changes): void {
  rebalanceBots(s, ch);
  s.phase = { k: "freeze", until: s.tick + secs(FREEZE_S) };
  s.bomb = { k: "none" };
  for (const team of [0, 1] as Team[]) {
    let i = 0;
    for (const p of members(s, team)) {
      if (p.bot || p.connected) spawn(s, p, i++);
      else p.alive = false;
    }
  }
  for (const p of Object.values(s.players)) if (p.team === null) p.alive = false;
  const ts = members(s, teamOf(s, "T")).filter((p) => p.alive);
  if (ts.length) {
    const carrier = ts[Math.floor(rand(s) * ts.length)];
    s.bomb = { k: "carried", by: carrier.id };
  }
  for (const p of Object.values(s.players)) if (p.bot && p.alive) for (const item of botBuys(s, p)) buy(s, p, item, ch);
  event(ch, null, "round_start", { round: s.round + 1, score: `${s.score[0]}-${s.score[1]}` });
  ch.meta = true;
  ch.boundary = true;
}

function endRound(s: RoomState, winnerSide: Side, how: RoundEnd, ch: Changes): void {
  if (s.phase.k !== "live") return;
  const winner = teamOf(s, winnerSide);
  const loser = (1 - winner) as Team;
  const planted = s.bomb.k === "planted" || s.bomb.k === "defused" || s.bomb.k === "exploded";
  s.score[winner]++;
  s.losses[winner] = 0;
  s.losses[loser]++;
  const result = { n: s.round + 1, winner, side: winnerSide, how };
  s.history.push(result);
  s.round++;
  const reward = how === "bomb" || how === "defuse" ? OBJECTIVE_WIN_REWARD : WIN_REWARD;
  const bonus = lossBonus(s.losses[loser]);
  for (const p of members(s, winner)) addMoney(p, reward);
  for (const p of members(s, loser)) addMoney(p, bonus + (planted && sideOf(s, loser) === "T" ? PLANT_TEAM_BONUS : 0));
  s.phase = { k: "over", until: s.tick + secs(OVER_S), result };
  for (const p of Object.values(s.players)) p.act = null;
  event(ch, null, "round_end", { round: result.n, winner: winnerSide, how, score: `${s.score[0]}-${s.score[1]}`, win_reward: reward, loss_bonus: bonus });
  ch.meta = true;
  ch.boundary = true;
}

function afterRound(s: RoomState, ch: Changes): void {
  const done = s.score[0] >= ROUNDS_TO_WIN || s.score[1] >= ROUNDS_TO_WIN || s.round >= MAX_ROUNDS;
  if (done) {
    const winner: Team | null = s.score[0] === s.score[1] ? null : s.score[0] > s.score[1] ? 0 : 1;
    s.phase = { k: "ended", winner };
    for (const p of Object.values(s.players)) {
      p.vx = p.vz = 0;
      p.act = null;
    }
    event(ch, null, "match_end", { winner: winner === null ? "draw" : `team${winner + 1}`, score: `${s.score[0]}-${s.score[1]}` });
    ch.meta = true;
    ch.boundary = true;
    return;
  }
  if (s.round === HALF_ROUNDS && s.half === 0) {
    s.phase = { k: "halftime", until: s.tick + secs(HALFTIME_S) };
    event(ch, null, "halftime", { score: `${s.score[0]}-${s.score[1]}` });
    ch.meta = true;
    ch.boundary = true;
    return;
  }
  startRound(s, ch);
}

function secondHalf(s: RoomState, ch: Changes): void {
  s.half = 1;
  s.losses = [0, 0];
  for (const p of Object.values(s.players)) {
    strip(p);
    p.money = START_MONEY;
    p.alive = false;
  }
  startRound(s, ch);
}

// ---- damage ---------------------------------------------------------------

function kill(s: RoomState, victim: Player, killer: Player | null, weapon: WeaponId | "bomb", head: boolean, ch: Changes): void {
  victim.alive = false;
  victim.hp = 0;
  victim.act = null;
  victim.vx = victim.vz = 0;
  victim.stats.deaths++;
  if (s.bomb.k === "carried" && s.bomb.by === victim.id) s.bomb = { k: "dropped", x: victim.x, z: victim.z };
  strip(victim);
  if (s.phase.k === "warmup") victim.respawnAt = s.tick + secs(WARMUP_RESPAWN_S);
  s.feed = [...s.feed, { t: s.tick, killer: killer?.id ?? null, victim: victim.id, weapon, head }].slice(-FEED);
  const enemy = killer && killer.team !== victim.team;
  if (killer && enemy) {
    killer.stats.kills++;
    if (weapon !== "bomb" && s.phase.k !== "warmup") addMoney(killer, WEAPONS[weapon].killReward);
  }
  event(ch, killer ?? victim, "kill", {
    victim: victim.id,
    victim_name: victim.name,
    weapon,
    head,
    at: calloutAt(victim.x, victim.z) || "map",
    ...(weapon !== "bomb" && killer && enemy && s.phase.k !== "warmup" ? { reward: WEAPONS[weapon].killReward } : {}),
  });
  ch.meta = true;
}

/** Damage after armour: returns [health lost, armour lost]. */
export function afterArmour(dmg: number, pen: number, armour: number, helmet: boolean, zone: "head" | "body" | "legs"): [number, number] {
  const covered = armour > 0 && (zone === "body" || (zone === "head" && helmet));
  if (!covered) return [Math.round(dmg), 0];
  const hp = Math.round(dmg * pen);
  const ar = Math.min(armour, Math.round((dmg - hp) / 2));
  return [hp, ar];
}

/** Damage a hit of this weapon does at this distance, before armour. */
export function rawDamage(w: WeaponDef, dist: number, zone: "head" | "body" | "legs"): number {
  const mult = zone === "head" ? w.headMult : zone === "legs" ? LEG_MULT : 1;
  return w.damage * Math.pow(w.falloff, dist / 10) * mult;
}

function hurt(s: RoomState, victim: Player, by: Player, w: WeaponDef, dist: number, zone: "head" | "body" | "legs", at: [number, number, number], ch: Changes): void {
  const [hp, ar] = afterArmour(rawDamage(w, dist, zone), w.armourPen, victim.armour, victim.helmet, zone);
  const dealt = Math.min(hp, victim.hp);
  victim.hp -= dealt;
  victim.armour -= ar;
  if (victim.armour <= 0) {
    victim.armour = 0;
    victim.helmet = false;
  }
  by.stats.damage += dealt;
  ch.fx.push({ k: "hit", by: by.id, on: victim.id, dmg: dealt, head: zone === "head", at });
  if (victim.hp <= 0) kill(s, victim, by, w.id, zone === "head", ch);
}

/** Where another player stood at fractional tick `vt`, from the lag frames; falls back to now. */
function rewound(s: RoomState, lag: Lag, q: Player, vt: number): [number, number, boolean] | null {
  const t = Math.max(s.tick - MAX_REWIND, Math.min(s.tick - 1, vt));
  const a = lag.frames.get(Math.floor(t))?.get(q.id);
  const b = lag.frames.get(Math.ceil(t))?.get(q.id);
  if (!a && !b) return [q.x, q.z, q.crouch];
  const A = a ?? b!;
  const B = b ?? a!;
  if (!A[3] && !B[3]) return null;
  const k = t - Math.floor(t);
  return [A[0] + (B[0] - A[0]) * k, A[1] + (B[1] - A[1]) * k, (k < 0.5 ? A[2] : B[2]) === 1];
}

/**
 * One shot, decided here and only here: from the shooter's server-known eye
 * and the aim the input carried, plus spray and inaccuracy drawn from the
 * room's own random stream, against walls and against every enemy where the
 * shooter was seeing them (rewound to the input's view tick, at most
 * MAX_REWIND back). The browser never says what it hit.
 */
function fire(s: RoomState, p: Player, vt: number, lag: Lag, ch: Changes): void {
  const id = weaponInHand(p);
  const w = WEAPONS[id];
  if (id !== "knife") {
    const a = p.ammo[id];
    if (!a || a.mag <= 0) {
      if (a && a.reserve > 0) startReload(s, p);
      else ch.fx.push({ k: "sound", s: "empty", by: p.id, x: p.x, z: p.z });
      p.nextFire = p.pc + w.rate * TICK_HZ;
      return;
    }
    a.mag--;
  }
  // spray recovers while you aren't firing, beyond the gun's own cadence
  const idle = Math.max(0, (p.pc - p.lastShot) / TICK_HZ - w.rate * 1.1);
  p.spray = Math.max(0, p.spray - idle / w.recovery);
  const [kick, sway] = sprayOffset(w, Math.round(p.spray));
  const cone = inaccuracy(w, Math.hypot(p.vx, p.vz), p.crouch);
  const ang = rand(s) * Math.PI * 2;
  const rad = cone * Math.sqrt(rand(s));
  const dir = aimDir(p.yaw - sway + rad * Math.cos(ang), Math.max(-1.55, Math.min(1.55, p.pitch + kick + rad * Math.sin(ang))));
  const eye: [number, number, number] = [p.x, eyeHeight(p.crouch), p.z];
  const wallT = rayMap(eye, dir, w.range);
  let best: { t: number; zone: "head" | "body" | "legs"; q: Player } | null = null;
  for (const q of sorted(s)) {
    if (q.id === p.id || !q.alive || q.team === p.team) continue;
    const at = rewound(s, lag, q, vt);
    if (!at) continue;
    const hit = rayPlayer(eye, dir, at[0], at[1], at[2], at[2] ? LEG_TOP * 0.6 : LEG_TOP);
    if (hit && hit.t < wallT && (!best || hit.t < best.t)) best = { ...hit, q };
  }
  const t = best ? best.t : wallT;
  const to: [number, number, number] = [eye[0] + dir[0] * t, eye[1] + dir[1] * t, eye[2] + dir[2] * t];
  ch.fx.push({ k: "shot", by: p.id, w: id, from: eye, to });
  if (best) hurt(s, best.q, p, w, best.t, best.zone, to, ch);
  p.spray += 1;
  p.lastShot = p.pc;
  p.nextFire = (p.nextFire > p.pc - 1 ? p.nextFire : p.pc) + w.rate * TICK_HZ;
}

function startReload(s: RoomState, p: Player): boolean {
  const id = weaponInHand(p);
  const a = p.ammo[id];
  if (id === "knife" || !a || p.reloading || a.reserve <= 0 || a.mag >= WEAPONS[id].mag) return false;
  p.reloading = true;
  p.busyUntil = s.tick + secs(WEAPONS[id].reload);
  return true;
}

// ---- inputs ---------------------------------------------------------------

export const canMove = (s: RoomState): boolean => s.phase.k === "warmup" || s.phase.k === "live" || s.phase.k === "over";

/** The movement half of an input, exactly as the browser predicts it. */
export function moveFor(s: RoomState, p: Player, inp: Input): [number, number] {
  const frozen = !canMove(s) || p.act !== null;
  const speed = frozen ? 0 : topSpeed(WEAPONS[weaponInHand(p)].speed, (inp.b & CROUCH) !== 0, (inp.b & WALK) !== 0);
  return wishVelocity(inp.f, inp.r, inp.yaw, speed);
}

/** Apply one input: turn, move, use, fire, in that order. */
export function applyInput(s: RoomState, p: Player, inp: Input, lag: Lag, ch: Changes): void {
  p.ack = inp.s;
  p.pc++;
  p.yaw = inp.yaw;
  p.pitch = inp.pitch;
  const pressed = inp.b & ~p.lastB;
  p.lastB = inp.b;
  if (!p.alive || p.team === null) return;
  p.crouch = (inp.b & CROUCH) !== 0;
  step(p, moveFor(s, p, inp));
  if (inp.b & USE) use(s, p, ch);
  else if (p.act) p.act = null;
  if (!(inp.b & FIRE) || p.act || !canMove(s) || s.tick < p.busyUntil) return;
  const w = WEAPONS[weaponInHand(p)];
  if (!(w.auto || pressed & FIRE)) return;
  if (p.pc + 1e-6 < p.nextFire) return;
  fire(s, p, inp.vt, lag, ch);
}

function use(s: RoomState, p: Player, ch: Changes): void {
  const side = playerSide(s, p);
  const b = s.bomb;
  if (p.act) {
    // keep going only while it's still possible
    const still = p.act.k === "plant" ? b.k === "carried" && b.by === p.id && siteAt(p.x, p.z) !== null : b.k === "planted" && Math.hypot(b.x - p.x, b.z - p.z) <= DEFUSE_RANGE;
    if (!still) p.act = null;
    return;
  }
  if (s.phase.k !== "live") return;
  if (side === "T" && b.k === "carried" && b.by === p.id && siteAt(p.x, p.z)) {
    p.act = { k: "plant", until: s.tick + secs(PLANT_S) };
    ch.fx.push({ k: "sound", s: "plant", by: p.id, x: p.x, z: p.z });
    ch.meta = true;
  } else if (side === "CT" && b.k === "planted" && Math.hypot(b.x - p.x, b.z - p.z) <= DEFUSE_RANGE) {
    if (Object.values(s.players).some((q) => q.act?.k === "defuse")) return;
    p.act = { k: "defuse", until: s.tick + secs(p.kit ? DEFUSE_KIT_S : DEFUSE_S) };
    ch.fx.push({ k: "sound", s: "defuse", by: p.id, x: p.x, z: p.z });
    event(ch, p, "defuse_start", { kit: p.kit });
    ch.meta = true;
  }
}

// ---- commands -------------------------------------------------------------

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** Can this player buy right now: the phase, the clock, and standing in their own buy zone. */
export function buyOpen(s: RoomState, p: Player): string | null {
  if (!p.alive || p.team === null) return "you can only buy while alive";
  const ph = s.phase;
  const window = ph.k === "warmup" || ph.k === "freeze" || (ph.k === "live" && ph.until - s.tick > secs(ROUND_S - BUY_AFTER_FREEZE_S));
  if (!window) return "the buy time is over";
  if (!inRect(MAP.buyZones[sideOf(s, p.team)], p.x, p.z)) return "buy in your spawn";
  return null;
}

/** What an item costs this player right now, or why they can't have it. */
export function price(s: RoomState, p: Player, item: BuyItem): number | string {
  const side = p.team === null ? null : sideOf(s, p.team);
  if (isWeapon(item)) {
    const w = WEAPONS[item];
    if (w.side && w.side !== side) return `the ${w.name} is ${w.side} only`;
    if (p.primary === item || p.secondary === item) return `you already have the ${w.name}`;
    return w.cost;
  }
  const g = GEAR[item];
  if (g.side && g.side !== side) return `the ${g.name.toLowerCase()} is ${g.side} only`;
  if (item === "vest") return p.armour >= 100 ? "your armour is full" : g.cost;
  if (item === "helmet") return p.helmet && p.armour >= 100 ? "you have a full vest and helmet" : p.armour >= 100 ? HELMET_ONLY : g.cost;
  return p.kit ? "you already have a kit" : g.cost;
}

function buy(s: RoomState, p: Player, item: BuyItem, ch: Changes): Result {
  const closed = buyOpen(s, p);
  if (closed) return no(closed);
  const cost = price(s, p, item);
  if (typeof cost === "string") return no(cost);
  if (p.money < cost) return no(`needs $${cost} (have $${p.money})`);
  p.money -= cost;
  if (isWeapon(item)) {
    const w = WEAPONS[item];
    if (w.slot === "primary") {
      if (p.primary) delete p.ammo[p.primary];
      p.primary = item;
    } else {
      if (p.secondary) delete p.ammo[p.secondary];
      p.secondary = item;
    }
    p.ammo[item] = fullAmmo(item);
    p.slot = w.slot;
    p.reloading = false;
    p.busyUntil = s.tick + secs(SWITCH_S);
  } else if (item === "vest") p.armour = 100;
  else if (item === "helmet") {
    p.armour = 100;
    p.helmet = true;
  } else p.kit = true;
  event(ch, p, "buy", { item, cost, money: p.money });
  ch.fx.push({ k: "sound", s: "buy", by: p.id, x: p.x, z: p.z });
  return ok;
}

function receipt(s: RoomState, pid: string, id: string): void {
  const r = (s.receipts[pid] ??= []);
  r.push(id);
  if (r.length > RECEIPTS) r.shift();
}

/**
 * A command from a player. Every field is checked here, whatever the UI
 * allows. A command id seen before is acknowledged without applying again;
 * only an applied command is receipted, so a refused one can be honestly retried.
 */
export function applyCommand(s: RoomState, pid: string, id: string, raw: unknown, ch: Changes): Result {
  const p = s.players[pid];
  if (!p) return no("you're not in this room");
  if (s.receipts[pid]?.includes(id)) return ok;
  if (!isRecord(raw) || typeof raw.k !== "string") return no("malformed command");
  const c = raw as Command;
  const res = command(s, p, c, ch);
  if (res.ok) {
    receipt(s, pid, id);
    ch.meta = true;
  }
  return res;
}

function command(s: RoomState, p: Player, c: Command, ch: Changes): Result {
  switch (c.k) {
    case "buy":
      if (!isBuyItem(c.item)) return no("there's nothing called that to buy");
      return buy(s, p, c.item, ch);
    case "slot": {
      if (c.slot !== "primary" && c.slot !== "secondary" && c.slot !== "knife") return no("no such slot");
      if (c.slot === "primary" && !p.primary) return no("no primary weapon");
      if (c.slot === "secondary" && !p.secondary) return no("no pistol");
      if (!p.alive) return no("you're dead");
      if (p.slot === c.slot) return ok;
      p.slot = c.slot as Slot;
      p.reloading = false;
      p.busyUntil = s.tick + secs(SWITCH_S);
      return ok;
    }
    case "reload":
      if (!p.alive) return no("you're dead");
      if (!startReload(s, p)) return no("nothing to reload");
      ch.fx.push({ k: "sound", s: "reload", by: p.id, x: p.x, z: p.z });
      return ok;
    case "side": {
      if (c.side !== "T" && c.side !== "CT" && c.side !== "auto") return no("pick T, CT or auto");
      if (s.phase.k === "ended") return no("the match is over");
      if (s.phase.k === "live" && p.alive) return no("you can switch sides when you're dead or between rounds");
      const team: Team = c.side === "auto" ? autoTeam(s) : teamOf(s, c.side);
      if (team === p.team) return ok;
      if (!roomFor(s, team)) return no("that side is full");
      if (s.bomb.k === "carried" && s.bomb.by === p.id) s.bomb = { k: "dropped", x: p.x, z: p.z };
      p.team = team;
      p.alive = false;
      p.act = null;
      enterPlay(s, p);
      event(ch, p, "side", { side: sideOf(s, team) });
      if (s.phase.k === "warmup") rebalanceBots(s, ch);
      return ok;
    }
    case "ping": {
      if (!(PING_KINDS as readonly string[]).includes(c.kind)) return no("no such callout");
      if (typeof c.x !== "number" || typeof c.z !== "number" || !Number.isFinite(c.x) || !Number.isFinite(c.z)) return no("malformed callout");
      if (c.x < 0 || c.z < 0 || c.x > MAP.width || c.z > MAP.depth) return no("that's off the map");
      if (p.team === null) return no("pick a side first");
      if (s.tick < p.nextPing) return no("one callout a second");
      p.nextPing = s.tick + PING_EVERY;
      const place = calloutAt(c.x, c.z);
      ch.fx.push({ k: "ping", by: p.id, kind: c.kind, x: c.x, z: c.z, team: p.team, place });
      event(ch, p, "ping", { kind: c.kind, at: place || "map" });
      return ok;
    }
    case "bots": {
      if (s.hostId !== p.id) return no("only the host can change the bots");
      if (typeof c.per !== "number" || !Number.isInteger(c.per) || c.per < 0 || c.per > TEAM_SIZE) return no("bots per side is 0 to 5");
      s.fill = c.per;
      event(ch, p, "bots", { per: c.per });
      if (s.phase.k === "warmup") rebalanceBots(s, ch);
      return ok;
    }
    case "start": {
      if (s.hostId !== p.id) return no("only the host can start the match");
      if (s.phase.k !== "warmup") return no("the match has already started");
      if (!bothSides(s)) return no("both sides need someone (add bots, or wait for a friend)");
      s.phase = { k: "warmup", until: s.tick + secs(3) };
      event(ch, p, "start");
      return ok;
    }
    default:
      return no("unknown command");
  }
}

// ---- the tick -------------------------------------------------------------

function recordFrame(s: RoomState, lag: Lag): void {
  const f = new Map<string, [number, number, number, number]>();
  for (const p of Object.values(s.players)) f.set(p.id, [p.x, p.z, p.crouch ? 1 : 0, p.alive ? 1 : 0]);
  lag.frames.set(s.tick, f);
  lag.frames.delete(s.tick - LAG_FRAMES);
}

function explode(s: RoomState, ch: Changes): void {
  const b = s.bomb;
  if (b.k !== "planted") return;
  s.bomb = { k: "exploded", x: b.x, z: b.z, site: b.site };
  ch.fx.push({ k: "sound", s: "explode", x: b.x, z: b.z });
  event(ch, null, "explode", { site: b.site });
  for (const p of sorted(s)) {
    if (!p.alive) continue;
    const d = Math.hypot(p.x - b.x, p.z - b.z);
    if (d >= BOMB_RADIUS) continue;
    const raw = BOMB_DAMAGE * (1 - d / BOMB_RADIUS) ** 2;
    const dmg = Math.round(p.armour > 0 ? raw * 0.6 : raw);
    p.hp -= Math.min(p.hp, dmg);
    if (p.hp <= 0) kill(s, p, null, "bomb", false, ch);
  }
  endRound(s, "T", "bomb", ch);
}

function progress(s: RoomState, ch: Changes): void {
  for (const p of sorted(s)) {
    if (p.reloading && s.tick >= p.busyUntil) {
      const id = weaponInHand(p);
      const a = p.ammo[id];
      if (a && id !== "knife") {
        const take = Math.min(WEAPONS[id].mag - a.mag, a.reserve);
        a.mag += take;
        a.reserve -= take;
      }
      p.reloading = false;
    }
    if (!p.act || s.tick < p.act.until) continue;
    const b = s.bomb;
    if (p.act.k === "plant" && b.k === "carried" && b.by === p.id) {
      const site = siteAt(p.x, p.z) ?? "A";
      s.bomb = { k: "planted", x: p.x, z: p.z, site, at: s.tick, explodeAt: s.tick + secs(BOMB_S), by: p.id };
      p.stats.obj++;
      addMoney(p, PLANT_REWARD);
      ch.fx.push({ k: "sound", s: "planted", by: p.id, x: p.x, z: p.z });
      event(ch, p, "plant", { site, at: calloutAt(p.x, p.z) || "map", reward: PLANT_REWARD });
    } else if (p.act.k === "defuse" && b.k === "planted") {
      s.bomb = { k: "defused", x: b.x, z: b.z, site: b.site, by: p.id };
      p.stats.obj++;
      addMoney(p, DEFUSE_REWARD);
      ch.fx.push({ k: "sound", s: "defused", by: p.id, x: b.x, z: b.z });
      event(ch, p, "defuse", { site: b.site, reward: DEFUSE_REWARD, left_s: +((b.explodeAt - s.tick) / TICK_HZ).toFixed(1) });
      p.act = null;
      endRound(s, "CT", "defuse", ch);
      continue;
    }
    p.act = null;
    ch.meta = true;
  }
}

function pickup(s: RoomState, ch: Changes): void {
  const b = s.bomb;
  if (b.k !== "dropped") return;
  for (const p of sorted(s)) {
    if (!p.alive || playerSide(s, p) !== "T") continue;
    if (Math.hypot(p.x - b.x, p.z - b.z) <= PICKUP_RANGE) {
      s.bomb = { k: "carried", by: p.id };
      event(ch, p, "pickup");
      ch.meta = true;
      return;
    }
  }
}

function checkRound(s: RoomState, ch: Changes): void {
  if (s.phase.k !== "live") return;
  const alive = (side: Side): number => members(s, teamOf(s, side)).filter((p) => p.alive).length;
  const t = alive("T");
  const ct = alive("CT");
  if (s.bomb.k === "planted") {
    if (ct === 0) endRound(s, "T", "elimination", ch);
    return;
  }
  if (t === 0) endRound(s, "CT", "elimination", ch);
  else if (ct === 0) endRound(s, "T", "elimination", ch);
  else if (s.tick >= s.phase.until) endRound(s, "CT", "time", ch);
}

function phaseClock(s: RoomState, ch: Changes): void {
  const ph = s.phase;
  switch (ph.k) {
    case "warmup": {
      for (const p of sorted(s)) {
        if (p.team === null) continue;
        p.money = WARMUP_MONEY;
        if (!p.alive && (p.bot || p.connected) && s.tick >= p.respawnAt) {
          spawn(s, p, Math.floor(rand(s) * 12));
          ch.meta = true;
        }
      }
      const ready = bothSides(s) && Object.values(s.players).some((p) => !p.bot && p.connected);
      if (!ready && ph.until !== null) {
        s.phase = { k: "warmup", until: null };
        ch.meta = true;
      } else if (ready && ph.until === null) {
        s.phase = { k: "warmup", until: s.tick + secs(20) };
        ch.meta = true;
      } else if (ph.until !== null && s.tick >= ph.until) startMatch(s, ch);
      break;
    }
    case "freeze":
      if (s.tick >= ph.until) {
        s.phase = { k: "live", until: s.tick + secs(ROUND_S) };
        event(ch, null, "live", { round: s.round + 1 });
        ch.meta = true;
      }
      break;
    case "live":
      if (s.bomb.k === "planted" && s.tick >= s.bomb.explodeAt) explode(s, ch);
      break;
    case "over":
      if (s.tick >= ph.until) afterRound(s, ch);
      break;
    case "halftime":
      if (s.tick >= ph.until) secondHalf(s, ch);
      break;
    case "ended":
      break;
  }
}

/**
 * One simulation tick: every player's inputs in id order (bots think here,
 * from the same state everyone sees), then reloads, plants and defuses, the
 * bomb, and the round clock. Fixed order, never message order.
 */
export function tick(s: RoomState, ch: Changes, ctx: TickCtx): void {
  s.tick++;
  if (s.phase.k === "ended") return;
  for (const p of sorted(s)) {
    if (p.bot) {
      let mem = ctx.brains.get(p.id);
      if (!mem) ctx.brains.set(p.id, (mem = { site: rand(s) < 0.5 ? "A" : "B" } as BotMem));
      applyInput(s, p, botInput(s, p, mem), ctx.lag, ch);
    } else if (p.connected) {
      for (const inp of ctx.inputs(p)) applyInput(s, p, inp, ctx.lag, ch);
    }
  }
  recordFrame(s, ctx.lag);
  progress(s, ch);
  pickup(s, ch);
  phaseClock(s, ch);
  checkRound(s, ch);
}

/** Field-by-field validation of an input off the wire; null when it's not a usable one. */
export function cleanInput(raw: Record<string, unknown>, last: number): Input | null {
  const { s, f, r, yaw, pitch, b, vt } = raw;
  const int = (v: unknown): v is number => typeof v === "number" && Number.isInteger(v);
  const num = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
  if (!int(s) || s <= last || !int(f) || !int(r) || f < -1 || f > 1 || r < -1 || r > 1) return null;
  if (!num(yaw) || !num(pitch) || !int(b) || b < 0 || b > 15 || !num(vt)) return null;
  const tau = Math.PI * 2;
  return { s, f, r, yaw: ((yaw % tau) + tau) % tau, pitch: Math.max(-1.5, Math.min(1.5, pitch)), b, vt };
}

export const alivePlayers = (s: RoomState, side: Side): number => members(s, teamOf(s, side)).filter((p) => p.alive).length;
