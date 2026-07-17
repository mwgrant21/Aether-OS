export interface DrawWarpParams {
  t: number;
  surge: number;
  phase: number;
  overdrive: boolean;
  glowFactor: number;
}

export function drawWarp(ctx: CanvasRenderingContext2D, params: DrawWarpParams): void {
  const { t, surge, overdrive: od, glowFactor: glowF } = params;
  const p = params.phase;
  const TAU = Math.PI * 2;
  const c = 112;
  const th = 20;
  let g: CanvasGradient;

  // ambient column glow
  g = ctx.createRadialGradient(c, c, 10, c, c, 110);
  g.addColorStop(0, `rgba(80,220,255,${Math.min(1, (0.08 + 0.24 * surge) * glowF).toFixed(3)})`);
  g.addColorStop(1, 'rgba(80,220,255,0)');
  ctx.save();
  ctx.translate(c, c);
  ctx.scale(0.5, 1);
  ctx.translate(-c, -c);
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, 224, 224);
  ctx.restore();

  const pd = (1 - p) * 96; // twin pulse offset from center
  const alloy = (y: number, h: number) => {
    const gg = ctx.createLinearGradient(0, y, 0, y + h);
    gg.addColorStop(0, '#2a3f4c');
    gg.addColorStop(0.5, '#141f27');
    gg.addColorStop(1, '#0a1218');
    return gg;
  };

  // outer casing silhouette
  ctx.fillStyle = '#0b161d';
  ctx.fillRect(c - th - 8, c - 102, (th + 8) * 2, 204);
  ctx.strokeStyle = 'rgba(120,180,205,.35)';
  ctx.lineWidth = 1.2;
  ctx.strokeRect(c - th - 8, c - 102, (th + 8) * 2, 204);

  [-1, 1].forEach((sd) => {
    const Y = (off: number) => c + sd * off;

    // flared antimatter-initiator cap
    g = alloy(Math.min(Y(110), Y(96)), 14);
    ctx.beginPath();
    ctx.moveTo(c - th - 2, Y(96));
    ctx.lineTo(c + th + 2, Y(96));
    ctx.lineTo(c + th + 12, Y(110));
    ctx.lineTo(c - th - 12, Y(110));
    ctx.closePath();
    ctx.fillStyle = g;
    ctx.fill();
    ctx.strokeStyle = 'rgba(120,180,205,.4)';
    ctx.lineWidth = 1;
    ctx.stroke();

    // initiator port — flickers when a pulse is born (p near 0)
    const ia = Math.max(0, 0.25 + 0.75 * Math.exp(-p * 6)) * glowF;
    ctx.fillStyle = `rgba(190,245,255,${ia.toFixed(3)})`;
    ctx.shadowColor = 'rgba(120,235,255,.9)';
    ctx.shadowBlur = 8 * glowF;
    ctx.beginPath();
    ctx.arc(c, Y(103), 3, 0, TAU);
    ctx.fill();
    ctx.shadowBlur = 0;

    // two capacitor stages: rows of amber cells that light as the pulse passes
    ([
      [66, 92, 4],
      [45, 63, 3],
    ] as [number, number, number][]).forEach((st) => {
      const [o0, o1, rows] = st;
      const yTop = Math.min(Y(o0), Y(o1));
      const hh = Math.abs(Y(o1) - Y(o0));
      ctx.fillStyle = alloy(yTop, hh);
      ctx.fillRect(c - th - 4, yTop, (th + 4) * 2, hh);
      ctx.strokeStyle = 'rgba(120,180,205,.3)';
      ctx.lineWidth = 1;
      ctx.strokeRect(c - th - 4, yTop, (th + 4) * 2, hh);
      const rh = hh / rows;
      for (let rr = 0; rr < rows; rr++) {
        const cy = yTop + rh * (rr + 0.5);
        const near = Math.exp(-Math.pow((Math.abs(cy - c) - pd) / 9, 2));
        const cal = Math.min(1, 0.18 + 0.7 * near + 0.15 * surge) * glowF;
        [-1, 1].forEach((cs) => {
          const cx = c + cs * (th / 2 + 1);
          ctx.fillStyle = `rgba(245,198,107,${(cal * 0.85).toFixed(3)})`;
          ctx.shadowColor = 'rgba(245,198,107,.8)';
          ctx.shadowBlur = 6 * cal * glowF;
          ctx.beginPath();
          if (ctx.roundRect) ctx.roundRect(cx - 6, cy - rh * 0.3, 12, rh * 0.6, 2);
          else ctx.rect(cx - 6, cy - rh * 0.3, 12, rh * 0.6);
          ctx.fill();
          ctx.shadowBlur = 0;
          ctx.strokeStyle = 'rgba(20,31,39,.9)';
          ctx.lineWidth = 1;
          ctx.stroke();
        });
      }
    });

    // membrane emitter/spinner — counter-rotating glow ellipse
    const sy = Y(38);
    ctx.fillStyle = alloy(sy - 5, 10);
    ctx.fillRect(c - th - 6, sy - 5, (th + 6) * 2, 10);
    ctx.strokeStyle = 'rgba(120,180,205,.35)';
    ctx.lineWidth = 1;
    ctx.strokeRect(c - th - 6, sy - 5, (th + 6) * 2, 10);
    const spin = t * 2.2 * sd;
    ctx.strokeStyle = `rgba(140,240,255,${((0.3 + 0.5 * surge) * glowF).toFixed(3)})`;
    ctx.lineWidth = 1.6;
    ctx.shadowColor = 'rgba(120,235,255,.8)';
    ctx.shadowBlur = 6 * glowF;
    ctx.beginPath();
    ctx.ellipse(c, sy, th + 2, 3.4, 0, spin, spin + TAU * 0.72);
    ctx.stroke();
    ctx.shadowBlur = 0;

    // zero-point extraction band — thin bright ring where the lens meets the stack
    const zy = Y(31);
    const za = (0.35 + 0.65 * Math.exp(-Math.pow((31 - pd) / 8, 2))) * glowF;
    ctx.strokeStyle = `rgba(190,245,255,${za.toFixed(3)})`;
    ctx.lineWidth = 2;
    ctx.shadowColor = 'rgba(120,235,255,.9)';
    ctx.shadowBlur = 7 * glowF;
    ctx.beginPath();
    ctx.moveTo(c - th + 2, zy);
    ctx.lineTo(c + th - 2, zy);
    ctx.stroke();
    ctx.shadowBlur = 0;
  });

  // ---- central vacuum chamber: rounded sphere ----
  const lensH = 40;
  const lensW = 30;
  const lensPath = () => {
    ctx.beginPath();
    ctx.ellipse(c, c, lensW, lensH, 0, 0, TAU);
  };
  lensPath();
  g = ctx.createRadialGradient(c, c, 4, c, c, lensH);
  g.addColorStop(0, '#0c3d50');
  g.addColorStop(1, '#041722');
  ctx.fillStyle = g;
  ctx.fill();

  ctx.save();
  lensPath();
  ctx.clip();

  // membrane field — horizontal ribs
  ctx.strokeStyle = `rgba(130,220,250,${(0.22 * glowF).toFixed(3)})`;
  ctx.lineWidth = 1;
  ctx.beginPath();
  for (let ry = -lensH + 4; ry <= lensH - 4; ry += 4) {
    ctx.moveTo(c - lensW * 2, c + ry);
    ctx.lineTo(c + lensW * 2, c + ry);
  }
  ctx.stroke();

  ctx.globalCompositeOperation = 'lighter';
  // churning cloud bed inside the chamber — blue wisps with white-hot knots
  for (let i = 0; i < 6; i++) {
    const a1 = t * (0.32 + i * 0.11) + i * 2.4;
    const a2 = t * (0.5 + i * 0.08) + i * 1.7;
    const cx2 = c + Math.cos(a1) * (lensW * 0.62) * Math.sin(a2 + i);
    const cy2 = c + Math.sin(a1 * 0.85 + 1.2) * (lensH * 0.62);
    const br = 10 + 9 * Math.abs(Math.sin(t * 0.7 + i * 2.1));
    const al = Math.max(0, (0.1 + 0.18 * surge) * (0.55 + 0.45 * Math.sin(t * 2.4 + i * 1.9))) * glowF;
    g = ctx.createRadialGradient(cx2, cy2, 0, cx2, cy2, br);
    g.addColorStop(0, i % 3 ? `rgba(150,225,255,${al.toFixed(3)})` : `rgba(255,255,255,${(al * 0.9).toFixed(3)})`);
    g.addColorStop(0.55, `rgba(70,180,240,${(al * 0.5).toFixed(3)})`);
    g.addColorStop(1, 'rgba(40,140,210,0)');
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.arc(cx2, cy2, br, 0, TAU);
    ctx.fill();
  }

  // twin pulses converging through the lens tips
  [-1, 1].forEach((sd) => {
    const py2 = c + sd * pd;
    const pa = (0.5 + 0.4 * (1 - p)) * glowF;
    g = ctx.createRadialGradient(c, py2, 0, c, py2, 14);
    g.addColorStop(0, `rgba(255,255,255,${pa.toFixed(3)})`);
    g.addColorStop(0.4, `rgba(160,240,255,${(pa * 0.6).toFixed(3)})`);
    g.addColorStop(1, 'rgba(80,210,255,0)');
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.arc(c, py2, 14, 0, TAU);
    ctx.fill();
  });

  // vacuum chamber core — collision flash
  g = ctx.createRadialGradient(c, c, 0, c, c, 18 + 14 * surge);
  g.addColorStop(0, `rgba(255,255,255,${(0.28 + 0.7 * surge).toFixed(3)})`);
  g.addColorStop(0.45, `rgba(140,235,255,${(0.2 + 0.5 * surge).toFixed(3)})`);
  g.addColorStop(1, 'rgba(100,210,255,0)');
  ctx.fillStyle = g;
  ctx.beginPath();
  ctx.arc(c, c, 18 + 14 * surge, 0, TAU);
  ctx.fill();

  // arcing inside the chamber
  if (Math.random() < 0.3 + surge * 0.5 + (od ? 0.25 : 0)) {
    const a0 = Math.random() * TAU;
    let xx = c + Math.cos(a0) * 4;
    let yy = c + Math.sin(a0) * 4;
    ctx.beginPath();
    ctx.moveTo(xx, yy);
    for (let sgm = 0; sgm < 4; sgm++) {
      xx += (Math.random() - 0.5) * 22;
      yy += (Math.random() - 0.5) * 26;
      ctx.lineTo(xx, yy);
    }
    ctx.strokeStyle = `rgba(230,252,255,${(0.5 + 0.45 * surge * Math.random()).toFixed(3)})`;
    ctx.lineWidth = 1.8;
    ctx.shadowColor = 'rgba(120,235,255,1)';
    ctx.shadowBlur = 13 * glowF;
    ctx.stroke();
    ctx.strokeStyle = `rgba(255,255,255,${(0.6 + 0.35 * surge).toFixed(3)})`;
    ctx.lineWidth = 0.7;
    ctx.stroke(); // hot inner filament
    ctx.shadowBlur = 0;
  }
  ctx.restore();

  // chamber rim + pulsing containment shield rings
  lensPath();
  ctx.strokeStyle = `rgba(150,235,255,${((0.4 + 0.5 * surge) * glowF).toFixed(3)})`;
  ctx.lineWidth = 1.6;
  ctx.shadowColor = 'rgba(120,235,255,.8)';
  ctx.shadowBlur = (5 + 9 * surge) * glowF;
  ctx.stroke();
  ctx.shadowBlur = 0;

  // shield: two breathing rings just outside the chamber, expanding softly on each whump
  for (let sh = 0; sh < 2; sh++) {
    const grow = 3 + sh * 4 + surge * 5 + Math.sin(t * 1.6 + sh * 1.4) * 1.5;
    const sa = Math.max(0, 0.28 - sh * 0.1 + 0.35 * surge) * glowF;
    ctx.strokeStyle = `rgba(120,225,255,${sa.toFixed(3)})`;
    ctx.lineWidth = 1.1 - sh * 0.3;
    ctx.setLineDash([7, 5]);
    ctx.lineDashOffset = -t * 14 * (sh ? -1 : 1);
    ctx.beginPath();
    ctx.ellipse(c, c, lensW + grow, lensH + grow, 0, 0, TAU);
    ctx.stroke();
    ctx.setLineDash([]);
  }

  // focusing forcefield coils at the lens waist
  [-1, 1].forEach((cs) => {
    const cx = c + cs * (lensW + 7);
    ctx.fillStyle = alloy(c - 7, 14);
    ctx.beginPath();
    ctx.ellipse(cx, c, 5, 7, 0, 0, TAU);
    ctx.fill();
    ctx.strokeStyle = 'rgba(120,180,205,.4)';
    ctx.lineWidth = 1;
    ctx.stroke();
    ctx.fillStyle = `rgba(140,235,255,${((0.3 + 0.6 * surge) * glowF).toFixed(3)})`;
    ctx.beginPath();
    ctx.arc(cx, c, 2, 0, TAU);
    ctx.fill();
  });

  // PTC docking cylinders reaching toward the horizontal conduits
  [-1, 1].forEach((cs) => {
    const x0 = c + cs * (lensW + 10);
    const x1 = c + cs * 52;
    const hw2 = 9;
    g = ctx.createLinearGradient(0, c - hw2, 0, c + hw2);
    g.addColorStop(0, '#2a3f4c');
    g.addColorStop(0.5, '#18242d');
    g.addColorStop(1, '#0a1218');
    ctx.fillStyle = g;
    ctx.fillRect(Math.min(x0, x1), c - hw2, Math.abs(x1 - x0), hw2 * 2);
    ctx.strokeStyle = 'rgba(120,180,205,.35)';
    ctx.lineWidth = 1;
    ctx.strokeRect(Math.min(x0, x1), c - hw2, Math.abs(x1 - x0), hw2 * 2);
    // energy window along the cylinder — carries the outbound pulse glow
    const wa = (0.18 + 0.5 * surge) * glowF;
    ctx.fillStyle = `rgba(120,225,255,${wa.toFixed(3)})`;
    ctx.shadowColor = 'rgba(120,235,255,.8)';
    ctx.shadowBlur = 6 * surge * glowF;
    ctx.fillRect(Math.min(x0, x1) + 2, c - 2, Math.abs(x1 - x0) - 4, 4);
    ctx.shadowBlur = 0;
    ctx.beginPath();
    ctx.ellipse(x1, c, 3.5, hw2 + 1, 0, 0, TAU);
    ctx.fillStyle = '#31454f';
    ctx.fill();
    ctx.strokeStyle = 'rgba(160,220,240,.35)';
    ctx.lineWidth = 0.8;
    ctx.stroke();
  });
}
