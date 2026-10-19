# Design

Kiln is the smallest shape of Counter-Strike that still plays like it: one map with two bomb sites, a round you can win or lose in a dozen ways, and an economy that makes the last round matter to the next one. Everything here serves one aim from the pod's brief: first-person movement and shooting that feels honest, with the server as referee.

## The match

- Two teams. Team one starts as T, team two as CT; they swap at the half.
- **First to seven rounds**, twelve at most, sides swap after six. A 6–6 match is a draw. Eight all-bot matches took 7 to 14 minutes (median about 8); people who don't rush will take longer. Either way it's a crit session's worth.
- **Warmup** first: free money, respawns two seconds after dying, so a room of strangers can try the guns while the last people arrive. The host starts the match, or it starts twenty seconds after both sides have someone.

## The round

| Phase | Length | What happens |
| --- | --- | --- |
| buy | 8 s | everyone frozen in spawn; buy with `B` |
| live | 100 s | the buy menu stays open 15 s more in spawn; T carry the bomb to a site |
| planted | 40 s | the round clock is replaced by the bomb's; CT must defuse |
| over | 5 s | the result banner; money is paid |
| halftime | 8 s | after round six; sides swap, money resets |

A round ends at the first of: one side all dead (but a planted bomb keeps the round going until it's defused or explodes), the bomb exploding (T), the bomb defused (CT), or the clock running out with no plant (CT). These are Counter-Strike's rules, shortened: the round clock is 1:40 rather than 1:55, the bomb 40 s, the defuse 10 s (5 with a kit), the plant 3 s.

The bomb is given to a random living T at the start of each round. If its carrier dies it drops where they fell, and any T walking over it picks it up. Planting needs the carrier standing inside a site's painted square and holding `E`, unmoving (holding use stops movement), for the whole three seconds. Defusing needs a CT within 1.5 m of the bomb, holding `E`; only one CT defuses at a time, and letting go resets it. The blast does 500 damage at the bomb, falling off quadratically to nothing at 17 m, through walls; armour takes 40% off. It's strong enough to kill anyone on the site.

## The economy

Numbers are Counter-Strike's, so anyone who knows the game knows the shape:

| Event | Money |
| --- | --- |
| start of each half | $800 |
| kill | $300 (pistols, rifles), $600 (Vex SMG), $1,500 (knife) |
| round win | $3,250 by elimination or time, $3,500 by bomb or defuse |
| round loss | $1,400 + $500 for each previous straight loss, up to $3,400 |
| plant | $300 to the planter; $800 to every T if T lose the round after planting |
| defuse | $300 to the defuser |
| cap | $16,000 |

A rifle with armour costs about $3,700–$4,100. A team that loses the pistol round gets $1,400 each, can't afford rifles, and has to choose: buy SMGs and armour now (a "force"), or save and buy rifles next round with $1,400 + $1,900 + whatever they kept. The loss streak bonus is the catch-up mechanic: a team that keeps losing keeps getting richer, so one bad round never decides a match.

Dying loses everything you carried. Surviving keeps it, with magazines refilled, so a survivor on a lost round is worth a rifle to their team.

## Guns

Five guns and a knife, chosen so each buy is a different decision rather than a bigger number:

- **P9**, the pistol everyone has. Weak through armour, but one headshot kills an unarmoured head. It's what pistol rounds and eco rounds are about.
- **Hand cannon**: one headshot kills through a helmet, slow and wild when moving. The eco round's high-skill buy.
- **Vex SMG**: cheap, fast, accurate while running, falls off hard past about 20 m (a body hit at 25 m does 14 damage), and pays double for a kill. The force buy, and the anti-eco buy.
- **AR-7** (T) and **M5** (CT): the rifles. The AR-7 kills a helmeted head in one shot and kicks harder; the M5 costs more, sprays more gently, and leaves a helmeted target on about 10 health. That asymmetry is borrowed from the AK and M4 because it's the most famous decision in the genre and it reads instantly.
- **Knife**: three body hits, always there, fastest to run with.

The exact numbers and how spread and spray work are in [`DECISIONS.md`](DECISIONS.md#weapons).

## Moving and shooting

Accuracy is what the game is about, so the rules for it are visible:

- **Moving costs accuracy.** Below a third of your gun's top speed you're "still" and get its full accuracy; above that, inaccuracy climbs to a large cone at full speed. That's what makes stopping before you shoot (counter-strafing) the core skill, as it is in CS. The crosshair's gap opens and closes with your current inaccuracy so you can see it.
- **Walking** (`Shift`) moves at 52% speed, under the threshold for most guns, so you can move and shoot carefully. **Crouching** moves at 34% and tightens the cone further, and lowers your head.
- **Spray** climbs: each shot in a burst kicks the aim further up, levelling off after about eight shots, then sways left and right. Stop firing and it recovers over a fraction of a second. A rifle's first three or four shots go where you aim; a full magazine held down doesn't.
- **Damage** falls off with distance per gun, a headshot is ×4, legs ×0.75. Armour on the body (and the head, with a helmet) lets only a share of the damage through to health, different per gun.

Acceleration is quick (top speed in about 0.15 s, stop in the same), so movement is responsive but stopping isn't instant: a player can't flick from full run to perfect accuracy in one tick.

## The map

Kiln is drawn as a 32 × 28 grid of 2.5 m cells: about 80 m by 70 m, smaller than a CS map so ten people meet each other in seconds. It has the de_dust2 shape without its geometry:

```
################################
#........###........###........#   B site (top left), CT spawn (top middle), A site (top right)
#......C.###.kkkkkk.###.c......#
#..BBBB......kkkkkk......AAAA..#   B door and A door connect CT spawn to each site
#..BBBB..................ACAA..#
#.cBBBB..###........###..AAAA..#
#..BBBB..#####....#####..AAAA..#
#......c.#####....#####......c.#
#.....c..#####....#####........#
##...##########..######........#   mid doors: a two-cell choke under CT spawn
##...##########..######..###...#
##...#########....#####..###.c.#
##...#########...........###...#   catwalk: mid to A
##...#########.......c...###...#
##................##########...#   connector: mid to B tunnels
##................##########...#
##...#########.c..##########...#
##...#########....##########...#   mid
##.c.#########....##########...#
##...#########....##########...#   B tunnels (left), A long (right)
##...#########....########.....#
##.............................#   lower tunnels and long doors open off T spawn
##.............................#
#########.c..........c.#########
#########...tttttttt...#########   T spawn
#########...tttttttt...#########
#########..............#########
################################
```

Each T route to a site has a long, readable approach and a choke where CTs can hold: A long and catwalk to A; B tunnels and connector to B; mid in between, crossing both. CT spawn sits between the sites with a short door to each, so CTs rotate faster than Ts can, which is what makes splitting and faking worth trying. Crates break up each site: low ones you can see and shoot over (and crouch behind), high ones that block sight. Measured along the bots' own paths, Ts need 14 to 16 seconds to reach a site and CTs 5 to 9, which gives CS's rhythm: CTs set up, Ts take a site.

Callout names are painted above each place and shown in the HUD; the radar shows the grid, sites and teammates.

## Bots

Bots fill empty seats so one person can play and a room of three still has two sides of five. They're designed to lose to someone who's learned to stop before shooting:

- They see only what has a clear line from their eye, within 45 m.
- They wait about a third of a second after first seeing someone, then aim at the chest with an error that shrinks over a second of tracking.
- They stop to shoot (so they're accurate) and fire bursts, crouching at range.
- They walk to a site (a coin flip per bot per round), Ts plant when the carrier gets there, CTs head for a planted bomb and defuse.
- They buy a rifle and armour when they can afford both, an SMG on a half-buy, armour otherwise.

They don't throw anything, don't use sound, don't rotate on information, and don't hold angles cleverly. In a full bot-only match about a quarter of their hits land on the head.

## What's not here

No grenades, no scoped rifles, no shotguns, no second map, no ranks. No friendly fire: in a room of strangers on a first evening it's more griefing than tactics. No text chat (three pings instead). These are deliberate cuts for a playable first slice; the brief named the first three as stretch goals.
