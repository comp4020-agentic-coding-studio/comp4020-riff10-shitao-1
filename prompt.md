# Brief: turn Plenty into a CS:GO-style tactical shooter

This is a full genre conversion, not a reskin. Plenty is a cooperative,
top-down, isometric economy-builder: players never fight each other, there's
no aiming, no weapons, no win/lose. The next version is a competitive,
round-based, first-person tactical shooter in the shape of Counter-Strike:
two five-ish-person sides, a buy phase, a bomb objective, and rounds you can
win or lose. Nothing about the old game's content (worlds, deposits, the
Green Lobby, factories) carries over. Delete whatever doesn't serve the new
game rather than bending it to fit.

## What good looks like

A stranger opens a room link, picks a side (or is auto-balanced onto one),
and by the end of a buy phase is looking down a weapon in a real first-person
3D view, not a top-down sprite. They can strafe, aim, and fire; a hit the
server agrees landed deals damage and a kill ends that player's round. One
side plants a bomb at a site and defends the plant; the other finds the
defuse or wipes the planting side first. The round ends, money is awarded
(kill, win, loss bonus, plant/defuse), a short intermission runs a new buy
phase, and the match is tracked to a win (first to some sane number of
rounds, with a side swap at the midpoint). A kill feed and scoreboard make
sense of what happened. It's playable start to finish by up to eight people
in a browser with nothing to install.

If you can only get one slice fully right, make it first-person movement and
shooting that feels honest (the server is the referee, not the client) over
breadth of weapons or maps. A match with two guns and one tight map that
actually works beats five guns and a map nobody can read.

## Scope calls already made (don't relitigate these)

- **First-person, real 3D, not an isometric reskin.** The current renderer
  (`client/render.ts`, `client/iso.ts`) is a 2D top-down canvas; it cannot
  become CS:GO by changing sprites. Add a proper 3D view for the game canvas
  — three.js is a reasonable, small dependency for this and fits the
  existing static Next.js export + `next/dynamic`/`ssr: false` boundary
  (`app/play/PlayShell.tsx`) without touching the deploy shape. The HUD
  (health, armour, ammo, money, round timer, buy menu, scoreboard, kill
  feed) can stay DOM/React, same as the old HUD's 5 Hz poll pattern.
- **One simple, well-made map beats several rough ones.** Build it as data
  (walls as boxes/segments, two bomb sites, a few sightlines and chokepoints
  that read clearly — think in terms of de_dust2's callouts without copying
  its geometry) so collision and spawn logic stay simple. A second map is a
  bonus, not a requirement.
- **Hitscan weapons, server-validated.** The server resolves whether a shot
  hit: given the shooter's server-known position/orientation at (or just
  before) the shot tick and the target's server-known position, not a
  client's claim of "I hit them." A damage report the server didn't agree to
  never reduces health. This is the same authority model the old game used
  (`applyCommand`/`tick` as the only place state changes) — keep that shape,
  just for aim and fire instead of harvest and build.
- **Round structure**: freeze-time buy phase, round timer, bomb plant/defuse
  on the T/CT split, round ends on elimination, bomb detonation, defuse, or
  time running out. Money per kill, a win bonus, a loss-streak bonus, and a
  plant/defuse bonus. Pick a short, sane match length (e.g. first to 6 or 7
  rounds with a side swap at the half) — this needs to be finishable as a
  playtest in minutes, not a full MR12 CS:GO match.
- **A handful of weapons and a pistol-only eco round is enough**: a starting
  pistol, one rifle per side, maybe one SMG and a utility item (a flash or
  smoke is a nice stretch, not a requirement). Depth of the buy menu matters
  less than every gun in it working correctly.

## What to carry over from the old build

- **Server authority and the room model.** One process owns every room's
  match state; the browser renders and sends intentions (move, aim/shoot,
  buy, plant, defuse); the server decides. Keep the pattern of pure,
  testable functions over a JSON-serialisable state (what `shared/sim.ts`
  was for Plenty) even though the state shape is now almost entirely new.
- **The deploy shape.** One Fly machine, one volume, `--ha=false`, WebSocket
  + static export on one port — don't touch `fly.toml` or the Dockerfile's
  structure. SQLite can store match/room results if you want persistence
  across restarts, but a live match is in-memory state like before; decide
  whether mid-match reconnect matters for this brief (probably: yes, a
  dropped player should be able to rejoin their side and seat, the way the
  old per-player token/reconnect worked) and whether anything needs
  migrating from old saves (probably not — old Plenty rooms are a different
  game; it's fine for them to simply fail to load under the new schema
  rather than migrate).
- **The protocol's good habits**: a version header client and server must
  agree on, command ids for dedup, a sequence number the client checks for
  gaps, and a snapshot-on-join. The actual message shapes should change to
  fit an FPS's tick rate and movement model (this needs a materially higher
  tick rate than Plenty's 10 Hz — pick what a shooter actually needs and say
  why in the docs).
- **The security bounds**: origin-checked WebSocket upgrades and
  `POST`/writes, a payload size cap, a per-connection rate limit, framing
  refused. A shooter is not a lower-trust surface than a builder game.
- **The action log.** Every meaningful event (kill, plant, defuse, round
  end, buy) as one logfmt line on stdout with actor and what happened, the
  way Plenty logged builds and harvests. It's still how `flyctl logs` tells
  the story of a match.
- **No text chat.** Keep comms to pings/callouts or emotes, same reasoning
  as before (moderation on a one-host-process game is limited).

## What to leave alone

- This `CLAUDE.md`'s pod-riff block at the top — don't edit it.
- The general directory shape (`shared/`, `server/`, `app/`, `client/`,
  `spec/`, `scripts/`, `docs/`) even though almost every file's contents
  change. Keep the course's grading/evidence tooling able to find things
  where it expects them.

## Tests and docs

- `spec/invariants.test.ts` must stay green: the app answers at `/`, and
  `/readme/` renders the README's headings in order. That means **rewrite
  `README.md`** to describe the new game (how to play, controls, buy menu,
  round flow, how to run it) — the existing Plenty copy is all wrong now —
  and keep its heading structure sane.
- `spec/server.test.ts` and `spec/sim.test.ts` encode Plenty's old brief;
  replace them with specs for the new simulation and server behaviour (round
  state machine, damage resolution, economy, bomb timer, reconnect) rather
  than patching them to fit. `pnpm check` (typecheck + spec against a
  running server) must pass before you're done.
- Rewrite `docs/DESIGN.md`, `docs/ARCHITECTURE.md`, `docs/DECISIONS.md`, and
  `docs/ASSETS.md` to describe the game that actually exists afterwards —
  don't leave them describing worlds, factories or the Green Lobby. Use
  `docs/DECISIONS.md` to record the calls you had to make that aren't
  already pinned above (map design, weapon stats, tick rate, exact round/
  economy numbers, how aim and recoil work, hit registration approach).
  `docs/TESTING.md` should say what you actually measured (tick time, hit
  registration behaviour under latency, a full match playtest) the way the
  old one did for Plenty.

## Stretch, only once the above is solid

Recoil/spray patterns, grenades (flash/smoke/HE), a second map, spectating
after death, a proper buy-menu UI polish pass, bots to fill empty seats for
solo testing (`scripts/playbot.ts`/`brain.ts` played this role for Plenty —
a bot that can at least move, shoot back, and plant/defuse would make this
playable and testable solo the same way).
