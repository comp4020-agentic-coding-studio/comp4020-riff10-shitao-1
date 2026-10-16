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

Plenty is a multiplayer game: one Node process (`server/`) owns every room's simulation (`shared/sim.ts`) and serves a statically exported Next.js shell (`app/`, `client/`). `README.md` is the player guide; `docs/` holds the design, architecture, decisions and test evidence. Read `docs/ARCHITECTURE.md` before changing the protocol, persistence or deployment.

## What the game must never do

- Let a browser decide an outcome. Clients send intentions; `applyCommand` and `tick` decide, one at a time. Validate every field server-side, whatever the UI allows.
- Make or lose natural stock off the books. Every family keeps `initial + restored = remaining + extracted + destroyed`, and `ledgerHolds` must stay true on every tick. The Green Lobby's finite, per-family seed bank is the only source of `restored`; nothing else creates stock. Goods and machine buffers are separate whole-number stores outside the ledger, never negative, and transfers conserve them. Salvage stays strictly below cost, goods and kits included; buffered contents come back once.
- Leave a deposit unreachable. Buildings can't cover a deposit with stock left, nothing blocks movement, and claims never stop walking or harvesting; keep all three true or replace them with another guarantee.
- Gate leaving a world on anything but exact exhaustion. The chain (factory, claim, datacentre) guides play; it never blocks a transition, and the lobby stops the moment a world is spent.
- Advance a world without its players, or wipe a finished campaign. Empty rooms pause ([ADR 0001](docs/adr/0001-empty-rooms-pause.md)); the ending is permanent and a new campaign is a new room.
- Accept a write or a WebSocket from another origin, or render user text as anything but text (React children, `textContent`, `fillText`).

## What a change must not break

- One owner per room: one process, one Fly machine, `--ha=false`. Replicas need owner routing first.
- A stage boundary is saved before it's announced, and the next world is a pure function of seed and stage.
- Bump `PROTOCOL_VERSION` for an incompatible wire change and `SCHEMA_VERSION` (with a migration in `server/migrate.ts`) for an incompatible saved-state change.
- Economy allocation runs in a fixed order (building id, tile order), never message order. Idle, blocked or disconnected machines consume nothing.
- Every player and lobby action is an event (`Changes.events`) the server prints as one logfmt line with the actor's id and name. Never log a token.
- React never renders per-entity updates: the renderer reads `GameClient.state` in its own frame loop; the HUD polls at 5 Hz.
- Shared code is imported with explicit `.ts` extensions and uses erasable TypeScript only, because node runs `server/` and `shared/` with type stripping.
- `pnpm check` passes before a commit. It needs a running server: `pnpm build && pnpm start`, or `APP_URL`.

## Working on it

- `node scripts/playbot.ts <ROOM> [url] [name] [rush|green|hand]` fills a room with a bot that plays the chain; its decisions are `scripts/brain.ts`, which the spec also runs. Use bots plus a browser to see later worlds and dense scenes.
- Balance lives in `shared/content.ts`. Re-measure pacing after changing it (hand, rush and green bots, normal pace) and update the tables in `docs/DESIGN.md`.
- When you change behaviour, update the doc that describes it in the same commit.
