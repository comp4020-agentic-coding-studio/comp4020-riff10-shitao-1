// The wire protocol between browser and game server, and the room state it
// describes. Versioned: a client and server that disagree on
// PROTOCOL_VERSION refuse each other rather than guess. All messages are
// JSON text frames.
import type { BuyItem, PingKind, Slot, WeaponId } from "./content.ts";
import type { Side, SiteId } from "./map.ts";

export const PROTOCOL_VERSION = 3;
/** 3: the tactical shooter. Rooms saved by Plenty (1, 2) are a different game and don't load. */
export const SCHEMA_VERSION = 3;
export const MAX_MESSAGE_BYTES = 1024;

/** A team keeps its score across the half; which side it plays flips at halftime. */
export type Team = 0 | 1;

/** One tick of a player's intent. The server consumes these one per tick, in order. */
export interface Input {
  /** sequence number, strictly increasing per connection */
  s: number;
  /** -1, 0 or 1: forward/back and right/left */
  f: number;
  r: number;
  yaw: number;
  pitch: number;
  /** buttons: FIRE | USE | CROUCH | WALK */
  b: number;
  /** the server tick the client was showing other players at, for lag compensation */
  vt: number;
}
export const FIRE = 1;
export const USE = 2;
export const CROUCH = 4;
export const WALK = 8;

export interface Ammo {
  mag: number;
  reserve: number;
}

export interface PlayerStats {
  kills: number;
  deaths: number;
  damage: number;
  /** objectives: plants and defuses */
  obj: number;
}

export interface Player {
  id: string;
  name: string;
  team: Team | null;
  bot: boolean;
  connected: boolean;
  alive: boolean;
  x: number;
  z: number;
  vx: number;
  vz: number;
  yaw: number;
  pitch: number;
  crouch: boolean;
  hp: number;
  armour: number;
  helmet: boolean;
  kit: boolean;
  money: number;
  primary: WeaponId | null;
  secondary: WeaponId | null;
  ammo: Partial<Record<WeaponId, Ammo>>;
  slot: Slot;
  /** inputs this player has spent: the clock their gun's cadence runs on */
  pc: number;
  /** the input count at which the weapon in hand may next fire (fractional, so cadence averages exactly) */
  nextFire: number;
  /** tick a reload or weapon switch finishes */
  busyUntil: number;
  reloading: boolean;
  /** shots in the current spray, decaying while not firing */
  spray: number;
  lastShot: number;
  /** planting or defusing: done at tick `until` */
  act: { k: "plant" | "defuse"; until: number } | null;
  /** last input consumed, so the owner can replay the rest on top */
  ack: number;
  /** warmup: respawn at this tick */
  respawnAt: number;
  /** last input's buttons, for edge detection */
  lastB: number;
  /** no callout before this tick */
  nextPing: number;
  stats: PlayerStats;
  joinedTick: number;
}

export type BombState =
  | { k: "carried"; by: string }
  | { k: "dropped"; x: number; z: number }
  | { k: "planted"; x: number; z: number; site: SiteId; at: number; explodeAt: number; by: string }
  | { k: "defused"; x: number; z: number; site: SiteId; by: string }
  | { k: "exploded"; x: number; z: number; site: SiteId }
  | { k: "none" };

export type RoundEnd = "elimination" | "time" | "bomb" | "defuse";

export interface RoundResult {
  n: number;
  winner: Team;
  side: Side;
  how: RoundEnd;
}

export type Phase =
  /** waiting for both sides; respawns and free money. `until` set once both sides have someone */
  | { k: "warmup"; until: number | null }
  | { k: "freeze"; until: number }
  | { k: "live"; until: number }
  | { k: "over"; until: number; result: RoundResult }
  | { k: "halftime"; until: number }
  | { k: "ended"; winner: Team | null };

export interface FeedEntry {
  t: number;
  killer: string | null;
  victim: string;
  weapon: WeaponId | "bomb";
  head: boolean;
}

/** Everything a room is. JSON-serialisable: this is exactly what gets saved. */
export interface RoomState {
  v: number;
  code: string;
  /** xorshift32 state: every random choice (spread, the bomb carrier, bots) comes from here */
  rng: number;
  tick: number;
  seq: number;
  phase: Phase;
  /** rounds played so far (the current one is round + 1 while it's running) */
  round: number;
  /** 0 first half, 1 second: team 0 is T in the first half and CT in the second */
  half: 0 | 1;
  score: [number, number];
  /** straight losses per team, for the loss bonus */
  losses: [number, number];
  history: RoundResult[];
  bomb: BombState;
  /** bots per side the host asked for, 0 to 5 */
  fill: number;
  hostId: string | null;
  feed: FeedEntry[];
  players: Record<string, Player>;
  nextBot: number;
  /** player id -> session token (secret; never sent to other clients) */
  tokens: Record<string, string>;
  /** player id -> recent command ids, for duplicate suppression */
  receipts: Record<string, string[]>;
}

export type Command =
  | { k: "side"; side: Side | "auto" }
  | { k: "buy"; item: BuyItem }
  | { k: "slot"; slot: Slot }
  | { k: "reload" }
  | { k: "ping"; kind: PingKind; x: number; z: number }
  | { k: "bots"; per: number }
  | { k: "start" };

export type ClientMsg =
  | { t: "hello"; v: number; room: string; token?: string; name: string }
  | ({ t: "in" } & Input)
  | { t: "cmd"; id: string; inc: string; c: Command }
  | { t: "sync" }
  | { t: "ping"; n: number };

/** What a client sees of the room: the state minus secrets. */
export type Snapshot = Omit<RoomState, "tokens" | "receipts">;

/** [id, x, z, vx, vz, yaw, pitch, crouch(0|1), ack] */
export type Motion = [string, number, number, number, number, number, number, number, number];

/** Momentary things to see and hear; never saved. */
export type Fx =
  | { k: "shot"; by: string; w: WeaponId; from: [number, number, number]; to: [number, number, number] }
  | { k: "hit"; by: string; on: string; dmg: number; head: boolean; at: [number, number, number] }
  | { k: "ping"; by: string; kind: PingKind; x: number; z: number; team: Team; place: string }
  | { k: "sound"; s: "plant" | "defuse" | "planted" | "defused" | "explode" | "reload" | "empty" | "buy"; by?: string; x: number; z: number };

export interface Delta {
  t: "delta";
  seq: number;
  tick: number;
  /** players whose non-motion fields changed, in full */
  players?: Player[];
  moves?: Motion[];
  gone?: string[];
  meta?: Pick<RoomState, "phase" | "round" | "half" | "score" | "losses" | "history" | "bomb" | "fill" | "hostId" | "feed">;
  fx?: Fx[];
}

export type ServerMsg =
  | { t: "welcome"; v: number; inc: string; you: string; token: string; snap: Snapshot }
  | Delta
  | { t: "ack"; id: string; ok: boolean; reason?: string }
  | { t: "error"; reason: string }
  | { t: "pong"; n: number };
