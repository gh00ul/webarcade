// ═══════════════ CORE: settings, renderer, scene, camera, shared helpers ═══════════════
// All parts share ONE module scope (they are concatenated by build.mjs).
// Names declared here are the shared API described in CONTRACT.md.

const ROOM = { w: 20, d: 14, h: 4 };      // metres: x, z, y. Centred on the origin, floor at y = 0.
const EYE_HEIGHT = 1.7;
const WALK_SPEED = 3;                     // m/s
const RUN_SPEED = 5.5;                    // m/s while holding Shift
const PLAYER_RADIUS = 0.3;                // for collisions
const LOOK_SENSITIVITY = 0.002;           // radians per pixel of mouse movement

const NEON = { pink: 0xff2bd6, cyan: 0x00e5ff, purple: 0x9b5cff, orange: 0xff8a1f,
               yellow: 0xffe600, green: 0x39ff88, red: 0xff2a3a, blue: 0x2f6bff };

const URL_PARAMS = new URLSearchParams(window.location.search);

// Troubleshooting switches for graphics drivers that draw something wrongly (e.g. index.html?nomsaa). ?safe turns all of them on.
//   ?nomsaa  no multisampled render targets     ?ldr  8 bit instead of half-float render targets (no glow above white)
//   ?nobloom no bloom pass                       ?pr1  render at 1 pixel per CSS pixel, whatever the display scaling
const urlFlag = (name) => URL_PARAMS.has(name) || URL_PARAMS.has('safe');

// Runtime quality knobs. The render part may lower these automatically if the frame rate is poor.
const QUALITY = {
  level: 2,                                               // 2 = high, 1 = medium, 0 = low
  pixelRatio: urlFlag('pr1') ? 1 : Math.min(window.devicePixelRatio || 1, 2),
  bloom: !urlFlag('nobloom'),
  adapt: !URL_PARAMS.has('noadapt'),                      // ?noadapt disables auto-downgrade (used by tests)
};

const renderer = new THREE.WebGLRenderer({ antialias: false, powerPreference: 'high-performance' });
renderer.setPixelRatio(QUALITY.pixelRatio);
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.0;
document.body.prepend(renderer.domElement);
const canvas = renderer.domElement;

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x05040a);
scene.fog = new THREE.FogExp2(0x07050f, 0.03);

const camera = new THREE.PerspectiveCamera(70, 1, 0.05, 60);
camera.rotation.order = 'YXZ';            // yaw first, then pitch

// Player state: floor position plus look direction. Start by the entrance, facing north (-z).
const player = { x: 0, z: 5, yaw: 0, pitch: 0 };

// Axis-aligned boxes on the floor plane that the player can't walk into.
const colliders = [];                     // each: { minX, maxX, minZ, maxZ }
function addCollider(minX, maxX, minZ, maxZ) { colliders.push({ minX, maxX, minZ, maxZ }); }

// Per-frame hooks: fn(timeSeconds, dtSeconds). Called once per frame before rendering.
const updaters = [];
function onUpdate(fn) { updaters.push(fn); }

// Things other parts may want to know about (audio, lighting, ...).
const registry = {
  cabinets: [],   // { x, z, rot, color, name, art }   video cabinets (cabinets part)
  props: [],      // { kind, x, z, y?, color? }        other objects with a sound or light (props part)
  lights: [],     // every light the lighting part creates
};

// ── Helpers ──
function makeCanvas(w, h) {
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  return { canvas: c, ctx: c.getContext('2d') };
}

// Wraps a canvas as a texture. sRGB by default (colour art); pass srgb:false for data maps.
function canvasTexture(cnv, { srgb = true, repeat = null, anisotropy = 4 } = {}) {
  const tex = new THREE.CanvasTexture(cnv);
  if (srgb) tex.colorSpace = THREE.SRGBColorSpace;
  if (repeat) { tex.wrapS = tex.wrapT = THREE.RepeatWrapping; tex.repeat.set(repeat[0], repeat[1]); }
  tex.anisotropy = anisotropy;
  return tex;
}

// Small seeded random generator so procedural art is the same on every load: const r = rng(42); r() -> [0,1)
function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Neon-arcade font stack for canvas text. Redraw signs after `fontsReady` resolves if you use it.
const ARCADE_FONT = '"Press Start 2P", "Courier New", monospace';
// The Google Fonts stylesheet is non-blocking (see template), so wait for it (or its failure), then for the font file.
// Never waits longer than 5 s: after that canvases simply keep the fallback font.
const fontsReady = new Promise((resolve) => {
  const link = document.getElementById('fontsheet');
  const timer = setTimeout(resolve, 5000);
  const finish = () => { clearTimeout(timer); resolve(); };
  const loadFont = () => {
    if (!(document.fonts && document.fonts.load)) return finish();
    document.fonts.load('16px "Press Start 2P"').catch(() => {}).then(finish);
  };
  const state = link && link.dataset.state;
  if (!link || state === 'ok') loadFont();
  else if (state === 'err') finish();
  else { link.addEventListener('load', loadFont); link.addEventListener('error', finish); }
});

// Canvas roundRect() is missing in Safari < 16 and Firefox < 112; without it those browsers would throw while building the room.
function polyfillRoundRect(proto) {
  if (!proto || proto.roundRect) return;
  proto.roundRect = function (x, y, w, h, r = 0) {
    const rad = Math.max(0, Math.min(Array.isArray(r) ? +r[0] || 0 : +r || 0, Math.abs(w) / 2, Math.abs(h) / 2));
    this.moveTo(x + rad, y);
    this.arcTo(x + w, y, x + w, y + h, rad); this.arcTo(x + w, y + h, x, y + h, rad);
    this.arcTo(x, y + h, x, y, rad); this.arcTo(x, y, x + w, y, rad);
    this.closePath();
  };
}
polyfillRoundRect(window.CanvasRenderingContext2D && CanvasRenderingContext2D.prototype);
polyfillRoundRect(window.Path2D && Path2D.prototype);
