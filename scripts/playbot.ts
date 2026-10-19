#!/usr/bin/env node
// A bot that joins a room over the real protocol, as a person's browser
// would: hello, pick a side, then one Input per tick from the same decisions
// the server's own seat-filling bots use (shared/bot.ts), and buys at the
// start of each round. It sees only what a browser sees (no tokens, no other
// player's secrets), so it's a fair second "person" for a solo playtest.
//
//   node scripts/playbot.ts <room> [baseUrl] [name] [T|CT]
import WebSocket from "ws";
import { TICK_MS } from "../shared/content.ts";
import { botBuys, botInput, type BotMem } from "../shared/bot.ts";
import { PROTOCOL_VERSION, type Motion, type RoomState, type ServerMsg, type Snapshot } from "../shared/protocol.ts";

const [room, base = "http://localhost:8080", name = "Playbot", side = "auto"] = process.argv.slice(2);
if (!room || !["T", "CT", "auto"].includes(side)) {
  console.error("usage: node scripts/playbot.ts <room> [baseUrl] [name] [T|CT]");
  process.exit(1);
}

const ws = new WebSocket(base.replace(/^http/, "ws") + "/ws", { headers: { origin: new URL(base).origin } });
let s: Snapshot | null = null;
let you = "";
let inc = "";
let n = 0;
let boughtRound = -1;
const mem: BotMem = { seq: 0, site: Math.random() < 0.5 ? "A" : "B" };

const cmd = (c: object): void => ws.send(JSON.stringify({ t: "cmd", id: `${name}-${n++}`, inc, c }));

ws.on("open", () => ws.send(JSON.stringify({ t: "hello", v: PROTOCOL_VERSION, room, name })));
ws.on("message", (raw) => {
  const m = JSON.parse(raw.toString()) as ServerMsg;
  if (m.t === "welcome") {
    const first = !s;
    s = m.snap;
    you = m.you;
    inc = m.inc;
    mem.seq = Math.max(mem.seq, s.players[you].ack);
    if (first && side !== "auto") cmd({ k: "side", side });
  } else if (m.t === "delta" && s) {
    if (m.seq !== s.seq + 1) {
      ws.send(JSON.stringify({ t: "sync" }));
      return;
    }
    s.seq = m.seq;
    s.tick = m.tick;
    for (const p of m.players ?? []) s.players[p.id] = p;
    for (const id of m.gone ?? []) delete s.players[id];
    for (const [id, x, z, vx, vz, yaw, pitch, crouch] of (m.moves ?? []) as Motion[]) if (s.players[id]) Object.assign(s.players[id], { x, z, vx, vz, yaw, pitch, crouch: crouch === 1 });
    if (m.meta) {
      const was = s.phase.k;
      Object.assign(s, m.meta);
      if (s.phase.k === "ended" && was !== "ended") console.log(`match over: ${s.score.join("-")}`);
    }
  } else if (m.t === "error") console.log(`error: ${m.reason}`);
  else if (m.t === "ack" && !m.ok && process.env.VERBOSE) console.log(`refused: ${m.reason}`);
});
ws.on("close", () => process.exit(0));

setInterval(() => {
  if (!s) return;
  const st = s as unknown as RoomState;
  const me = st.players[you];
  if (!me) return;
  if (me.alive && (s.phase.k === "freeze" || s.phase.k === "warmup") && boughtRound !== s.round) {
    boughtRound = s.round;
    for (const item of botBuys(st, me)) cmd({ k: "buy", item });
  }
  const inp = botInput(st, me, mem);
  ws.send(JSON.stringify({ t: "in", ...inp, vt: s.tick }));
}, TICK_MS);
