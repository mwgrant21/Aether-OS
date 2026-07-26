// aetherStorm.ts — procedural electrical discharge + nebula cloud for the storm-nebula
// reactor core (design handoff "option 4c"). Draws onto a single 268x268 (CSS px) canvas.
//
//   import { createStorm } from './aetherStorm';
//   const storm = createStorm({ canvas, kind: 'storm', nebula: true, getMode: () => 2 });
//   storm.strike();   // fire a burst (e.g. on agent spawn)
//   storm.destroy();  // stop + release
//
// kind:  'surface' = bolts crawl the plasma (clipped to the sphere)
//        'ring'    = bolts jump from core to containment ring, with corona flash
//        'storm'   = both
// mode:  0 idle · 1 nominal · 2 surge · 3 breach  (drives rate, jitter, branching)

const C = 134; // canvas centre, CSS px
const R = 71; // sphere radius
const RING = 118; // containment ring radius
const RATES = [0.4, 1, 2.5, 4.4];
const POWERS = [0.6, 1, 1.35, 1.7];
const PUFF_COLS = ['126,240,255', '23,184,216', '191,244,255'];

type Point = [number, number];

interface Bolt {
  pts: Point[];
  branches: Point[][];
  life: number;
  width: number;
  color: string;
  clip?: number;
  flash?: Point;
}

interface Puff {
  ax: number;
  ay: number;
  px: number;
  py: number;
  sx: number;
  sy: number;
  r: number;
  a: number;
  hue: number;
}

function seg(pts: Point[], a: Point, b: Point, disp: number, depth: number): void {
  if (depth <= 0) {
    pts.push(b);
    return;
  }
  const mx = (a[0] + b[0]) / 2;
  const my = (a[1] + b[1]) / 2;
  const nx = -(b[1] - a[1]);
  const ny = b[0] - a[0];
  const len = Math.hypot(nx, ny) || 1;
  const off = (Math.random() - 0.5) * disp;
  const m: Point = [mx + (nx / len) * off, my + (ny / len) * off];
  seg(pts, a, m, disp * 0.55, depth - 1);
  seg(pts, m, b, disp * 0.55, depth - 1);
}

function makeBolt(a: Point, b: Point, disp: number, depth: number, branchP: number, width: number, color: string): Bolt {
  const pts: Point[] = [a];
  seg(pts, a, b, disp, depth);
  const branches: Point[][] = [];
  for (let i = 2; i < pts.length - 1; i += 2) {
    if (Math.random() > branchP) continue;
    const p = pts[i];
    const dir = Math.atan2(b[1] - a[1], b[0] - a[0]) + (Math.random() - 0.5) * 1.9;
    const l = 16 + Math.random() * 32;
    const end: Point = [p[0] + Math.cos(dir) * l, p[1] + Math.sin(dir) * l];
    const bp: Point[] = [p];
    seg(bp, p, end, disp * 0.5, Math.max(2, depth - 2));
    branches.push(bp);
  }
  return { pts, branches, life: 1, width, color };
}

function seedPuffs(): Puff[] {
  const puffs: Puff[] = [];
  for (let i = 0; i < 16; i++) {
    puffs.push({
      ax: 8 + Math.random() * 34,
      ay: 8 + Math.random() * 34,
      px: Math.random() * 6.28,
      py: Math.random() * 6.28,
      sx: 0.00006 + Math.random() * 0.00016,
      sy: 0.00006 + Math.random() * 0.00016,
      r: 16 + Math.random() * 30,
      a: 0.035 + Math.random() * 0.07,
      hue: i % 3,
    });
  }
  return puffs;
}

export interface CreateStormParams {
  canvas: HTMLCanvasElement | null;
  kind?: 'surface' | 'ring' | 'storm';
  nebula?: boolean;
  getMode?: () => number;
}

export interface StormHandle {
  strike(bursts?: number): void;
  destroy(): void;
}

export function createStorm({ canvas, kind = 'storm', nebula = false, getMode = () => 1 }: CreateStormParams): StormHandle {
  if (!canvas) throw new Error('createStorm: canvas required');
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  canvas.width = 268 * dpr;
  canvas.height = 268 * dpr;
  const ctx = canvas.getContext('2d')!;
  const puffs = nebula ? seedPuffs() : null;

  let bolts: Bolt[] = [];
  let last = 0;
  let lastTick = 0;
  let raf = 0;
  let watchdog = 0;
  let dead = false;

  const mode = () => Math.max(0, Math.min(3, getMode() | 0));

  function spawn(k: 'surface' | 'ring' | 'storm', power: number): void {
    const ang = Math.random() * Math.PI * 2;
    const onSurface = k !== 'ring' && (k === 'surface' || Math.random() > 0.45);
    if (onSurface) {
      const spread = 0.8 + Math.random() * 2;
      const r = R * 0.94;
      const a: Point = [C + Math.cos(ang) * r, C + Math.sin(ang) * r];
      const b: Point = [C + Math.cos(ang + spread) * r, C + Math.sin(ang + spread) * r];
      const bo = makeBolt(a, b, 24 * power, 5, 0.34, 1.1, '#bff4ff');
      bo.clip = R;
      bolts.push(bo);
    } else {
      const a: Point = [C + Math.cos(ang) * R * 0.99, C + Math.sin(ang) * R * 0.99];
      const j = (Math.random() - 0.5) * 0.45;
      const b: Point = [C + Math.cos(ang + j) * RING, C + Math.sin(ang + j) * RING];
      const bo = makeBolt(a, b, 13 * power, 4, 0.24, 1.35, '#eafcff');
      bo.clip = 0;
      bo.flash = b;
      bolts.push(bo);
    }
  }

  function drawNebula(ts: number, m: number): void {
    if (!puffs) return;
    const lit = bolts.map((b) => {
      const mid = b.pts[(b.pts.length / 2) | 0];
      return { x: mid[0], y: mid[1], s: Math.pow(b.life, 0.5) };
    });
    ctx.save();
    ctx.beginPath();
    ctx.arc(C, C, R * 0.99, 0, 6.2832);
    ctx.clip();
    ctx.globalCompositeOperation = 'lighter';
    const boost = 1 + m * 0.22;
    for (const q of puffs) {
      const x = C + Math.cos(ts * q.sx + q.px) * q.ax + Math.sin(ts * q.sy * 0.7 + q.py) * 6;
      const y = C + Math.sin(ts * q.sy + q.py) * q.ay + Math.cos(ts * q.sx * 0.8 + q.px) * 6;
      let flash = 0;
      for (const l of lit) {
        const d = Math.hypot(l.x - x, l.y - y);
        if (d < q.r * 2.2) flash += l.s * (1 - d / (q.r * 2.2));
      }
      const alpha = Math.min(0.5, q.a * boost + flash * 0.5);
      const rad = q.r * (1 + flash * 0.35);
      const g = ctx.createRadialGradient(x, y, 0, x, y, rad);
      g.addColorStop(0, `rgba(${PUFF_COLS[q.hue]},${alpha.toFixed(3)})`);
      g.addColorStop(0.55, `rgba(${PUFF_COLS[q.hue]},${(alpha * 0.35).toFixed(3)})`);
      g.addColorStop(1, `rgba(${PUFF_COLS[q.hue]},0)`);
      ctx.fillStyle = g;
      ctx.beginPath();
      ctx.arc(x, y, rad, 0, 6.2832);
      ctx.fill();
    }
    ctx.restore();
  }

  function frame(): void {
    if (dead) return;
    const ts = performance.now();
    lastTick = Date.now();
    const dt = Math.min(48, ts - last || 16);
    last = ts;
    const m = mode();
    const rate = RATES[m];
    const power = POWERS[m];
    const step = dt / 16;

    const per = rate * (kind === 'storm' ? 0.17 : 0.1) * (kind === 'ring' ? 0.9 : 1) * step;
    if (Math.random() < per) spawn(kind, power);

    for (const b of bolts) b.life -= 0.075 * step;
    bolts = bolts.filter((b) => b.life > 0);

    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, 268, 268);
    ctx.globalCompositeOperation = 'lighter';
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';

    if (puffs) drawNebula(ts, m);

    for (const b of bolts) {
      if (kind === 'surface' && !b.clip) continue;
      if (kind === 'ring' && b.clip) continue;
      const a = Math.pow(b.life, 0.65) * (0.5 + Math.random() * 0.5);
      ctx.save();
      if (b.clip) {
        ctx.beginPath();
        ctx.arc(C, C, b.clip, 0, 6.2832);
        ctx.clip();
      }
      const paths = [b.pts, ...b.branches];
      const passes: [number, number, string, number][] = [
        [7 * b.width, 0.11, b.color, 15],
        [2.5 * b.width, 0.32, b.color, 8],
        [1 * b.width, 0.95, '#ffffff', 4],
      ];
      for (const [w, al, col, blur] of passes) {
        ctx.lineWidth = w;
        ctx.strokeStyle = col;
        ctx.shadowColor = b.color;
        ctx.shadowBlur = blur;
        paths.forEach((p, pi) => {
          ctx.globalAlpha = al * a * (pi ? 0.5 : 1);
          ctx.beginPath();
          ctx.moveTo(p[0][0], p[0][1]);
          for (let i = 1; i < p.length; i++) ctx.lineTo(p[i][0], p[i][1]);
          ctx.stroke();
        });
      }
      if (b.flash) {
        const g = ctx.createRadialGradient(b.flash[0], b.flash[1], 0, b.flash[0], b.flash[1], 20);
        g.addColorStop(0, `rgba(191,244,255,${(0.6 * a).toFixed(3)})`);
        g.addColorStop(1, 'rgba(191,244,255,0)');
        ctx.globalAlpha = 1;
        ctx.shadowBlur = 0;
        ctx.fillStyle = g;
        ctx.beginPath();
        ctx.arc(b.flash[0], b.flash[1], 20, 0, 6.2832);
        ctx.fill();
      }
      ctx.restore();
    }
    ctx.globalAlpha = 1;
    ctx.shadowBlur = 0;
  }

  function loop(): void {
    raf = requestAnimationFrame(loop);
    frame();
  }
  raf = requestAnimationFrame(loop);
  // keeps the storm alive when rAF is throttled (window hidden / offscreen)
  watchdog = window.setInterval(() => {
    if (Date.now() - lastTick > 110) frame();
  }, 40);

  return {
    strike(bursts = 6) {
      const p = POWERS[mode()] * 1.6;
      for (let i = 0; i < bursts; i++) {
        setTimeout(() => {
          spawn('surface', p);
          spawn('ring', p);
        }, i * 50);
      }
    },
    destroy() {
      dead = true;
      cancelAnimationFrame(raf);
      clearInterval(watchdog);
    },
  };
}

// Map a live burn rate (tokens/min) to the four intensity modes and a pulse duration.
export function burnToMode(tokensPerMin: number): number {
  if (tokensPerMin < 12000) return 0;
  if (tokensPerMin < 110000) return 1;
  if (tokensPerMin < 145000) return 2;
  return 3;
}

export function burnToPulse(tokensPerMin: number): string {
  const t = Math.max(0, Math.min(1, (tokensPerMin - 4000) / 144000));
  return (3.6 - t * 2.9).toFixed(2) + 's'; // 3.6s at rest → 0.7s at ceiling
}
