// Procedural sound: no audio files, so nothing to license. Gunshots are
// filtered noise bursts shaped per weapon and panned and attenuated by where
// the shot came from, so you can hear which way a fight is. Starts only
// after a click, as browsers require.
import type { WeaponId } from "../shared/content.ts";

const SHOT: Record<WeaponId, { freq: number; len: number; gain: number }> = {
  knife: { freq: 2400, len: 0.06, gain: 0.25 },
  p9: { freq: 1500, len: 0.1, gain: 0.5 },
  deagle: { freq: 700, len: 0.22, gain: 0.85 },
  vex: { freq: 1800, len: 0.07, gain: 0.4 },
  ak: { freq: 800, len: 0.14, gain: 0.7 },
  m5: { freq: 1100, len: 0.12, gain: 0.6 },
};

export class Sound {
  private ctx: AudioContext | null = null;
  private master: GainNode | null = null;
  private noise: AudioBuffer | null = null;
  volume = 0.6;

  get running(): boolean {
    return this.ctx !== null;
  }

  start(): void {
    if (this.ctx) return;
    const ctx = new AudioContext();
    this.ctx = ctx;
    this.master = ctx.createGain();
    this.master.gain.value = this.volume;
    this.master.connect(ctx.destination);
    this.noise = ctx.createBuffer(1, ctx.sampleRate, ctx.sampleRate);
    const d = this.noise.getChannelData(0);
    for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
  }

  setVolume(v: number): void {
    this.volume = v;
    if (this.master) this.master.gain.value = v;
  }

  /** A sound at a world position heard from the listener: quieter with distance, panned left/right. */
  private place(dx: number, dz: number, yaw: number): [number, number] {
    const dist = Math.hypot(dx, dz);
    const gain = 1 / (1 + dist / 8);
    // the listener's right is (cos yaw, -sin yaw)
    const pan = dist < 0.5 ? 0 : (dx * Math.cos(yaw) - dz * Math.sin(yaw)) / dist;
    return [gain, Math.max(-1, Math.min(1, pan))];
  }

  private burst(freq: number, len: number, gain: number, pan: number, type: BiquadFilterType = "lowpass"): void {
    const ctx = this.ctx;
    if (!ctx || !this.master || !this.noise) return;
    const src = ctx.createBufferSource();
    src.buffer = this.noise;
    const f = ctx.createBiquadFilter();
    f.type = type;
    f.frequency.value = freq;
    const g = ctx.createGain();
    const t = ctx.currentTime;
    g.gain.setValueAtTime(gain, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + len);
    const p = ctx.createStereoPanner();
    p.pan.value = pan;
    src.connect(f).connect(g).connect(p).connect(this.master);
    src.start(t, Math.random() * 0.5, len + 0.05);
  }

  private tone(freq: number, len: number, gain: number, type: OscillatorType = "sine", pan = 0): void {
    const ctx = this.ctx;
    if (!ctx || !this.master) return;
    const o = ctx.createOscillator();
    o.type = type;
    o.frequency.value = freq;
    const g = ctx.createGain();
    const t = ctx.currentTime;
    g.gain.setValueAtTime(gain, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + len);
    const p = ctx.createStereoPanner();
    p.pan.value = pan;
    o.connect(g).connect(p).connect(this.master);
    o.start(t);
    o.stop(t + len + 0.02);
  }

  shot(w: WeaponId, dx: number, dz: number, yaw: number): void {
    const s = SHOT[w];
    const [g, pan] = this.place(dx, dz, yaw);
    this.burst(s.freq, s.len, s.gain * g, pan);
    if (w !== "knife") this.tone(s.freq / 8, s.len * 0.8, 0.25 * s.gain * g, "triangle", pan);
  }

  /** we hit someone: a dry tick, higher for a headshot */
  hit(head: boolean): void {
    this.tone(head ? 1900 : 1100, 0.07, 0.25, "square");
  }

  hurt(): void {
    this.burst(300, 0.15, 0.5, 0);
  }

  beep(dx: number, dz: number, yaw: number): void {
    const [g, pan] = this.place(dx, dz, yaw);
    this.tone(2200, 0.08, 0.3 * g + 0.04, "sine", pan);
  }

  explode(dx: number, dz: number, yaw: number): void {
    const [g, pan] = this.place(dx, dz, yaw);
    this.burst(220, 1.6, Math.min(1, 1.2 * g + 0.15), pan);
    this.tone(45, 1.2, 0.6 * g + 0.1, "sine", pan);
  }

  click(): void {
    this.tone(900, 0.03, 0.15, "square");
  }

  chime(up: boolean): void {
    this.tone(up ? 660 : 440, 0.25, 0.25, "triangle");
    setTimeout(() => this.tone(up ? 990 : 330, 0.35, 0.25, "triangle"), 140);
  }
}
