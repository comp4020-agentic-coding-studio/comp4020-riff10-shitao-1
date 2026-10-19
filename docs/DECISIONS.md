# Decision log

The calls the pod's brief left open, with the reasoning and the numbers. Everything tunable lives in [`shared/content.ts`](../shared/content.ts) and the map in [`shared/map.ts`](../shared/map.ts); this file says why they're what they are.

## Scope

- **Delete, don't adapt.** Plenty's worlds, economy, Green Lobby, isometric renderer, migrations and bot brain were removed outright. What carried over is structural: one process owning every room, pure functions over a JSON state, the version/incarnation/sequence/receipt habits of the protocol, the security bounds, the logfmt action log, the deploy.
- **Old saves don't load.** `SCHEMA_VERSION` went from 2 to 3 and `loadRoom` returns "no such room" for anything older. A Plenty campaign has nothing to become in a shooter, so there's no migration to write.
- **The name is Kiln.** The map is a desert compound and the game is short and hot; "Plenty" would have been actively misleading in the logs.

## Tick rate and networking

- **32 Hz simulation and input rate.** See [`ARCHITECTURE.md`](ARCHITECTURE.md#tick-rate). At 10 Hz a peek is two ticks and lag compensation interpolates across 100 ms gaps; at 32 a strafe is several ticks and the history is fine enough to rewind accurately. 64 Hz would double the per-player message rate for a gain few people on home connections would feel.
- **One input per tick, sent and spent.** The client sends exactly one input per simulation tick from a fixed-rate loop (caught up if the browser's timer slips), and the server spends at most one per tick per player with a bank of four. That makes movement and fire rate the server's to pace, not the client's: a fast or hacked client gets nothing from sending more.
- **Delta compression by diffing, not by schema.** The server remembers what it last sent of each player and sends movement as a 9-number tuple and a whole record only when other fields changed. Measured (see [`TESTING.md`](TESTING.md)), a ten-player room costs each client about 15 KB/s (120 kbit/s), two thirds of it movement; that's well inside any connection, so the format stays plain JSON for legibility in the browser's network panel rather than a binary encoding.
- **Remote players drawn 3 ticks (94 ms) behind.** Enough to always have two samples to interpolate between at 32 Hz with ordinary jitter; any less and a late packet makes players stutter.

## Hit registration

- **Hitscan, decided on the server with lag compensation.** The brief pinned "server-validated, from server-known positions". The open question was whose *time* the target's position is taken at. Taking it at the server's current tick (no compensation) means a player with 80 ms of latency has to lead every moving target by 80 ms plus interpolation, which feels like the game is cheating them. Taking it where the shooter saw the target (rewinding to the input's view tick) is how CS and most shooters feel fair to the shooter.
- **Rewind capped at about 300 ms (10 ticks).** The client says what tick it was showing, and that claim is the one thing in a shot the client supplies besides aim. The cap bounds what a lie can buy: at most 300 ms of history, and only real recorded positions. The first cap was 250 ms; measuring showed it failed at a 200 ms round trip, because the rewind has to cover the round trip *plus* the 94 ms interpolation delay. 300 ms holds to 200 ms round trips.
- **No client-side hit prediction.** The browser doesn't play a hit marker, blood or a kill until the server's `hit` arrives. Even the muzzle flash and tracer wait for the server's `shot`, because the tracer's end point is where the server says the bullet stopped. That's one round trip of delay on feedback (about 20–60 ms in Australia) in exchange for never showing a hit that didn't happen. The firing sound and recoil animation follow the same effect. The crosshair responds to your own movement instantly, since that's predicted.
- **Hitboxes: a head sphere and a body cylinder.** Head radius 17 cm on top of a 1.42 m body (0.98 m crouched), body radius 29 cm; hits below 75 cm are legs. Simple to raycast exactly and close enough to the drawn capsule that what you see is what you can hit.
- **No friendly fire, no wallbangs.** Both cut for a first slice: friendly fire is griefing in a room of strangers, and penetration needs material rules.

## Aim, spread and recoil

- **Inaccuracy is a cone around the aim, chosen by stance and speed.** Below 34% of the gun's top speed you're treated as still. That threshold makes walking (`Shift`, 52%) still slightly inaccurate for most guns and crouch-walking (34%) accurate, and rewards stopping before you shoot. Random points are drawn uniformly over the cone's disc from the room's seeded generator.
- **Spray is a fixed pattern, not random.** Shot *n* of a burst climbs by `climb × (1 − e^(−n/4))` (so it rises fast then levels off) and, from the fifth shot, sways sinusoidally left and right by up to `sway`. A fixed pattern can be learned and pulled down, as CS sprays can; a random one can't. The spray count recovers by one shot per `recovery` seconds of not firing, so tapping and short bursts stay accurate.
- **Recoil moves the shot, not your view.** The server offsets each shot by the spray; your crosshair stays where you put it, with a small visual kick on the gun. Moving the camera would need the server and the client to agree on a camera that isn't the aim, which is the kind of client/server split that makes "I was aiming right at him" arguments. Here the crosshair is always where an unsprayed shot goes, and the pattern is how far above it shot *n* lands.

## Weapons

| Gun | Cost | Damage | Head | Through armour | RPM | Magazine | Reload | Speed m/s | Kept per 10 m | Spread still / crouched / running (mrad) | Spray after 10 shots (mrad up, max sway) | Kill reward |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Knife | $0 | 40 | ×1 | 85% | 120 | – | – | 5.4 | 100% | – | – | $1500 |
| P9 | $200 | 30 | ×4 | 50% | 375 | 12 + 36 | 2.2 s | 5 | 85% | 6.0 / 4.0 / 36 | 28, ±10 | $300 |
| Hand cannon | $700 | 54 | ×4 | 90% | 222 | 7 + 28 | 2.2 s | 4.9 | 88% | 5.0 / 4.0 / 65 | 64, ±10 | $300 |
| Vex SMG | $1200 | 25 | ×4 | 60% | 800 | 30 + 120 | 2.3 s | 5 | 80% | 9.0 / 7.0 / 27 | 55, ±30 | $600 |
| AR-7 (T) | $2700 | 36 | ×4 | 78% | 600 | 30 + 90 | 2.5 s | 4.3 | 98% | 4.0 / 3.0 / 74 | 101, ±40 | $300 |
| M5 carbine (CT) | $3100 | 33 | ×4 | 70% | 667 | 30 + 90 | 2.9 s | 4.5 | 97% | 3.5 / 2.5 / 64 | 78, ±30 | $300 |

Shots to kill at 10 m, body / head:

| Gun | No armour | Vest + helmet |
| --- | --- | --- |
| Knife | 3 / 3 | 3 / 3 |
| P9 | 4 / 1 | 8 / 2 |
| Hand cannon | 3 / 1 | 3 / 1 |
| Vex SMG | 5 / 2 | 9 / 3 |
| AR-7 | 3 / 1 | 4 / 1 |
| M5 carbine | 4 / 1 | 5 / 2 |

The intent behind each row is in [`DESIGN.md`](DESIGN.md#guns). The rifles carry the AK/M4 asymmetry (one-shot helmeted head versus a gentler spray) because it's the genre's best-known weapon decision. The SMG's running inaccuracy (27 mrad) is little over a third of a rifle's, so it's the gun for moving fights; its falloff makes it poor past about 20 m. Armour: a covered hit puts the "through armour" share into health, and half the rest comes off armour.

**Two guns and a knife were enough for the brief's "one slice right"; five is what makes the buy decision interesting.** Every gun has a spec covering what's specific to it (semi-auto needs a fresh press; full-auto fires at its cadence and climbs; reload timing; side restrictions; headshot thresholds).

## The round and the economy

- **First to 7, swap after 6, 12 maximum, 6–6 a draw.** The brief asked for "first to 6 or 7 with a side swap at the half". Seven with a swap after six gives each team six rounds on each side before the decider, and a match that fits in 7–14 minutes with bots.
- **Shortened CS timings**: 8 s freeze, 100 s rounds, 40 s bomb, 3 s plant, 10/5 s defuse, 5 s between rounds. A 1:55 CS round on a map this size would be mostly waiting.
- **CS money**, unchanged in shape: $800 start, $3,250/$3,500 wins, $1,400 + $500 per straight loss to $3,400, $300 plant and defuse, $800 team plant bonus on a loss, $16,000 cap, per-gun kill rewards. Familiar to anyone who's played, and it already has the catch-up property a short match needs.
- **The bomb goes to a random T each round**, from the room's seeded generator. In CS it goes to a random T too; letting the team choose would need a UI for it.
- **The buy window is spawn-only, freeze plus 15 s.** Long enough to buy after a slow freeze, short enough that you can't run back mid-round to rebuy.
- **Warmup with free money and respawns**, started by the host or by a 20-second timer once both sides have someone. A room of strangers needs a way in; a room where the host left still needs to start.

## The map

- **A grid, not free geometry.** The brief: "walls as boxes/segments... so collision and spawn logic stay simple". A character grid of 2.5 m cells makes collision a 3×3 lookup, raycasts a grid walk, and the map readable as text in a code review (see the drawing in [`DESIGN.md`](DESIGN.md#the-map)).
- **de_dust2's shape, not its geometry**: two sites, CT spawn between them, mid splitting into a route to each, a long route around each side. Corridors two cells wide (5 m); chokes at mid doors, long doors, B door, A door; one large open site each, broken by low and high crates.
- **Small**: 80 × 70 m. Ten people find each other in seconds, which a first playtest needs more than strategic depth.
- **One map.** A second is a stretch goal; the first one being readable came first.

## Bots

- **Bots are seat-fillers, not opponents to be proud of.** The brief listed them as a stretch for solo testing, and they turned out to be what made the round machine testable end to end, so they came early. They run inside the server's tick (`shared/bot.ts`), producing ordinary `Input`s that go through `applyInput` exactly like a human's, and see only what has a line of sight from their eye.
- **Handicaps**: a 0.34 s reaction delay, chest aim, and an aim error that settles over a second. About a quarter of their hits are headshots, enough to be dangerous and not enough to feel like an aimbot.
- **Long-range standoffs are abandoned after four seconds**, otherwise two bots who can see each other across a map at the edge of their accuracy stand still trading misses until the clock runs out (a real bug found in a live-server match; see [`TESTING.md`](TESTING.md)).
- **The host sets bots per side (0–5); bots give way to people** between rounds, never mid-round.

## Interface

- **Pointer lock for aim; the HUD is React at 5 Hz.** Everything that moves every frame (the view, the gun, tracers, the radar's dots) is drawn in its own frame loop; the HUD (health, armour, money, ammo, clock, kill feed, scoreboard, buy menu) re-renders only when the client's version counter changes, at most five times a second.
- **The radar never shows enemies.** Teammates, the map, and the bomb when your side should know where it is (always for T; for CT once it's planted).
- **Name tags on teammates only**, and hidden when they're within 2.5 m so a teammate standing on you doesn't fill the screen.
- **Callouts, not chat.** Three pings ("here", "enemy", "help") at the point you're aiming, shown to your team as a marker in the world and a beep panned towards it, rate-limited to one a second, named by place in the log. The same no-text-chat reasoning as Plenty: moderation on a one-host hobby game is limited to leaving.
- **Procedural everything.** Walls, floor, crates, players, the gun and every sound are generated in code (see [`ASSETS.md`](ASSETS.md)), so there's nothing to license or download and the game loads fast.
