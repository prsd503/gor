// E-Bouquet rendering engine (shared by the page and the offline test renderer).
// Plain canvas 2D drawing only, so it runs in the browser and in Node.
//
// Everything random is driven by one seed, which means the live preview and
// the exported GIF are pixel-for-pixel the same arrangement.
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.OwBouquet = api;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const TAU = Math.PI * 2;
  const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
  const lerp = (a, b, t) => a + (b - a) * t;

  // ------------------------------------------------------------- random ----
  function makeRandom(seed) {
    let s = (seed >>> 0) || 0x9e3779b9;
    return function () {
      s ^= s << 13; s >>>= 0;
      s ^= s >>> 17;
      s ^= s << 5; s >>>= 0;
      return s / 4294967296;
    };
  }

  function hashString(str) {
    let h = 2166136261;
    for (let i = 0; i < str.length; i++) {
      h ^= str.charCodeAt(i);
      h = Math.imul(h, 16777619);
    }
    return h >>> 0;
  }

  // --------------------------------------------------------------- color ---
  const SKY = { top: '#181033', mid: '#3b2154', low: '#63325a', floor: '#150f2a' };

  function roundedRect(ctx, x, y, w, h, r) {
    const rr = Math.min(r, Math.abs(w) / 2, Math.abs(h) / 2);
    ctx.beginPath();
    ctx.moveTo(x + rr, y);
    ctx.arcTo(x + w, y, x + w, y + h, rr);
    ctx.arcTo(x + w, y + h, x, y + h, rr);
    ctx.arcTo(x, y + h, x, y, rr);
    ctx.arcTo(x, y, x + w, y, rr);
    ctx.closePath();
  }

  // ------------------------------------------------------------ artwork ----
  // Night sky: violet gradient, a warm hush of gold behind the bouquet, a soft
  // moon, and a sprinkle of stars that twinkle at different rates.
  function paintSky(ctx, w, h) {
    const g = ctx.createLinearGradient(0, 0, w * 0.4, h);
    g.addColorStop(0, SKY.top);
    g.addColorStop(0.52, SKY.mid);
    g.addColorStop(1, SKY.low);
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, w, h);

    const halo = ctx.createRadialGradient(w * 0.5, h * 0.54, w * 0.02, w * 0.5, h * 0.54, h * 0.56);
    halo.addColorStop(0, 'rgba(255, 196, 132, 0.50)');
    halo.addColorStop(0.35, 'rgba(255, 172, 132, 0.20)');
    halo.addColorStop(1, 'rgba(255, 172, 132, 0)');
    ctx.fillStyle = halo;
    ctx.fillRect(0, 0, w, h);

    const mx = w * 0.79, my = h * 0.115, mr = h * 0.042;
    const moon = ctx.createRadialGradient(mx, my, mr * 0.3, mx, my, mr * 3.2);
    moon.addColorStop(0, 'rgba(255, 248, 226, 0.98)');
    moon.addColorStop(0.22, 'rgba(255, 240, 205, 0.55)');
    moon.addColorStop(1, 'rgba(255, 240, 205, 0)');
    ctx.fillStyle = moon;
    ctx.beginPath();
    ctx.arc(mx, my, mr * 3.2, 0, TAU);
    ctx.fill();
    ctx.fillStyle = '#fff8e4';
    ctx.beginPath();
    ctx.arc(mx, my, mr, 0, TAU);
    ctx.fill();
    ctx.fillStyle = 'rgba(214, 190, 150, 0.30)';
    ctx.beginPath();
    ctx.arc(mx - mr * 0.25, my - mr * 0.2, mr * 0.28, 0, TAU);
    ctx.arc(mx + mr * 0.3, my + mr * 0.25, mr * 0.2, 0, TAU);
    ctx.fill();
  }

  function buildStars(count, seed, w, h) {
    const rnd = makeRandom(seed);
    const stars = [];
    for (let i = 0; i < count; i++) {
      const big = rnd() > 0.88;
      stars.push({
        x: rnd() * w,
        y: rnd() * h * 0.86,
        r: big ? lerp(2.4, 4.2, rnd()) : lerp(0.7, 2.2, rnd()),
        phase: rnd() * TAU,
        speed: lerp(0.8, 2.4, rnd()),
        depth: rnd(),
        sparkle: big || rnd() > 0.6,
        warm: rnd() > 0.72
      });
    }
    return stars;
  }

  function drawStar(ctx, x, y, r, alpha, warm, sparkle) {
    const tint = warm ? '#ffe9bf' : '#ffffff';
    ctx.save();
    ctx.translate(x, y);
    ctx.globalAlpha = alpha;
    const halo = ctx.createRadialGradient(0, 0, 0, 0, 0, r * 5);
    halo.addColorStop(0, tint);
    halo.addColorStop(0.18, warm ? 'rgba(255,224,176,0.55)' : 'rgba(226,232,255,0.5)');
    halo.addColorStop(1, 'rgba(255,255,255,0)');
    ctx.fillStyle = halo;
    ctx.beginPath();
    ctx.arc(0, 0, r * 5, 0, TAU);
    ctx.fill();
    ctx.fillStyle = tint;
    ctx.beginPath();
    ctx.arc(0, 0, r * 0.75, 0, TAU);
    ctx.fill();
    if (sparkle) {
      ctx.globalAlpha = alpha * 0.9;
      const s = r * 3.4;
      const k = s * 0.14;
      ctx.beginPath();
      ctx.moveTo(0, -s);
      ctx.quadraticCurveTo(k, -k, s, 0);
      ctx.quadraticCurveTo(k, k, 0, s);
      ctx.quadraticCurveTo(-k, k, -s, 0);
      ctx.quadraticCurveTo(-k, -k, 0, -s);
      ctx.fill();
    }
    ctx.restore();
  }

  function paintStars(ctx, stars, time, reduceMotion) {
    for (let i = 0; i < stars.length; i++) {
      const s = stars[i];
      const tw = 0.5 + 0.5 * Math.sin(s.phase + time * s.speed);
      const alpha = reduceMotion ? 0.75 : lerp(0.30, 1.0, tw);
      drawStar(ctx, s.x, s.y, s.r, alpha, s.warm, s.sparkle && (reduceMotion || tw > 0.45));
    }
  }

  // Soft shooting star that sweeps across the sky once per loop (skipped when
  // the viewer prefers reduced motion).
  function paintShootingStar(ctx, w, h, time, reduceMotion) {
    if (reduceMotion) return;
    const cycle = time % 6;
    if (cycle > 1.5) return;
    const t = cycle / 1.5;
    const a = 0.9 * Math.sin(Math.PI * t);
    const x = lerp(w * 0.06, w * 0.42, t);
    const y = lerp(h * 0.10, h * 0.24, t);
    ctx.save();
    ctx.globalAlpha = a;
    const g = ctx.createLinearGradient(x, y, x - w * 0.16, y - h * 0.05);
    g.addColorStop(0, 'rgba(255,255,255,0.9)');
    g.addColorStop(1, 'rgba(255,255,255,0)');
    ctx.strokeStyle = g;
    ctx.lineWidth = Math.max(1.2, w * 0.0028);
    ctx.lineCap = 'round';
    ctx.beginPath();
    ctx.moveTo(x, y);
    ctx.lineTo(x - w * 0.16, y - h * 0.05);
    ctx.stroke();
    ctx.restore();
  }

  // -------------------------------------------------------------- foliage --
  function drawLeaf(ctx, x, y, len, angle, bend, color, vein) {
    ctx.save();
    ctx.translate(x, y);
    ctx.rotate(angle);
    const wdt = len * 0.30;
    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.moveTo(0, 0);
    ctx.bezierCurveTo(wdt * bend, -len * 0.22, wdt * bend * 0.9, -len * 0.74, 0, -len);
    ctx.bezierCurveTo(-wdt * bend * 0.9, -len * 0.74, -wdt * bend, -len * 0.22, 0, 0);
    ctx.fill();
    if (vein) {
      ctx.strokeStyle = vein;
      ctx.lineWidth = Math.max(0.6, len * 0.014);
      ctx.beginPath();
      ctx.moveTo(0, -len * 0.04);
      ctx.quadraticCurveTo(wdt * 0.22, -len * 0.5, 0, -len * 0.93);
      ctx.stroke();
    }
    ctx.restore();
  }

  function drawFern(ctx, x, y, len, angle, color, dark) {
    ctx.save();
    ctx.translate(x, y);
    ctx.rotate(angle);
    // curved rachis
    const curve = len * 0.13;
    const pt = (t) => [Math.sin(t * Math.PI * 0.55) * curve, -len * t];
    ctx.strokeStyle = dark;
    ctx.lineWidth = Math.max(1, len * 0.020);
    ctx.lineCap = 'round';
    ctx.beginPath();
    ctx.moveTo(0, 0);
    for (let t = 0.1; t <= 1.001; t += 0.1) {
      const [px, py] = pt(Math.min(1, t));
      ctx.lineTo(px, py);
    }
    ctx.stroke();
    // leaflets
    const pairs = 9;
    for (let i = 1; i <= pairs; i++) {
      const t = i / (pairs + 1);
      const [px, py] = pt(t);
      const spread = (0.95 - t * 0.42);
      const size = len * 0.135 * (1 - t * 0.55);
      for (const dir of [-1, 1]) {
        ctx.save();
        ctx.translate(px, py);
        ctx.rotate(dir * spread);
        ctx.fillStyle = i % 2 ? color : dark;
        ctx.beginPath();
        ctx.moveTo(0, 0);
        ctx.quadraticCurveTo(dir * size * 0.85, -size * 0.55, dir * size * 1.5, -size * 0.18);
        ctx.quadraticCurveTo(dir * size * 0.95, size * 0.4, 0, 0);
        ctx.fill();
        ctx.restore();
      }
    }
    // tip
    const [tx, ty] = pt(1);
    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.ellipse(tx, ty - len * 0.03, len * 0.045, len * 0.09, 0, 0, TAU);
    ctx.fill();
    ctx.restore();
  }

  function drawEucalyptus(ctx, x, y, len, angle, color, dark) {
    ctx.save();
    ctx.translate(x, y);
    ctx.rotate(angle);
    ctx.strokeStyle = dark;
    ctx.lineWidth = Math.max(0.9, len * 0.018);
    ctx.lineCap = 'round';
    ctx.beginPath();
    ctx.moveTo(0, 0);
    ctx.quadraticCurveTo(len * 0.1, -len * 0.55, len * 0.02, -len);
    ctx.stroke();
    const n = 6;
    for (let i = 1; i <= n; i++) {
      const t = i / (n + 1);
      const px = Math.sin(t * 1.6) * len * 0.06;
      const py = -len * t;
      const r = len * 0.088 * (1 - t * 0.40);
      for (const dir of [-1, 1]) {
        ctx.fillStyle = i % 3 === 0 ? color : dark;
        ctx.beginPath();
        ctx.ellipse(px + dir * r * 1.05, py, r * 1.15, r * 0.82, dir * 0.55, 0, TAU);
        ctx.fill();
      }
    }
    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.ellipse(len * 0.02, -len * 1.01, len * 0.05, len * 0.09, 0, 0, TAU);
    ctx.fill();
    ctx.restore();
  }

  // -------------------------------------------------------------- bouquet --
  // Blooms sit on a tilted dome. Radius drives both position and depth: the
  // outer rim is drawn first (and slightly smaller), the centre sits on top.
  function layoutBouquet(opts) {
    const count = clamp(Math.round(opts.count || 0), 0, 12);
    const width = opts.width, height = opts.height;
    const seed = (opts.seed >>> 0) || 1;
    const rnd = makeRandom(seed);

    // Dome geometry can be supplied by the card (so the page and the export
    // agree) or falls back to sensible poster proportions.
    const dome = opts.dome || {};
    const bx = dome.cx != null ? dome.cx : width * 0.5;
    const by = dome.cy != null ? dome.cy : height * 0.455;
    const R = dome.rx != null ? dome.rx : width * 0.375;
    const RY = dome.ry != null ? dome.ry : R * 0.86;

    // Bloom size scales with the dome, so a 6-flower bouquet looks generous
    // and a 10-flower one still fits without crowding.
    const baseSize = (dome.bloom || R * 0.72) * (count > 8 ? 0.90 : 1);

    const slots = [];
    const golden = Math.PI * (3 - Math.sqrt(5));
    for (let i = 0; i < count; i++) {
      const t = (i + 0.52) / count;
      const rad = Math.sqrt(t) * 0.94;
      const ang = i * golden + 0.75;
      const px = Math.cos(ang) * rad + (rnd() - 0.5) * 0.12;
      const py = Math.sin(ang) * rad * 0.94 + (rnd() - 0.5) * 0.12;
      const rr = Math.min(1.08, Math.hypot(px, py));

      const x = bx + px * R * 0.80;
      const y = by + py * RY * 0.80;
      const size = baseSize * lerp(1.06, 0.86, rr) * lerp(0.96, 1.04, rnd());
      const tilt = Math.atan2(px, -py) * 0.14 * rr;

      slots.push({
        index: i, x, y, size, rr, tilt,
        depth: rr,
        angle: tilt + (rnd() - 0.5) * 0.14,
        phase: rnd() * TAU,
        speed: lerp(0.55, 1.15, rnd()),
        bob: lerp(1.2, 3.4, rnd()),
        flower: i % Math.max(1, opts.flowerCount || count)
      });
    }

    // back (outer rim) first, centre last
    slots.sort((a, b) => b.depth - a.depth || a.y - b.y);

    // manual nudges (from the page's fine-tune controls), keyed by bloom index
    const nudges = opts.nudges || null;
    if (nudges) {
      slots.forEach((slot, i) => {
        const n = nudges[slot.index];
        if (!n) return;
        slot.x += (n.dx || 0) * width * 0.018;
        slot.y += (n.dy || 0) * height * 0.018;
        if (n.front) {
          // move this bloom to the end of the draw order
          slot.front = true;
        }
      });
      slots.sort((a, b) => (b.depth - a.depth || a.y - b.y));
      const front = slots.filter(s => s.front);
      if (front.length) {
        for (const f of front) slots.splice(slots.indexOf(f), 1);
        slots.push(...front);
      }
    }

    return {
      slots, bx, by, R, RY,
      wrap: {
        x: bx,
        top: by + RY * 0.10,
        neck: dome.neck != null ? dome.neck : height * 0.79,
        topW: R * 1.02,
        neckW: R * 0.74
      }
    };
  }

  function buildGreenery(layout, seed, style) {
    const rnd = makeRandom((seed ^ 0x2f9a1c3d) >>> 0);
    const items = [];
    const { bx, by, R, RY, wrap } = layout;
    const look = style || 'classic';
    const scale = look === 'lush' ? 1.12 : look === 'minimal' ? 0.82 : 1;

    // Ferns fan out from behind the dome
    const fernCount = look === 'minimal' ? 5 : look === 'lush' ? 10 : 8;
    for (let i = 0; i < fernCount; i++) {
      const ang = lerp(-1.22, 1.22, i / (fernCount - 1)) + (rnd() - 0.5) * 0.14;
      items.push({
        kind: 'fern',
        x: bx + Math.sin(ang) * R * 0.30,
        y: wrap.top + RY * 0.12,
        len: R * lerp(1.02, 1.40, rnd()) * scale,
        angle: ang,
        color: ['#43714f', '#528459'][i % 2],
        dark: '#356046',
        phase: rnd() * TAU, speed: lerp(0.35, 0.8, rnd())
      });
    }

    // Eucalyptus sprays around the shoulders
    const eucaCount = look === 'minimal' ? 8 : look === 'lush' ? 18 : 14;
    for (let i = 0; i < eucaCount; i++) {
      const side = i % 2 ? 1 : -1;
      const ang = side * lerp(0.58, 1.42, rnd());
      items.push({
        kind: 'euca',
        x: bx + Math.sin(ang) * R * 0.26,
        y: by + RY * 0.36,
        len: R * lerp(0.68, 1.02, rnd()) * scale,
        angle: ang,
        color: ['#7fa88a', '#6d9a7d', '#8fb59a'][i % 3],
        dark: ['#4a7060', '#3f6555', '#557c68'][i % 3],
        phase: rnd() * TAU, speed: lerp(0.4, 0.9, rnd())
      });
    }

    // Short leaves spilling over the front corners of the wrap
    const leafCount = look === 'minimal' ? 2 : look === 'lush' ? 8 : 6;
    for (let i = 0; i < leafCount; i++) {
      const side = i % 2 ? 1 : -1;
      items.push({
        kind: 'leaf',
        x: bx + side * R * lerp(0.52, 0.68, rnd()),
        y: by + RY * lerp(0.50, 0.62, rnd()),
        len: R * lerp(0.34, 0.50, rnd()) * scale,
        angle: side * lerp(1.0, 1.34, rnd()),
        bend: lerp(0.95, 1.35, rnd()),
        color: ['#46764f', '#538257'][i % 2],
        vein: 'rgba(255,255,255,0.16)',
        phase: rnd() * TAU, speed: lerp(0.5, 1, rnd())
      });
    }
    return items;
  }

  function drawFoliageItem(ctx, item, time, reduceMotion) {
    const swayAmount = item.kind === 'leaf' ? 0.03 : 0.022;
    const a = reduceMotion ? 0 : swayAmount * Math.sin(time * item.speed + item.phase);
    ctx.save();
    ctx.translate(item.x, item.y);
    ctx.rotate(a);
    ctx.translate(-item.x, -item.y);
    if (item.kind === 'fern') drawFern(ctx, item.x, item.y, item.len, item.angle, item.color, item.dark);
    else if (item.kind === 'euca') drawEucalyptus(ctx, item.x, item.y, item.len, item.angle, item.color, item.dark);
    else drawLeaf(ctx, item.x, item.y, item.len, item.angle, item.bend, item.color, item.vein);
    ctx.restore();
  }

  // Kraft wrap with a fold, a ribbon and a bow.
  function drawWrap(ctx, wrap) {
    const { x, top, neck, topW, neckW } = wrap;
    ctx.save();

    const body = ctx.createLinearGradient(x - topW / 2, top, x + topW / 2, neck);
    body.addColorStop(0, '#f3e4cd');
    body.addColorStop(0.38, '#efdcc0');
    body.addColorStop(0.72, '#e2c8a6');
    body.addColorStop(1, '#c9a983');
    ctx.fillStyle = body;
    ctx.beginPath();
    ctx.moveTo(x - topW / 2, top);
    ctx.quadraticCurveTo(x - topW * 0.44, lerp(top, neck, 0.5), x - neckW / 2, neck);
    ctx.quadraticCurveTo(x, neck + neckW * 0.12, x + neckW / 2, neck);
    ctx.quadraticCurveTo(x + topW * 0.44, lerp(top, neck, 0.5), x + topW / 2, top);
    ctx.quadraticCurveTo(x, top - topW * 0.10, x - topW / 2, top);
    ctx.closePath();
    ctx.fill();

    // inner shadow under the flowers
    const shade = ctx.createLinearGradient(0, top - topW * 0.1, 0, top + topW * 0.22);
    shade.addColorStop(0, 'rgba(92, 58, 32, 0.38)');
    shade.addColorStop(1, 'rgba(92, 58, 32, 0)');
    ctx.fillStyle = shade;
    ctx.beginPath();
    ctx.moveTo(x - topW / 2, top);
    ctx.quadraticCurveTo(x, top - topW * 0.10, x + topW / 2, top);
    ctx.quadraticCurveTo(x, top + topW * 0.26, x - topW / 2, top);
    ctx.fill();

    // fold seam
    ctx.strokeStyle = 'rgba(146, 108, 70, 0.30)';
    ctx.lineWidth = Math.max(1, topW * 0.006);
    ctx.beginPath();
    ctx.moveTo(x - topW * 0.06, top + topW * 0.04);
    ctx.quadraticCurveTo(x - neckW * 0.08, lerp(top, neck, 0.55), x - neckW * 0.02, neck);
    ctx.stroke();

    // ribbon
    const ribY = lerp(top, neck, 0.80);
    const ribW = lerp(topW, neckW, 0.80);
    const ribH = topW * 0.085;
    const rib = ctx.createLinearGradient(0, ribY - ribH / 2, 0, ribY + ribH / 2);
    rib.addColorStop(0, '#b8763f');
    rib.addColorStop(0.5, '#a05f2f');
    rib.addColorStop(1, '#7f4823');
    ctx.fillStyle = rib;
    roundedRect(ctx, x - ribW / 2 - ribW * 0.02, ribY - ribH / 2, ribW + ribW * 0.04, ribH, ribH * 0.35);
    ctx.fill();

    // bow
    ctx.fillStyle = '#a96533';
    ctx.beginPath();
    ctx.ellipse(x - ribW * 0.17, ribY, ribW * 0.12, ribH * 0.85, -0.35, 0, TAU);
    ctx.fill();
    ctx.beginPath();
    ctx.ellipse(x + ribW * 0.17, ribY, ribW * 0.12, ribH * 0.85, 0.35, 0, TAU);
    ctx.fill();
    ctx.fillStyle = '#c48349';
    ctx.beginPath();
    ctx.ellipse(x - ribW * 0.15, ribY - ribH * 0.05, ribW * 0.075, ribH * 0.6, -0.3, 0, TAU);
    ctx.fill();
    ctx.beginPath();
    ctx.ellipse(x + ribW * 0.15, ribY - ribH * 0.05, ribW * 0.075, ribH * 0.6, 0.3, 0, TAU);
    ctx.fill();
    // tails
    ctx.fillStyle = '#96562b';
    ctx.beginPath();
    ctx.moveTo(x - ribW * 0.03, ribY + ribH * 0.3);
    ctx.lineTo(x - ribW * 0.13, ribY + ribH * 1.5);
    ctx.lineTo(x - ribW * 0.02, ribY + ribH * 1.15);
    ctx.lineTo(x + ribW * 0.04, ribY + ribH * 0.35);
    ctx.closePath();
    ctx.fill();
    ctx.beginPath();
    ctx.moveTo(x + ribW * 0.03, ribY + ribH * 0.3);
    ctx.lineTo(x + ribW * 0.14, ribY + ribH * 1.45);
    ctx.lineTo(x + ribW * 0.03, ribY + ribH * 1.1);
    ctx.lineTo(x - ribW * 0.04, ribY + ribH * 0.35);
    ctx.closePath();
    ctx.fill();
    // knot
    ctx.fillStyle = '#8d4f26';
    ctx.beginPath();
    ctx.ellipse(x, ribY, ribW * 0.045, ribH * 0.7, 0, 0, TAU);
    ctx.fill();
    ctx.restore();
  }

  function drawBloom(ctx, slot, img, time, reduceMotion) {
    const sway = reduceMotion ? 0 : 1;
    const dy = sway * slot.bob * Math.sin(time * slot.speed + slot.phase);
    const rot = sway * 0.02 * Math.sin(time * slot.speed * 0.7 + slot.phase + 0.8);
    const s = slot.size;
    ctx.save();
    ctx.translate(slot.x, slot.y + dy);
    ctx.rotate(slot.angle + rot);

    // contact shadow so each bloom reads separately
    const sh = ctx.createRadialGradient(0, s * 0.12, s * 0.2, 0, s * 0.12, s * 0.58);
    sh.addColorStop(0, 'rgba(40, 16, 48, 0.40)');
    sh.addColorStop(0.65, 'rgba(40, 16, 48, 0.20)');
    sh.addColorStop(1, 'rgba(40, 16, 48, 0)');
    ctx.fillStyle = sh;
    ctx.beginPath();
    ctx.arc(0, s * 0.12, s * 0.58, 0, TAU);
    ctx.fill();

    const ar = img.width / img.height;
    const dw = s * Math.max(1, ar), dh = s * Math.max(1, 1 / ar);
    ctx.drawImage(img, -dw / 2, -dh / 2, dw, dh);
    ctx.restore();
  }

  function drawBouquet(ctx, opts) {
    const { layout, images, time = 0, reduceMotion = false } = opts;
    const greens = layout.greenery || (layout.greenery = buildGreenery(layout, opts.seed || 1, opts.greenery));
    for (const item of greens) {
      if (item.kind !== 'leaf') drawFoliageItem(ctx, item, time, reduceMotion);
    }
    drawWrap(ctx, layout.wrap);
    for (const slot of layout.slots) {
      const img = images[slot.flower];
      if (img) drawBloom(ctx, slot, img, time, reduceMotion);
    }
    // a few leaves poking over the wrap so the stems do not stop dead
    for (const item of greens) {
      if (item.kind === 'leaf') drawFoliageItem(ctx, item, time, reduceMotion);
    }
  }


  // ----------------------------------------------------------- TYPOGRAPHY --
  // The page uses the site fonts; the offline renderer falls back to whatever
  // the system has, so the layout is measured rather than hard-coded.
  const SCRIPT = (px) => `italic 700 ${px}px "Caveat", "Segoe Script", "Bradley Hand", cursive`;
  const CAPS = (px) => `600 ${px}px "Inter", "Helvetica Neue", Arial, sans-serif`;

  function wrapLines(ctx, text, maxWidth) {
    const words = String(text).split(/\s+/).filter(Boolean);
    const lines = [];
    let line = '';
    for (const word of words) {
      const test = line ? line + ' ' + word : word;
      if (ctx.measureText(test).width <= maxWidth || !line) line = test;
      else { lines.push(line); line = word; }
    }
    if (line) lines.push(line);
    return lines;
  }

  function drawSpaced(ctx, text, x, y, spacing) {
    // letter-spaced small caps, centred on x
    const chars = Array.from(text);
    let total = 0;
    for (const ch of chars) total += ctx.measureText(ch).width + spacing;
    total -= spacing;
    let cx = x - total / 2;
    const prev = ctx.textAlign;
    ctx.textAlign = 'left';
    for (const ch of chars) {
      ctx.fillText(ch, cx, y);
      cx += ctx.measureText(ch).width + spacing;
    }
    ctx.textAlign = prev;
  }

  // ------------------------------------------------------------ THE CARD ---
  // Poster layout, computed from the text so nothing overlaps whatever the
  // message length: header (crest + wordmark) | bouquet | message | credit.
  function measureMessage(ctx, width, message, from) {
    const boxW = width * 0.86;
    const msgFont = Math.round(width * 0.0395);
    const innerW = boxW - width * 0.13;
    ctx.save();
    ctx.font = `italic 500 ${msgFont}px "Caveat", "Segoe Script", cursive`;
    let lines = (message || '').trim() ? wrapLines(ctx, message.trim(), innerW) : [];
    if (lines.length > 5) {
      lines = lines.slice(0, 5);
      lines[4] = lines[4].replace(/[.,;:]?$/, '…');
    }
    ctx.restore();
    const fromFont = Math.round(width * 0.0315);
    const padY = width * 0.040;
    const lineH = msgFont * 1.10;
    const height = padY * 2 + Math.max(1, lines.length) * lineH + (from ? fromFont * 1.85 : 0);
    return { lines, msgFont, fromFont, lineH, padY, boxW, boxH: height };
  }

  function drawCard(ctx, opts) {
    const { width, height, time = 0, reduceMotion = false, message, from } = opts;
    const stars = opts.stars || buildStars(170, opts.seed || 7, width, height);

    paintSky(ctx, width, height);
    paintStars(ctx, stars, time, reduceMotion);
    paintShootingStar(ctx, width, height, time, reduceMotion);

    // ---- header block
    const owlR = width * 0.048;
    const headerTop = height * 0.030;
    const crestCy = headerTop + owlR;
    const titleSize = Math.round(width * 0.096);
    const titleY = crestCy + owlR + titleSize * 0.80;
    const subY = titleY + width * 0.040;
    const ruleY = subY + width * 0.030;

    // ---- message block (bottom anchored)
    const msg = measureMessage(ctx, width, message, from);
    const footerY = height * 0.966;
    const msgBottom = footerY - height * 0.040;
    const msgTop = msgBottom - msg.boxH;

    // ---- bouquet occupies what is left: dome on top of a tapered wrap.
    // The wrap is sized first (a third of the free height), then the dome
    // takes the rest, so the bouquet always fills the gap without clipping.
    const availTop = ruleY + height * 0.035;
    const availBottom = msgTop - height * 0.025;
    const availH = Math.max(height * 0.30, availBottom - availTop);
    // greenery reaches ~1.35 x RY above the dome centre, the wrap hangs 0.30 x
    // RY below it, so the two together must fit the available band.
    const wrapH = availH * 0.325;
    const RY = (availH - wrapH) / 1.62;
    const R = Math.min(width * 0.395, RY / 0.82);
    const by = availBottom - wrapH - RY * 0.30;
    const neck = by + RY * 0.30 + wrapH;

    const layout = opts.layout || layoutBouquet({
      count: opts.flowers.length, seed: opts.seed || 7, width, height,
      flowerCount: opts.flowerCount || opts.flowers.length,
      nudges: opts.nudges || null,
      dome: { cx: width * 0.5, cy: by, rx: R, ry: RY, neck, bloom: R * 0.72 }
    });

    drawHeader(ctx, { width, crestCy, owlR, titleY, titleSize, subY, ruleY }, opts.owlImg);
    drawBouquet(ctx, { layout, images: opts.images, time, reduceMotion, seed: opts.seed, greenery: opts.greenery });
    drawMessage(ctx, { width, box: msg, top: msgTop, message, from });
    drawFooter(ctx, { width, y: footerY });
    return layout;
  }

  function drawHeader(ctx, g, owlImg) {
    const { width, crestCy, owlR, titleY, titleSize, subY, ruleY } = g;
    ctx.save();
    ctx.textAlign = 'center';
    ctx.textBaseline = 'alphabetic';

    if (owlImg) {
      const cx = width / 2;
      ctx.save();
      ctx.beginPath();
      ctx.arc(cx, crestCy, owlR, 0, TAU);
      ctx.closePath();
      ctx.clip();
      const scale = (owlR * 2.7) / owlImg.width;
      ctx.drawImage(owlImg, cx - owlImg.width * scale / 2, crestCy - owlImg.height * scale / 2,
        owlImg.width * scale, owlImg.height * scale);
      ctx.restore();
      const ring = ctx.createLinearGradient(cx - owlR, crestCy - owlR, cx + owlR, crestCy + owlR);
      ring.addColorStop(0, 'rgba(255, 232, 190, 0.85)');
      ring.addColorStop(1, 'rgba(255, 196, 128, 0.45)');
      ctx.strokeStyle = ring;
      ctx.lineWidth = Math.max(1.2, width * 0.0035);
      ctx.beginPath();
      ctx.arc(cx, crestCy, owlR, 0, TAU);
      ctx.stroke();
    }

    ctx.fillStyle = '#fff5e6';
    ctx.shadowColor = 'rgba(255, 178, 110, 0.55)';
    ctx.shadowBlur = width * 0.05;
    ctx.font = `italic 700 ${titleSize}px "Caveat", "Segoe Script", "Bradley Hand", cursive`;
    ctx.fillText('E-Bouquet', width / 2, titleY);
    ctx.shadowBlur = 0;

    ctx.fillStyle = 'rgba(255, 226, 188, 0.90)';
    ctx.font = CAPS(Math.round(width * 0.0255));
    drawSpaced(ctx, 'BY OWL WATCHER', width / 2, subY, width * 0.0072);

    // little sprig ornaments either side of the rule
    ctx.strokeStyle = 'rgba(255, 220, 176, 0.34)';
    ctx.lineWidth = Math.max(1, width * 0.0018);
    const half = width * 0.10;
    ctx.beginPath();
    ctx.moveTo(width / 2 - half, ruleY);
    ctx.lineTo(width / 2 + half, ruleY);
    ctx.stroke();
    ctx.fillStyle = 'rgba(255, 220, 176, 0.5)';
    for (const dir of [-1, 1]) {
      ctx.beginPath();
      ctx.arc(width / 2 + dir * half, ruleY, width * 0.0035, 0, TAU);
      ctx.fill();
    }
    ctx.restore();
  }

  function drawMessage(ctx, o) {
    const { width, box, top, message, from } = o;
    if (!box.lines.length && !from) return;
    const cx = width / 2;
    const y0 = top;

    ctx.save();
    ctx.shadowColor = 'rgba(10, 4, 20, 0.55)';
    ctx.shadowBlur = width * 0.038;
    ctx.shadowOffsetY = width * 0.009;
    const parch = ctx.createLinearGradient(cx - box.boxW / 2, y0, cx + box.boxW / 2, y0 + box.boxH);
    parch.addColorStop(0, 'rgba(255, 248, 233, 0.97)');
    parch.addColorStop(1, 'rgba(250, 230, 200, 0.95)');
    ctx.fillStyle = parch;
    roundedRect(ctx, cx - box.boxW / 2, y0, box.boxW, box.boxH, width * 0.03);
    ctx.fill();
    ctx.restore();

    ctx.save();
    ctx.strokeStyle = 'rgba(178, 130, 80, 0.52)';
    ctx.lineWidth = Math.max(1, width * 0.0021);
    ctx.setLineDash([width * 0.011, width * 0.0085]);
    roundedRect(ctx, cx - box.boxW / 2 + width * 0.013, y0 + width * 0.013,
      box.boxW - width * 0.026, box.boxH - width * 0.026, width * 0.020);
    ctx.stroke();
    ctx.setLineDash([]);

    ctx.textAlign = 'center';
    ctx.textBaseline = 'alphabetic';
    ctx.fillStyle = '#4b2e1c';
    ctx.font = `italic 500 ${box.msgFont}px "Caveat", "Segoe Script", cursive`;
    let ty = y0 + box.padY + box.msgFont * 0.80;
    for (const line of box.lines) {
      ctx.fillText(line, cx, ty);
      ty += box.lineH;
    }
    if (from) {
      ctx.font = `500 ${box.fromFont}px "Inter", "Helvetica Neue", Arial, sans-serif`;
      ctx.fillStyle = 'rgba(122, 80, 50, 0.95)';
      ctx.fillText('— ' + from, cx, ty + box.fromFont * 0.85);
    }
    ctx.restore();
  }

  function drawFooter(ctx, o) {
    ctx.save();
    ctx.textAlign = 'center';
    ctx.fillStyle = 'rgba(255, 233, 200, 0.55)';
    ctx.font = CAPS(Math.round(o.width * 0.0225));
    drawSpaced(ctx, 'MADE WITH OWL WATCHER  ·  OWLWATCHER.TECH', o.width / 2, o.y, o.width * 0.0055);
    ctx.restore();
  }

  return {
    TAU, clamp, lerp, makeRandom, hashString, roundedRect,
    SKY, paintSky, buildStars, paintStars, paintShootingStar,
    drawStar, drawLeaf, drawFern, drawEucalyptus, drawWrap,
    layoutBouquet, buildGreenery, drawFoliageItem, drawBouquet, drawBloom,
    measureMessage, drawCard, drawHeader, drawMessage, drawFooter, wrapLines, drawSpaced, SCRIPT, CAPS
  };
});
