// ═══════════════ ROOM SHELL: carpet, wall panels, ceiling structure, entrance, neon architecture ═══════════════
// Owner: room agent. Entry point: buildRoom().  Runs after buildLighting() and before every other builder.
//
// What lives here (all procedural, no external files):
//   floor      space-age confetti carpet (map + emissive + pile bump/roughness), a wear/stain overlay,
//              a black-and-white vinyl threshold with a doormat by the entrance
//   walls      dark panel wall texture (seams, wainscot flutes, scuffs), baseboard, chair rail, cornice,
//              corner posts, conduits, vents, two structural pilasters on the north wall
//   ceiling    black corrugated deck, steel truss grid, round/rectangular ducts, pipes, cable trays,
//              an acoustic-tile soffit over the entrance and mount plates for spot cans
//   neon       every glowing bar lives in ONE merged vertex-coloured mesh; soft "light spill" quads are
//              merged into ONE additive mesh (halo) so the neon appears to wash the wall, floor and ceiling
//   entrance   double glass doors in the south wall with a night-street backdrop and light spill
//
// Public API for other parts (top-level constants, valid as soon as the module has evaluated):
//   ROOM_SPOT_MOUNTS  [{x,y,z}]  truss crossings with a mount plate: hang spot cans from these (y = underside of the truss)
//   ROOM_DOOR         {x,z,halfW,h}  the entrance opening in the south wall
//   ROOM_DROP         {z0,y}    the tiled soffit covers z in [z0, 7] at height y (ceiling is lower there)
//   ROOM_TRIM_Y       {cove,line,base}  heights of the neon lines, for props that want to align with them
//@@import import * as roomGeo from 'three/addons/utils/BufferGeometryUtils.js';

// ── Layout constants ──
const ROOM_WALL_TILE = 4;                         // the wall texture covers 4 m x 4 m
const ROOM_CARPET_TILE = 3;                       // one carpet tile per 3 m
const ROOM_DECK_TILE = 2;                         // ceiling deck texture covers 2 m x 2 m
const ROOM_DOOR = { x: 0, z: 7, halfW: 1.6, h: 2.5 };
const ROOM_DROP = { z0: 4.4, y: 3.62 };           // acoustic soffit along the entrance wall
const ROOM_TRIM_Y = { base: 0.19, line: 3.2, cove: 3.8 };
const ROOM_TRUSS = { y: 3.78, halfW: 0.15, halfH: 0.14, x: [-7.5, -2.5, 2.5, 7.5], z: [-3.5, 0, 3.5] };
const ROOM_SPOT_MOUNTS = ROOM_TRUSS.z.flatMap((z) => ROOM_TRUSS.x.map((x) => ({ x, y: ROOM_TRUSS.y - ROOM_TRUSS.halfH, z })));
const ROOM_PILASTER_X = [-5.5, 5.5];              // wall-hugging columns on the north wall (outside every reserved zone)
const ROOM_NEON_LEVEL = { line: 3.4, cove: 2.8, base: 2.6, corner: 3.4, accent: 3.0 };   // emissive HDR multipliers (bloom)
const ROOM_CARPET_GLOW = 0.55;                    // blacklight strength of the confetti

const _roomDummy = new THREE.Object3D();          // scratch object for orienting struts (build time only)

// ══════════════════════════ small helpers ══════════════════════════

function roomAnisotropy() { return Math.min(16, renderer.capabilities.getMaxAnisotropy()); }

// Fast xorshift32 stream of bytes for per-pixel noise (rng() closures are too slow for millions of pixels).
function roomByteNoise(seed) {
  let x = (seed * 2654435761) >>> 0 || 1;
  return () => { x ^= x << 13; x >>>= 0; x ^= x >>> 17; x ^= x << 5; x >>>= 0; return x & 255; };
}

// Adds fine grain (paint / pile speckle) by tiling a small random-alpha noise pattern over the canvas.
function roomGrain(ctx, w, h, amp, seed) {
  const n = 128, tile = makeCanvas(n, n), img = tile.ctx.createImageData(n, n), d = img.data, next = roomByteNoise(seed);
  for (let i = 0; i < d.length; i += 4) {
    const v = next(), light = v & 1;
    d[i] = d[i + 1] = d[i + 2] = light ? 255 : 0;
    d[i + 3] = (next() / 255) * amp * 1.6;
  }
  tile.ctx.putImageData(img, 0, 0);
  ctx.fillStyle = ctx.createPattern(tile.canvas, 'repeat');
  ctx.fillRect(0, 0, w, h);
}

// Calls draw(ctx) once, plus wrapped copies when a shape of radius r at (x,y) crosses a tile edge (tileable art).
function roomDrawWrapped(ctx, size, x, y, r, draw) {
  const xs = [0], ys = [0];
  if (x - r < 0) xs.push(size); if (x + r > size) xs.push(-size);
  if (y - r < 0) ys.push(size); if (y + r > size) ys.push(-size);
  for (const ox of xs) for (const oy of ys) { ctx.save(); ctx.translate(ox, oy); draw(ctx); ctx.restore(); }
}

const roomCss = (hex, a = 1) => `rgba(${(hex >> 16) & 255},${(hex >> 8) & 255},${hex & 255},${a})`;

// ══════════════════════════ geometry builders (collect, then merge) ══════════════════════════

function roomBox(out, sx, sy, sz, x, y, z) {
  const g = new THREE.BoxGeometry(sx, sy, sz);
  g.translate(x, y, z);
  out.push(g);
}

// Cylinder along axis 'x' | 'y' | 'z', centred on (x,y,z).
function roomCyl(out, r, len, axis, x, y, z, seg = 14) {
  const g = new THREE.CylinderGeometry(r, r, len, seg, 1);
  if (axis === 'x') g.rotateZ(Math.PI / 2); else if (axis === 'z') g.rotateX(Math.PI / 2);
  g.translate(x, y, z);
  out.push(g);
}

// Square-section bar from a to b (truss members, hangers).
function roomStrut(out, ax, ay, az, bx, by, bz, t) {
  const g = new THREE.BoxGeometry(t, t, Math.hypot(bx - ax, by - ay, bz - az));
  _roomDummy.position.set((ax + bx) / 2, (ay + by) / 2, (az + bz) / 2);
  _roomDummy.lookAt(bx, by, bz);
  _roomDummy.updateMatrix();
  g.applyMatrix4(_roomDummy.matrix);
  out.push(g);
}

// A wall rectangle from (ax,az) to (bx,bz) between heights y0..y1 with texture coordinates in wall-tile units.
// Walking a -> b must run clockwise seen from above (north: -x -> +x, east: -z -> +z, south: +x -> -x, west: +z -> -z)
// so the visible face points into the room. `along` = distance from the start of that wall (metres).
function roomWallQuad(out, [ax, az], [bx, bz], y0, y1, along, uShift) {
  const len = Math.hypot(bx - ax, bz - az), T = ROOM_WALL_TILE;
  const nx = -(bz - az) / len, nz = (bx - ax) / len;
  const u0 = (along + uShift) / T, u1 = (along + uShift + len) / T;
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute([ax, y0, az, bx, y0, bz, bx, y1, bz, ax, y1, az], 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute([nx, 0, nz, nx, 0, nz, nx, 0, nz, nx, 0, nz], 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute([u0, y0 / T, u1, y0 / T, u1, y1 / T, u0, y1 / T], 2));
  g.setIndex([0, 1, 2, 0, 2, 3]);
  out.push(g);
}

// Merges a list of geometries into one mesh (one draw call) and adds it to the scene.
function roomFlush(geos, material, { renderOrder = 0 } = {}) {
  if (!geos.length) return null;
  const merged = roomGeo.mergeGeometries(geos, false);
  for (const g of geos) g.dispose();
  const mesh = new THREE.Mesh(merged, material);
  mesh.matrixAutoUpdate = false;
  mesh.renderOrder = renderOrder;
  scene.add(mesh);
  return mesh;
}

// All neon bars share one mesh: vertex colours hold linear HDR colour x intensity (MeshBasicMaterial, unlit).
function roomNeonSet() {
  const geos = [];
  return {
    bar(color, level, sx, sy, sz, x, y, z) {
      const g = new THREE.BoxGeometry(sx, sy, sz);
      g.translate(x, y, z);
      const c = new THREE.Color(color).multiplyScalar(level);
      const n = g.attributes.position.count, arr = new Float32Array(n * 3);
      for (let i = 0; i < n; i++) { arr[i * 3] = c.r; arr[i * 3 + 1] = c.g; arr[i * 3 + 2] = c.b; }
      g.setAttribute('color', new THREE.BufferAttribute(arr, 3));
      geos.push(g);
    },
    flush() {
      return roomFlush(geos, new THREE.MeshBasicMaterial({ vertexColors: true }));
    },
  };
}

// Soft light spill: additive quads whose vertex colours fade to black (no texture needed), merged into one mesh.
function roomHaloSet() {
  const geos = [];
  const FADE = [0, 0.1, 0.25, 0.45, 0.7, 1];                 // ring offsets, as a fraction of the width
  const falloff = (t) => Math.pow(1 - t, 2.2);
  const make = (pos, col, idx) => {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
    g.setIndex(idx);
    geos.push(g);
  };
  return {
    // Band that starts on the line a-b and extends `width` metres along the unit vector dir, fading out.
    strip(color, strength, a, b, dir, width) {
      const c = new THREE.Color(color), pos = [], col = [], idx = [];
      FADE.forEach((t, i) => {
        const k = strength * falloff(t);
        for (const p of [a, b]) {
          pos.push(p[0] + dir[0] * width * t, p[1] + dir[1] * width * t, p[2] + dir[2] * width * t);
          col.push(c.r * k, c.g * k, c.b * k);
        }
        if (i > 0) { const j = (i - 1) * 2; idx.push(j, j + 1, j + 3, j, j + 3, j + 2); }
      });
      make(pos, col, idx);
    },
    // Elliptical puddle of light lying on the floor (or any y), centred at (cx, y, cz).
    pool(color, strength, cx, y, cz, rx, rz, segs = 28) {
      const c = new THREE.Color(color), pos = [cx, y, cz], col = [c.r * strength, c.g * strength, c.b * strength], idx = [];
      const rings = FADE.slice(1);
      rings.forEach((t, ri) => {
        const k = strength * falloff(t);
        for (let s = 0; s < segs; s++) {
          const ang = (s / segs) * Math.PI * 2;
          pos.push(cx + Math.cos(ang) * rx * t, y, cz + Math.sin(ang) * rz * t);
          col.push(c.r * k, c.g * k, c.b * k);
        }
        const base = 1 + ri * segs, prev = 1 + (ri - 1) * segs;
        for (let s = 0; s < segs; s++) {
          const s2 = (s + 1) % segs;
          if (ri === 0) idx.push(0, base + s2, base + s);
          else idx.push(prev + s, prev + s2, base + s2, prev + s, base + s2, base + s);
        }
      });
      make(pos, col, idx);
    },
    flush() {
      const mat = new THREE.MeshBasicMaterial({
        vertexColors: true, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide,
        polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2,
      });
      return roomFlush(geos, mat, { renderOrder: 5 });
    },
  };
}

// ══════════════════════════ textures ══════════════════════════

// ── Carpet: navy base + neon space confetti. Returns { map, emissiveMap, pile } canvas textures. ──
const ROOM_CONFETTI = [0x00e5ff, 0x00e5ff, 0xff2bd6, 0xff2bd6, 0x9b5cff, 0x9b5cff, 0xffe600, 0xff8a1f, 0x39ff88, 0xc9c2ff, 0x2f6bff, 0xff2a3a];
const ROOM_SHAPES = ['squiggle', 'squiggle', 'squiggle', 'triangle', 'triangle', 'ring', 'ring', 'dot', 'dot', 'dot', 'star4', 'star4',
                     'star5', 'planet', 'planet', 'bar', 'bar', 'zigzag', 'zigzag', 'arc', 'cross', 'dots'];

// Draws one confetti shape centred on the origin (context already translated and rotated).
function roomConfettiShape(ctx, kind, rad, lw, ring) {
  ctx.lineWidth = lw; ctx.lineCap = 'round'; ctx.lineJoin = 'round';
  ctx.beginPath();
  switch (kind) {
    case 'squiggle':
      for (let i = 0; i <= 28; i++) { const t = i / 28; ctx.lineTo((t - 0.5) * 2 * rad, Math.sin(t * Math.PI * 3) * rad * 0.3); }
      ctx.stroke(); break;
    case 'triangle':
      for (let i = 0; i < 3; i++) { const a = -Math.PI / 2 + i * Math.PI * 2 / 3; ctx.lineTo(Math.cos(a) * rad * 0.8, Math.sin(a) * rad * 0.8); }
      ctx.closePath(); ctx.stroke(); break;
    case 'ring': ctx.arc(0, 0, rad * 0.55, 0, Math.PI * 2); ctx.stroke(); break;
    case 'dot': ctx.arc(0, 0, rad * 0.32, 0, Math.PI * 2); ctx.fill(); break;
    case 'star4':
      for (let i = 0; i < 8; i++) { const a = i * Math.PI / 4, q = i % 2 ? rad * 0.2 : rad * 0.8; ctx.lineTo(Math.cos(a) * q, Math.sin(a) * q); }
      ctx.closePath(); ctx.fill(); break;
    case 'star5':
      for (let i = 0; i < 10; i++) { const a = -Math.PI / 2 + i * Math.PI / 5, q = i % 2 ? rad * 0.34 : rad * 0.75; ctx.lineTo(Math.cos(a) * q, Math.sin(a) * q); }
      ctx.closePath(); ctx.fill(); break;
    case 'planet': {
      const globe = ctx.fillStyle;
      ctx.strokeStyle = ring; ctx.lineWidth = lw * 0.55;
      ctx.ellipse(0, 0, rad * 1.0, rad * 0.3, -0.45, Math.PI, Math.PI * 2); ctx.stroke();  // back half of the ring
      ctx.fillStyle = globe; ctx.beginPath(); ctx.arc(0, 0, rad * 0.44, 0, Math.PI * 2); ctx.fill();   // globe
      ctx.beginPath(); ctx.ellipse(0, 0, rad * 1.0, rad * 0.3, -0.45, 0, Math.PI); ctx.stroke(); break;   // front half
    }
    case 'bar': ctx.moveTo(-rad * 0.7, 0); ctx.lineTo(rad * 0.7, 0); ctx.stroke(); break;
    case 'zigzag':
      for (let i = 0; i <= 5; i++) ctx.lineTo((i / 5 - 0.5) * 2 * rad * 0.9, (i % 2 ? -1 : 1) * rad * 0.24);
      ctx.stroke(); break;
    case 'arc': ctx.arc(0, 0, rad * 0.7, 0.15 * Math.PI, 1.15 * Math.PI); ctx.stroke(); break;
    case 'cross': ctx.moveTo(-rad * 0.4, 0); ctx.lineTo(rad * 0.4, 0); ctx.moveTo(0, -rad * 0.4); ctx.lineTo(0, rad * 0.4); ctx.stroke(); break;
    default:   // 'dots': a short dotted line
      for (let i = -1; i <= 2; i++) { ctx.moveTo(i * rad * 0.4, 0); ctx.arc(i * rad * 0.4, 0, lw * 0.55, 0, Math.PI * 2); }
      ctx.fill();
  }
}

function roomCarpetTextures() {
  const S = 1024, P = 512, r = rng(1993);
  const col = makeCanvas(S, S), glow = makeCanvas(S, S), pile = makeCanvas(P, P);

  // Base: navy with soft tonal blotches (wrapped, so the tile stays seamless).
  col.ctx.fillStyle = '#0b0c26'; col.ctx.fillRect(0, 0, S, S);
  glow.ctx.fillStyle = '#000'; glow.ctx.fillRect(0, 0, S, S);
  for (let i = 0; i < 70; i++) {
    const x = r() * S, y = r() * S, rad = 60 + r() * 140, light = r() < 0.5;
    roomDrawWrapped(col.ctx, S, x, y, rad, (c) => {
      const g = c.createRadialGradient(x, y, 0, x, y, rad);
      g.addColorStop(0, light ? 'rgba(60,50,120,0.16)' : 'rgba(0,0,10,0.28)'); g.addColorStop(1, 'rgba(0,0,0,0)');
      c.fillStyle = g; c.fillRect(x - rad, y - rad, rad * 2, rad * 2);
    });
  }

  // Confetti by dart-throwing so shapes never overlap; each shape is drawn into the colour and emissive canvases.
  const placed = [];
  for (let attempt = 0; attempt < 9000 && placed.length < 150; attempt++) {
    const kind = ROOM_SHAPES[Math.floor(r() * ROOM_SHAPES.length)];
    const rad = kind === 'dot' ? 12 + r() * 8 : kind === 'dots' ? 30 + r() * 10 : 30 + r() * 26;
    const x = r() * S, y = r() * S;
    const clash = placed.some((p) => {
      const dx = Math.min(Math.abs(p.x - x), S - Math.abs(p.x - x)), dy = Math.min(Math.abs(p.y - y), S - Math.abs(p.y - y));
      return Math.hypot(dx, dy) < (p.rad + rad) * 0.95 + 8;
    });
    if (clash) continue;
    const color = ROOM_CONFETTI[Math.floor(r() * ROOM_CONFETTI.length)], rot = r() * Math.PI * 2, lw = 7 + r() * 4;
    const ringColor = ROOM_CONFETTI[Math.floor(r() * ROOM_CONFETTI.length)];
    placed.push({ x, y, rad });
    const paint = (target, alpha, blur) => roomDrawWrapped(target.ctx, S, x, y, rad, (c) => {
      c.translate(x, y); c.rotate(rot);
      c.strokeStyle = c.fillStyle = roomCss(color, alpha);
      c.shadowColor = roomCss(color, 0.9); c.shadowBlur = blur;
      roomConfettiShape(c, kind, rad, lw, roomCss(ringColor, alpha));
    });
    paint(col, 0.78, 0);
    paint(glow, 0.9, 6);
  }
  roomGrain(col.ctx, S, S, 12, 5);

  // Pile: R = height (tufts + fibre noise), G = roughness (mostly rough).
  const img = pile.ctx.createImageData(P, P), d = img.data, n = P / 4, tufts = new Uint8Array(n * n), next = roomByteNoise(77);
  for (let i = 0; i < tufts.length; i++) tufts[i] = next();
  for (let y = 0; y < P; y++) for (let x = 0; x < P; x++) {
    const i = (y * P + x) * 4;
    d[i] = 70 + (tufts[(y >> 2) * n + (x >> 2)] * 90 + next() * 80) / 255;
    d[i + 1] = 228 + next() * 27 / 255; d[i + 2] = 0; d[i + 3] = 255;
  }
  pile.ctx.putImageData(img, 0, 0);

  const rep = [ROOM.w / ROOM_CARPET_TILE, ROOM.d / ROOM_CARPET_TILE], an = roomAnisotropy();
  return {
    map: canvasTexture(col.canvas, { repeat: rep, anisotropy: an }),
    emissiveMap: canvasTexture(glow.canvas, { repeat: rep, anisotropy: an }),
    pile: canvasTexture(pile.canvas, { srgb: false, repeat: rep, anisotropy: an }),
  };
}

// ── Wear overlay for the whole floor (traffic lanes, stains, gum): black with alpha, 32 px per metre. ──
function roomWearTexture() {
  const PPM = 32, W = ROOM.w * PPM, H = ROOM.d * PPM, r = rng(88);
  const { canvas, ctx } = makeCanvas(W, H);
  const px = (x) => (x + ROOM.w / 2) * PPM, pz = (z) => (z + ROOM.d / 2) * PPM;
  const stamp = (x, y, rad, a) => {
    const g = ctx.createRadialGradient(x, y, 0, x, y, rad);
    g.addColorStop(0, `rgba(0,0,0,${a})`); g.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.fillStyle = g; ctx.fillRect(x - rad, y - rad, rad * 2, rad * 2);
  };
  // Where people actually walk: door -> aisles -> prize counter, the wall rows and the front aisle.
  const lanes = [
    [[0, 7], [0, 4.4], [-3.2, 2.6], [-3.2, -3.6], [-1.6, -4.5]], [[0, 4.4], [3.2, 2.6], [3.2, -3.2], [1.6, -4.5]],
    [[-8, 4.4], [8, 4.4]], [[-7.9, 4.2], [-7.9, -4.2]], [[7.9, 3.8], [7.9, -4.2]], [[-3.2, -4.6], [3.2, -4.6]],
  ];
  for (const lane of lanes) {
    for (let s = 0; s < lane.length - 1; s++) {
      const [a, b] = [lane[s], lane[s + 1]], len = Math.hypot(b[0] - a[0], b[1] - a[1]);
      for (let t = 0; t < len; t += 0.18) {
        const k = t / len, j = (r() - 0.5) * 0.5;
        stamp(px(a[0] + (b[0] - a[0]) * k + j), pz(a[1] + (b[1] - a[1]) * k + j), (0.6 + r() * 0.55) * PPM, 0.14 + r() * 0.07);
      }
    }
  }
  for (let i = 0; i < 26; i++) stamp(r() * W, r() * H, (0.25 + r() * 0.5) * PPM, 0.08 + r() * 0.12);    // spills
  ctx.fillStyle = 'rgba(0,0,0,0.5)';
  for (let i = 0; i < 90; i++) { ctx.beginPath(); ctx.arc(r() * W, r() * H, 0.8 + r() * 1.4, 0, Math.PI * 2); ctx.fill(); }   // gum
  return canvasTexture(canvas, { anisotropy: roomAnisotropy() });
}

// ── Wall panels. Colour map (1024) for 4 m x 4 m plus a height map (512, R = bump, G = roughness). ──
function roomPaintWall(ctx, S, K) {
  const ppm = S / ROOM_WALL_TILE, k = S / 1024, r = rng(2718), Y = (m) => S - m * ppm;
  ctx.fillStyle = K.base; ctx.fillRect(0, 0, S, S);
  // Painted-over unevenness.
  for (let i = 0; i < 20; i++) {
    const x = r() * S, y = r() * S, rad = (50 + r() * 130) * k, g = ctx.createRadialGradient(x, y, 0, x, y, rad);
    g.addColorStop(0, r() < 0.5 ? K.blotchA : K.blotchB); g.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.fillStyle = g; ctx.fillRect(x - rad, y - rad, rad * 2, rad * 2);
  }
  // Wainscot (0 - 1.05 m): darker fluted panelling; chair-rail band above it.
  ctx.fillStyle = K.wain; ctx.fillRect(0, Y(1.05), S, 1.05 * ppm);
  for (let x = 0; x < S; x += 0.09 * ppm) {
    ctx.fillStyle = K.groove; ctx.fillRect(x, Y(1.05), 3.5 * k, 1.05 * ppm);
    ctx.fillStyle = K.flute; ctx.fillRect(x + 3.5 * k, Y(1.05), 2 * k, 1.05 * ppm);
  }
  ctx.fillStyle = K.rail; ctx.fillRect(0, Y(1.13), S, 0.08 * ppm);
  ctx.fillStyle = K.groove; ctx.fillRect(0, Y(1.13), S, 3 * k);
  // Sheet-panel seams every metre with screw heads.
  for (let i = 0; i < 4; i++) {
    const x = i * ppm;
    for (const ox of i === 0 ? [0, S] : [0]) {
      ctx.fillStyle = K.groove; ctx.fillRect(x + ox - 2 * k, Y(4), 4 * k, 2.87 * ppm);
      ctx.fillStyle = K.seamHi; ctx.fillRect(x + ox + 2 * k, Y(4), 1.5 * k, 2.87 * ppm);
      ctx.fillStyle = K.screw;
      for (const m of [1.35, 2.2, 3.05, 3.85]) { ctx.beginPath(); ctx.arc(x + ox + 9 * k, Y(m), 2.6 * k, 0, Math.PI * 2); ctx.fill(); }
    }
  }
  // Horizontal joint of the upper sheets.
  ctx.fillStyle = K.groove; ctx.fillRect(0, Y(2.6), S, 2.5 * k);
  // Rain-streak grime from the ceiling, dirt near the floor.
  for (let i = 0; i < 46; i++) {
    const x = r() * S, len = (0.3 + r() * 1.1) * ppm, w = (4 + r() * 12) * k, g = ctx.createLinearGradient(0, 0, 0, len);
    g.addColorStop(0, K.grime); g.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.save(); ctx.translate(x, 0); ctx.fillStyle = g; ctx.fillRect(0, 0, w, len); ctx.restore();
  }
  const dirt = ctx.createLinearGradient(0, Y(0.9), 0, S);
  dirt.addColorStop(0, 'rgba(0,0,0,0)'); dirt.addColorStop(1, K.dirt);
  ctx.fillStyle = dirt; ctx.fillRect(0, Y(0.9), S, 0.9 * ppm);
  // Scuffs and scratches, mostly low on the wall.
  ctx.lineCap = 'round';
  for (let i = 0; i < 130; i++) {
    const low = r() < 0.75, y = low ? Y(r() * 1.6) : Y(1.6 + r() * 2.2), x = r() * S, len = (12 + r() * 60) * k, a = (r() - 0.5) * 0.7;
    ctx.strokeStyle = K.scuff; ctx.lineWidth = (1.5 + r() * 3.5) * k;
    ctx.beginPath(); ctx.moveTo(x, y); ctx.quadraticCurveTo(x + len / 2, y + a * len * 0.4, x + len, y + a * len); ctx.stroke();
  }
}

function roomWallTextures() {
  const an = roomAnisotropy();
  const colour = makeCanvas(1024, 1024), height = makeCanvas(512, 512);
  roomPaintWall(colour.ctx, 1024, {
    base: '#27213f', wain: '#1b1731', groove: '#0b0918', flute: 'rgba(120,110,170,0.10)', rail: '#3b3558', seamHi: 'rgba(150,140,200,0.10)',
    screw: '#4c4670', grime: 'rgba(0,0,0,0.22)', dirt: 'rgba(0,0,0,0.45)', scuff: 'rgba(190,180,215,0.13)',
    blotchA: 'rgba(90,70,150,0.10)', blotchB: 'rgba(0,0,10,0.16)',
  });
  roomGrain(colour.ctx, 1024, 1024, 10, 6);
  roomPaintWall(height.ctx, 512, {
    base: '#808080', wain: '#808080', groove: '#2a2a2a', flute: '#a8a8a8', rail: '#b0b0b0', seamHi: '#a0a0a0',
    screw: '#c0c0c0', grime: 'rgba(0,0,0,0)', dirt: 'rgba(0,0,0,0)', scuff: 'rgba(220,220,220,0.5)',
    blotchA: 'rgba(150,150,150,0.10)', blotchB: 'rgba(100,100,100,0.10)',
  });
  // Grain + roughness channel (scuffed spots are glossier).
  const img = height.ctx.getImageData(0, 0, 512, 512), d = img.data, next = roomByteNoise(9);
  for (let i = 0; i < d.length; i += 4) {
    const h = d[i] + (next() / 255 - 0.5) * 22; d[i] = h; d[i + 1] = 205 + (h - 128) * 0.3; d[i + 2] = 0;
  }
  height.ctx.putImageData(img, 0, 0);
  const rep = { repeat: [1, 1], anisotropy: an };   // repeat [1,1] just switches on RepeatWrapping; UVs are in wall-tile units
  return { map: canvasTexture(colour.canvas, rep), bump: canvasTexture(height.canvas, { srgb: false, ...rep }) };
}

// ── Ceiling deck: black corrugated steel, ribs along x. One canvas used as colour and bump. ──
function roomDeckTexture() {
  const S = 512, { canvas, ctx } = makeCanvas(S, S), r = rng(31), rib = S / (ROOM_DECK_TILE * 10);   // 10 ribs per metre
  ctx.fillStyle = '#15151d'; ctx.fillRect(0, 0, S, S);
  for (let y = 0; y < S; y += rib) {
    const g = ctx.createLinearGradient(0, y, 0, y + rib);
    g.addColorStop(0, '#08080d'); g.addColorStop(0.35, '#23232e'); g.addColorStop(0.6, '#15151d'); g.addColorStop(1, '#08080d');
    ctx.fillStyle = g; ctx.fillRect(0, y, S, rib);
  }
  for (let i = 0; i < 30; i++) {          // dust and soot
    const x = r() * S, y = r() * S, rad = 30 + r() * 80, g = ctx.createRadialGradient(x, y, 0, x, y, rad);
    g.addColorStop(0, 'rgba(0,0,0,0.25)'); g.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.fillStyle = g; ctx.fillRect(x - rad, y - rad, rad * 2, rad * 2);
  }
  roomGrain(ctx, S, S, 10, 12);
  return canvasTexture(canvas, { repeat: [ROOM.w / ROOM_DECK_TILE, ROOM.d / ROOM_DECK_TILE], anisotropy: roomAnisotropy() });
}

// ── Acoustic drop-ceiling tiles: 4 x 4 tiles of 0.6 m in one 512 px canvas, black-painted with a steel T-bar grid. ──
function roomTileTexture(width, depth) {
  const S = 512, { canvas, ctx } = makeCanvas(S, S), r = rng(57), cell = S / 4;
  ctx.fillStyle = '#1a1a21'; ctx.fillRect(0, 0, S, S);
  for (let ty = 0; ty < 4; ty++) for (let tx = 0; tx < 4; tx++) {
    const x0 = tx * cell, y0 = ty * cell, shade = r();
    ctx.fillStyle = shade < 0.2 ? '#2a2a33' : shade < 0.6 ? '#1d1d25' : '#16161c'; ctx.fillRect(x0, y0, cell, cell);
    if (r() < 0.25) {                       // water stain
      const g = ctx.createRadialGradient(x0 + r() * cell, y0 + r() * cell, 2, x0 + cell / 2, y0 + cell / 2, cell * 0.6);
      g.addColorStop(0, 'rgba(70,52,30,0.35)'); g.addColorStop(1, 'rgba(70,52,30,0)');
      ctx.fillStyle = g; ctx.fillRect(x0, y0, cell, cell);
    }
    for (let i = 0; i < 260; i++) {        // fissures and pinholes
      ctx.fillStyle = r() < 0.5 ? 'rgba(0,0,0,0.55)' : 'rgba(120,120,140,0.16)';
      ctx.fillRect(x0 + r() * cell, y0 + r() * cell, 1 + r() * 2, 1 + r());
    }
  }
  ctx.fillStyle = '#3c3d48';                // T-bars
  for (let i = 0; i <= 4; i++) {
    ctx.fillRect(i * cell - 3, 0, 6, S); ctx.fillRect(0, i * cell - 3, S, 6);
  }
  ctx.fillStyle = 'rgba(200,205,225,0.22)';
  for (let i = 0; i <= 4; i++) { ctx.fillRect(i * cell - 3, 0, 1.5, S); ctx.fillRect(0, i * cell - 3, S, 1.5); }
  return canvasTexture(canvas, { repeat: [width / 2.4, depth / 2.4], anisotropy: roomAnisotropy() });
}

// ── Threshold vinyl (checkerboard) with a rubber doormat. 4.2 m x 1.2 m at 240 px/m. ──
const ROOM_THRESHOLD = { x0: -2.1, x1: 2.1, z0: 5.8, z1: 7.0 };
function roomDrawThreshold(ctx, W, H) {
  const ppm = 240, tile = 0.3 * ppm, r = rng(70);
  for (let ty = 0; ty < H / tile; ty++) for (let tx = 0; tx < W / tile; tx++) {
    const light = (tx + ty) % 2 === 0, j = r() * 10;
    ctx.fillStyle = light ? `rgb(${112 + j},${110 + j},${124 + j})` : `rgb(${10 + j / 2},${10 + j / 2},${16 + j / 2})`;
    ctx.fillRect(tx * tile, ty * tile, tile + 1, tile + 1);
  }
  ctx.fillStyle = 'rgba(0,0,0,0.5)';                                   // grout lines
  for (let x = 0; x <= W; x += tile) ctx.fillRect(x - 1, 0, 2, H);
  for (let y = 0; y <= H; y += tile) ctx.fillRect(0, y - 1, W, 2);
  for (let i = 0; i < 24; i++) {                                         // scuffs
    ctx.strokeStyle = `rgba(200,200,220,${0.08 + r() * 0.12})`; ctx.lineWidth = 1 + r() * 2;
    const x = r() * W, y = r() * H; ctx.beginPath(); ctx.moveTo(x, y); ctx.lineTo(x + 10 + r() * 40, y + (r() - 0.5) * 14); ctx.stroke();
  }
  // Doormat, 2.6 m x 0.8 m, centred in the strip.
  const mw = 2.6 * ppm, mh = 0.8 * ppm, mx = (W - mw) / 2, my = 0.25 * ppm;
  ctx.fillStyle = 'rgba(0,0,0,0.5)'; ctx.fillRect(mx - 5, my - 3, mw + 10, mh + 12);
  ctx.fillStyle = '#12141b'; ctx.fillRect(mx, my, mw, mh);
  ctx.strokeStyle = '#1fa7bd'; ctx.lineWidth = 5; ctx.strokeRect(mx + 10, my + 10, mw - 20, mh - 20);
  ctx.strokeStyle = '#b1268f'; ctx.lineWidth = 3; ctx.strokeRect(mx + 20, my + 20, mw - 40, mh - 40);
  for (let i = 0; i < 1400; i++) { ctx.fillStyle = `rgba(255,255,255,${r() * 0.05})`; ctx.fillRect(mx + r() * mw, my + r() * mh, 2, 2); }
  ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  ctx.font = `28px ${ARCADE_FONT}`; ctx.fillStyle = '#34c8dd'; ctx.fillText('WELCOME', W / 2, my + mh * 0.38);
  ctx.font = `15px ${ARCADE_FONT}`; ctx.fillStyle = '#d347b5'; ctx.fillText('PLAYER ONE', W / 2, my + mh * 0.68);
}

function roomThresholdTexture() {
  const W = 1008, H = 288, { canvas, ctx } = makeCanvas(W, H);
  const tex = canvasTexture(canvas, { anisotropy: roomAnisotropy() });
  roomDrawThreshold(ctx, W, H);
  fontsReady.then(() => { roomDrawThreshold(ctx, W, H); tex.needsUpdate = true; });
  return tex;
}

// ── Night street seen through the doors: sky, skyline with neon signs, wet road, street lamps, blurred bokeh. 1024 x 512. ──
function roomStreetTexture() {
  const W = 1024, H = 512, HZ = H * 0.62, r = rng(404), { canvas, ctx } = makeCanvas(W, H);
  let g = ctx.createLinearGradient(0, 0, 0, HZ);
  g.addColorStop(0, '#01030f'); g.addColorStop(0.6, '#07112e'); g.addColorStop(1, '#173a6a');
  ctx.fillStyle = g; ctx.fillRect(0, 0, W, HZ);
  g = ctx.createLinearGradient(0, HZ, 0, H);
  g.addColorStop(0, '#132c4d'); g.addColorStop(1, '#04070f');
  ctx.fillStyle = g; ctx.fillRect(0, HZ, W, H - HZ);
  // Skyline in two depth layers with lit windows.
  for (const [colour, minH, maxH, winA] of [['#0a1430', 70, 200, 0.5], ['#050a19', 30, 120, 0.85]]) {
    for (let x = -10; x < W;) {
      const bw = 36 + r() * 90, bh = minH + r() * (maxH - minH);
      ctx.fillStyle = colour; ctx.fillRect(x, HZ - bh, bw, bh + 2);
      for (let wy = HZ - bh + 8; wy < HZ - 6; wy += 13) for (let wx = x + 6; wx < x + bw - 8; wx += 12) {
        if (r() < 0.2) { ctx.fillStyle = r() < 0.7 ? `rgba(255,190,100,${winA * 0.6})` : `rgba(120,220,255,${winA * 0.6})`; ctx.fillRect(wx, wy, 4, 6); }
      }
      x += bw + r() * 10;
    }
  }
  const lights = [];                                     // bright spots that get a wet-road reflection
  // Neon shop signs across the street (soft via shadowBlur).
  for (const [x, y, sw, sh, c] of [[150, HZ - 70, 110, 9, 0xff2bd6], [430, HZ - 118, 8, 62, 0x00e5ff], [640, HZ - 52, 90, 8, 0xffb347], [880, HZ - 96, 70, 8, 0x39ff88]]) {
    ctx.shadowColor = roomCss(c, 1); ctx.shadowBlur = 20; ctx.fillStyle = roomCss(c, 0.95); ctx.fillRect(x, y, sw, sh);
    ctx.shadowBlur = 0; lights.push({ x: x + sw / 2, y: y + sh, rad: Math.max(sw, sh) * 0.3, c });
  }
  // Street lamps: dark pole, warm head.
  for (const x of [300, 780]) {
    ctx.fillStyle = '#03060e'; ctx.fillRect(x - 3, HZ - 170, 6, 190); ctx.fillRect(x - 3, HZ - 172, 30, 5);
    lights.push({ x: x + 26, y: HZ - 160, rad: 22, c: 0xffc46b });
  }
  ctx.globalCompositeOperation = 'lighter';
  const bokeh = (x, y, rad, colour, a) => {
    const rg = ctx.createRadialGradient(x, y, 0, x, y, rad);
    rg.addColorStop(0, roomCss(colour, a * 0.7)); rg.addColorStop(0.75, roomCss(colour, a * 0.5)); rg.addColorStop(1, roomCss(colour, 0));
    ctx.fillStyle = rg; ctx.beginPath(); ctx.arc(x, y, rad, 0, Math.PI * 2); ctx.fill();
  };
  const tints = [0xff2bd6, 0x00e5ff, 0xffb347, 0xff3a4a, 0x39ff88, 0xffffff, 0x9b5cff];
  for (const l of lights) bokeh(l.x, l.y, l.rad * 2.4, l.c, 0.45);
  for (let i = 0; i < 70; i++) {                         // small distant bokeh around the skyline
    const x = r() * W, y = HZ - 110 + r() * 130, rad = 5 + r() * 15, c = tints[Math.floor(r() * tints.length)];
    bokeh(x, y, rad, c, 0.5 + r() * 0.4);
  }
  for (let i = 0; i < 5; i++) bokeh(r() * W, HZ - 120 + r() * 160, 34 + r() * 24, tints[Math.floor(r() * 4)], 0.14);   // big soft discs
  for (let i = 0; i < 26; i++) {                         // headlights and tail lights on the road
    const x = r() * W, y = HZ + 4 + r() * 22, c = r() < 0.5 ? 0xffe9c0 : 0xff2a3a, rad = 5 + r() * 7;
    bokeh(x, y, rad, c, 0.9); lights.push({ x, y, rad, c });
  }
  for (const l of lights) {                              // wet-road reflections: vertical smears under each light
    const len = 45 + l.rad * 5, sg = ctx.createLinearGradient(0, Math.max(l.y, HZ), 0, HZ + len);
    sg.addColorStop(0, roomCss(l.c, 0.3)); sg.addColorStop(1, roomCss(l.c, 0));
    ctx.fillStyle = sg; ctx.fillRect(l.x - Math.max(3, l.rad * 0.4), Math.max(l.y, HZ), Math.max(6, l.rad * 0.8), len);
  }
  ctx.globalCompositeOperation = 'source-over';
  return canvasTexture(canvas, { anisotropy: 4 });
}

// ── Door glass: faint tint, reflection streaks, fingerprints and vinyl decals. Left leaf = left half, right leaf = right half. ──
function roomDrawGlass(ctx, W, H) {
  ctx.clearRect(0, 0, W, H);
  const r = rng(12), half = W / 2;
  for (let leaf = 0; leaf < 2; leaf++) {
    ctx.save(); ctx.translate(leaf * half, 0);
    ctx.fillStyle = 'rgba(110,160,215,0.10)'; ctx.fillRect(0, 0, half, H);
    for (const [x, w, a] of [[0.15, 0.10, 0.10], [0.42, 0.05, 0.08], [0.6, 0.16, 0.06]]) {      // slanted reflections
      const g = ctx.createLinearGradient(x * half, 0, (x + w) * half, 0);
      g.addColorStop(0, 'rgba(200,225,255,0)'); g.addColorStop(0.5, `rgba(200,225,255,${a})`); g.addColorStop(1, 'rgba(200,225,255,0)');
      ctx.fillStyle = g; ctx.beginPath();
      ctx.moveTo(x * half + 90, 0); ctx.lineTo((x + w) * half + 90, 0); ctx.lineTo((x + w) * half - 90, H); ctx.lineTo(x * half - 90, H); ctx.fill();
    }
    for (let i = 0; i < 26; i++) {           // smudges around hand height
      const x = r() * half, y = H * (0.42 + r() * 0.2), rad = 6 + r() * 16, g = ctx.createRadialGradient(x, y, 0, x, y, rad);
      g.addColorStop(0, 'rgba(220,230,255,0.07)'); g.addColorStop(1, 'rgba(220,230,255,0)');
      ctx.fillStyle = g; ctx.fillRect(x - rad, y - rad, rad * 2, rad * 2);
    }
    ctx.restore();
  }
  ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.fillStyle = 'rgba(245,245,255,0.88)';
  ctx.save(); ctx.translate(half * 1.5, H * 0.3);                      // hours plate
  ctx.font = `30px ${ARCADE_FONT}`; ctx.fillText('OPEN', 0, 0);
  ctx.font = `13px ${ARCADE_FONT}`; ctx.fillText('11AM - 2AM', 0, 38); ctx.fillText('EVERY DAY', 0, 62);
  ctx.restore();
  ctx.save(); ctx.translate(half * 0.5, H * 0.3);                      // round sticker
  ctx.strokeStyle = 'rgba(245,245,255,0.88)'; ctx.lineWidth = 3; ctx.beginPath(); ctx.arc(0, 0, 42, 0, Math.PI * 2); ctx.stroke();
  ctx.font = `14px ${ARCADE_FONT}`; ctx.fillText('ALL', 0, -10); ctx.fillText('AGES', 0, 12);
  ctx.restore();
  ctx.font = `10px ${ARCADE_FONT}`; ctx.fillStyle = 'rgba(245,245,255,0.7)';
  ctx.save(); ctx.translate(half * 1.5, H * 0.53); ctx.fillText('PUSH', 0, 0); ctx.restore();
  ctx.save(); ctx.translate(half * 0.5, H * 0.53); ctx.fillText('PUSH', 0, 0); ctx.restore();
}

function roomGlassTexture() {
  const W = 640, H = 512, { canvas, ctx } = makeCanvas(W, H);
  const tex = canvasTexture(canvas, { anisotropy: 4 });
  roomDrawGlass(ctx, W, H);
  fontsReady.then(() => { roomDrawGlass(ctx, W, H); tex.needsUpdate = true; });
  return tex;
}

// ══════════════════════════ materials ══════════════════════════

function roomMaterials() {
  const carpet = roomCarpetTextures(), wall = roomWallTextures(), deck = roomDeckTexture();
  const std = (o) => new THREE.MeshStandardMaterial(o);
  return {
    carpet: std({
      map: carpet.map, emissive: 0xffffff, emissiveMap: carpet.emissiveMap, emissiveIntensity: ROOM_CARPET_GLOW,
      bumpMap: carpet.pile, bumpScale: 1.4, roughnessMap: carpet.pile, roughness: 1, metalness: 0,
    }),
    wear: new THREE.MeshBasicMaterial({ map: roomWearTexture(), transparent: true, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -1 }),
    threshold: std({ map: roomThresholdTexture(), roughness: 0.32, metalness: 0.05, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 }),
    wall: std({ map: wall.map, bumpMap: wall.bump, bumpScale: 1.6, roughnessMap: wall.bump, roughness: 1, metalness: 0 }),
    paint: std({ color: 0x14111f, roughness: 0.6, metalness: 0.1 }),
    metal: std({ color: 0x3a3c4a, roughness: 0.42, metalness: 0.65 }),
    alu: std({ color: 0xa6adbb, roughness: 0.32, metalness: 0.85 }),
    steel: std({ color: 0x24262f, roughness: 0.55, metalness: 0.55, emissive: 0x0a0c16 }),
    duct: std({ color: 0x3c4050, roughness: 0.5, metalness: 0.55, emissive: 0x0d1020 }),
    red: std({ color: 0x8c1420, roughness: 0.5, metalness: 0.3, emissive: 0x2a0308 }),
    brass: std({ color: 0xb08a3c, roughness: 0.4, metalness: 0.8 }),
    deck: std({ map: deck, bumpMap: deck, bumpScale: 1.2, roughness: 0.75, metalness: 0.35, emissive: 0x05060c }),
    tiles: std({ map: roomTileTexture(ROOM.w, ROOM.d / 2 - ROOM_DROP.z0), roughness: 0.95, metalness: 0, emissive: 0x06060a }),
    glass: new THREE.MeshBasicMaterial({ map: roomGlassTexture(), transparent: true, depthWrite: false }),
    street: new THREE.MeshBasicMaterial({ map: roomStreetTexture(), color: new THREE.Color(1.2, 1.2, 1.2), fog: false }),
    ground: new THREE.MeshBasicMaterial({ vertexColors: true, fog: false }),
  };
}

// ══════════════════════════ builders ══════════════════════════

function buildRoomFloor(m, halo) {
  const { w, d } = ROOM;
  const floor = new THREE.Mesh(new THREE.PlaneGeometry(w, d), m.carpet);
  floor.rotation.x = -Math.PI / 2;
  scene.add(floor);
  const wear = new THREE.Mesh(new THREE.PlaneGeometry(w, d), m.wear);
  wear.rotation.x = -Math.PI / 2; wear.position.y = 0.002; wear.renderOrder = 1;
  scene.add(wear);

  const T = ROOM_THRESHOLD, strip = new THREE.Mesh(new THREE.PlaneGeometry(T.x1 - T.x0, T.z1 - T.z0), m.threshold);
  strip.rotation.x = -Math.PI / 2; strip.position.set((T.x0 + T.x1) / 2, 0.004, (T.z0 + T.z1) / 2); strip.renderOrder = 2;
  scene.add(strip);

  // Cool street light and stray neon reflections spilling through the doors onto the floor.
  halo.pool(0x3f7dff, 0.42, 0, 0.008, 5.9, 3.6, 3.0);
  halo.pool(NEON.pink, 0.24, -1.15, 0.008, 5.5, 1.5, 1.2);
  halo.pool(NEON.cyan, 0.22, 1.2, 0.008, 5.6, 1.5, 1.2);
}

function buildRoomWalls(m, paint, metal, neon, halo) {
  const { w, d, h } = ROOM, hw = w / 2, hd = d / 2, D = ROOM_DOOR, up = [0, 1, 0], down = [0, -1, 0];
  const wallGeos = [];
  roomWallQuad(wallGeos, [-hw, -hd], [hw, -hd], 0, h, 0, 0);                                      // north
  roomWallQuad(wallGeos, [hw, -hd], [hw, hd], 0, h, 0, 1.5);                                      // east
  roomWallQuad(wallGeos, [hw, hd], [D.halfW, hd], 0, h, 0, 2.5);                                  // south, east of the door
  roomWallQuad(wallGeos, [D.halfW, hd], [-D.halfW, hd], D.h, h, hw - D.halfW, 2.5);               // south, above the door
  roomWallQuad(wallGeos, [-D.halfW, hd], [-hw, hd], 0, h, hw + D.halfW, 2.5);                     // south, west of the door
  roomWallQuad(wallGeos, [-hw, hd], [-hw, -hd], 0, h, 0, 0.5);                                    // west
  roomFlush(wallGeos, m.wall);

  // Baseboard, chair rail and cornice run round every wall (the door gap is skipped on the south wall).
  const runs = [
    { axis: 'x', c: 0, len: w, wallPos: -hd, sign: 1 },                                       // north
    { axis: 'x', c: 0, len: w, wallPos: hd, sign: -1, gap: true },                            // south
    { axis: 'z', c: 0, len: d, wallPos: hw, sign: -1 },                                       // east
    { axis: 'z', c: 0, len: d, wallPos: -hw, sign: 1 },                                       // west
  ];
  const placeBox = (out, run, from, to, sy, sz, y) => {          // box along a wall between two coordinates, hugging the wall
    const len = to - from, mid = (from + to) / 2, off = run.sign * sz / 2;
    if (run.axis === 'x') roomBox(out, len, sy, sz, mid, y, run.wallPos + off); else roomBox(out, sz, sy, len, run.wallPos + off, y, mid);
  };
  for (const run of runs) {
    const spans = run.gap ? [[-hw, -D.halfW], [D.halfW, hw]] : [[-run.len / 2, run.len / 2]];
    for (const [a, b] of spans) {
      placeBox(paint, run, a, b, 0.14, 0.03, 0.07);              // baseboard
      placeBox(metal, run, a, b, 0.04, 0.045, 1.08);             // chair rail
    }
    placeBox(paint, run, -run.len / 2, run.len / 2, 0.15, 0.16, 3.905);       // cornice ledge (hides the cove tube from above)
  }

  // Corner posts with a vertical neon edge each.
  const corners = [[-hw, -hd, NEON.cyan], [hw, -hd, NEON.pink], [-hw, hd, NEON.pink], [hw, hd, NEON.cyan]];
  for (const [cx, cz, colour] of corners) {
    const sx = cx < 0 ? 1 : -1, sz = cz < 0 ? 1 : -1;
    roomBox(paint, 0.16, 3.83, 0.16, cx + sx * 0.08, 1.915, cz + sz * 0.08);
    neon.bar(colour, ROOM_NEON_LEVEL.corner, 0.03, 3.4, 0.03, cx + sx * 0.155, 1.9, cz + sz * 0.155);
    halo.strip(colour, 0.22, [cx + sx * 0.17, 0.2, cz + sz * 0.005], [cx + sx * 0.17, 3.75, cz + sz * 0.005], [sx, 0, 0], 0.7);
  }

  // Neon lines (cove, wall line, baseboard). Colours follow the v1 scheme: north pink, south cyan, sides purple.
  const cv = ROOM_TRIM_Y.cove, ln = ROOM_TRIM_Y.line, bs = ROOM_TRIM_Y.base, off = 0.045;
  const line = (colour, level, axis, wallPos, sign, from, to, y, thick = 0.03) => {
    const len = to - from, mid = (from + to) / 2, o = wallPos + sign * off;
    if (axis === 'x') neon.bar(colour, level, len, thick, thick, mid, y, o); else neon.bar(colour, level, thick, thick, len, o, y, mid);
  };
  // Cyan cove tube under the cornice, all round.
  line(NEON.cyan, ROOM_NEON_LEVEL.cove, 'x', -hd, 1, -hw + 0.2, hw - 0.2, cv);
  line(NEON.cyan, ROOM_NEON_LEVEL.cove, 'x', hd, -1, -hw + 0.2, hw - 0.2, cv);
  line(NEON.cyan, ROOM_NEON_LEVEL.cove, 'z', hw, -1, -hd + 0.2, hd - 0.2, cv);
  line(NEON.cyan, ROOM_NEON_LEVEL.cove, 'z', -hw, 1, -hd + 0.2, hd - 0.2, cv);
  // Wall lines at 3.2 m; the north one stops at the pilasters so the sign bay stays clear.
  const px = ROOM_PILASTER_X[1] + 0.35;
  line(NEON.pink, ROOM_NEON_LEVEL.line, 'x', -hd, 1, -hw + 0.4, -px, ln);
  line(NEON.pink, ROOM_NEON_LEVEL.line, 'x', -hd, 1, px, hw - 0.4, ln);
  line(NEON.cyan, ROOM_NEON_LEVEL.line, 'x', hd, -1, -hw + 0.4, -D.halfW - 0.5, ln);
  line(NEON.cyan, ROOM_NEON_LEVEL.line, 'x', hd, -1, D.halfW + 0.5, hw - 0.4, ln);
  line(NEON.purple, ROOM_NEON_LEVEL.line, 'z', hw, -1, -hd + 0.4, hd - 0.4, ln);
  line(NEON.purple, ROOM_NEON_LEVEL.line, 'z', -hw, 1, -hd + 0.4, hd - 0.4, ln);
  // Baseboard glow (usually half hidden behind cabinets, which then get a coloured rim).
  line(NEON.pink, ROOM_NEON_LEVEL.base, 'x', -hd, 1, -hw + 0.4, hw - 0.4, bs, 0.022);
  line(NEON.cyan, ROOM_NEON_LEVEL.base, 'x', hd, -1, -hw + 0.4, -D.halfW - 0.2, bs, 0.022);
  line(NEON.cyan, ROOM_NEON_LEVEL.base, 'x', hd, -1, D.halfW + 0.2, hw - 0.4, bs, 0.022);
  line(NEON.purple, ROOM_NEON_LEVEL.base, 'z', hw, -1, -hd + 0.4, hd - 0.4, bs, 0.022);
  line(NEON.purple, ROOM_NEON_LEVEL.base, 'z', -hw, 1, -hd + 0.4, hd - 0.4, bs, 0.022);

  // Light spill from those lines onto the wall (up and down), the ceiling (cove) and the floor (baseboard).
  const S = 0.008;
  const wallHalo = (colour, str, axis, wallPos, sign, from, to, y, reach) => {
    const a = axis === 'x' ? [from, y, wallPos + sign * S] : [wallPos + sign * S, y, from];
    const b = axis === 'x' ? [to, y, wallPos + sign * S] : [wallPos + sign * S, y, to];
    halo.strip(colour, str, a, b, up, reach); halo.strip(colour, str, a, b, down, reach);
  };
  const inward = (axis, sign) => (axis === 'x' ? [0, 0, sign] : [sign, 0, 0]);
  const horizontalHalo = (colour, str, axis, wallPos, sign, from, to, reach, y) => {     // glow lying on the ceiling or floor
    const a = axis === 'x' ? [from, y, wallPos] : [wallPos, y, from], b = axis === 'x' ? [to, y, wallPos] : [wallPos, y, to];
    halo.strip(colour, str, a, b, inward(axis, sign), reach);
  };
  for (const [axis, wallPos, sign, from, to] of [['x', -hd, 1, -hw, hw], ['x', hd, -1, -hw, hw], ['z', hw, -1, -hd, hd], ['z', -hw, 1, -hd, hd]]) {
    horizontalHalo(NEON.cyan, 0.30, axis, wallPos, sign, from, to, 1.5, h - 0.006);     // cove -> ceiling
    halo.strip(NEON.cyan, 0.16, axis === 'x' ? [from, cv, wallPos + sign * S] : [wallPos + sign * S, cv, from],
               axis === 'x' ? [to, cv, wallPos + sign * S] : [wallPos + sign * S, cv, to], down, 0.5);   // cove -> wall
    horizontalHalo(axis === 'x' ? (sign > 0 ? NEON.pink : NEON.cyan) : NEON.purple, 0.28, axis, wallPos, sign, from, to, 0.8, 0.008);   // base -> floor
  }
  wallHalo(NEON.pink, 0.30, 'x', -hd, 1, -hw + 0.4, -px, ln, 0.7);
  wallHalo(NEON.pink, 0.30, 'x', -hd, 1, px, hw - 0.4, ln, 0.7);
  wallHalo(NEON.cyan, 0.26, 'x', hd, -1, -hw + 0.4, -D.halfW - 0.5, ln, 0.7);
  wallHalo(NEON.cyan, 0.26, 'x', hd, -1, D.halfW + 0.5, hw - 0.4, ln, 0.7);
  wallHalo(NEON.purple, 0.32, 'z', hw, -1, -hd + 0.4, hd - 0.4, ln, 0.8);
  wallHalo(NEON.purple, 0.32, 'z', -hw, 1, -hd + 0.4, hd - 0.4, ln, 0.8);
}

// Wall-mounted extras: conduits with clamps, junction boxes, louvred vents, an electrical cabinet, pilasters.
function buildRoomWallDetails(m, paint, metal, neon, halo) {
  const { w, d } = ROOM, hw = w / 2, hd = d / 2;
  const conduit = (x, z, axisSign) => {                 // vertical conduit run with clamps and a junction box
    roomCyl(metal, 0.022, 3.55, 'y', x, 1.975, z, 8);
    for (const y of [0.5, 1.4, 2.3, 3.2]) roomBox(metal, 0.06, 0.03, 0.03, x, y, z + axisSign * 0.012);
    roomBox(metal, 0.2, 0.26, 0.09, x, 1.55, z + axisSign * 0.03);
    roomBox(paint, 0.17, 0.2, 0.01, x, 1.55, z + axisSign * 0.08);
  };
  conduit(-6.35, -hd + 0.03, 1); conduit(6.35, -hd + 0.03, 1);
  for (const sx of [-1, 1]) {                            // south end of the side walls
    roomCyl(metal, 0.022, 3.55, 'y', sx * (hw - 0.03), 1.975, 5.3, 8);
    roomBox(metal, 0.09, 0.26, 0.2, sx * (hw - 0.05), 1.55, 5.3);
  }
  // Louvred vents beside the door.
  for (const sx of [-1, 1]) {
    const x = sx * 2.1, z = hd - 0.02;
    roomBox(paint, 0.6, 0.36, 0.03, x, 0.4, z);
    for (let i = 0; i < 6; i++) roomBox(metal, 0.52, 0.018, 0.028, x, 0.28 + i * 0.05, z - 0.008);
  }
  // Electrical cabinet on the east wall, just south of the pinball row.
  roomBox(metal, 0.1, 0.7, 0.5, hw - 0.05, 1.65, 4.6);
  roomBox(paint, 0.02, 0.6, 0.42, hw - 0.11, 1.65, 4.6);
  roomBox(metal, 0.03, 0.08, 0.03, hw - 0.13, 1.65, 4.77);

  // Pilasters: 0.5 m x 0.35 m columns against the north wall with neon wraps (outside every reserved zone).
  for (const x of ROOM_PILASTER_X) {
    roomBox(paint, 0.5, 3.83, 0.35, x, 1.915, -hd + 0.175);
    addCollider(x - 0.25, x + 0.25, -hd, -hd + 0.35);
    roomBox(metal, 0.54, 0.12, 0.39, x, 0.06, -hd + 0.195);                  // plinth
    for (const y of [0.55, 3.3]) {                                           // neon wraps on the front and both sides
      const c = y > 2 ? NEON.pink : NEON.cyan;
      neon.bar(c, ROOM_NEON_LEVEL.accent, 0.5, 0.03, 0.03, x, y, -hd + 0.35 + 0.016);
      for (const sx of [-1, 1]) neon.bar(c, ROOM_NEON_LEVEL.accent, 0.03, 0.03, 0.35, x + sx * (0.25 + 0.016), y, -hd + 0.175);
      halo.strip(c, 0.2, [x - 0.25, y, -hd + 0.35 + 0.008], [x + 0.25, y, -hd + 0.35 + 0.008], [0, 1, 0], 0.45);
      halo.strip(c, 0.2, [x - 0.25, y, -hd + 0.35 + 0.008], [x + 0.25, y, -hd + 0.35 + 0.008], [0, -1, 0], 0.45);
    }
    for (const sx of [-1, 1]) neon.bar(NEON.purple, ROOM_NEON_LEVEL.accent, 0.03, 3.2, 0.03, x + sx * 0.26, 1.9, -hd + 0.35 + 0.016);
  }
}

// Steel truss (box section: 4 chords, zig-zag on the underside and both sides). axis: 'x' or 'z'.
function roomAddTruss(out, axis, cx, cy, cz, len) {
  const HW = ROOM_TRUSS.halfW, HH = ROOM_TRUSS.halfH;
  const P = axis === 'x' ? (s, u, v) => [cx + s, cy + v, cz + u] : (s, u, v) => [cx + u, cy + v, cz + s];   // s along, u across, v up
  for (const u of [-HW, HW]) for (const v of [-HH, HH]) roomStrut(out, ...P(-len / 2, u, v), ...P(len / 2, u, v), 0.045);
  const n = Math.round(len / 0.6), step = len / n;
  for (let i = 0; i < n; i++) {
    const s0 = -len / 2 + i * step, s1 = s0 + step, f = i % 2 ? 1 : -1;
    roomStrut(out, ...P(s0, -f * HW, -HH), ...P(s1, f * HW, -HH), 0.024);
    for (const u of [-HW, HW]) roomStrut(out, ...P(s0, u, -f * HH), ...P(s1, u, f * HH), 0.024);
  }
}

function buildRoomCeiling(m, paint) {
  const { w, d, h } = ROOM, hd = d / 2, TR = ROOM_TRUSS, DR = ROOM_DROP;

  // Exposed deck.
  const deck = new THREE.Mesh(new THREE.PlaneGeometry(w, d), m.deck);
  deck.rotation.x = Math.PI / 2; deck.position.y = h;
  scene.add(deck);

  // Truss grid + mount plates for spot cans at every crossing.
  const steel = [];
  for (const z of TR.z) roomAddTruss(steel, 'x', 0, TR.y, z, w - 0.4);
  for (const x of TR.x) roomAddTruss(steel, 'z', x, TR.y, -1.3, 11);          // z from -6.8 to 4.2 (stops at the soffit)
  for (const p of ROOM_SPOT_MOUNTS) {
    roomBox(steel, 0.2, 0.025, 0.2, p.x, p.y - 0.0125, p.z);
    roomCyl(steel, 0.018, 0.09, 'y', p.x, p.y - 0.07, p.z, 8);
  }
  roomFlush(steel, m.steel);

  // Ducts: round spiral main, rectangular run, small round branch, with joint rings and hangers.
  const ducts = [], round = { r: 0.28, y: 3.33, z: -1.75, x0: -9.0, x1: 9.0 };
  roomCyl(ducts, round.r, round.x1 - round.x0, 'x', 0, round.y, round.z, 20);
  for (const sx of [-1, 1]) {
    const g = new THREE.SphereGeometry(round.r, 20, 12); g.translate(sx * round.x1, round.y, round.z); ducts.push(g);
    roomCyl(ducts, round.r, h - round.y, 'y', sx * round.x1, round.y + (h - round.y) / 2, round.z, 20);
  }
  for (let x = round.x0 + 1.2; x < round.x1; x += 1.8) roomCyl(ducts, round.r + 0.03, 0.07, 'x', x, round.y, round.z, 20);
  for (let x = -7.5; x <= 7.5; x += 5) for (const s of [-1, 1]) roomStrut(ducts, x, round.y + round.r, round.z + s * 0.2, x, h, round.z + s * 0.2, 0.02);
  const rect = { sx: 0.56, sy: 0.3, y: 3.46, z: 1.75, x0: -9.0, x1: 3.0 };
  roomBox(ducts, rect.x1 - rect.x0, rect.sy, rect.sx, (rect.x0 + rect.x1) / 2, rect.y, rect.z);
  for (let x = rect.x0 + 0.9; x < rect.x1; x += 1.5) roomBox(ducts, 0.05, rect.sy + 0.05, rect.sx + 0.05, x, rect.y, rect.z);
  roomBox(ducts, 0.5, 0.05, 0.5, -4.0, rect.y - rect.sy / 2 - 0.025, rect.z);             // supply diffuser plate
  roomBox(ducts, 0.4, 0.04, 0.4, -4.0, rect.y - rect.sy / 2 - 0.06, rect.z);
  for (let x = -7.5; x <= 2.5; x += 5) for (const s of [-1, 1]) roomStrut(ducts, x, rect.y + rect.sy / 2, rect.z + s * 0.25, x, h, rect.z + s * 0.25, 0.02);
  roomCyl(ducts, 0.13, 10.4, 'z', -5.0, 3.78, -1.4, 14);                                   // small branch, north-south
  for (let z = -6.2; z < 3.8; z += 1.6) roomCyl(ducts, 0.155, 0.06, 'z', -5.0, 3.78, z, 14);
  roomFlush(ducts, m.duct);

  // Sprinkler main (red) along the north side with heads, a copper line and a cable tray.
  const pipes = [], heads = [];
  roomCyl(pipes, 0.055, w - 0.6, 'x', 0, 3.88, -5.9, 12);
  for (let x = -8.5; x <= 8.5; x += 2.125) {
    roomCyl(pipes, 0.028, 0.2, 'y', x, 3.78, -5.9, 8);
    roomCyl(heads, 0.03, 0.06, 'y', x, 3.66, -5.9, 10);
    roomCyl(heads, 0.075, 0.012, 'y', x, 3.625, -5.9, 12);
  }
  for (let x = -9; x <= 9; x += 3) roomBox(pipes, 0.05, 0.14, 0.05, x, 3.93, -5.9);
  roomFlush(pipes, m.red); roomFlush(heads, m.brass);

  const tray = [], trayY = 3.9;
  const ladder = (axis, cx, cz, len) => {              // perforated ladder tray with two cables
    const across = 0.42;
    for (const s of [-1, 1]) {
      if (axis === 'x') { roomBox(tray, len, 0.07, 0.025, cx, trayY, cz + s * across / 2); }
      else { roomBox(tray, 0.025, 0.07, len, cx + s * across / 2, trayY, cz); }
    }
    for (let t = -len / 2 + 0.15; t < len / 2; t += 0.3) {
      if (axis === 'x') roomBox(tray, 0.02, 0.02, across, cx + t, trayY - 0.025, cz); else roomBox(tray, across, 0.02, 0.02, cx, trayY - 0.025, cz + t);
    }
    for (const s of [-0.1, 0.08]) {
      if (axis === 'x') roomCyl(tray, 0.022, len, 'x', cx, trayY - 0.005, cz + s, 8); else roomCyl(tray, 0.022, len, 'z', cx + s, trayY - 0.005, cz, 8);
    }
  };
  ladder('x', 0, -5.1, w - 0.8); ladder('z', 5.0, -0.6, 8.9);
  roomFlush(tray, m.steel);

  // Acoustic soffit above the entrance: T-bar tiles, fascia and a cyan/magenta edge (neon added by buildRoom).
  const soffit = new THREE.Mesh(new THREE.PlaneGeometry(w, hd - DR.z0), m.tiles);
  soffit.rotation.x = Math.PI / 2; soffit.position.set(0, DR.y, (DR.z0 + hd) / 2);
  scene.add(soffit);
  const fascia = [];
  roomBox(fascia, w, 0.16, 0.06, 0, DR.y - 0.08 + 0.0, DR.z0 + 0.03);
  roomBox(fascia, w, 0.04, 0.08, 0, DR.y - 0.18, DR.z0 + 0.04);
  roomFlush(fascia, m.paint);
}

function buildRoomEntrance(m, neon, halo) {
  const D = ROOM_DOOR, hd = ROOM.d / 2, zc = hd + 0.1;            // door plane sits 0.1 m into the 0.25 m wall thickness
  const alu = [];
  // Frame: jambs, head and threshold fill the wall thickness.
  for (const s of [-1, 1]) roomBox(alu, 0.1, D.h, 0.25, s * (D.halfW - 0.05), D.h / 2, hd + 0.125);
  roomBox(alu, D.halfW * 2, 0.1, 0.25, 0, D.h - 0.05, hd + 0.125);
  roomBox(alu, D.halfW * 2, 0.03, 0.25, 0, 0.015, hd + 0.125);
  // Two leaves: stiles, top rail, kick rail, push bars, door closers.
  const glassGeos = [];
  for (const s of [-1, 1]) {
    const inner = 0.012, outer = D.halfW - 0.1, cx = s * (inner + outer) / 2, wLeaf = outer - inner;
    for (const x of [s * (inner + 0.045), s * (outer - 0.045)]) roomBox(alu, 0.09, D.h - 0.13, 0.05, x, 0.03 + (D.h - 0.13) / 2 + 0.0, zc);
    roomBox(alu, wLeaf, 0.1, 0.05, cx, 2.35, zc);
    roomBox(alu, wLeaf, 0.28, 0.05, cx, 0.17, zc);
    roomCyl(alu, 0.018, wLeaf - 0.4, 'x', cx, 1.0, zc - 0.085, 12);
    for (const dx of [-1, 1]) roomCyl(alu, 0.011, 0.07, 'z', cx + dx * (wLeaf - 0.4) / 2, 1.0, zc - 0.05, 8);
    roomBox(alu, 0.4, 0.06, 0.06, cx, 2.29, zc - 0.055);
    const gw = wLeaf - 0.18, gh = 2.3 - 0.31, g = new THREE.PlaneGeometry(gw, gh);
    g.rotateY(Math.PI);                                   // face into the room (-z)
    g.translate(cx, 0.31 + gh / 2, zc);
    // Map each leaf to its own half of the glass texture.
    const uv = g.attributes.uv;
    for (let i = 0; i < uv.count; i++) uv.setX(i, (s < 0 ? 0 : 0.5) + uv.getX(i) * 0.5);
    glassGeos.push(g);
  }
  roomFlush(alu, m.alu);
  roomFlush(glassGeos, m.glass, { renderOrder: 4 });

  // Night street beyond the doors: ground, backdrop and a few reflected neon pools.
  const gnd = new THREE.PlaneGeometry(12, 2.4, 1, 3);
  gnd.rotateX(-Math.PI / 2); gnd.translate(0, -0.02, hd + 0.25 + 1.2);
  const cols = new Float32Array(gnd.attributes.position.count * 3), near = new THREE.Color(0x05080f), far = new THREE.Color(0x0b1626), c = new THREE.Color();
  for (let i = 0; i < gnd.attributes.position.count; i++) {
    c.copy(near).lerp(far, (gnd.attributes.position.getZ(i) - (hd + 0.25)) / 2.4); c.toArray(cols, i * 3);
  }
  gnd.setAttribute('color', new THREE.BufferAttribute(cols, 3));
  scene.add(new THREE.Mesh(gnd, m.ground));
  const back = new THREE.Mesh(new THREE.PlaneGeometry(12, 6), m.street);
  back.position.set(0, 2.3, hd + 0.25 + 2.4); back.rotation.y = Math.PI;
  scene.add(back);
  halo.pool(NEON.pink, 0.28, -1.6, -0.005, hd + 1.4, 1.1, 0.7);
  halo.pool(NEON.cyan, 0.26, 1.7, -0.005, hd + 1.7, 1.2, 0.8);
  halo.pool(0xffb347, 0.2, 0.2, -0.005, hd + 1.9, 1.4, 0.6);

  // Faint LED line in the door head and frame highlight so the entrance reads as its own lit bay.
  neon.bar(0x7fc8ff, 1.6, D.halfW * 2 - 0.3, 0.02, 0.02, 0, D.h - 0.115, zc - 0.05);
  registry.props.push({ kind: 'door', x: D.x, z: D.z });
}

// ══════════════════════════ entry point ══════════════════════════

function buildRoom() {
  const t0 = performance.now();   //@@DEBUG
  const m = roomMaterials();
  const neon = roomNeonSet(), halo = roomHaloSet();
  const paint = [], metal = [];

  buildRoomFloor(m, halo);
  buildRoomWalls(m, paint, metal, neon, halo);
  buildRoomWallDetails(m, paint, metal, neon, halo);
  buildRoomCeiling(m, paint);
  buildRoomEntrance(m, neon, halo);

  // Fascia edge of the soffit: magenta tube plus its glow on the underside of the tiles.
  const D = ROOM_DROP;
  neon.bar(NEON.pink, ROOM_NEON_LEVEL.line, ROOM.w - 0.6, 0.03, 0.03, 0, D.y - 0.2, D.z0 + 0.04);
  halo.strip(NEON.pink, 0.2, [-ROOM.w / 2 + 0.3, D.y - 0.19, D.z0 + 0.06], [ROOM.w / 2 - 0.3, D.y - 0.19, D.z0 + 0.06], [0, 0, -1], 0.9);

  roomFlush(paint, m.paint);
  roomFlush(metal, m.metal);
  neon.flush();
  halo.flush();
  window.__roomBuildMs = performance.now() - t0;   //@@DEBUG
}
