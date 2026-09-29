// ═══════════════ VIDEO CABINETS: side-profile bodies, CRT + glass, marquee, controls, layout ═══════════════
// Owner: cabinets agent. Entry points: buildCabinets(), addCabinet(x, z, rotY, artIndex).
// Artwork (screen / marquee / side / panel textures) comes from makeCabinetArt(i) in 45-screens.js.
//
// Local cabinet space: front faces +z, floor at y = 0, 0.9 m wide (x), z from CAB_BACK to CAB_FRONT, ~2 m tall.
//
// How a cabinet is built (draw calls: 4 own meshes per cabinet + 12 instanced/merged batches for the whole arcade):
//  * The body is ONE ExtrudeGeometry of a 2D side profile (kick plate, coin-door body, overhanging control deck,
//    recessed monitor bay, angled marquee box, rounded roof). Its two side faces ("caps") wear the vinyl side art
//    (own mesh per cabinet); everything else (edge walls + bezel, coin door, joysticks, grille, scuffs...) is merged
//    into one vertex-coloured "shell" geometry per body style and drawn with InstancedMesh for all cabinets.
//  * Glowing bits (T-molding in the game colour, lit buttons, coin slots) and the glass layer are instanced too.
//  * Screen, marquee and control-panel decal are per-art meshes sharing geometry; art (and its materials) is shared
//    by cabinets that use the same game, so at most CAB_ART_LIMIT animated screens exist.
//  * Contact shadows and coloured light pools on the carpet are merged into two meshes for the whole arcade.
//@@import import * as CabGeoUtils from 'three/addons/utils/BufferGeometryUtils.js';
//@@import import { RoundedBoxGeometry as CabRoundedBox } from 'three/addons/geometries/RoundedBoxGeometry.js';

// ── Dimensions (metres) ──
const CAB_W = 0.9;                       // cabinet width
const CAB_BACK = -0.40;                  // local z of the back panel
const CAB_FRONT = 0.55;                  // furthest overhang (control deck lip); used for colliders
const CAB_BEVEL = 0.012;                 // rounded edge of the side panels
const CAB_BAY = { x0: 0.16, y0: 1.10, x1: 0.05, y1: 1.68 };   // slanted monitor bay: bottom and top (z, y)
const CAB_SCREEN = { w: 0.68, h: 0.51, hole: [0.64, 0.48], bulge: 0.014 };   // CRT picture (4:3) and bezel opening
const CAB_ART_LIMIT = 16;                // distinct games (= animated screens) at most
const CAB_BATCH_START = 32;              // initial instance capacity of each batch (grows on demand)
const CAB_BUTTONS = [0xff2a2a, 0xffd21a, 0x2ee65f, 0x2f7bff, 0xf4f4ff, 0xff8a1f];

// Three body styles: silhouette (deck, marquee box), colour scheme and control layout.
// deck: lip = front edge of the control deck, under = front of the lower (coin door) body.
// marquee: low/high = z of the lower / upper end of the slanted marquee face.
const CAB_STYLES = [
  { body: 0x1b1926, controls: 'twin',                                   // classic upright
    deck: { lipX: 0.55, lipY0: 0.88, lipY1: 0.99, underX: 0.36, underY: 0.82 },
    marquee: { lowX: 0.30, highX: 0.22, roofY: 2.02, radius: 0.035 } },
  { body: 0x131c36, controls: 'trackball',                              // bubble-top with trackball
    deck: { lipX: 0.53, lipY0: 0.84, lipY1: 1.00, underX: 0.35, underY: 0.78 },
    marquee: { lowX: 0.31, highX: 0.18, roofY: 2.06, radius: 0.10 } },
  { body: 0x2b1439, controls: 'fight',                                  // tall, steep deck, eight buttons
    deck: { lipX: 0.50, lipY0: 0.84, lipY1: 0.95, underX: 0.36, underY: 0.80 },
    marquee: { lowX: 0.28, highX: 0.25, roofY: 2.08, radius: 0.02 } },
];

// Control layouts for player 1 (u = across the deck, t = fraction of the deck depth, 0 = front). Mirrored for player 2.
const CAB_CONTROLS = {
  twin:      { stick: [-0.27, 0.5], buttons: [[-0.185, 0.66], [-0.135, 0.66], [-0.085, 0.66], [-0.16, 0.36], [-0.11, 0.36], [-0.06, 0.36]] },
  trackball: { stick: [-0.33, 0.5], buttons: [[-0.22, 0.62], [-0.17, 0.62], [-0.22, 0.34], [-0.17, 0.34]], trackball: [0, 0.55] },
  fight:     { stick: [-0.32, 0.5], buttons: [[-0.21, 0.66], [-0.16, 0.66], [-0.11, 0.66], [-0.06, 0.66], [-0.195, 0.36], [-0.145, 0.36], [-0.095, 0.36], [-0.045, 0.36]] },
};

// ── Small geometry helpers ──
const _cabWhite = new THREE.Color(1, 1, 1);

// Bakes one primitive into a non-indexed, uv-less geometry with a vertex colour (gain > 1 makes it glow) so that
// many different primitives can be merged into one geometry.
function cabPart(geometry, hex, matrix = null, gain = 1) {
  const g = geometry.index ? geometry.toNonIndexed() : geometry.clone();
  g.deleteAttribute('uv');
  if (matrix) g.applyMatrix4(matrix);
  const c = new THREE.Color(hex).multiplyScalar(gain), n = g.attributes.position.count, col = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) col.set([c.r, c.g, c.b], i * 3);
  g.setAttribute('color', new THREE.BufferAttribute(col, 3));
  return g;
}

// A straight line of the side profile from p0 to p1 ([z, y] pairs) as a coordinate frame:
// at(u, t, h) = point u across the cabinet, t along the line, h out of the surface (towards the player).
function cabFrame(p0, p1) {
  const dx = p1[0] - p0[0], dy = p1[1] - p0[1];
  const len = Math.hypot(dx, dy), ang = Math.atan2(dx, dy), s = Math.sin(ang), c = Math.cos(ang);
  return { len, ang, at: (u, t, h = 0) => new THREE.Vector3(u, p0[1] + c * t - s * h, p0[0] + s * t + c * h) };
}

// Matrix that puts a primitive (y = along the line, z = out of the surface) on a frame.
// tilt rotates it about x (PI/2 turns a cylinder's axis onto the surface normal); spin rotates it in the surface plane.
function cabPlace(frame, u, t, h = 0, tilt = 0, spin = 0) {
  const m = new THREE.Matrix4().makeTranslation(...frame.at(u, t, h).toArray());
  m.multiply(new THREE.Matrix4().makeRotationX(frame.ang + tilt));
  return spin ? m.multiply(new THREE.Matrix4().makeRotationZ(spin)) : m;
}

function cabTranslate(x, y, z) { return new THREE.Matrix4().makeTranslation(x, y, z); }

// Rounded-rectangle outline on a Path/Shape (also used for holes).
function cabTraceRoundRect(path, hw, hh, r) {
  path.moveTo(-hw + r, -hh);
  path.lineTo(hw - r, -hh);  path.absarc(hw - r, -hh + r, r, -Math.PI / 2, 0, false);
  path.lineTo(hw, hh - r);   path.absarc(hw - r, hh - r, r, 0, Math.PI / 2, false);
  path.lineTo(-hw + r, hh);  path.absarc(-hw + r, hh - r, r, Math.PI / 2, Math.PI, false);
  path.lineTo(-hw, -hh + r); path.absarc(-hw + r, -hh + r, r, Math.PI, Math.PI * 1.5, false);
}

// ── Side profile ──
// Control points [z, y, corner radius, T-molding?] going round the cabinet side, starting at the bottom back.
function cabProfile(s) {
  const d = s.deck, m = s.marquee, b = CAB_BAY;
  return [
    [CAB_BACK, 0, 0, 0],
    [0.30, 0, 0, 0],                       // kick plate (recessed)
    [0.30, 0.11, 0, 0],
    [d.underX, 0.11, 0, 1],                // lower body with the coin door
    [d.underX, d.underY, 0, 1],
    [d.lipX, d.lipY0, 0.012, 1],           // control deck overhang
    [d.lipX, d.lipY1, 0.014, 1],
    [b.x0, b.y0, 0.02, 1],                 // deck meets the monitor bay
    [b.x1, b.y1, 0.01, 1],                 // top of the slanted monitor bay
    [m.lowX, b.y1, 0.008, 1],              // underside of the marquee box
    [m.highX, m.roofY, m.radius, 1],       // marquee face rises to the roof
    [CAB_BACK, m.roofY, 0.05, 1],
  ];
}

// Rounds the corners of the control-point loop and returns a polyline [{x, y, wrap}] (x = z in cabinet space).
function cabOutline(points) {
  const out = [], n = points.length;
  for (let i = 0; i < n; i++) {
    const [x, y, r, wrap] = points[i];
    if (!r) { out.push({ x, y, wrap }); continue; }
    const [px, py] = points[(i + n - 1) % n], [nx, ny] = points[(i + 1) % n];
    const dp = Math.hypot(px - x, py - y), dn = Math.hypot(nx - x, ny - y);
    const rp = Math.min(r, dp / 2), rn = Math.min(r, dn / 2);
    const ax = x + (px - x) / dp * rp, ay = y + (py - y) / dp * rp;
    const bx = x + (nx - x) / dn * rn, by = y + (ny - y) / dn * rn;
    const steps = r > 0.04 ? 7 : 2;
    for (let k = 0; k <= steps; k++) {                     // quadratic curve a -> (corner) -> b
      const t = k / steps, u = 1 - t;
      out.push({ x: u * u * ax + 2 * u * t * x + t * t * bx, y: u * u * ay + 2 * u * t * y + t * t * by, wrap });
    }
  }
  return out;
}

// Extrudes the outline across the cabinet width. Returns the two side faces (uv-mapped for the side art) and the
// edge walls (smooth-shaded around the bevel and the rounded corners, hard on the sharp corners).
function cabBodyGeometry(outline) {
  const shape = new THREE.Shape(outline.map((p) => new THREE.Vector2(p.x, p.y)));
  const depth = CAB_W - 2 * CAB_BEVEL;
  const ext = new THREE.ExtrudeGeometry(shape, {
    depth, bevelEnabled: true, bevelThickness: CAB_BEVEL, bevelSize: CAB_BEVEL, bevelOffset: -CAB_BEVEL, bevelSegments: 3,
  });
  // Shape space (x = z, y, extrusion = -x)  ->  cabinet space.
  ext.applyMatrix4(new THREE.Matrix4().makeRotationY(-Math.PI / 2).setPosition(depth / 2, 0, 0));

  const slice = (attr, g, size) => attr.array.slice(g.start * size, (g.start + g.count) * size);
  const lids = ext.groups.find((g) => g.materialIndex === 0), sides = ext.groups.find((g) => g.materialIndex === 1);

  const cap = new THREE.BufferGeometry();
  const capPos = slice(ext.attributes.position, lids, 3);
  cap.setAttribute('position', new THREE.BufferAttribute(capPos, 3));
  cap.setAttribute('normal', new THREE.BufferAttribute(slice(ext.attributes.normal, lids, 3), 3));
  const zMin = CAB_BACK, zMax = Math.max(...outline.map((p) => p.x)), yMax = Math.max(...outline.map((p) => p.y));
  const uv = new Float32Array((capPos.length / 3) * 2);
  for (let i = 0; i < capPos.length / 3; i++) {             // front on the left when seen from either side
    const x = capPos[i * 3], y = capPos[i * 3 + 1], z = capPos[i * 3 + 2];
    uv[i * 2] = x > 0 ? (zMax - z) / (zMax - zMin) : (z - zMin) / (zMax - zMin);
    uv[i * 2 + 1] = y / yMax;
  }
  cap.setAttribute('uv', new THREE.BufferAttribute(uv, 2));

  let wall = new THREE.BufferGeometry();
  wall.setAttribute('position', new THREE.BufferAttribute(slice(ext.attributes.position, sides, 3), 3));
  wall.setAttribute('normal', new THREE.BufferAttribute(slice(ext.attributes.normal, sides, 3), 3));
  wall = CabGeoUtils.toCreasedNormals(wall, 0.75);
  ext.dispose();
  return { cap, wall };
}

// T-molding: a thin strip hugging both side panels along the front edge, in one white geometry that is tinted
// per cabinet through instanceColor. Plus lit bars across the deck lip, the marquee foot and above the kick plate.
function cabMoldGeometry(outline, frames, s) {
  const parts = [];
  for (let i = 0; i < outline.length; i++) {
    const a = outline[i], b = outline[(i + 1) % outline.length];
    if (!a.wrap || !b.wrap) continue;
    const dx = b.x - a.x, dy = b.y - a.y, len = Math.hypot(dx, dy) + 0.008, ang = Math.atan2(dx, dy);
    if (len < 0.02) continue;                                // tiny corner segments are covered by their neighbours
    const mid = new THREE.Vector3(0, (a.y + b.y) / 2, (a.x + b.x) / 2);
    for (const side of [-1, 1]) {
      const m = cabTranslate(side * (CAB_W / 2 - 0.004), mid.y, mid.z).multiply(new THREE.Matrix4().makeRotationX(ang));
      parts.push(cabPart(new THREE.BoxGeometry(0.016, len, 0.012), 0xffffff, m));
    }
  }
  const d = s.deck;
  parts.push(cabPart(new THREE.BoxGeometry(0.84, 0.018, 0.01), 0xffffff, cabTranslate(0, (d.lipY0 + d.lipY1) / 2 - 0.005, d.lipX + 0.006)));
  const mq = frames.marquee;
  parts.push(cabPart(new THREE.BoxGeometry(0.84, 0.006, 0.01), 0xffffff, cabPlace(mq, 0, 0.052, 0.006)));
  parts.push(cabPart(new THREE.BoxGeometry(0.80, 0.008, 0.008), 0xffffff, cabTranslate(0, 0.115, d.underX + 0.003)));   // above the kick plate
  return CabGeoUtils.mergeGeometries(parts);
}

// ── Detail groups (each pushes vertex-coloured parts into `trim` = dull shell, `lit` = glowing) ──

// Bezel: dark frame with a rounded opening, an instruction card and screws. Sits in front of the recessed CRT.
function cabAddBezel(ctx) {
  const { trim, frames } = ctx, bay = frames.bay, [ow, oh] = CAB_SCREEN.hole;
  const shape = new THREE.Shape();
  cabTraceRoundRect(shape, 0.42, 0.2925, 0.015);
  const hole = new THREE.Path();
  cabTraceRoundRect(hole, ow / 2, oh / 2, 0.035);
  shape.holes.push(hole);
  const frame = new THREE.ExtrudeGeometry(shape, {
    depth: 0.008, bevelEnabled: true, bevelThickness: 0.004, bevelSize: 0.004, bevelSegments: 1, curveSegments: 3,
  });
  trim(frame, 0x0b0b10, cabPlace(bay, 0, bay.len / 2, 0.020));
  const front = 0.0335;                                          // just in front of the frame face
  trim(new THREE.PlaneGeometry(0.15, 0.034), 0xd8d1b6, cabPlace(bay, -0.24, 0.031, front));        // instruction card
  trim(new THREE.PlaneGeometry(0.15, 0.008), 0xc2263a, cabPlace(bay, -0.24, 0.043, front + 0.0005));
  for (const sx of [-0.395, 0.395]) for (const t of [0.03, bay.len - 0.03]) {
    trim(new THREE.CylinderGeometry(0.006, 0.006, 0.004, 8), 0x9a9eaa, cabPlace(bay, sx, t, front, Math.PI / 2));
  }
}

// Speaker grille on the lower band of the marquee face.
function cabAddGrille(ctx) {
  const { trim, frames } = ctx, mq = frames.marquee;
  trim(new THREE.PlaneGeometry(0.84, 0.042), 0x2a2a34, cabPlace(mq, 0, 0.027, 0.003));
  for (let i = 0; i < 13; i++) {
    trim(new THREE.PlaneGeometry(0.048, 0.009), 0x030305, cabPlace(mq, (i - 6) * 0.064, 0.027, 0.0035));
  }
}

// Kick plate with scuffs, a few scratches and stickers on the lower front.
function cabAddWear(ctx) {
  const { trim, frames, rand } = ctx, kick = frames.kick, low = frames.lower;
  trim(new THREE.PlaneGeometry(0.86, 0.10), 0x07070a, cabPlace(kick, 0, 0.055, 0.002));
  for (let i = 0; i < 16; i++) {
    const u = (rand() - 0.5) * 0.8, t = 0.01 + rand() * 0.09;
    trim(new THREE.PlaneGeometry(0.02 + rand() * 0.08, 0.002 + rand() * 0.003), 0x4a4858, cabPlace(kick, u, t, 0.0035, 0, (rand() - 0.5) * 1.2));
  }
  for (let i = 0; i < 9; i++) {
    const u = (rand() - 0.5) * 0.84, t = 0.02 + rand() * 0.16;
    trim(new THREE.PlaneGeometry(0.02 + rand() * 0.06, 0.002), 0x34323f, cabPlace(low, u, t, 0.002, 0, (rand() - 0.5) * 1.4));
  }
  trim(new THREE.PlaneGeometry(0.075, 0.045), 0x77778a, cabPlace(low, -0.365, 0.30, 0.002, 0, 0.05));    // label plates
  trim(new THREE.PlaneGeometry(0.075, 0.012), 0xa02030, cabPlace(low, -0.365, 0.318, 0.0025, 0, 0.05));
  trim(new THREE.PlaneGeometry(0.05, 0.05), 0x7a3a5c, cabPlace(low, 0.375, 0.24, 0.002, 0, -0.1));
}

// Coin door: steel plate, two coin mechs with backlit slots and return buttons, coin return flap and lock.
function cabAddCoinDoor(ctx) {
  const { trim, lit, frames } = ctx, low = frames.lower;
  const t0 = 0.29;                                               // door centre, measured up from the kick top
  trim(new CabRoundedBox(0.27, 0.42, 0.02, 2, 0.012), 0x6c7180, cabPlace(low, 0, t0, 0.008));
  trim(new THREE.BoxGeometry(0.235, 0.385, 0.006), 0x4a4e5c, cabPlace(low, 0, t0, 0.0175));
  for (const sx of [-0.062, 0.062]) {
    trim(new CabRoundedBox(0.078, 0.135, 0.012, 1, 0.008), 0x0f0f14, cabPlace(low, sx, t0 + 0.085, 0.022));
    lit(new THREE.PlaneGeometry(0.008, 0.05), 0xd87818, cabPlace(low, sx, t0 + 0.105, 0.0285), 1.3);       // backlit coin slit
    trim(new THREE.CylinderGeometry(0.013, 0.013, 0.008, 10), 0x1a1a20, cabPlace(low, sx, t0 + 0.045, 0.0285, Math.PI / 2));
    lit(new THREE.CylinderGeometry(0.009, 0.01, 0.006, 10), 0xff2a2a, cabPlace(low, sx, t0 + 0.045, 0.0315, Math.PI / 2), 1.1);
  }
  trim(new THREE.BoxGeometry(0.15, 0.06, 0.012), 0x08080b, cabPlace(low, 0, t0 - 0.06, 0.022));   // coin return flap
  trim(new THREE.BoxGeometry(0.13, 0.008, 0.006), 0x2c2c36, cabPlace(low, 0, t0 - 0.045, 0.0305));
  trim(new THREE.CylinderGeometry(0.012, 0.012, 0.006, 10), 0xc8ccd8, cabPlace(low, 0.07, t0 - 0.155, 0.022, Math.PI / 2));   // lock
  for (const sx of [-0.11, 0.11]) for (const t of [t0 - 0.18, t0 + 0.18]) {
    trim(new THREE.CylinderGeometry(0.005, 0.005, 0.004, 6), 0xb0b4c0, cabPlace(low, sx, t, 0.0205, Math.PI / 2));
  }
}

// Joysticks, lit buttons, start buttons and (style 2) a trackball on the control deck.
function cabAddControls(ctx) {
  const { trim, lit, frames, s } = ctx, deck = frames.deck, layout = CAB_CONTROLS[s.controls];
  const along = (f) => f * deck.len;
  for (const side of [-1, 1]) {
    const [su, st] = layout.stick;
    trim(new THREE.CylinderGeometry(0.052, 0.056, 0.008, 12), 0x0d0d12, cabPlace(deck, side * -su, along(st), 0.008, Math.PI / 2));
    trim(new THREE.CylinderGeometry(0.008, 0.008, 0.07, 6), 0xb4b8c4, cabPlace(deck, side * -su, along(st), 0.045, Math.PI / 2));
    trim(new THREE.SphereGeometry(0.028, 10, 7), side < 0 ? 0xd81820 : 0x2050e0, cabPlace(deck, side * -su, along(st), 0.093));
    layout.buttons.forEach(([u, t], i) => {
      const bu = side * -u, hue = CAB_BUTTONS[(i + (side < 0 ? 0 : 2)) % CAB_BUTTONS.length];
      trim(new THREE.CylinderGeometry(0.021, 0.021, 0.008, 10), 0x0d0d12, cabPlace(deck, bu, along(t), 0.008, Math.PI / 2));
      lit(new THREE.CylinderGeometry(0.0155, 0.017, 0.012, 10), hue, cabPlace(deck, bu, along(t), 0.012, Math.PI / 2), 1.5);
    });
    trim(new THREE.CylinderGeometry(0.016, 0.016, 0.008, 8), 0x0d0d12, cabPlace(deck, side * 0.045, along(0.13), 0.008, Math.PI / 2));
    lit(new THREE.CylinderGeometry(0.0115, 0.0125, 0.01, 8), side < 0 ? 0xffffff : 0x40a0ff, cabPlace(deck, side * 0.045, along(0.13), 0.011, Math.PI / 2), 1.4);
  }
  if (layout.trackball) {
    const [tu, tt] = layout.trackball;
    trim(new THREE.CylinderGeometry(0.058, 0.062, 0.01, 14), 0x1a1a22, cabPlace(deck, tu, along(tt), 0.008, Math.PI / 2));
    trim(new THREE.SphereGeometry(0.04, 12, 8), 0x15151b, cabPlace(deck, tu, along(tt), 0.026));
    lit(new THREE.TorusGeometry(0.05, 0.0035, 4, 16), 0x00e5ff, cabPlace(deck, tu, along(tt), 0.014), 1.8);
  }
}

// ── Shared, per-style kit: geometry + instanced batches ──
class CabBatch {
  // One InstancedMesh for a shared geometry/material; `tinted` batches also get a colour per instance.
  constructor(geometry, material, tinted = false) {
    this.geometry = geometry; this.material = material; this.tinted = tinted;
    this.count = 0; this.capacity = 0; this.mesh = null;
    this.grow(CAB_BATCH_START);
  }
  grow(capacity) {
    const old = this.mesh, mesh = new THREE.InstancedMesh(this.geometry, this.material, capacity);
    mesh.count = this.count;
    if (this.tinted) mesh.setColorAt(0, _cabWhite);              // allocates instanceColor
    if (old) {
      mesh.instanceMatrix.array.set(old.instanceMatrix.array);
      if (this.tinted) mesh.instanceColor.array.set(old.instanceColor.array);
      cabRoot().remove(old);
      old.dispose();
    }
    cabRoot().add(mesh);
    this.mesh = mesh; this.capacity = capacity;
  }
  add(matrix, color = _cabWhite) {
    if (this.count === this.capacity) this.grow(this.capacity * 2);
    const m = this.mesh;
    m.setMatrixAt(this.count, matrix);
    if (this.tinted) { m.setColorAt(this.count, color); m.instanceColor.needsUpdate = true; }
    m.count = ++this.count;
    m.instanceMatrix.needsUpdate = true;
    m.computeBoundingSphere();                                   // keeps frustum culling correct as instances are added
  }
}

let _cabRoot = null;
function cabRoot() {
  if (!_cabRoot) { _cabRoot = new THREE.Group(); _cabRoot.name = 'cabinets'; scene.add(_cabRoot); }
  return _cabRoot;
}

// Everything shared by all cabinets: CRT / glass geometry, materials, glass batch.
let _cabShared = null;
function cabShared() {
  if (_cabShared) return _cabShared;
  const bay = cabFrame([CAB_BAY.x0, CAB_BAY.y0], [CAB_BAY.x1, CAB_BAY.y1]);
  const dome = (w, h, sx, sy, bulge, offset) => {                // subdivided plane bulging towards the viewer
    const g = new THREE.PlaneGeometry(w, h, sx, sy), p = g.attributes.position;
    for (let i = 0; i < p.count; i++) {
      const nx = p.getX(i) / (w / 2), ny = p.getY(i) / (h / 2);
      p.setZ(i, bulge * (1 - nx * nx) * (1 - ny * ny));
    }
    g.computeVertexNormals();
    g.applyMatrix4(cabPlace(bay, 0, bay.len / 2, offset));
    return g;
  };
  const screenGeo = dome(CAB_SCREEN.w, CAB_SCREEN.h, 12, 9, CAB_SCREEN.bulge, 0.004);
  const glassGeo = dome(0.84, 0.585, 8, 6, 0.010, 0.040);
  const glassMat = new THREE.MeshStandardMaterial({
    color: 0x000000, roughness: 0.26, metalness: 0,              // black + additive: only reflections and sheen add light
    emissive: 0xffffff, emissiveMap: cabSheenTexture(), emissiveIntensity: 0.25,
    transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, fog: false,
  });
  _cabShared = {
    screenGeo,
    glass: new CabBatch(glassGeo, glassMat),
    shellMat: new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.55, metalness: 0.2 }),
    glowMat: new THREE.MeshBasicMaterial({ vertexColors: true }),
    moldMat: new THREE.MeshBasicMaterial({}),
  };
  return _cabShared;
}

// Soft diagonal streaks + smudges, the "window reflection" on the tube glass.
function cabSheenTexture() {
  const { canvas, ctx } = makeCanvas(128, 128);
  ctx.fillStyle = '#000'; ctx.fillRect(0, 0, 128, 128);
  ctx.save(); ctx.translate(64, 64); ctx.rotate(-0.62);
  for (const [x, w, a] of [[-26, 30, 0.34], [18, 9, 0.20], [34, 4, 0.14]]) {
    const g = ctx.createLinearGradient(x - w, 0, x + w, 0);
    g.addColorStop(0, 'rgba(255,255,255,0)'); g.addColorStop(0.5, `rgba(255,255,255,${a})`); g.addColorStop(1, 'rgba(255,255,255,0)');
    ctx.fillStyle = g; ctx.fillRect(x - w, -120, w * 2, 240);
  }
  ctx.restore();
  const r = rng(7);
  for (let i = 0; i < 5; i++) {                                  // fingerprints / dust
    const g = ctx.createRadialGradient(0, 0, 0, 0, 0, 14);
    g.addColorStop(0, 'rgba(255,255,255,0.10)'); g.addColorStop(1, 'rgba(255,255,255,0)');
    ctx.save(); ctx.translate(r() * 128, r() * 128); ctx.scale(1, 0.6); ctx.fillStyle = g; ctx.fillRect(-14, -14, 28, 28); ctx.restore();
  }
  return canvasTexture(canvas, { anisotropy: 1 });
}

const _cabKits = [];
function cabKit(styleIndex) {
  return _cabKits[styleIndex] || (_cabKits[styleIndex] = cabBuildKit(styleIndex));
}

function cabBuildKit(styleIndex) {
  const s = CAB_STYLES[styleIndex], d = s.deck, m = s.marquee, b = CAB_BAY, shared = cabShared();
  const outline = cabOutline(cabProfile(s));
  const { cap, wall } = cabBodyGeometry(outline);
  const frames = {
    kick: cabFrame([0.30, 0], [0.30, 0.11]),
    lower: cabFrame([d.underX, 0.11], [d.underX, d.underY]),
    deck: cabFrame([d.lipX, d.lipY1], [b.x0, b.y0]),
    bay: cabFrame([b.x0, b.y0], [b.x1, b.y1]),
    marquee: cabFrame([m.lowX, b.y1], [m.highX, m.roofY]),
  };

  const shell = [cabPart(wall, s.body)], glow = [];
  const ctx = {
    s, frames, rand: rng(4242 + styleIndex * 97),
    trim: (geo, hex, matrix) => shell.push(cabPart(geo, hex, matrix)),
    lit: (geo, hex, matrix, gain) => glow.push(cabPart(geo, hex, matrix, gain)),
  };
  cabAddBezel(ctx); cabAddGrille(ctx); cabAddWear(ctx); cabAddCoinDoor(ctx); cabAddControls(ctx);

  // Printed art planes: control-panel decal on the deck, lit marquee on the slanted marquee face.
  const deckGeo = new THREE.PlaneGeometry(0.84, frames.deck.len - 0.08);
  deckGeo.applyMatrix4(cabPlace(frames.deck, 0, frames.deck.len / 2, 0.003));
  const marqueeGeo = new THREE.PlaneGeometry(0.84, 0.21);
  marqueeGeo.applyMatrix4(cabPlace(frames.marquee, 0, 0.16, 0.004));

  return {
    capGeo: cap, deckGeo, marqueeGeo,
    shell: new CabBatch(CabGeoUtils.mergeGeometries(shell), shared.shellMat, true),
    glow: new CabBatch(CabGeoUtils.mergeGeometries(glow), shared.glowMat),
    mold: new CabBatch(cabMoldGeometry(outline, frames, s), shared.moldMat, true),
  };
}

// ── Per-game materials (shared by every cabinet showing the same game) ──
const _cabArts = new Map();
function cabArtKit(artIndex) {
  const limit = Math.max(1, Math.min(CAB_ART_LIMIT, GAME_COUNT));
  const key = ((artIndex % limit) + limit) % limit;
  let kit = _cabArts.get(key);
  if (kit) return kit;
  const art = makeCabinetArt(key);
  kit = {
    art,
    sideMat: new THREE.MeshStandardMaterial({                     // glossy vinyl print
      map: art.sideTex, roughness: 0.38, metalness: 0, emissive: 0xffffff, emissiveMap: art.sideTex, emissiveIntensity: 0.18,
    }),
    panelMat: new THREE.MeshStandardMaterial({
      map: art.panelTex, roughness: 0.3, metalness: 0, emissive: 0xffffff, emissiveMap: art.panelTex, emissiveIntensity: 0.3,
    }),
    marqueeMat: cabPatchedBasic(art.marqueeTex, 1.3, 'cab-marquee', `
      diffuseColor.rgb *= (0.84 + 0.16 * sin(vMapUv.y * 3.14159)) * (0.90 + 0.10 * sin(vMapUv.x * 3.14159));`),
    screenMat: cabPatchedBasic(art.screenTex, 1.2, 'cab-screen', `
      vec2 cq = vMapUv - 0.5;
      float cr = dot(cq, cq) * 4.0;                                  // 0 in the middle, 2 in the corners
      float scan = sin(vMapUv.y * 192.0 * 6.28318);                  // scanlines, faded out when they would alias
      float aa = 1.0 - smoothstep(0.1, 0.5, fwidth(vMapUv.y) * 192.0);
      diffuseColor.rgb *= (1.0 - 0.40 * smoothstep(0.25, 1.6, cr)) * (1.0 + 0.10 * (1.0 - smoothstep(0.0, 1.0, cr)))
                        * (1.0 - 0.14 * aa * (0.5 + 0.5 * scan));`),
  };
  _cabArts.set(key, kit);
  return kit;
}

// Unlit (emissive-looking) textured material with a small fragment tweak (vignette, scanlines, light-box falloff).
function cabPatchedBasic(map, gain, cacheKey, glsl) {
  const mat = new THREE.MeshBasicMaterial({ map, color: new THREE.Color(gain, gain, gain) });
  mat.onBeforeCompile = (shader) => {
    shader.fragmentShader = shader.fragmentShader.replace('#include <map_fragment>', `#include <map_fragment>\n${glsl}`);
  };
  mat.customProgramCacheKey = () => cacheKey;
  return mat;
}

// ── Floor decals: soft contact shadows and coloured light pools, merged for the whole arcade ──
const _cabDecals = [];
let _cabFloorMeshes = null, _cabFloorTextures = null, _cabDeferFloor = false;
const _cabFloorMats = {};                                        // created on first use, reused when the decals are rebuilt

function cabFloorTextures() {
  if (_cabFloorTextures) return _cabFloorTextures;
  const sh = makeCanvas(128, 128);                               // soft rectangle
  sh.ctx.shadowColor = '#000'; sh.ctx.shadowBlur = 16; sh.ctx.shadowOffsetX = 1000;
  sh.ctx.fillStyle = '#000'; sh.ctx.fillRect(-1000 + 30, 28, 68, 72);
  const pool = makeCanvas(128, 128);                             // radial falloff
  const g = pool.ctx.createRadialGradient(64, 64, 0, 64, 64, 64);
  g.addColorStop(0, 'rgba(255,255,255,1)'); g.addColorStop(0.35, 'rgba(255,255,255,0.55)');
  g.addColorStop(0.7, 'rgba(255,255,255,0.14)'); g.addColorStop(1, 'rgba(255,255,255,0)');
  pool.ctx.fillStyle = g; pool.ctx.fillRect(0, 0, 128, 128);
  _cabFloorTextures = { shadow: canvasTexture(sh.canvas, { anisotropy: 1 }), pool: canvasTexture(pool.canvas, { anisotropy: 1 }) };
  return _cabFloorTextures;
}

// One merged quad list. across/along: half sizes; centre: offset along the cabinet's facing direction.
function cabDecalGeometry(across, along, centre, y, colorOf) {
  const n = _cabDecals.length;
  const pos = new Float32Array(n * 12), uv = new Float32Array(n * 8), idx = new Uint16Array(n * 6);
  const col = colorOf ? new Float32Array(n * 12) : null;
  const corners = [[-1, -1], [1, -1], [1, 1], [-1, 1]];
  _cabDecals.forEach((dc, i) => {
    const s = Math.sin(dc.rot), c = Math.cos(dc.rot);             // facing (s, c), right (c, -s) on the floor plane
    const cx = dc.x + s * centre, cz = dc.z + c * centre;
    corners.forEach(([a, l], k) => {
      const v = i * 4 + k;
      pos.set([cx + c * a * across + s * l * along, y, cz - s * a * across + c * l * along], v * 3);
      uv.set([(a + 1) / 2, (l + 1) / 2], v * 2);
      if (col) col.set(colorOf(dc), v * 3);
    });
    idx.set([i * 4, i * 4 + 1, i * 4 + 2, i * 4, i * 4 + 2, i * 4 + 3], i * 6);
  });
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  g.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  if (col) g.setAttribute('color', new THREE.BufferAttribute(col, 3));
  g.setIndex(new THREE.BufferAttribute(idx, 1));
  return g;
}

function cabRebuildFloor() {
  const tex = cabFloorTextures();
  if (_cabFloorMeshes) for (const mesh of _cabFloorMeshes) { cabRoot().remove(mesh); mesh.geometry.dispose(); }
  const common = { transparent: true, depthWrite: false, side: THREE.DoubleSide, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 };
  const shadow = new THREE.Mesh(
    cabDecalGeometry(0.70, 0.74, 0.075, 0.004, null),
    _cabFloorMats.shadow || (_cabFloorMats.shadow = new THREE.MeshBasicMaterial({ map: tex.shadow, color: 0x000000, opacity: 0.85, ...common })));
  const pool = new THREE.Mesh(
    cabDecalGeometry(1.15, 0.75, 1.15, 0.006, (dc) => dc.glow),
    _cabFloorMats.pool || (_cabFloorMats.pool = new THREE.MeshBasicMaterial({ map: tex.pool, vertexColors: true, blending: THREE.AdditiveBlending, fog: false, ...common })));
  for (const mesh of [shadow, pool]) { mesh.renderOrder = -1; mesh.frustumCulled = false; cabRoot().add(mesh); }
  _cabFloorMeshes = [shadow, pool];
}

// ── Placing cabinets ──
const _cabQuat = new THREE.Quaternion(), _cabUp = new THREE.Vector3(0, 1, 0), _cabOne = new THREE.Vector3(1, 1, 1);
let _cabCounter = 0;

// Builds one cabinet, places it at (x, z) turned by rotY, registers its collider and returns the group of its own meshes.
function addCabinet(x, z, rotY, artIndex) {
  const cab = cabBuild(x, z, rotY, artIndex);
  if (!_cabDeferFloor) cabRebuildFloor();
  return cab;
}

function cabBuild(x, z, rotY, artIndex) {
  const shared = cabShared();
  const n = _cabCounter++;
  const kit = cabKit((n + (n >> 2)) % CAB_STYLES.length);         // styles alternate along a row
  const arts = cabArtKit(artIndex), art = arts.art;
  const rand = rng(Math.round(x * 100) * 7919 + Math.round(z * 100) * 104729 + n);

  // Instanced parts (shell, glow, T-molding, glass): one matrix per cabinet, slight random tint on shell and molding.
  const matrix = new THREE.Matrix4().compose(new THREE.Vector3(x, 0, z), _cabQuat.setFromAxisAngle(_cabUp, rotY), _cabOne);
  const k = 0.82 + rand() * 0.36;
  const tint = new THREE.Color(k * (0.94 + rand() * 0.12), k * (0.94 + rand() * 0.12), k * (0.94 + rand() * 0.12));
  const neon = new THREE.Color(art.color);
  const glowTint = new THREE.Color(neon.r, neon.g, neon.b).multiplyScalar(1.25 * (0.9 + rand() * 0.2));
  kit.shell.add(matrix, tint); kit.glow.add(matrix); kit.mold.add(matrix, glowTint); shared.glass.add(matrix);

  // Own meshes: side art, control-panel decal, marquee and CRT. Static, so their matrices are computed once.
  const cab = new THREE.Group();
  cab.position.set(x, 0, z);
  cab.rotation.y = rotY;
  cab.matrixAutoUpdate = false;
  cab.updateMatrix();
  for (const [geo, mat] of [[kit.capGeo, arts.sideMat], [kit.deckGeo, arts.panelMat], [kit.marqueeGeo, arts.marqueeMat], [shared.screenGeo, arts.screenMat]]) {
    const mesh = new THREE.Mesh(geo, mat);
    mesh.matrixAutoUpdate = false;
    cab.add(mesh);
  }
  cabRoot().add(cab);

  cabAddCollider(x, z, rotY);
  _cabDecals.push({ x, z, rot: rotY, glow: [neon.r * 0.26, neon.g * 0.26, neon.b * 0.26] });
  registry.cabinets.push({ x, z, rot: rotY, color: art.color, name: art.name, art });
  return cab;
}

// Collision box: rotate the footprint (including the control-deck overhang) into world space, take its bounding box.
function cabAddCollider(x, z, rotY) {
  const c = Math.cos(rotY), s = Math.sin(rotY), xs = [], zs = [];
  for (const [lx, lz] of [[-CAB_W / 2, CAB_BACK], [CAB_W / 2, CAB_BACK], [CAB_W / 2, CAB_FRONT], [-CAB_W / 2, CAB_FRONT]]) {
    xs.push(x + lx * c + lz * s);
    zs.push(z - lx * s + lz * c);
  }
  addCollider(Math.min(...xs), Math.max(...xs), Math.min(...zs), Math.max(...zs));
}

// Layout (zones in CONTRACT.md): west wall strip, central island, west-centre island. 24 cabinets, 1.05 m pitch.
function buildCabinets() {
  _cabDeferFloor = true;
  const PITCH = 1.05, BACK_GAP = 0.03;
  let game = 0;                                                  // next game (art index); wraps after CAB_ART_LIMIT
  const row = (count, at, rot) => { for (let k = 0; k < count; k++) { const [x, z] = at(k); addCabinet(x, z, rot, game++); } };
  const centred = (k, n) => (k - (n - 1) / 2) * PITCH;

  // West wall strip, facing east (+x)
  row(8, (k) => [-ROOM.w / 2 - CAB_BACK + BACK_GAP, centred(k, 8)], Math.PI / 2);
  // Central island: two back-to-back rows of four, facing +z and -z
  row(4, (k) => [centred(k, 4), -CAB_BACK], 0);
  row(4, (k) => [centred(k, 4), CAB_BACK], Math.PI);
  // West-centre island: two back-to-back rows of four, facing west (-x) and east (+x)
  row(4, (k) => [-5.5 + CAB_BACK, centred(k, 4)], -Math.PI / 2);
  row(4, (k) => [-5.5 - CAB_BACK, centred(k, 4)], Math.PI / 2);

  _cabDeferFloor = false;
  cabRebuildFloor();
  window.__addCabinet = addCabinet;   //@@DEBUG
}
