// The first-person view: a three.js scene built once from the map data,
// with players, the bomb, tracers and hit sparks updated in its own frame
// loop from GameClient's state. Nothing here decides anything; it draws what
// the server said, plus our own predicted position.
import * as THREE from "three";
import { WEAPONS, type WeaponId } from "../shared/content.ts";
import { CELL, MAP, WALL_H, type Side } from "../shared/map.ts";
import { aimDir, bodyTop, eyeHeight } from "../shared/physics.ts";
import type { Fx, Player, Snapshot } from "../shared/protocol.ts";
import { playerSide } from "../shared/sim.ts";
import type { RoomState } from "../shared/protocol.ts";
import type { GameClient } from "./net.ts";

export const SIDE_COLOUR: Record<Side, number> = { T: 0xd9822b, CT: 0x3d7fd1 };
const SAND = 0xd8c39a;
const WALL = 0xc9ab7c;
const WALL_DARK = 0xa88b62;
const CRATE = 0x8a6a3e;

interface Avatar {
  root: THREE.Group;
  body: THREE.Mesh;
  head: THREE.Mesh;
  gun: THREE.Mesh;
  label: THREE.Sprite;
  labelText: string;
}

interface Transient {
  obj: THREE.Object3D;
  until: number;
  fade?: THREE.Material;
  life: number;
}

/** A text label drawn to a canvas texture, for signs and name tags. */
function textTexture(text: string, colour: string, bg: string | null, px = 64): THREE.CanvasTexture {
  const c = document.createElement("canvas");
  const ctx = c.getContext("2d")!;
  ctx.font = `700 ${px}px system-ui, sans-serif`;
  const w = Math.ceil(ctx.measureText(text).width) + px;
  c.width = w;
  c.height = Math.ceil(px * 1.5);
  ctx.font = `700 ${px}px system-ui, sans-serif`;
  if (bg) {
    ctx.fillStyle = bg;
    ctx.fillRect(0, 0, c.width, c.height);
  }
  ctx.fillStyle = colour;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText(text, c.width / 2, c.height / 2);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 4;
  return t;
}

export class Renderer {
  readonly renderer: THREE.WebGLRenderer;
  readonly scene = new THREE.Scene();
  readonly camera: THREE.PerspectiveCamera;
  private avatars = new Map<string, Avatar>();
  private transients: Transient[] = [];
  private bomb: THREE.Group;
  private bombLight: THREE.Mesh;
  private viewGun: THREE.Group;
  private viewGunMesh: THREE.Mesh;
  private flash: THREE.Mesh;
  private flashUntil = 0;
  private recoil = 0;
  private heldWeapon: WeaponId | null = null;
  private frame = 0;
  private running = true;
  private bob = 0;
  /** filled by the HUD: yaw, pitch and whether to show the world from a teammate's eyes */
  view = { yaw: 0, pitch: 0, spectate: null as string | null };

  constructor(private canvas: HTMLCanvasElement, private client: GameClient) {
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: "high-performance" });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.camera = new THREE.PerspectiveCamera(78, 1, 0.05, 200);
    this.camera.rotation.order = "YXZ";
    this.scene.background = new THREE.Color(0xa9cbe8);
    this.scene.fog = new THREE.Fog(0xcfd9df, 40, 110);
    this.scene.add(new THREE.HemisphereLight(0xeaf3ff, 0x8a7350, 1.6));
    const sun = new THREE.DirectionalLight(0xfff1d6, 1.9);
    sun.position.set(-30, 60, 20);
    this.scene.add(sun);
    this.buildMap();
    this.bomb = this.buildBomb();
    this.bombLight = this.bomb.children[1] as THREE.Mesh;
    this.scene.add(this.bomb);
    this.viewGun = new THREE.Group();
    // a receiver, a barrel and a grip: enough to read as a gun at the corner of the screen
    this.viewGunMesh = new THREE.Mesh(new THREE.BoxGeometry(0.045, 0.06, 0.5), new THREE.MeshLambertMaterial({ color: 0x2c2c30 }));
    const barrel = new THREE.Mesh(new THREE.CylinderGeometry(0.009, 0.009, 0.2, 8), new THREE.MeshLambertMaterial({ color: 0x18181a }));
    barrel.rotation.x = Math.PI / 2;
    barrel.position.set(0, 0.012, -0.3);
    const grip = new THREE.Mesh(new THREE.BoxGeometry(0.035, 0.1, 0.045), new THREE.MeshLambertMaterial({ color: 0x3b3022 }));
    grip.position.set(0, -0.06, 0.12);
    grip.rotation.x = -0.25;
    this.viewGunMesh.add(barrel, grip);
    this.viewGun.add(this.viewGunMesh);
    this.flash = new THREE.Mesh(new THREE.SphereGeometry(0.05, 8, 6), new THREE.MeshBasicMaterial({ color: 0xffe08a, transparent: true, opacity: 0.95 }));
    this.flash.visible = false;
    this.viewGun.add(this.flash);
    this.camera.add(this.viewGun);
    this.scene.add(this.camera);
    this.resize();
    window.addEventListener("resize", this.resize);
    requestAnimationFrame(this.loop);
  }

  dispose(): void {
    this.running = false;
    window.removeEventListener("resize", this.resize);
    this.renderer.dispose();
  }

  private resize = (): void => {
    const w = this.canvas.clientWidth || window.innerWidth;
    const h = this.canvas.clientHeight || window.innerHeight;
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
  };

  private buildMap(): void {
    const floor = new THREE.Mesh(new THREE.PlaneGeometry(MAP.width, MAP.depth), new THREE.MeshLambertMaterial({ color: SAND }));
    floor.rotation.x = -Math.PI / 2;
    floor.position.set(MAP.width / 2, 0, MAP.depth / 2);
    this.scene.add(floor);
    // a faint grid on the floor helps judge distance and speed
    const grid = new THREE.GridHelper(Math.max(MAP.width, MAP.depth), Math.max(MAP.cols, MAP.rows), 0xb59f74, 0xc4ae84);
    grid.position.set(Math.max(MAP.width, MAP.depth) / 2, 0.01, Math.max(MAP.width, MAP.depth) / 2);
    (grid.material as THREE.Material).transparent = true;
    (grid.material as THREE.Material).opacity = 0.35;
    this.scene.add(grid);

    // walls as one instanced mesh, with alternating shades so corners read
    const walls = MAP.boxes.filter((b) => b.kind === "wall");
    const wallMesh = new THREE.InstancedMesh(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshLambertMaterial({ color: 0xffffff }), walls.length);
    const m = new THREE.Matrix4();
    const col = new THREE.Color();
    walls.forEach((b, i) => {
      m.makeScale(b.x1 - b.x0, b.y1 - b.y0, b.z1 - b.z0).setPosition((b.x0 + b.x1) / 2, (b.y0 + b.y1) / 2, (b.z0 + b.z1) / 2);
      wallMesh.setMatrixAt(i, m);
      const c = Math.floor(b.x0 / CELL) + Math.floor(b.z0 / CELL);
      wallMesh.setColorAt(i, col.setHex(c % 2 ? WALL : WALL_DARK));
    });
    this.scene.add(wallMesh);
    const crates = MAP.boxes.filter((b) => b.kind === "crate");
    const crateMat = new THREE.MeshLambertMaterial({ color: CRATE });
    const edge = new THREE.LineBasicMaterial({ color: 0x4f3a1f });
    for (const b of crates) {
      const g = new THREE.BoxGeometry(b.x1 - b.x0, b.y1 - b.y0, b.z1 - b.z0);
      const mesh = new THREE.Mesh(g, crateMat);
      mesh.position.set((b.x0 + b.x1) / 2, (b.y0 + b.y1) / 2, (b.z0 + b.z1) / 2);
      this.scene.add(mesh);
      const lines = new THREE.LineSegments(new THREE.EdgesGeometry(g), edge);
      lines.position.copy(mesh.position);
      this.scene.add(lines);
    }
    // bomb sites: a painted square and a big letter on the floor
    for (const id of ["A", "B"] as const) {
      const r = MAP.sites[id];
      const pad = new THREE.Mesh(new THREE.PlaneGeometry(r.x1 - r.x0, r.z1 - r.z0), new THREE.MeshBasicMaterial({ color: 0xb3402f, transparent: true, opacity: 0.22 }));
      pad.rotation.x = -Math.PI / 2;
      pad.position.set(r.cx, 0.02, r.cz);
      this.scene.add(pad);
      const letter = new THREE.Mesh(new THREE.PlaneGeometry(4, 4), new THREE.MeshBasicMaterial({ map: textTexture(id, "#8f2a1c", null, 160), transparent: true }));
      letter.rotation.x = -Math.PI / 2;
      letter.position.set(r.cx, 0.03, r.cz);
      this.scene.add(letter);
    }
    // callout signs, painted on the wall nearest each place's centre
    for (const c of MAP.callouts) {
      const cx = (c.x0 + c.x1) / 2;
      const cz = (c.z0 + c.z1) / 2;
      const tex = textTexture(c.name, "#fdf5e4", "rgba(60,40,20,0.8)", 48);
      const w = (tex.image as HTMLCanvasElement).width / (tex.image as HTMLCanvasElement).height;
      const sign = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, transparent: true, depthWrite: false }));
      sign.scale.set(0.55 * w, 0.55, 1);
      sign.position.set(cx, WALL_H - 0.6, cz);
      this.scene.add(sign);
    }
    // spawns tinted by side
    for (const side of ["T", "CT"] as const) {
      const r = MAP.buyZones[side];
      const pad = new THREE.Mesh(new THREE.PlaneGeometry(r.x1 - r.x0, r.z1 - r.z0), new THREE.MeshBasicMaterial({ color: SIDE_COLOUR[side], transparent: true, opacity: 0.12 }));
      pad.rotation.x = -Math.PI / 2;
      pad.position.set((r.x0 + r.x1) / 2, 0.015, (r.z0 + r.z1) / 2);
      this.scene.add(pad);
    }
  }

  private buildBomb(): THREE.Group {
    const g = new THREE.Group();
    const body = new THREE.Mesh(new THREE.BoxGeometry(0.4, 0.16, 0.28), new THREE.MeshLambertMaterial({ color: 0x3a3a2a }));
    body.position.y = 0.08;
    g.add(body);
    const light = new THREE.Mesh(new THREE.SphereGeometry(0.05, 8, 6), new THREE.MeshBasicMaterial({ color: 0xff3020 }));
    light.position.set(0.1, 0.19, 0);
    g.add(light);
    g.visible = false;
    return g;
  }

  private avatar(p: Player, side: Side): Avatar {
    let a = this.avatars.get(p.id);
    if (!a) {
      const root = new THREE.Group();
      const body = new THREE.Mesh(new THREE.CylinderGeometry(0.27, 0.24, 1, 10), new THREE.MeshLambertMaterial({ color: SIDE_COLOUR[side] }));
      const head = new THREE.Mesh(new THREE.SphereGeometry(0.17, 12, 10), new THREE.MeshLambertMaterial({ color: 0xe8c4a0 }));
      const gun = new THREE.Mesh(new THREE.BoxGeometry(0.07, 0.08, 0.55), new THREE.MeshLambertMaterial({ color: 0x222222 }));
      root.add(body, head, gun);
      const label = new THREE.Sprite(new THREE.SpriteMaterial({ transparent: true, depthTest: true }));
      root.add(label);
      this.scene.add(root);
      a = { root, body, head, gun, label, labelText: "" };
      this.avatars.set(p.id, a);
    }
    (a.body.material as THREE.MeshLambertMaterial).color.setHex(SIDE_COLOUR[side]);
    return a;
  }

  /** Effects the server reported: tracers, sparks, and our own muzzle flash. */
  fx(f: Fx): void {
    const now = performance.now();
    if (f.k === "shot") {
      const mine = f.by === this.client.you;
      if (mine) {
        this.flashUntil = now + 50;
        this.recoil = Math.min(1, this.recoil + 0.35);
      }
      // a tracer from the gun (ours) or the shooter's eye to where the server says the shot stopped
      const from = new THREE.Vector3(...f.from);
      if (mine) {
        const m = this.viewGun.localToWorld(new THREE.Vector3(0, 0, -0.3));
        from.copy(m);
      } else from.y -= 0.15;
      const geo = new THREE.BufferGeometry().setFromPoints([from, new THREE.Vector3(...f.to)]);
      const mat = new THREE.LineBasicMaterial({ color: 0xfff2b0, transparent: true, opacity: 0.8 });
      const line = new THREE.Line(geo, mat);
      this.scene.add(line);
      this.transients.push({ obj: line, until: now + 80, fade: mat, life: 80 });
      // a scuff where it hit
      const dot = new THREE.Mesh(new THREE.SphereGeometry(0.035, 6, 4), new THREE.MeshBasicMaterial({ color: 0x3a2f22, transparent: true }));
      dot.position.set(...f.to);
      this.scene.add(dot);
      this.transients.push({ obj: dot, until: now + 4000, fade: dot.material as THREE.Material, life: 4000 });
    } else if (f.k === "hit") {
      const spark = new THREE.Mesh(new THREE.SphereGeometry(f.head ? 0.12 : 0.08, 8, 6), new THREE.MeshBasicMaterial({ color: f.head ? 0xff5a3a : 0xc0302a, transparent: true }));
      spark.position.set(...f.at);
      this.scene.add(spark);
      this.transients.push({ obj: spark, until: now + 250, fade: spark.material as THREE.Material, life: 250 });
    } else if (f.k === "ping") {
      const s = this.client.state;
      const me = s?.players[this.client.you];
      if (!me || me.team !== f.team) return;
      const colour = f.kind === "enemy" ? "#ff4a3a" : f.kind === "help" ? "#ffd23a" : "#ffffff";
      const tex = textTexture(f.kind === "enemy" ? "◆ enemy" : f.kind === "help" ? "◆ help" : "◆ here", colour, "rgba(0,0,0,0.55)", 48);
      const w = (tex.image as HTMLCanvasElement).width / (tex.image as HTMLCanvasElement).height;
      const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, transparent: true, depthTest: false }));
      sprite.scale.set(0.5 * w, 0.5, 1);
      sprite.position.set(f.x, 2.4, f.z);
      sprite.renderOrder = 10;
      this.scene.add(sprite);
      this.transients.push({ obj: sprite, until: now + 4000, fade: sprite.material, life: 4000 });
    }
  }

  private loop = (): void => {
    if (!this.running) return;
    requestAnimationFrame(this.loop);
    this.frame++;
    const s = this.client.state;
    if (s) this.draw(s);
    this.renderer.render(this.scene, this.camera);
  };

  private draw(s: Snapshot): void {
    const now = performance.now();
    const me = s.players[this.client.you];
    const room = s as unknown as RoomState;
    // the camera: our own predicted eye, or a living teammate's when we're dead
    const spec = this.view.spectate ? s.players[this.view.spectate] : null;
    let eyeX: number;
    let eyeZ: number;
    let eyeY: number;
    let yaw = this.view.yaw;
    let pitch = this.view.pitch;
    if (me?.alive || !spec) {
      // ease away any correction so a reconcile never snaps the camera
      const e = this.client.err;
      e.x *= 0.82;
      e.z *= 0.82;
      eyeX = this.client.me.x + e.x;
      eyeZ = this.client.me.z + e.z;
      eyeY = eyeHeight(this.client.me.crouch);
      if (!me?.alive && me?.team === null) eyeY = 12;
    } else {
      const pose = this.client.pose(spec.id) ?? { x: spec.x, z: spec.z, yaw: spec.yaw, pitch: spec.pitch, crouch: spec.crouch };
      eyeX = pose.x;
      eyeZ = pose.z;
      eyeY = eyeHeight(pose.crouch);
      yaw = pose.yaw;
      pitch = pose.pitch;
    }
    const speed = Math.hypot(this.client.me.vx, this.client.me.vz);
    this.bob += speed * 0.016;
    const bobY = me?.alive ? Math.sin(this.bob * 2.2) * 0.012 * Math.min(1, speed / 4) : 0;
    this.camera.position.set(eyeX, eyeY + bobY, eyeZ);
    this.camera.rotation.set(pitch, yaw, 0);

    // view model: the gun in hand, kicked by our own shots
    const held = me?.alive ? (me.slot === "primary" ? me.primary : me.slot === "secondary" ? me.secondary : null) ?? "knife" : null;
    this.viewGun.visible = !!held && !!me?.alive;
    if (held && held !== this.heldWeapon) {
      this.heldWeapon = held;
      const len = held === "knife" ? 0.28 : WEAPONS[held].slot === "secondary" ? 0.22 : 0.55;
      this.viewGunMesh.scale.set(1, 1, len / 0.5);
      for (const c of this.viewGunMesh.children) c.visible = held !== "knife";
      (this.viewGunMesh.material as THREE.MeshLambertMaterial).color.setHex(held === "knife" ? 0x9aa0a6 : held === "ak" ? 0x5a3a20 : 0x2c2c30);
      this.flash.position.set(0, 0.01, -len / 2 - 0.05);
    }
    this.recoil *= 0.86;
    const sway = Math.sin(this.bob * 1.1) * 0.008 * Math.min(1, speed / 4);
    this.viewGun.position.set(0.17 + sway, -0.16 + bobY * 0.5 - this.recoil * 0.02, -0.4 + this.recoil * 0.06);
    this.viewGun.rotation.set(this.recoil * 0.12, 0.04, 0);
    this.flash.visible = now < this.flashUntil;

    // everyone else, where we saw them (the same view tick the server rewinds to)
    const seen = new Set<string>();
    for (const p of Object.values(s.players)) {
      if (p.id === this.client.you || !p.alive || p.team === null) continue;
      const side = playerSide(room, p);
      if (!side) continue;
      if (spec && p.id === spec.id) continue;
      const pose = this.client.pose(p.id) ?? { x: p.x, z: p.z, yaw: p.yaw, pitch: p.pitch, crouch: p.crouch };
      const a = this.avatar(p, side);
      seen.add(p.id);
      const top = bodyTop(pose.crouch);
      a.root.position.set(pose.x, 0, pose.z);
      a.root.rotation.y = pose.yaw;
      a.body.scale.set(1, top, 1);
      a.body.position.y = top / 2;
      a.head.position.y = top + 0.15;
      a.gun.position.set(0.18, top - 0.25, -0.3);
      a.gun.rotation.x = pose.pitch;
      a.root.visible = true;
      // name tags for teammates only: an enemy is found by looking, not by a label through a wall
      // and not when they're on top of us, where a tag would fill the screen
      const mate = me && p.team === me.team && Math.hypot(pose.x - eyeX, pose.z - eyeZ) > 2.5;
      a.label.visible = !!mate;
      if (mate) {
        const text = p.name;
        if (a.labelText !== text) {
          a.labelText = text;
          const tex = textTexture(text, "#ffffff", "rgba(20,40,80,0.6)", 40);
          (a.label.material as THREE.SpriteMaterial).map?.dispose();
          (a.label.material as THREE.SpriteMaterial).map = tex;
          (a.label.material as THREE.SpriteMaterial).needsUpdate = true;
          const w = (tex.image as HTMLCanvasElement).width / (tex.image as HTMLCanvasElement).height;
          a.label.scale.set(0.3 * w, 0.3, 1);
        }
        a.label.position.y = top + 0.55;
      }
    }
    for (const [id, a] of this.avatars) {
      if (seen.has(id)) continue;
      a.root.visible = false;
      if (!s.players[id]) {
        this.scene.remove(a.root);
        this.avatars.delete(id);
      }
    }

    // the bomb, wherever it lies
    const b = s.bomb;
    if (b.k === "dropped" || b.k === "planted" || b.k === "defused" || b.k === "exploded") {
      this.bomb.visible = b.k !== "exploded";
      this.bomb.position.set(b.x, 0, b.z);
      const blink = b.k === "planted" ? (Math.floor(now / Math.max(90, 500 * this.client.secondsTo(b.explodeAt) / 40)) % 2 === 0) : false;
      this.bombLight.visible = b.k === "planted" ? blink : b.k === "dropped";
    } else this.bomb.visible = false;

    for (let i = this.transients.length - 1; i >= 0; i--) {
      const t = this.transients[i];
      const left = t.until - now;
      if (left <= 0) {
        this.scene.remove(t.obj);
        this.transients.splice(i, 1);
        continue;
      }
      if (t.fade) (t.fade as THREE.Material & { opacity: number }).opacity = Math.min(1, (left / t.life) * 1.5);
    }
  }

  /** Where the crosshair points on the floor, for a callout ping. */
  aimPoint(): [number, number] {
    const d = aimDir(this.view.yaw, this.view.pitch);
    const o = this.camera.position;
    let t = 25;
    if (d[1] < -0.02) t = Math.min(t, o.y / -d[1]);
    return [Math.max(0, Math.min(MAP.width, o.x + d[0] * t)), Math.max(0, Math.min(MAP.depth, o.z + d[2] * t))];
  }
}
