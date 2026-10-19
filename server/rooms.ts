// Live rooms: exactly one in-memory owner per room, inside this one process.
// Rooms with nobody connected pause (no ticks) and are unloaded after a
// minute, so a match never plays on without its people.
import { randomBytes, randomUUID } from "node:crypto";
import type { WebSocket } from "ws";
import { MAX_MESSAGE_BYTES, PROTOCOL_VERSION, type ClientMsg, type Delta, type Input, type Motion, type Player, type RoomState, type ServerMsg, type Snapshot } from "../shared/protocol.ts";
import { TICK_MS } from "../shared/content.ts";
import { applyCommand, cleanInput, createRoom, join, leave, newChanges, newCtx, tick, type Changes, type Ev, type TickCtx } from "../shared/sim.ts";
import { loadRoom, roomExists, saveRoom } from "./store.ts";

const SAVE_EVERY_MS = 5000;
const UNLOAD_AFTER_MS = 60_000;
const MAX_CATCHUP_TICKS = 4;
/** inputs queued per connection; a client further ahead than this loses the oldest */
const INPUT_QUEUE = 12;
/** a connection may spend at most one input per tick on average, banking up to this many */
const INPUT_BANK = 4;

interface Conn {
  ws: WebSocket;
  pid: string | null;
  tokens: number;
  lastRefill: number;
  lastInput: number;
}

interface LiveRoom {
  s: RoomState;
  /** fresh every time the room is loaded into memory: clients must resync on change */
  inc: string;
  conns: Set<Conn>;
  dirty: boolean;
  lastSave: number;
  emptySince: number | null;
  lastTickAt: number;
  sentPlayers: Map<string, string>;
  sentMoves: Map<string, string>;
  sentMeta: string;
  ch: Changes;
  ctx: TickCtx;
  queues: Map<string, Input[]>;
  bank: Map<string, number>;
}

const rooms = new Map<string, LiveRoom>();
export const stats = { tickMsMax: 0, tickMsLast: 0, bytesOut: 0, msgsIn: 0 };

const ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
export function createNewRoom(fill: number): string {
  let code = "";
  do {
    code = Array.from(randomBytes(5), (b) => ALPHABET[b % ALPHABET.length]).join("");
  } while (roomExists(code));
  saveRoom(createRoom(code, randomBytes(4).readUInt32LE(0), fill));
  return code;
}

function live(code: string): LiveRoom | null {
  let r = rooms.get(code);
  if (r) return r;
  const s = loadRoom(code);
  if (!s) return null;
  for (const p of Object.values(s.players)) {
    if (!p.bot) p.connected = false;
    p.vx = p.vz = 0;
    p.act = null;
    p.lastB = 0;
  }
  const queues = new Map<string, Input[]>();
  const bank = new Map<string, number>();
  const ctx = newCtx((p: Player) => {
    // one input a tick on average, a few banked to ride out jitter: a client can't move or fire faster by sending more
    const q = queues.get(p.id);
    let n = Math.min(INPUT_BANK, (bank.get(p.id) ?? 0) + 1);
    const out: Input[] = [];
    while (q?.length && n >= 1) {
      out.push(q.shift()!);
      n--;
    }
    bank.set(p.id, n);
    return out;
  });
  r = { s, inc: randomUUID().slice(0, 8), conns: new Set(), dirty: false, lastSave: Date.now(), emptySince: Date.now(), lastTickAt: Date.now(), sentPlayers: new Map(), sentMoves: new Map(), sentMeta: "", ch: newChanges(), ctx, queues, bank };
  rooms.set(code, r);
  return r;
}

const snapshot = (s: RoomState): Snapshot => {
  const { tokens: _t, receipts: _r, ...snap } = s;
  return snap;
};

function send(c: Conn, msg: ServerMsg): void {
  if (c.ws.readyState !== c.ws.OPEN) return;
  // a slow client whose buffer is backing up gets dropped rather than stall or bloat the room
  if (c.ws.bufferedAmount > 1_000_000) {
    c.ws.close(1013, "too far behind");
    return;
  }
  const text = JSON.stringify(msg);
  stats.bytesOut += text.length;
  c.ws.send(text);
}

function welcome(r: LiveRoom, c: Conn): void {
  if (!c.pid) return;
  send(c, { t: "welcome", v: PROTOCOL_VERSION, inc: r.inc, you: c.pid, token: r.s.tokens[c.pid], snap: snapshot(r.s) });
}

function save(r: LiveRoom): void {
  saveRoom(r.s);
  r.dirty = false;
  r.lastSave = Date.now();
}

const logValue = (v: string | number | boolean): string => {
  const t = String(v);
  return /^[\w.,:+-]+$/.test(t) ? t : JSON.stringify(t);
};

/**
 * The action log: one logfmt line per event, with the room, round, the
 * actor's id and display name, so `flyctl logs` alone tells the story of a
 * match. Tokens never appear here. The actor's own fields always win over an
 * event field of the same name.
 */
export function printEvents(s: RoomState, events: Ev[]): void {
  for (const e of events) {
    const { actor, name, action, ...rest } = e;
    const fields = Object.entries(rest)
      .filter(([k]) => !["room", "round", "tick", "actor", "name", "action"].includes(k))
      .map(([k, v]) => `${k}=${logValue(v)}`);
    console.log([`room=${s.code}`, `round=${s.round + (s.phase.k === "live" || s.phase.k === "freeze" ? 1 : 0)}`, `tick=${s.tick}`, `actor=${logValue(actor)}`, `name=${logValue(name)}`, `action=${action}`, ...fields].join(" "));
  }
}

const r3 = (v: number): number => Math.round(v * 1000) / 1000;

/** Turn accumulated changes into one delta for everyone. */
function flush(r: LiveRoom): void {
  const ch = r.ch;
  const s = r.s;
  if (ch.events.length) {
    printEvents(s, ch.events);
    ch.events = [];
  }
  // a round boundary is saved before anyone hears about it
  if (ch.boundary) save(r);
  // movement is most of the traffic: compact tuples, whole records only when something else changed
  const players: Player[] = [];
  const moves: Motion[] = [];
  for (const p of Object.values(s.players)) {
    const { x, z, vx, vz, yaw, pitch, crouch, ack, pc: _pc, lastB: _b, nextFire: _f, lastShot: _l, spray: _s, ...rest } = p;
    const full = JSON.stringify(rest);
    const motion: Motion = [p.id, r3(x), r3(z), r3(vx), r3(vz), r3(yaw), r3(pitch), crouch ? 1 : 0, ack];
    const key = motion.join(",");
    if (r.sentPlayers.get(p.id) !== full) {
      r.sentPlayers.set(p.id, full);
      players.push(p);
    }
    if (r.sentMoves.get(p.id) !== key) {
      r.sentMoves.set(p.id, key);
      moves.push(motion);
    }
  }
  for (const id of r.sentPlayers.keys()) if (!s.players[id]) r.sentPlayers.delete(id);
  for (const id of r.sentMoves.keys()) if (!s.players[id]) r.sentMoves.delete(id);
  let metaChanged = false;
  const meta = { phase: s.phase, round: s.round, half: s.half, score: s.score, losses: s.losses, history: s.history, bomb: s.bomb, fill: s.fill, hostId: s.hostId, feed: s.feed };
  if (ch.meta || ch.boundary) {
    const m = JSON.stringify(meta);
    metaChanged = m !== r.sentMeta;
    r.sentMeta = m;
  }
  const any = players.length || moves.length || ch.gone.length || ch.fx.length || metaChanged;
  r.ch = newChanges();
  if (!any) return;
  s.seq++;
  const d: Delta = { t: "delta", seq: s.seq, tick: s.tick };
  if (players.length) d.players = players;
  if (moves.length) d.moves = moves;
  if (ch.gone.length) d.gone = ch.gone;
  if (metaChanged) d.meta = meta;
  if (ch.fx.length) d.fx = ch.fx;
  r.dirty = true;
  for (const c of r.conns) if (c.pid) send(c, d);
}

export function stepAll(): void {
  const now = Date.now();
  const t0 = performance.now();
  for (const [code, r] of rooms) {
    if (r.conns.size === 0) {
      r.lastTickAt = now;
      if (r.dirty) save(r);
      if (r.emptySince && now - r.emptySince > UNLOAD_AFTER_MS) rooms.delete(code);
      continue;
    }
    // catch up after a stall, but never more than a few ticks
    let due = Math.floor((now - r.lastTickAt) / TICK_MS);
    if (due > MAX_CATCHUP_TICKS) {
      r.lastTickAt = now - MAX_CATCHUP_TICKS * TICK_MS;
      due = MAX_CATCHUP_TICKS;
    }
    if (due === 0) continue;
    try {
      for (let i = 0; i < due; i++) {
        tick(r.s, r.ch, r.ctx);
        r.lastTickAt += TICK_MS;
      }
      flush(r);
      if (r.dirty && now - r.lastSave > SAVE_EVERY_MS) save(r);
    } catch (err) {
      // one room's failure mustn't stop the others; it resumes from its last save on next load
      console.error(`room ${code}:`, err);
      for (const c of r.conns) c.ws.close(1011, "room error");
      rooms.delete(code);
    }
  }
  stats.tickMsLast = performance.now() - t0;
  stats.tickMsMax = Math.max(stats.tickMsMax, stats.tickMsLast);
}

export function saveAll(): void {
  for (const r of rooms.values()) save(r);
}

export const roomCount = (): number => rooms.size;

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

const perIp = new Map<string, number>();
// generous: a whole class on campus Wi-Fi can share one public address
const MAX_SOCKETS_PER_IP = 32;
/** messages a second per connection: 32 inputs plus commands, pings and slack */
const RATE = 60;
const BURST = 90;

export function attach(ws: WebSocket, ip: string): void {
  // one machine opening many sockets can't take every seat or multiply its rate limit
  const open = perIp.get(ip) ?? 0;
  if (open >= MAX_SOCKETS_PER_IP) {
    ws.close(1013, "too many connections from one address");
    return;
  }
  perIp.set(ip, open + 1);
  const c: Conn = { ws, pid: null, tokens: BURST, lastRefill: Date.now(), lastInput: -1 };
  let room: LiveRoom | null = null;
  const fail = (reason: string): void => send(c, { t: "error", reason });

  // a frame over the payload cap (or any protocol error) arrives here; without a listener it would crash every room
  ws.on("error", () => ws.terminate());

  ws.on("message", (raw, isBinary) => {
    // a throw in here would take every room down with it: contain it to this message
    try {
      onMessage(raw.toString(), isBinary);
    } catch (err) {
      console.error("message handler:", err);
      fail("server error");
    }
  });

  const onMessage = (text: string, isBinary: boolean): void => {
    stats.msgsIn++;
    const now = Date.now();
    c.tokens = Math.min(BURST, c.tokens + ((now - c.lastRefill) / 1000) * RATE);
    c.lastRefill = now;
    if (c.tokens < 1) return fail("slow down");
    c.tokens--;
    if (isBinary || text.length > MAX_MESSAGE_BYTES) return fail("message too large");
    let msg: ClientMsg;
    try {
      msg = JSON.parse(text);
    } catch {
      return fail("malformed message");
    }
    if (!isRecord(msg)) return fail("malformed message");

    if (msg.t === "hello") {
      if (room) return fail("already joined");
      if (msg.v !== PROTOCOL_VERSION) return fail("this page is out of date: reload it");
      if (typeof msg.room !== "string" || !/^[A-Z0-9]{5}$/.test(msg.room)) return fail("no such room");
      const r = live(msg.room);
      if (!r) return fail("no such room");
      const s = r.s;
      const pid = typeof msg.token === "string" ? Object.keys(s.tokens).find((id) => s.tokens[id] === msg.token) : undefined;
      if (pid) {
        // the same player opened a second tab: the newest wins
        for (const other of r.conns) if (other.pid === pid) other.ws.close(4001, "opened in another tab");
      }
      const id = pid ?? randomUUID().slice(0, 12);
      const token = pid ? s.tokens[pid] : randomBytes(18).toString("base64url");
      const p = join(s, id, token, typeof msg.name === "string" ? msg.name : "", r.ch);
      if (!p) return fail("this room is full");
      room = r;
      c.pid = id;
      // inputs are numbered from wherever the server last acknowledged this player
      c.lastInput = p.ack;
      r.queues.set(id, []);
      r.conns.add(c);
      r.emptySince = null;
      // pending changes go out first, so the snapshot is the exact boundary for later deltas
      flush(r);
      welcome(r, c);
      return;
    }
    if (!room || !c.pid) return fail("say hello first");
    if ((msg.t as string) === "in") {
      const inp = cleanInput(msg as unknown as Record<string, unknown>, c.lastInput);
      if (!inp) return;
      c.lastInput = inp.s;
      const q = room.queues.get(c.pid) ?? [];
      q.push(inp);
      if (q.length > INPUT_QUEUE) q.shift();
      room.queues.set(c.pid, q);
      return;
    }
    if (msg.t === "ping") return send(c, { t: "pong", n: typeof msg.n === "number" && Number.isFinite(msg.n) ? msg.n : 0 });
    if (msg.t === "sync") {
      flush(room);
      return welcome(room, c);
    }
    if (msg.t === "cmd") {
      if (typeof msg.id !== "string" || msg.id.length < 1 || msg.id.length > 40) return fail("malformed command");
      if (msg.inc !== room.inc) {
        send(c, { t: "ack", id: msg.id, ok: false, reason: "the server restarted: resyncing" });
        flush(room);
        return welcome(room, c);
      }
      const res = applyCommand(room.s, c.pid, msg.id, msg.c, room.ch);
      send(c, res.ok ? { t: "ack", id: msg.id, ok: true } : { t: "ack", id: msg.id, ok: false, reason: res.reason });
      return;
    }
    fail("unknown message");
  };

  ws.on("close", () => {
    const left = (perIp.get(ip) ?? 1) - 1;
    if (left <= 0) perIp.delete(ip);
    else perIp.set(ip, left);
    if (!room || !c.pid) return;
    room.conns.delete(c);
    const stillHere = [...room.conns].some((o) => o.pid === c.pid);
    if (!stillHere) {
      leave(room.s, c.pid, room.ch);
      room.queues.delete(c.pid);
    }
    flush(room);
    if (room.conns.size === 0) {
      room.emptySince = Date.now();
      save(room);
    }
  });
}

export const fillOf = (raw: unknown): number => (typeof raw === "number" && Number.isInteger(raw) && raw >= 0 && raw <= 5 ? raw : 0);
