"use client";
// The play screen: the 3D canvas (driven by Renderer's own frame loop), a
// fixed-rate input loop that sends one Input per simulation tick, and a
// React HUD that re-renders at most five times a second from the client's
// version counter, never per entity update.
import { useEffect, useRef, useState, type ReactNode } from "react";
import { BUY_ITEMS, GEAR, HALF_ROUNDS, ROUNDS_TO_WIN, TICK_MS, WEAPONS, isWeapon, type BuyItem, type PingKind, type Slot } from "../shared/content.ts";
import { MAP, calloutAt, inRect, type Side } from "../shared/map.ts";
import { CROUCH, FIRE, USE, WALK, type Player, type RoomState, type Snapshot } from "../shared/protocol.ts";
import { buyOpen, members, playerSide, price, sideOf, weaponInHand } from "../shared/sim.ts";
import { inaccuracy } from "../shared/content.ts";
import { GameClient } from "./net.ts";
import { Renderer, SIDE_COLOUR } from "./render.ts";
import { Sound } from "./audio.ts";

function useVersion(client: GameClient | null): number {
  const [, setN] = useState(0);
  useEffect(() => {
    if (!client) return;
    let seen = -1;
    const id = setInterval(() => {
      if (client.version !== seen) {
        seen = client.version;
        setN((n) => n + 1);
      }
    }, 200);
    return () => clearInterval(id);
  }, [client]);
  return client?.version ?? 0;
}

const hex = (n: number): string => `#${n.toString(16).padStart(6, "0")}`;
const clock = (s: number): string => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, "0")}`;
const room = (s: Snapshot): RoomState => s as unknown as RoomState;
const SENS_KEY = "kiln:sens";

interface Keys {
  f: number;
  b: number;
  l: number;
  r: number;
  walk: boolean;
  crouch: boolean;
  use: boolean;
  fire: boolean;
}

export default function Game({ room: code, name }: { room: string; name: string }): ReactNode {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const radarRef = useRef<HTMLCanvasElement>(null);
  const [client, setClient] = useState<GameClient | null>(null);
  const rendererRef = useRef<Renderer | null>(null);
  const soundRef = useRef(new Sound());
  const keys = useRef<Keys>({ f: 0, b: 0, l: 0, r: 0, walk: false, crouch: false, use: false, fire: false });
  const aim = useRef({ yaw: 0, pitch: 0 });
  const [locked, setLocked] = useState(false);
  const [buyMenu, setBuyMenu] = useState(false);
  const [board, setBoard] = useState(false);
  const [sidePicker, setSidePicker] = useState(false);
  const [sens, setSens] = useState(2);
  const sensRef = useRef(2);
  const hitMark = useRef<{ until: number; head: boolean }>({ until: 0, head: false });
  const hurtUntil = useRef(0);
  const spectate = useRef<string | null>(null);
  const [, force] = useState(0);
  const version = useVersion(client);
  void version;

  // connect, and build the renderer once the canvas exists
  useEffect(() => {
    const c = new GameClient(code, name);
    setClient(c);
    c.connect();
    const saved = Number(localStorage.getItem(SENS_KEY));
    if (saved > 0) {
      setSens(saved);
      sensRef.current = saved;
    }
    return () => c.close();
  }, [code, name]);

  useEffect(() => {
    if (!client || !canvasRef.current) return;
    const r = new Renderer(canvasRef.current, client);
    rendererRef.current = r;
    const sound = soundRef.current;
    let lastAlive: boolean | null = null;
    client.onFx = (fx) => {
      r.fx(fx);
      const s = client.state;
      const me = s?.players[client.you];
      const ex = client.me.x;
      const ez = client.me.z;
      if (fx.k === "shot") sound.shot(fx.w, fx.from[0] - ex, fx.from[2] - ez, aim.current.yaw);
      else if (fx.k === "hit") {
        if (fx.by === client.you) {
          hitMark.current = { until: performance.now() + 180, head: fx.head };
          sound.hit(fx.head);
        }
        if (fx.on === client.you) {
          hurtUntil.current = performance.now() + 300;
          sound.hurt();
        }
      } else if (fx.k === "sound") {
        if (fx.s === "explode") sound.explode(fx.x - ex, fx.z - ez, aim.current.yaw);
        else if (fx.s === "planted" || fx.s === "defused") sound.chime(fx.s === "defused");
        else if (fx.s === "empty" && fx.by === client.you) sound.click();
      } else if (fx.k === "ping" && me && fx.team === me.team) sound.beep(fx.x - ex, fx.z - ez, aim.current.yaw);
    };
    // on (re)spawn, look the way the spawn faces
    const watch = setInterval(() => {
      const me = client.state?.players[client.you];
      if (!me) return;
      if (me.alive && lastAlive === false) {
        aim.current = { yaw: me.yaw, pitch: 0 };
        spectate.current = null;
      }
      if (lastAlive === null && me.alive) aim.current = { yaw: me.yaw, pitch: me.pitch };
      lastAlive = me.alive;
      if (client.state && me.team === null) setSidePicker(true);
    }, 100);
    return () => {
      clearInterval(watch);
      r.dispose();
      rendererRef.current = null;
    };
  }, [client]);

  // the fixed-rate input loop: one input per simulation tick, caught up if the timer slipped
  useEffect(() => {
    if (!client) return;
    let next = performance.now();
    const id = setInterval(() => {
      const now = performance.now();
      let n = 0;
      while (next <= now && n < 4) {
        const k = keys.current;
        const b = (k.fire && locked ? FIRE : 0) | (k.use ? USE : 0) | (k.crouch ? CROUCH : 0) | (k.walk ? WALK : 0);
        client.input(k.f - k.b, k.r - k.l, aim.current.yaw, aim.current.pitch, b);
        next += TICK_MS;
        n++;
      }
      if (now - next > 200) next = now;
      const r = rendererRef.current;
      if (r) {
        r.view.yaw = aim.current.yaw;
        r.view.pitch = aim.current.pitch;
        r.view.spectate = spectate.current;
      }
    }, TICK_MS / 2);
    return () => clearInterval(id);
  }, [client, locked]);

  // mouse look under pointer lock
  useEffect(() => {
    const onLock = (): void => {
      const isLocked = document.pointerLockElement === canvasRef.current;
      setLocked(isLocked);
      if (!isLocked) keys.current = { f: 0, b: 0, l: 0, r: 0, walk: false, crouch: false, use: false, fire: false };
    };
    const onMove = (e: MouseEvent): void => {
      if (document.pointerLockElement !== canvasRef.current) return;
      const k = 0.0011 * sensRef.current;
      const tau = Math.PI * 2;
      aim.current.yaw = (((aim.current.yaw - e.movementX * k) % tau) + tau) % tau;
      aim.current.pitch = Math.max(-1.45, Math.min(1.45, aim.current.pitch - e.movementY * k));
    };
    document.addEventListener("pointerlockchange", onLock);
    document.addEventListener("mousemove", onMove);
    return () => {
      document.removeEventListener("pointerlockchange", onLock);
      document.removeEventListener("mousemove", onMove);
    };
  }, []);

  const lock = (): void => {
    soundRef.current.start();
    setBuyMenu(false);
    void canvasRef.current?.requestPointerLock?.();
  };

  const ping = (kind: PingKind): void => {
    const r = rendererRef.current;
    if (!r || !client) return;
    const [x, z] = r.aimPoint();
    client.send({ k: "ping", kind, x, z });
  };

  const cycleSpectate = (): void => {
    const s = client?.state;
    const me = s?.players[client!.you];
    if (!s || !me || me.alive || me.team === null) return;
    const mates = members(room(s), me.team).filter((p) => p.alive);
    if (!mates.length) return (spectate.current = null), undefined;
    const i = mates.findIndex((p) => p.id === spectate.current);
    spectate.current = mates[(i + 1) % mates.length].id;
  };

  // keyboard
  useEffect(() => {
    if (!client) return;
    const set = (e: KeyboardEvent, down: boolean): void => {
      const target = e.target as HTMLElement | null;
      if (target && (target.tagName === "INPUT" || target.tagName === "SELECT")) return;
      const k = keys.current;
      const key = e.key.toLowerCase();
      switch (e.code) {
        case "KeyW":
        case "ArrowUp":
          k.f = down ? 1 : 0;
          break;
        case "KeyS":
        case "ArrowDown":
          k.b = down ? 1 : 0;
          break;
        case "KeyA":
        case "ArrowLeft":
          k.l = down ? 1 : 0;
          break;
        case "KeyD":
        case "ArrowRight":
          k.r = down ? 1 : 0;
          break;
        case "ShiftLeft":
        case "ShiftRight":
          k.walk = down;
          break;
        case "KeyC":
        case "ControlLeft":
          k.crouch = down;
          if (e.code === "ControlLeft") e.preventDefault();
          break;
        case "KeyE":
          k.use = down;
          break;
        case "Tab":
          e.preventDefault();
          setBoard(down);
          break;
        default:
          if (!down) break;
          if (key === "r") client.send({ k: "reload" });
          else if (key === "1" || key === "2" || key === "3") {
            const slot: Slot = key === "1" ? "primary" : key === "2" ? "secondary" : "knife";
            client.send({ k: "slot", slot });
          } else if (key === "q") {
            const me = client.state?.players[client.you];
            if (me) client.send({ k: "slot", slot: me.slot === "secondary" && me.primary ? "primary" : me.slot === "primary" && me.secondary ? "secondary" : me.primary ? "primary" : "secondary" });
          } else if (key === "b") {
            setBuyMenu((open) => {
              if (!open) document.exitPointerLock?.();
              return !open;
            });
          } else if (key === "m") {
            document.exitPointerLock?.();
            setSidePicker(true);
          } else if (key === "z") ping("here");
          else if (key === "x") ping("enemy");
          else if (key === "v") ping("help");
          else if (key === " ") cycleSpectate();
          else if (key === "escape") setBuyMenu(false);
      }
      force((n) => n + 1);
    };
    const down = (e: KeyboardEvent): void => set(e, true);
    const up = (e: KeyboardEvent): void => set(e, false);
    window.addEventListener("keydown", down);
    window.addEventListener("keyup", up);
    return () => {
      window.removeEventListener("keydown", down);
      window.removeEventListener("keyup", up);
    };
  }, [client]);

  // mouse buttons
  useEffect(() => {
    const c = canvasRef.current;
    if (!c) return;
    const down = (e: MouseEvent): void => {
      if (document.pointerLockElement !== c) return;
      if (e.button === 0) {
        keys.current.fire = true;
        const me = client?.state?.players[client.you];
        if (me && !me.alive) cycleSpectate();
      }
      if (e.button === 2) ping("enemy");
    };
    const up = (e: MouseEvent): void => {
      if (e.button === 0) keys.current.fire = false;
    };
    const wheel = (e: WheelEvent): void => {
      if (document.pointerLockElement !== c || !client) return;
      const me = client.state?.players[client.you];
      if (!me) return;
      const order: Slot[] = (["primary", "secondary", "knife"] as Slot[]).filter((s) => s === "knife" || (s === "primary" ? me.primary : me.secondary));
      const i = order.indexOf(me.slot);
      client.send({ k: "slot", slot: order[(i + (e.deltaY > 0 ? 1 : order.length - 1)) % order.length] });
    };
    const menu = (e: Event): void => e.preventDefault();
    c.addEventListener("mousedown", down);
    window.addEventListener("mouseup", up);
    c.addEventListener("wheel", wheel, { passive: true });
    c.addEventListener("contextmenu", menu);
    return () => {
      c.removeEventListener("mousedown", down);
      window.removeEventListener("mouseup", up);
      c.removeEventListener("wheel", wheel);
      c.removeEventListener("contextmenu", menu);
    };
  }, [client]);

  // the radar: its own little frame loop, so dots move smoothly
  useEffect(() => {
    if (!client) return;
    let raf = 0;
    const draw = (): void => {
      raf = requestAnimationFrame(draw);
      const cv = radarRef.current;
      const s = client.state;
      if (!cv || !s) return;
      const ctx = cv.getContext("2d")!;
      const k = cv.width / MAP.width;
      ctx.clearRect(0, 0, cv.width, cv.height);
      ctx.fillStyle = "rgba(20,20,24,0.65)";
      ctx.fillRect(0, 0, cv.width, cv.height);
      for (let r = 0; r < MAP.rows; r++)
        for (let c = 0; c < MAP.cols; c++) {
          const ch = MAP.rowsText[r][c];
          if (ch === "#") continue;
          ctx.fillStyle = ch === "A" || ch === "B" ? "rgba(200,80,60,0.75)" : ch === "c" || ch === "C" ? "rgba(140,110,70,0.9)" : "rgba(216,195,154,0.55)";
          ctx.fillRect(c * 2.5 * k, r * 2.5 * k, 2.5 * k + 0.5, 2.5 * k + 0.5);
        }
      ctx.fillStyle = "#fff";
      ctx.font = `700 ${Math.round(cv.width / 11)}px system-ui`;
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      for (const id of ["A", "B"] as const) ctx.fillText(id, MAP.sites[id].cx * k, MAP.sites[id].cz * k);
      const me = s.players[client.you];
      const rs = room(s);
      // teammates always; enemies only where the server has reported a shot this second would be wallhacks, so never
      for (const p of Object.values(s.players)) {
        if (!p.alive || p.team === null || !me || p.team !== me.team || p.id === client.you) continue;
        const pose = client.pose(p.id) ?? p;
        ctx.fillStyle = hex(SIDE_COLOUR[playerSide(rs, p)!]);
        ctx.beginPath();
        ctx.arc(pose.x * k, pose.z * k, 3.5, 0, Math.PI * 2);
        ctx.fill();
      }
      const b = s.bomb;
      const bombSeen = me && me.team !== null && (sideOf(rs, me.team) === "T" || b.k === "planted" || b.k === "defused");
      if (bombSeen && (b.k === "dropped" || b.k === "planted" || b.k === "defused")) {
        ctx.fillStyle = b.k === "planted" ? "#ff3a2a" : "#ffd23a";
        ctx.fillRect(b.x * k - 3, b.z * k - 3, 6, 6);
      }
      if (me?.alive) {
        const x = client.me.x * k;
        const z = client.me.z * k;
        const yaw = aim.current.yaw;
        ctx.fillStyle = "#fff";
        ctx.beginPath();
        ctx.moveTo(x - Math.sin(yaw) * 7, z - Math.cos(yaw) * 7);
        ctx.lineTo(x - Math.sin(yaw + 2.4) * 4, z - Math.cos(yaw + 2.4) * 4);
        ctx.lineTo(x - Math.sin(yaw - 2.4) * 4, z - Math.cos(yaw - 2.4) * 4);
        ctx.fill();
      }
    };
    draw();
    return () => cancelAnimationFrame(raf);
  }, [client]);

  const s = client?.state ?? null;
  const me = s && client ? s.players[client.you] : null;

  if (!client || client.status === "error")
    return (
      <main className="landing">
        <div className="card">
          <h1>Can't join {code}</h1>
          <p>{client?.error}</p>
          <a href="/">Back to the front page</a>
        </div>
      </main>
    );

  const rs = s ? room(s) : null;
  const side: Side | null = rs && me ? playerSide(rs, me) : null;
  const ph = s?.phase;
  const now = performance.now();
  const nameOf = (id: string | null): string => (id && s?.players[id]?.name) || "the bomb";

  // the clock and what it's counting to
  let phaseLabel = "";
  let timeLeft = 0;
  if (ph?.k === "warmup") {
    phaseLabel = ph.until === null ? "Warmup: waiting for both sides" : "Warmup: match starts in";
    timeLeft = ph.until === null ? 0 : client.secondsTo(ph.until);
  } else if (ph?.k === "freeze") {
    phaseLabel = "Buy phase";
    timeLeft = client.secondsTo(ph.until);
  } else if (ph?.k === "live") {
    phaseLabel = s!.bomb.k === "planted" ? "Bomb planted" : `Round ${s!.round + 1}`;
    timeLeft = s!.bomb.k === "planted" ? client.secondsTo(s!.bomb.explodeAt) : client.secondsTo(ph.until);
  } else if (ph?.k === "over") {
    phaseLabel = "Round over";
    timeLeft = client.secondsTo(ph.until);
  } else if (ph?.k === "halftime") {
    phaseLabel = "Half time: switching sides";
    timeLeft = client.secondsTo(ph.until);
  }

  const myTeam = me?.team ?? 0;
  const tTeam = rs ? (sideOf(rs, 0) === "T" ? 0 : 1) : 0;
  const ctTeam = (1 - tTeam) as 0 | 1;
  const held = me ? weaponInHand(me) : "knife";
  const ammo = me?.ammo[held];
  const canBuy = rs && me ? buyOpen(rs, me) === null : false;
  const inBuyZone = me && side ? inRect(MAP.buyZones[side], client.me.x, client.me.z) : false;
  const w = WEAPONS[held];
  const spread = me?.alive ? inaccuracy(w, Math.hypot(client.me.vx, client.me.vz), client.me.crouch) : 0;
  const gap = 6 + Math.min(40, spread * 900);
  const hit = hitMark.current.until > now;
  const isHost = s?.hostId === client.you;
  const place = me?.alive ? calloutAt(client.me.x, client.me.z) : "";

  let actBar: { label: string; frac: number } | null = null;
  if (me?.act) {
    const total = me.act.k === "plant" ? 3 : me.kit ? 5 : 10;
    actBar = { label: me.act.k === "plant" ? "Planting" : "Defusing", frac: 1 - client.secondsTo(me.act.until) / total };
  }
  const nearBomb = s && me?.alive && side === "CT" && s.bomb.k === "planted" && Math.hypot(s.bomb.x - client.me.x, s.bomb.z - client.me.z) <= 1.5;
  const canPlant = s && me?.alive && side === "T" && s.bomb.k === "carried" && s.bomb.by === me.id && ph?.k === "live" && (inRect(MAP.sites.A, client.me.x, client.me.z) || inRect(MAP.sites.B, client.me.x, client.me.z));
  const carrying = s?.bomb.k === "carried" && s.bomb.by === me?.id;

  // people who left without playing are a count, not a row
  const played = (p: Player): boolean => p.bot || p.connected || p.stats.kills + p.stats.deaths + p.stats.damage + p.stats.obj > 0;
  const scoreRow = (team: 0 | 1): Player[] => (s && rs ? members(rs, team).filter(played).sort((a, b) => b.stats.kills - a.stats.kills || a.stats.deaths - b.stats.deaths) : []);
  const awayCount = (team: 0 | 1): number => (s && rs ? members(rs, team).filter((p) => !played(p)).length : 0);

  return (
    <div className="game">
      <canvas ref={canvasRef} className="world" onClick={() => !locked && !buyMenu && lock()} aria-label="First-person view of the match" />
      {hurtUntil.current > now && <div className="hurt" aria-hidden />}

      {me?.alive && (
        <div className={`crosshair${hit ? " hit" : ""}${hitMark.current.head && hit ? " head" : ""}`} style={{ ["--gap" as string]: `${gap}px` }} aria-hidden>
          <i className="l" />
          <i className="r" />
          <i className="u" />
          <i className="d" />
        </div>
      )}

      <div className="top-bar" role="status">
        <span className="team t" style={{ color: hex(SIDE_COLOUR.T) }}>
          T <b>{s ? s.score[tTeam] : 0}</b>
        </span>
        <span className="clock">
          <small>{phaseLabel}</small>
          {timeLeft > 0 && <b className={s?.bomb.k === "planted" ? "bad" : ""}>{clock(timeLeft)}</b>}
        </span>
        <span className="team ct" style={{ color: hex(SIDE_COLOUR.CT) }}>
          <b>{s ? s.score[ctTeam] : 0}</b> CT
        </span>
        <small className="sub">
          first to {ROUNDS_TO_WIN}, sides swap after {HALF_ROUNDS} · {side ? `you're ${side}` : "no side yet"}
          {place && ` · ${place}`}
        </small>
      </div>

      <ol className="feed" aria-label="Kill feed">
        {s?.feed.map((f) => (
          <li key={`${f.t}-${f.victim}`} className={f.killer === client.you || f.victim === client.you ? "mine" : ""}>
            {f.killer && <span style={{ color: hex(SIDE_COLOUR[f.kside ?? "T"]) }}>{nameOf(f.killer)}</span>}
            <span className="weapon">
              {f.weapon === "bomb" ? "bomb" : WEAPONS[f.weapon].name}
              {f.head ? " ⦿" : ""}
            </span>
            <span style={{ color: hex(SIDE_COLOUR[f.vside ?? "CT"]) }}>{nameOf(f.victim)}</span>
          </li>
        ))}
      </ol>

      <canvas ref={radarRef} className="radar" width={180} height={158} aria-label="Radar: the map, your teammates and the bomb" />

      {me && me.team !== null && (
        <div className="vitals">
          <span className={`hp${me.hp <= 25 ? " bad" : ""}`}>
            <small>Health</small>
            {me.alive ? me.hp : 0}
          </span>
          <span className="ar">
            <small>{me.helmet ? "Armour + helmet" : "Armour"}</small>
            {me.armour}
          </span>
          <span className="money">
            <small>Money</small>${me.money}
          </span>
          {me.kit && <span className="tag">kit</span>}
          {carrying && <span className="tag bomb">bomb</span>}
        </div>
      )}
      {me?.alive && (
        <div className="ammo">
          <small>
            {w.name}
            {me.reloading ? " · reloading" : ""}
          </small>
          {held === "knife" ? "—" : `${ammo?.mag ?? 0} / ${ammo?.reserve ?? 0}`}
          <span className="slots">
            {me.primary && <span className={me.slot === "primary" ? "on" : ""}>1 {WEAPONS[me.primary].name}</span>}
            {me.secondary && <span className={me.slot === "secondary" ? "on" : ""}>2 {WEAPONS[me.secondary].name}</span>}
            <span className={me.slot === "knife" ? "on" : ""}>3 Knife</span>
          </span>
        </div>
      )}

      {actBar && (
        <div className="act" role="status">
          {actBar.label}
          <span className="bar">
            <i style={{ width: `${Math.max(0, Math.min(1, actBar.frac)) * 100}%` }} />
          </span>
        </div>
      )}
      {!actBar && (canPlant || nearBomb) && <div className="hint">Hold E to {canPlant ? "plant" : "defuse"}</div>}
      {!actBar && carrying && ph?.k === "live" && !canPlant && <div className="hint soft">You have the bomb: take it to A or B</div>}
      {me?.alive && canBuy && inBuyZone && !buyMenu && <div className="hint soft lower">B to buy</div>}

      {me && !me.alive && me.team !== null && ph?.k !== "ended" && (
        <div className="dead">
          {ph?.k === "warmup" ? "Respawning…" : spectate.current ? `Watching ${s?.players[spectate.current]?.name ?? ""}` : "You're out this round"}
          <small> · click or Space to watch a teammate</small>
        </div>
      )}

      {ph?.k === "over" && (
        <div className="banner" role="status" style={{ borderColor: hex(SIDE_COLOUR[ph.result.side]) }}>
          <b>{ph.result.side === "T" ? "Terrorists" : "Counter-terrorists"} win</b>
          <small>
            {ph.result.how === "bomb" ? "the bomb went off" : ph.result.how === "defuse" ? "the bomb was defused" : ph.result.how === "time" ? "time ran out" : "the other side is down"}
            {me?.team !== null && me?.team !== undefined && (ph.result.winner === myTeam ? " · you won the round" : " · you lost the round")}
          </small>
        </div>
      )}
      {ph?.k === "halftime" && (
        <div className="banner" role="status">
          <b>Half time</b>
          <small>Sides swap: money resets to $800 and everyone starts with a pistol.</small>
        </div>
      )}
      {ph?.k === "ended" && s && (
        <div className="banner big" role="status">
          <b>{ph.winner === null ? "A draw" : ph.winner === myTeam ? "You won the match" : "You lost the match"}</b>
          <small>
            {s.score[myTeam]} – {s.score[1 - myTeam]}. This room is finished; start a new one from the <a href="/">front page</a>.
          </small>
        </div>
      )}

      <div className="toasts" aria-live="polite">
        {client.toasts.map((t) => (
          <p key={t.id} className={t.kind}>
            {t.text}
          </p>
        ))}
      </div>

      {client.status !== "live" && <div className="conn">{client.status === "connecting" ? "Connecting…" : "Reconnecting…"}</div>}

      {ph?.k === "warmup" && s && (
        <div className="panel warmup">
          <h2>Room {code}</h2>
          <p className="small">Send this page's link to friends. Respawns are instant and money is free until the match starts.</p>
          {isHost ? (
            <>
              <label>
                Bots per side
                <select value={s.fill} onChange={(e) => client.send({ k: "bots", per: Number(e.target.value) })}>
                  {[0, 1, 2, 3, 4, 5].map((n) => (
                    <option key={n} value={n}>
                      {n}
                    </option>
                  ))}
                </select>
              </label>
              <button type="button" disabled={ph.until !== null && client.secondsTo(ph.until) < 4} onClick={() => client.send({ k: "start" })}>
                Start the match
              </button>
            </>
          ) : (
            <p className="small">The host ({s.hostId ? s.players[s.hostId]?.name : "nobody"}) sets bots and starts the match. It also starts by itself 20 seconds after both sides have someone.</p>
          )}
        </div>
      )}

      {(!locked || board) && s && rs && !buyMenu && !sidePicker && (
        <div className="board panel" aria-label="Scoreboard">
          {([tTeam, ctTeam] as const).map((team) => (
            <table key={team}>
              <caption style={{ color: hex(SIDE_COLOUR[sideOf(rs, team)]) }}>
                {sideOf(rs, team) === "T" ? "Terrorists" : "Counter-terrorists"} · {s.score[team]}
              </caption>
              <thead>
                <tr>
                  <th scope="col">Player</th>
                  <th scope="col">K</th>
                  <th scope="col">D</th>
                  <th scope="col">Dmg</th>
                  <th scope="col">Obj</th>
                  {team === myTeam && <th scope="col">$</th>}
                </tr>
              </thead>
              <tbody>
                {scoreRow(team).map((p) => (
                  <tr key={p.id} className={`${p.id === client.you ? "me" : ""}${p.alive ? "" : " out"}${!p.bot && !p.connected ? " away" : ""}`}>
                    <td>
                      {p.name}
                      {p.bot ? " (bot)" : ""}
                      {!p.bot && !p.connected ? " (away)" : ""}
                      {p.id === s.hostId ? " ★" : ""}
                    </td>
                    <td>{p.stats.kills}</td>
                    <td>{p.stats.deaths}</td>
                    <td>{p.stats.damage}</td>
                    <td>{p.stats.obj}</td>
                    {team === myTeam && <td>${p.money}</td>}
                  </tr>
                ))}
              </tbody>
              {awayCount(team) > 0 && (
                <tfoot>
                  <tr>
                    <td colSpan={team === myTeam ? 6 : 5} className="small">
                      and {awayCount(team)} who left
                    </td>
                  </tr>
                </tfoot>
              )}
            </table>
          ))}
          <p className="small rounds">
            {s.history.map((h) => (
              <span key={h.n} title={`round ${h.n}: ${h.side} by ${h.how}`} style={{ color: hex(SIDE_COLOUR[h.side]) }}>
                {h.how === "bomb" ? "✸" : h.how === "defuse" ? "✓" : h.how === "time" ? "⧗" : "✕"}
              </span>
            ))}
          </p>
        </div>
      )}

      {!locked && !buyMenu && !sidePicker && client.status === "live" && ph?.k !== "ended" && (
        <div className="click-to-play">
          <button type="button" onClick={lock}>
            Click to play
          </button>
          <p className="small">
            <kbd>WASD</kbd> move · mouse aim · click fire · <kbd>Shift</kbd> walk · <kbd>C</kbd> crouch · <kbd>E</kbd> plant/defuse · <kbd>R</kbd> reload · <kbd>1</kbd>
            <kbd>2</kbd>
            <kbd>3</kbd>/<kbd>Q</kbd> weapons · <kbd>B</kbd> buy · <kbd>Tab</kbd> scores · <kbd>Z</kbd>/<kbd>X</kbd>/<kbd>V</kbd> callouts · <kbd>M</kbd> side · <kbd>Esc</kbd> release mouse
          </p>
          <label className="small">
            Mouse sensitivity
            <input
              type="range"
              min={0.3}
              max={6}
              step={0.1}
              value={sens}
              onChange={(e) => {
                const v = Number(e.target.value);
                setSens(v);
                sensRef.current = v;
                localStorage.setItem(SENS_KEY, String(v));
              }}
            />
            {sens.toFixed(1)}
          </label>
        </div>
      )}

      {buyMenu && me && rs && (
        <div className="panel buy" role="dialog" aria-label="Buy menu">
          <h2>
            Buy · ${me.money}
            <button type="button" className="secondary" onClick={lock}>
              Done (B)
            </button>
          </h2>
          {!canBuy && <p className="bad">{buyOpen(rs, me)}</p>}
          <ul>
            {BUY_ITEMS.map((item: BuyItem) => {
              const cost = price(rs, me, item);
              const off = typeof cost === "string";
              const wdef = isWeapon(item) ? WEAPONS[item] : null;
              const itemSide = wdef ? wdef.side : GEAR[item as keyof typeof GEAR].side;
              if (itemSide && itemSide !== side) return null;
              return (
                <li key={item}>
                  <button type="button" disabled={!canBuy || off || (cost as number) > me.money} onClick={() => client.send({ k: "buy", item })}>
                    <b>{wdef ? wdef.name : GEAR[item as keyof typeof GEAR].name}</b>
                    <span>{off ? "owned" : `$${cost}`}</span>
                  </button>
                  <small>
                    {wdef ? `${wdef.damage} dmg · ${Math.round(60 / wdef.rate)} rpm · ${wdef.mag} rounds · ` : ""}
                    {wdef ? wdef.blurb : GEAR[item as keyof typeof GEAR].blurb}
                  </small>
                </li>
              );
            })}
          </ul>
        </div>
      )}

      {sidePicker && s && rs && (
        <div className="panel sides" role="dialog" aria-label="Pick a side">
          <h2>Pick a side</h2>
          <div className="row">
            {(["T", "CT"] as const).map((sd) => {
              const team = sideOf(rs, 0) === sd ? 0 : 1;
              const humans = members(rs, team).filter((p) => !p.bot && p.connected).length;
              return (
                <button
                  key={sd}
                  type="button"
                  style={{ borderColor: hex(SIDE_COLOUR[sd]) }}
                  onClick={() => {
                    client.send({ k: "side", side: sd });
                    setSidePicker(false);
                  }}
                >
                  <b>{sd === "T" ? "Terrorists" : "Counter-terrorists"}</b>
                  <small>
                    {humans}/5 people · {sd === "T" ? "plant the bomb at A or B" : "stop the plant, or defuse it"}
                  </small>
                </button>
              );
            })}
            <button
              type="button"
              className="secondary"
              onClick={() => {
                client.send({ k: "side", side: "auto" });
                setSidePicker(false);
              }}
            >
              Auto-balance
            </button>
          </div>
          {me?.team !== null && (
            <button type="button" className="secondary" onClick={() => setSidePicker(false)}>
              Keep my side
            </button>
          )}
          <p className="small">You can switch between rounds, or while you're dead.</p>
        </div>
      )}
    </div>
  );
}
