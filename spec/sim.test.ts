import { describe, expect, it } from "vitest";
import {
  BOMB_S,
  DEFUSE_KIT_S,
  DEFUSE_S,
  FREEZE_S,
  HALF_ROUNDS,
  LOSS_BASE,
  LOSS_STEP,
  MAX_MONEY,
  OBJECTIVE_WIN_REWARD,
  OVER_S,
  PLANT_S,
  PLANT_TEAM_BONUS,
  ROUNDS_TO_WIN,
  ROUND_S,
  START_MONEY,
  TICK_HZ,
  WEAPONS,
  WIN_REWARD,
  lossBonus,
  secs,
} from "../shared/content.ts";
import { CELL, MAP, walkable } from "../shared/map.ts";
import { aimDir, step, wishVelocity } from "../shared/physics.ts";
import { CROUCH, FIRE, USE, type Input, type Player, type RoomState } from "../shared/protocol.ts";
import {
  MAX_REWIND,
  afterArmour,
  applyCommand,
  applyInput,
  cleanInput,
  createRoom,
  join,
  leave,
  moveFor,
  newChanges,
  newCtx,
  rawDamage,
  sideOf,
  teamOf,
  tick,
  type Changes,
  type TickCtx,
} from "../shared/sim.ts";

// The simulation with no browser or socket. Inputs go in through the same
// TickCtx hook the server uses; nothing here reaches into the state to fake
// an outcome except to stage positions.

interface World {
  s: RoomState;
  ch: Changes;
  ctx: TickCtx;
  queue: Map<string, Input[]>;
  seq: Map<string, number>;
  events: Changes["events"];
}

function world(seed = 7, fill = 0): World {
  const s = createRoom("TESTS", seed, fill);
  const queue = new Map<string, Input[]>();
  const w: World = { s, ch: newChanges(), ctx: newCtx((p) => queue.get(p.id)?.splice(0, 1) ?? []), queue, seq: new Map(), events: [] };
  return w;
}

function run(w: World, ticks: number): void {
  for (let i = 0; i < ticks; i++) {
    tick(w.s, w.ch, w.ctx);
    w.events.push(...w.ch.events);
    w.ch = newChanges();
  }
}

function add(w: World, id: string, side: "T" | "CT"): Player {
  const p = join(w.s, id, `tok-${id}`, id, w.ch)!;
  applyCommand(w.s, id, `side-${id}`, { k: "side", side }, w.ch);
  return w.s.players[id] ?? p;
}

/** Queue one input for a player: aim at a yaw/pitch, buttons, optional movement. */
function press(w: World, id: string, inp: Partial<Input> = {}): void {
  const n = (w.seq.get(id) ?? 0) + 1;
  w.seq.set(id, n);
  const p = w.s.players[id];
  const q = w.queue.get(id) ?? [];
  q.push({ s: n, f: 0, r: 0, yaw: p.yaw, pitch: p.pitch, b: 0, vt: w.s.tick, ...inp });
  w.queue.set(id, q);
}

/** Into a live round, both sides populated, freeze time over. */
function live(w: World): void {
  const host = w.s.hostId!;
  expect(applyCommand(w.s, host, "go", { k: "start" }, w.ch)).toEqual({ ok: true });
  run(w, secs(3) + 1);
  expect(w.s.phase.k).toBe("freeze");
  run(w, secs(FREEZE_S) + 1);
  expect(w.s.phase.k).toBe("live");
}

/** Stand two players facing each other down an open stretch of mid. */
function faceOff(w: World, a: string, b: string, dist: number): void {
  // column 16 of mid is open floor from row 12 to row 20
  const x = 16.5 * CELL;
  const z0 = 12.5 * CELL;
  Object.assign(w.s.players[a], { x, z: z0 + dist, vx: 0, vz: 0, yaw: 0, pitch: 0 });
  Object.assign(w.s.players[b], { x, z: z0, vx: 0, vz: 0, yaw: Math.PI, pitch: 0 });
  // let the lag-compensation history see them there: the server judges shots where the shooter last saw the target
  run(w, 2);
}

/** The pitch from a's eye to a height on b. */
const pitchTo = (dist: number, eye: number, y: number): number => Math.atan2(y - eye, dist);

describe("the map", () => {
  it("every open cell is reachable from both spawns, and both sites and spawns are on it", () => {
    const start = MAP.spawns.T[0];
    const seen = new Set<number>();
    const q = [Math.floor(start.z / CELL) * MAP.cols + Math.floor(start.x / CELL)];
    while (q.length) {
      const i = q.pop()!;
      if (seen.has(i)) continue;
      seen.add(i);
      const c = i % MAP.cols;
      const r = Math.floor(i / MAP.cols);
      for (const [dc, dr] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) if (walkable(c + dc, r + dr)) q.push((r + dr) * MAP.cols + c + dc);
    }
    let open = 0;
    for (let r = 0; r < MAP.rows; r++) for (let c = 0; c < MAP.cols; c++) if (walkable(c, r)) open++;
    expect(seen.size).toBe(open);
    expect(MAP.spawns.T.length).toBeGreaterThanOrEqual(5);
    expect(MAP.spawns.CT.length).toBeGreaterThanOrEqual(5);
    for (const sp of [...MAP.spawns.T, ...MAP.spawns.CT]) expect(walkable(Math.floor(sp.x / CELL), Math.floor(sp.z / CELL))).toBe(true);
  });
});

describe("movement", () => {
  it("can't walk through a wall, and slides along it", () => {
    // B door's corridor: walk north into the wall above it
    const b = { x: 9.5 * CELL, z: 3.6 * CELL, vx: 0, vz: 0 };
    for (let i = 0; i < 20; i++) step(b, wishVelocity(1, 1, 0, 5));
    expect(walkable(Math.floor(b.x / CELL), Math.floor(b.z / CELL))).toBe(true);
    expect(b.z).toBeGreaterThanOrEqual(3 * CELL);
    // it kept moving east along the wall rather than sticking
    expect(b.x).toBeGreaterThan(9.5 * CELL + 1);
  });

  it("the browser's prediction and the server agree exactly, input for input", () => {
    const w = world();
    add(w, "a", "T");
    add(w, "b", "CT");
    live(w);
    const p = w.s.players.a;
    const predicted = { x: p.x, z: p.z, vx: p.vx, vz: p.vz };
    const inputs: Input[] = [];
    for (let i = 0; i < 90; i++) inputs.push({ s: i + 1, f: i < 60 ? 1 : 0, r: i % 20 < 10 ? 1 : -1, yaw: 0.3 + i * 0.01, pitch: 0, b: i > 70 ? CROUCH : 0, vt: 0 });
    for (const inp of inputs) {
      const q = w.queue.get("a") ?? [];
      q.push(inp);
      w.queue.set("a", q);
      run(w, 1);
      step(predicted, moveFor(w.s, w.s.players.a, inp));
    }
    expect(predicted.x).toBe(w.s.players.a.x);
    expect(predicted.z).toBe(w.s.players.a.z);
  });

  it("freeze time holds everyone still", () => {
    const w = world();
    add(w, "a", "T");
    add(w, "b", "CT");
    applyCommand(w.s, w.s.hostId!, "go", { k: "start" }, w.ch);
    run(w, secs(3) + 2);
    expect(w.s.phase.k).toBe("freeze");
    const { x, z } = w.s.players.a;
    for (let i = 0; i < 30; i++) press(w, "a", { f: 1 });
    run(w, 30);
    expect([w.s.players.a.x, w.s.players.a.z]).toEqual([x, z]);
  });
});

describe("hits are the server's call", () => {
  it("a shot aimed at a body hits it; the same shot aimed past misses", () => {
    const w = world();
    add(w, "a", "T");
    add(w, "b", "CT");
    live(w);
    faceOff(w, "a", "b", 8);
    press(w, "a", { yaw: 0, pitch: pitchTo(8, 1.62, 1.1), b: FIRE });
    run(w, 1);
    expect(w.s.players.b.hp).toBeLessThan(100);
    const hp = w.s.players.b.hp;
    run(w, 10);
    press(w, "a", { yaw: 0.4, pitch: 0, b: FIRE });
    run(w, 1);
    expect(w.s.players.b.hp).toBe(hp);
  });

  it("a wall between shooter and target stops the shot", () => {
    const w = world();
    add(w, "a", "T");
    add(w, "b", "CT");
    live(w);
    // a in mid, b behind the solid block west of mid (cell column 12 is wall at row 12)
    Object.assign(w.s.players.a, { x: 15.5 * CELL, z: 12.5 * CELL, yaw: Math.PI / 2, pitch: 0 });
    Object.assign(w.s.players.b, { x: 4 * CELL, z: 12.5 * CELL });
    press(w, "a", { yaw: Math.PI / 2, pitch: pitchTo(30, 1.62, 1.1), b: FIRE });
    run(w, 1);
    expect(w.s.players.b.hp).toBe(100);
  });

  it("there is no command that reports damage: a client claiming a hit changes nothing", () => {
    const w = world();
    add(w, "a", "T");
    add(w, "b", "CT");
    live(w);
    for (const c of [{ k: "hit", on: "b", dmg: 100 }, { k: "damage", target: "b" }, { k: "kill", victim: "b" }])
      expect(applyCommand(w.s, "a", JSON.stringify(c), c, w.ch).ok).toBe(false);
    expect(w.s.players.b.hp).toBe(100);
    expect(w.s.players.b.alive).toBe(true);
  });

  it("a headshot from the starting pistol kills an unhelmeted player outright, and a helmet saves them", () => {
    const w = world();
    add(w, "a", "T");
    add(w, "b", "CT");
    live(w);
    faceOff(w, "a", "b", 6);
    press(w, "a", { yaw: 0, pitch: pitchTo(6, 1.62, 1.42 + 0.15), b: FIRE });
    run(w, 1);
    expect(w.s.players.b.alive).toBe(false);
    expect(w.s.feed.at(-1)).toMatchObject({ killer: "a", victim: "b", weapon: "p9", head: true });
    expect(w.events.some((e) => e.action === "kill" && e.actor === "a" && e.victim === "b" && e.head === true)).toBe(true);
    // the arithmetic: 30 × 4 = 120 > 100 bare; with a helmet, half of it goes through
    expect(afterArmour(rawDamage(WEAPONS.p9, 6, "head"), WEAPONS.p9.armourPen, 100, true, "head")[0]).toBeLessThan(100);
    expect(afterArmour(rawDamage(WEAPONS.ak, 6, "head"), WEAPONS.ak.armourPen, 100, true, "head")[0]).toBeGreaterThanOrEqual(100);
  });

  it("damage falls off with distance, and armour soaks body hits but not legs", () => {
    expect(rawDamage(WEAPONS.vex, 40, "body")).toBeLessThan(rawDamage(WEAPONS.vex, 5, "body"));
    const [hp, ar] = afterArmour(36, 0.78, 100, false, "body");
    expect(hp).toBe(28);
    expect(ar).toBeGreaterThan(0);
    expect(afterArmour(36, 0.78, 100, true, "legs")).toEqual([36, 0]);
  });

  it("shots are judged where the shooter saw the target (lag compensation), but never more than MAX_REWIND back", () => {
    const w = world();
    add(w, "a", "T");
    add(w, "b", "CT");
    live(w);
    faceOff(w, "a", "b", 10);
    // b strafes east at full speed for a while; a's view lags 6 ticks behind
    for (let i = 0; i < 20; i++) press(w, "b", { r: -1, yaw: Math.PI });
    run(w, 20);
    const t = w.s.tick;
    const old = w.ctx.lag.frames.get(t - 6)!.get("b")!;
    const aimAtOld = Math.atan2(-(old[0] - w.s.players.a.x), -(old[1] - w.s.players.a.z));
    // aimed at where b was 6 ticks ago, with a view tick that says so: a hit
    press(w, "a", { yaw: aimAtOld, pitch: pitchTo(10, 1.62, 1.1), b: FIRE, vt: t - 6 + 1 });
    run(w, 1);
    expect(w.s.players.b.hp).toBeLessThan(100);
    // the same aim claiming a view far older than MAX_REWIND is clamped, and misses the now-distant body
    const hp = w.s.players.b.hp;
    for (let i = 0; i < 20; i++) press(w, "b", { r: -1, yaw: Math.PI });
    run(w, 20);
    run(w, 4);
    const far = w.ctx.lag.frames.get(w.s.tick - MAX_REWIND - 20)?.get("b");
    expect(far).toBeUndefined();
    press(w, "a", { yaw: aimAtOld, pitch: pitchTo(10, 1.62, 1.1), b: FIRE, vt: 0 });
    run(w, 1);
    expect(w.s.players.b.hp).toBe(hp);
  });

  it("a shooter aiming at a strafing target exactly where their screen showed it hits, at round trips up to 200 ms", () => {
    // the client draws others 3 ticks behind the newest update, and its input reaches the server half a round trip later
    for (const rtt of [0, 100, 200]) {
      const oneWay = Math.round(rtt / 2 / (1000 / TICK_HZ));
      let hits = 0;
      for (let k = 0; k < 10; k++) {
        const w = world(k + 1);
        add(w, "a", "T");
        add(w, "b", "CT");
        live(w);
        faceOff(w, "a", "b", 8 + k);
        Object.assign(w.s.players.b, { x: 15.5 * CELL });
        for (let i = 0; i < 30; i++) press(w, "b", { r: -1, yaw: Math.PI });
        run(w, 30);
        const view = w.s.tick - oneWay - 3;
        const seen = w.ctx.lag.frames.get(view)!.get("b")!;
        const a = w.s.players.a;
        const yaw = Math.atan2(-(seen[0] - a.x), -(seen[1] - a.z));
        const pitch = Math.atan2(1.0 - 1.62, Math.hypot(seen[0] - a.x, seen[1] - a.z));
        for (let i = 0; i <= oneWay; i++) press(w, "b", { r: -1, yaw: Math.PI });
        run(w, oneWay);
        press(w, "a", { yaw, pitch, b: FIRE, vt: view });
        run(w, 1);
        if (w.s.players.b.hp < 100) hits++;
      }
      expect(hits, `round trip ${rtt} ms`).toBe(10);
    }
  });

  it("holding fire can't shoot faster than the gun, and a semi-automatic needs a fresh press each shot", () => {
    const w = world();
    add(w, "a", "T");
    add(w, "b", "CT");
    live(w);
    faceOff(w, "a", "b", 30);
    w.s.players.a.yaw = 0.6; // aim at nothing
    // the pistol, trigger held for a second: one shot
    for (let i = 0; i < TICK_HZ; i++) press(w, "a", { yaw: 0.6, b: FIRE });
    run(w, TICK_HZ);
    expect(w.s.players.a.ammo.p9!.mag).toBe(11);
    // tapped as fast as inputs allow: no faster than its rate
    for (let i = 0; i < TICK_HZ; i++) press(w, "a", { yaw: 0.6, b: i % 2 ? 0 : FIRE });
    run(w, TICK_HZ);
    const fired = 11 - w.s.players.a.ammo.p9!.mag;
    expect(fired).toBeLessThanOrEqual(Math.ceil(1 / WEAPONS.p9.rate));
    expect(fired).toBeGreaterThan(3);
  });

  it("a full-auto rifle fires at its cadence and its spray climbs", () => {
    const w = world();
    add(w, "a", "T");
    add(w, "b", "CT");
    live(w);
    w.s.players.a.money = 5000;
    // still in the buy window, in spawn
    expect(applyCommand(w.s, "a", "buy-ak", { k: "buy", item: "ak" }, w.ch)).toEqual({ ok: true });
    run(w, secs(0.5));
    const shots: number[] = [];
    for (let i = 0; i < TICK_HZ; i++) press(w, "a", { yaw: 0.2, pitch: 0.05, b: FIRE });
    for (let i = 0; i < TICK_HZ; i++) {
      run(w, 1);
      shots.push(w.s.players.a.ammo.ak!.mag);
    }
    const fired = 30 - w.s.players.a.ammo.ak!.mag;
    expect(fired).toBeGreaterThanOrEqual(Math.floor(1 / WEAPONS.ak.rate) - 1);
    expect(fired).toBeLessThanOrEqual(Math.ceil(1 / WEAPONS.ak.rate) + 1);
    expect(w.s.players.a.spray).toBeGreaterThan(5);
  });

  it("an empty magazine reloads from reserve after the reload time, and only then fires again", () => {
    const w = world();
    add(w, "a", "T");
    add(w, "b", "CT");
    live(w);
    w.s.players.a.ammo.p9 = { mag: 0, reserve: 5 };
    press(w, "a", { yaw: 1, b: FIRE });
    run(w, 1);
    expect(w.s.players.a.reloading).toBe(true);
    run(w, secs(WEAPONS.p9.reload) + 1);
    expect(w.s.players.a.ammo.p9).toEqual({ mag: 5, reserve: 0 });
  });
});

describe("the round", () => {
  it("runs warmup, freeze, live, over and the next freeze, with a fresh spawn each round", () => {
    const w = world();
    add(w, "a", "T");
    add(w, "b", "CT");
    expect(w.s.phase.k).toBe("warmup");
    live(w);
    expect(w.s.round).toBe(0);
    Object.assign(w.s.players.a, { x: 15 * CELL, z: 12 * CELL });
    run(w, secs(ROUND_S) + 1);
    expect(w.s.phase).toMatchObject({ k: "over", result: { side: "CT", how: "time" } });
    expect(w.s.score[teamOf(w.s, "CT")]).toBe(1);
    run(w, secs(OVER_S) + 1);
    expect(w.s.phase.k).toBe("freeze");
    expect(w.s.round).toBe(1);
    const sp = MAP.spawns.T.map((p) => `${p.x},${p.z}`);
    expect(sp).toContain(`${w.s.players.a.x},${w.s.players.a.z}`);
  });

  it("eliminating the other side wins the round, and pays kill, win and loss money", () => {
    const w = world();
    add(w, "a", "T");
    add(w, "b", "CT");
    live(w);
    const [ma, mb] = [w.s.players.a.money, w.s.players.b.money];
    faceOff(w, "a", "b", 5);
    press(w, "a", { yaw: 0, pitch: pitchTo(5, 1.62, 1.57), b: FIRE });
    run(w, 1);
    expect(w.s.phase).toMatchObject({ k: "over", result: { side: "T", how: "elimination" } });
    expect(w.s.players.a.money).toBe(ma + WEAPONS.p9.killReward + WIN_REWARD);
    expect(w.s.players.b.money).toBe(mb + LOSS_BASE);
  });

  it("the loss bonus climbs with each straight loss, up to its cap", () => {
    expect([1, 2, 3, 4, 5, 6, 9].map(lossBonus)).toEqual([1400, 1900, 2400, 2900, 3400, 3400, 3400]);
    expect(lossBonus(2)).toBe(LOSS_BASE + LOSS_STEP);
  });

  it("swaps sides at the half with money reset, and ends the match at seven", () => {
    const w = world();
    add(w, "a", "T");
    add(w, "b", "CT");
    live(w);
    const aTeam = w.s.players.a.team!;
    const bTeam = w.s.players.b.team!;
    for (let r = 0; r < HALF_ROUNDS; r++) {
      // CTs (b) win every first-half round on time
      if (w.s.phase.k === "freeze") run(w, secs(FREEZE_S) + 1);
      run(w, secs(ROUND_S) + 1);
      expect(w.s.phase.k).toBe("over");
      run(w, secs(OVER_S) + 1);
    }
    expect(w.s.score[bTeam]).toBe(HALF_ROUNDS);
    expect(w.s.phase.k).toBe("halftime");
    run(w, secs(10));
    expect(sideOf(w.s, aTeam)).toBe("CT");
    expect(sideOf(w.s, bTeam)).toBe("T");
    expect(w.s.players.a.money).toBe(START_MONEY);
    expect(w.s.players.a.primary).toBeNull();
    // b, now a T, wins the seventh round by elimination, and with it the match
    expect(w.s.phase.k).toBe("freeze");
    run(w, secs(FREEZE_S) + 1);
    faceOff(w, "b", "a", 5);
    press(w, "b", { yaw: 0, pitch: pitchTo(5, 1.62, 1.57), b: FIRE });
    run(w, 1);
    expect(w.s.score[bTeam]).toBe(ROUNDS_TO_WIN);
    run(w, secs(OVER_S) + 1);
    expect(w.s.phase).toEqual({ k: "ended", winner: bTeam });
    expect(w.events.some((e) => e.action === "match_end")).toBe(true);
    // the ending is permanent: nothing moves on
    const before = JSON.stringify([w.s.score, w.s.phase, w.s.round]);
    run(w, secs(30));
    expect(JSON.stringify([w.s.score, w.s.phase, w.s.round])).toBe(before);
  });

  it("twelve rounds split six and six is a draw", () => {
    const w = world();
    add(w, "a", "T");
    add(w, "b", "CT");
    live(w);
    for (let r = 0; r < HALF_ROUNDS * 2 && w.s.phase.k !== "ended"; r++) {
      if (w.s.phase.k === "halftime") run(w, secs(10));
      if (w.s.phase.k === "freeze") run(w, secs(FREEZE_S) + 1);
      run(w, secs(ROUND_S) + 1);
      run(w, secs(OVER_S) + 1);
    }
    expect(w.s.score).toEqual([6, 6]);
    expect(w.s.phase).toEqual({ k: "ended", winner: null });
  });
});

describe("the bomb", () => {
  function carrier(w: World): string {
    const b = w.s.bomb;
    expect(b.k).toBe("carried");
    return b.k === "carried" ? b.by : "";
  }

  it("plants only inside a site, after holding use for the plant time, and pays the planter", () => {
    const w = world();
    add(w, "a", "T");
    add(w, "b", "CT");
    live(w);
    expect(carrier(w)).toBe("a");
    // outside a site: nothing
    for (let i = 0; i < secs(PLANT_S) + 4; i++) press(w, "a", { b: USE });
    run(w, secs(PLANT_S) + 4);
    expect(w.s.bomb.k).toBe("carried");
    Object.assign(w.s.players.a, { x: MAP.sites.A.cx, z: MAP.sites.A.cz + 2 });
    Object.assign(w.s.players.b, { x: 15 * CELL, z: 20 * CELL });
    const money = w.s.players.a.money;
    // letting go early cancels
    for (let i = 0; i < secs(1); i++) press(w, "a", { b: USE });
    press(w, "a", { b: 0 });
    run(w, secs(1) + 1);
    expect(w.s.players.a.act).toBeNull();
    for (let i = 0; i < secs(PLANT_S) + 2; i++) press(w, "a", { b: USE });
    run(w, secs(PLANT_S) + 2);
    expect(w.s.bomb).toMatchObject({ k: "planted", site: "A" });
    expect(w.s.players.a.money).toBe(money + 300);
  });

  it("explodes after the bomb timer and wins for T, even with every T dead", () => {
    const w = world();
    add(w, "a", "T");
    add(w, "b", "CT");
    live(w);
    Object.assign(w.s.players.a, { x: MAP.sites.B.cx, z: MAP.sites.B.cz });
    Object.assign(w.s.players.b, { x: 15 * CELL, z: 22 * CELL });
    for (let i = 0; i < secs(PLANT_S) + 2; i++) press(w, "a", { b: USE });
    run(w, secs(PLANT_S) + 2);
    expect(w.s.bomb.k).toBe("planted");
    // the T dies after the plant; the round goes on
    w.s.players.a.hp = 1;
    faceOff(w, "b", "a", 5);
    Object.assign(w.s.players.a, { x: MAP.sites.B.cx, z: MAP.sites.B.cz });
    w.s.players.a.alive = false;
    run(w, 2);
    expect(w.s.phase.k).toBe("live");
    const bMoney = w.s.players.b.money;
    run(w, secs(BOMB_S));
    expect(w.s.phase).toMatchObject({ k: "over", result: { side: "T", how: "bomb" } });
    expect(w.s.players.a.money).toBeGreaterThanOrEqual(OBJECTIVE_WIN_REWARD);
    expect(w.s.players.b.money).toBe(bMoney + LOSS_BASE);
  });

  it("a CT defuses in ten seconds, five with a kit, and wins the round; the losing Ts still get the plant bonus", () => {
    for (const kit of [false, true]) {
      const w = world(kit ? 3 : 4);
      add(w, "a", "T");
      add(w, "b", "CT");
      live(w);
      Object.assign(w.s.players.a, { x: MAP.sites.A.cx, z: MAP.sites.A.cz });
      for (let i = 0; i < secs(PLANT_S) + 2; i++) press(w, "a", { b: USE });
      run(w, secs(PLANT_S) + 2);
      expect(w.s.bomb.k).toBe("planted");
      // the T steps away, the CT stands on the bomb
      Object.assign(w.s.players.a, { x: 15 * CELL, z: 24 * CELL });
      Object.assign(w.s.players.b, { x: w.s.players.a.x, z: w.s.players.a.z });
      const bomb = w.s.bomb;
      if (bomb.k !== "planted") throw new Error("not planted");
      Object.assign(w.s.players.b, { x: bomb.x + 0.5, z: bomb.z, kit });
      const aMoney = w.s.players.a.money;
      const need = secs(kit ? DEFUSE_KIT_S : DEFUSE_S);
      for (let i = 0; i < need - 3; i++) press(w, "b", { b: USE });
      run(w, need - 3);
      expect(w.s.bomb.k).toBe("planted");
      for (let i = 0; i < 6; i++) press(w, "b", { b: USE });
      run(w, 6);
      expect(w.s.bomb.k).toBe("defused");
      expect(w.s.phase).toMatchObject({ k: "over", result: { side: "CT", how: "defuse" } });
      expect(w.s.players.a.money).toBe(Math.min(MAX_MONEY, aMoney + LOSS_BASE + PLANT_TEAM_BONUS));
    }
  });

  it("a dead carrier drops the bomb, and a T walking over it picks it up", () => {
    const w = world();
    add(w, "a", "T");
    add(w, "c", "T");
    add(w, "b", "CT");
    live(w);
    const by = carrier(w);
    const other = by === "a" ? "c" : "a";
    faceOff(w, by, "b", 5);
    Object.assign(w.s.players[other], { x: 2 * CELL, z: 22 * CELL });
    press(w, "b", { yaw: Math.PI, pitch: pitchTo(5, 1.62, 1.57), b: FIRE });
    run(w, 1);
    expect(w.s.players[by].alive).toBe(false);
    expect(w.s.bomb.k).toBe("dropped");
    const d = w.s.bomb;
    if (d.k !== "dropped") throw new Error("not dropped");
    Object.assign(w.s.players[other], { x: d.x, z: d.z });
    run(w, 1);
    expect(w.s.bomb).toEqual({ k: "carried", by: other });
  });
});

describe("buying", () => {
  it("only in your own spawn, during the buy window, with the money, and only your side's rifle", () => {
    const w = world();
    add(w, "a", "T");
    add(w, "b", "CT");
    live(w);
    expect(applyCommand(w.s, "a", "1", { k: "buy", item: "ak" }, w.ch)).toMatchObject({ ok: false, reason: expect.stringContaining("needs $2700") });
    expect(applyCommand(w.s, "a", "2", { k: "buy", item: "m5" }, w.ch)).toMatchObject({ ok: false, reason: expect.stringContaining("CT only") });
    expect(applyCommand(w.s, "a", "3", { k: "buy", item: "kit" }, w.ch)).toMatchObject({ ok: false });
    expect(applyCommand(w.s, "a", "4", { k: "buy", item: "vest" }, w.ch)).toEqual({ ok: true });
    expect(w.s.players.a.money).toBe(START_MONEY - 650);
    expect(w.s.players.a.armour).toBe(100);
    expect(applyCommand(w.s, "a", "5", { k: "buy", item: "rocket" }, w.ch).ok).toBe(false);
    expect(applyCommand(w.s, "b", "6", { k: "buy", item: "kit" }, w.ch)).toEqual({ ok: true });
    // out of spawn
    Object.assign(w.s.players.b, { x: 15 * CELL, z: 12 * CELL });
    expect(applyCommand(w.s, "b", "7", { k: "buy", item: "vest" }, w.ch)).toMatchObject({ ok: false, reason: "buy in your spawn" });
    // after the buy window
    run(w, secs(20));
    expect(applyCommand(w.s, "a", "8", { k: "buy", item: "p9" }, w.ch)).toMatchObject({ ok: false });
    expect(applyCommand(w.s, "a", "9", { k: "buy", item: "deagle" }, w.ch)).toMatchObject({ ok: false, reason: "the buy time is over" });
    for (const p of Object.values(w.s.players)) expect(p.money).toBeGreaterThanOrEqual(0);
  });

  it("a resent command id applies once", () => {
    const w = world();
    add(w, "a", "T");
    add(w, "b", "CT");
    live(w);
    applyCommand(w.s, "a", "same", { k: "buy", item: "vest" }, w.ch);
    applyCommand(w.s, "a", "same", { k: "buy", item: "vest" }, w.ch);
    expect(w.s.players.a.money).toBe(START_MONEY - 650);
  });

  it("someone who dies loses their gear; a survivor keeps it into the next round", () => {
    const w = world();
    add(w, "a", "T");
    add(w, "b", "CT");
    live(w);
    applyCommand(w.s, "a", "v", { k: "buy", item: "vest" }, w.ch);
    faceOff(w, "a", "b", 5);
    press(w, "a", { yaw: 0, pitch: pitchTo(5, 1.62, 1.57), b: FIRE });
    run(w, 1);
    run(w, secs(OVER_S) + 2);
    expect(w.s.players.a.armour).toBe(100);
    expect(w.s.players.b.secondary).toBe("p9");
    expect(w.s.players.b.armour).toBe(0);
  });
});

describe("players and seats", () => {
  it("newcomers are balanced onto the smaller side; a full side refuses a switch", () => {
    const w = world();
    const teams = ["a", "b", "c", "d"].map((id) => join(w.s, id, id, id, w.ch)!.team);
    expect(teams.filter((t) => t === 0)).toHaveLength(2);
    for (let i = 0; i < 6; i++) join(w.s, `x${i}`, `x${i}`, `x${i}`, w.ch);
    const t0 = Object.values(w.s.players).filter((p) => p.team === 0).length;
    expect(t0).toBe(5);
    const onOne = Object.values(w.s.players).find((p) => p.team === 1)!;
    expect(applyCommand(w.s, onOne.id, "sw", { k: "side", side: sideOf(w.s, 0) }, w.ch)).toMatchObject({ ok: false, reason: "that side is full" });
    expect(join(w.s, "late", "late", "late", w.ch)).toBeNull();
  });

  it("a dropped player keeps their seat, side, money and gear, and gets them back on rejoin", () => {
    const w = world();
    add(w, "a", "T");
    add(w, "b", "CT");
    live(w);
    applyCommand(w.s, "a", "v", { k: "buy", item: "vest" }, w.ch);
    const before = { team: w.s.players.a.team, money: w.s.players.a.money, armour: w.s.players.a.armour };
    leave(w.s, "a", w.ch);
    expect(w.s.players.a.connected).toBe(false);
    run(w, 10);
    const back = join(w.s, "a", "tok-a", "a", w.ch)!;
    expect({ team: back.team, money: back.money, armour: back.armour }).toEqual(before);
    expect(back.alive).toBe(true);
  });

  it("a returning player whose side filled up meanwhile goes to the other side, or is told the room is full", () => {
    const w = world();
    for (const id of ["a", "b", "c", "d", "e"]) add(w, id, "T");
    leave(w.s, "a", w.ch);
    add(w, "f", "T");
    const back = join(w.s, "a", "tok-a", "a", w.ch)!;
    expect(sideOf(w.s, back.team!)).toBe("CT");
    for (const id of ["g", "h", "i", "j"]) add(w, id, "CT");
    leave(w.s, "b", w.ch);
    add(w, "k", "T");
    expect(join(w.s, "b", "tok-b", "b", w.ch)).toBeNull();
    for (const t of [0, 1] as const) expect(Object.values(w.s.players).filter((p) => p.team === t && p.connected).length).toBeLessThanOrEqual(5);
  });

  it("names are stripped of control characters and capped", () => {
    const w = world();
    const p = join(w.s, "n", "n", "\u0007Ada‮Lovelace-the-very-long-name", w.ch)!;
    expect(p.name).toBe("AdaLovelace-the-");
  });

  it("bots fill each side to the host's number, give way to people, and only the host can change it", () => {
    const w = world(5, 3);
    add(w, "a", "T");
    const bots = (t: number): number => Object.values(w.s.players).filter((p) => p.bot && p.team === t).length;
    expect(bots(w.s.players.a.team!)).toBe(2);
    expect(bots(1 - w.s.players.a.team!)).toBe(3);
    add(w, "b", "CT");
    expect(applyCommand(w.s, "b", "x", { k: "bots", per: 5 }, w.ch)).toMatchObject({ ok: false });
    expect(applyCommand(w.s, "a", "y", { k: "bots", per: 1 }, w.ch)).toEqual({ ok: true });
    expect(Object.values(w.s.players).filter((p) => p.bot)).toHaveLength(0);
    expect(applyCommand(w.s, "a", "z", { k: "bots", per: 9 }, w.ch).ok).toBe(false);
  });
});

describe("robustness", () => {
  it("refuses malformed inputs field by field", () => {
    const good = { s: 5, f: 1, r: -1, yaw: 1, pitch: 0, b: 1, vt: 10 };
    expect(cleanInput(good, 4)).not.toBeNull();
    for (const bad of [{ s: 4 }, { s: 5.5 }, { f: 2 }, { r: "1" }, { yaw: Infinity }, { pitch: NaN }, { b: 16 }, { b: -1 }, { vt: null }, { s: { valueOf: () => 9 } }])
      expect(cleanInput({ ...good, ...bad } as Record<string, unknown>, 4)).toBeNull();
    expect(cleanInput({ ...good, pitch: 9 }, 4)!.pitch).toBe(1.5);
  });

  it("refuses malformed and unauthorised commands", () => {
    const w = world();
    add(w, "a", "T");
    add(w, "b", "CT");
    for (const c of [null, 5, "buy", { k: 5 }, { k: "ping", kind: "here", x: "1", z: 2 }, { k: "ping", kind: "nuke", x: 1, z: 1 }, { k: "slot", slot: "rocket" }, { k: "side", side: "spectator" }])
      expect(applyCommand(w.s, "a", `m${JSON.stringify(c)}`, c, w.ch).ok).toBe(false);
    expect(applyCommand(w.s, "b", "start", { k: "start" }, w.ch).ok).toBe(false);
    expect(applyCommand(w.s, "nobody", "x", { k: "reload" }, w.ch).ok).toBe(false);
  });

  it("a whole match of bots ends with everyone's money in bounds and every round accounted for", () => {
    const w = world(11, 5);
    add(w, "h", "T");
    applyCommand(w.s, "h", "go", { k: "start" }, w.ch);
    run(w, secs(4));
    w.s.players.h.connected = false;
    const seen = new Set<string>();
    for (let i = 0; i < secs(60 * 40) && w.s.phase.k !== "ended"; i++) {
      run(w, 1);
      for (const p of Object.values(w.s.players)) {
        expect(p.money).toBeGreaterThanOrEqual(0);
        expect(p.money).toBeLessThanOrEqual(MAX_MONEY);
        expect(p.hp).toBeGreaterThanOrEqual(0);
      }
      seen.add(w.s.phase.k);
    }
    expect(w.s.phase.k).toBe("ended");
    expect(w.s.history.length).toBe(w.s.score[0] + w.s.score[1]);
    expect(seen).toContain("halftime");
    expect(w.events.filter((e) => e.action === "kill").length).toBeGreaterThan(10);
  }, 30_000);

  it("a state saved mid-round and reloaded plays on identically", () => {
    const a = world(21, 4);
    add(a, "h", "T");
    applyCommand(a.s, "h", "go", { k: "start" }, a.ch);
    run(a, secs(4));
    a.s.players.h.connected = false;
    run(a, secs(25));
    const b = world(21, 4);
    b.s = JSON.parse(JSON.stringify(a.s));
    // bots' memories aren't saved: give both the same fresh start from here
    a.ctx = newCtx(a.ctx.inputs);
    b.ctx = newCtx(b.ctx.inputs);
    run(a, secs(20));
    run(b, secs(20));
    expect(JSON.stringify(b.s)).toBe(JSON.stringify(a.s));
  });

  it("aimDir agrees with the movement convention: yaw 0 is north, positive yaw turns left", () => {
    const r = (v: number): number => Math.round(v) + 0;
    const [x, , z] = aimDir(0, 0);
    expect([r(x), r(z)]).toEqual([0, -1]);
    const [lx, , lz] = aimDir(Math.PI / 2, 0);
    expect([r(lx), r(lz)]).toEqual([-1, 0]);
    const [wx, wz] = wishVelocity(1, 0, Math.PI / 2, 1);
    expect([r(wx), r(wz)]).toEqual([-1, 0]);
    void applyInput;
  });
});
