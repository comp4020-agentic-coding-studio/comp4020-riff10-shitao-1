import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, inject, it } from "vitest";
import WebSocket from "ws";
import type { Command, Delta, Motion, ServerMsg, Snapshot } from "../shared/protocol.ts";
import { PROTOCOL_VERSION } from "../shared/protocol.ts";

// The real server over HTTP and WebSocket: what a browser actually talks to.
const baseUrl = inject("baseUrl");

class Client {
  ws: WebSocket;
  msgs: ServerMsg[] = [];
  snap: Snapshot | null = null;
  inc = "";
  you = "";
  token = "";
  seq = 0;
  private waiters: (() => void)[] = [];
  private n = 0;

  constructor(url: string, origin: string) {
    this.ws = new WebSocket(url.replace(/^http/, "ws") + "/ws", { headers: { origin } });
    this.ws.on("message", (raw) => {
      const m = JSON.parse(raw.toString()) as ServerMsg;
      this.msgs.push(m);
      if (m.t === "welcome") {
        this.snap = m.snap;
        this.inc = m.inc;
        this.you = m.you;
        this.token = m.token;
      }
      if (m.t === "delta" && this.snap) {
        for (const p of m.players ?? []) this.snap.players[p.id] = p;
        for (const [id, x, z] of (m.moves ?? []) as Motion[]) Object.assign(this.snap.players[id] ?? {}, { x, z });
        if (m.meta) Object.assign(this.snap, m.meta);
      }
      for (const w of this.waiters.splice(0)) w();
    });
  }

  open(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.ws.once("open", () => resolve());
      this.ws.once("error", reject);
    });
  }

  send(m: unknown): void {
    this.ws.send(JSON.stringify(m));
  }

  hello(room: string, name: string, token?: string): void {
    this.send({ t: "hello", v: PROTOCOL_VERSION, room, name, token });
  }

  cmd(c: Command | Record<string, unknown>, id = `t${this.n++}`, inc = this.inc): string {
    this.send({ t: "cmd", id, inc, c });
    return id;
  }

  input(f: number, r: number, yaw: number, b = 0): void {
    this.send({ t: "in", s: ++this.seq, f, r, yaw, pitch: 0, b, vt: this.snap?.tick ?? 0 });
  }

  async until(pred: (m: ServerMsg) => boolean, ms = 3000): Promise<ServerMsg> {
    const deadline = Date.now() + ms;
    let seen = 0;
    for (;;) {
      for (; seen < this.msgs.length; seen++) if (pred(this.msgs[seen])) return this.msgs[seen];
      if (Date.now() > deadline) throw new Error("timed out waiting for a message");
      await new Promise<void>((r) => {
        this.waiters.push(r);
        setTimeout(r, 100);
      });
    }
  }

  close(): void {
    this.ws.close();
  }
}

const originOf = (url: string): string => new URL(url).origin;
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

async function newRoom(url: string, bots = 0): Promise<string> {
  const res = await fetch(new URL("/api/rooms", url), { method: "POST", headers: { origin: originOf(url), "content-type": "application/json" }, body: JSON.stringify({ bots }) });
  expect(res.status).toBe(201);
  return ((await res.json()) as { code: string }).code;
}

async function joined(url: string, room: string, name: string, token?: string): Promise<Client> {
  const c = new Client(url, originOf(url));
  await c.open();
  c.hello(room, name, token);
  await c.until((m) => m.t === "welcome");
  return c;
}

describe("pages", () => {
  it("serves the app shell, the play screen and a health check", async () => {
    for (const p of ["/", "/play/"]) expect((await fetch(new URL(p, baseUrl))).status).toBe(200);
    const h = (await (await fetch(new URL("/api/health", baseUrl))).json()) as { ok: boolean };
    expect(h.ok).toBe(true);
  });

  it("refuses to create a room from another site, and refuses a foreign WebSocket", async () => {
    const res = await fetch(new URL("/api/rooms", baseUrl), { method: "POST", headers: { origin: "https://evil.example" }, body: "{}" });
    expect(res.status).toBe(403);
    const ws = new WebSocket(baseUrl.replace(/^http/, "ws") + "/ws", { headers: { origin: "https://evil.example" } });
    await expect(
      new Promise((resolve, reject) => {
        ws.once("open", resolve);
        ws.once("error", reject);
      }),
    ).rejects.toThrow();
  });

  it("refuses to be framed", async () => {
    const res = await fetch(new URL("/", baseUrl));
    expect(res.headers.get("x-frame-options")).toBe("DENY");
  });
});

describe("real time", () => {
  it("one player's movement reaches another open session within a second, without a reload", async () => {
    const room = await newRoom(baseUrl);
    const a = await joined(baseUrl, room, "Ada");
    const b = await joined(baseUrl, room, "Bo");
    await sleep(200);
    const start = { ...b.snap!.players[a.you] };
    const sent = Date.now();
    for (let i = 0; i < 12; i++) {
      a.input(1, 0, a.snap!.players[a.you].yaw);
      await sleep(30);
    }
    await b.until((m) => m.t === "delta" && !!(m as Delta).moves?.some(([id, x, z]) => id === a.you && Math.hypot(x - start.x, z - start.z) > 0.3), 1000);
    expect(Date.now() - sent).toBeLessThan(1000);
    a.close();
    b.close();
  });

  it("puts two strangers on opposite sides, and a returning browser gets its own seat back", async () => {
    const room = await newRoom(baseUrl);
    const a = await joined(baseUrl, room, "Ada");
    const b = await joined(baseUrl, room, "Bo");
    expect(a.snap!.players[a.you].team).not.toBe(b.snap!.players[b.you].team);
    const { you, token } = a;
    const team = b.snap!.players[a.you].team;
    a.close();
    await sleep(200);
    const again = await joined(baseUrl, room, "Ada", token);
    expect(again.you).toBe(you);
    expect(again.snap!.players[you].team).toBe(team);
    const stranger = await joined(baseUrl, room, "Mallory", "not-a-real-token");
    expect(stranger.you).not.toBe(you);
    again.close();
    b.close();
    stranger.close();
  });

  it("a resent command applies once, and a stale incarnation is refused with a fresh snapshot", async () => {
    const room = await newRoom(baseUrl);
    const a = await joined(baseUrl, room, "Ada");
    // callouts are limited to one a second, so a second application would be refused: a resend is acknowledged without applying
    a.cmd({ k: "ping", kind: "here", x: 40, z: 30 }, "dup-1");
    expect(await a.until((m) => m.t === "ack" && m.id === "dup-1")).toMatchObject({ ok: true });
    a.cmd({ k: "ping", kind: "here", x: 40, z: 30 }, "dup-1");
    await a.until(() => a.msgs.filter((q) => q.t === "ack" && q.id === "dup-1").length === 2);
    expect(a.msgs.filter((q) => q.t === "ack" && q.id === "dup-1").every((q) => q.t === "ack" && q.ok)).toBe(true);
    a.cmd({ k: "ping", kind: "here", x: 40, z: 30 }, "new-1");
    expect(await a.until((m) => m.t === "ack" && m.id === "new-1")).toMatchObject({ ok: false, reason: "one callout a second" });
    await sleep(200);
    const pings = a.msgs.flatMap((m) => (m.t === "delta" ? (m.fx ?? []) : [])).filter((f) => f.k === "ping");
    expect(pings).toHaveLength(1);
    const welcomes = a.msgs.filter((m) => m.t === "welcome").length;
    a.cmd({ k: "reload" }, "stale-1", "not-this-incarnation");
    const ack = await a.until((m) => m.t === "ack" && m.id === "stale-1");
    expect(ack).toMatchObject({ ok: false });
    await a.until(() => a.msgs.filter((m) => m.t === "welcome").length > welcomes);
    a.close();
  });

  it("only the server says what a shot did: there is no message that deals damage", async () => {
    const room = await newRoom(baseUrl);
    const a = await joined(baseUrl, room, "Ada");
    const b = await joined(baseUrl, room, "Bo");
    for (const c of [{ k: "hit", on: b.you, dmg: 500 }, { k: "kill", victim: b.you }]) {
      const id = a.cmd(c);
      expect(await a.until((m) => m.t === "ack" && m.id === id)).toMatchObject({ ok: false, reason: "unknown command" });
    }
    a.send({ t: "damage", on: b.you, dmg: 500 });
    await a.until((m) => m.t === "error" && m.reason === "unknown message");
    await sleep(200);
    expect(b.snap!.players[b.you].hp).toBe(100);
    a.close();
    b.close();
  });

  it("a flood of inputs can't move a player faster than one input a tick", async () => {
    const room = await newRoom(baseUrl);
    const a = await joined(baseUrl, room, "Ada");
    await joined(baseUrl, room, "Bo");
    const p0 = { ...a.snap!.players[a.you] };
    // 60 inputs at once: the server spends at most one per tick (plus a small bank), so 300 ms moves at most ~0.3 s worth
    for (let i = 0; i < 60; i++) a.input(1, 0, p0.yaw);
    await sleep(300);
    const p1 = a.snap!.players[a.you];
    expect(Math.hypot(p1.x - p0.x, p1.z - p0.z)).toBeLessThan(5.4 * 0.6);
    a.close();
  });

  it("survives messages built to throw when coerced, oversized and malformed messages", async () => {
    const room = await newRoom(baseUrl);
    const a = await joined(baseUrl, room, "Ada");
    a.send({ t: "cmd", id: { toString: 1 }, inc: "stale", c: { k: "reload" } });
    a.send({ t: "ping", n: { toString: 1 } });
    a.send({ t: "in", s: { valueOf: 1 }, f: 1, r: 0, yaw: 0, pitch: 0, b: 0, vt: 0 });
    await a.until((m) => m.t === "pong");
    a.cmd({ k: "buy", item: { toString: 1 } }, "x");
    await a.until((m) => m.t === "ack" && m.id === "x" && !m.ok);
    a.ws.send("{not json");
    await a.until((m) => m.t === "error" && m.reason === "malformed message");
    // past the payload cap the socket itself is refused (1009), and the room carries on
    const closed = new Promise<number>((r) => a.ws.once("close", (code) => r(code)));
    a.ws.send(JSON.stringify({ t: "ping", n: 1, pad: "x".repeat(4000) }));
    expect(await closed).toBe(1009);
    expect((await fetch(new URL("/api/health", baseUrl))).status).toBe(200);
    const b = await joined(baseUrl, room, "Bo");
    expect(Object.keys(b.snap!.players)).toContain(a.you);
    expect(b.snap!.players[a.you].connected).toBe(false);
    b.close();
  });
});

describe("persistence and the action log", () => {
  // A private server against its own data directory, so it can be killed and its stdout read.
  const dir = mkdtempSync(join(tmpdir(), "kiln-"));
  const procs: ChildProcess[] = [];
  const port = 18000 + Math.floor(Math.random() * 1000);
  const url = `http://localhost:${port}`;
  let out = "";

  async function boot(): Promise<ChildProcess> {
    const p = spawn(process.execPath, ["server/main.ts"], { env: { ...process.env, PORT: String(port), DATA_DIR: dir }, stdio: ["ignore", "pipe", "ignore"] });
    p.stdout!.on("data", (d) => (out += d.toString()));
    procs.push(p);
    for (let i = 0; i < 100; i++) {
      try {
        await fetch(new URL("/api/health", url));
        return p;
      } catch {
        await sleep(100);
      }
    }
    throw new Error("server didn't start");
  }
  const stop = (p: ChildProcess, signal: NodeJS.Signals): Promise<void> =>
    new Promise((r) => {
      p.once("exit", () => r());
      p.kill(signal);
    });

  afterAll(() => {
    for (const p of procs) p.kill("SIGKILL");
    rmSync(dir, { recursive: true, force: true });
  });

  it("a match in progress survives a restart: score, side, money and gear come back under a new incarnation", async () => {
    let p = await boot();
    const room = await newRoom(url, 2);
    const a = await joined(url, room, "Ada");
    a.cmd({ k: "start" }, "go");
    await a.until((m) => m.t === "ack" && m.id === "go" && m.ok);
    // the match starts three seconds later, into the first buy phase
    await a.until((m) => m.t === "delta" && m.meta?.phase.k === "freeze", 6000);
    a.cmd({ k: "buy", item: "vest" }, "vest");
    await a.until((m) => m.t === "ack" && m.id === "vest" && m.ok);
    await sleep(300);
    const before = a.snap!.players[a.you];
    const { token, you, inc } = a;
    await stop(p, "SIGTERM");
    p = await boot();
    const back = await joined(url, room, "Ada", token);
    expect(back.you).toBe(you);
    expect(back.inc).not.toBe(inc);
    const me = back.snap!.players[you];
    expect({ team: me.team, money: me.money, armour: me.armour }).toEqual({ team: before.team, money: before.money, armour: before.armour });
    expect(back.snap!.round).toBe(0);
    expect(["freeze", "live"]).toContain(back.snap!.phase.k);
    back.close();
    await stop(p, "SIGTERM");
  }, 30_000);

  it("prints who did what as one logfmt line per event, and never a token", async () => {
    const p = await boot();
    const room = await newRoom(url, 1);
    const a = await joined(url, room, "Ada");
    a.cmd({ k: "buy", item: "vest" }, "b1");
    a.cmd({ k: "ping", kind: "enemy", x: 40, z: 30 }, "p1");
    await a.until((m) => m.t === "ack" && m.id === "p1");
    await sleep(300);
    const lines = out.split("\n").filter((l) => l.includes(`room=${room}`));
    expect(lines.some((l) => l.includes(`actor=${a.you}`) && l.includes("name=Ada") && l.includes("action=join"))).toBe(true);
    expect(lines.some((l) => l.includes("name=Ada") && l.includes("action=buy") && l.includes("item=vest") && l.includes("cost=650"))).toBe(true);
    expect(lines.some((l) => l.includes("name=Ada") && l.includes("action=ping") && l.includes("kind=enemy"))).toBe(true);
    expect(lines.some((l) => /actor=bot-\d+ name=\w+ action=bot_join/.test(l))).toBe(true);
    for (const l of lines) expect(l).toMatch(/^room=\w{5} round=\d+ tick=\d+ actor=\S+ name=\S+ action=\w+/);
    expect(out).not.toContain(a.token);
    a.close();
    await stop(p, "SIGTERM");
  }, 30_000);
});
