// ═══════════════ GAME PROPS: pinball machines, claw machines, air hockey tables, stools & bench ═══════════════
// Owner: games agent. Entry point: buildGameProps(). Runs after buildProps(). No real lights are added.
//
// How this part is organised
//   * Static geometry is baked into world space and merged into a few meshes per zone. Six shared materials
//     (solid / chrome / glow / glass / glare / floor-glow) read per-vertex colours, so any colour costs nothing.
//   * Per-machine artwork (playfields, backglasses, side decals, marquees, air-hockey surfaces) is painted once on canvases.
//   * Motion is transform-only and event-driven: instanced claws on long timers, air-hockey pucks that rally every few
//     seconds, and every lamp chase (backglass borders, playfield inserts, marquee bulbs) lives in ONE InstancedMesh
//     whose instance colours change at 8 Hz. Nothing here re-uploads a canvas after the build.
//   * To add another machine: add an entry to GP_PINBALLS / GP_CLAWS / GP_TABLES (or copy a gpBuild... function).

//@@import import * as GpBGU from 'three/addons/utils/BufferGeometryUtils.js';

// ── Layout & themes ─────────────────────────────────────────────────────────────────────────────
const GP_PIN = {
  x: 9.29,                       // machine origin: backbox touches the east wall, the front faces -x
  tilt: 6.5 * Math.PI / 180,     // playfield slope (back is higher)
  pfW: 0.58, pfL: 1.26,          // playfield size (m)
  pfOrigin: [0, 0.87, -0.02],    // playfield centre in machine space (front is +z)
};
// Playfield fixtures in normalised art coordinates (0..1 across, 0..1 from the back/top to the front/bottom).
// The canvas art and the 3D parts both read this table so they line up.
const GP_PIN_LAYOUT = {
  bumpers: [[0.50, 0.33], [0.35, 0.42], [0.65, 0.42]],
  flippers: [[0.345, 0.865, 0.445, 0.905], [0.655, 0.865, 0.555, 0.905]],       // pivot x,y -> tip x,y
  slings: [[0.17, 0.66, 0.17, 0.80, 0.29, 0.83], [0.83, 0.66, 0.83, 0.80, 0.71, 0.83]],
};
const GP_PINBALLS = [   // north to south along the east wall; each has its own theme
  { name: 'COSMIC COWBOY', tag: 'RODEO IN ORBIT', kind: 'space', z: -3.9,  c1: NEON.cyan,  c2: NEON.orange, bg: ['#020a26', '#0a3070'], seed: 11 },
  { name: 'GHOST GARAGE',  tag: 'HAUNTED HOT RODS', kind: 'ghost', z: -2.95, c1: NEON.green, c2: NEON.purple, bg: ['#0c0322', '#3a0c58'], seed: 12 },
  { name: 'TURBO TIKI',    tag: 'ISLAND SPEEDWAY', kind: 'tiki',  z: -2.0,  c1: NEON.red,   c2: NEON.yellow, bg: ['#2a0604', '#801c0a'], seed: 13 },
  { name: 'LASER LAGOON',  tag: 'SYNTHWAVE SURF', kind: 'wave',  z: -1.05, c1: NEON.pink,  c2: NEON.blue,   bg: ['#160332', '#520a5c'], seed: 14 },
];

const GP_CLAW_Z = 6.47;         // machine origin z; the machines face north (-z), backs against the south wall
const GP_CLAWS = [              // left pair, then right pair (x = machine centre)
  { name: 'CLAW KING',    tag: 'WIN BIG!',   x: -5.0,  c1: NEON.cyan,   c2: NEON.pink,   body: 0x0b2a4a, seed: 21 },
  { name: 'PLUSH RUSH',   tag: 'GRAB A FRIEND', x: -3.75, c1: NEON.pink,   c2: NEON.yellow, body: 0x3c0f44, seed: 22 },
  { name: 'MEGA GRABBER', tag: 'PRIZES INSIDE', x: 3.75,  c1: NEON.green,  c2: NEON.orange, body: 0x0c3a26, seed: 23 },
  { name: 'TOY TOWN',     tag: 'TRY YOUR LUCK', x: 5.0,   c1: NEON.orange, c2: NEON.blue,   body: 0x43200a, seed: 24 },
];
const GP_CLAW = {               // claw travel (machine space; y in metres)
  restY: 1.46, dropY: 1.12, bridgeY: 1.62, carriageY: 1.585, cableTop: 1.56,
  chuteX: -0.28, chuteZ: 0.24, closed: 0.62,
};
const GP_PRIZE_COLORS = [0xff3b6b, 0xffd23f, 0x3bd5ff, 0x7dff4a, 0xb05cff, 0xff8a1f, 0xf4f4ff, 0xff5cf0, 0x39ff88, 0xff4a2a];

const GP_TABLES = [             // air hockey: long axis along z
  { name: 'POLAR PUCK',   x: 5.4, z: -2.0, c1: NEON.cyan, c2: NEON.pink,   m1: 0xff2a3a, m2: 0x2f6bff, seed: 31 },
  { name: 'TURBO HOCKEY', x: 5.4, z:  2.0, c1: NEON.pink, c2: NEON.yellow, m1: 0x39ff88, m2: 0xff8a1f, seed: 32 },
];
const GP_STOOLS = [[8.05, -3.4, NEON.pink], [8.05, -1.5, NEON.cyan], [4.15, -2.45, NEON.orange],
                   [4.15, -1.55, NEON.green], [6.65, 1.55, NEON.pink], [6.65, 2.45, NEON.cyan]];
const GP_BENCH = { x: 9.68, z: 1.9, length: 1.6, color: NEON.purple };

// ── Shared build state ──────────────────────────────────────────────────────────────────────────
const GP_GEO = {};              // unit geometries shared by every batch (scaled by matrices)
const GP_MAT = {};              // shared materials
const gpLamps = [];             // { matrix, kind, k, gap, color } for the one lamp InstancedMesh
const gpClaws = [];             // claw animation state, one per machine
const gpPucks = [];             // air hockey puck animation state
let gpLampState = null;         // { mesh, on, off } once the lamp mesh exists
let gpClawMeshes = null;        // instanced gantry parts + carried prize

// ── Build-time helpers ──────────────────────────────────────────────────────────────────────────
const _gpEuler = new THREE.Euler(), _gpQuat = new THREE.Quaternion();
const _gpPos = new THREE.Vector3(), _gpScl = new THREE.Vector3(), _gpMat = new THREE.Matrix4();
const GP_UP = new THREE.Vector3(0, 1, 0), GP_FWD = new THREE.Vector3(0, 0, 1);
const gpCss = (hex, a = 1) => `rgba(${(hex >> 16) & 255},${(hex >> 8) & 255},${hex & 255},${a})`;

// Matrix from position, XYZ Euler rotation and scale.
function gpXf(pos = [0, 0, 0], rot = [0, 0, 0], scl = [1, 1, 1]) {
  _gpQuat.setFromEuler(_gpEuler.set(rot[0], rot[1], rot[2]));
  return new THREE.Matrix4().compose(_gpPos.set(pos[0], pos[1], pos[2]), _gpQuat, _gpScl.set(scl[0], scl[1], scl[2]));
}

// Collects transformed, vertex-coloured copies of unit primitives and merges them into one geometry.
// Every method takes the parent `frame` matrix (machine space -> world) first.
class GpBatch {
  constructor() { this.geos = []; }

  add(geo, matrix, color = 0xffffff, gain = 1) {
    const g = geo.index ? geo.toNonIndexed() : geo.clone();
    g.applyMatrix4(matrix);
    const c = new THREE.Color(color).multiplyScalar(gain);
    const n = g.attributes.position.count, rgb = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) { rgb[i * 3] = c.r; rgb[i * 3 + 1] = c.g; rgb[i * 3 + 2] = c.b; }
    g.setAttribute('color', new THREE.BufferAttribute(rgb, 3));
    this.geos.push(g);
    return this;
  }
  part(kind, frame, pos, rot, scl, color, gain) {
    return this.add(GP_GEO[kind], frame.clone().multiply(gpXf(pos, rot, scl)), color, gain);
  }
  box(frame, size, pos, color, gain, rot) { return this.part('box', frame, pos, rot, size, color, gain); }
  cyl(frame, r, h, pos, color, gain, rot) { return this.part('cyl', frame, pos, rot, [r, h, r], color, gain); }
  ball(frame, r, pos, color, gain, squash = 1) { return this.part('sphere', frame, pos, undefined, [r, r * squash, r], color, gain); }
  torus(frame, r, pos, color, gain) { return this.part('torus', frame, pos, undefined, [r, r, r], color, gain); }
  // Flat box whose long (z) axis runs from point a to point b: rails, ramps.
  beam(frame, a, b, w, t, color, gain) {
    const va = new THREE.Vector3(...a), vb = new THREE.Vector3(...b), d = vb.clone().sub(va), len = d.length();
    const q = new THREE.Quaternion().setFromUnitVectors(GP_FWD, d.normalize());
    const m = new THREE.Matrix4().compose(va.add(vb).multiplyScalar(0.5), q, new THREE.Vector3(w, t, len));
    return this.add(GP_GEO.box, frame.clone().multiply(m), color, gain);
  }
  // Thin round rod from point a to point b: wires, joystick shafts, claw arms.
  wire(frame, a, b, r, color, gain) {
    const va = new THREE.Vector3(...a), vb = new THREE.Vector3(...b), d = vb.clone().sub(va), len = d.length();
    const q = new THREE.Quaternion().setFromUnitVectors(GP_UP, d.normalize());
    const m = new THREE.Matrix4().compose(va.add(vb).multiplyScalar(0.5), q, new THREE.Vector3(r, len, r));
    return this.add(GP_GEO.wire, frame.clone().multiply(m), color, gain);
  }
  geometry() { return GpBGU.mergeGeometries(this.geos, false); }
}

// One zone = the six merged meshes that belong to one part of the room (keeps frustum culling useful).
function gpZone() {
  return { solid: new GpBatch(), chrome: new GpBatch(), glow: new GpBatch(), glass: new GpBatch(), glare: new GpBatch(), floor: new GpBatch() };
}
const GP_RENDER_ORDER = { floor: -2, glass: 1, glare: 2 };
function gpFlush(zone) {
  for (const [key, batch] of Object.entries(zone)) {
    if (!batch.geos.length) continue;
    const mesh = new THREE.Mesh(batch.geometry(), GP_MAT[key]);
    mesh.renderOrder = GP_RENDER_ORDER[key] || 0;
    scene.add(mesh);
    batch.geos.forEach((g) => g.dispose());
    batch.geos.length = 0;
  }
}

// A single textured mesh baked into world space.
function gpArtMesh(geo, matrix, material) {
  const mesh = new THREE.Mesh(geo.clone().applyMatrix4(matrix), material);
  scene.add(mesh);
  return mesh;
}

// Registers one lamp for the shared lamp mesh. kind: 0 travelling pairs, 1 alternate blink, 2 sparkle, 3 steady.
function gpAddLamp(matrix, kind, k, gap, color) { gpLamps.push({ matrix, kind, k, gap, color }); }

// Evenly spaced points around a w x h rectangle (centred), used for bulb borders.
function gpPerimeter(w, h, count) {
  const pts = [], per = 2 * (w + h);
  for (let i = 0; i < count; i++) {
    let d = (i / count) * per;
    if (d < w) pts.push([-w / 2 + d, h / 2]);
    else if ((d -= w) < h) pts.push([w / 2, h / 2 - d]);
    else if ((d -= h) < w) pts.push([w / 2 - d, -h / 2]);
    else pts.push([-w / 2, -h / 2 + (d - w - h)]);
  }
  return pts;
}

// ── Geometries & materials ──────────────────────────────────────────────────────────────────────
function gpInitGeometries() {
  GP_GEO.box = new THREE.BoxGeometry(1, 1, 1);
  GP_GEO.cyl = new THREE.CylinderGeometry(1, 1, 1, 20);
  GP_GEO.wire = new THREE.CylinderGeometry(1, 1, 1, 6);
  GP_GEO.sphere = new THREE.SphereGeometry(1, 16, 10);
  GP_GEO.disc = new THREE.CircleGeometry(1, 12);                                   // faces +z
  GP_GEO.flat = new THREE.PlaneGeometry(1, 1).rotateX(-Math.PI / 2);               // lies flat, faces up
  GP_GEO.torus = new THREE.TorusGeometry(1, 0.07, 6, 28).rotateX(Math.PI / 2);     // ring lying flat
  const poly = gpSidePoly();                                                       // pinball side panel, 2 cm thick
  const shape = new THREE.Shape(poly.map(([z, y]) => new THREE.Vector2(-z, y)));
  GP_GEO.pinSide = new THREE.ExtrudeGeometry(shape, { depth: 0.02, bevelEnabled: false }).rotateY(Math.PI / 2);
}

// Uses the scene's environment map when the lighting part made one, otherwise builds a small neon "studio" of its own.
function gpFallbackEnv() {
  const { canvas: cv, ctx: g } = makeCanvas(256, 128);
  const sky = g.createLinearGradient(0, 0, 0, 128);
  sky.addColorStop(0, '#3a2c66'); sky.addColorStop(0.5, '#5a48a0'); sky.addColorStop(0.55, '#1a1230'); sky.addColorStop(1, '#0a0716');
  g.fillStyle = sky; g.fillRect(0, 0, 256, 128);
  g.fillStyle = '#ffffff';
  for (let i = 0; i < 6; i++) g.fillRect(i * 43 + 8, 20, 24, 8);                    // ceiling light panels
  g.fillStyle = '#ff2bd6'; g.fillRect(0, 62, 120, 5);
  g.fillStyle = '#00e5ff'; g.fillRect(130, 58, 126, 5);
  const tex = new THREE.CanvasTexture(cv);
  tex.mapping = THREE.EquirectangularReflectionMapping;
  tex.colorSpace = THREE.SRGBColorSpace;
  const pmrem = new THREE.PMREMGenerator(renderer);
  const target = pmrem.fromEquirectangular(tex);
  tex.dispose(); pmrem.dispose();
  return target.texture;
}

function gpMakeMaterials() {
  const envMap = scene.environment ? null : gpFallbackEnv();
  const std = (o) => new THREE.MeshStandardMaterial({ envMap, ...o });
  GP_MAT.envMap = envMap;
  GP_MAT.solid = std({ vertexColors: true, roughness: 0.42, metalness: 0.15, envMapIntensity: 0.8 });
  GP_MAT.chrome = std({ vertexColors: true, roughness: 0.14, metalness: 1, envMapIntensity: 1.5 });
  GP_MAT.glow = new THREE.MeshBasicMaterial({ vertexColors: true });
  GP_MAT.glass = new THREE.MeshPhysicalMaterial({
    envMap, color: 0xb8dcff, roughness: 0.05, metalness: 0, transparent: true, opacity: 0.14,
    envMapIntensity: 1.8, clearcoat: 1, clearcoatRoughness: 0.05, depthWrite: false,
  });
  GP_MAT.glare = new THREE.MeshBasicMaterial({
    map: gpGlareTexture(), vertexColors: true, blending: THREE.AdditiveBlending, transparent: true, depthWrite: false,
  });
  GP_MAT.floor = new THREE.MeshBasicMaterial({
    map: gpSpillTexture(), vertexColors: true, blending: THREE.AdditiveBlending, transparent: true, depthWrite: false,
  });
  GP_MAT.lamp = new THREE.MeshBasicMaterial({ color: 0xffffff });                  // instance colours do the lighting
  // Prizes: plain lit plastic plus a self-lit share of their own colour (the cabinet interior is LED-lit but we have no lights).
  GP_MAT.prize = std({ roughness: 0.7, metalness: 0, envMapIntensity: 0.3 });
  GP_MAT.prize.onBeforeCompile = (shader) => {
    shader.fragmentShader = shader.fragmentShader.replace('#include <emissivemap_fragment>',
      '#include <emissivemap_fragment>\n  totalEmissiveRadiance += diffuseColor.rgb * 0.3;');
  };
  GP_MAT.prize.customProgramCacheKey = () => 'gpPrize';
}

// ── Canvas painting ─────────────────────────────────────────────────────────────────────────────
// Paints now and again once web fonts are ready. `draw(ctx, w, h)` must repaint the whole canvas.
function gpPaintedTexture(w, h, draw, opts) {
  const { canvas: cv, ctx } = makeCanvas(w, h);
  draw(ctx, w, h);
  const tex = canvasTexture(cv, opts);
  fontsReady.then(() => { draw(ctx, w, h); tex.needsUpdate = true; });
  return tex;
}

const gpTitleFont = (size) => `italic 900 ${size}px Impact, "Arial Black", "Helvetica Neue", Arial, sans-serif`;
const gpPixelFont = (size) => `${size}px ${ARCADE_FONT}`;

// Chunky outlined, glowing title text that shrinks to fit maxW.
function gpTitle(g, text, x, y, maxW, size, fill, stroke, glow) {
  g.font = gpTitleFont(size);
  const w = g.measureText(text).width;
  if (w > maxW) { size = Math.floor(size * maxW / w); g.font = gpTitleFont(size); }
  g.textAlign = 'center'; g.textBaseline = 'middle'; g.lineJoin = 'round';
  g.shadowColor = glow; g.shadowBlur = size * 0.4;
  g.lineWidth = size * 0.24; g.strokeStyle = stroke; g.strokeText(text, x, y);
  g.shadowBlur = 0;
  const grad = g.createLinearGradient(0, y - size / 2, 0, y + size / 2);
  grad.addColorStop(0, fill[0]); grad.addColorStop(1, fill[1]);
  g.fillStyle = grad; g.fillText(text, x, y);
}

function gpSparkles(g, rnd, count, W, H, color) {
  g.fillStyle = color;
  for (let i = 0; i < count; i++) {
    g.globalAlpha = 0.25 + rnd() * 0.6;
    const s = 1 + rnd() * 2.2;
    g.fillRect(rnd() * W, rnd() * H, s, s);
  }
  g.globalAlpha = 1;
}

function gpChevron(g, x, y, s, color, width) {
  g.strokeStyle = color; g.lineWidth = width; g.lineCap = 'round'; g.lineJoin = 'round';
  g.beginPath(); g.moveTo(x - s, y + s * 0.5); g.lineTo(x, y - s * 0.5); g.lineTo(x + s, y + s * 0.5); g.stroke();
}

// The theme's big picture, centred at (cx, cy) with radius r: planet / ghost / tiki sun / synthwave sun.
function gpPaintEmblem(g, kind, cx, cy, r, c1, c2) {
  const A = gpCss(c1), B = gpCss(c2);
  g.save(); g.translate(cx, cy);
  if (kind === 'space') {
    const p = g.createRadialGradient(-r * 0.25, -r * 0.3, r * 0.05, 0, 0, r * 0.65);
    p.addColorStop(0, '#ffffff'); p.addColorStop(0.3, A); p.addColorStop(1, '#04102e');
    g.fillStyle = p; g.beginPath(); g.arc(0, 0, r * 0.62, 0, 7); g.fill();
    g.strokeStyle = B; g.lineWidth = r * 0.1; g.shadowColor = B; g.shadowBlur = r * 0.2;
    g.beginPath(); g.ellipse(0, 0, r, r * 0.27, -0.4, Math.PI * 0.05, Math.PI * 0.95); g.stroke();   // ring, front half
    g.shadowBlur = 0; g.fillStyle = '#fff'; g.beginPath(); g.arc(r * 0.78, -r * 0.62, r * 0.09, 0, 7); g.fill();
  } else if (kind === 'ghost') {
    g.fillStyle = B; g.globalAlpha = 0.55; g.beginPath(); g.arc(r * 0.45, -r * 0.55, r * 0.42, 0, 7); g.fill(); g.globalAlpha = 1;
    g.shadowColor = A; g.shadowBlur = r * 0.35; g.fillStyle = '#e8fff0';
    g.beginPath(); g.moveTo(-r * 0.5, r * 0.62); g.lineTo(-r * 0.5, -r * 0.05); g.arc(0, -r * 0.05, r * 0.5, Math.PI, 0); g.lineTo(r * 0.5, r * 0.62);
    for (let i = 0; i < 4; i++) g.quadraticCurveTo(r * 0.5 - (i * 2 + 1) * r * 0.125, r * 0.86, r * 0.5 - (i + 1) * r * 0.25, r * 0.62);
    g.fill(); g.shadowBlur = 0; g.fillStyle = '#10061e';
    g.beginPath(); g.ellipse(-r * 0.2, -r * 0.1, r * 0.09, r * 0.14, 0, 0, 7); g.ellipse(r * 0.2, -r * 0.1, r * 0.09, r * 0.14, 0, 0, 7); g.fill();
    g.beginPath(); g.ellipse(0, r * 0.22, r * 0.1, r * 0.13, 0, 0, 7); g.fill();
  } else if (kind === 'tiki') {
    g.fillStyle = B; g.shadowColor = B; g.shadowBlur = r * 0.3;
    for (let i = 0; i < 14; i++) {                                                   // sun rays
      g.save(); g.rotate(i / 14 * Math.PI * 2); g.beginPath(); g.moveTo(r * 0.7, -r * 0.06); g.lineTo(r * 1.05, 0); g.lineTo(r * 0.7, r * 0.06); g.fill(); g.restore();
    }
    g.shadowBlur = 0; g.fillStyle = '#3b1608'; g.strokeStyle = B; g.lineWidth = r * 0.06;
    g.beginPath(); g.roundRect(-r * 0.4, -r * 0.6, r * 0.8, r * 1.2, r * 0.2); g.fill(); g.stroke();      // mask
    g.fillStyle = A; g.fillRect(-r * 0.3, -r * 0.35, r * 0.22, r * 0.14); g.fillRect(r * 0.08, -r * 0.35, r * 0.22, r * 0.14);
    g.fillStyle = B; g.fillRect(-r * 0.24, r * 0.1, r * 0.48, r * 0.26);
    g.fillStyle = '#3b1608'; for (let i = -1; i <= 1; i++) g.fillRect(i * r * 0.12 - r * 0.02, r * 0.1, r * 0.04, r * 0.26);
  } else {                                                                            // 'wave': synthwave sun over a grid
    const p = g.createLinearGradient(0, -r * 0.7, 0, r * 0.5);
    p.addColorStop(0, '#fff06a'); p.addColorStop(0.5, A); p.addColorStop(1, B);
    g.fillStyle = p; g.shadowColor = A; g.shadowBlur = r * 0.35;
    g.beginPath(); g.arc(0, -r * 0.1, r * 0.6, 0, 7); g.fill(); g.shadowBlur = 0;
    g.fillStyle = 'rgba(8,0,24,0.9)';
    for (let i = 0; i < 5; i++) g.fillRect(-r * 0.7, r * 0.05 + i * r * 0.1, r * 1.4, r * 0.02 + i * r * 0.012);
    g.strokeStyle = B; g.lineWidth = 2; g.globalAlpha = 0.9;
    for (let i = -5; i <= 5; i++) { g.beginPath(); g.moveTo(i * r * 0.1, r * 0.5); g.lineTo(i * r * 0.32, r * 0.95); g.stroke(); }
    for (let i = 0; i < 4; i++) { g.beginPath(); g.moveTo(-r, r * (0.55 + i * i * 0.03)); g.lineTo(r, r * (0.55 + i * i * 0.03)); g.stroke(); }
    g.globalAlpha = 1;
  }
  g.restore();
}

// Pinball playfield art, 512 x 1024. Fixture positions come from GP_PIN_LAYOUT.
function gpPaintPlayfield(cfg) {
  return gpPaintedTexture(512, 1024, (g, W, H) => {
    const rnd = rng(cfg.seed), A = gpCss(cfg.c1), B = gpCss(cfg.c2);
    const bg = g.createLinearGradient(0, 0, 0, H);
    bg.addColorStop(0, cfg.bg[1]); bg.addColorStop(1, cfg.bg[0]);
    g.fillStyle = bg; g.fillRect(0, 0, W, H);
    g.strokeStyle = gpCss(cfg.c1, 0.12); g.lineWidth = 3;
    for (let i = 1; i < 8; i++) { g.beginPath(); g.arc(W / 2, H * 0.38, i * 68, 0, 7); g.stroke(); }   // ripples round the bumpers
    gpSparkles(g, rnd, 110, W, H, '#ffffff');
    gpPaintEmblem(g, cfg.kind, W * 0.5, H * 0.60, 118, cfg.c1, cfg.c2);
    g.strokeStyle = A; g.lineWidth = 8; g.strokeRect(4, 4, W - 8, H - 8);                                // outer wall
    g.lineWidth = 5; g.strokeStyle = B;
    g.beginPath(); g.moveTo(W * 0.86, H * 0.92); g.lineTo(W * 0.86, H * 0.06); g.stroke();               // plunger lane
    const words = cfg.name.split(' ');
    gpTitle(g, words[0], W * 0.47, 122, 380, 78, ['#ffffff', A], '#080414', A);
    gpTitle(g, words.slice(1).join(' '), W * 0.47, 196, 380, 78, ['#ffffff', B], '#080414', B);
    for (const [nx, ny] of GP_PIN_LAYOUT.bumpers) {                                                       // bumper rings
      const grad = g.createRadialGradient(nx * W, ny * H, 20, nx * W, ny * H, 66);
      grad.addColorStop(0, gpCss(cfg.c1, 0.5)); grad.addColorStop(1, gpCss(cfg.c1, 0));
      g.fillStyle = grad; g.beginPath(); g.arc(nx * W, ny * H, 66, 0, 7); g.fill();
      g.strokeStyle = '#fff'; g.lineWidth = 4; g.beginPath(); g.arc(nx * W, ny * H, 50, 0, 7); g.stroke();
    }
    for (const [x0, y0, x1, y1, x2, y2] of GP_PIN_LAYOUT.slings) {                                        // slingshot decals
      g.strokeStyle = B; g.lineWidth = 6; g.beginPath(); g.moveTo(x0 * W, y0 * H); g.lineTo(x1 * W, y1 * H); g.lineTo(x2 * W, y2 * H); g.closePath(); g.stroke();
    }
    for (let i = 0; i < 6; i++) gpChevron(g, W * 0.5, H * (0.74 - i * 0.045), 26, i % 2 ? A : B, 7);      // centre lane arrows
    for (const nx of [0.18, 0.82]) for (let i = 0; i < 6; i++) {                                          // side lane inserts
      g.strokeStyle = gpCss(cfg.c2, 0.85); g.lineWidth = 4; g.beginPath(); g.arc(nx * W, H * (0.30 + i * 0.055), 15, 0, 7); g.stroke();
    }
    for (const nx of [0.35, 0.5, 0.65]) { g.strokeStyle = A; g.lineWidth = 4; g.beginPath(); g.arc(nx * W, H * 0.055, 15, 0, 7); g.stroke(); }
    g.font = gpPixelFont(16); g.fillStyle = gpCss(0xffffff, 0.75); g.textAlign = 'center'; g.textBaseline = 'middle';
    g.fillText(cfg.tag, W * 0.47, H * 0.955);
  });
}

// Backglass art, 512 x 568 (0.54 x 0.60 m).
function gpPaintBackglass(cfg) {
  return gpPaintedTexture(512, 568, (g, W, H) => {
    const rnd = rng(cfg.seed + 100), A = gpCss(cfg.c1), B = gpCss(cfg.c2);
    const bg = g.createLinearGradient(0, 0, 0, H);
    bg.addColorStop(0, cfg.bg[0]); bg.addColorStop(1, cfg.bg[1]);
    g.fillStyle = bg; g.fillRect(0, 0, W, H);
    g.save(); g.translate(W / 2, 330);                                                                   // sunburst
    for (let i = 0; i < 28; i += 2) {
      g.fillStyle = gpCss(i % 4 ? cfg.c1 : cfg.c2, 0.16);
      g.beginPath(); g.moveTo(0, 0); g.arc(0, 0, 520, i / 28 * Math.PI * 2, (i + 1) / 28 * Math.PI * 2); g.closePath(); g.fill();
    }
    g.restore();
    gpSparkles(g, rnd, 90, W, H, '#ffffff');
    gpPaintEmblem(g, cfg.kind, W / 2, 335, 175, cfg.c1, cfg.c2);
    const words = cfg.name.split(' ');
    gpTitle(g, words[0], W / 2, 84, 430, 92, ['#ffffff', A], '#0a0414', A);
    gpTitle(g, words.slice(1).join(' '), W / 2, 168, 430, 92, ['#ffffff', B], '#0a0414', B);
    g.fillStyle = '#04030a'; g.strokeStyle = A; g.lineWidth = 4;                                          // score window
    g.beginPath(); g.roundRect(60, 476, 392, 66, 12); g.fill(); g.stroke();
    g.textAlign = 'center'; g.textBaseline = 'middle';
    g.font = gpPixelFont(11); g.fillStyle = B; g.fillText('HI SCORE', W / 2, 493);
    g.font = gpPixelFont(24); g.fillStyle = '#ff9a1a'; g.shadowColor = '#ff6a00'; g.shadowBlur = 8;
    g.fillText('9,550,120', W / 2, 522); g.shadowBlur = 0;
  });
}

// Vinyl side decal, 768 x 256 (runs the length of the cabinet).
function gpPaintSideArt(cfg) {
  return gpPaintedTexture(768, 256, (g, W, H) => {
    const rnd = rng(cfg.seed + 200), A = gpCss(cfg.c1), B = gpCss(cfg.c2);
    g.fillStyle = '#0a0812'; g.fillRect(0, 0, W, H);
    g.fillStyle = A; g.beginPath(); g.moveTo(0, H * 0.75); g.lineTo(W * 0.55, 0); g.lineTo(W * 0.72, 0); g.lineTo(0, H); g.fill();
    g.fillStyle = B; g.beginPath(); g.moveTo(W, H * 0.2); g.lineTo(W * 0.45, H); g.lineTo(W * 0.3, H); g.lineTo(W, 0); g.fill();
    g.fillStyle = '#fff'; g.beginPath(); g.moveTo(W * 0.62, 0); g.lineTo(W * 0.66, 0); g.lineTo(W * 0.18, H); g.lineTo(W * 0.14, H); g.fill();
    gpSparkles(g, rnd, 60, W, H, '#ffffff');
    g.fillStyle = '#fff'; g.beginPath();                                                                 // lightning bolt
    g.moveTo(W * 0.5, H * 0.08); g.lineTo(W * 0.4, H * 0.5); g.lineTo(W * 0.47, H * 0.5); g.lineTo(W * 0.42, H * 0.92);
    g.lineTo(W * 0.58, H * 0.42); g.lineTo(W * 0.5, H * 0.42); g.lineTo(W * 0.56, H * 0.08); g.closePath(); g.fill();
    gpTitle(g, cfg.name, W * 0.5, H * 0.52, W * 0.8, 84, ['#ffffff', B], '#0a0414', A);
  });
}

// Claw machine marquee, 512 x 128.
function gpPaintMarquee(cfg) {
  return gpPaintedTexture(512, 128, (g, W, H) => {
    const A = gpCss(cfg.c1), B = gpCss(cfg.c2), rnd = rng(cfg.seed);
    const bg = g.createLinearGradient(0, 0, 0, H);
    bg.addColorStop(0, '#0a0616'); bg.addColorStop(1, gpCss(cfg.body, 1));
    g.fillStyle = bg; g.fillRect(0, 0, W, H);
    g.fillStyle = gpCss(cfg.c1, 0.28); g.beginPath(); g.moveTo(0, H); g.lineTo(150, 0); g.lineTo(200, 0); g.lineTo(50, H); g.fill();
    g.fillStyle = gpCss(cfg.c2, 0.28); g.beginPath(); g.moveTo(W, 0); g.lineTo(W - 150, H); g.lineTo(W - 200, H); g.lineTo(W - 50, 0); g.fill();
    gpSparkles(g, rnd, 50, W, H, '#ffffff');
    gpTitle(g, cfg.name, W / 2, H * 0.44, 340, 66, ['#ffffff', A], '#0a0414', A);
    g.font = gpPixelFont(13); g.fillStyle = B; g.textAlign = 'center'; g.textBaseline = 'middle';
    g.fillText(cfg.tag, W / 2, H * 0.83);
    for (const x of [58, W - 58]) {                                                                      // little claw icons
      g.strokeStyle = B; g.lineWidth = 5; g.lineCap = 'round';
      g.beginPath(); g.moveTo(x, 8); g.lineTo(x, 44); g.stroke();
      g.beginPath(); g.arc(x, 50, 9, 0, 7); g.stroke();
      for (const s of [-1, 1]) { g.beginPath(); g.moveTo(x + s * 8, 56); g.quadraticCurveTo(x + s * 34, 70, x + s * 18, 100); g.stroke(); }
    }
  });
}

// Claw machine lower-front vinyl, 512 x 352: stripes, stars and instructions (the prize door is a 3D part on top).
function gpPaintClawFront(cfg) {
  return gpPaintedTexture(512, 352, (g, W, H) => {
    const A = gpCss(cfg.c1), B = gpCss(cfg.c2), rnd = rng(cfg.seed + 300);
    g.fillStyle = gpCss(cfg.body, 1); g.fillRect(0, 0, W, H);
    for (let i = 0; i < 6; i++) {                                                                        // diagonal stripes
      g.fillStyle = i & 1 ? gpCss(cfg.c1, 0.55) : gpCss(cfg.c2, 0.55);
      g.beginPath(); g.moveTo(i * 110 - 90, H); g.lineTo(i * 110 + 10, 0); g.lineTo(i * 110 + 60, 0); g.lineTo(i * 110 - 40, H); g.fill();
    }
    gpSparkles(g, rnd, 60, W, H, '#ffffff');
    g.textAlign = 'center'; g.textBaseline = 'middle';
    gpTitle(g, 'WIN A PRIZE!', W * 0.62, 106, 330, 60, ['#ffffff', B], '#0a0414', B);
    g.font = gpPixelFont(15); g.fillStyle = '#fff'; g.fillText('1 PLAY = 1 TOKEN', W * 0.62, 178);
    g.fillStyle = A; g.fillText('SKILL TESTER', W * 0.62, 206);
    g.strokeStyle = '#fff'; g.lineWidth = 3;
    for (const [x, y] of [[W * 0.62, 280], [W * 0.62 - 92, 280], [W * 0.62 + 92, 280]]) { g.beginPath(); g.roundRect(x - 40, y - 26, 80, 52, 8); g.stroke(); }
    g.fillStyle = B; g.fillText('$', W * 0.62, 280);
    g.fillStyle = 'rgba(255,255,255,0.7)'; g.fillText('$', W * 0.62 - 92, 280); g.fillText('$', W * 0.62 + 92, 280);
  });
}

// Air hockey apron vinyl, 1024 x 56 (runs the length of the long sides).
function gpPaintApron(cfg) {
  return gpPaintedTexture(1024, 56, (g, W, H) => {
    g.fillStyle = '#0a0a14'; g.fillRect(0, 0, W, H);
    for (let i = 0; i < 24; i++) {
      g.fillStyle = gpCss(i & 1 ? cfg.c1 : cfg.c2, 0.75);
      g.beginPath(); g.moveTo(i * 44, H); g.lineTo(i * 44 + 20, 0); g.lineTo(i * 44 + 32, 0); g.lineTo(i * 44 + 12, H); g.fill();
    }
    for (const x of [W * 0.25, W * 0.75]) gpTitle(g, cfg.name, x, H / 2, 300, 40, ['#ffffff', gpCss(cfg.c1)], '#0a0414', gpCss(cfg.c1));
  });
}

// Air hockey surface, 512 x 1024: tiny air holes, glowing lines, faint logo.
function gpPaintHockey(cfg) {
  return gpPaintedTexture(512, 1024, (g, W, H) => {
    const A = gpCss(cfg.c1), B = gpCss(cfg.c2);
    const bg = g.createLinearGradient(0, 0, 0, H);
    bg.addColorStop(0, '#04101c'); bg.addColorStop(0.5, '#0a2038'); bg.addColorStop(1, '#04101c');
    g.fillStyle = bg; g.fillRect(0, 0, W, H);
    const glow = g.createRadialGradient(W / 2, H / 2, 10, W / 2, H / 2, 330);
    glow.addColorStop(0, gpCss(cfg.c1, 0.28)); glow.addColorStop(1, gpCss(cfg.c1, 0));
    g.fillStyle = glow; g.fillRect(0, 0, W, H);
    g.fillStyle = 'rgba(255,255,255,0.13)';                                                              // air holes
    for (let y = 8; y < H; y += 9) for (let x = 8 + ((y / 9) & 1) * 4.5; x < W; x += 9) g.fillRect(x, y, 2, 2);
    g.lineCap = 'round'; g.shadowColor = A; g.shadowBlur = 10; g.strokeStyle = A; g.lineWidth = 7;
    g.strokeRect(12, 12, W - 24, H - 24);
    g.beginPath(); g.moveTo(12, H / 2); g.lineTo(W - 12, H / 2); g.stroke();
    g.strokeStyle = B; g.shadowColor = B; g.beginPath(); g.arc(W / 2, H / 2, 82, 0, 7); g.stroke();
    g.beginPath(); g.arc(W / 2, 12, 122, 0, Math.PI); g.stroke();                                        // goal creases
    g.beginPath(); g.arc(W / 2, H - 12, 122, Math.PI, Math.PI * 2); g.stroke();
    g.fillStyle = B; g.beginPath(); g.arc(W / 2, H / 2, 12, 0, 7); g.fill();
    g.shadowBlur = 0;
    g.font = gpTitleFont(56); g.fillStyle = gpCss(0xffffff, 0.16); g.textAlign = 'center'; g.textBaseline = 'middle';
    g.save(); g.translate(W / 2, H * 0.27); g.rotate(Math.PI); g.fillText(cfg.name, 0, 0); g.restore();
    g.fillText(cfg.name, W / 2, H * 0.73);
  }, { anisotropy: 8 });
}

// Two soft diagonal glints for glass panes (drawn on black; used additively).
function gpGlareTexture() {
  return gpPaintedTexture(64, 128, (g, W, H) => {
    g.fillStyle = '#000'; g.fillRect(0, 0, W, H);
    for (const [x, w, a] of [[8, 14, 0.5], [34, 6, 0.3], [46, 3, 0.2]]) {
      const grad = g.createLinearGradient(x, 0, x + w, 0);
      grad.addColorStop(0, 'rgba(255,255,255,0)'); grad.addColorStop(0.5, `rgba(255,255,255,${a})`); grad.addColorStop(1, 'rgba(255,255,255,0)');
      g.fillStyle = grad; g.setTransform(1, 0, 0.55, 1, -0.55 * H * 0.5, 0); g.fillRect(x, 0, w, H); g.setTransform(1, 0, 0, 1, 0, 0);
    }
  });
}

// Soft radial falloff for neon light spilled on the carpet (used additively, tinted by vertex colour).
function gpSpillTexture() {
  return gpPaintedTexture(128, 128, (g, W, H) => {
    const grad = g.createRadialGradient(W / 2, H / 2, 0, W / 2, H / 2, W / 2);
    grad.addColorStop(0, '#fff'); grad.addColorStop(0.4, '#6a6a6a'); grad.addColorStop(1, '#000');
    g.fillStyle = grad; g.fillRect(0, 0, W, H);
  });
}

// ── Pinball machines ────────────────────────────────────────────────────────────────────────────
// Side-panel outline in machine space as [z, y] pairs: front-bottom, front-top, back-top, back-bottom.
function gpSidePoly() {
  const P = GP_PIN, top = (z) => P.pfOrigin[1] - (z - P.pfOrigin[2]) * Math.tan(P.tilt) + 0.095;
  return [[0.66, 0.62], [0.66, top(0.66)], [-0.70, top(-0.70)], [-0.70, 0.62]];
}

// Flat vinyl decal on one side panel (sign -1 = left of the player, +1 = right). UVs read left-to-right from outside.
function gpSideDecalGeo(sign) {
  const poly = gpSidePoly(), x = sign * 0.3415;
  const zs = poly.map((p) => p[0]), ys = poly.map((p) => p[1]);
  const z0 = Math.min(...zs), z1 = Math.max(...zs), y0 = Math.min(...ys), y1 = Math.max(...ys);
  const pos = [], uv = [], nor = [];
  for (const [z, y] of poly) {
    pos.push(x, y, z); nor.push(sign, 0, 0);
    uv.push(sign > 0 ? (z1 - z) / (z1 - z0) : (z - z0) / (z1 - z0), (y - y0) / (y1 - y0));
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  g.setIndex(sign > 0 ? [0, 2, 1, 0, 3, 2] : [0, 1, 2, 0, 2, 3]);
  return g;
}

// Playfield-space helper: normalised art coords -> metres on the playfield ([x, z] in the playfield frame).
const gpPfPos = (nx, ny) => [(nx - 0.5) * GP_PIN.pfW, (ny - 0.5) * GP_PIN.pfL];

// Extruded triangle lying on the playfield (slingshots). pts are [x, z] pairs in the playfield frame.
function gpTriangleGeo(pts, height) {
  const shape = new THREE.Shape(pts.map(([x, z]) => new THREE.Vector2(x, -z)));
  return new THREE.ExtrudeGeometry(shape, { depth: height, bevelEnabled: false }).rotateX(-Math.PI / 2);
}

function gpBuildPinball(zone, cfg) {
  const { solid, chrome, glow, glass, glare, floor } = zone;
  const P = GP_PIN, tan = Math.tan(P.tilt), { c1, c2 } = cfg;
  const F = gpXf([P.x, 0, cfg.z], [0, -Math.PI / 2, 0]);                          // machine frame: local +z = front (faces -x)
  const PF = F.clone().multiply(gpXf(P.pfOrigin, [P.tilt, 0, 0]));                // playfield frame: +y = surface normal
  const black = 0x0c0c14, sideTopY = (z) => P.pfOrigin[1] - (z - P.pfOrigin[2]) * tan + 0.095;

  // Cabinet shell: side panels with vinyl decals, chrome rails, boards, legs.
  const decals = [];
  for (const s of [-1, 1]) {
    solid.add(GP_GEO.pinSide, F.clone().multiply(gpXf([s > 0 ? 0.32 : -0.34, 0, 0])), black);
    decals.push(gpSideDecalGeo(s).applyMatrix4(F));
    chrome.beam(F, [s * 0.33, sideTopY(0.66) + 0.008, 0.66], [s * 0.33, sideTopY(-0.70) + 0.008, -0.70], 0.03, 0.016);
  }
  const sideTex = gpPaintSideArt(cfg);
  const sideMat = new THREE.MeshStandardMaterial({ map: sideTex, emissiveMap: sideTex, emissive: 0xffffff, emissiveIntensity: 0.55, roughness: 0.35, envMap: GP_MAT.envMap, envMapIntensity: 0.6 });
  scene.add(new THREE.Mesh(GpBGU.mergeGeometries(decals), sideMat));
  solid.box(F, [0.64, 0.02, 1.36], [0, 0.63, -0.02], black);                                             // bottom
  solid.box(F, [0.62, 0.225, 0.02], [0, 0.7325, 0.65], black);                                           // front board
  solid.box(F, [0.62, 0.42, 0.02], [0, 0.83, -0.69], black);                                             // rear board
  chrome.box(F, [0.68, 0.04, 0.055], [0, 0.875, 0.645]);                                                 // lockdown bar
  glow.box(F, [0.6, 0.008, 0.006], [0, 0.81, 0.662], c1, 1.6);
  for (const sx of [-1, 1]) for (const lz of [0.58, -0.6]) {
    chrome.box(F, [0.05, 0.62, 0.05], [sx * 0.27, 0.31, lz]);                                            // legs
    solid.cyl(F, 0.03, 0.025, [sx * 0.27, 0.0125, lz], black);                                           // levelers
  }

  // Coin door, start button, flipper buttons, plunger.
  chrome.box(F, [0.24, 0.13, 0.012], [0, 0.72, 0.662]);
  for (const sx of [-1, 1]) {
    solid.box(F, [0.02, 0.055, 0.014], [sx * 0.045, 0.72, 0.666], 0x050508);
    glow.box(F, [0.034, 0.008, 0.016], [sx * 0.045, 0.765, 0.667], NEON.red, 1.6);
    const y = sideTopY(0.4) - 0.06;                                                                       // flipper buttons on the rails
    chrome.cyl(F, 0.013, 0.034, [sx * 0.355, y, 0.4], 0xffffff, 1, [0, 0, Math.PI / 2]);
    glow.cyl(F, 0.017, 0.01, [sx * 0.375, y, 0.4], c1, 1.6, [0, 0, Math.PI / 2]);
  }
  chrome.cyl(F, 0.03, 0.01, [0.2, 0.795, 0.665], 0xffffff, 1, [Math.PI / 2, 0, 0]);
  glow.cyl(F, 0.022, 0.016, [0.2, 0.795, 0.672], c2, 1.8, [Math.PI / 2, 0, 0]);                          // start button
  chrome.wire(PF, [0.265, 0.02, 0.56], [0.265, 0.02, 0.70], 0.007);                                      // plunger
  solid.ball(PF, 0.017, [0.265, 0.02, 0.715], 0xd41f2a);

  // Playfield: art plane, glass cover and a glint.
  const pfTex = gpPaintPlayfield(cfg);
  const pfMat = new THREE.MeshStandardMaterial({ map: pfTex, emissiveMap: pfTex, emissive: 0xffffff, emissiveIntensity: 0.5, roughness: 0.25, envMap: GP_MAT.envMap, envMapIntensity: 0.6 });
  gpArtMesh(GP_GEO.flat, PF.clone().multiply(gpXf([0, 0, 0], [0, 0, 0], [P.pfW, 1, P.pfL])), pfMat);
  glass.add(GP_GEO.flat, PF.clone().multiply(gpXf([0, 0.09, 0], [0, 0, 0], [0.61, 1, P.pfL + 0.03])));
  glare.add(GP_GEO.flat, PF.clone().multiply(gpXf([0, 0.092, 0], [0, 0, 0], [0.56, 1, 1.1])), 0xffffff, 0.55);

  // Playfield fixtures: pop bumpers, flippers, slingshots, posts, guide wires, ramp, targets, ball.
  GP_PIN_LAYOUT.bumpers.forEach(([nx, ny], i) => {
    const [x, z] = gpPfPos(nx, ny);
    solid.cyl(PF, 0.042, 0.026, [x, 0.013, z], 0x14141c);
    chrome.cyl(PF, 0.037, 0.012, [x, 0.03, z]);
    glow.cyl(PF, 0.027, 0.02, [x, 0.04, z], i === 0 ? c2 : c1, 1.8);
    chrome.ball(PF, 0.013, [x, 0.052, z], 0xffffff, 1, 0.5);
  });
  for (const [px, py, tx, ty] of GP_PIN_LAYOUT.flippers) {
    const [x0, z0] = gpPfPos(px, py), [x1, z1] = gpPfPos(tx, ty);
    solid.wire(PF, [x0, 0.016, z0], [x1, 0.016, z1], 0.013, 0xf2f2f2);
    solid.ball(PF, 0.02, [x0, 0.016, z0], 0xf2f2f2);
    chrome.ball(PF, 0.008, [x0, 0.03, z0], 0xffffff);
  }
  for (const [ax, ay, bx, by, cx, cy] of GP_PIN_LAYOUT.slings) {
    const tri = gpTriangleGeo([gpPfPos(ax, ay), gpPfPos(bx, by), gpPfPos(cx, cy)], 0.022);
    solid.add(tri, PF, c2, 0.45);
    const [x0, z0] = gpPfPos(ax, ay), [x1, z1] = gpPfPos(cx, cy);
    glow.beam(PF, [x0, 0.024, z0], [x1, 0.024, z1], 0.006, 0.006, c2, 1.8);                              // lit sling edge
    tri.dispose();
    const [fx, fz] = gpPfPos(ax < 0.5 ? 0.345 : 0.655, 0.865);                                            // inlane guide to the flipper
    chrome.wire(PF, [x1, 0.02, z1], [fx, 0.02, fz - 0.02], 0.004);
  }
  for (const [nx, ny] of [[0.10, 0.60], [0.90, 0.60], [0.30, 0.55], [0.70, 0.55], [0.5, 0.20], [0.42, 0.47], [0.58, 0.47]]) {
    const [x, z] = gpPfPos(nx, ny);
    chrome.cyl(PF, 0.007, 0.03, [x, 0.015, z]);                                                          // rubber posts
  }
  for (const s of [-1, 1]) {                                                                              // top corner arches
    let prev = null;
    for (let i = 0; i <= 8; i++) {
      const a = i / 8 * Math.PI / 2, p = [s * (0.09 + 0.2 * Math.cos(a)), 0.02, -0.45 - 0.17 * Math.sin(a)];
      if (prev) chrome.wire(PF, prev, p, 0.004);
      prev = p;
    }
  }
  chrome.beam(PF, [0.245, 0.016, 0.60], [0.245, 0.016, -0.45], 0.007, 0.032);                            // plunger lane wall
  const ramp = [[-0.13, 0.004, 0.10], [-0.16, 0.078, -0.30]];
  solid.beam(PF, ramp[0], ramp[1], 0.09, 0.008, c1, 0.5);
  for (const sx of [-0.045, 0.045]) glow.beam(PF, [ramp[0][0] + sx, ramp[0][1] + 0.008, ramp[0][2]], [ramp[1][0] + sx, ramp[1][1] + 0.008, ramp[1][2]], 0.008, 0.012, c1, 1.8);
  for (let i = 0; i < 3; i++) glow.box(PF, [0.012, 0.03, 0.032], [-0.265, 0.015, -0.04 + i * 0.07], c2, 1.5);   // stand-up targets
  chrome.ball(PF, 0.0135, [0.10, 0.0135, 0.36]);                                                           // the ball

  // Backbox: body, header, speaker panel with lit strips, and the backglass.
  solid.box(F, [0.6, 0.92, 0.24], [0, 1.5, -0.58], black);
  solid.box(F, [0.62, 0.04, 0.26], [0, 1.96, -0.58], 0x101018);
  glow.box(F, [0.58, 0.012, 0.006], [0, 1.938, -0.457], c1, 2.2);
  glow.box(F, [0.58, 0.012, 0.006], [0, 1.306, -0.457], c2, 2.2);
  for (const sx of [-1, 1]) {
    chrome.box(F, [0.014, 0.66, 0.26], [sx * 0.307, 1.63, -0.58]);
    chrome.torus(F, 0.075, [sx * 0.14, 1.17, -0.464], 0xffffff, 1);
    chrome.cyl(F, 0.06, 0.006, [sx * 0.14, 1.17, -0.462], 0x2a2a34, 1, [Math.PI / 2, 0, 0]);
  }
  solid.box(F, [0.5, 0.2, 0.006], [0, 1.17, -0.461], 0x15151d);
  const bgTex = gpPaintBackglass(cfg);
  gpArtMesh(new THREE.PlaneGeometry(0.54, 0.6), F.clone().multiply(gpXf([0, 1.63, -0.4585])),
    new THREE.MeshBasicMaterial({ map: bgTex, color: new THREE.Color(1.25, 1.25, 1.25) }));
  glare.add(GP_GEO.flat, F.clone().multiply(gpXf([0, 1.632, -0.455], [Math.PI / 2, 0, 0], [0.5, 1, 0.58])), 0xffffff, 0.3);

  // Lamps: chasing border on the backglass, arrows / lane inserts on the playfield.
  const border = gpPerimeter(0.5, 0.56, 36);
  border.forEach(([x, y], k) => gpAddLamp(F.clone().multiply(gpXf([x, 1.63 + y, -0.4565], [0, 0, 0], [0.011, 0.011, 1])), 0, k, 6, k & 1 ? c2 : c1));
  const inserts = (nx, ny, kind, k, gap, color) => {
    const [x, z] = gpPfPos(nx, ny);
    gpAddLamp(PF.clone().multiply(gpXf([x, 0.003, z], [-Math.PI / 2, 0, 0], [0.012, 0.012, 1])), kind, k, gap, color);
  };
  for (let i = 0; i < 6; i++) inserts(0.5, 0.74 - i * 0.045, 0, i, 6, i & 1 ? c1 : c2);
  for (const nx of [0.18, 0.82]) for (let i = 0; i < 6; i++) inserts(nx, 0.30 + i * 0.055, 1, i + (nx > 0.5 ? 1 : 0), 2, c2);
  [0.35, 0.5, 0.65].forEach((nx, i) => inserts(nx, 0.055, 1, i, 2, c1));
  inserts(0.5, 0.80, 2, 0, 1, c2);

  // Carpet glow, collider, registry.
  floor.add(GP_GEO.flat, F.clone().multiply(gpXf([0, 0.005, 0.1], [0, 0, 0], [1.3, 1, 2.2])), c1, 0.55);
  addCollider(P.x - 0.70, P.x + 0.70, cfg.z - 0.345, cfg.z + 0.345);
  registry.props.push({ kind: 'pinball', x: P.x, z: cfg.z, color: c1, name: cfg.name });
}

// ── Claw machines ───────────────────────────────────────────────────────────────────────────────
// Geometry of the claw itself: hub plus three jointed arms. Origin = top of the hub; hangs 0.17 m below it.
function gpClawGeometry() {
  const b = new GpBatch(), I = new THREE.Matrix4();
  b.cyl(I, 0.036, 0.05, [0, -0.025, 0], 0xffffff);
  b.cyl(I, 0.012, 0.03, [0, 0.015, 0], 0x9a9aa8);
  for (let i = 0; i < 3; i++) {
    const R = gpXf([0, 0, 0], [0, i * Math.PI * 2 / 3, 0]);
    b.wire(R, [0.03, -0.045, 0], [0.078, -0.095, 0], 0.0075, 0xffffff);
    b.wire(R, [0.078, -0.095, 0], [0.05, -0.172, 0], 0.0065, 0xffffff);
    b.ball(R, 0.011, [0.05, -0.172, 0], 0xffb020);
  }
  return b.geometry();
}

function gpBuildClaw(zone, cfg, index) {
  const { solid, chrome, glow, glass, glare, floor } = zone;
  const F = gpXf([cfg.x, 0, GP_CLAW_Z], [0, Math.PI, 0]);                         // faces -z
  const { c1, c2 } = cfg, K = GP_CLAW;

  // Lower cabinet, deck and the front details.
  solid.box(F, [0.9, 0.72, 0.85], [0, 0.36, -0.025], cfg.body);
  solid.box(F, [0.92, 0.07, 0.22], [0, 0.755, 0.43], 0x16161f, 1, [0.12, 0, 0]);                        // control deck
  const frontTex = gpPaintClawFront(cfg);                                                                // vinyl on the lower front
  gpArtMesh(new THREE.PlaneGeometry(0.9, 0.62), F.clone().multiply(gpXf([0, 0.4, 0.4015])),
    new THREE.MeshStandardMaterial({ map: frontTex, emissiveMap: frontTex, emissive: 0xffffff, emissiveIntensity: 0.6, roughness: 0.4, envMap: GP_MAT.envMap, envMapIntensity: 0.5 }));
  glow.box(F, [0.9, 0.012, 0.006], [0, 0.6, 0.404], c1, 2);                                              // front accent lines
  glow.box(F, [0.9, 0.012, 0.006], [0, 0.1, 0.404], c2, 2);
  chrome.cyl(F, 0.033, 0.012, [-0.2, 0.8, 0.45]);                                                        // joystick
  chrome.wire(F, [-0.2, 0.805, 0.45], [-0.2, 0.9, 0.44], 0.008);
  solid.ball(F, 0.03, [-0.2, 0.93, 0.437], 0xe8202e);
  chrome.cyl(F, 0.05, 0.012, [0.05, 0.8, 0.45]);                                                         // big button
  glow.cyl(F, 0.04, 0.024, [0.05, 0.808, 0.45], c2, 1.5);
  solid.box(F, [0.055, 0.1, 0.02], [0.3, 0.775, 0.535], 0x050508);                                       // coin slot
  glow.box(F, [0.008, 0.06, 0.006], [0.3, 0.775, 0.547], NEON.yellow, 1.8);
  chrome.box(F, [0.28, 0.22, 0.012], [-0.26, 0.3, 0.404]);                                               // prize door frame
  solid.box(F, [0.24, 0.18, 0.016], [-0.26, 0.3, 0.408], 0x040408);
  glow.box(F, [0.24, 0.012, 0.006], [-0.26, 0.42, 0.418], c2, 1.8);

  // Play area: floor, back wall with lit stripes, chute glow, corner posts, rails, marquee box.
  solid.box(F, [0.86, 0.02, 0.8], [0, 0.79, -0.02], 0x261a44);
  solid.box(F, [0.86, 0.93, 0.02], [0, 1.255, -0.42], cfg.body, 0.8);
  glow.box(F, [0.86, 0.014, 0.004], [0, 0.98, -0.408], c1, 1.2);                                          // lit bands on the back wall
  glow.box(F, [0.86, 0.014, 0.004], [0, 1.58, -0.408], c2, 1.2);
  gpArtMesh(new THREE.PlaneGeometry(0.86, 0.593), F.clone().multiply(gpXf([0, 1.28, -0.4085])),          // printed backdrop (reuses the front vinyl)
    new THREE.MeshBasicMaterial({ map: frontTex, color: new THREE.Color(0.85, 0.85, 0.85) }));
  glow.box(F, [0.24, 0.004, 0.22], [-0.28, 0.802, 0.25], c2, 0.7);                                       // chute opening
  for (const sx of [-1, 1]) for (const lz of [0.36, -0.4]) {
    solid.box(F, [0.05, 0.93, 0.05], [sx * 0.43, 1.255, lz], c1, 0.6);                                   // corner posts
    glow.box(F, [0.008, 0.9, 0.008], [sx * 0.405, 1.255, lz], c1, 2.2);
    chrome.box(F, [0.02, 0.02, 0.72], [sx * 0.405, 1.62, -0.02]);                                        // gantry rails
  }
  chrome.box(F, [0.9, 0.035, 0.05], [0, 1.705, 0.385]);
  chrome.box(F, [0.9, 0.035, 0.05], [0, 0.812, 0.385]);
  for (const sx of [-1, 1]) chrome.box(F, [0.05, 0.035, 0.85], [sx * 0.43, 1.705, -0.02]);
  solid.box(F, [0.92, 0.27, 0.88], [0, 1.845, -0.02], 0x0c0c14);                                         // marquee box
  glow.box(F, [0.9, 0.014, 0.006], [0, 1.712, 0.42], c1, 2.4);
  glow.box(F, [0.9, 0.014, 0.006], [0, 1.978, 0.42], c2, 2.4);
  glow.box(F, [0.8, 0.006, 0.72], [0, 1.693, -0.02], 0xfff4e0, 1.1);                                     // interior LED panel
  gpArtMesh(new THREE.PlaneGeometry(0.88, 0.235), F.clone().multiply(gpXf([0, 1.84, 0.4215])),
    new THREE.MeshBasicMaterial({ map: gpPaintMarquee(cfg), color: new THREE.Color(1.15, 1.15, 1.15) }));

  // Glass panes with a glint on the front, plus carpet glow.
  glass.box(F, [0.82, 0.88, 0.006], [0, 1.255, 0.39], 0xffffff);
  for (const sx of [-1, 1]) glass.box(F, [0.006, 0.88, 0.78], [sx * 0.435, 1.255, -0.02], 0xffffff);
  glare.add(GP_GEO.flat, F.clone().multiply(gpXf([0, 1.255, 0.395], [Math.PI / 2, 0, 0], [0.8, 1, 0.86])), 0xffffff, 0.45);
  floor.add(GP_GEO.flat, F.clone().multiply(gpXf([0, 0.005, 0.45], [0, 0, 0], [1.9, 1, 1.7])), c1, 0.5);

  // Bulb border round the marquee.
  gpPerimeter(0.84, 0.21, 34).forEach(([x, y], k) =>
    gpAddLamp(F.clone().multiply(gpXf([x, 1.84 + y, 0.4235], [0, 0, 0], [0.011, 0.011, 1])), 0, k, 5, k & 1 ? c2 : c1));

  gpAddPrizes(F, cfg.seed);
  const c = { idx: index, fx: cfg.x, fz: GP_CLAW_Z, x: 0, z: 0, y: K.restY, s: 1, rnd: rng(cfg.seed * 7), keys: null, i: 0, t: 0, win: false, start: [0, 0, K.restY, 1] };
  gpPlanClaw(c);
  c.i = 7; c.t = c.rnd() * 3;                                                                              // start staggered, resting
  gpClaws.push(c);
  addCollider(cfg.x - 0.45, cfg.x + 0.45, GP_CLAW_Z - 0.55, GP_CLAW_Z + 0.45);
  registry.props.push({ kind: 'claw', x: cfg.x, z: GP_CLAW_Z, color: c1, name: cfg.name });
}

// ── Claw prizes (four shared InstancedMeshes) ───────────────────────────────────────────────────
const gpPrizeLists = { sphere: [], capsule: [], box: [], cone: [] };

// Scatters a heap of prizes over the play-area floor in machine frame F (chute corner left clear).
function gpAddPrizes(F, seed) {
  const r = rng(seed * 13), kinds = ['sphere', 'capsule', 'box', 'cone'];
  const place = (x, y, z, size) => {
    const kind = kinds[Math.floor(r() * 4)];
    const stretch = kind === 'capsule' ? [size, size * 1.1, size] : kind === 'sphere' ? [size, size * 0.92, size] : [size * 1.5, size * 1.5, size * 1.5];
    const m = F.clone().multiply(gpXf([x, y, z], [r() * 6.28, r() * 6.28, r() * 6.28], stretch));
    gpPrizeLists[kind].push({ m, color: GP_PRIZE_COLORS[Math.floor(r() * GP_PRIZE_COLORS.length)] });
  };
  for (let gx = 0; gx < 7; gx++) for (let gz = 0; gz < 6; gz++) {
    const x = -0.36 + gx * 0.12 + (r() - 0.5) * 0.04, z = -0.34 + gz * 0.11 + (r() - 0.5) * 0.04;
    if (x < -0.14 && z > 0.08) continue;                                                                    // keep the chute clear
    const s = 0.048 + r() * 0.02;
    place(x, 0.8 + s, z, s);
    if (z < 0.16 && r() < 0.65) place(x + 0.05, 0.8 + s * 2.2, z + 0.03, 0.046 + r() * 0.02);
    if (z < 0.0 && r() < 0.3) place(x, 0.8 + s * 3.7, z + 0.04, 0.045 + r() * 0.015);
  }
}

// Builds the prize InstancedMeshes plus the claw gantry parts (bridge / carriage / cable / claw / carried prize).
function gpBuildClawMachinery() {
  const shapes = {
    sphere: new THREE.SphereGeometry(1, 10, 7),
    capsule: new THREE.CapsuleGeometry(1, 0.9, 3, 8),
    box: new THREE.BoxGeometry(1, 1, 1),
    cone: new THREE.ConeGeometry(1, 1.8, 9),
  };
  const color = new THREE.Color();
  for (const [kind, list] of Object.entries(gpPrizeLists)) {
    const mesh = new THREE.InstancedMesh(shapes[kind], GP_MAT.prize, list.length);
    list.forEach(({ m, color: hex }, i) => { mesh.setMatrixAt(i, m); mesh.setColorAt(i, color.setHex(hex)); });
    scene.add(mesh);
  }
  const n = GP_CLAWS.length, I = new THREE.Matrix4();
  const make = (geo, mat) => { const m = new THREE.InstancedMesh(geo, mat, n); m.frustumCulled = false; scene.add(m); return m; };
  const bridge = new GpBatch().box(I, [0.84, 0.03, 0.05], [0, 0, 0], 0xffffff).geometry();
  const carriage = new GpBatch().box(I, [0.13, 0.07, 0.1], [0, 0, 0], 0x2e2e3c).box(I, [0.05, 0.02, 0.102], [0, 0.0, 0], NEON.yellow, 0.6).geometry();
  const cable = new GpBatch().wire(I, [0, -0.5, 0], [0, 0.5, 0], 0.004, 0x30303c).geometry();
  const carried = new THREE.InstancedMesh(shapes.sphere, GP_MAT.prize, n);
  carried.frustumCulled = false; scene.add(carried);
  gpClawMeshes = { bridge: make(bridge, GP_MAT.chrome), carriage: make(carriage, GP_MAT.solid), cable: make(cable, GP_MAT.solid), claw: make(gpClawGeometry(), GP_MAT.chrome), carried };
  gpClaws.forEach((c) => { carried.setColorAt(c.idx, color.setHex(GP_PRIZE_COLORS[(c.idx * 3 + 1) % GP_PRIZE_COLORS.length])); gpWriteClaw(c, 0, 0); });
}

// Fills a new play cycle for one claw: [duration, x, z, y, scale] keyframes (machine space).
function gpPlanClaw(c) {
  const r = c.rnd, K = GP_CLAW, tx = (r() - 0.5) * 0.56, tz = -0.26 + r() * 0.36;
  c.win = r() < 0.55;
  c.keys = [
    [2.6 + r() * 2, tx, tz, K.restY, 1],                 // 0 wander over the heap
    [0.5, tx, tz, K.restY, 1],                           // 1 line up
    [1.5, tx, tz, K.dropY, 1],                           // 2 descend
    [0.7, tx, tz, K.dropY, K.closed],                    // 3 close
    [1.5, tx, tz, K.restY, K.closed],                    // 4 lift
    [2.6, K.chuteX, K.chuteZ, K.restY, K.closed],        // 5 carry to the chute
    [0.8, K.chuteX, K.chuteZ, K.restY, 1],               // 6 open, prize drops
    [7 + r() * 9, K.chuteX, K.chuteZ, K.restY, 1],       // 7 rest (long timer)
  ];
  c.i = 0; c.t = 0;
  c.start[0] = c.x; c.start[1] = c.z; c.start[2] = c.y; c.start[3] = c.s;
}

// Writes one machine's gantry instances (machine space -> world: rotated half a turn, so x and z are negated).
// `drop` is the 0..1 progress of the prize falling into the chute; `carry` is 1 while the claw holds a prize.
function gpWriteClaw(c, carry, drop) {
  const K = GP_CLAW, M = gpClawMeshes, wx = c.fx - c.x, wz = c.fz - c.z, id = _gpQuat.identity();
  const put = (mesh, px, py, pz, sx, sy, sz) => {
    mesh.setMatrixAt(c.idx, _gpMat.compose(_gpPos.set(px, py, pz), id, _gpScl.set(sx, sy, sz)));
    mesh.instanceMatrix.needsUpdate = true;
  };
  put(M.bridge, c.fx, K.bridgeY, c.fz - c.z, 1, 1, 1);
  put(M.carriage, wx, K.carriageY, wz, 1, 1, 1);
  const cableLen = K.cableTop - c.y;
  put(M.cable, wx, (K.cableTop + c.y) / 2, wz, 1, cableLen, 1);
  put(M.claw, wx, c.y, wz, c.s, 1, c.s);
  const holdY = c.y - 0.13, fallY = holdY - drop * drop * (holdY - 0.86);
  const size = carry && drop < 1 ? 0.055 : 0.0001;
  put(M.carried, wx, fallY, wz, size, size, size);
}

// Advances every claw's keyframe timeline; only touches the GPU buffers while something is actually moving.
function gpUpdateClaws(dt) {
  for (const c of gpClaws) {
    const key = c.keys[c.i], st = c.start;
    c.t += dt;
    const p = Math.min(1, c.t / key[0]);
    const dropping = c.win && c.i === 6;
    if (st[0] !== key[1] || st[1] !== key[2] || st[2] !== key[3] || st[3] !== key[4] || dropping) {
      const e = p * p * (3 - 2 * p);
      c.x = st[0] + (key[1] - st[0]) * e; c.z = st[1] + (key[2] - st[1]) * e;
      c.y = st[2] + (key[3] - st[2]) * e; c.s = st[3] + (key[4] - st[3]) * e;
      const carry = c.win && c.i >= 4 && c.i <= 6 ? 1 : 0;
      gpWriteClaw(c, carry, dropping ? Math.min(1, c.t / 0.5) : 0);
    }
    if (c.t >= key[0]) {                                                                                     // key finished
      c.t = 0; c.x = key[1]; c.z = key[2]; c.y = key[3]; c.s = key[4];
      c.start[0] = c.x; c.start[1] = c.z; c.start[2] = c.y; c.start[3] = c.s;
      if (++c.i >= c.keys.length) gpPlanClaw(c);
    }
  }
}

// ── Air hockey ──────────────────────────────────────────────────────────────────────────────────
function gpBuildAirHockey(zone, cfg) {
  const { solid, chrome, glow, floor } = zone;
  const F = gpXf([cfg.x, 0, cfg.z]), { c1, c2 } = cfg;
  const rim = 0x121c30;

  // Body, legs, rim with LED strips, goal slots.
  solid.box(F, [1.22, 0.16, 2.12], [0, 0.68, 0], 0x12121c);
  for (const sx of [-1, 1]) for (const sz of [-1, 1]) {
    solid.box(F, [0.09, 0.62, 0.09], [sx * 0.5, 0.31, sz * 0.95], 0x1a1a26);
    chrome.cyl(F, 0.05, 0.02, [sx * 0.5, 0.01, sz * 0.95]);
    chrome.box(F, [0.1, 0.1, 0.1], [sx * 0.57, 0.72, sz * 1.02]);                                        // corner caps
  }
  glow.box(F, [1.22, 0.008, 0.006], [0, 0.605, 1.064], c2, 1.8);
  glow.box(F, [1.22, 0.008, 0.006], [0, 0.605, -1.064], c2, 1.8);
  const apronTex = gpPaintApron(cfg), apronDecals = [];                                                    // vinyl on the long sides
  for (const sx of [-1, 1]) apronDecals.push(new THREE.PlaneGeometry(2.1, 0.12).applyMatrix4(F.clone().multiply(gpXf([sx * 0.6125, 0.685, 0], [0, sx * Math.PI / 2, 0]))));
  scene.add(new THREE.Mesh(GpBGU.mergeGeometries(apronDecals),
    new THREE.MeshStandardMaterial({ map: apronTex, emissiveMap: apronTex, emissive: 0xffffff, emissiveIntensity: 0.6, roughness: 0.35, envMap: GP_MAT.envMap, envMapIntensity: 0.5 })));
  for (const sx of [-1, 1]) {
    glow.box(F, [0.006, 0.008, 2.12], [sx * 0.613, 0.605, 0], c2, 1.8);
    solid.box(F, [0.06, 0.06, 2.12], [sx * 0.57, 0.79, 0], rim);
    glow.box(F, [0.02, 0.008, 2.0], [sx * 0.57, 0.824, 0], c1, 2.6);
  }
  for (const sz of [-1, 1]) {
    for (const sx of [-1, 1]) {
      solid.box(F, [0.45, 0.06, 0.06], [sx * 0.375, 0.79, sz * 1.03], rim);
      glow.box(F, [0.4, 0.008, 0.02], [sx * 0.375, 0.824, sz * 1.03], c1, 2.6);
    }
    solid.box(F, [0.3, 0.05, 0.1], [0, 0.735, sz * 1.06], 0x030308);                                    // goal slot
    glow.box(F, [0.3, 0.006, 0.02], [0, 0.762, sz * 1.05], c2, 1.5);
  }

  // Playing surface and mallets.
  const tex = gpPaintHockey(cfg);
  const mat = new THREE.MeshStandardMaterial({ map: tex, emissiveMap: tex, emissive: 0xffffff, emissiveIntensity: 0.55, roughness: 0.18, envMap: GP_MAT.envMap, envMapIntensity: 0.7 });
  gpArtMesh(GP_GEO.flat, F.clone().multiply(gpXf([0, 0.7605, 0], [0, 0, 0], [1.08, 1, 2.0])), mat);
  [[-0.16, 0.6, cfg.m1], [0.18, -0.6, cfg.m2]].forEach(([x, z, color]) => {
    solid.cyl(F, 0.055, 0.014, [x, 0.767, z], color);
    solid.cyl(F, 0.02, 0.04, [x, 0.79, z], color, 0.8);
    solid.ball(F, 0.034, [x, 0.815, z], color, 1, 0.55);
    glow.torus(F, 0.052, [x, 0.775, z], color, 1.2);
  });

  // Puck (its own mesh so it can slide) and carpet glow.
  const puck = new THREE.Mesh(new THREE.CylinderGeometry(0.04, 0.04, 0.009, 24),
    new THREE.MeshStandardMaterial({ color: c2, emissive: c2, emissiveIntensity: 0.9, roughness: 0.3 }));
  puck.position.set(cfg.x, 0.766, cfg.z);
  scene.add(puck);
  gpPucks.push({ mesh: puck, cx: cfg.x, cz: cfg.z, x: 0, z: 0, x0: 0, z0: 0, dx: 0, dz: 1, speed: 0, t: 0, wait: 2 + gpPucks.length * 3.5, rnd: rng(cfg.seed) });
  floor.add(GP_GEO.flat, F.clone().multiply(gpXf([0, 0.005, 0], [0, 0, 0], [2.0, 1, 3.1])), c1, 0.45);

  addCollider(cfg.x - 0.62, cfg.x + 0.62, cfg.z - 1.08, cfg.z + 1.08);
  registry.props.push({ kind: 'airhockey', x: cfg.x, z: cfg.z, color: c1, name: cfg.name });
}

// Reflects v back and forth inside [lo, hi] (a puck bouncing off the rims).
function gpBounce(v, lo, hi) {
  const range = hi - lo, m = (((v - lo) % (2 * range)) + 2 * range) % (2 * range);
  return lo + (m > range ? 2 * range - m : m);
}

// Every few seconds a puck is shot from where it rests and slows to a stop; between rallies nothing runs.
function gpUpdatePucks(dt) {
  for (const p of gpPucks) {
    if (p.wait > 0) {
      p.wait -= dt;
      if (p.wait > 0) continue;
      const a = p.rnd() * Math.PI * 2;                                                                    // start a new rally
      p.dx = Math.sin(a); p.dz = Math.cos(a); p.speed = 3.2 + p.rnd() * 2.4; p.t = 0; p.x0 = p.x; p.z0 = p.z;
    }
    p.t += dt;
    const travelled = p.speed / 2.6 * (1 - Math.exp(-2.6 * Math.min(p.t, 2.4)));
    p.x = gpBounce(p.x0 + p.dx * travelled, -0.5, 0.5);
    p.z = gpBounce(p.z0 + p.dz * travelled, -0.94, 0.94);
    p.mesh.position.set(p.cx + p.x, 0.766, p.cz + p.z);
    if (p.t >= 2.4) p.wait = 5 + p.rnd() * 7;
  }
}

// ── Stools & bench ──────────────────────────────────────────────────────────────────────────────
function gpBuildStool(zone, x, z, color) {
  const { solid, chrome, glow } = zone, F = gpXf([x, 0, z]);
  chrome.cyl(F, 0.2, 0.02, [0, 0.01, 0]);
  chrome.cyl(F, 0.022, 0.5, [0, 0.27, 0]);
  chrome.torus(F, 0.14, [0, 0.24, 0]);
  chrome.wire(F, [0.14, 0.24, 0], [0.02, 0.3, 0], 0.005);
  solid.cyl(F, 0.18, 0.07, [0, 0.625, 0], color, 0.55);
  solid.cyl(F, 0.15, 0.03, [0, 0.665, 0], color, 0.5);
  glow.cyl(F, 0.183, 0.012, [0, 0.6, 0], color, 1.8);
  addCollider(x - 0.2, x + 0.2, z - 0.2, z + 0.2);
}

function gpBuildBench(zone, cfg) {
  const { solid, chrome, glow } = zone, F = gpXf([cfg.x, 0, cfg.z], [0, -Math.PI / 2, 0]), L = cfg.length;
  const cushions = 3, w = (L - 0.06) / cushions;
  solid.box(F, [L, 0.04, 0.42], [0, 0.4, 0], 0x14141c);
  for (let i = 0; i < cushions; i++) {                                                                    // tufted vinyl cushions
    const x = -L / 2 + 0.03 + w * (i + 0.5);
    solid.box(F, [w - 0.025, 0.07, 0.44], [x, 0.455, 0], cfg.color, 0.4);
    solid.box(F, [w - 0.025, 0.32, 0.07], [x, 0.72, -0.2], cfg.color, 0.4, [-0.12, 0, 0]);
    glow.cyl(F, 0.012, 0.01, [x, 0.495, 0.02], 0xffffff, 0.6);
    glow.cyl(F, 0.012, 0.01, [x, 0.74, -0.155], 0xffffff, 0.6, [Math.PI / 2 - 0.12, 0, 0]);
  }
  glow.box(F, [L - 0.04, 0.012, 0.008], [0, 0.42, 0.212], cfg.color, 1.8);
  glow.box(F, [L - 0.04, 0.012, 0.008], [0, 0.885, -0.238], cfg.color, 1.8);
  for (const sx of [-1, 1]) {
    chrome.box(F, [0.05, 0.4, 0.05], [sx * (L / 2 - 0.06), 0.2, 0.16]);
    chrome.box(F, [0.05, 0.4, 0.05], [sx * (L / 2 - 0.06), 0.2, -0.16]);
    chrome.box(F, [0.05, 0.05, 0.4], [sx * (L / 2 - 0.06), 0.4, 0]);
  }
  addCollider(cfg.x - 0.27, cfg.x + 0.27, cfg.z - L / 2, cfg.z + L / 2);
}

// ── Lamps & animation ───────────────────────────────────────────────────────────────────────────
function gpLampOn(kind, k, gap, step) {
  switch (kind) {
    case 0: return (((step - k) % gap) + gap) % gap < 2;                        // pairs of lit lamps run along the row
    case 1: return (((step >> 2) + k) & 1) === 0;                               // alternate blink, 2 Hz
    case 2: return ((Math.imul(step, 2654435761) + k * 40503) >>> 7 & 7) < 3;   // random sparkle
    default: return true;
  }
}

function gpBuildLamps() {
  const n = gpLamps.length, mesh = new THREE.InstancedMesh(GP_GEO.disc, GP_MAT.lamp, n);
  const on = new Float32Array(n * 3), off = new Float32Array(n * 3), col = new THREE.Color();
  gpLamps.forEach((l, i) => {
    mesh.setMatrixAt(i, l.matrix);
    col.setHex(l.color);
    on.set([col.r * 2.2, col.g * 2.2, col.b * 2.2], i * 3);
    off.set([col.r * 0.1, col.g * 0.1, col.b * 0.1], i * 3);
  });
  mesh.setColorAt(0, col.setRGB(1, 1, 1));                                        // allocates the instance colour buffer
  mesh.frustumCulled = false;
  scene.add(mesh);
  gpLampState = { mesh, on, off };
  gpUpdateLamps(0);
}

function gpUpdateLamps(step) {
  const { mesh, on, off } = gpLampState, out = mesh.instanceColor.array;
  for (let i = 0; i < gpLamps.length; i++) {
    const l = gpLamps[i], src = gpLampOn(l.kind, l.k, l.gap, step) ? on : off;
    out[i * 3] = src[i * 3]; out[i * 3 + 1] = src[i * 3 + 1]; out[i * 3 + 2] = src[i * 3 + 2];
  }
  mesh.instanceColor.needsUpdate = true;
}

// ── Entry point ─────────────────────────────────────────────────────────────────────────────────
function buildGameProps() {
  gpInitGeometries();
  gpMakeMaterials();
  const east = gpZone(), south = gpZone();

  GP_PINBALLS.forEach((cfg) => gpBuildPinball(east, cfg));
  GP_TABLES.forEach((cfg) => gpBuildAirHockey(east, cfg));
  GP_STOOLS.forEach(([x, z, color]) => gpBuildStool(east, x, z, color));
  gpBuildBench(east, GP_BENCH);
  GP_CLAWS.forEach((cfg, i) => gpBuildClaw(south, cfg, i));
  gpBuildClawMachinery();
  gpFlush(east);
  gpFlush(south);
  gpBuildLamps();

  let lastStep = -1;
  onUpdate((t, dt) => {
    if (window.__dbg && !window.__dbg.gp) window.__dbg.gp = { gpClaws, gpPucks, gpLamps };   //@@DEBUG
    const step = Math.floor(t * 8);
    if (step !== lastStep) { lastStep = step; gpUpdateLamps(step); }
    gpUpdateClaws(dt);
    gpUpdatePucks(dt);
  });
}
