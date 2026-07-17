export interface DrawHousingParams {
  t: number;
  surge: number;
  overdrive: boolean;
  glowFactor: number;
}

export function drawHousing(ctx: CanvasRenderingContext2D, params: DrawHousingParams): void {
  const { t, surge, overdrive: od, glowFactor: glowF } = params;
  const TAU = Math.PI * 2;
  const c = 112;
  const innerR = 74;

  // ambient glow spilling past the housing
  let g = ctx.createRadialGradient(c, c, 62, c, c, 112);
  g.addColorStop(0, `rgba(80,220,255,${Math.min(1, (0.1 + 0.28 * surge) * glowF).toFixed(3)})`);
  g.addColorStop(1, 'rgba(80,220,255,0)');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, 224, 224);

  // lightning filaments, clipped to the interior chamber
  ctx.save();
  ctx.beginPath();
  ctx.arc(c, c, innerR, 0, TAU);
  ctx.clip();
  ctx.globalCompositeOperation = 'lighter';
  if (Math.random() < 0.45 + surge * 0.5 + (od ? 0.35 : 0)) {
    const bolts = od ? 3 : Math.random() < 0.25 + surge * 0.6 ? 2 : 1;
    for (let b = 0; b < bolts; b++) {
      let aa = Math.random() * TAU;
      let rr = 8;
      ctx.beginPath();
      ctx.moveTo(c + Math.cos(aa) * 6, c + Math.sin(aa) * 6);
      while (rr < innerR - 4) {
        rr += 8 + Math.random() * 8;
        aa += (Math.random() - 0.5) * 0.7;
        ctx.lineTo(c + Math.cos(aa) * rr, c + Math.sin(aa) * rr);
      }
      ctx.strokeStyle = `rgba(230,252,255,${(0.45 + 0.5 * surge * Math.random()).toFixed(3)})`;
      ctx.lineWidth = 1.9;
      ctx.shadowColor = 'rgba(120,235,255,1)';
      ctx.shadowBlur = 14;
      ctx.stroke();
      ctx.strokeStyle = `rgba(255,255,255,${(0.55 + 0.4 * surge).toFixed(3)})`;
      ctx.lineWidth = 0.8;
      ctx.stroke(); // hot inner filament
      ctx.shadowBlur = 0;
    }
  }
  ctx.restore();

  // ---- containment housing ----
  ctx.lineWidth = 3;
  ctx.strokeStyle = `rgba(140,240,255,${(0.45 + 0.55 * surge).toFixed(3)})`;
  ctx.shadowColor = 'rgba(120,235,255,0.8)';
  ctx.shadowBlur = (10 + 14 * surge) * glowF;
  ctx.beginPath();
  ctx.arc(c, c, innerR + 2, 0, TAU);
  ctx.stroke();
  ctx.shadowBlur = 0;

  const R0 = innerR + 5;
  const R1 = 106;
  const plate = ctx.createRadialGradient(c, c, R0, c, c, R1);
  plate.addColorStop(0, '#243743');
  plate.addColorStop(0.45, '#141f27');
  plate.addColorStop(1, '#0a1218');

  for (let i = 0; i < 12; i++) {
    // segmented alloy plates
    const a0 = (i * TAU) / 12 + 0.035;
    const a1 = ((i + 1) * TAU) / 12 - 0.035;
    ctx.beginPath();
    ctx.arc(c, c, R1, a0, a1);
    ctx.arc(c, c, R0, a1, a0, true);
    ctx.closePath();
    ctx.fillStyle = plate;
    ctx.fill();
    ctx.strokeStyle = 'rgba(120,180,205,0.18)';
    ctx.lineWidth = 1;
    ctx.stroke();
  }

  for (let i = 0; i < 12; i++) {
    // glowing vent slits, energy circulates
    const a = (i + 0.5) * (TAU / 12);
    const al = Math.max(0, 0.18 + 0.5 * surge + 0.28 * Math.max(0, Math.sin(a - t * 2)));
    ctx.strokeStyle = `rgba(120,235,255,${al.toFixed(3)})`;
    ctx.lineWidth = 3.5;
    ctx.lineCap = 'round';
    ctx.shadowColor = 'rgba(120,235,255,0.8)';
    ctx.shadowBlur = (6 + 10 * surge) * glowF;
    ctx.beginPath();
    ctx.moveTo(c + Math.cos(a) * (R0 + 7), c + Math.sin(a) * (R0 + 7));
    ctx.lineTo(c + Math.cos(a) * (R1 - 9), c + Math.sin(a) * (R1 - 9));
    ctx.stroke();
    ctx.shadowBlur = 0;
  }

  for (let i = 0; i < 12; i++) {
    // bolts at plate seams
    const a = (i * TAU) / 12;
    const x = c + Math.cos(a) * ((R0 + R1) / 2);
    const y = c + Math.sin(a) * ((R0 + R1) / 2);
    ctx.beginPath();
    ctx.arc(x, y, 2.6, 0, TAU);
    ctx.fillStyle = '#31454f';
    ctx.fill();
    ctx.strokeStyle = 'rgba(160,220,240,0.35)';
    ctx.lineWidth = 0.8;
    ctx.stroke();
  }

  ctx.lineWidth = 2.5;
  ctx.strokeStyle = 'rgba(90,130,150,0.5)';
  ctx.beginPath();
  ctx.arc(c, c, R1 + 1, 0, TAU);
  ctx.stroke();
}
