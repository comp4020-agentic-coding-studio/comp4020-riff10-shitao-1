# Kiln

A small round-based tactical shooter for up to ten people in a browser, with nothing to install.

Two sides of up to five. The terrorists (T) carry a bomb to site A or site B, plant it, and defend it until it goes off. The counter-terrorists (CT) stop the plant, defuse the bomb, or wipe the planting side first. Between rounds you buy guns and armour with money earned from kills, wins, losses and the bomb. First team to seven rounds wins, and the sides swap after six. A match takes about fifteen minutes.

It's one map, five guns and a knife, and a server that decides every shot. This is a pod riff: a crit-10 pod asked for Plenty, a cosy economy game, to be turned into a Counter-Strike-shaped shooter. Nothing of Plenty's game survives; its server shape, protocol habits and security bounds do.

## Starting a match

Open the front page, type a name, and either start a room for friends or start a room with bots to practise. Send the page's link (or the five-letter room code) to the others. No account: your browser remembers your seat in each room, so a reload or a dropped connection puts you back on your side with your money and gear.

The room opens in warmup: you respawn two seconds after dying and money is free, so you can try every gun. Newcomers are balanced onto the smaller side; press `M` to pick one. The host (the first person in, marked ★ on the scoreboard) sets how many bots fill each side and starts the match. It also starts by itself twenty seconds after both sides have someone.

## Controls

Click the view to capture the mouse; `Esc` releases it.

| Key | Does |
| --- | --- |
| `W` `A` `S` `D` or arrow keys | move |
| mouse | aim |
| left click | fire (hold for automatic weapons) |
| `Shift` | walk: slower, quieter, more accurate |
| `C` or `Ctrl` | crouch: slowest and most accurate |
| `E` (hold) | plant the bomb on a site, or defuse it |
| `R` | reload |
| `1` `2` `3`, `Q`, wheel | rifle or SMG, pistol, knife; `Q` swaps between your main gun and pistol |
| `B` | buy menu |
| `Tab` (hold) | scoreboard |
| `Z` `X` `V`, right click | callouts to your team: "here", "enemy", "help" at the spot you're aiming at |
| `M` | change side (between rounds, or while dead) |
| `Space` or click while dead | watch a living teammate |

Shooting while running sprays everywhere. Stop (or let go of the keys a moment before you fire) and the shot goes where the crosshair is; the crosshair opens up to show how inaccurate you are right now. Holding the trigger on a rifle climbs and then sways: short bursts land, long sprays don't.

## The round

1. **Buy phase**, 8 seconds. Everyone is frozen in spawn. Press `B` to buy; you can keep buying for 15 seconds into the round while you're still in your spawn.
2. **Live**, 1:40. One T carries the bomb (the red tag in your HUD). Hold `E` on a site for three seconds to plant it.
3. **Bomb planted**, 40 seconds. A CT standing on it holds `E` for ten seconds to defuse, five with a kit. Let go and you start again.
4. **The round ends** when one side is all dead, when the bomb explodes (T win, even if every T is dead) or is defused (CT win), or when the clock runs out with no plant (CT win). Planted bombs keep the round going after the last T dies.
5. Five seconds to see what happened, then the next buy phase.

Die, and you're out until the next round: you lose the guns and armour you carried. Survive, and you keep them, with your magazines refilled.

## Money

Everyone starts each half with $800 and a P9 pistol.

| | |
| --- | --- |
| a kill | $300 with a pistol or rifle, $600 with the SMG, $1,500 with the knife |
| winning a round | $3,250, or $3,500 by bomb or defuse |
| losing a round | $1,400, rising $500 per straight loss to $3,400 |
| planting | $300 to the planter, and $800 to every T if they lose the round anyway |
| defusing | $300 to the defuser |

Money caps at $16,000. A team that loses can save (buy nothing) and come back with rifles; that's the economy game.

## The buy menu

| Item | Side | Cost | Notes |
| --- | --- | --- | --- |
| P9 | both | $200 | the default pistol; one headshot kills without a helmet |
| Hand cannon | both | $700 | one headshot kills through a helmet; useless on the move |
| Vex SMG | both | $1,200 | fast and accurate while running, weak at range, double kill money |
| AR-7 | T | $2,700 | one headshot kills through a helmet; kicks hard |
| M5 carbine | CT | $3,100 | gentler spray than the AR-7; a helmet survives one head hit |
| Kevlar vest | both | $650 | 100 armour: body hits take far less health |
| Vest + helmet | both | $1,000 | covers the head too ($350 if you already have a full vest) |
| Defuse kit | CT | $400 | defuse in 5 seconds instead of 10 |

The numbers behind each gun (damage, fire rate, spread, spray, falloff) are in [`docs/DECISIONS.md`](docs/DECISIONS.md).

## The map

Kiln is a small desert compound, about 80 by 70 metres. T spawn is at the bottom, CT spawn at the top between the two sites.

- **A site**, top right: reached by A long (the far-right corridor, via long doors from T spawn) or by catwalk off mid. CTs arrive through A door.
- **B site**, top left: reached by the B tunnels (left side, via lower tunnels from T spawn) or by the connector off mid. CTs arrive through B door.
- **Mid**, the centre corridor, joins T spawn to the mid doors under CT spawn, with catwalk and connector branching off.

Low crates you can see over; high crates you can't. Signs above each place give its callout name, and the HUD names where you're standing. The radar (top left) shows the map, your teammates, and the bomb when your side knows where it is. It never shows enemies.

## Bots

A room started "with bots" fills each side to four; the host can choose 0 to 5 per side in warmup. Bots make way for people as they arrive. They walk to a site, shoot what they can see (with a human-ish reaction time and aim that settles over a second), plant and defuse. They exist so one person can learn the game and so a room of three still plays; they are not good.

## What it doesn't do

There's no text or voice chat, by design: moderation on a one-process hobby server is the host leaving, so communication is three pings and the kill feed. No grenades, no scoped rifles, no second map, no matchmaking or ranks. It needs a mouse and keyboard; a phone can watch but can't play. Finished matches stay finished: a new match is a new room.

## How it works

One Node process on Fly.io owns every room's match and speaks WebSocket at 32 ticks a second. Browsers send one input per tick (which keys are down and where they're aiming) and the server moves everyone, fires every shot, and decides every hit, using where the shooter could see the target at the moment they fired (lag compensation, capped at about 300 ms). The browser predicts its own movement with the same code the server runs, so movement feels instant; it never predicts a hit. Every kill, plant, defuse, buy and round end is one line in `flyctl logs`. Matches persist in SQLite on the Fly volume, so a restart or redeploy resumes them.

- [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md): the stack, the protocol, authority, hit registration, persistence and deployment
- [`docs/DESIGN.md`](docs/DESIGN.md): the round, the economy, the map and the guns as a game
- [`docs/DECISIONS.md`](docs/DECISIONS.md): every call the brief left open, with the numbers
- [`docs/TESTING.md`](docs/TESTING.md): what was tested and measured
- [`docs/ASSETS.md`](docs/ASSETS.md): where every picture and sound comes from

## Running it

You need the versions in `mise.toml` (Node 24, pnpm 11).

```sh
pnpm install
pnpm build          # Next.js shell -> out/
pnpm start          # game server on :8080 (PORT and DATA_DIR override)
```

Then open <http://localhost:8080>. `pnpm check` typechecks and runs the spec against the running server (set `APP_URL` if it isn't on :8080). `node scripts/playbot.ts <ROOM> [url] [name] [T|CT]` joins a room as a bot over the real protocol, which is how a second "person" can be added from a terminal.
