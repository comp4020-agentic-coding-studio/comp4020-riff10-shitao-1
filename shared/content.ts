// Every tunable number lives here: tick rate, round timings, economy,
// movement and the weapons. Units are metres, seconds and radians; money is
// whole dollars. docs/DECISIONS.md says why each of these was picked.
import type { Side } from "./map.ts";

/** 32 simulation ticks a second: see docs/DECISIONS.md, "Tick rate". */
export const TICK_HZ = 32;
export const TICK_MS = 1000 / TICK_HZ;
export const TICK_S = 1 / TICK_HZ;
export const secs = (s: number): number => Math.round(s * TICK_HZ);

export const MAX_PLAYERS = 10;
/** remembered identities per room, connected or not */
export const MAX_IDENTITIES = 24;
export const MAX_BOTS = 8;

// ---- round structure -------------------------------------------------------
export const ROUNDS_TO_WIN = 7;
export const HALF_ROUNDS = 6;
export const MAX_ROUNDS = HALF_ROUNDS * 2;
export const FREEZE_S = 8;
export const ROUND_S = 100;
export const BUY_AFTER_FREEZE_S = 15;
export const OVER_S = 5;
export const HALFTIME_S = 8;
export const WARMUP_RESPAWN_S = 2;
export const BOMB_S = 40;
export const PLANT_S = 3;
export const DEFUSE_S = 10;
export const DEFUSE_KIT_S = 5;
/** how close a CT has to stand to the bomb to defuse it, and a T to pick it up */
export const DEFUSE_RANGE = 1.5;
export const PICKUP_RANGE = 1.1;
/** bomb blast: full damage at the bomb, nothing past the radius, through walls */
export const BOMB_DAMAGE = 500;
export const BOMB_RADIUS = 17;

// ---- economy ---------------------------------------------------------------
export const START_MONEY = 800;
export const WARMUP_MONEY = 16000;
export const MAX_MONEY = 16000;
export const WIN_REWARD = 3250;
export const OBJECTIVE_WIN_REWARD = 3500;
/** loss bonus: LOSS_BASE + LOSS_STEP per previous straight loss, up to LOSS_MAX_STREAK */
export const LOSS_BASE = 1400;
export const LOSS_STEP = 500;
export const LOSS_MAX_STREAK = 4;
export const PLANT_TEAM_BONUS = 800;
export const PLANT_REWARD = 300;
export const DEFUSE_REWARD = 300;

export const lossBonus = (streak: number): number => LOSS_BASE + LOSS_STEP * Math.min(Math.max(streak - 1, 0), LOSS_MAX_STREAK);

// ---- bodies and movement ---------------------------------------------------
export const RADIUS = 0.32;
export const EYE_STAND = 1.62;
export const EYE_CROUCH = 1.15;
export const BODY_STAND = 1.42;
export const BODY_CROUCH = 0.98;
export const HEAD_R = 0.17;
/** below this height a hit is a leg hit */
export const LEG_TOP = 0.75;
export const LEG_MULT = 0.75;
export const WALK_MULT = 0.52;
export const CROUCH_MULT = 0.34;
/** m/s² towards the wished velocity, starting and stopping alike */
export const ACCEL = 38;
export const SWITCH_S = 0.45;

// ---- weapons ---------------------------------------------------------------
export type WeaponId = "knife" | "p9" | "deagle" | "vex" | "ak" | "m5";
export type Slot = "primary" | "secondary" | "knife";
export const SLOTS: readonly Slot[] = ["primary", "secondary", "knife"];

export interface WeaponDef {
  id: WeaponId;
  name: string;
  slot: Slot;
  /** only this side can buy it */
  side?: Side;
  cost: number;
  damage: number;
  headMult: number;
  /** share of damage that reaches health through armour */
  armourPen: number;
  /** seconds between shots */
  rate: number;
  auto: boolean;
  mag: number;
  reserve: number;
  reload: number;
  /** running speed in m/s while it's in hand */
  speed: number;
  /** metres; also the knife's reach */
  range: number;
  /** damage kept per 10 m travelled */
  falloff: number;
  /** inaccuracy in radians: standing, crouched, and added at full running speed */
  spread: number;
  crouchSpread: number;
  moveSpread: number;
  /** spray: how far the pattern climbs (rad) and how wide it sways once it tops out */
  climb: number;
  sway: number;
  /** seconds of not firing to recover one shot of spray */
  recovery: number;
  killReward: number;
  blurb: string;
}

export const WEAPONS: Record<WeaponId, WeaponDef> = {
  knife: {
    id: "knife", name: "Knife", slot: "knife", cost: 0, damage: 40, headMult: 1, armourPen: 0.85, rate: 0.5, auto: true,
    mag: 0, reserve: 0, reload: 0, speed: 5.4, range: 1.7, falloff: 1, spread: 0, crouchSpread: 0, moveSpread: 0,
    climb: 0, sway: 0, recovery: 0.1, killReward: 1500, blurb: "Three hits, or two and a pistol round.",
  },
  p9: {
    id: "p9", name: "P9", slot: "secondary", cost: 200, damage: 30, headMult: 4, armourPen: 0.5, rate: 0.16, auto: false,
    mag: 12, reserve: 36, reload: 2.2, speed: 5.0, range: 120, falloff: 0.85, spread: 0.006, crouchSpread: 0.004, moveSpread: 0.03,
    climb: 0.03, sway: 0.01, recovery: 0.12, killReward: 300, blurb: "The pistol everyone spawns with. One tap to the head without a helmet.",
  },
  deagle: {
    id: "deagle", name: "Hand cannon", slot: "secondary", cost: 700, damage: 54, headMult: 4, armourPen: 0.9, rate: 0.27, auto: false,
    mag: 7, reserve: 28, reload: 2.2, speed: 4.9, range: 140, falloff: 0.88, spread: 0.005, crouchSpread: 0.004, moveSpread: 0.06,
    climb: 0.07, sway: 0.01, recovery: 0.3, killReward: 300, blurb: "One shot to the head through a helmet. Punishes moving.",
  },
  vex: {
    id: "vex", name: "Vex SMG", slot: "primary", cost: 1200, damage: 25, headMult: 4, armourPen: 0.6, rate: 0.075, auto: true,
    mag: 30, reserve: 120, reload: 2.3, speed: 5.0, range: 70, falloff: 0.7, spread: 0.009, crouchSpread: 0.007, moveSpread: 0.018,
    climb: 0.06, sway: 0.03, recovery: 0.06, killReward: 600, blurb: "Cheap, fast and accurate on the move. Falls off at range. Double kill reward.",
  },
  ak: {
    id: "ak", name: "AR-7", slot: "primary", side: "T", cost: 2700, damage: 36, headMult: 4, armourPen: 0.78, rate: 0.1, auto: true,
    mag: 30, reserve: 90, reload: 2.5, speed: 4.3, range: 160, falloff: 0.98, spread: 0.004, crouchSpread: 0.003, moveSpread: 0.07,
    climb: 0.11, sway: 0.04, recovery: 0.1, killReward: 300, blurb: "The T rifle. One headshot kills through a helmet. Kicks hard after five shots.",
  },
  m5: {
    id: "m5", name: "M5 carbine", slot: "primary", side: "CT", cost: 3100, damage: 33, headMult: 4, armourPen: 0.7, rate: 0.09, auto: true,
    mag: 30, reserve: 90, reload: 2.9, speed: 4.5, range: 160, falloff: 0.97, spread: 0.0035, crouchSpread: 0.0025, moveSpread: 0.06,
    climb: 0.085, sway: 0.03, recovery: 0.09, killReward: 300, blurb: "The CT rifle. Softer spray than the AR-7, but a helmet saves a head hit.",
  },
};
export const WEAPON_IDS = Object.keys(WEAPONS) as WeaponId[];
export const isWeapon = (v: unknown): v is WeaponId => typeof v === "string" && v in WEAPONS;

export type GearId = "vest" | "helmet" | "kit";
export const GEAR: Record<GearId, { name: string; cost: number; side?: Side; blurb: string }> = {
  vest: { name: "Kevlar vest", cost: 650, blurb: "100 armour: body hits take far less health." },
  helmet: { name: "Vest + helmet", cost: 1000, blurb: "Armour on the head too (350 if you already have a full vest)." },
  kit: { name: "Defuse kit", cost: 400, side: "CT", blurb: "Defuse in 5 seconds instead of 10." },
};
export const HELMET_ONLY = 350;
export type BuyItem = WeaponId | GearId;
export const BUY_ITEMS: readonly BuyItem[] = ["p9", "deagle", "vex", "ak", "m5", "vest", "helmet", "kit"];
export const isBuyItem = (v: unknown): v is BuyItem => typeof v === "string" && (BUY_ITEMS as readonly string[]).includes(v);

/** Where the n-th shot of a spray goes, relative to the aim: [pitch up, yaw right]. */
export function sprayOffset(w: WeaponDef, n: number): [number, number] {
  if (n <= 0) return [0, 0];
  const pitch = w.climb * (1 - Math.exp(-n / 4));
  // once it's climbed, it sways left then right
  const sway = n < 5 ? 0 : w.sway * Math.sin((n - 5) * 0.55) * Math.min(1, (n - 4) / 4);
  return [pitch, sway];
}

/** Inaccuracy in radians for a shot taken at this speed and stance. */
export function inaccuracy(w: WeaponDef, speed: number, crouch: boolean): number {
  const frac = Math.min(1, speed / w.speed);
  // below a third of full speed counts as still: the reward for counter-strafing
  const moving = Math.max(0, (frac - 0.34) / 0.66);
  return (crouch ? w.crouchSpread : w.spread) + w.moveSpread * moving;
}

export const PING_KINDS = ["here", "enemy", "help"] as const;
export type PingKind = (typeof PING_KINDS)[number];
