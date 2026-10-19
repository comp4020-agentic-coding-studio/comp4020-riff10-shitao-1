# Architecture

## Shape

```
browser                                      one Fly machine (shared-cpu-1x, 256 MB)
┌───────────────────────────┐                ┌───────────────────────────────────────┐
│ Next.js shell (static)    │   GET /, /play │ server/main.ts (node, type-stripped)  │
│  app/, client/Game.tsx    │◄──────────────►│  serves out/ (Next export), /readme/  │
│  React HUD (≤5 Hz)        │                │  POST /api/rooms, GET /api/health     │
│  three.js view (rAF)      │   WebSocket    │  /ws ──► server/rooms.ts               │
│  client/net.ts            │◄──────────────►│          one live owner per room      │
│  32 Hz input loop         │    /ws         │          shared/sim.ts (pure), 32 Hz  │
└───────────────────────────┘                │  server/store.ts ──► SQLite on /data  │
                                             └───────────────────────────────────────┘
```

| Directory | Holds |
| --- | --- |
| `shared/` | the map as data (`map.ts`), tunables and weapons (`content.ts`), the protocol and state types, movement and raycasting (`physics.ts`), the match simulation (`sim.ts`) and the bots (`bot.ts`); pure TypeScript, no I/O, imported by both sides |
| `server/` | the HTTP and WebSocket server, live room management and input queues, SQLite storage |
| `app/` | Next.js routes: the front page and the play shell (the client-only boundary) |
| `client/` | the browser game: network client with prediction, the three.js renderer, procedural audio, the HUD |
| `spec/` | the tests (see [`TESTING.md`](TESTING.md)) |
| `scripts/` | `playbot.ts`, a bot over the real protocol, and the course's evidence check |

## Choices, and why

- **The deploy shape didn't change.** One Node process serves the static Next.js export and owns every room on one port, on one Fly machine with one volume. Next never runs a request handler. The game is loaded with `next/dynamic` and `ssr: false` from `app/play/PlayShell.tsx`, since it touches WebGL, pointer lock, WebSocket, AudioContext and localStorage.
- **three.js for the 3D view.** The brief pinned it as reasonable; it's one dependency with no build step of its own and runs fine on integrated graphics for a scene this size (one instanced mesh for every wall, a few dozen crates, up to ten capsule players). Nothing in `shared/` imports it, so the simulation stays testable in node.
- **The map is a character grid.** `shared/map.ts` is 28 strings of 32 characters; every cell is 2.5 m. Collision, line of sight, spawns, sites, buy zones and callouts all come from it, so the server, the renderer, the radar and the bots can't disagree about geometry. Walls are one cell, full height; crates are inset boxes, low (see and shoot over) or high (block both).
- **`ws` over a room framework**, `node:sqlite` one row per room, as before.

## Authority

The server owns every room's match; the browser renders it and sends intentions. All change goes through `applyInput`, `applyCommand` and `tick` in `shared/sim.ts`, called one at a time on Node's single thread. The browser never reports a result: there is no message for "I hit", "I picked up", "I planted"; there are only keys held and an aim.

**Inputs.** Each tick the browser sends one `in` message: forward/back and right/left as -1, 0 or 1, yaw and pitch, a button bitmask (fire, use, crouch, walk), a strictly increasing sequence number, and the server tick it was showing other players at (`vt`). The server validates every field (`cleanInput`), queues up to 12 per connection, and spends them at most one per tick on average with a bank of four to absorb jitter. Sending faster gains nothing: a flood is dropped from the front of the queue, and a client can't move or fire faster than the tick allows (spec: "a flood of inputs can't move a player faster than one input a tick").

**Commands** carry discrete intentions that aren't per-tick: `buy`, `slot`, `reload`, `side`, `ping`, and for the host `bots` and `start`. Each has a client id for deduplication and the room incarnation it was meant for; a stale incarnation gets a refusal and a fresh snapshot.

**One tick** (`tick`): every player in id order spends their inputs (bots decide theirs here, from the state everyone sees); each input turns, moves, holds use, and maybe fires. Then the positions are recorded for lag compensation, reloads and plants and defuses complete, a dropped bomb is picked up, the phase clock advances, and the round is checked for a winner. Fixed order, never message order.

## Movement and prediction

`step` in `shared/physics.ts` accelerates towards the wished velocity at 38 m/s², then moves one axis at a time against the boxes in the 3×3 cells around the player, stopping flush with whatever it meets so bodies slide along walls. A tick moves at most about 0.17 m, far less than a cell, so nothing tunnels. Results are rounded to 0.1 mm so a saved and reloaded state continues bit for bit.

The browser runs the same `step` on each input the moment it's sent, and keeps every input the server hasn't acknowledged. Each server update carries the last input sequence it consumed for that player (`ack`); the client resets to the server's position and replays the unacknowledged inputs on top. The spec checks the two agree exactly over 90 varied inputs. A correction from packet loss or a wall the client misjudged is applied to the body at once but eased out of the camera over a few frames, so it never snaps.

Other players are drawn three ticks (about 94 ms) behind the newest update, interpolated between server samples.

## Hit registration

Every shot is resolved in `fire` on the server:

1. The origin is the shooter's server-known eye (position after this input's movement, crouched or standing).
2. The direction is the aim carried by the input, plus the gun's spray offset for this shot in the current spray, plus a random point inside the inaccuracy cone for the shooter's current speed and stance. The randomness comes from the room's own seeded generator, so a reloaded room draws the same numbers and the browser can't choose them.
3. The ray is walked through the grid against walls and crates (`rayMap`).
4. Every living enemy is placed where the shooter saw them: their recorded position at the input's view tick `vt`, interpolated between ticks, clamped to at most `MAX_REWIND` (10 ticks, about 300 ms) in the past. Each is tested as a sphere for the head and a vertical cylinder for the body, with hits below 0.75 m counted as legs.
5. The nearest enemy hit in front of the wall takes damage after falloff, the zone multiplier and armour. Teammates aren't tested (no friendly fire).

The view tick is the client's own claim, but it can only make the server look *backwards* along positions it actually recorded, and never more than about 300 ms. Claiming an older view than real buys a target that was somewhere else; claiming a newer one gives you no rewind. What it can't do is invent a position, move the shooter, or skip a wall. The trade-off is the usual one for lag compensation: a defender with 150 ms of latency can be shot just after stepping behind a corner, by someone who saw them before they did. The rewind has to cover the round trip plus the 94 ms the client draws others behind, so 300 ms keeps hits honest up to a 200 ms round trip (measured: see [`TESTING.md`](TESTING.md)), which covers campus Wi-Fi and Australian home connections to Sydney with room to spare.

Damage reports never flow from client to server; the client learns about hits from `hit` effects in deltas, and draws its own muzzle flash and tracer only when the server's `shot` effect arrives (one round trip later, a deliberate honesty cost: see [`DECISIONS.md`](DECISIONS.md)).

## Protocol

Defined in [`shared/protocol.ts`](../shared/protocol.ts), JSON text frames, `PROTOCOL_VERSION = 3`. A client and server on different versions refuse each other ("this page is out of date: reload it").

Client to server:

- `hello {v, room, token?, name}`: join; a known token resumes that player (side, money, gear, stats), anything else makes a new one and auto-balances them
- `in {s, f, r, yaw, pitch, b, vt}`: one tick of intent, as above
- `cmd {id, inc, c}`: a discrete intention
- `sync`: ask for a fresh snapshot (sent on a sequence gap)
- `ping {n}`

Server to client:

- `welcome {v, inc, you, token, snap}`: the whole match minus other players' tokens and command receipts, and its sequence number
- `delta {seq, tick, players?, moves?, gone?, meta?, fx?}`: changes since the previous delta, at most once per tick and only when something changed. Movement travels as compact tuples `[id, x, z, vx, vz, yaw, pitch, crouch, ack]`, positions to 1 mm and velocities to 1 cm/s (a replay from the rounded start drifts from the server by about a millimetre at worst, measured, and is eased out); whole player records only when something besides movement changed (health, money, gear, ammo); `meta` is the round state (phase, score, bomb, history, kill feed) when it changed; `fx` are momentary things to show and hear (shots with their server-decided end points, hits, pings, plant/defuse/explosion sounds), never saved
- `ack {id, ok, reason?}` for every command
- `error {reason}` and `pong {n}`

The client checks `seq` is exactly one more than the last; on a gap it asks for a snapshot rather than guess.

## Tick rate

32 Hz. Plenty's 10 Hz was fine for walking to trees; a shooter needs movement and aim sampled finely enough that a strafe, a peek and a flick are each several ticks, and a server position history fine enough that lag compensation interpolates over 31 ms rather than 100 ms. 64 Hz would halve that again but doubles the bandwidth and the per-connection message rate, and a shared-cpu-1x machine on a home connection gains little from it. Measured, a ten-player room ticks in about 0.012 ms of simulation (headless) and the whole server tick including serialising and sending is under 1 ms (see [`TESTING.md`](TESTING.md)).

## Rooms, seats and reconnect

A room holds up to 10 connected people (5 a side) and remembers up to 24 identities; past that the longest-gone are forgotten. A player who disconnects during a match keeps their seat, side, money, gear and stats (in warmup, for 15 seconds: long enough for a reload, short enough that passers-by don't fill the room); their body stands where it was and can still be shot. Coming back with the same browser (the token in localStorage) puts them back in it, alive if they were alive. Someone who was away when a round started sits that round out. If their side filled up while they were away they go to the other side, or are told the room is full. A second tab with the same token takes over and the first is closed.

**Empty rooms pause.** A room with nobody connected doesn't tick; after a minute it's unloaded from memory. Bots don't count as people: a room of bots with no humans stops. This is the same rule Plenty had, for a different reason: a match shouldn't play out its rounds (and its money) with nobody watching.

**Halftime and the end.** After six rounds the teams swap sides (team 0 starts T), money resets to $800 and gear is stripped. The first team to seven rounds wins; twelve rounds at six all is a draw. A finished match stays finished; the room keeps its final scoreboard and accepts no more rounds.

## Persistence

`server/store.ts` keeps one row per room in SQLite on the volume (`/data/plenty.db`, WAL mode), with the whole match as JSON. A room is saved every 5 seconds while it has changes, at every round boundary before the boundary is broadcast, when it empties, and on shutdown. On restart a room loads under a new incarnation id; clients resync. Unsaved changes since the last save (at most 5 seconds of a round) are lost on a crash. Lag-compensation history, input queues and bot memories aren't saved: a resumed round starts them fresh.

`SCHEMA_VERSION` is 3. Plenty's saved rooms (schema 1 and 2) are a different game and load as "no such room"; nothing migrates them. A row newer than the server refuses to load rather than be read wrongly.

## Security bounds

- WebSocket upgrades and `POST /api/rooms` require an `Origin` matching the host; anything else gets 403.
- `maxPayload` of 1 KB on the socket: a larger frame closes that socket (1009) and nothing else. An `error` listener on every socket keeps a protocol error from crashing the process.
- A token bucket per connection: 60 messages a second sustained (32 inputs plus commands and pings), bursts of 90.
- At most 32 sockets per address, and 60 new rooms an hour per address.
- `X-Frame-Options: DENY` and `frame-ancestors 'none'`.
- Every field of every message is checked server-side; malformed messages are refused with a reason and the room carries on. Names are stripped of control and bidirectional characters and capped at 16.
- User text (names) only ever reaches the page as React children or canvas `fillText`.
- Tokens are never logged or sent to anyone but their owner.

## The action log

Every meaningful event is one logfmt line on stdout:

```
room=PD8YN round=1 tick=650 actor=bot-2 name=Magpie action=kill victim=bot-7 victim_name=Shrike weapon=p9 head=true at="A site" reward=300
room=PD8YN round=1 tick=1712 actor=f021cfa7-cb5 name=Ada action=plant site=B at="B site" reward=300
room=PD8YN round=1 tick=2306 actor=room name=room action=round_end round=1 winner=T how=bomb score=1-0 win_reward=3500 loss_bonus=1400
```

Joins, leaves, side changes, buys, kills (with weapon, headshot, place and reward), plants, defuse starts and completions, pickups, explosions, callouts, round and match boundaries, halftime, and host actions all appear. `flyctl logs -a <app>` tells the story of a match.

## Deployment and recovery

`fly.toml` and the `Dockerfile` are unchanged in shape: a two-stage build (Next export, then a production install with the server and `shared/`), `node server/main.ts`, one shared-cpu-1x machine with 256 MB, `--ha=false`, the volume at `/data`, a health check at `/api/health` (rooms, last and worst tick time, memory, bytes out). The machine auto-stops when idle; a WebSocket keeps it awake. On `SIGTERM` the server saves every room and closes sockets with 1012, which clients treat as "reconnect".
