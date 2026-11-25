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

  // -------------------------------------------------------------- themes ---
  // A theme is pure data: a sky palette, an optional halo/moon tint, the
  // header/sub wording and the star density. "night" is the original free look
  // and must never change. Premium themes are still rendered by exactly the
  // same deterministic code path, so preview and export always agree.
  const THEMES = [
    {
      // The original look, untouched: moon, stars, shooting star.
      id: 'night', name: 'Midnight Sky', tagline: 'the original', free: true,
      sky: SKY, halo: 'rgba(255, 196, 132, 0.50)', haloMid: 'rgba(255, 172, 132, 0.20)',
      glow: 'rgba(255, 178, 110, 0.55)', starWarm: true, stars: 170, moon: true
    },
    {
      id: 'birthday', name: 'Birthday', tagline: 'make a wish', free: false,
      sky: { top: '#ff5f9e', mid: '#ff9a3c', low: '#ffd23f', floor: '#a8255f' },
      halo: 'rgba(255, 245, 190, 0.55)', haloMid: 'rgba(255, 210, 120, 0.26)',
      glow: 'rgba(255, 230, 150, 0.68)', stars: 0, moon: false,
      bg: 'confetti', colors: ['#ffffff', '#ffd23f', '#4ecdc4', '#c77dff', '#ff6b9d'],
      title: 'Happy Birthday', badge: 'a little confetti for you'
    },
    {
      id: 'anniversary', name: 'Anniversary', tagline: 'years of us', free: false,
      sky: { top: '#7b1046', mid: '#c9184a', low: '#ff758f', floor: '#4a0b2c' },
      halo: 'rgba(255, 214, 224, 0.50)', haloMid: 'rgba(255, 160, 185, 0.24)',
      glow: 'rgba(255, 200, 215, 0.62)', stars: 0, moon: false,
      bg: 'hearts', colors: ['#ffd9e2', '#ff8fa8'],
      title: 'Happy Anniversary', badge: 'for every year together'
    },
    {
      id: 'champion', name: 'Champion', tagline: 'you won', free: false,
      sky: { top: '#0b3d2e', mid: '#12805c', low: '#d4af37', floor: '#072a20' },
      halo: 'rgba(255, 232, 150, 0.55)', haloMid: 'rgba(220, 196, 96, 0.24)',
      glow: 'rgba(255, 232, 140, 0.66)', stars: 0, moon: false,
      bg: 'rays',
      title: 'Champion', badge: 'first place, always'
    },
    {
      id: 'promotion', name: 'Promotion', tagline: 'next level', free: false,
      sky: { top: '#0a1b4a', mid: '#1e5fa8', low: '#f0b429', floor: '#081334' },
      halo: 'rgba(255, 226, 150, 0.50)', haloMid: 'rgba(220, 190, 110, 0.22)',
      glow: 'rgba(255, 222, 140, 0.62)', stars: 0, moon: false,
      bg: 'confetti', colors: ['#ffe066', '#ffffff', '#74c0fc', '#ffd8a8'],
      title: 'Congratulations', badge: 'a well earned promotion'
    },
    {
      id: 'wedding', name: 'Wedding', tagline: 'just married', free: false,
      sky: { top: '#f6e7de', mid: '#f3d3c6', low: '#e9b8a8', floor: '#d8a294' },
      halo: 'rgba(255, 255, 255, 0.68)', haloMid: 'rgba(255, 245, 235, 0.40)',
      glow: 'rgba(255, 255, 255, 0.80)', stars: 0, moon: false,
      bg: 'petals', colors: ['#ffffff', '#ffc9d8', '#e8a48f'],
      ink: '#6b2436', inkSub: 'rgba(107, 36, 54, 0.78)', inkRule: 'rgba(107, 36, 54, 0.34)',
      title: 'Just Married', badge: 'two hearts, one home'
    },
    {
      id: 'romance', name: 'Romance', tagline: 'for my love', free: false,
      sky: { top: '#4a0d2c', mid: '#a11248', low: '#ff6b7a', floor: '#2c0719' },
      halo: 'rgba(255, 180, 170, 0.52)', haloMid: 'rgba(255, 130, 120, 0.24)',
      glow: 'rgba(255, 180, 165, 0.62)', stars: 0, moon: false,
      bg: 'bokeh', colors: ['#ffc2c7', '#ff8f9c', '#ffe3d8'],
      title: 'For You', badge: 'with all my love'
    },
    {
      id: 'newbaby', name: 'New Baby', tagline: 'hello little one', free: false,
      sky: { top: '#bfe9f0', mid: '#f7d9e3', low: '#ffe9c9', floor: '#a9d6e0' },
      halo: 'rgba(255, 255, 255, 0.66)', haloMid: 'rgba(255, 246, 226, 0.38)',
      glow: 'rgba(255, 255, 245, 0.78)', stars: 0, moon: false,
      bg: 'bokeh', colors: ['#ffffff', '#8fdce8', '#ffb3cc', '#ffd98a'],
      ink: '#1f4a5a', inkSub: 'rgba(31, 74, 90, 0.78)', inkRule: 'rgba(31, 74, 90, 0.32)',
      title: 'Welcome Little One', badge: 'a new star is here'
    },
    {
      id: 'farewell', name: 'Farewell', tagline: 'good luck', free: false,
      sky: { top: '#123049', mid: '#2e6f8e', low: '#8fc9d9', floor: '#0d2537' },
      halo: 'rgba(214, 240, 250, 0.48)', haloMid: 'rgba(180, 220, 235, 0.22)',
      glow: 'rgba(214, 240, 250, 0.58)', stars: 0, moon: false,
      bg: 'rings', ripple: '#d6f0fa',
      title: 'Good Luck', badge: 'until we meet again'
    },
    {
      id: 'festival', name: 'Festival Vibe', tagline: 'celebrate together', free: false,
      sky: { top: '#2b0a3d', mid: '#8e1240', low: '#f4a02a', floor: '#24062f' },
      halo: 'rgba(255, 205, 110, 0.60)', haloMid: 'rgba(255, 160, 70, 0.28)',
      glow: 'rgba(255, 215, 125, 0.70)', stars: 0, moon: false,
      bg: 'festivalLights',
      title: 'Festival Wishes', badge: 'celebrating together'
    },
    {
      id: 'sorry', name: 'Sorry', tagline: 'from the heart', free: false,
      sky: { top: '#e5d9ea', mid: '#e9c3c8', low: '#f8dfd1', floor: '#bd9aaf' },
      halo: 'rgba(255, 255, 255, 0.64)', haloMid: 'rgba(255, 243, 236, 0.36)',
      glow: 'rgba(255, 252, 246, 0.76)', stars: 0, moon: false,
      bg: 'petals', colors: ['#fffaf8', '#f4aebf', '#cbaedb'],
      ink: '#59364e', inkSub: 'rgba(89, 54, 78, 0.82)', inkRule: 'rgba(89, 54, 78, 0.36)',
      title: 'I’m Sorry', badge: 'from the heart'
    },
    {
      id: 'newyear', name: 'Happy New Year', tagline: 'new beginnings', free: false,
      sky: { top: '#151741', mid: '#433b83', low: '#bb789e', floor: '#101332' },
      halo: 'rgba(255, 225, 174, 0.52)', haloMid: 'rgba(255, 189, 168, 0.24)',
      glow: 'rgba(255, 229, 187, 0.65)', stars: 0, moon: false,
      bg: 'fireworks', colors: ['#ffe7a1', '#ffb7c8', '#b9d4ff', '#ffffff'],
      title: 'Happy New Year', badge: 'cheers to new beginnings'
    }
  ];

  function themeById(id) {
    for (let i = 0; i < THEMES.length; i++) if (THEMES[i].id === id) return THEMES[i];
    return THEMES[0];
  }

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
  function paintSky(ctx, w, h, theme) {
    const t = theme || THEMES[0];
    const sky = t.sky || SKY;
    const g = ctx.createLinearGradient(0, 0, w * 0.4, h);
    g.addColorStop(0, sky.top);
    g.addColorStop(0.52, sky.mid);
    g.addColorStop(1, sky.low);
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, w, h);

    const halo = ctx.createRadialGradient(w * 0.5, h * 0.54, w * 0.02, w * 0.5, h * 0.54, h * 0.56);
    halo.addColorStop(0, t.halo || 'rgba(255, 196, 132, 0.50)');
    halo.addColorStop(0.35, t.haloMid || 'rgba(255, 172, 132, 0.20)');
    halo.addColorStop(1, 'rgba(255, 172, 132, 0)');
    ctx.fillStyle = halo;
    ctx.fillRect(0, 0, w, h);

  }

  function paintMoon(ctx, w, h) {
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

  /* ---------------------------------------------------------- backgrounds ---
   * Each premium occasion gets its own backdrop instead of the night sky. They
   * are all drawn from a seeded PRNG and never depend on `time`, except where a
   * slow twinkle is wanted, so the preview and the exported GIF agree.
   */
  function bgConfetti(ctx, w, h, t, time) {
    const rnd = makeRandom(hashString('confetti-' + (t.id || 'x')));
    const count = 70;
    for (let i = 0; i < count; i++) {
      const x = rnd() * w;
      const y = rnd() * h;
      const size = lerp(w * 0.006, w * 0.020, rnd());
      const spin = rnd() * TAU + time * lerp(0.2, 0.9, rnd());
      const hue = t.colors ? t.colors[i % t.colors.length] : '#ffd166';
      ctx.save();
      ctx.globalAlpha = lerp(0.35, 0.9, rnd());
      ctx.translate(x, y);
      ctx.rotate(spin);
      ctx.fillStyle = hue;
      if (rnd() > 0.45) ctx.fillRect(-size / 2, -size / 4, size, size / 2);
      else { ctx.beginPath(); ctx.arc(0, 0, size * 0.42, 0, TAU); ctx.fill(); }
      ctx.restore();
    }
    // rising balloons, drawn as translucent ovals
    for (let i = 0; i < 5; i++) {
      const bx = w * (0.10 + i * 0.19) + Math.sin(i * 2.1) * w * 0.03;
      const by = h * (0.30 - ((time * 0.03 + i * 0.17) % 0.55)) + Math.sin(time * 0.6 + i) * h * 0.008;
      const r = w * 0.052;
      const hue = t.colors ? t.colors[i % t.colors.length] : '#ff9f68';
      ctx.save();
      ctx.globalAlpha = 0.30;
      ctx.fillStyle = hue;
      ctx.beginPath();
      ctx.ellipse(bx, by, r * 0.86, r, 0, 0, TAU);
      ctx.fill();
      ctx.globalAlpha = 0.22;
      ctx.strokeStyle = hue;
      ctx.lineWidth = Math.max(1, w * 0.002);
      ctx.beginPath();
      ctx.moveTo(bx, by + r);
      ctx.quadraticCurveTo(bx + r * 0.3, by + r * 1.9, bx - r * 0.1, by + r * 2.6);
      ctx.stroke();
      ctx.restore();
    }
  }

  function bgHearts(ctx, w, h, t, time) {
    const rnd = makeRandom(hashString('hearts-' + (t.id || 'x')));
    const heart = (cx, cy, s) => {
      ctx.beginPath();
      ctx.moveTo(cx, cy + s * 0.35);
      ctx.bezierCurveTo(cx - s, cy - s * 0.45, cx - s * 0.45, cy - s * 1.05, cx, cy - s * 0.35);
      ctx.bezierCurveTo(cx + s * 0.45, cy - s * 1.05, cx + s, cy - s * 0.45, cx, cy + s * 0.35);
      ctx.closePath();
    };
    for (let i = 0; i < 30; i++) {
      const x = rnd() * w;
      const y = rnd() * h;
      const s = lerp(w * 0.016, w * 0.058, rnd());
      const pulse = 0.75 + 0.25 * Math.sin(time * 1.1 + rnd() * TAU);
      ctx.save();
      ctx.globalAlpha = lerp(0.22, 0.52, rnd()) * pulse;
      ctx.fillStyle = rnd() > 0.5 ? '#ffd9e2' : '#ff8fa8';
      heart(x, y, s);
      ctx.fill();
      ctx.restore();
    }
  }

  function bgRays(ctx, w, h, t, time) {
    // Rotating sunburst behind the blooms - gold light on a deep ground.
    const cx = w * 0.5, cy = h * 0.46;
    ctx.save();
    ctx.translate(cx, cy);
    ctx.rotate(time * 0.06);
    const rays = 22;
    for (let i = 0; i < rays; i++) {
      ctx.save();
      ctx.rotate((i / rays) * TAU);
      const grad = ctx.createLinearGradient(0, 0, 0, -h * 0.9);
      grad.addColorStop(0, 'rgba(255, 214, 120, 0.30)');
      grad.addColorStop(1, 'rgba(255, 214, 120, 0)');
      ctx.fillStyle = grad;
      ctx.beginPath();
      ctx.moveTo(0, 0);
      ctx.lineTo(-w * 0.055, -h * 0.95);
      ctx.lineTo(w * 0.055, -h * 0.95);
      ctx.closePath();
      ctx.fill();
      ctx.restore();
    }
    ctx.restore();
    // laurel-ish arc of small leaves around the dome
    const rnd = makeRandom(hashString('laurel-' + (t.id || 'x')));
    for (let i = 0; i < 22; i++) {
      const a = -Math.PI * 0.92 + (i / 21) * Math.PI * 0.84;
      const r = Math.min(w, h) * 0.42;
      const lx = cx + Math.cos(a) * r;
      const ly = cy + Math.sin(a) * r * 0.82;
      ctx.save();
      ctx.translate(lx, ly);
      ctx.rotate(a + Math.PI / 2);
      ctx.globalAlpha = 0.22;
      ctx.fillStyle = i % 2 ? '#ffd98a' : '#b8d98a';
      ctx.beginPath();
      ctx.ellipse(0, 0, w * 0.012, w * 0.028, 0, 0, TAU);
      ctx.fill();
      ctx.restore();
      rnd();
    }
  }

  function bgBokeh(ctx, w, h, t, time) {
    const rnd = makeRandom(hashString('bokeh-' + (t.id || 'x')));
    for (let i = 0; i < 30; i++) {
      const x = rnd() * w;
      const y = rnd() * h;
      const r = lerp(w * 0.016, w * 0.090, rnd());
      const drift = Math.sin(time * 0.5 + rnd() * TAU) * w * 0.012;
      const hue = t.colors ? t.colors[i % t.colors.length] : '#ffe6d0';
      ctx.save();
      ctx.globalAlpha = lerp(0.18, 0.44, rnd());
      ctx.fillStyle = hue;
      ctx.beginPath();
      ctx.arc(x + drift, y, r, 0, TAU);
      ctx.fill();
      ctx.restore();
    }
  }

  function bgPetals(ctx, w, h, t, time) {
    // Softly falling petals for the wedding / new baby sets.
    const rnd = makeRandom(hashString('petals-' + (t.id || 'x')));
    for (let i = 0; i < 34; i++) {
      const base = rnd();
      const x = base * w + Math.sin(time * 0.4 + base * TAU) * w * 0.05;
      const y = ((rnd() + time * 0.018) % 1) * h;
      const s = lerp(w * 0.008, w * 0.022, rnd());
      const hue = t.colors ? t.colors[i % t.colors.length] : '#ffe1e8';
      ctx.save();
      ctx.translate(x, y);
      ctx.rotate(time * 0.4 + base * TAU);
      ctx.globalAlpha = lerp(0.34, 0.70, rnd());
      ctx.fillStyle = hue;
      ctx.beginPath();
      ctx.ellipse(0, 0, s, s * 0.55, 0, 0, TAU);
      ctx.fill();
      ctx.restore();
    }
  }

  function bgFestivalLights(ctx, w, h, t, time) {
    // A neutral garland of lights for festival wishes of any kind.
    const bulbs = 13;
    const sag = h * 0.045;
    const lineY = h * 0.045;
    const px = (i) => (i / (bulbs - 1)) * w;
    const py = (i) => {
      const u = i / (bulbs - 1);
      return lineY + Math.sin(u * Math.PI) * sag;
    };

    // the wire
    ctx.save();
    ctx.strokeStyle = 'rgba(255, 226, 170, 0.30)';
    ctx.lineWidth = Math.max(1, w * 0.0025);
    ctx.beginPath();
    ctx.moveTo(0, py(0));
    for (let i = 1; i < bulbs; i++) ctx.lineTo(px(i), py(i));
    ctx.stroke();
    ctx.restore();

    for (let i = 0; i < bulbs; i++) {
      const x = px(i);
      const y = py(i);
      const flick = 0.78 + 0.22 * Math.sin(time * 2.6 + i * 1.7);
      const hue = i % 3 === 0 ? 'rgba(255, 238, 176,' : i % 3 === 1 ? 'rgba(255, 196, 92,' : 'rgba(255, 168, 74,';
      const r = w * 0.016;

      const glow = ctx.createRadialGradient(x, y + r * 1.4, 1, x, y + r * 1.4, r * 4.2);
      glow.addColorStop(0, hue + (0.55 * flick).toFixed(3) + ')');
      glow.addColorStop(1, hue + '0)');
      ctx.fillStyle = glow;
      ctx.fillRect(x - r * 4.4, y - r * 2.6, r * 8.8, r * 8.8);

      // shade
      ctx.fillStyle = 'rgba(214, 140, 56, ' + (0.75 * flick).toFixed(3) + ')';
      ctx.beginPath();
      ctx.moveTo(x - r, y);
      ctx.quadraticCurveTo(x, y + r * 2.2, x + r, y);
      ctx.closePath();
      ctx.fill();

      // filament
      ctx.fillStyle = 'rgba(255, 246, 214, ' + flick.toFixed(3) + ')';
      ctx.beginPath();
      ctx.arc(x, y + r * 0.95, r * 0.30, 0, TAU);
      ctx.fill();
    }

  }

  function bgFireworks(ctx, w, h, t, time) {
    // Seeded bursts twinkle without introducing a year or a specific festival.
    const random = makeRandom(hashString('fireworks-' + t.id));
    for (let i = 0; i < 10; i++) {
      const x = w * (0.07 + random() * 0.86);
      const y = h * (0.12 + random() * 0.62);
      const radius = w * (0.035 + random() * 0.055);
      const phase = random() * TAU;
      const brightness = 0.35 + 0.30 * (0.5 + 0.5 * Math.sin(time * 1.5 + phase));
      ctx.save();
      ctx.globalAlpha = brightness;
      ctx.strokeStyle = t.colors[i % t.colors.length];
      ctx.lineWidth = Math.max(1, w * 0.0024);
      for (let ray = 0; ray < 12; ray++) {
        const angle = ray * TAU / 12 + phase;
        ctx.beginPath();
        ctx.moveTo(x + Math.cos(angle) * radius * 0.25, y + Math.sin(angle) * radius * 0.25);
        ctx.lineTo(x + Math.cos(angle) * radius, y + Math.sin(angle) * radius);
        ctx.stroke();
      }
      ctx.restore();
    }
  }

  function bgRings(ctx, w, h, t, time) {
    // Fine concentric ripples, for the calm / farewell sets.
    const cx = w * 0.5, cy = h * 0.42;
    ctx.save();
    for (let i = 0; i < 7; i++) {
      const phase = ((time * 0.10 + i / 7) % 1);
      ctx.globalAlpha = 0.30 * (1 - phase);
      ctx.strokeStyle = t.ripple || '#dbe9f2';
      ctx.lineWidth = Math.max(1.4, w * 0.005);
      ctx.beginPath();
      ctx.arc(cx, cy, w * 0.10 + phase * w * 0.55, 0, TAU);
      ctx.stroke();
    }
    ctx.restore();
  }

  const BACKGROUNDS = {
    confetti: bgConfetti,
    hearts: bgHearts,
    rays: bgRays,
    bokeh: bgBokeh,
    petals: bgPetals,
    festivalLights: bgFestivalLights,
    fireworks: bgFireworks,
    rings: bgRings
  };

  function paintBackground(ctx, w, h, theme, time, reduceMotion) {
    const t = theme || THEMES[0];
    paintSky(ctx, w, h, t);
    const fn = BACKGROUNDS[t.bg];
    if (fn) fn(ctx, w, h, t, reduceMotion ? 0 : (time || 0));
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

      const flowerIndex = i % Math.max(1, opts.flowerCount || count);
      const premiumSet = opts.premiumFlowers;
      slots.push({
        index: i, x, y, size, rr, tilt,
        depth: rr,
        angle: tilt + (rnd() - 0.5) * 0.14,
        phase: rnd() * TAU,
        speed: lerp(0.55, 1.15, rnd()),
        bob: lerp(1.2, 3.4, rnd()),
        flower: flowerIndex,
        premium: !!(premiumSet && premiumSet[flowerIndex])
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

    // A locked premium bouquet is still shown in full colour - people should see
    // exactly what they would be buying - but the flowers themselves carry a
    // PREVIEW ribbon, so a crop of the bouquet cannot pass as an unlocked card.
    const premiumSlots = layout.slots.filter((sl) => sl.premium);
    if (opts.markPremium && premiumSlots.length) {
      drawBouquetPreviewMark(ctx, layout, premiumSlots);
    }
  }

  // One clear ribbon across the bloom cluster rather than a badge per flower:
  // blooms overlap, so per-flower badges pile into unreadable fragments.
  function drawBouquetPreviewMark(ctx, layout, premiumSlots) {
    let sumX = 0, sumY = 0, maxSize = 0;
    for (const sl of premiumSlots) {
      sumX += sl.x;
      sumY += sl.y;
      maxSize = Math.max(maxSize, sl.size);
    }
    const cx = sumX / premiumSlots.length;
    const cy = sumY / premiumSlots.length;

    const label = 'PREVIEW';
    const fs = Math.max(9, Math.min(28, maxSize * 0.26));
    ctx.save();
    ctx.font = `800 ${fs}px "Inter", "Helvetica Neue", Arial, sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';

    const tw = ctx.measureText(label).width;
    const padX = fs * 0.9, padY = fs * 0.5;
    const bw = Math.min(tw + padX * 2, layout.R * 2.05);
    const bh = fs + padY * 2;

    ctx.translate(cx, cy);
    ctx.rotate(-0.11);
    ctx.globalAlpha = 0.82;
    ctx.fillStyle = 'rgba(16, 10, 6, 0.72)';
    roundedRect(ctx, -bw / 2, -bh / 2, bw, bh, bh / 2);
    ctx.fill();
    ctx.globalAlpha = 1;
    ctx.fillStyle = '#ffe9c0';
    ctx.fillText(label, 0, fs * 0.04);
    ctx.restore();
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
    const theme = themeById(opts.theme);
    const stars = opts.stars || buildStars(theme.stars || 170, opts.seed || 7, width, height);

    paintBackground(ctx, width, height, theme, time, reduceMotion);
    // Stars and the shooting star are the night theme's signature; a premium
    // theme brings its own backdrop instead of borrowing them.
    if (theme.stars !== 0) {
      paintStars(ctx, stars, time, reduceMotion);
      paintShootingStar(ctx, width, height, time, reduceMotion);
    }

    // ---- header block
    // The owl crest is the brand mark on the card, so it is drawn a clear
    // size rather than a small emblem — it stays the first thing you see.
    const owlR = width * 0.064;
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
      premiumFlowers: opts.premiumFlowers || null,
      nudges: opts.nudges || null,
      dome: { cx: width * 0.5, cy: by, rx: R, ry: RY, neck, bloom: R * 0.72 }
    });

    drawHeader(ctx, { width, crestCy, owlR, titleY, titleSize, subY, ruleY }, opts.owlImg, theme);
    drawBouquet(ctx, { layout, images: opts.images, time, reduceMotion, seed: opts.seed, greenery: opts.greenery, markPremium: opts.markPremium });
    drawMessage(ctx, { width, box: msg, top: msgTop, message, from });
    drawFooter(ctx, { width, y: footerY });
    if (opts.watermark) drawWatermark(ctx, width, height);
    return layout;
  }

  function drawHeader(ctx, g, owlImg, theme) {
    const { width, crestCy, owlR, titleY, titleSize, subY, ruleY } = g;
    const t = theme || THEMES[0];
    ctx.save();
    ctx.textAlign = 'center';
    ctx.textBaseline = 'alphabetic';

    if (owlImg) {
      const cx = width / 2;
      ctx.save();
      // Render the brand logo exactly as the app shows it: the full badge
      // fitted into the circle, no zoom and no extra ring. The previous
      // scale drew it at 2.7x the circle and cropped it, so the GIF crest
      // did not match the app logo.
      ctx.beginPath();
      ctx.arc(cx, crestCy, owlR, 0, TAU);
      ctx.closePath();
      ctx.clip();
      const scale = (owlR * 2) / owlImg.width;
      ctx.drawImage(owlImg, cx - owlImg.width * scale / 2, crestCy - owlImg.height * scale / 2,
        owlImg.width * scale, owlImg.height * scale);
      ctx.restore();
    }

    // Theme titles vary in length ("Happy Anniversary" is far wider than
    // "E-Bouquet"), so shrink the type until it clears the card margins.
    const title = t.title || 'E-Bouquet';
    const maxTitleW = width * 0.86;
    let size = titleSize;
    const titleFont = (px) => `italic 700 ${px}px "Caveat", "Segoe Script", "Bradley Hand", cursive`;
    ctx.font = titleFont(size);
    while (size > width * 0.045 && ctx.measureText(title).width > maxTitleW) {
      size -= 1;
      ctx.font = titleFont(size);
    }

    // Light themes need dark ink or the title disappears into the backdrop.
    ctx.fillStyle = t.ink || '#fff5e6';
    ctx.shadowColor = t.glow || 'rgba(255, 178, 110, 0.55)';
    ctx.shadowBlur = t.ink ? width * 0.012 : width * 0.05;
    ctx.fillText(title, width / 2, titleY);
    ctx.shadowBlur = 0;

    ctx.fillStyle = t.inkSub || 'rgba(255, 226, 188, 0.90)';
    ctx.font = CAPS(Math.round(width * 0.0255));
    drawSpaced(ctx, (t.badge || 'BY OWL WATCHER'), width / 2, subY, width * 0.0072);

    // little sprig ornaments either side of the rule
    ctx.strokeStyle = t.inkRule || 'rgba(255, 220, 176, 0.34)';
    ctx.lineWidth = Math.max(1, width * 0.0018);
    const half = width * 0.10;
    ctx.beginPath();
    ctx.moveTo(width / 2 - half, ruleY);
    ctx.lineTo(width / 2 + half, ruleY);
    ctx.stroke();
    ctx.fillStyle = t.inkRule || 'rgba(255, 220, 176, 0.5)';
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

  // Credit line only - no web address, so the GIF reads as a gift rather than
  // an advert when it lands in a chat.
  function drawFooter(ctx, o) {
    ctx.save();
    ctx.textAlign = 'center';
    ctx.fillStyle = 'rgba(255, 233, 200, 0.55)';
    ctx.font = CAPS(Math.round(o.width * 0.0225));
    drawSpaced(ctx, 'MADE WITH OWL WATCHER', o.width / 2, o.y, o.width * 0.0055);
    ctx.restore();
  }

  // The free preview: a premium theme can be looked at, but the rendered frame
  // carries a repeating diagonal watermark so a screenshot is obviously a
  // preview and not the real card. A large corner badge spells out why. Both
  // are drawn every frame, so they survive into an animated capture too.
  function drawWatermark(ctx, width, height) {
    ctx.save();
    ctx.globalAlpha = 0.16;
    ctx.fillStyle = '#ffffff';
    ctx.font = CAPS(Math.round(width * 0.052));
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    const text = 'PREVIEW';
    const stepX = width * 0.62;
    const stepY = height * 0.20;
    ctx.rotate(-Math.PI / 9);
    for (let y = -height * 0.5; y < height * 1.5; y += stepY) {
      for (let x = -width * 0.4; x < width * 1.6; x += stepX) {
        ctx.fillText(text, x, y);
      }
    }
    ctx.restore();

    // A solid banner is harder to crop out than the diagonal tiling alone. It
    // sits along the bottom edge so it covers the brand footer (which a preview
    // should not carry anyway) and never hides the bouquet or the message.
    ctx.save();
    ctx.globalAlpha = 0.92;
    ctx.fillStyle = 'rgba(20, 14, 10, 0.62)';
    const bh = height * 0.048;
    const by = height * 0.955;
    ctx.fillRect(0, by - bh / 2, width, bh);
    ctx.globalAlpha = 1;
    ctx.fillStyle = '#ffe9c0';
    ctx.font = CAPS(Math.round(width * 0.029));
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('PREVIEW \u00B7 UNLOCK TO SHARE', width / 2, by);
    ctx.restore();
  }

  return {
    TAU, clamp, lerp, makeRandom, hashString, roundedRect,
    SKY, THEMES, themeById, paintSky, paintBackground, BACKGROUNDS, buildStars, paintStars, paintShootingStar,
    drawStar, drawLeaf, drawFern, drawEucalyptus, drawWrap,
    layoutBouquet, buildGreenery, drawFoliageItem, drawBouquet, drawBloom,
    measureMessage, drawCard, drawHeader, drawMessage, drawFooter, drawWatermark, drawBouquetPreviewMark, wrapLines, drawSpaced, SCRIPT, CAPS
  };
});
