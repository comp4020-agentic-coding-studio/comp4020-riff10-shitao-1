# Testing and evidence

What was checked, how, and what it showed. Targets and results are kept apart, and anything not tested says so. All of this was one unattended run on a shared workstation (AMD Threadripper 7960X, Node 24.21, headless Chrome 151 through `agent-browser` 0.39), with no human playtesters.

## Automated tests

`pnpm check` typechecks and runs every `spec/*.test.ts` against a running server (`APP_URL`, default `:8080`). CI runs it against the Docker image Fly deploys, with a throwaway `/data`. 50 tests, all passing.

**`spec/sim.test.ts`**, the simulation with no browser or socket. Inputs go in through the same per-tick hook the server uses.

- the map: every open cell is reachable from T spawn, and every spawn point is on open floor
- movement: a body walking diagonally into a wall stops flush and slides along it; the browser's prediction (the same `step` on the same inputs) and the server agree exactly over 90 varied inputs; freeze time holds everyone still
- hits are the server's call: an aimed shot hits and the same shot aimed past misses; a wall between shooter and target stops it; there is no command that reports damage (a client sending "hit", "damage" or "kill" is refused and nobody's health moves)
- a P9 headshot kills an unhelmeted player; a helmet saves them from the P9 but not the AR-7; damage falls off with distance; armour soaks body hits but not legs
- lag compensation: a shot aimed where a strafing target was six ticks ago, with a view tick that says so, hits; the same aim with a view far older than the cap misses
- **hit registration under latency**: a shooter aiming exactly where their delayed screen showed a strafing target (3 ticks of interpolation plus half the round trip) hits 10 of 10 times at round trips of 0, 100 and 200 ms
- fire rate: holding the trigger on a semi-automatic fires once; tapping can't exceed the gun's rate; a rifle held down fires at its cadence (±1 shot a second) and its spray count climbs
- an empty magazine reloads from reserve after the reload time
- the round machine: warmup, freeze, live, over, the next freeze, with a fresh spawn each round; time running out is a CT win
- eliminating the other side wins the round and pays exactly kill + win money to the winner and the loss bonus to the loser; the loss bonus climbs $500 a straight loss to $3,400
- halftime after six rounds swaps sides, resets money to $800 and strips gear; the seventh round win ends the match permanently (thirty more seconds change nothing); six all is a draw
- the bomb: no plant outside a site; letting go cancels; a full plant inside a site pays the planter; it explodes after 40 s and wins for T even with every T dead; a CT defuses in 10 s (5 with a kit, and not before) and wins, with the losing Ts still paid the plant bonus; a dead carrier drops it and a T walking over it picks it up
- buying: only in your own spawn, during the buy window, with the money, and only your side's rifle and kit; unknown items refused; a resent command id applies once; a dead player loses their gear and a survivor keeps it
- seats: newcomers balance onto the smaller side; a full side refuses a switch; an eleventh person is refused; a dropped player keeps seat, side, money and gear and gets them back; someone returning to a side that filled meanwhile goes to the other side or is refused, and no side ever has six; warmup forgets someone after 15 seconds, a match doesn't
- names are stripped of control and bidirectional characters and capped at 16
- bots fill each side to the host's number and give way to people; only the host can change it
- robustness: inputs are refused field by field (sequence not increasing or not an integer, out-of-range keys, non-finite angles, a bad button mask, an object pretending to be a number); malformed and unauthorised commands are refused
- a whole bot match ends, with every round accounted for, a halftime, money always between $0 and $16,000 and health never negative
- a state saved mid-round, reloaded from JSON, plays on identically to the original
- the aim and movement conventions agree (yaw 0 is north, positive yaw turns left)

**`spec/server.test.ts`**, the real server over HTTP and WebSocket:

- `/`, `/play/` and `/api/health` answer; pages refuse to be framed
- a room can't be created, and a WebSocket can't open, from a foreign origin
- **real time**: one player's movement reaches a second open session in under a second, without a reload
- two strangers land on opposite sides; a returning browser's token restores its seat and side; an unknown token gets a new player
- a resent command is acknowledged without applying again; a stale incarnation is refused with a fresh snapshot
- there is no message that deals damage: "hit" and "kill" commands are unknown, a "damage" message is an unknown message, and health doesn't move
- a flood of 60 inputs at once moves a player no further than the tick rate allows
- messages built to throw when coerced, malformed JSON, and a frame over the 1 KB cap (which closes only that socket, 1009) leave the server and the room running
- **a match survives a restart**: a private server is started, a match begun and a vest bought, then the server is stopped with SIGTERM and restarted; the player rejoins as themselves under a new incarnation with the same side, money and armour, in the same round
- **the action log**: joins, buys (item and cost), callouts and bot joins appear as one `room= round= tick= actor= name= action=` line each, and no token ever appears

**`spec/invariants.test.ts`**, the course's: `/` answers and `/readme/` publishes the README with every heading.

## Playtests in a real browser

Two separate headless Chrome sessions (separate cookie and storage jars), driven by keyboard and mouse events through `agent-browser`, against a locally built server:

- **Strangers get opposite sides.** Two fresh browsers joined one room and were auto-balanced, T and CT.
- **A kill the server agreed to.** The CT turned (by mouse movement under pointer lock) onto the T walking up mid 25 m away and fired five P9 shots. The server logged `name=Ada action=kill victim_name=Bo weapon=p9 head=false at=Mid reward=300`; Ada's HUD showed the round win banner and $4,350, Bo's showed "You're out this round", the red damage vignette and the loss bonus. Earlier, the same browser shooting at a teammate correctly did nothing.
- **Plant and explode.** The T carrier walked through lower tunnels and B tunnels to B site, saw "Hold E to plant", held `E` through the progress bar, and the server logged `action=plant site=B at="B site" reward=300`. Both screens switched to "Bomb planted" and a red 0:40. Nobody defused; at zero the log shows `action=explode site=B` and a T win by bomb, and the explosion killed both players standing on the site.
- **Plant and defuse.** Next round, the CT ran through B door to the bomb, saw "Hold E to defuse", held `E` for ten seconds: `action=defuse_start kit=false`, then `action=defuse site=B reward=300 left_s=15`, a CT win by defuse, and the T's screen read "Counter-terrorists win: the bomb was defused · you lost the round".
- **A restart under two open browsers.** The server was restarted mid-match. Both pages reconnected by themselves, rejoined their own sides (`action=rejoin`), and the match carried on in round 3 at the same score.
- **The buy menu.** Opened with `B` in warmup: the T saw the AR-7 and not the M5 or kit; bought the AR-7 and a vest and helmet; the ammo panel showed `30 / 90` and the vitals "Armour + helmet 100".
- **Latency.** One browser went through a TCP proxy delaying every chunk 60 ms each way (an in-game ping of 124–155 ms), the other connected directly. Over two seconds of walking, the lagged player's predicted position never needed a correction larger than 0.6 mm, while the server's view of them trailed by up to 1.7 m, which is what prediction is for; after stopping both agreed exactly. The lagged player tracked the unlagged one strafing left and right across mid at 22 m, aiming at what their own screen showed, and three of six P9 shots hit (the server's own `hit` effects, 21 damage each at that range); the misses are what a P9's inaccuracy at 22 m does. With lag compensation turned off in a headless reproduction of the same geometry, 0 of 40 such shots hit at any latency.
- **Console clean** in both sessions throughout (`agent-browser errors` empty).

Bugs found this way and fixed (each in its own commit):

- the gun in hand vanished into walls when pressed against them, and drew under the B site's floor letter
- a teammate standing on you drew a name tag that filled the screen
- bots holding a semi-automatic pistol held the trigger down and never fired again
- two bots who could see each other across the map at the edge of their accuracy stood still trading misses until the round timed out (a live round with zero kills)
- bots' aim point plus their aim error landed on heads almost every time (every kill in one live round was a headshot)
- a bomb kill was logged with the victim as the actor
- after halftime the kill feed recoloured earlier kills by each player's new side
- the scoreboard filled with a dozen "(away)" rows from people who'd joined and left; and it and the controls card overlapped
- a frame over the payload cap crashed the whole server process (no `error` listener on the socket)
- a returning player could make a side of six

## Whole matches

- **Headless**: eight seeds of a full ten-bot match, each to the end: 7 to 14 minutes (median about 8), scores from 7–2 to 7–5, rounds ending by elimination, defuse, bomb and time, every one with a halftime where it reached six rounds. A whole match with a seat-holding human passes the spec's money and health bounds on every tick.
- **Over the live server**: two `scripts/playbot.ts` processes (over the real WebSocket protocol, one T, one CT) and six server bots played a complete match from warmup to `match_end winner=team1 score=7-5` in about 11 minutes: 12 rounds, a halftime at 4–2, 69 kills (26 by the two protocol bots), wins by elimination, time and defuse. Both playbots saw "match over: 7-5".

## Performance

Targets: a server tick well inside the 31 ms budget; memory well inside the 256 MB Fly machine; network traffic any connection can carry; a playable frame rate on an ordinary laptop.

| Measure | Scene | Result |
| --- | --- | --- |
| simulation tick, headless | 9 players (8 bots), a whole match, 17,728 ticks | mean 0.022 ms, p99 0.095 ms, worst 7 ms |
| server step, all rooms | two to six live rooms, up to 10 players and 20 connections | typically under 1 ms; worst seen 12 ms on one server and 44 ms once on another (on a host shared with other runs; a SQLite save measures 0.03 ms, so the spike is most likely a GC pause or contention) |
| server memory | same | 103–157 MB, flat over ten minutes |
| saved state | a ten-player room | 6 KB of JSON |
| traffic per client | ten players, mid-round | 15 KB/s (32 messages a second, two thirds movement); message gaps p50 30 ms, p99 46 ms |
| browser frame time | 1920×1080, headless Chrome on SwiftShader (software rendering, no GPU) | 127 ms; 29 ms at 640×360 |

The frame-time row says nothing about a real machine: SwiftShader rasterises on the CPU, and the cost scales with pixels (four times fewer pixels, four times faster), which is the signature of fill rate, not of the game's own code. The scene is one instanced mesh for all walls, a few dozen crates, up to ten five-part players and some sprites, which an integrated laptop GPU draws easily, but no laptop with a GPU was available to measure it. That is the biggest unmeasured claim here.

## Visual and accessibility checks

Screenshots at 1280×720, 1920×1080 and 390×844 of warmup, the buy menu, a live round, the planted bomb, defusing, the round-over banners for both sides, a dead player's view and the scoreboard. At 390×844 the game renders and the HUD fits (the top bar moves right of the radar, the scoreboard scrolls), but there are no touch controls: a phone can watch, not play, which the README says.

`agent-browser a11y` (axe-core 4.12): the front page, the play screen with the HUD and scoreboard loaded, and `/readme/` all report **0 violations**. On the play screen, contrast for 48 HUD nodes is "incomplete", because axe can't compute a background through a WebGL canvas; the HUD panels are near-black at 75–88% opacity under light text, so they pass against anything the canvas draws. Every control is a native button, select or range input with a text label; phase changes, round results and progress are in `role="status"` regions; toasts are `aria-live`.

## Not done

- **Human playtests.** Every "player" above was a script or a bot. Whether the movement and shooting *feel* honest, whether the map reads, and whether the spray is learnable needs people.
- **A real GPU.** See performance.
- **Deployment.** This run doesn't deploy or push; CI deploys the pod's app. Nothing here claims a verified live URL.
- **Ten people at once.** The densest room tested was two protocol bots plus eight server bots (ten seats) and a watcher; the densest browser test was two browsers.
- **Packet loss and jitter.** The latency test was a fixed in-order delay. Real jitter would exercise the server's input bank (four inputs) and the client's three-tick interpolation buffer harder.

## Next, in priority order

1. A human playtest of a whole match with four to ten people, watching the logs, then tuning spread, spray and money from what people actually do.
2. Grenades: a smoke first (it changes how the map plays most), then a flash.
3. A second map, built from the same character grid.
4. Spectating with a free camera after death, and a kill cam that shows where you were shot from.
5. Recoil you can feel: a camera kick that recovers, on top of the spray pattern the server already applies.
