// The browser's side of the protocol. Holds the latest authoritative state
// (mutated in place, read by the renderer every frame) and a version counter
// the HUD polls at a few hertz, so React never sees per-entity updates.
//
// Own movement is predicted with the server's own step function and
// reconciled by replaying every input the server hasn't acknowledged yet;
// everyone else is drawn a few ticks in the past, interpolated between
// server updates. Shots are never predicted as hits: the browser shows a
// muzzle flash, and the server says what it struck.
import { PROTOCOL_VERSION, type ClientMsg, type Command, type Delta, type Fx, type Input, type Motion, type ServerMsg, type Snapshot } from "../shared/protocol.ts";
import { TICK_HZ, TICK_MS } from "../shared/content.ts";
import { moveFor } from "../shared/sim.ts";
import { step } from "../shared/physics.ts";
import type { RoomState } from "../shared/protocol.ts";

export type Status = "connecting" | "live" | "reconnecting" | "error";

interface Sample {
  tick: number;
  x: number;
  z: number;
  yaw: number;
  pitch: number;
  crouch: boolean;
}

export interface Toast {
  id: number;
  text: string;
  kind: "info" | "bad";
}

/** how far behind the newest update other players are drawn, in ticks */
export const INTERP_TICKS = 3;
const PENDING_LIMIT = 32;

export class GameClient {
  state: Snapshot | null = null;
  you = "";
  inc = "";
  status: Status = "connecting";
  error = "";
  version = 0;
  rtt = 0;
  toasts: Toast[] = [];
  samples = new Map<string, Sample[]>();
  /** predicted own body; the camera reads this */
  me = { x: 0, z: 0, vx: 0, vz: 0, crouch: false };
  /** visual offset left over from a correction, eased away over a few frames */
  err = { x: 0, z: 0 };
  /** fired for every effect the server reports */
  onFx: ((fx: Fx) => void) | null = null;
  onAck: ((ok: boolean, c: Command, reason?: string) => void) | null = null;

  private ws: WebSocket | null = null;
  private seq = 0;
  private nextId = 1;
  private inputSeq = 0;
  private unacked: Input[] = [];
  private pending = new Map<string, Command>();
  private retry = 0;
  private closed = false;
  private toastId = 0;
  private pingTimer: ReturnType<typeof setInterval> | null = null;
  /** newest server tick heard, and when (performance.now) */
  private heardTick = 0;
  private heardAt = 0;

  readonly room: string;
  readonly name: string;

  constructor(room: string, name: string) {
    this.room = room;
    this.name = name;
  }

  get token(): string | null {
    return localStorage.getItem(`kiln:token:${this.room}`);
  }

  connect(): void {
    this.closed = false;
    const proto = location.protocol === "https:" ? "wss" : "ws";
    const ws = new WebSocket(`${proto}://${location.host}/ws`);
    this.ws = ws;
    ws.onopen = () => {
      this.retry = 0;
      this.raw({ t: "hello", v: PROTOCOL_VERSION, room: this.room, token: this.token ?? undefined, name: this.name });
    };
    ws.onmessage = (e) => this.receive(JSON.parse(e.data as string) as ServerMsg);
    ws.onclose = (e) => {
      if (this.pingTimer) clearInterval(this.pingTimer);
      this.pingTimer = null;
      if (this.closed) return;
      if (e.code === 4001) {
        this.fail("This match is open in another tab.");
        return;
      }
      if (this.status === "error") return;
      this.status = "reconnecting";
      this.bump();
      // back off: 0.5s, 1s, 2s ... capped at 8s
      setTimeout(() => this.connect(), Math.min(8000, 500 * 2 ** this.retry++));
    };
  }

  close(): void {
    this.closed = true;
    this.ws?.close();
  }

  private fail(msg: string): void {
    this.status = "error";
    this.error = msg;
    this.bump();
  }

  private raw(m: ClientMsg): void {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(m));
  }

  bump(): void {
    this.version++;
  }

  toast(text: string, kind: Toast["kind"] = "info"): void {
    const t = { id: ++this.toastId, text, kind };
    this.toasts = [...this.toasts.filter((x) => x.text !== text).slice(-2), t];
    this.bump();
    setTimeout(() => {
      this.toasts = this.toasts.filter((x) => x.id !== t.id);
      this.bump();
    }, 3000);
  }

  send(c: Command): void {
    if (!this.state || this.status !== "live") return;
    if (this.pending.size >= PENDING_LIMIT) return this.toast("Waiting for the server…", "bad");
    const id = `${this.inc}-${this.nextId++}`;
    this.pending.set(id, c);
    this.raw({ t: "cmd", id, inc: this.inc, c });
  }

  /** The server tick we're drawing other players at: a little behind our estimate of now. */
  viewTick(): number {
    const now = this.heardTick + ((performance.now() - this.heardAt) / 1000) * TICK_HZ;
    return Math.min(now, this.heardTick + 2) - INTERP_TICKS;
  }

  /** One fixed tick of our own intent: sent to the server and applied locally at once. */
  input(f: number, r: number, yaw: number, pitch: number, b: number): void {
    const s = this.state;
    if (!s || this.status !== "live") return;
    const inp: Input = { s: ++this.inputSeq, f, r, yaw, pitch, b, vt: Math.round(this.viewTick() * 100) / 100 };
    this.raw({ t: "in", ...inp });
    this.unacked.push(inp);
    if (this.unacked.length > 64) this.unacked.shift();
    this.predict(inp);
  }

  private predict(inp: Input): void {
    const s = this.state;
    const p = s?.players[this.you];
    if (!s || !p || !p.alive) return;
    p.crouch = (inp.b & 4) !== 0;
    this.me.crouch = p.crouch;
    step(this.me, moveFor(s as RoomState, p, inp));
  }

  private receive(m: ServerMsg): void {
    switch (m.t) {
      case "welcome": {
        const fresh = this.inc !== m.inc;
        if (this.inc && fresh && this.pending.size) this.toast("The server restarted; your last action may not have gone through.", "bad");
        this.inc = m.inc;
        this.you = m.you;
        this.state = m.snap;
        this.seq = m.snap.seq;
        this.heardTick = m.snap.tick;
        this.heardAt = performance.now();
        localStorage.setItem(`kiln:token:${this.room}`, m.token);
        if (fresh) this.pending.clear();
        this.samples.clear();
        const me = m.snap.players[m.you];
        if (me) {
          // inputs continue from what the server has seen, so a reconnect's first input isn't discarded as old
          this.inputSeq = Math.max(this.inputSeq, me.ack);
          this.unacked = [];
          this.me = { x: me.x, z: me.z, vx: me.vx, vz: me.vz, crouch: me.crouch };
        }
        for (const p of Object.values(m.snap.players)) this.sample(p.id, m.snap.tick, p.x, p.z, p.yaw, p.pitch, p.crouch);
        this.status = "live";
        if (!this.pingTimer) this.pingTimer = setInterval(() => this.raw({ t: "ping", n: performance.now() }), 2000);
        this.bump();
        break;
      }
      case "delta":
        this.apply(m);
        break;
      case "ack": {
        const c = this.pending.get(m.id);
        this.pending.delete(m.id);
        if (!m.ok) this.toast(m.reason ?? "That didn't work.", "bad");
        if (c) this.onAck?.(m.ok, c, m.reason);
        break;
      }
      case "error":
        if (m.reason === "no such room" || m.reason === "this room is full" || m.reason.startsWith("this page is out of date")) this.fail(m.reason);
        else this.toast(m.reason, "bad");
        break;
      case "pong":
        this.rtt = Math.round(performance.now() - m.n);
        break;
    }
  }

  private apply(d: Delta): void {
    const s = this.state;
    if (!s) return;
    if (d.seq !== this.seq + 1) {
      // a gap: ask for a fresh snapshot rather than guess
      if (d.seq > this.seq) this.raw({ t: "sync" });
      return;
    }
    this.seq = d.seq;
    s.seq = d.seq;
    s.tick = d.tick;
    this.heardTick = d.tick;
    this.heardAt = performance.now();
    let changed = false;
    for (const p of d.players ?? []) {
      const was = s.players[p.id];
      s.players[p.id] = p;
      if (p.id === this.you && was && was.alive !== p.alive) this.me = { x: p.x, z: p.z, vx: 0, vz: 0, crouch: false };
      changed = true;
    }
    for (const id of d.gone ?? []) {
      delete s.players[id];
      this.samples.delete(id);
      changed = true;
    }
    for (const mv of d.moves ?? []) this.move(mv, d.tick);
    if (d.meta) {
      Object.assign(s, d.meta);
      changed = true;
    }
    for (const fx of d.fx ?? []) this.onFx?.(fx);
    if (changed || d.fx) this.bump();
  }

  private move([id, x, z, vx, vz, yaw, pitch, crouch, ack]: Motion, tick: number): void {
    const s = this.state!;
    const p = s.players[id];
    if (!p) return;
    Object.assign(p, { x, z, vx, vz, crouch: crouch === 1, ack });
    if (id !== this.you) {
      Object.assign(p, { yaw, pitch });
      this.sample(id, tick, x, z, yaw, pitch, crouch === 1);
      return;
    }
    // reconcile: start from the server's answer and replay what it hasn't seen yet
    const before = { x: this.me.x, z: this.me.z };
    this.unacked = this.unacked.filter((i) => i.s > ack);
    this.me = { x, z, vx, vz, crouch: crouch === 1 };
    for (const inp of this.unacked) this.predict(inp);
    const ex = before.x - this.me.x;
    const ez = before.z - this.me.z;
    if (Math.hypot(ex, ez) > 2) this.err = { x: 0, z: 0 };
    else this.err = { x: this.err.x + ex, z: this.err.z + ez };
  }

  private sample(id: string, tick: number, x: number, z: number, yaw: number, pitch: number, crouch: boolean): void {
    const buf = this.samples.get(id) ?? [];
    if (buf.length && buf[buf.length - 1].tick >= tick) buf.pop();
    buf.push({ tick, x, z, yaw, pitch, crouch });
    while (buf.length > 20) buf.shift();
    this.samples.set(id, buf);
  }

  /** Where another player is drawn: interpolated at the view tick, the same tick our shots are judged against. */
  pose(id: string): Sample | null {
    const buf = this.samples.get(id);
    if (!buf?.length) return null;
    const t = this.viewTick();
    if (t <= buf[0].tick) return buf[0];
    for (let i = buf.length - 1; i > 0; i--) {
      const a = buf[i - 1];
      const b = buf[i];
      if (a.tick <= t) {
        const k = Math.min(1, (t - a.tick) / Math.max(1, b.tick - a.tick));
        let dy = b.yaw - a.yaw;
        if (dy > Math.PI) dy -= Math.PI * 2;
        if (dy < -Math.PI) dy += Math.PI * 2;
        return { tick: t, x: a.x + (b.x - a.x) * k, z: a.z + (b.z - a.z) * k, yaw: a.yaw + dy * k, pitch: a.pitch + (b.pitch - a.pitch) * k, crouch: k < 0.5 ? a.crouch : b.crouch };
      }
    }
    return buf[buf.length - 1];
  }

  /** seconds left on a phase clock */
  secondsTo(tick: number): number {
    const s = this.state;
    if (!s) return 0;
    const now = this.heardTick + ((performance.now() - this.heardAt) / 1000) * TICK_HZ;
    return Math.max(0, (tick - now) / TICK_HZ);
  }
}

export { TICK_MS };
