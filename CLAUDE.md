# This repo is a pod riff: pods write the prompt, the agent does the work

This repo is a copy of [`comp4020-riff8-baishi-2`](https://github.com/comp4020-agentic-coding-studio/comp4020-riff8-baishi-2) at
`cb6b77a6` --- shitao's crit agent's final project as it stood at
`10-fly-by-instruments`. Their repo is untouched and off limits. From here to the end of
semester, each crit a pod picks this repo up from wherever the last run left
it.

**Pods: the only file you change is `prompt.md`, at the repo root.** Read the
live app, the code and the history, then write the prompt that would take
this app to a strong, interesting answer to the next brief (the crit runsheet
links it). The prompt can point at any file here. After the session,
shitao's crit agent runs `prompt.md` once, unattended, start to finish, and
nobody is there to answer its questions --- so say what you want, what good
looks like and what to leave alone. Push it before you leave.

**Crit agent: when `prompt.md` exists, it is your brief.** Run it to
completion in one go, keep `main` deployable, and delete `prompt.md` in your
last commit. Leave this block of `CLAUDE.md` as it is.

**Nothing here is marked.** No cutoff, no reflection, no `PROCESS.md` entry.
The next crit opens by looking at where each pod repo ended up, beside the
prompt that got it there (the `prompt-crit<N>` tag).

**The agent's own spec tests are `spec/server.test.ts` and `spec/sim.test.ts`.** They encode the brief it was
working to, and they gate the deploy. A prompt aimed at a different brief can
have them changed or deleted; keep `spec/invariants.test.ts` green, since that
one is true of any good site.

Everything below this line was written for the agent's graded submission. Its
marks, cutoff and weekly skills don't govern this repo: read it for how the
agent was directed, not for what anyone owes.

---

# Your harness

Kiln is a round-based first-person tactical shooter: one Node process (`server/`) owns every room's match (`shared/sim.ts`) at 32 ticks a second and serves a statically exported Next.js shell (`app/`, `client/`, three.js for the view). `README.md` is the player guide; `docs/` holds the design, architecture, decisions and test evidence. Read `docs/ARCHITECTURE.md` before changing the protocol, hit registration, persistence or deployment.

## What the game must never do

- Let a browser decide an outcome. Clients send one `Input` per tick (keys, aim, view tick) and `Command`s (buy, slot, side...); `applyInput`, `applyCommand` and `tick` decide, one at a time. No message reports a hit, a kill or damage. Validate every field server-side, whatever the UI allows.
- Resolve a shot from anything but server-known state: the shooter's server position and the input's aim, spray and spread from the room's seeded generator, walls from `shared/map.ts`, and targets where the server recorded them at the input's view tick, never more than `MAX_REWIND` back.
- Let a client act faster than the tick: inputs are spent at most one per tick (with a small bank), and fire rate is counted in inputs spent.
- Put a sixth player on a side, an eleventh in a room, or give a dead player their gear back.
- Advance a match without its people, or restart a finished one. Empty rooms pause; the ending is permanent and a new match is a new room.
- Accept a write or a WebSocket from another origin, or render user text as anything but text (React children, `textContent`, `fillText`).

## What a change must not break

- One owner per room: one process, one Fly machine, `--ha=false`. Replicas need owner routing first.
- A round boundary is saved before it's announced.
- The browser predicts its own movement with the server's `step` and `moveFor`; change one and the other changes with it (the spec checks they agree exactly).
- Bump `PROTOCOL_VERSION` for an incompatible wire change and `SCHEMA_VERSION` for an incompatible saved-state change. Plenty's rooms (schema < 3) don't load and don't migrate.
- Players are processed in id order every tick, never message order.
- Every meaningful event is a `Changes.events` entry the server prints as one logfmt line with the actor's id and name. Never log a token.
- React never renders per-entity updates: the renderer and radar read `GameClient.state` in their own frame loops; the HUD polls at 5 Hz.
- Shared code is imported with explicit `.ts` extensions and uses erasable TypeScript only, because node runs `server/` and `shared/` with type stripping.
- `pnpm check` passes before a commit. It needs a running server: `pnpm build && pnpm start`, or `APP_URL`.

## Working on it

- Start a room "with bots" to play alone; `node scripts/playbot.ts <ROOM> [url] [name] [T|CT]` adds a bot over the real protocol. Bots' decisions are `shared/bot.ts`, which the server and the spec both run.
- Weapons, timings and money live in `shared/content.ts`; the map in `shared/map.ts`. After changing balance, replay whole bot matches and update the tables in `docs/DECISIONS.md` and `docs/DESIGN.md`.
- When you change behaviour, update the doc that describes it in the same commit.
