export interface DrawConduitsParams {
  t: number;
  surge: number;
  phase: number;
  glowFactor: number;
  hubRadius?: number;
  channelWidth?: number;
  layout?: 'plus' | 'x';
}

const LAYOUT_ANGLES: Record<'plus' | 'x', number[]> = {
  plus: [0, 90, 180, 270],
  x: [45, 135, 225, 315],
};

export function drawConduits(ctx: CanvasRenderingContext2D, params: DrawConduitsParams): void {
  const { t, surge, phase: p, glowFactor: glowF } = params;
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, 668, 668);
  ctx.setTransform(2, 0, 0, 2, 0, 0);

  const TAU = Math.PI * 2;
  const c = 167;
  const r1 = 164;
  const w = params.channelWidth || 7;
  const r0 = params.hubRadius || 110;
  const angles = LAYOUT_ANGLES[params.layout || 'plus'];
  let g: CanvasGradient;

  // Each channel is drawn in its own rotated local frame: local x runs outward
  // from the hub (r0 -> r1), local y is the perpendicular offset across the
  // channel. This makes the geometry angle-agnostic, so the same drawing code
  // produces both the cardinal "+" layout and the diagonal "x" layout.
  angles.forEach((deg, di) => {
    const rad = (deg * Math.PI) / 180;
    const lx = (s: number) => r0 + (r1 - r0) * s;

    ctx.save();
    ctx.translate(c, c);
    ctx.rotate(rad);

    // channel housing: dark trough + wall lines + end socket
    ctx.fillStyle = 'rgba(4,18,26,.85)';
    ctx.beginPath();
    ctx.rect(lx(0), -w, lx(1) - lx(0), w * 2);
    ctx.fill();
    ctx.strokeStyle = 'rgba(90,130,150,.45)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(lx(0), w);
    ctx.lineTo(lx(1), w);
    ctx.moveTo(lx(0), -w);
    ctx.lineTo(lx(1), -w);
    ctx.stroke();
    ctx.beginPath();
    ctx.arc(lx(1), 0, w * 0.5, 0, TAU);
    ctx.fillStyle = '#31454f';
    ctx.fill();
    ctx.strokeStyle = 'rgba(160,220,240,.35)';
    ctx.lineWidth = 0.8;
    ctx.stroke();

    ctx.save();
    // clip plasma to the trough
    ctx.beginPath();
    ctx.rect(lx(0), -w + 1, lx(1) - lx(0), w * 2 - 2);
    ctx.clip();
    ctx.globalCompositeOperation = 'lighter';

    // faint drifting storm wisps
    for (let i = 0; i < 3; i++) {
      const s = Math.sin(t * (0.6 + i * 0.29) + di * 1.7 + i * 2.1) * 0.5 + 0.5;
      const bx = lx(s);
      const by = Math.sin(t * 2.1 + i) * (w * 0.3);
      const al = Math.max(0, (0.07 + 0.13 * surge) * (0.55 + 0.45 * Math.sin(t * 3 + i * 2 + di)) * glowF);
      g = ctx.createRadialGradient(bx, by, 0, bx, by, w + 2);
      g.addColorStop(0, `rgba(170,240,255,${al.toFixed(3)})`);
      g.addColorStop(1, 'rgba(60,190,235,0)');
      ctx.fillStyle = g;
      ctx.beginPath();
      ctx.arc(bx, by, w + 2, 0, TAU);
      ctx.fill();
    }

    // the pulse packet — ejected from the core on each whump, rides the channel
    const bx = lx(p);
    const pa = Math.max(0, 0.95 - p * 0.45) * glowF;
    g = ctx.createRadialGradient(bx, 0, 0, bx, 0, w + 4);
    g.addColorStop(0, `rgba(255,255,255,${pa.toFixed(3)})`);
    g.addColorStop(0.35, `rgba(160,240,255,${(pa * 0.7).toFixed(3)})`);
    g.addColorStop(1, 'rgba(80,210,255,0)');
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.arc(bx, 0, w + 4, 0, TAU);
    ctx.fill();

    // trailing tail behind the packet
    const tailX0 = lx(Math.max(0, p - 0.5));
    g = ctx.createLinearGradient(tailX0, 0, bx, 0);
    g.addColorStop(0, 'rgba(80,210,255,0)');
    g.addColorStop(1, `rgba(140,235,255,${(pa * 0.5).toFixed(3)})`);
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.rect(Math.min(tailX0, bx), -w * 0.25, Math.abs(bx - tailX0), w * 0.5);
    ctx.fill();

    // micro lightning arcing down the channel
    if (Math.random() < 0.1 + surge * 0.28) {
      ctx.beginPath();
      ctx.moveTo(lx(0), 0);
      for (let s = 0.15; s <= 1; s += 0.14 + Math.random() * 0.1) {
        const o = (Math.random() - 0.5) * (w * 2 - 3);
        ctx.lineTo(lx(s), o);
      }
      ctx.strokeStyle = `rgba(230,252,255,${(0.4 + 0.45 * surge * Math.random()).toFixed(3)})`;
      ctx.lineWidth = 1.6;
      ctx.shadowColor = 'rgba(120,235,255,1)';
      ctx.shadowBlur = 11 * glowF;
      ctx.stroke();
      ctx.strokeStyle = `rgba(255,255,255,${(0.5 + 0.35 * surge).toFixed(3)})`;
      ctx.lineWidth = 0.7;
      ctx.stroke(); // hot inner filament
      ctx.shadowBlur = 0;
    }
    ctx.restore();

    // socket flash when the packet arrives
    const arr = Math.exp(-Math.pow((p - 0.96) * 18, 2));
    if (arr > 0.02) {
      g = ctx.createRadialGradient(lx(1), 0, 0, lx(1), 0, 12);
      g.addColorStop(0, `rgba(200,250,255,${(arr * 0.8 * glowF).toFixed(3)})`);
      g.addColorStop(1, 'rgba(120,230,255,0)');
      ctx.fillStyle = g;
      ctx.beginPath();
      ctx.arc(lx(1), 0, 12, 0, TAU);
      ctx.fill();
    }
    ctx.restore();
  });
}
