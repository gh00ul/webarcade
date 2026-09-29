// ═══════════════ PROPS & SIGNAGE: prize counter, vending/change machines, neon signs, posters, scoreboard ═══════════════
// Owner: props agent (the games agent owns 55-games.js). Entry point: buildProps(). Runs after buildRoom() and buildCabinets().
// Register every prop that should make noise or light in `registry.props`, and add colliders for solid ones.
//
// How this part keeps the draw-call count low: every static box/cylinder/quad is collected in a PropBatch (one per
// material) and merged into ONE mesh at the end; posters, signs and stickers share texture atlases; the prizes are
// InstancedMeshes. Nothing here adds real lights: glow is emissive vertex colour + additive halo quads.
//
// Layout, front to back at the north wall (z = -7):  ARCADE sign (y 2.4-3.7)  >  spot cans  >  prize shelves
// (y 1.14-2.4)  >  staff aisle  >  counter top (y 1.05)  >  glass display case  >  customers.
//@@import import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';

// ── Constants ──
const PROP_FONT = '"Arial Black", Impact, "Helvetica Neue", "Liberation Sans", "DejaVu Sans", Arial, sans-serif';
const PROP_COUNTER = { zFront: -5.5, zBack: -6.15 };      // glass front / back face of the prize counter
const PROP_PLUSH = [0xff5fa8, 0x4fd2ff, 0xffd93b, 0x7be36a, 0xb489ff, 0xff8a3d, 0xf2f2ff, 0xff4d4d];
const PROP_FRAMES = [0x0d0d12, 0x3a2716, 0xa4a9bc, 0x14141c];   // poster frame colours (black, wood, silver, charcoal)
const PROP_WARM = 0xffa845;                                   // warm counter light
const PROP_SCORES = ['1 KAT 998450', '2 ZAP 874200', '3 MAX 761100', '4 JLO 655300', '5 OWL 540000', '6 RAY 498750'];
const PROP_SCORE_COLORS = ['#3dff88', '#3ad7ff', '#ff5fd0', '#ffe14a', '#ff8a3d', '#b489ff'];

// ── Small colour helpers ──
const propCss = (c) => '#' + c.toString(16).padStart(6, '0');
function propTint(c, k) {   // mixes a hex colour toward white by k (0..1) and returns a CSS colour
  const m = (v) => Math.round(v + (255 - v) * k);
  return `rgb(${m((c >> 16) & 255)},${m((c >> 8) & 255)},${m(c & 255)})`;
}

// ═══════════════ Batching helpers ═══════════════
const _pm = new THREE.Matrix4(), _pq = new THREE.Quaternion(), _pe = new THREE.Euler(),
      _pv = new THREE.Vector3(), _ps = new THREE.Vector3(1, 1, 1), _pc = new THREE.Color();

// Collects geometry, bakes position/rotation/colour into it, and merges everything into one mesh.
class PropBatch {
  constructor(material, { colored = true, atlas = null } = {}) {
    this.material = material; this.colored = colored; this.atlas = atlas; this.geos = [];
  }
  // Adds `geo` at (x,y,z) with Euler rotation (yaw applied last) and a vertex colour (hex) times brightness k.
  add(geo, x, y, z, color = 0xffffff, k = 1, rx = 0, ry = 0, rz = 0) {
    _pe.set(rx, ry, rz, 'YXZ');
    _pm.compose(_pv.set(x, y, z), _pq.setFromEuler(_pe), _ps);
    geo.applyMatrix4(_pm);
    if (this.colored) {
      const n = geo.attributes.position.count, arr = new Float32Array(n * 3);
      _pc.set(color).multiplyScalar(k);
      for (let i = 0; i < n; i++) { arr[i * 3] = _pc.r; arr[i * 3 + 1] = _pc.g; arr[i * 3 + 2] = _pc.b; }
      geo.setAttribute('color', new THREE.BufferAttribute(arr, 3));
    }
    this.geos.push(geo);
    return this;
  }
  box(sx, sy, sz, x, y, z, color, k, rx, ry, rz) { return this.add(new THREE.BoxGeometry(sx, sy, sz), x, y, z, color, k, rx, ry, rz); }
  cyl(rTop, rBot, h, x, y, z, color, k, seg = 18, rx, ry, rz) { return this.add(new THREE.CylinderGeometry(rTop, rBot, h, seg), x, y, z, color, k, rx, ry, rz); }
  sphere(r, x, y, z, color, k, rx, ry, rz) { return this.add(new THREE.SphereGeometry(r, 14, 10), x, y, z, color, k, rx, ry, rz); }
  plane(w, h, x, y, z, color, k, rx, ry, rz) { return this.add(new THREE.PlaneGeometry(w, h), x, y, z, color, k, rx, ry, rz); }
  // A quad showing one cell of this batch's texture atlas (the quad's world size is w x h).
  atlasQuad(cell, w, h, x, y, z, ry = 0, k = 1, rx = 0) { return this.add(this.atlas.quad(cell, w, h), x, y, z, 0xffffff, k, rx, ry, 0); }
  build(renderOrder = 0) {
    if (!this.geos.length) return null;
    const mesh = new THREE.Mesh(mergeGeometries(this.geos), this.material);
    for (const g of this.geos) g.dispose();
    mesh.renderOrder = renderOrder; mesh.matrixAutoUpdate = false;
    scene.add(mesh);
    return mesh;
  }
}

// A canvas divided into named cells; each cell has a draw(ctx, w, h) callback. Quads can show any cell.
class PropAtlas {
  constructor(w, h) { const c = makeCanvas(w, h); this.canvas = c.canvas; this.ctx = c.ctx; this.w = w; this.h = h; this.cells = new Map(); }
  add(name, x, y, w, h, draw) { this.cells.set(name, { x, y, w, h, draw }); return this; }
  render() {
    const g = this.ctx;
    g.clearRect(0, 0, this.w, this.h);
    for (const c of this.cells.values()) {
      g.save(); g.translate(c.x, c.y); g.beginPath(); g.rect(0, 0, c.w, c.h); g.clip();
      c.draw(g, c.w, c.h);
      g.restore();
    }
  }
  // Paints every cell and returns the texture (repainted once the web font arrives).
  texture() {
    this.render();
    const tex = canvasTexture(this.canvas, { anisotropy: 8 });
    fontsReady.then(() => { this.render(); tex.needsUpdate = true; });
    return tex;
  }
  quad(name, ww, hh) {
    const c = this.cells.get(name), g = new THREE.PlaneGeometry(ww, hh), uv = g.attributes.uv;
    for (let i = 0; i < uv.count; i++) uv.setXY(i, (c.x + uv.getX(i) * c.w) / this.w, 1 - (c.y + (1 - uv.getY(i)) * c.h) / this.h);
    return g;
  }
}

// One-off painted canvas texture (repainted after fonts load).
function propPainted(w, h, draw, opts) {
  const { canvas, ctx } = makeCanvas(w, h);
  draw(ctx, w, h);
  const tex = canvasTexture(canvas, opts);
  fontsReady.then(() => { ctx.clearRect(0, 0, w, h); draw(ctx, w, h); tex.needsUpdate = true; });
  return tex;
}

// ═══════════════ Neon tube lettering (single-stroke vector alphabet, so it never depends on installed fonts) ═══════════════
// Glyphs live on a 0.7 x 1 grid as SVG path data.
const PROP_GLYPHS = {
  A: 'M0.02 1 L0.35 0 L0.68 1 M0.14 0.68 L0.56 0.68',
  C: 'M0.68 0.18 Q0.6 0 0.36 0 Q0.02 0 0.02 0.5 Q0.02 1 0.36 1 Q0.6 1 0.68 0.82',
  D: 'M0.02 0 L0.02 1 L0.32 1 Q0.68 1 0.68 0.5 Q0.68 0 0.32 0 Z',
  E: 'M0.66 0 L0.02 0 L0.02 1 L0.66 1 M0.02 0.5 L0.5 0.5',
  G: 'M0.68 0.18 Q0.6 0 0.36 0 Q0.02 0 0.02 0.5 Q0.02 1 0.36 1 Q0.68 1 0.68 0.6 L0.4 0.6',
  H: 'M0.02 0 L0.02 1 M0.68 0 L0.68 1 M0.02 0.5 L0.68 0.5',
  I: 'M0.1 0 L0.6 0 M0.35 0 L0.35 1 M0.1 1 L0.6 1',
  K: 'M0.02 0 L0.02 1 M0.68 0 L0.02 0.6 M0.26 0.44 L0.68 1',
  N: 'M0.02 1 L0.02 0 L0.68 1 L0.68 0',
  O: 'M0.36 0 Q0.68 0 0.68 0.5 Q0.68 1 0.36 1 Q0.02 1 0.02 0.5 Q0.02 0 0.36 0 Z',
  P: 'M0.02 1 L0.02 0 L0.4 0 Q0.68 0 0.68 0.28 Q0.68 0.56 0.4 0.56 L0.02 0.56',
  R: 'M0.02 1 L0.02 0 L0.4 0 Q0.68 0 0.68 0.28 Q0.68 0.56 0.4 0.56 L0.02 0.56 M0.36 0.56 L0.68 1',
  S: 'M0.66 0.16 Q0.56 0 0.36 0 Q0.04 0 0.04 0.25 Q0.04 0.5 0.36 0.5 Q0.68 0.5 0.68 0.75 Q0.68 1 0.36 1 Q0.14 1 0.02 0.84',
  T: 'M0 0 L0.7 0 M0.35 0 L0.35 1',
  X: 'M0.02 0 L0.68 1 M0.68 0 L0.02 1',
  Z: 'M0.02 0 L0.68 0 L0.02 1 L0.68 1',
};
// Neon icons on a 1 x 1 grid.
const PROP_ICONS = {
  star: 'M0.5 0 L0.62 0.36 L1 0.38 L0.7 0.6 L0.8 0.98 L0.5 0.76 L0.2 0.98 L0.3 0.6 L0 0.38 L0.38 0.36 Z',
  bolt: 'M0.62 0 L0.18 0.56 L0.48 0.56 L0.36 1 L0.82 0.4 L0.52 0.4 Z',
  joystick: 'M0.36 0.2 A0.14 0.14 0 1 1 0.64 0.2 A0.14 0.14 0 1 1 0.36 0.2 Z M0.5 0.34 L0.5 0.68 M0.08 1 L0.08 0.86 Q0.08 0.68 0.28 0.68 L0.72 0.68 Q0.92 0.68 0.92 0.86 L0.92 1 Z M0.3 0.84 L0.3 0.84 M0.7 0.84 L0.7 0.84',
};
const propPathCache = {};
function propPath(key, def) { return propPathCache[key] || (propPathCache[key] = new Path2D(def)); }

// One rendering pass of a neon tube along `path` (canvas transform already set, `s` = its scale):
//   'halo' = coloured glow, 'tube' = the glass tube with a hot core. style: 'single' | 'double' (outlined tube) | 'flat'.
function propNeonPass(ctx, path, color, tube, pass, style, s) {
  const css = propCss(color);
  ctx.lineCap = ctx.lineJoin = 'round';
  if (pass === 'halo') {
    if (style === 'flat') return;
    ctx.shadowColor = css; ctx.shadowBlur = tube * 2.2; ctx.strokeStyle = css; ctx.lineWidth = tube / s;
    ctx.stroke(path);
    ctx.shadowBlur = 0; ctx.shadowColor = 'rgba(0,0,0,0)';
    return;
  }
  ctx.strokeStyle = css; ctx.lineWidth = tube / s; ctx.stroke(path);
  if (style === 'flat') return;
  if (style === 'double') { ctx.strokeStyle = '#000'; ctx.lineWidth = tube * 0.52 / s; ctx.stroke(path); }
  ctx.strokeStyle = propTint(color, 0.82); ctx.lineWidth = tube * (style === 'double' ? 0.14 : 0.3) / s; ctx.stroke(path);
}

// Lays a string out in glyph rectangles ({ch, x, w}, relative to the start) plus the total width.
function propNeonLayout(text, h, gap) {
  const rects = []; let x = 0;
  for (const ch of text) { const w = ch === ' ' ? 0.45 * h : 0.7 * h; rects.push({ ch, x, w }); x += w + gap; }
  return { rects, width: x - gap };
}

// Draws neon lettering with its top-left at (x, y) (or top-centre with o.center). `skip` leaves one glyph out
// (drawn as an unlit tube) so it can be animated separately. Returns the glyph rectangles in canvas px.
function propNeonText(ctx, text, x, y, h, colors, o = {}) {
  const { tube = h * 0.11, gap = h * 0.3, style = 'single', center = false, skip = -1 } = o;
  const lay = propNeonLayout(text, h, gap), ox = center ? x - lay.width / 2 : x;
  const glyphs = (fn) => lay.rects.forEach((r, i) => {
    if (r.ch === ' ') return;
    ctx.save(); ctx.translate(ox + r.x, y); ctx.scale(h, h);
    fn(propPath(r.ch, PROP_GLYPHS[r.ch]), colors[i % colors.length], i);
    ctx.restore();
  });
  glyphs((p, c, i) => { if (i === skip) { ctx.strokeStyle = '#3a2444'; ctx.lineCap = ctx.lineJoin = 'round'; ctx.lineWidth = tube * 0.8 / h; ctx.stroke(p); } });
  for (const pass of ['halo', 'tube']) glyphs((p, c, i) => { if (i !== skip) propNeonPass(ctx, p, c, tube, pass, style, h); });
  return lay.rects.map((r) => ({ x: ox + r.x, y, w: r.w, h }));
}

// Neon icon (star/bolt/joystick) in a size x size box at (x, y).
function propNeonIcon(ctx, name, x, y, size, color, tube) {
  const p = propPath('icon' + name, PROP_ICONS[name]);
  ctx.save(); ctx.translate(x, y); ctx.scale(size, size);
  for (const pass of ['halo', 'tube']) propNeonPass(ctx, p, color, tube, pass, 'single', size);
  ctx.restore();
}

// Neon along an arbitrary Path2D given in canvas px (used for borders and underlines).
function propNeonRaw(ctx, path, color, tube, style = 'single') {
  for (const pass of ['halo', 'tube']) propNeonPass(ctx, path, color, tube, pass, style, 1);
}

// ═══════════════ Dot-matrix font (5x7) for LED displays ═══════════════
const PROP_DOT_FONT = {
  A: '01110 10001 10001 11111 10001 10001 10001', B: '11110 10001 10001 11110 10001 10001 11110',
  C: '01110 10001 10000 10000 10000 10001 01110', D: '11110 10001 10001 10001 10001 10001 11110',
  E: '11111 10000 10000 11110 10000 10000 11111', F: '11111 10000 10000 11110 10000 10000 10000',
  G: '01110 10001 10000 10111 10001 10001 01111', H: '10001 10001 10001 11111 10001 10001 10001',
  I: '01110 00100 00100 00100 00100 00100 01110', J: '00111 00010 00010 00010 00010 10010 01100',
  K: '10001 10010 10100 11000 10100 10010 10001', L: '10000 10000 10000 10000 10000 10000 11111',
  M: '10001 11011 10101 10101 10001 10001 10001', N: '10001 11001 10101 10011 10001 10001 10001',
  O: '01110 10001 10001 10001 10001 10001 01110', P: '11110 10001 10001 11110 10000 10000 10000',
  Q: '01110 10001 10001 10001 10101 10010 01101', R: '11110 10001 10001 11110 10100 10010 10001',
  S: '01111 10000 10000 01110 00001 00001 11110', T: '11111 00100 00100 00100 00100 00100 00100',
  U: '10001 10001 10001 10001 10001 10001 01110', V: '10001 10001 10001 10001 10001 01010 00100',
  W: '10001 10001 10001 10101 10101 11011 10001', X: '10001 10001 01010 00100 01010 10001 10001',
  Y: '10001 10001 01010 00100 00100 00100 00100', Z: '11111 00001 00010 00100 01000 10000 11111',
  0: '01110 10001 10011 10101 11001 10001 01110', 1: '00100 01100 00100 00100 00100 00100 01110',
  2: '01110 10001 00001 00010 00100 01000 11111', 3: '11110 00001 00001 01110 00001 00001 11110',
  4: '00010 00110 01010 10010 11111 00010 00010', 5: '11111 10000 11110 00001 00001 10001 01110',
  6: '00110 01000 10000 11110 10001 10001 01110', 7: '11111 00001 00010 00100 01000 01000 01000',
  8: '01110 10001 10001 01110 10001 10001 01110', 9: '01110 10001 10001 01111 00001 00010 01100',
  '.': '00000 00000 00000 00000 00000 01100 01100', '-': '00000 00000 00000 11111 00000 00000 00000',
  ':': '00000 01100 01100 00000 01100 01100 00000', '!': '00100 00100 00100 00100 00100 00000 00100',
  '$': '00100 01111 10100 01110 00101 11110 00100', '>': '10000 01000 00100 00010 00100 01000 10000',
  '*': '00000 00100 10101 01110 10101 00100 00000', ' ': '00000 00000 00000 00000 00000 00000 00000',
};
const propDotRows = {};
// Draws `text` as LEDs: pitch 1 = one canvas pixel per LED (used for the shader-lit scoreboard), otherwise round dots.
function propDotText(ctx, text, x, y, pitch, color) {
  ctx.fillStyle = color;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i], rows = propDotRows[ch] || (propDotRows[ch] = (PROP_DOT_FONT[ch] || PROP_DOT_FONT[' ']).split(' '));
    for (let ry = 0; ry < 7; ry++) for (let rx = 0; rx < 5; rx++) {
      if (rows[ry][rx] !== '1') continue;
      const px = x + (i * 6 + rx) * pitch, py = y + ry * pitch;
      if (pitch === 1) ctx.fillRect(px, py, 1, 1);
      else { ctx.beginPath(); ctx.arc(px + pitch / 2, py + pitch / 2, pitch * 0.42, 0, 6.2832); ctx.fill(); }
    }
  }
}

// ═══════════════ Canvas art: shared drawing helpers ═══════════════
function propVGrad(ctx, y0, y1, stops) { const g = ctx.createLinearGradient(0, y0, 0, y1); for (const [o, c] of stops) g.addColorStop(o, c); return g; }
function propBg(ctx, w, h, stops) { ctx.fillStyle = propVGrad(ctx, 0, h, stops); ctx.fillRect(0, 0, w, h); }
function propStars(ctx, w, h, n, seed) {
  const r = rng(seed); ctx.fillStyle = '#fff';
  for (let i = 0; i < n; i++) { ctx.globalAlpha = 0.35 + r() * 0.65; const s = r() < 0.15 ? 3 : 2; ctx.fillRect(r() * w, r() * h, s, s); }
  ctx.globalAlpha = 1;
}
// Bold title text, shrunk to fit maxW, with optional outline.
function propTitle(ctx, text, x, y, maxW, size, fill, stroke, lw, style = 'italic 900') {
  ctx.save(); ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.lineJoin = 'round';
  ctx.font = `${style} ${size}px ${PROP_FONT}`;
  const tw = ctx.measureText(text).width;
  if (tw > maxW) ctx.font = `${style} ${size * maxW / tw}px ${PROP_FONT}`;
  if (lw) { ctx.strokeStyle = stroke; ctx.lineWidth = lw; ctx.strokeText(text, x, y); }
  ctx.fillStyle = fill; ctx.fillText(text, x, y);
  ctx.restore();
}
function propSmallText(ctx, text, x, y, size, color, align = 'center', font = ARCADE_FONT) {
  ctx.save(); ctx.textAlign = align; ctx.textBaseline = 'middle'; ctx.font = `${size}px ${font}`; ctx.fillStyle = color; ctx.fillText(text, x, y); ctx.restore();
}
function propSprite(ctx, rows, x, y, px, color) {   // pixel-art sprite from strings of 0/1
  ctx.fillStyle = color;
  rows.forEach((row, j) => { for (let i = 0; i < row.length; i++) if (row[i] === '1') ctx.fillRect(x + i * px, y + j * px, px, px); });
}
function propSun(ctx, cx, cy, r, top, bottom, stripe) {   // retro sun with horizontal cut-outs
  ctx.save(); ctx.beginPath(); ctx.arc(cx, cy, r, 0, 7); ctx.clip();
  ctx.fillStyle = propVGrad(ctx, cy - r, cy + r, [[0, top], [1, bottom]]); ctx.fillRect(cx - r, cy - r, 2 * r, 2 * r);
  ctx.fillStyle = stripe;
  for (let i = 0; i < 7; i++) ctx.fillRect(cx - r, cy + r * 0.05 + i * r * 0.14, 2 * r, 2 + i * 1.6);
  ctx.restore();
}
function propGrid(ctx, w, y0, y1, color, vx = w / 2) {   // perspective grid floor
  ctx.strokeStyle = color; ctx.lineWidth = 2; ctx.globalAlpha = 0.85;
  for (let i = -14; i <= 14; i++) { ctx.beginPath(); ctx.moveTo(vx + i * 6, y0); ctx.lineTo(vx + i * 70, y1); ctx.stroke(); }
  for (let k = 1; k <= 9; k++) { const y = y0 + (y1 - y0) * (k / 9) ** 2; ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(w, y); ctx.stroke(); }
  ctx.globalAlpha = 1;
}
function propHazard(ctx, x, y, w, h, stripe, a = '#ffd400', b = '#111') {   // diagonal hazard stripes
  ctx.save(); ctx.beginPath(); ctx.rect(x, y, w, h); ctx.clip();
  ctx.fillStyle = a; ctx.fillRect(x, y, w, h); ctx.fillStyle = b;
  for (let i = -h; i < w + h; i += stripe * 2) { ctx.beginPath(); ctx.moveTo(x + i, y + h); ctx.lineTo(x + i + stripe, y + h); ctx.lineTo(x + i + stripe + h, y); ctx.lineTo(x + i + h, y); ctx.fill(); }
  ctx.restore();
}
function propPosterFrame(ctx, w, h, c = '#0a0a0f') {
  ctx.strokeStyle = c; ctx.lineWidth = 14; ctx.strokeRect(0, 0, w, h);
  ctx.strokeStyle = 'rgba(255,255,255,0.35)'; ctx.lineWidth = 2; ctx.strokeRect(14, 14, w - 28, h - 28);
}

// ═══════════════ Poster art (invented games, films and bands; no real brands) ═══════════════
const PROP_INVADER = ['00100000100', '00010001000', '00111111100', '01101110110', '11111111111', '10111111101', '10100000101', '00011011000'];

function propPosterStarBlaster(ctx, w, h) {
  propBg(ctx, w, h, [[0, '#070226'], [0.55, '#2a0b64'], [1, '#6a1a8f']]);
  propStars(ctx, w, h, 120, 11);
  const pg = ctx.createRadialGradient(320, 190, 8, 335, 205, 110);
  pg.addColorStop(0, '#ffd08a'); pg.addColorStop(0.5, '#ff5fa8'); pg.addColorStop(1, '#3a1470');
  ctx.fillStyle = pg; ctx.beginPath(); ctx.arc(335, 205, 100, 0, 7); ctx.fill();
  ctx.strokeStyle = '#7fe9ff'; ctx.lineWidth = 7; ctx.beginPath(); ctx.ellipse(335, 212, 165, 30, -0.35, 0.15, 6.1); ctx.stroke();
  ['#3dff88', '#ff5fd0', '#ffe14a'].forEach((c, r) => {
    for (let i = 0; i < 3; i++) propSprite(ctx, PROP_INVADER, 60 + i * 135 + (r % 2) * 40, 300 + r * 62, 5, c);
  });
  ctx.strokeStyle = '#7fe9ff'; ctx.lineWidth = 5; ctx.shadowColor = '#7fe9ff'; ctx.shadowBlur = 16;
  ctx.beginPath(); ctx.moveTo(256, 520); ctx.lineTo(256, 330); ctx.stroke(); ctx.shadowBlur = 0;
  ctx.fillStyle = '#eaf6ff'; ctx.beginPath(); ctx.moveTo(256, 520); ctx.lineTo(292, 585); ctx.lineTo(256, 570); ctx.lineTo(220, 585); ctx.fill();
  ctx.fillStyle = '#ff8a3d'; ctx.beginPath(); ctx.moveTo(244, 575); ctx.lineTo(256, 615); ctx.lineTo(268, 575); ctx.fill();
  propTitle(ctx, 'STAR', 256, 92, 400, 96, propVGrad(ctx, 50, 130, [[0, '#ffffff'], [0.5, '#9fe8ff'], [1, '#3a7bd5']]), '#12063a', 14);
  propTitle(ctx, 'BLASTER', 256, 178, 440, 88, propVGrad(ctx, 140, 220, [[0, '#ffffff'], [0.5, '#ffb3ec'], [1, '#d03aa0']]), '#12063a', 14);
  propSmallText(ctx, 'INSERT COIN', 256, 662, 24, '#7fe9ff');
  propPosterFrame(ctx, w, h);
}

function propPosterTurbo(ctx, w, h) {
  const hy = 394;
  propBg(ctx, w, h, [[0, '#12053a'], [0.3, '#8a1a86'], [0.55, '#ff6a3d'], [0.5601, '#1a0a30'], [1, '#0a0418']]);
  propStars(ctx, w, 150, 60, 5);
  propSun(ctx, 256, hy, 135, '#fff36b', '#ff2b8a', '#c0287f');
  ctx.fillStyle = '#1b0a3c'; ctx.beginPath(); ctx.moveTo(0, hy);
  [[40, 340], [90, 370], [140, 335], [200, 380], [312, 382], [380, 330], [440, 372], [512, 345]].forEach(([x, y]) => ctx.lineTo(x, y));
  ctx.lineTo(512, hy); ctx.fill();
  propGrid(ctx, w, hy, h, '#ff2bd6');
  ctx.fillStyle = '#08080f'; ctx.beginPath(); ctx.moveTo(140, 650); ctx.lineTo(165, 590); ctx.lineTo(228, 566); ctx.lineTo(284, 566); ctx.lineTo(347, 590); ctx.lineTo(372, 650); ctx.fill();
  ctx.shadowColor = '#ff2a3a'; ctx.shadowBlur = 18; ctx.fillStyle = '#ff2a3a';
  ctx.fillRect(160, 604, 62, 14); ctx.fillRect(290, 604, 62, 14); ctx.shadowBlur = 0;
  propTitle(ctx, 'TURBO', 256, 92, 420, 116, propVGrad(ctx, 40, 140, [[0, '#fff36b'], [1, '#ff8a1f']]), '#3a0a50', 14);
  propTitle(ctx, 'RACER', 256, 196, 420, 116, propVGrad(ctx, 140, 240, [[0, '#ff8a1f'], [1, '#ff2b8a']]), '#3a0a50', 14);
  propPosterFrame(ctx, w, h);
}

function propPosterNinja(ctx, w, h) {
  propBg(ctx, w, h, [[0, '#031018'], [0.6, '#0b3a4c'], [1, '#02080c']]);
  ctx.shadowColor = '#7fe9ff'; ctx.shadowBlur = 60; ctx.fillStyle = '#e8fbff'; ctx.beginPath(); ctx.arc(345, 200, 95, 0, 7); ctx.fill(); ctx.shadowBlur = 0;
  const r = rng(21);
  for (let x = 0, i = 0; x < w; x += 46 + r() * 20, i++) {   // skyline with lit windows
    const bh = 120 + r() * 220, bw = 44 + r() * 18;
    ctx.fillStyle = '#040a10'; ctx.fillRect(x, h - bh, bw, bh);
    for (let wy = h - bh + 12; wy < h - 14; wy += 20) for (let wx = x + 6; wx < x + bw - 8; wx += 14) if (r() < 0.35) { ctx.fillStyle = r() < 0.5 ? '#ffd23a' : '#ff5fd0'; ctx.fillRect(wx, wy, 6, 9); }
  }
  ctx.fillStyle = '#050508'; ctx.strokeStyle = '#050508'; ctx.lineCap = 'round';
  ctx.beginPath(); ctx.arc(230, 322, 21, 0, 7); ctx.fill();
  ctx.beginPath(); ctx.moveTo(214, 346); ctx.lineTo(252, 346); ctx.lineTo(264, 428); ctx.lineTo(224, 438); ctx.fill();
  ctx.lineWidth = 20; ctx.beginPath(); ctx.moveTo(232, 436); ctx.lineTo(190, 495); ctx.lineTo(160, 545); ctx.moveTo(252, 434); ctx.lineTo(304, 470); ctx.lineTo(338, 462); ctx.stroke();
  ctx.lineWidth = 14; ctx.beginPath(); ctx.moveTo(242, 360); ctx.lineTo(300, 326); ctx.lineTo(340, 286); ctx.stroke();
  ctx.strokeStyle = '#d8f6ff'; ctx.lineWidth = 5; ctx.beginPath(); ctx.moveTo(332, 296); ctx.lineTo(428, 176); ctx.stroke();
  ctx.strokeStyle = '#ff2a3a'; ctx.lineWidth = 10; ctx.beginPath(); ctx.moveTo(220, 330); ctx.bezierCurveTo(160, 310, 110, 350, 70, 322); ctx.stroke();
  propTitle(ctx, 'NEON', 256, 82, 400, 100, '#ff2bd6', '#1a0430', 12);
  propTitle(ctx, 'NINJA', 256, 168, 400, 100, '#00e5ff', '#03151c', 12);
  propSmallText(ctx, 'SHADOWS NEVER SLEEP', 256, 660, 15, '#a8f4ff');
  propPosterFrame(ctx, w, h);
}

function propPosterRobot(ctx, w, h) {   // B-movie one-sheet
  const bg = ctx.createRadialGradient(256, 290, 20, 256, 290, 430); bg.addColorStop(0, '#6a0c16'); bg.addColorStop(1, '#050203');
  ctx.fillStyle = bg; ctx.fillRect(0, 0, w, h);
  ctx.fillStyle = propVGrad(ctx, 130, 400, [[0, '#a6afc2'], [1, '#2a2f3a']]);
  ctx.beginPath(); ctx.roundRect(136, 130, 240, 270, 28); ctx.fill();
  ctx.fillStyle = '#4c5364'; ctx.fillRect(210, 400, 92, 40);
  ctx.fillStyle = '#050508'; ctx.fillRect(166, 210, 180, 60);
  ctx.shadowColor = '#ff2a3a'; ctx.shadowBlur = 34; ctx.fillStyle = '#ff5a5a';
  ctx.beginPath(); ctx.arc(216, 240, 16, 0, 7); ctx.arc(296, 240, 16, 0, 7); ctx.fill(); ctx.shadowBlur = 0;
  ctx.fillStyle = '#0b0d12'; for (let i = 0; i < 7; i++) ctx.fillRect(184 + i * 23, 322, 10, 46);
  ctx.strokeStyle = '#0b0b10'; ctx.lineWidth = 3; ctx.beginPath(); ctx.moveTo(150, 138); ctx.lineTo(178, 176); ctx.lineTo(160, 204); ctx.lineTo(190, 226); ctx.stroke();
  ctx.strokeStyle = '#a6afc2'; ctx.lineWidth = 6; ctx.beginPath(); ctx.moveTo(256, 130); ctx.lineTo(256, 84); ctx.stroke();
  ctx.fillStyle = '#ff2a3a'; ctx.beginPath(); ctx.arc(256, 78, 10, 0, 7); ctx.fill();
  propTitle(ctx, 'NIGHT OF', 256, 490, 400, 48, '#f4f0ff', '#000', 6, '900');
  propTitle(ctx, 'THE ROBOT', 256, 556, 470, 84, propVGrad(ctx, 520, 596, [[0, '#ffdf6b'], [1, '#ff2a3a']]), '#000', 10, '900');
  propSmallText(ctx, 'THEY CAME TO PLAY.', 256, 616, 14, '#ffb0b0');
  propSmallText(ctx, 'STARRING JESS MORROW  DEXTER VANCE', 256, 664, 9, '#c8c0d0');
  propSmallText(ctx, 'A FILM BY R. KOWALSKI  IN NEON COLOR', 256, 682, 9, '#c8c0d0');
  propPosterFrame(ctx, w, h);
}

function propPosterKittens(ctx, w, h) {   // band poster
  propBg(ctx, w, h, [[0, '#ff2bd6'], [1, '#2a0a6a']]);
  ctx.fillStyle = 'rgba(255,255,255,0.13)';
  for (let i = 0; i < 20; i += 2) { const a = i * Math.PI / 10, b = (i + 1) * Math.PI / 10; ctx.beginPath(); ctx.moveTo(256, 290); ctx.lineTo(256 + 700 * Math.cos(a), 290 + 700 * Math.sin(a)); ctx.lineTo(256 + 700 * Math.cos(b), 290 + 700 * Math.sin(b)); ctx.fill(); }
  ctx.fillStyle = '#0a0410'; ctx.beginPath(); ctx.arc(256, 300, 96, 0, 7); ctx.fill();
  ctx.beginPath(); ctx.moveTo(176, 250); ctx.lineTo(180, 150); ctx.lineTo(244, 214); ctx.fill();
  ctx.beginPath(); ctx.moveTo(336, 250); ctx.lineTo(332, 150); ctx.lineTo(268, 214); ctx.fill();
  ctx.strokeStyle = '#00e5ff'; ctx.lineWidth = 10; ctx.shadowColor = '#00e5ff'; ctx.shadowBlur = 24;
  ctx.beginPath(); ctx.moveTo(222, 290); ctx.lineTo(0, 246); ctx.moveTo(290, 290); ctx.lineTo(512, 246); ctx.stroke(); ctx.shadowBlur = 0;
  ctx.fillStyle = '#eaffff'; ctx.beginPath(); ctx.ellipse(222, 292, 15, 20, 0, 0, 7); ctx.ellipse(290, 292, 15, 20, 0, 0, 7); ctx.fill();
  ctx.strokeStyle = '#eaeaff'; ctx.lineWidth = 2; ctx.beginPath();   // whiskers
  for (const s of [-1, 1]) for (const dy of [-8, 6, 20]) { ctx.moveTo(256 + s * 34, 332 + dy / 2); ctx.lineTo(256 + s * 120, 332 + dy); }
  ctx.stroke();
  propTitle(ctx, 'THE LASER', 256, 442, 440, 76, '#ffffff', '#2a0a6a', 12);
  propTitle(ctx, 'KITTENS', 256, 516, 440, 86, propVGrad(ctx, 476, 556, [[0, '#ffe600'], [1, '#ff8a1f']]), '#2a0a6a', 12);
  ctx.fillStyle = '#00e5ff'; ctx.fillRect(40, 580, 432, 44);
  propTitle(ctx, "LIVE! WORLD TOUR '94", 256, 603, 400, 28, '#08061a', null, 0, '900');
  propSmallText(ctx, 'NEON CITY  PIXEL BAY  SYNTH VALLEY', 256, 652, 11, '#fff');
  propPosterFrame(ctx, w, h);
}

function propPosterVolt(ctx, w, h) {
  propHazard(ctx, 0, 0, w, h, 34, '#ffe600', '#15101a');
  ctx.fillStyle = 'rgba(255,230,0,0.9)'; ctx.fillRect(28, 28, w - 56, h - 56);
  ctx.fillStyle = '#12081e'; ctx.beginPath(); ctx.moveTo(320, 40); ctx.lineTo(120, 350); ctx.lineTo(240, 350); ctx.lineTo(180, 560); ctx.lineTo(410, 260); ctx.lineTo(290, 260); ctx.lineTo(380, 40); ctx.fill();
  ctx.strokeStyle = '#00b8d4'; ctx.lineWidth = 12; ctx.lineCap = 'round';
  for (const [y, ph] of [[300, 0], [370, 2]]) { ctx.beginPath(); for (let x = 30; x <= 482; x += 8) { const yy = y + Math.sin(x / 34 + ph) * 22; x === 30 ? ctx.moveTo(x, yy) : ctx.lineTo(x, yy); } ctx.stroke(); }
  propTitle(ctx, 'DJ VOLT', 256, 596, 420, 110, '#ff2bd6', '#12081e', 16);
  propTitle(ctx, '& THE ELECTRIC EELS', 256, 656, 420, 40, '#12081e', null, 0, '900');
  propPosterFrame(ctx, w, h);
}

function propPosterPirates(ctx, w, h) {
  propBg(ctx, w, h, [[0, '#0a1440'], [0.6, '#1f5fa8'], [0.61, '#0a2a5a'], [1, '#040d24']]);
  propStars(ctx, w, 300, 70, 33);
  ctx.fillStyle = '#fff6d8'; ctx.beginPath(); ctx.arc(110, 150, 48, 0, 7); ctx.fill();
  ctx.fillStyle = '#120a08'; ctx.beginPath(); ctx.moveTo(110, 470); ctx.lineTo(400, 470); ctx.lineTo(360, 530); ctx.lineTo(160, 530); ctx.fill();
  ctx.fillRect(252, 196, 8, 276);
  ctx.fillStyle = '#efe3c4'; ctx.beginPath(); ctx.moveTo(262, 210); ctx.quadraticCurveTo(340, 300, 262, 400); ctx.fill();
  ctx.fillStyle = '#d8c8a2'; ctx.beginPath(); ctx.moveTo(248, 230); ctx.quadraticCurveTo(180, 310, 248, 410); ctx.fill();
  ctx.fillStyle = '#12081e'; ctx.fillRect(254, 150, 60, 40);
  ctx.fillStyle = '#fff'; ctx.beginPath(); ctx.arc(284, 168, 11, 0, 7); ctx.fill(); ctx.fillRect(278, 172, 12, 9);
  ctx.fillStyle = '#12081e'; ctx.fillRect(276, 163, 4, 4); ctx.fillRect(288, 163, 4, 4);
  ctx.fillStyle = '#0a2a5a';
  for (let row = 0; row < 4; row++) { ctx.fillStyle = ['#0e3a78', '#0a2f66', '#082550', '#061c3e'][row]; ctx.beginPath(); ctx.moveTo(0, 520 + row * 40); for (let x = 0; x <= 512; x += 16) ctx.lineTo(x, 520 + row * 40 + Math.sin(x / 26 + row) * 10); ctx.lineTo(512, h); ctx.lineTo(0, h); ctx.fill(); }
  propTitle(ctx, 'PIXEL', 256, 70, 400, 96, propVGrad(ctx, 30, 110, [[0, '#fff2a0'], [1, '#ffb300']]), '#2a1200', 14);
  propTitle(ctx, 'PIRATES', 256, 654, 420, 88, propVGrad(ctx, 615, 695, [[0, '#fff2a0'], [1, '#ffb300']]), '#2a1200', 14);
  propPosterFrame(ctx, w, h);
}

function propPosterContinue(ctx, w, h) {
  const bg = ctx.createRadialGradient(256, 340, 20, 256, 340, 420); bg.addColorStop(0, '#3a0d6a'); bg.addColorStop(1, '#07020f');
  ctx.fillStyle = bg; ctx.fillRect(0, 0, w, h);
  ctx.shadowColor = '#ff2bd6'; ctx.shadowBlur = 24;
  propTitle(ctx, 'CONTINUE?', 256, 120, 440, 72, '#ffffff', '#ff2bd6', 4, '900');
  propTitle(ctx, '9', 256, 350, 300, 360, propVGrad(ctx, 200, 500, [[0, '#ffe600'], [1, '#ff2bd6']]), '#1a0430', 16, '900');
  ctx.shadowBlur = 0;
  propSmallText(ctx, 'INSERT COIN', 256, 566, 30, '#00e5ff');
  propSmallText(ctx, 'CREDIT 00', 256, 630, 16, '#c8c0e0');
  propPosterFrame(ctx, w, h);
}

function propPosterHighScore(ctx, w, h) {   // landscape banner
  propBg(ctx, w, h, [[0, '#0a0630'], [1, '#22106e']]);
  for (let i = 0; i < 32; i++) { ctx.fillStyle = i % 2 ? '#ffe600' : '#111'; ctx.fillRect(i * 32, 0, 32, 26); ctx.fillRect(i * 32, h - 26, 32, 26); }
  ctx.shadowColor = '#ff2bd6'; ctx.shadowBlur = 30;
  propTitle(ctx, 'HIGH SCORE', 640, 200, 720, 190, propVGrad(ctx, 110, 290, [[0, '#ffee55'], [0.5, '#ff9a2a'], [1, '#ff2bd6']]), '#1a0640', 20, '900');
  ctx.shadowBlur = 0;
  propTitle(ctx, 'BEAT THE CHAMP!', 640, 372, 660, 64, '#00e5ff', '#031824', 8, '900');
  ctx.fillStyle = '#ffc93c'; ctx.beginPath(); ctx.moveTo(90, 120); ctx.lineTo(210, 120); ctx.lineTo(196, 250); ctx.quadraticCurveTo(150, 300, 104, 250); ctx.fill();
  ctx.fillRect(140, 290, 20, 60); ctx.fillRect(108, 350, 84, 22);
  ctx.strokeStyle = '#ffc93c'; ctx.lineWidth = 10; ctx.beginPath(); ctx.arc(88, 170, 34, 1.6, 4.7); ctx.arc(212, 170, 34, -1.6, 1.6); ctx.stroke();
  propPosterFrame(ctx, w, h);
}

function propPosterNotice(ctx, w, h) {   // "no food or drink" placard
  ctx.fillStyle = '#ffd400'; ctx.fillRect(0, 0, w, h);
  propHazard(ctx, 0, 0, w, 44, 26); propHazard(ctx, 0, h - 44, w, 44, 26);
  const banned = (cx, draw) => {
    draw(cx, 250);
    ctx.strokeStyle = '#d61f2c'; ctx.lineWidth = 16; ctx.beginPath(); ctx.arc(cx, 250, 92, 0, 7); ctx.moveTo(cx - 65, 185); ctx.lineTo(cx + 65, 315); ctx.stroke();
  };
  banned(150, (cx, cy) => { ctx.fillStyle = '#111'; ctx.beginPath(); ctx.moveTo(cx - 40, cy - 55); ctx.lineTo(cx + 40, cy - 55); ctx.lineTo(cx + 30, cy + 55); ctx.lineTo(cx - 30, cy + 55); ctx.fill(); ctx.fillRect(cx - 10, cy - 78, 6, 26); });
  banned(360, (cx, cy) => { ctx.fillStyle = '#111'; ctx.beginPath(); ctx.ellipse(cx, cy - 22, 62, 32, 0, Math.PI, 0); ctx.fill(); ctx.fillRect(cx - 62, cy - 10, 124, 14); ctx.fillRect(cx - 58, cy + 8, 116, 12); ctx.beginPath(); ctx.ellipse(cx, cy + 32, 60, 18, 0, 0, Math.PI); ctx.fill(); });
  propTitle(ctx, 'NO FOOD OR DRINK', 730, 190, 480, 74, '#111', null, 0, '900');
  propTitle(ctx, 'ON MACHINES', 730, 282, 480, 84, '#d61f2c', null, 0, '900');
  propSmallText(ctx, 'THANK YOU - MANAGEMENT', 730, 364, 20, '#111');
}

// ── Stickers (128x128 each, die-cut white border) ──
const PROP_STICKERS = [
  (c) => { c.fillStyle = '#ffd93b'; c.beginPath(); c.arc(64, 64, 42, 0, 7); c.fill(); c.fillStyle = '#111'; c.fillRect(46, 48, 9, 16); c.fillRect(73, 48, 9, 16); c.lineWidth = 6; c.strokeStyle = '#111'; c.beginPath(); c.arc(64, 68, 24, 0.2, 2.9); c.stroke(); },
  (c) => { c.fillStyle = '#5ee66a'; c.beginPath(); c.ellipse(64, 66, 34, 42, 0, 0, 7); c.fill(); c.fillStyle = '#0b0b12'; c.beginPath(); c.ellipse(50, 60, 9, 14, 0.5, 0, 7); c.ellipse(78, 60, 9, 14, -0.5, 0, 7); c.fill(); },
  (c) => { c.fillStyle = '#ff2bd6'; c.beginPath(); for (let i = 0; i < 16; i++) { const a = i * Math.PI / 8, r = i % 2 ? 26 : 46; c.lineTo(64 + r * Math.cos(a), 64 + r * Math.sin(a)); } c.fill(); },
  (c) => { c.fillStyle = '#0b0b12'; c.beginPath(); c.roundRect(14, 34, 100, 60, 10); c.fill(); propSmallText(c, '1UP', 64, 66, 24, '#3dff88'); },
  (c) => { c.fillStyle = '#ff2a3a'; c.beginPath(); c.moveTo(64, 96); c.bezierCurveTo(6, 56, 30, 18, 64, 46); c.bezierCurveTo(98, 18, 122, 56, 64, 96); c.fill(); },
  (c) => { c.fillStyle = '#5a2bd6'; c.beginPath(); c.arc(64, 64, 46, 0, 7); c.fill(); c.fillStyle = '#ffe600'; c.beginPath(); c.moveTo(72, 22); c.lineTo(42, 70); c.lineTo(62, 70); c.lineTo(52, 108); c.lineTo(88, 56); c.lineTo(68, 56); c.fill(); },
  (c) => { c.fillStyle = '#fff'; c.beginPath(); c.arc(64, 64, 42, 0, 7); c.fill(); c.strokeStyle = '#d61f2c'; c.lineWidth = 9; c.beginPath(); c.arc(64, 64, 34, 0, 7); c.moveTo(40, 40); c.lineTo(88, 88); c.stroke(); },
  (c) => { c.fillStyle = '#d61f2c'; c.fillRect(14, 22, 100, 24); c.fillStyle = '#fff'; c.fillRect(14, 46, 100, 60); propSmallText(c, 'HELLO', 64, 34, 13, '#fff'); propSmallText(c, 'ZAP', 64, 78, 22, '#111', 'center', PROP_FONT); },
];
function propDrawSticker(c, i) {
  c.fillStyle = '#f4f4f4'; c.beginPath(); c.roundRect(6, 6, 116, 116, 30); c.fill();
  c.save(); c.translate(64, 64); c.scale(0.86, 0.86); c.translate(-64, -64);
  PROP_STICKERS[i](c);
  c.restore();
}
function propDrawExtinguisherSign(c) {
  c.fillStyle = '#d61f2c'; c.fillRect(0, 0, 128, 128); c.fillStyle = '#fff'; c.fillRect(8, 8, 112, 112); c.fillStyle = '#d61f2c'; c.fillRect(14, 14, 100, 100);
  c.fillStyle = '#fff'; c.fillRect(52, 36, 26, 56); c.fillRect(56, 26, 18, 12); c.fillRect(74, 30, 20, 6); c.fillRect(38, 42, 14, 5);
}

function propDrawStaffSign(c, w, h) {
  c.fillStyle = '#12081e'; c.fillRect(0, 0, w, h); c.strokeStyle = '#d61f2c'; c.lineWidth = 8; c.strokeRect(6, 6, w - 12, h - 12);
  propTitle(c, 'STAFF', w / 2, 44, 200, 46, '#ffffff', null, 0, '900'); propTitle(c, 'ONLY', w / 2, 92, 200, 46, '#ff5a5a', null, 0, '900');
}

// ═══════════════ Lit / printed texture atlases ═══════════════
// Printed things (posters, stickers): lit softly by the room. 2048x2048, portrait cells 512x704, landscape 1024x512.
function propPrintAtlas() {
  const at = new PropAtlas(2048, 2048);
  [propPosterStarBlaster, propPosterTurbo, propPosterNinja, propPosterRobot, propPosterKittens, propPosterVolt, propPosterPirates, propPosterContinue]
    .forEach((fn, i) => at.add('p' + i, (i % 4) * 512, Math.floor(i / 4) * 704, 512, 704, fn));
  at.add('score', 0, 1408, 1024, 512, propPosterHighScore).add('notice', 1024, 1408, 1024, 512, propPosterNotice);
  PROP_STICKERS.forEach((_, i) => at.add('st' + i, i * 128, 1920, 128, 128, (c) => propDrawSticker(c, i)));
  at.add('ext', 1024, 1920, 128, 128, propDrawExtinguisherSign);
  at.add('staff', 1152, 1920, 256, 128, propDrawStaffSign);
  return at;
}

// Self-lit panels (register, ticket machine, light-box price signs, counter panel, EXIT). 2048x1024.
function propLitAtlas() {
  const at = new PropAtlas(2048, 1024);
  at.add('register', 0, 0, 256, 128, (c, w, h) => {
    c.fillStyle = '#03150a'; c.fillRect(0, 0, w, h);
    propDotText(c, 'TKT 0250', 34, 16, 4, '#3dff7a'); propDotText(c, 'THANK YOU', 10, 66, 4, '#3dff7a');
  });
  at.add('placard', 256, 0, 256, 128, (c, w, h) => {
    c.fillStyle = '#f2e9d0'; c.fillRect(0, 0, w, h); c.strokeStyle = '#b3122a'; c.lineWidth = 6; c.strokeRect(6, 6, w - 12, h - 12);
    propTitle(c, 'RING FOR', 128, 44, 210, 40, '#b3122a', null, 0, '900'); propTitle(c, 'PRIZES!', 128, 88, 210, 44, '#1a1024', null, 0, '900');
  });
  at.add('ticketFace', 512, 0, 512, 384, (c, w, h) => {
    c.fillStyle = propVGrad(c, 0, h, [[0, '#4a1a8a'], [1, '#22093f']]); c.fillRect(0, 0, w, h);
    c.fillStyle = '#ffe600'; c.fillRect(0, 0, w, 14); c.fillRect(0, h - 14, w, 14);
    propTitle(c, 'TICKET', w / 2, 60, 360, 56, '#ffe600', '#12051f', 6, '900'); propTitle(c, 'REDEMPTION', w / 2, 112, 420, 44, '#ff5fd0', '#12051f', 6, '900');
    c.fillStyle = '#080310'; c.fillRect(74, 150, 364, 96);
    propDotText(c, '0250', 108, 172, 8, '#ff5a2a');
    for (let i = 0; i < 9; i++) { c.fillStyle = i % 2 ? '#ffe600' : '#ff2bd6'; c.beginPath(); c.arc(64 + i * 48, 276, 11, 0, 7); c.fill(); }
    c.fillStyle = '#000'; c.fillRect(120, 310, 272, 26); c.strokeStyle = '#ff2a3a'; c.lineWidth = 5; c.shadowColor = '#ff2a3a'; c.shadowBlur = 14; c.strokeRect(120, 310, 272, 26);
  });
  const price = (name, x, title, tint, amount, tint2) => at.add(name, x, 0, 512, 320, (c, w, h) => {
    c.fillStyle = '#120a1e'; c.fillRect(0, 0, w, h); c.fillStyle = tint; c.fillRect(14, 14, w - 28, 92);
    propTitle(c, title, w / 2, 62, 440, 60, '#fff', '#12051f', 6, '900');
    c.fillStyle = tint2; c.fillRect(14, 116, w - 28, h - 130);
    propTitle(c, amount, w / 2, 190, 420, 110, '#12051f', null, 0, '900'); propTitle(c, 'TICKETS', w / 2, 268, 380, 50, '#12051f', null, 0, '900');
  });
  price('price1', 1024, 'SMALL PRIZES', '#ff2bd6', '25', '#ffe600'); price('price2', 1536, 'BIG PRIZES', '#00b8d4', '250', '#ffe600');
  at.add('centerPanel', 0, 384, 1024, 256, (c, w, h) => {
    c.fillStyle = propVGrad(c, 0, h, [[0, '#2a0e46'], [1, '#12051f']]); c.fillRect(0, 0, w, h);
    c.strokeStyle = '#ff2bd6'; c.lineWidth = 8; c.strokeRect(10, 10, w - 20, h - 20);
    propTitle(c, 'REDEEM YOUR TICKETS', w / 2, 96, 690, 84, propVGrad(c, 50, 140, [[0, '#fff36b'], [1, '#ff8a1f']]), '#12051f', 8, '900');
    propTitle(c, 'WIN BIG  -  PLAY MORE', w / 2, 184, 700, 46, '#00e5ff', '#12051f', 5, '900');
    for (const x of [90, 934]) { c.fillStyle = '#ffd7a0'; c.beginPath(); c.roundRect(x - 42, 90, 84, 70, 8); c.fill(); c.fillStyle = '#ff5a5a'; c.fillRect(x - 42, 118, 84, 14); }
  });
  at.add('exit', 1024, 384, 1024, 320, (c, w, h) => {
    c.fillStyle = propVGrad(c, 0, h, [[0, '#12a552'], [1, '#0a6d34']]); c.fillRect(0, 0, w, h);
    c.strokeStyle = '#eafff0'; c.lineWidth = 10; c.strokeRect(14, 14, w - 28, h - 28);
    propNeonText(c, 'EXIT', w / 2, 76, 170, [0xffffff], { center: true, tube: 30, gap: 40, style: 'flat' });
    c.fillStyle = '#eafff0';
    for (const s of [-1, 1]) { const x = w / 2 + s * 400; c.beginPath(); c.moveTo(x + s * 50, h / 2); c.lineTo(x - s * 30, h / 2 - 60); c.lineTo(x - s * 30, h / 2 + 60); c.fill(); }
  });
  return at;
}

// Additive neon accents on black (star/bolt/joystick, PRIZES, TOKENS, INSERT COIN). 2048x1024.
function propNeonAtlas() {
  const at = new PropAtlas(2048, 1024);
  const word = (name, x, y, w, text, colors, style = 'single', h = 132) => at.add(name, x, y, w, 256, (c, cw, ch) => {
    c.fillStyle = '#000'; c.fillRect(0, 0, cw, ch); propNeonText(c, text, cw / 2, (ch - h) / 2, h, colors, { center: true, style, tube: h * 0.115 });
  });
  word('prizes', 0, 0, 896, 'PRIZES', [NEON.yellow]); word('tokens', 896, 0, 896, 'TOKENS', [NEON.cyan]);
  word('insert', 0, 256, 1280, 'INSERT COIN', [NEON.pink, NEON.pink, NEON.pink, NEON.pink, NEON.pink, NEON.pink, NEON.pink, NEON.cyan, NEON.cyan, NEON.cyan, NEON.cyan, NEON.cyan], 'single', 108);
  [['star', NEON.yellow], ['bolt', NEON.cyan], ['joystick', NEON.pink]].forEach(([name, col], i) =>
    at.add(name, 1280 + i * 256, 256, 256, 256, (c, w, h) => { c.fillStyle = '#000'; c.fillRect(0, 0, w, h); propNeonIcon(c, name, 40, 40, 176, col, 15); }));
  return at;
}

// ── Vending machine front (512x1024) ──
const PROP_VENDING = [
  { name: 'BLIP COLA', tag: 'ICE COLD', a: '#1b5cff', b: '#00c8ff', dark: '#06133a', accent: NEON.cyan, body: 0x16357a, seed: 3,
    cans: ['#e8243c', '#1f6bff', '#26c281', '#ffb300', '#a15cff'] },
  { name: 'NEON POP', tag: 'SO FRESH', a: '#ff2b9a', b: '#ff8a1f', dark: '#3a0620', accent: NEON.pink, body: 0x6a1740, seed: 8,
    cans: ['#ff8a1f', '#39ff88', '#00c8ff', '#ff2b9a', '#ffe600'] },
];
function propDrawVending(ctx, w, h, th) {
  ctx.fillStyle = '#07080d'; ctx.fillRect(0, 0, w, h);
  const hg = ctx.createLinearGradient(0, 0, w, 0); hg.addColorStop(0, th.a); hg.addColorStop(1, th.b);
  ctx.fillStyle = hg; ctx.fillRect(16, 16, w - 32, 164);
  ctx.fillStyle = 'rgba(255,255,255,0.2)'; ctx.fillRect(16, 16, w - 32, 56);
  propTitle(ctx, th.name, w / 2, 100, w - 90, 84, '#ffffff', th.dark, 12);
  propSmallText(ctx, th.tag, w / 2, 156, 16, '#ffffff');
  const wx = 30, wy = 200, ww = 350, wh = 560, rowH = wh / 5, r = rng(th.seed);   // can window
  ctx.fillStyle = propVGrad(ctx, wy, wy + wh, [[0, '#8fbedb'], [1, '#33526e']]); ctx.fillRect(wx, wy, ww, wh);
  for (let row = 0; row < 5; row++) {
    const y = wy + row * rowH;
    for (let i = 0; i < 7; i++) {
      const cx = wx + 10 + i * 48, cy = y + 16;
      ctx.fillStyle = th.cans[(r() * th.cans.length) | 0]; ctx.fillRect(cx, cy, 38, 78);
      ctx.fillStyle = 'rgba(255,255,255,0.85)'; ctx.fillRect(cx, cy + 26, 38, 26);
      ctx.fillStyle = 'rgba(0,0,0,0.35)'; ctx.fillRect(cx + 29, cy, 9, 78);
      ctx.fillStyle = '#d5dbe3'; ctx.fillRect(cx + 3, cy - 4, 32, 6);
      ctx.fillStyle = 'rgba(255,255,255,0.5)'; ctx.fillRect(cx + 5, cy + 4, 4, 70);
    }
    ctx.fillStyle = '#1c2a38'; ctx.fillRect(wx, y + rowH - 14, ww, 14);
    ctx.fillStyle = '#fff'; for (let i = 0; i < 7; i++) ctx.fillRect(wx + 12 + i * 48, y + rowH - 11, 30, 8);
  }
  ctx.strokeStyle = '#141820'; ctx.lineWidth = 12; ctx.strokeRect(wx - 6, wy - 6, ww + 12, wh + 12);
  ctx.fillStyle = '#05060a'; ctx.fillRect(396, 200, 102, 46); propDotText(ctx, '1.25', 404, 210, 3.6, '#ffb03a');
  for (let i = 0; i < 12; i++) {   // keypad
    const bx = 398 + (i % 3) * 34, by = 268 + Math.floor(i / 3) * 34;
    ctx.fillStyle = '#c7ced9'; ctx.fillRect(bx, by, 30, 28); propSmallText(ctx, '123456789*0#'[i], bx + 15, by + 15, 14, '#12151c', 'center', PROP_FONT);
  }
  ctx.fillStyle = '#05060a'; ctx.fillRect(404, 430, 86, 22); ctx.strokeStyle = '#ff2a3a'; ctx.lineWidth = 4; ctx.shadowColor = '#ff2a3a'; ctx.shadowBlur = 12; ctx.strokeRect(404, 430, 86, 22); ctx.shadowBlur = 0;
  propSmallText(ctx, 'COINS', 447, 470, 11, '#fff');
  ctx.fillStyle = '#05060a'; ctx.fillRect(404, 500, 86, 40); ctx.fillStyle = '#3dff88'; ctx.beginPath(); ctx.moveTo(420, 512); ctx.lineTo(474, 512); ctx.lineTo(447, 532); ctx.fill();
  propSmallText(ctx, 'BILLS', 447, 560, 11, '#fff');
  ctx.fillStyle = '#04050a'; ctx.beginPath(); ctx.roundRect(60, 800, 300, 170, 16); ctx.fill();
  ctx.fillStyle = propVGrad(ctx, 810, 900, [[0, '#2c3446'], [1, '#141821']]); ctx.beginPath(); ctx.roundRect(72, 812, 276, 90, 10); ctx.fill();
  propSmallText(ctx, 'PUSH', 210, 858, 24, '#5d6780');
  ctx.fillStyle = th.a; ctx.fillRect(0, 0, 8, h); ctx.fillRect(w - 8, 0, 8, h);
}

// ── Change-machine front (256x576) ──
function propDrawChange(ctx, w, h) {
  ctx.fillStyle = propVGrad(ctx, 0, h, [[0, '#343a50'], [1, '#1e2233']]); ctx.fillRect(0, 0, w, h);
  ctx.fillStyle = '#0a0a12'; ctx.fillRect(12, 12, w - 24, 108);
  propNeonText(ctx, 'CHANGE', w / 2, 30, 40, [NEON.yellow], { center: true, tube: 6, gap: 9, style: 'single' });
  propSmallText(ctx, 'TOKENS  COINS', w / 2, 98, 12, '#ffd6a0');
  ctx.fillStyle = '#05060a'; ctx.fillRect(28, 134, 200, 50); propDotText(ctx, 'INSERT $1', 40, 146, 3.4, '#ffb03a');
  ctx.fillStyle = '#0b0c14'; ctx.beginPath(); ctx.roundRect(40, 200, 176, 84, 8); ctx.fill();
  ctx.fillStyle = '#000'; ctx.fillRect(60, 236, 136, 14);
  ctx.strokeStyle = '#3dff88'; ctx.lineWidth = 4; ctx.shadowColor = '#3dff88'; ctx.shadowBlur = 14; ctx.strokeRect(60, 236, 136, 14); ctx.shadowBlur = 0;
  ctx.fillStyle = '#3dff88'; for (let i = 0; i < 4; i++) { ctx.beginPath(); ctx.moveTo(80 + i * 30, 214); ctx.lineTo(92 + i * 30, 224); ctx.lineTo(80 + i * 30, 234); ctx.lineTo(84 + i * 30, 224); ctx.fill(); }
  propSmallText(ctx, 'BILLS', w / 2, 270, 10, '#9fb0c8');
  propSmallText(ctx, '$1  $5  $10', w / 2, 308, 11, '#dfe6f4'); propSmallText(ctx, '4 TOKENS = $1', w / 2, 334, 11, '#ffe14a');
  ctx.fillStyle = '#0a0b12'; ctx.beginPath(); ctx.roundRect(36, 404, 184, 118, 12); ctx.fill();
  ctx.fillStyle = propVGrad(ctx, 416, 512, [[0, '#06070c'], [1, '#22283a']]); ctx.fillRect(48, 416, 160, 96);
  propSmallText(ctx, 'TOKENS', w / 2, 384, 12, '#ffd6a0');
  ctx.fillStyle = '#ffc93c'; for (let i = 0; i < 5; i++) { ctx.beginPath(); ctx.ellipse(84 + i * 22, 490, 9, 6, 0, 0, 7); ctx.fill(); }
}

// ═══════════════ Scene builders ═══════════════
// Position of a wall-mounted item: `along` is x (north/south walls) or z (west/east walls), `off` the gap to the wall.
function propWallSpot(wall, along, off) {
  if (wall === 'N') return { x: along, z: -ROOM.d / 2 + off, ry: 0 };
  if (wall === 'S') return { x: along, z: ROOM.d / 2 - off, ry: Math.PI };
  if (wall === 'W') return { x: -ROOM.w / 2 + off, z: along, ry: Math.PI / 2 };
  return { x: ROOM.w / 2 - off, z: along, ry: -Math.PI / 2 };
}

// Soft radial and rectangular halo textures used by the additive glow quads.
function propGlowTextures() {
  const radial = propPainted(128, 128, (c) => {
    const g = c.createRadialGradient(64, 64, 0, 64, 64, 64);
    g.addColorStop(0, 'rgba(255,255,255,1)'); g.addColorStop(0.25, 'rgba(255,255,255,0.55)'); g.addColorStop(0.55, 'rgba(255,255,255,0.16)'); g.addColorStop(1, 'rgba(255,255,255,0)');
    c.fillStyle = g; c.fillRect(0, 0, 128, 128);
  });
  const box = propPainted(256, 128, (c) => {   // rectangle with feathered edges (fades to 0 at the border)
    const img = c.createImageData(256, 128), smooth = (t) => t * t * (3 - 2 * t);
    for (let y = 0; y < 128; y++) for (let x = 0; x < 256; x++) {
      const i = (y * 256 + x) * 4, a = smooth(Math.min(1, Math.min(x, 255 - x) / 70)) * smooth(Math.min(1, Math.min(y, 127 - y) / 40));
      img.data[i] = img.data[i + 1] = img.data[i + 2] = 255; img.data[i + 3] = Math.round(a * 255);
    }
    c.putImageData(img, 0, 0);
  });
  return { radial, box };
}

// The bundle of batches every builder writes into.
function propMakeKit() {
  const glowMat = (map) => new THREE.MeshBasicMaterial({ map, vertexColors: true, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, fog: false });
  const tex = propGlowTextures();
  const printAtlas = propPrintAtlas(), litAtlas = propLitAtlas(), neonAtlas = propNeonAtlas();
  const printTex = printAtlas.texture(), litTex = litAtlas.texture(), neonTex = neonAtlas.texture();
  return {
    solid: new PropBatch(new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.55, metalness: 0.3 })),
    glow: new PropBatch(new THREE.MeshBasicMaterial({ vertexColors: true })),
    glass: new PropBatch(new THREE.MeshBasicMaterial({ color: 0x9fc8ff, transparent: true, opacity: 0.07, depthWrite: false }), { colored: false }),
    halo: new PropBatch(glowMat(tex.radial)),
    haloBox: new PropBatch(glowMat(tex.box)),
    print: new PropBatch(new THREE.MeshStandardMaterial({ map: printTex, emissiveMap: printTex, emissive: 0xffffff, emissiveIntensity: 0.42, roughness: 0.6 }), { colored: false, atlas: printAtlas }),
    lit: new PropBatch(new THREE.MeshBasicMaterial({ map: litTex, vertexColors: true }), { atlas: litAtlas }),
    neon: new PropBatch(glowMat(neonTex), { atlas: neonAtlas }),
    prizes: { sphere: [], box: [], capsule: [], cone: [], cyl: [] },
    changeTex: null,   // shared front texture of the change machines
    tickers: [],       // per-frame callbacks (flicker, scoreboard, clock)
  };
}

// A machine front: texture is both the diffuse and the emissive map, so it glows but still catches room light.
function propPanelMesh(tex, w, h, x, y, z) {
  const mat = new THREE.MeshStandardMaterial({ map: tex, color: 0x808080, emissive: 0xffffff, emissiveMap: tex, emissiveIntensity: 0.95, roughness: 0.45, metalness: 0.05 });
  const mesh = new THREE.Mesh(new THREE.PlaneGeometry(w, h), mat);
  mesh.position.set(x, y, z); mesh.matrixAutoUpdate = false; mesh.updateMatrix();
  scene.add(mesh);
  return mesh;
}

// ── Prizes: plush toys, boxed toys, capsule-ball piles, rockets, trophies as instance records ──
function propInst(kit, type, x, y, z, sx, sy, sz, color, ry = 0) { kit.prizes[type].push({ x, y, z, sx, sy, sz, color, ry }); }

function propPlush(kit, cx, y, z, s, r) {   // returns the item width
  const col = PROP_PLUSH[(r() * PROP_PLUSH.length) | 0], kind = (r() * 4) | 0, ry = (r() - 0.5) * 0.7;
  const cs = Math.cos(ry), sn = Math.sin(ry);
  const put = (type, dx, dy, dz, sx, sy, sz, c) => propInst(kit, type, cx + (dx * cs + dz * sn) * s, y + dy * s, z + (-dx * sn + dz * cs) * s, sx * s, sy * s, sz * s, c, ry);
  if (kind === 3) {   // alien: big head, huge black eyes, antennae
    const g = 0x76e26a;
    put('sphere', 0, 0.07, 0, 0.15, 0.14, 0.11, g); put('sphere', 0, 0.2, 0.005, 0.26, 0.22, 0.2, g);
    for (const sx of [-1, 1]) { put('sphere', sx * 0.06, 0.21, 0.085, 0.07, 0.09, 0.03, 0x0b0b12); put('capsule', sx * 0.06, 0.36, 0, 0.012, 0.09, 0.012, g); put('sphere', sx * 0.06, 0.41, 0, 0.03, 0.03, 0.03, 0xffe14a); }
    return 0.26 * s;
  }
  put('sphere', 0, 0.1, 0, 0.2, 0.21, 0.17, col); put('sphere', 0, 0.245, 0.01, 0.17, 0.15, 0.15, col);
  for (const sx of [-1, 1]) {
    if (kind === 0) put('sphere', sx * 0.065, 0.315, 0, 0.06, 0.06, 0.04, col);            // bear ears
    else if (kind === 1) put('capsule', sx * 0.04, 0.38, 0, 0.045, 0.2, 0.03, col);         // bunny ears
    else put('cone', sx * 0.06, 0.33, 0, 0.06, 0.07, 0.05, col);                             // cat ears
    put('sphere', sx * 0.035, 0.26, 0.075, 0.022, 0.022, 0.015, 0x151018);                   // eyes
    put('sphere', sx * 0.112, 0.11, 0.02, 0.06, 0.09, 0.06, col);                            // arms
  }
  put('sphere', 0, 0.235, 0.075, 0.07, 0.05, 0.04, 0xfff0dc); put('sphere', 0, 0.245, 0.098, 0.02, 0.015, 0.015, 0x2a1a1a);
  return 0.27 * s;
}
function propBoxToy(kit, cx, y, z, s, r) {
  const w = (0.13 + r() * 0.08) * s, h = (0.2 + r() * 0.1) * s, d = (0.09 + r() * 0.05) * s, col = PROP_PLUSH[(r() * PROP_PLUSH.length) | 0], ry = (r() - 0.5) * 0.5;
  propInst(kit, 'box', cx, y + h / 2, z, w, h, d, col, ry);
  propInst(kit, 'box', cx + Math.sin(ry) * d / 2, y + h * 0.58, z + Math.cos(ry) * d / 2, w * 0.66, h * 0.4, 0.006, 0xcfe8ff, ry);   // window
  propInst(kit, 'box', cx, y + h * 0.9, z, w * 1.02, h * 0.14, d * 1.02, 0xffffff, ry);                                               // top band
  return w + 0.02;
}
function propBalls(kit, cx, y, z, s, r) {   // little pyramid of capsule-toy balls
  const d = 0.1 * s, pts = [[-0.5, 0], [0.5, 0], [0, 0.86]];
  for (const [ox, oy] of pts) {
    const px = cx + ox * d, py = y + d / 2 + oy * d;
    propInst(kit, 'sphere', px, py, z, d, d, d, PROP_PLUSH[(r() * PROP_PLUSH.length) | 0]);
    propInst(kit, 'cyl', px, py, z, d * 1.02, d * 0.08, d * 1.02, 0xffffff);
  }
  return d * 1.2;
}
function propRocket(kit, cx, y, z, s) {
  propInst(kit, 'cyl', cx, y + 0.12 * s, z, 0.07 * s, 0.22 * s, 0.07 * s, 0xf2f2ff);
  propInst(kit, 'cone', cx, y + 0.27 * s, z, 0.07 * s, 0.1 * s, 0.07 * s, 0xff3a4a);
  for (const a of [0, 2.1, 4.2]) propInst(kit, 'box', cx + Math.sin(a) * 0.05 * s, y + 0.04 * s, z + Math.cos(a) * 0.05 * s, 0.012 * s, 0.07 * s, 0.05 * s, 0x2f6bff, a);
  return 0.12 * s;
}
function propTrophy(kit, cx, y, z, s) {
  const gold = 0xffc93c;
  propInst(kit, 'cyl', cx, y + 0.015 * s, z, 0.1 * s, 0.03 * s, 0.1 * s, gold); propInst(kit, 'cyl', cx, y + 0.07 * s, z, 0.025 * s, 0.08 * s, 0.025 * s, gold);
  propInst(kit, 'sphere', cx, y + 0.17 * s, z, 0.12 * s, 0.1 * s, 0.12 * s, gold);
  return 0.14 * s;
}

// Fills the span [x0, x1] of one shelf surface (height y, depth range z0..z1) with a random assortment.
function propStockRow(kit, x0, x1, y, z0, z1, s, r) {
  let x = x0 + 0.14 * s;
  while (x < x1 - 0.14 * s) {
    const pick = r(), z = z0 + r() * (z1 - z0);
    const width = pick < 0.44 ? 0.27 * s : pick < 0.64 ? 0.2 * s : pick < 0.8 ? 0.13 * s : pick < 0.92 ? 0.12 * s : 0.14 * s;
    const cx = x + width / 2;
    if (pick < 0.44) propPlush(kit, cx, y, z, s, r);
    else if (pick < 0.64) propBoxToy(kit, cx, y, z, s, r);
    else if (pick < 0.8) propBalls(kit, cx, y, z, s, r);
    else if (pick < 0.92) propRocket(kit, cx, y, z, s);
    else propTrophy(kit, cx, y, z, s);
    x += width + 0.03 + r() * 0.05;
  }
}

// Turns the collected instance records into 5 InstancedMeshes sharing one warm self-lit material.
function propBuildPrizes(kit) {
  const mat = new THREE.MeshStandardMaterial({ roughness: 0.7, metalness: 0 });
  mat.onBeforeCompile = (sh) => {   // prizes glow softly in warm "spot" light regardless of the room lights
    sh.fragmentShader = sh.fragmentShader.replace('#include <emissivemap_fragment>', '#include <emissivemap_fragment>\n totalEmissiveRadiance += diffuseColor.rgb * vec3(0.62, 0.5, 0.38);');
  };
  mat.customProgramCacheKey = () => 'propPrizeGlow';
  const geos = { sphere: new THREE.SphereGeometry(0.5, 8, 6), box: new THREE.BoxGeometry(1, 1, 1), capsule: new THREE.CapsuleGeometry(0.5, 1, 3, 8),
                 cone: new THREE.ConeGeometry(0.5, 1, 10), cyl: new THREE.CylinderGeometry(0.5, 0.5, 1, 12) };
  const dummy = new THREE.Object3D(), c = new THREE.Color();
  for (const [type, list] of Object.entries(kit.prizes)) {
    if (!list.length) continue;
    const mesh = new THREE.InstancedMesh(geos[type], mat, list.length);
    list.forEach((p, i) => {
      dummy.position.set(p.x, p.y, p.z); dummy.rotation.set(0, p.ry, 0);
      dummy.scale.set(p.sx, type === 'capsule' ? p.sy / 2 : p.sy, p.sz); dummy.updateMatrix();
      mesh.setMatrixAt(i, dummy.matrix); mesh.setColorAt(i, c.set(p.color));
    });
    mesh.matrixAutoUpdate = false;
    scene.add(mesh);
  }
}

// ── Prize counter: display case, register, ticket machine, bell, hanging price signs ──
function propCounter(kit) {
  const { solid, glow, glass, lit, halo, haloBox } = kit, { zFront: zF, zBack: zB } = PROP_COUNTER, zC = (zF + zB) / 2, r = rng(77);
  const wood = 0x1a1122, chrome = 0xb9bfd2, pink = NEON.pink;
  solid.box(9.0, 0.12, 0.7, 0, 0.06, zC, 0x0f0a14);                               // plinth
  glow.box(8.9, 0.018, 0.018, 0, 0.11, zF + 0.05, PROP_WARM, 3.2);                 // warm kick light along the base
  haloBox.plane(9.6, 1.5, 0, 0.012, zF + 0.75, PROP_WARM, 0.5, -Math.PI / 2);      // ... and its pool on the carpet
  solid.box(2.8, 0.83, 0.06, 0, 0.535, zF - 0.03, 0x22162e);                       // solid centre section
  lit.atlasQuad('centerPanel', 2.4, 0.6, 0, 0.55, zF + 0.003, 0, 1.15);
  glow.box(2.5, 0.012, 0.012, 0, 0.24, zF + 0.012, pink, 3);
  glow.box(2.5, 0.012, 0.012, 0, 0.86, zF + 0.012, pink, 3);
  for (const sx of [-1, 1]) {
    solid.box(0.07, 0.83, 0.67, sx * 4.465, 0.535, zC, wood);                      // end panels
    solid.box(0.06, 0.83, 0.66, sx * 1.4, 0.535, zC, chrome, 0.5);                 // dividers
    solid.box(0.04, 0.83, 0.04, sx * 2.93, 0.535, zF - 0.02, chrome, 0.5);         // mid mullion
    const cx = sx * 2.93;                                                          // ── one glass display section (3 m wide)
    glass.plane(3.0, 0.8, cx, 0.535, zF - 0.008);
    haloBox.plane(1.1, 0.5, cx - 0.5 * sx, 0.55, zF + 0.012, 0xffffff, 0.05, 0, 0, 0.3);   // glass reflection streak
    glow.box(3.0, 0.8, 0.01, cx, 0.535, zB + 0.03, 0xffc98a, 0.55);                // warm-lit back panel
    solid.box(3.0, 0.02, 0.5, cx, 0.5, zC + 0.03, 0xe8d6b8, 0.85);                 // shelf
    glow.box(3.0, 0.014, 0.014, cx, 0.925, zF - 0.06, 0xfff1d0, 3.5);              // LED under the top rail
    glow.box(3.0, 0.01, 0.01, cx, 0.485, zF - 0.06, 0xffd9a0, 2.6);                // LED under the shelf
    propStockRow(kit, cx - 1.42, cx + 1.42, 0.13, zB + 0.1, zF - 0.14, 0.75, r);   // bottom row
    propStockRow(kit, cx - 1.42, cx + 1.42, 0.51, zB + 0.1, zF - 0.14, 0.72, r);   // shelf row
  }
  solid.box(9.1, 0.1, 0.78, 0, 1.0, -5.78, 0x1c1224, 1);                           // counter top
  glow.box(9.1, 0.02, 0.02, 0, 1.0, -5.39, pink, 3);                               // pink neon edge

  // register, token scanner, bell, ticket machine, token cups
  solid.box(0.34, 0.09, 0.28, -0.85, 1.095, -5.85, 0xc9c2b0, 0.55);
  solid.box(0.05, 0.14, 0.05, -0.85, 1.18, -5.97, 0x2a2a34);
  lit.atlasQuad('register', 0.22, 0.11, -0.85, 1.25, -5.955, 0, 1.1, -0.3);
  for (let i = 0; i < 4; i++) for (let j = 0; j < 3; j++) solid.box(0.03, 0.012, 0.022, -0.955 + i * 0.07, 1.146, -5.79 - j * 0.03 + 0.03, [0xd4d4dc, 0x6a8cff, 0xff6a6a, 0xffe14a][(i + j) % 4], 0.6);
  solid.box(0.16, 0.05, 0.12, -1.28, 1.075, -5.68, 0x232633); glow.box(0.1, 0.006, 0.012, -1.28, 1.102, -5.632, NEON.green, 3.5);
  solid.cyl(0.075, 0.075, 0.012, -0.32, 1.056, -5.64, 0x9a7a20, 1, 20); solid.sphere(0.055, -0.32, 1.058, -5.64, 0xe0b040, 1.3); solid.cyl(0.012, 0.012, 0.02, -0.32, 1.118, -5.64, 0xf0d060, 1.3);
  lit.atlasQuad('placard', 0.17, 0.085, -0.6, 1.098, -5.53, 0, 1, -0.55);
  solid.box(0.62, 0.52, 0.36, 1.0, 1.31, -5.86, 0x2b1040);                          // ticket-redemption machine
  lit.atlasQuad('ticketFace', 0.56, 0.42, 1.0, 1.31, -5.678, 0, 1.15);
  solid.box(0.66, 0.03, 0.4, 1.0, 1.585, -5.86, 0x12051f);
  [NEON.yellow, NEON.red, NEON.cyan, NEON.pink, NEON.green].forEach((c, i) => glow.box(0.05, 0.03, 0.05, 0.8 + i * 0.1, 1.615, -5.75, c, 3));
  for (let i = 0; i < 12; i++) {                                                   // paper ticket ribbon curling out of the slot
    const s = i / 11, x = 1.0 + 0.16 * Math.sin(s * 5.5), z = -5.66 + 0.24 * s;
    solid.box(0.05, 0.004, 0.034, x, 1.056 + 0.012 * Math.sin(s * 9), z, i % 2 ? 0xffd7a0 : 0xffb59a, 0.9, 0, Math.cos(s * 5.5) * 0.5, 0);
  }
  [[1.95, NEON.pink], [2.13, NEON.cyan], [2.31, NEON.yellow]].forEach(([x, c]) => {   // token cups
    solid.cyl(0.05, 0.036, 0.11, x, 1.105, -5.7, c, 0.8, 14); glow.cyl(0.044, 0.044, 0.004, x, 1.158, -5.7, 0xffd24a, 1.6, 14);
  });
  // hanging light-box price signs (wires up to the ceiling)
  [[-3.5, 'price1'], [3.5, 'price2']].forEach(([x, cell]) => {
    solid.box(0.94, 0.6, 0.04, x, 2.22, -5.86, 0x0d0a14);
    lit.atlasQuad(cell, 0.9, 0.56, x, 2.22, -5.838, 0, 0.9);
    for (const dx of [-0.32, 0.32]) solid.box(0.008, 1.48, 0.008, x + dx, 3.26, -5.86, 0x1a1a22);
    halo.plane(1.5, 1.1, x, 2.22, -5.8, cell === 'price1' ? NEON.pink : NEON.cyan, 0.16);
  });
  addCollider(-4.95, 4.95, -7, -5.36);
  registry.props.push({ kind: 'prize', x: 0, z: -6.0, y: 1.2, color: PROP_WARM }, { kind: 'prize', x: 1.0, z: -5.86, y: 1.4, color: NEON.yellow });
}

// ── Prize shelves on the north wall behind the counter ──
function propShelves(kit) {
  const { solid, glow, halo } = kit, r = rng(2024), depth = 0.42;
  solid.box(8.9, 1.32, 0.03, 0, 1.75, -6.985, 0x1a0d0a);                            // back board
  solid.box(8.9, 0.04, depth + 0.1, 0, 2.38, -7 + (depth + 0.1) / 2, 0x1a0f12);      // header under the sign
  for (let i = 0; i < 9; i++) solid.box(0.05, 1.32, depth, -4.4 + i * 1.1, 1.75, -7 + depth / 2, 0x2c1a12);   // uprights
  for (const y of [1.14, 1.57, 2.0]) {
    solid.box(8.9, 0.03, depth, 0, y - 0.015, -7 + depth / 2, 0x3a2418);
    glow.box(8.8, 0.012, 0.012, 0, y + 0.395, -6.6, PROP_WARM, 3);                  // LED under the shelf above
    propStockRow(kit, -4.4, 4.4, y, -6.93, -6.68, 1.0, r);
  }
  for (let i = 0; i < 8; i++) {                                                    // spot cans with warm pools on the back board
    const x = -3.85 + i * 1.1;
    solid.cyl(0.04, 0.055, 0.09, x, 2.31, -6.62, 0x0a0a0e, 1, 12); glow.cyl(0.036, 0.036, 0.005, x, 2.262, -6.62, 0xffe0b0, 4, 12);
    halo.plane(1.5, 1.7, x, 1.7, -6.975, PROP_WARM, 0.65);
  }
  for (const sx of [-1, 1]) solid.box(0.05, 1.32, depth, sx * 4.47, 1.75, -7 + depth / 2, 0x2c1a12);
}

// ── Big ARCADE neon sign above the counter (with one letter that occasionally flickers) ──
function propArcadeSign(kit) {
  const { solid, glow, halo, haloBox } = kit, W = 2048, H = 512, PX = 2048 / 5.4;         // canvas px per metre
  const letterH = 290, letterX = 185, letterY = 62;
  const colors = [NEON.pink, NEON.cyan, NEON.pink, NEON.cyan, NEON.pink, NEON.cyan], FLICK = 2;   // flickering letter = 'C'
  const style = { tube: 40, gap: 92, style: 'double' };
  let rects;
  const paintMain = (ctx) => {
    ctx.fillStyle = '#000'; ctx.fillRect(0, 0, W, H);
    rects = propNeonText(ctx, 'ARCADE', letterX, letterY, letterH, colors, { ...style, skip: FLICK });
    const border = new Path2D(); border.roundRect(30, 26, W - 60, H - 52, 46);
    propNeonRaw(ctx, border, NEON.purple, 14);
    const under = new Path2D(); under.moveTo(220, 432); under.lineTo(W - 220, 432);
    propNeonRaw(ctx, under, NEON.yellow, 14);
    for (const x of [96, W - 96]) propNeonIcon(ctx, 'star', x - 28, 232, 56, NEON.yellow, 9);
  };
  const mainTex = propPainted(W, H, paintMain, { anisotropy: 8 });
  const addMat = (map, k) => new THREE.MeshBasicMaterial({ map, color: new THREE.Color(k, k, k), transparent: true, blending: THREE.AdditiveBlending, depthWrite: false });
  const zSign = -6.9;
  solid.box(5.5, 1.36, 0.06, 0, 3.06, zSign, 0x0a0710);                             // dark backing board with metal edge
  for (const [w, h, x, y] of [[5.56, 0.03, 0, 3.75], [5.56, 0.03, 0, 2.37], [0.03, 1.4, -2.765, 3.06], [0.03, 1.4, 2.765, 3.06]]) solid.box(w, h, 0.08, x, y, zSign + 0.005, 0x5a5f78, 0.8);
  const sign = new THREE.Mesh(new THREE.PlaneGeometry(5.4, 1.35), addMat(mainTex, 1.5));
  sign.position.set(0, 3.06, zSign + 0.034); scene.add(sign);
  // marquee bulbs along the frame (static emissive, alternating warm white / pink)
  let bulbs = 0;
  const bulb = (x, y) => glow.add(new THREE.SphereGeometry(0.02, 6, 4), x, y, zSign + 0.05, bulbs++ % 2 ? 0xffe9b0 : NEON.pink, 3.2);
  for (let x = -2.765; x <= 2.77; x += 0.17) { bulb(x, 3.75); bulb(x, 2.37); }
  for (let y = 2.54; y < 3.7; y += 0.17) { bulb(-2.765, y); bulb(2.765, y); }
  // flickering letter on its own plane: same glyph, drawn on a padded canvas and placed exactly over the main sign
  const P = 70, fr = rects[FLICK];
  const flickTex = propPainted(Math.ceil(fr.w + 2 * P), letterH + 2 * P, (ctx, w, h) => propNeonText(ctx, 'C', P, P, letterH, [colors[FLICK]], style), { anisotropy: 8 });
  const flick = new THREE.Mesh(new THREE.PlaneGeometry((fr.w + 2 * P) / PX, (letterH + 2 * P) / PX), addMat(flickTex, 1.5));
  flick.position.set((fr.x + fr.w / 2 - W / 2) / PX, 3.06 + (H / 2 - (fr.y + letterH / 2)) / PX, zSign + 0.036); scene.add(flick);
  // halos behind the board (only their outer rim shows) and a wash on the wall
  rects.forEach((rc, i) => halo.plane(1.5, 1.4, (rc.x + rc.w / 2 - W / 2) / PX, 3.06, zSign - 0.02, colors[i], 0.55));
  haloBox.plane(7.6, 2.8, 0, 3.06, zSign - 0.022, NEON.purple, 0.4);
  haloBox.plane(6.4, 2.2, 0, 3.06, zSign - 0.024, NEON.pink, 0.24);
  // rare, event-driven flicker: a burst of quick on/off steps every 8-16 s
  const rnd = rng(9), steps = [0.07, 0.05, 0.06, 0.16, 0.22, 0.06, 0.05], mat = flick.material;
  let next = 7, start = -1;
  kit.tickers.push((t) => {
    if (t < next) return;
    if (start < 0) start = t;
    const e = t - start;
    let acc = 0, idx = 0;
    while (idx < steps.length && e > acc + steps[idx]) { acc += steps[idx]; idx++; }
    if (idx >= steps.length) { mat.color.setScalar(1.5); start = -1; next = t + 8 + rnd() * 8; return; }
    mat.color.setScalar(idx % 2 === 0 ? 0.08 : 1.5);
  });
  registry.props.push({ kind: 'sign', name: 'arcade', x: 0, z: zSign, y: 3.06, color: NEON.pink });
}

// ── Corner machines: drink vending, token/change machine, trash bin, fire extinguisher ──
function propVending(kit, x, theme) {
  const { solid, glow, haloBox } = kit, z = -7 + 0.425;
  solid.box(0.95, 1.85, 0.85, x, 0.925, z, theme.body); solid.box(0.99, 0.03, 0.89, x, 1.865, z, 0x0a0a10);
  const tex = propPainted(512, 1024, (c, w, h) => propDrawVending(c, w, h, theme), { anisotropy: 8 });
  propPanelMesh(tex, 0.88, 1.72, x, 0.93, -6.146);
  for (const s of [-1, 1]) glow.box(0.012, 1.74, 0.012, x + s * 0.465, 0.93, -6.14, theme.accent, 3);
  haloBox.plane(1.8, 1.4, x, 0.012, -5.45, theme.accent, 0.42, -Math.PI / 2);
  addCollider(x - 0.48, x + 0.48, -7, -6.12);
  registry.props.push({ kind: 'vending', x, z: -6.3, y: 1.0, color: theme.accent });
}
function propChange(kit, x) {
  const { solid, glow, haloBox } = kit, z = -7 + 0.275;
  solid.box(0.7, 1.55, 0.55, x, 0.775, z, 0x2f3345); solid.box(0.66, 0.05, 0.5, x, 1.575, z, 0x14151d);
  if (!kit.changeTex) kit.changeTex = propPainted(256, 576, propDrawChange, { anisotropy: 8 });
  propPanelMesh(kit.changeTex, 0.62, 1.395, x, 0.79, -6.446);
  solid.box(0.4, 0.025, 0.09, x, 0.3, -6.42, 0xa0a6b8, 0.9);                        // token tray lip
  glow.box(0.5, 0.05, 0.01, x, 1.61, -6.46, NEON.yellow, 2.2);                      // "CHANGE" topper light
  haloBox.plane(1.2, 1.0, x, 0.012, -5.9, PROP_WARM, 0.4, -Math.PI / 2);
  addCollider(x - 0.37, x + 0.37, -7, -6.42);
  registry.props.push({ kind: 'change', x, z: -6.6, y: 1.0, color: NEON.yellow });
}
function propTrash(kit, x, z) {
  const { solid, print } = kit;
  solid.cyl(0.21, 0.18, 0.72, x, 0.36, z, 0x3b4152, 0.9, 20); solid.cyl(0.228, 0.228, 0.05, x, 0.745, z, 0x596077, 1, 20);
  solid.box(0.22, 0.09, 0.02, x, 0.62, z + 0.2, 0x0a0a0e, 1, 0, 0, 0);
  print.atlasQuad('st1', 0.1, 0.1, x + 0.1, 0.4, z + 0.192);
  addCollider(x - 0.24, x + 0.24, z - 0.24, z + 0.24);
}
function propExtinguisher(kit, x) {
  const { solid, print } = kit;
  solid.cyl(0.065, 0.065, 0.4, x, 1.15, -6.9, 0xd41f2c, 1.1, 16); solid.cyl(0.028, 0.034, 0.06, x, 1.38, -6.9, 0x1a1a1a, 1, 12);
  solid.box(0.08, 0.03, 0.05, x, 1.42, -6.88, 0x1a1a1a); solid.box(0.15, 0.04, 0.05, x, 1.25, -6.94, 0x111114);
  solid.box(0.012, 0.3, 0.012, x + 0.085, 1.2, -6.86, 0x1a1a1a);
  print.atlasQuad('ext', 0.22, 0.22, x, 1.78, -6.97);
}
function propCornerMachines(kit) {
  propVending(kit, -9.2, PROP_VENDING[0]); propChange(kit, -7.9); propTrash(kit, -7.0, -6.6); propExtinguisher(kit, -6.62);
  propVending(kit, 7.9, PROP_VENDING[1]); propChange(kit, 9.15); propTrash(kit, 6.95, -6.55);
}

// ── Staff-only rope barriers at the counter ends ──
function propStanchions(kit) {
  const { solid, print } = kit;
  for (const sx of [-1, 1]) {
    const x = sx * 4.85, posts = [[x, -5.58], [x, -6.7]];
    for (const [px, pz] of posts) {
      solid.cyl(0.17, 0.17, 0.03, px, 0.015, pz, 0xb9bfd2, 0.9, 20); solid.cyl(0.024, 0.024, 0.93, px, 0.49, pz, 0xd8dcea, 1, 12); solid.sphere(0.045, px, 0.97, pz, 0xd8dcea, 1);
    }
    const curve = new THREE.CatmullRomCurve3([new THREE.Vector3(x, 0.94, posts[0][1]), new THREE.Vector3(x, 0.84, (posts[0][1] + posts[1][1]) / 2), new THREE.Vector3(x, 0.94, posts[1][1])]);
    solid.add(new THREE.TubeGeometry(curve, 12, 0.016, 6, false), 0, 0, 0, 0x9c1030, 1);
    print.atlasQuad('staff', 0.3, 0.15, x, 0.66, (posts[0][1] + posts[1][1]) / 2, sx > 0 ? Math.PI / 2 : -Math.PI / 2);
  }
}

// ── High-score scoreboard: 96 x 32 LED grid rendered as round dots by a tiny shader ──
function propScoreboard(kit) {
  const { solid, haloBox } = kit, W = 96, H = 32, sp = propWallSpot('W', 0, 0.06);
  const { canvas, ctx } = makeCanvas(W, H);
  const tex = canvasTexture(canvas, { anisotropy: 1 });
  tex.magFilter = tex.minFilter = THREE.NearestFilter; tex.generateMipmaps = false;
  const mat = new THREE.ShaderMaterial({
    uniforms: { map: { value: tex }, grid: { value: new THREE.Vector2(W, H) }, gain: { value: 1.6 } },
    vertexShader: 'varying vec2 vUv; void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }',
    fragmentShader: `uniform sampler2D map; uniform vec2 grid; uniform float gain; varying vec2 vUv;
      void main() {
        vec2 c = vUv * grid;
        vec3 col = texture2D(map, (floor(c) + 0.5) / grid).rgb;
        float m = smoothstep(0.5, 0.3, length(fract(c) - 0.5));
        m = mix(m, 0.6, smoothstep(0.35, 0.9, fwidth(c.x)));      // fade to an average when the dots get sub-pixel
        gl_FragColor = vec4(col * m * gain + vec3(0.01, 0.004, 0.003), 1.0);
      }`,
  });
  const y = 2.68, x = sp.x + 0.03;
  solid.box(0.1, 0.58, 1.6, -9.95, y, 0, 0x0c0a12); solid.box(0.12, 0.03, 1.66, -9.95, y + 0.3, 0, 0x5a5f78, 0.8); solid.box(0.12, 0.03, 1.66, -9.95, y - 0.3, 0, 0x5a5f78, 0.8);
  const mesh = new THREE.Mesh(new THREE.PlaneGeometry(1.5, 0.47), mat);
  mesh.position.set(-9.895, y, 0); mesh.rotation.y = Math.PI / 2; scene.add(mesh);
  haloBox.plane(2.6, 1.1, x - 0.02, y, 0, PROP_WARM, 0.2, 0, Math.PI / 2);
  // content: title, scrolling ticker of scores, blinking prompt; redrawn ~12x/s only while the player is near and facing it
  const tokenW = 12 * 6, loop = PROP_SCORES.length * (tokenW + 24);
  let last = -1;
  const draw = (t) => {
    ctx.fillStyle = '#000'; ctx.fillRect(0, 0, W, H);
    propDotText(ctx, 'HIGH SCORES', 15, 2, 1, '#ffc93a');
    ctx.fillStyle = '#5a3a08'; ctx.fillRect(4, 10, 88, 1); ctx.fillRect(4, 22, 88, 1);
    const scroll = (t * 16) % loop;
    for (let i = 0; i < PROP_SCORES.length; i++) {
      for (let wrap = 0; wrap <= loop; wrap += loop) {
        const px = Math.round(i * (tokenW + 24) - scroll + wrap);
        if (px > -tokenW && px < W) propDotText(ctx, PROP_SCORES[i], px, 13, 1, PROP_SCORE_COLORS[i]);
      }
    }
    if (Math.floor(t * 1.5) % 2 === 0) propDotText(ctx, 'INSERT COIN', 15, 24, 1, '#ff3a4a');
    tex.needsUpdate = true;
  };
  draw(0);
  kit.tickers.push((t) => {
    if (t - last < 0.083) return;
    const dx = -9.9 - player.x, dz = -player.z;
    if (dx * dx + dz * dz > 196 || -Math.sin(player.yaw) * dx - Math.cos(player.yaw) * dz < 0) return;   // far away or behind the camera
    last = t; draw(t);
  });
  registry.props.push({ kind: 'scoreboard', x: -9.9, z: 0, y: y, color: NEON.yellow });
}

// ── Posters, neon accents, EXIT sign, wall clock ──
function propPoster(kit, cell, wall, along, yc, w, frameIdx) {
  const { solid, print } = kit, c = print.atlas.cells.get(cell), h = w * c.h / c.w, sp = propWallSpot(wall, along, 0.09), t = 0.035, fc = PROP_FRAMES[frameIdx % PROP_FRAMES.length];
  print.atlasQuad(cell, w, h, sp.x, yc, sp.z, sp.ry);
  const frame = (bw, bh, bx, by, bz, d) => { const g = new THREE.BoxGeometry(bw, bh, d); g.translate(bx, by, bz); solid.add(g, sp.x, yc, sp.z, fc, 1, 0, sp.ry, 0); };
  frame(w + 2 * t, t, 0, (h + t) / 2, -0.004, 0.05); frame(w + 2 * t, t, 0, -(h + t) / 2, -0.004, 0.05);
  frame(t, h, -(w + t) / 2, 0, -0.004, 0.05); frame(t, h, (w + t) / 2, 0, -0.004, 0.05);
  frame(w, h, 0, 0, -0.03, 0.02);
}
function propNeonSign(kit, cell, wall, along, yc, w, color, k = 1.25) {
  const { neon, halo, haloBox } = kit, c = neon.atlas.cells.get(cell), h = w * c.h / c.w, sp = propWallSpot(wall, along, 0.08);
  neon.atlasQuad(cell, w, h, sp.x, yc, sp.z, sp.ry, k);
  const hs = propWallSpot(wall, along, 0.07);
  (c.w === c.h ? halo : haloBox).plane(w * 1.4, h * 1.6, hs.x, yc, hs.z, color, 0.3, 0, sp.ry, 0);
  if (c.w !== c.h) registry.props.push({ kind: 'sign', name: cell, x: sp.x, z: sp.z, y: yc, color });   // words hum, icons don't
}
function propExitSign(kit) {
  const { solid, lit, halo, haloBox } = kit, sp = propWallSpot('S', 0, 0.05);
  solid.box(1.66, 0.54, 0.08, 0, 2.9, sp.z, 0x0c1a12);
  lit.atlasQuad('exit', 1.6, 0.5, 0, 2.9, sp.z - 0.042, Math.PI, 1.25);
  haloBox.plane(3.2, 1.5, 0, 2.9, sp.z - 0.012, NEON.green, 0.4, 0, Math.PI, 0);
  halo.plane(3.6, 2.6, 0, 0.012, 6.0, NEON.green, 0.1, -Math.PI / 2);
  registry.props.push({ kind: 'sign', name: 'exit', x: 0, z: 6.95, y: 2.9, color: NEON.green });
}
function propClock(kit, wall, along, y) {
  const { solid } = kit, sp = propWallSpot(wall, along, 0.058), ring = propWallSpot(wall, along, 0.03), size = 160;
  const { canvas, ctx } = makeCanvas(size, size);
  const tex = canvasTexture(canvas, { anisotropy: 4 });
  const draw = () => {
    const d = new Date(), s = d.getSeconds(), m = d.getMinutes() + s / 60, hr = (d.getHours() % 12) + m / 60, c = size / 2;
    ctx.fillStyle = '#f0e8d4'; ctx.beginPath(); ctx.arc(c, c, c, 0, 7); ctx.fill();
    ctx.strokeStyle = '#1a1a22'; ctx.lineCap = 'round';
    for (let i = 0; i < 12; i++) { const a = i * Math.PI / 6; ctx.lineWidth = i % 3 ? 3 : 6; ctx.beginPath(); ctx.moveTo(c + Math.sin(a) * 62, c - Math.cos(a) * 62); ctx.lineTo(c + Math.sin(a) * 72, c - Math.cos(a) * 72); ctx.stroke(); }
    const hand = (a, len, lw, col) => { ctx.strokeStyle = col; ctx.lineWidth = lw; ctx.beginPath(); ctx.moveTo(c, c); ctx.lineTo(c + Math.sin(a) * len, c - Math.cos(a) * len); ctx.stroke(); };
    hand(hr / 12 * 6.2832, 38, 7, '#1a1a22'); hand(m / 60 * 6.2832, 58, 5, '#1a1a22'); hand(s / 60 * 6.2832, 64, 2, '#d61f2c');
    tex.needsUpdate = true;
  };
  draw();
  const mat = new THREE.MeshStandardMaterial({ map: tex, emissiveMap: tex, emissive: 0xffffff, emissiveIntensity: 0.5, roughness: 0.5 });
  const face = new THREE.Mesh(new THREE.CircleGeometry(0.21, 32), mat);
  face.position.set(sp.x, y, sp.z); face.rotation.y = sp.ry; scene.add(face);
  solid.cyl(0.235, 0.235, 0.05, ring.x, y, ring.z, 0x14141c, 1, 32, Math.PI / 2, ring.ry, 0);
  let sec = -1;
  kit.tickers.push(() => { const now = Math.floor(Date.now() / 1000); if (now !== sec) { sec = now; draw(); } });
}

function propWallDecor(kit) {
  // [cell, wall, along, y centre, width, frame]
  const posters = [
    ['p2', 'N', -9.15, 2.9, 0.72, 0], ['p1', 'N', -7.75, 2.9, 0.72, 2], ['p6', 'N', 7.75, 2.9, 0.72, 1], ['p0', 'N', 9.15, 2.9, 0.72, 0],
    ['p3', 'W', -3.7, 2.85, 0.72, 0], ['p4', 'W', 3.7, 2.85, 0.72, 3], ['p5', 'W', -5.9, 2.75, 0.8, 2], ['p7', 'W', 5.9, 2.75, 0.8, 1],
    ['score', 'W', 2.1, 2.7, 1.0, 0], ['notice', 'W', -2.1, 2.7, 0.8, 3],
    ['p1', 'E', -6.0, 2.75, 0.8, 1], ['p4', 'E', -3.3, 2.85, 0.72, 0], ['p2', 'E', 2.5, 2.85, 0.72, 2], ['p6', 'E', 4.7, 2.75, 0.8, 3], ['p3', 'E', 6.1, 2.85, 0.72, 0],
    ['p0', 'S', -6.8, 2.95, 0.72, 3], ['p5', 'S', -5.1, 2.95, 0.72, 0], ['p7', 'S', 5.3, 2.95, 0.72, 2], ['p2', 'S', 7.0, 2.95, 0.72, 1],
  ];
  posters.forEach((p) => propPoster(kit, ...p));
  propNeonSign(kit, 'prizes', 'N', -4.4, 3.05, 1.7, NEON.yellow); propNeonSign(kit, 'tokens', 'N', 4.4, 3.05, 1.7, NEON.cyan);   // between the pilasters (+-5.5) and the bolt/star icons
  propNeonSign(kit, 'bolt', 'N', -3.35, 3.05, 0.55, NEON.cyan); propNeonSign(kit, 'star', 'N', 3.35, 3.05, 0.55, NEON.yellow);
  propNeonSign(kit, 'insert', 'E', -0.6, 3.05, 2.6, NEON.pink); propNeonSign(kit, 'joystick', 'E', 1.55, 3.05, 0.55, NEON.pink);
  propNeonSign(kit, 'joystick', 'S', -3.2, 3.0, 0.5, NEON.pink); propNeonSign(kit, 'star', 'S', 3.2, 3.0, 0.5, NEON.yellow);
  propExitSign(kit);
  propClock(kit, 'W', 4.75, 2.9);
}

// ── Floor clutter: cables, gaffer tape, warning line, a lost token, a dropped ticket ──
function propClutter(kit) {
  const { solid, glow, print } = kit;
  const cable = (pts) => solid.add(new THREE.TubeGeometry(new THREE.CatmullRomCurve3(pts.map(([x, y, z]) => new THREE.Vector3(x, y, z))), 40, 0.011, 5, false), 0, 0, 0, 0x0b0b0e, 1);
  cable([[-4.95, 0.012, -6.3], [-5.4, 0.012, -6.62], [-5.9, 0.012, -6.4], [-6.3, 0.012, -6.85], [-6.3, 0.3, -6.97]]);
  cable([[-4.95, 0.012, -6.2], [-5.5, 0.012, -6.45], [-5.95, 0.012, -6.25], [-6.4, 0.012, -6.8], [-6.4, 0.3, -6.97]]);
  cable([[4.95, 0.012, -6.1], [5.5, 0.012, -6.5], [6.0, 0.012, -6.3], [6.6, 0.012, -6.85], [6.6, 0.3, -6.97]]);
  cable([[-8.7, 0.012, -6.2], [-8.3, 0.012, -5.85], [-7.8, 0.012, -6.05], [-7.5, 0.012, -6.4]]);
  for (const [x, z, ry] of [[-5.6, -6.55, 0.5], [5.55, -6.4, -0.4], [-8.25, -5.9, 0.9]]) solid.box(0.075, 0.004, 0.2, x, 0.006, z, 0xc9a400, 0.7, 0, ry, 0);   // gaffer tape patches
  glow.cyl(0.016, 0.016, 0.004, -1.1, 0.004, -4.0, 0xffc933, 1.6, 12);              // a lost token
  solid.box(0.05, 0.003, 0.14, 0.6, 0.004, -4.3, 0xffd7a0, 0.8, 0, 0.7, 0);          // dropped ticket
  print.atlasQuad('st4', 0.09, 0.09, -0.4, 1.053, -5.47, 0, 1, -Math.PI / 2);          // sticker lying on the counter top
  print.atlasQuad('st2', 0.08, 0.08, 4.505, 0.6, -5.8, Math.PI / 2);                   // stickers on the counter ends
  print.atlasQuad('st5', 0.08, 0.08, -4.505, 0.5, -5.75, -Math.PI / 2);
  // warning-tape queue line in front of the counter
  const tapeTex = propPainted(128, 32, (c, w, h) => propHazard(c, 0, 0, w, h, 16, '#e8b800', '#141414'), { repeat: [52, 1], anisotropy: 8 });
  const tape = new THREE.Mesh(new THREE.PlaneGeometry(8.4, 0.09), new THREE.MeshStandardMaterial({ map: tapeTex, roughness: 0.7, emissive: 0xe8b800, emissiveMap: tapeTex, emissiveIntensity: 0.18 }));
  tape.rotation.x = -Math.PI / 2; tape.position.set(0, 0.006, -4.55); scene.add(tape);
}

function buildProps() {
  const kit = propMakeKit();
  propCounter(kit);
  propShelves(kit);
  propArcadeSign(kit);
  propCornerMachines(kit);
  propStanchions(kit);
  propScoreboard(kit);
  propWallDecor(kit);
  propClutter(kit);
  propBuildPrizes(kit);
  for (const b of [kit.solid, kit.glow, kit.print, kit.lit]) b.build();
  kit.glass.build(1);
  for (const b of [kit.halo, kit.haloBox, kit.neon]) b.build(2);
  const tickers = kit.tickers;
  onUpdate((t) => { for (let i = 0; i < tickers.length; i++) tickers[i](t); });
}
