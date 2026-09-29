// ═══════════════ CABINET ARTWORK: attract-mode screens, marquees, side decals, control panels ═══════════════
// Owner: screens agent. Entry points: makeCabinetArt(index[, {x, z, rot}]) and GAME_COUNT.
// Everything is drawn on 2D canvases at runtime (no image files).
//
// How this part works
//  * GAMES (table below) lists every game: palette, logo lines, mascot, title backdrop, side-decal style and a
//    `demo(g, u, A)` function. Demos are PURE FUNCTIONS OF TIME `u` (seconds into the demo), so a screen can be
//    throttled, skipped while out of view and resumed later without any simulation state. Anything that needs a
//    real simulation (falling blocks, breakout ball) is pre-computed once in the game's `init(A)`.
//  * A screen cycles TITLE -> DEMO -> HIGH SCORES -> INSERT COIN; every cabinet is phase-shifted by its index.
//  * Each redraw goes into a 256x192 buffer; scrCompose() then bakes the CRT look (phosphor glow, scanlines,
//    RGB mask, vignette, flicker, rare glitch) and the texture is uploaded.
//  * One shared scheduler (a single onUpdate hook) throttles every screen to SCR_FPS, skips screens that are far
//    away, behind the camera or facing away, and hard-caps the redraws per frame.
//  * To add a game: write `myInit(A)` / `myDemo(g, u, A)`, then add one line to GAMES.

// ── 1. Tunables ──
const SCR_W = 256, SCR_H = 192;                 // screen texture size (4:3)
const SCR_FPS = 15;                             // redraws per second of one screen
const SCR_MAX_UPDATES = 3;                      // hard cap on screen redraws (texture uploads) per rendered frame
const SCR_CULL_DIST = 14;                       // metres: farther screens are not redrawn
const SCR_PHASES = [5, 15, 5, 4];               // seconds: TITLE, DEMO, HIGH SCORES, INSERT COIN
const SCR_CYCLE = 29;                           // sum of SCR_PHASES
const SCR_STAGGER = 4.3;                        // seconds of phase shift between neighbouring cabinet indices
const SCR_GLITCH_GAP = [15, 25];                // seconds between glitches (each hits one random visible cabinet)
const SCR_GLITCH_LEN = 0.55;                    // seconds a glitch lasts
const SCR_FADE = 0.3;                           // fade-in at the start of every phase

// ── 2. Game table ──
// pal = [main, accent, dark, background] (css); titleStyle / side = backdrop style names used by scrBackdrop();
// mascot = sprite key or drawing function (see section 6); keys = the three button legends on the control panel;
// hs = 'pts' or 'time' (kind of high-score table).
const GAMES = [
  { id: 'astro',    name: 'ASTRO BLAST',   lines: ['ASTRO', 'BLAST'],     tag: 'SHOOT-EM-UP',      color: 0xff2a2a, pal: ['#ff3b30', '#ffc21a', '#6a0d14', '#0c0208'], titleStyle: 'stars',   side: 'burst',   mascot: 'ship',      keys: ['FIRE', 'BOMB', 'AUTO'],     hs: 'pts',  init: astroInit,  demo: astroDemo },
  { id: 'racer',    name: 'NEON RACER',    lines: ['NEON', 'RACER'],      tag: 'DRIVING GAME',     color: 0xff8c00, pal: ['#ff8a1f', '#ff2bd6', '#5a0a5a', '#12002a'], titleStyle: 'sunset',  side: 'stripes', mascot: mascotCar,   keys: ['TURBO', 'BRAKE', 'GEAR'],   hs: 'time', mrat: 2.1, init: racerInit,  demo: racerDemo },
  { id: 'pac',      name: 'PIXEL PAC',     lines: ['PIXEL', 'PAC'],       tag: 'MAZE CHASE',       color: 0xffe600, pal: ['#ffe600', '#2b4bff', '#101070', '#02020c'], titleStyle: 'grid',    side: 'chevron', mascot: mascotPac,   keys: ['START', 'BOOST', 'WARP'],   hs: 'pts',  mrat: 2.2, init: pacInit,    demo: pacDemo },
  { id: 'robo',     name: 'ROBO SMASH',    lines: ['ROBO', 'SMASH'],      tag: 'VERSUS FIGHTER',   color: 0x7dff2a, pal: ['#7dff2a', '#ff5a1f', '#1a5a10', '#040a04'], titleStyle: 'city',    side: 'checker', mascot: 'robot',     keys: ['PUNCH', 'KICK', 'SUPER'],   hs: 'pts',  init: roboInit,   demo: roboDemo },
  { id: 'dragon',   name: 'DRAGON KEEP',   lines: ['DRAGON', 'KEEP'],     tag: 'DUNGEON QUEST',    color: 0x00ff88, pal: ['#00e58a', '#ffb000', '#0a5a3a', '#031208'], titleStyle: 'burst',   side: 'waves',   mascot: mascotDragon, keys: ['SWORD', 'MAGIC', 'ITEM'],  hs: 'pts',  mrat: 1.6, init: dragonInit, demo: dragonDemo },
  { id: 'invaders', name: 'STAR INVADERS', lines: ['STAR', 'INVADERS'],   tag: 'ALIEN INVASION',   color: 0x00e5ff, pal: ['#00e5ff', '#ff5aff', '#0a4a7a', '#020a14'], titleStyle: 'stars',   side: 'city',    mascot: 'crabA',     keys: ['FIRE', 'LEFT', 'RIGHT'],    hs: 'pts',  init: invInit,    demo: invDemo },
  { id: 'kart',     name: 'TURBO KART',    lines: ['TURBO', 'KART'],      tag: 'KART RACING',      color: 0x2f6bff, pal: ['#3d7bff', '#ffe600', '#12308a', '#040a1e'], titleStyle: 'checker', side: 'chevron', mascot: mascotKart,  keys: ['GAS', 'ITEM', 'DRIFT'],     hs: 'time', mrat: 2.3, init: kartInit,   demo: kartDemo },
  { id: 'block',    name: 'BLOCK DROP',    lines: ['BLOCK', 'DROP'],      tag: 'PUZZLE GAME',      color: 0x9b5cff, pal: ['#b06cff', '#00e5ff', '#3a1a7a', '#0a0420'], titleStyle: 'grid',    side: 'stripes', mascot: mascotBlocks, keys: ['ROTATE', 'DROP', 'HOLD'],  hs: 'pts',  mrat: 1.3, init: blkInit,    demo: blkDemo },
  { id: 'galaxy',   name: 'GALAXY WARS',   lines: ['GALAXY', 'WARS'],     tag: 'SPACE SHOOTER',    color: 0xff2bd6, pal: ['#ff2bd6', '#ffb000', '#5a0a6a', '#0c0220'], titleStyle: 'waves',  side: 'burst',   mascot: 'galaxy',    keys: ['LASER', 'BOMB', 'BEAM'],    hs: 'pts',  init: galaxyInit, demo: galaxyDemo },
  { id: 'pong',     name: 'PONG 2000',     lines: ['PONG', '2000'],       tag: 'THE CLASSIC',      color: 0xe8f0ff, pal: ['#e8f0ff', '#00e5ff', '#1a2a5a', '#04060f'], titleStyle: 'grid',    side: 'checker', mascot: mascotPong,  keys: ['SERVE', 'SPIN', 'SMASH'],   hs: 'pts',  mrat: 1.8, init: pongInit,   demo: pongDemo },
  { id: 'snake',    name: 'SNAKE BYTE',    lines: ['SNAKE', 'BYTE'],      tag: 'GROW AND SURVIVE', color: 0xff5c93, pal: ['#ff5c93', '#39ff88', '#6a1a3a', '#12040c'], titleStyle: 'checker', side: 'waves',   mascot: mascotSnake, keys: ['LEFT', 'START', 'RIGHT'],   hs: 'pts',  init: snakeInit,  demo: snakeDemo },
  { id: 'zombie',   name: 'ZOMBIE ZAP',    lines: ['ZOMBIE', 'ZAP'],      tag: 'SURVIVAL SHOOTER', color: 0x39ff88, pal: ['#39ff88', '#ff2a3a', '#0a3a1a', '#040a06'], titleStyle: 'city',    side: 'burst',   mascot: mascotZombie, keys: ['FIRE', 'ROLL', 'NUKE'],    hs: 'pts',  mrat: 0.9, init: zombieInit, demo: zombieDemo },
  { id: 'brawl',    name: 'STREET BRAWL',  lines: ['STREET', 'BRAWL'],    tag: 'BEAT-EM-UP',       color: 0xff6a00, pal: ['#ff6a00', '#ffe600', '#7a2a00', '#140804'], titleStyle: 'city',    side: 'stripes', mascot: mascotFist,  keys: ['PUNCH', 'JUMP', 'KICK'],    hs: 'pts',  mrat: 1.3, init: brawlInit,  demo: brawlDemo },
  { id: 'hoop',     name: 'HOOP SHOT',     lines: ['HOOP', 'SHOT'],       tag: 'BASKETBALL',       color: 0x46a0ff, pal: ['#46a0ff', '#ff8c1a', '#12408a', '#040a1e'], titleStyle: 'burst',   side: 'chevron', mascot: mascotBall,  keys: ['SHOOT', 'PASS', 'TURBO'],   hs: 'pts',  init: hoopInit,   demo: hoopDemo },
  { id: 'frog',     name: 'FROG HOP',      lines: ['FROG', 'HOP'],        tag: 'CROSS THE ROAD',   color: 0xc8ff2a, pal: ['#c8ff2a', '#00e5ff', '#3a6a0a', '#081204'], titleStyle: 'waves',   side: 'checker', mascot: mascotFrog,  keys: ['HOP', 'HOP', 'HOP'],        hs: 'pts',  mrat: 1.2, init: frogInit,   demo: frogDemo },
  { id: 'dive',     name: 'DEEP DIVE',     lines: ['DEEP', 'DIVE'],       tag: 'TREASURE HUNT',    color: 0x00c8b4, pal: ['#00d8c0', '#ffe600', '#06507a', '#021018'], titleStyle: 'sky',     side: 'burst',   mascot: mascotFish,  keys: ['SPEAR', 'FLARE', 'SWIM'],   hs: 'pts',  mrat: 1.6, init: diveInit,   demo: diveDemo },
  { id: 'brick',    name: 'BRICK BUSTER',  lines: ['BRICK', 'BUSTER'],    tag: 'BREAK THE WALL',   color: 0xff3d7f, pal: ['#ff3d7f', '#ffe600', '#7a1a3a', '#14040c'], titleStyle: 'checker', side: 'grid',    mascot: mascotBrick, keys: ['LAUNCH', 'LEFT', 'RIGHT'],  hs: 'pts',  mrat: 1.8, init: brickInit,  demo: brickDemo },
  { id: 'jump',     name: 'JUMP QUEST',    lines: ['JUMP', 'QUEST'],      tag: 'PLATFORM ADVENTURE', color: 0xffb000, pal: ['#ffb000', '#ff3b3b', '#a04a00', '#0a1a3a'], titleStyle: 'sky',   side: 'chevron', mascot: mascotHero,  keys: ['RUN', 'JUMP', 'FIRE'],      hs: 'pts',  init: jumpInit,   demo: jumpDemo },
];
const GAME_COUNT = GAMES.length;                // >= 18 distinct games
const GAME_NAMES = GAMES.map((d) => d.name);
const GAME_COLORS = GAMES.map((d) => d.color);

// ── 3. Small helpers ──
const scrClamp = (x, a = 0, b = 1) => (x < a ? a : x > b ? b : x);
const scrEase = (x) => { x = scrClamp(x); return x * x * (3 - 2 * x); };            // smoothstep
const scrTri = (x) => { const m = ((x % 2) + 2) % 2; return m < 1 ? m : 2 - m; };    // triangle wave 0..1..0, period 2
const scrLerp = (a, b, k) => a + (b - a) * k;
// Stateless noise in [0,1): the same input always gives the same output (animation = pure function of time).
function scrHash(n) {
  n = Math.imul((n | 0) ^ ((n | 0) >>> 15), 0x2c1b3c6d);
  n = Math.imul(n ^ (n >>> 12), 0x297a2d39);
  return ((n ^ (n >>> 15)) >>> 0) / 4294967296;
}
const _scrP = { x: 0, y: 0, dx: 0, dy: 0 };     // scratch output shared by helpers, so per-frame code never allocates

// Pixel-snapped filled rectangle (fractions are rounded so edges never blur).
function scrRect(g, col, x, y, w, h) {
  const x0 = Math.round(x), y0 = Math.round(y);
  g.fillStyle = col;
  g.fillRect(x0, y0, Math.round(x + w) - x0, Math.round(y + h) - y0);
}
// Filled disc built from pixel spans (crisp, no anti-aliasing).
function scrDisc(g, col, cx, cy, r) {
  g.fillStyle = col;
  cx = Math.round(cx); cy = Math.round(cy); r = Math.round(r);
  for (let dy = -r; dy <= r; dy++) {
    const hw = Math.floor(Math.sqrt(r * r + r - dy * dy));
    g.fillRect(cx - hw, cy + dy, hw * 2 + 1, 1);
  }
}
// Draws `draw(ctx)` into a new canvas (default screen size) with smoothing off, and returns the canvas.
function scrLayer(draw, w = SCR_W, h = SCR_H) {
  const { canvas, ctx } = makeCanvas(w, h);
  ctx.imageSmoothingEnabled = false;
  draw(ctx, canvas);
  return canvas;
}
// Closed polyline path with arc-length lookup: scrPathAt(path, distance) -> _scrP {x, y, dx, dy}.
function scrMakePath(pts) {
  const cum = [0];
  for (let i = 0; i < pts.length; i++) {
    const a = pts[i], b = pts[(i + 1) % pts.length];
    cum.push(cum[i] + Math.hypot(b[0] - a[0], b[1] - a[1]));
  }
  return { pts, cum, len: cum[pts.length] };
}
function scrPathAt(path, d, out = _scrP) {
  d = ((d % path.len) + path.len) % path.len;
  let i = 0;
  while (i < path.pts.length - 1 && path.cum[i + 1] <= d) i++;
  const a = path.pts[i], b = path.pts[(i + 1) % path.pts.length], seg = path.cum[i + 1] - path.cum[i] || 1;
  const f = (d - path.cum[i]) / seg;
  out.dx = (b[0] - a[0]) / seg; out.dy = (b[1] - a[1]) / seg;
  out.x = a[0] + (b[0] - a[0]) * f; out.y = a[1] + (b[1] - a[1]) * f;
  return out;
}
// Glide along timed targets ev = [{t, x}] (sorted): the mover arrives `lead` seconds before each event; start = x at time 0.
function scrGlide(u, ev, lead, start) {
  let px = start, pt = 0;
  for (let k = 0; k < ev.length; k++) {
    const ta = ev[k].t - lead;
    if (u < ta) return px + (ev[k].x - px) * scrEase((u - pt) / Math.max(0.2, ta - pt));
    px = ev[k].x; pt = ta;
  }
  return px;
}
// Scrolling starfield: n stars, drifting by (vx, vy) px/s, wrapped around the screen.
function scrStars(g, u, n, vx, vy, size, col, seed) {
  g.fillStyle = col;
  for (let i = 0; i < n; i++) {
    const x = (((scrHash(seed * 131 + i) * SCR_W + u * vx) % SCR_W) + SCR_W) % SCR_W;
    const y = (((scrHash(seed * 131 + i + 64) * SCR_H + u * vy) % SCR_H) + SCR_H) % SCR_H;
    g.fillRect(x | 0, y | 0, size, size);
  }
}
// Pixel explosion: age 0..0.6 s. A ring, then debris on hashed directions.
function scrBoom(g, x, y, age, size, c1, c2, seed) {
  if (age < 0 || age > 0.6) return;
  const p = age / 0.6, r = 2 + p * size;
  g.globalAlpha = 1 - p * p;
  g.strokeStyle = c1; g.lineWidth = 2;
  g.beginPath(); g.arc(x, y, r * 0.7, 0, 6.2832); g.stroke();
  for (let i = 0; i < 10; i++) {
    const a = scrHash(seed * 13 + i) * 6.2832, d = r * (0.5 + scrHash(seed * 17 + i) * 0.9);
    scrRect(g, i & 1 ? c1 : c2, x + Math.cos(a) * d, y + Math.sin(a) * d, 2, 2);
  }
  g.globalAlpha = 1;
}

// ── 4. Pixel text: 8x8 glyph atlas (one per colour), so text looks the same with or without the web font ──
const SCR_CHARS = ' ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789.,:!?-+/\'"()*<>=%$#&';
const SCR_CHAR_INDEX = new Int16Array(128).fill(-1);
for (let i = 0; i < SCR_CHARS.length; i++) {
  SCR_CHAR_INDEX[SCR_CHARS.charCodeAt(i)] = i;
  SCR_CHAR_INDEX[SCR_CHARS.toLowerCase().charCodeAt(i)] = i;          // lower case prints as upper case
}
let scrFontEpoch = 0;                            // bumped when the web font arrives: all text layers rebuild
let _scrAtlasBase = null, _scrAtlasEpoch = -1;
const _scrAtlas = new Map();

// White glyph sheet: each character in an 8x8 cell, alpha hard-thresholded so even the fallback font reads as bitmap text.
function scrAtlasBase() {
  if (_scrAtlasBase && _scrAtlasEpoch === scrFontEpoch) return _scrAtlasBase;
  const c = document.createElement('canvas');
  c.width = SCR_CHARS.length * 8; c.height = 8;
  const g = c.getContext('2d', { willReadFrequently: true });
  g.font = '16px ' + ARCADE_FONT;
  const real = g.measureText('WWWW').width > 56;                       // 1 em per glyph = the real pixel font
  g.font = (real ? '8px ' : 'bold 9px ') + ARCADE_FONT;
  g.textAlign = 'center'; g.textBaseline = 'middle'; g.fillStyle = '#fff';
  for (let i = 0; i < SCR_CHARS.length; i++) g.fillText(SCR_CHARS[i], i * 8 + 4, real ? 4 : 4.5);
  const im = g.getImageData(0, 0, c.width, 8), d = im.data;
  for (let i = 3; i < d.length; i += 4) d[i] = d[i] > 90 ? 255 : 0;
  g.putImageData(im, 0, 0);
  _scrAtlas.clear();
  _scrAtlasBase = c; _scrAtlasEpoch = scrFontEpoch;
  return c;
}
function scrAtlas(col) {
  const base = scrAtlasBase();
  let a = _scrAtlas.get(col);
  if (!a) {
    const { canvas, ctx } = makeCanvas(base.width, 8);
    ctx.drawImage(base, 0, 0);
    ctx.globalCompositeOperation = 'source-in';
    ctx.fillStyle = col; ctx.fillRect(0, 0, base.width, 8);
    _scrAtlas.set(col, a = canvas);
  }
  return a;
}
// Text with its top-left at (x, y); each glyph is 8*scale px wide; align 0/1/2 = left/centre/right.
function scrText(g, str, x, y, col, scale = 1, align = 0) {
  const a = scrAtlas(col), w = 8 * scale, n = str.length;
  x = Math.round(align === 1 ? x - (n * w) / 2 : align === 2 ? x - n * w : x); y = Math.round(y);
  for (let i = 0; i < n; i++) {
    const k = SCR_CHAR_INDEX[str.charCodeAt(i) & 127];
    if (k > 0) g.drawImage(a, k * 8, 0, 8, 8, x + i * w, y, w, w);
  }
}
// Same with a 1px drop shadow.
function scrTextS(g, str, x, y, col, scale = 1, align = 0) {
  scrText(g, str, x + scale, y + scale, '#000000', scale, align);
  scrText(g, str, x, y, col, scale, align);
}
// Zero-padded integer in `digits` cells: no string allocation per frame.
function scrNum(g, n, digits, x, y, col, scale = 1) {
  const a = scrAtlas(col), w = 8 * scale;
  n = Math.floor(Math.max(0, n));
  for (let i = digits - 1; i >= 0; i--) {
    g.drawImage(a, SCR_CHAR_INDEX[48 + (n % 10)] * 8, 0, 8, 8, x + i * w, y, w, w);
    n = Math.floor(n / 10);
  }
}
// Top score line shared by many demos: 1UP score on the left, HI score on the right.
function scrHud(g, u, score, hi, col = '#ff5a5a') {
  if (((u * 2) | 0) % 2 === 0) scrText(g, '1UP', 6, 2, col);
  scrNum(g, score, 6, 34, 2, '#ffffff');
  scrText(g, 'HI', 138, 2, col);
  scrNum(g, hi, 6, 158, 2, '#ffffff');
}

// ── 5. Sprites: rows of characters ('#' = tint colour, '.' = transparent, other letters = SCR_PAL) ──
const SCR_PAL = { w: '#ffffff', k: '#14101f', r: '#ff2a3a', y: '#ffe600', o: '#ff8a1f', b: '#2f6bff', c: '#00e5ff', g: '#39ff88',
                  p: '#ff2bd6', m: '#9b5cff', s: '#ffc9a0', n: '#8a5a2b', e: '#8f95ad', l: '#d5d9ea', d: '#3a3550',
                  R: '#a01426', G: '#1e9a55', B: '#1a3fa8', Y: '#c8a800', O: '#b85a00', P: '#a0187f', C: '#008ea3' };
const _scrSpriteCache = new Map();
// Returns { c: canvas, w, h } for SPRITES[key] tinted with `main` (cached).
function scrSprite(key, main = '#ffffff') {
  const id = key + main;
  let sp = _scrSpriteCache.get(id);
  if (sp) return sp;
  const rows = SPRITES[key];
  let w = 0;
  for (let i = 0; i < rows.length; i++) w = Math.max(w, rows[i].length);
  const { canvas, ctx } = makeCanvas(w, rows.length);
  for (let y = 0; y < rows.length; y++) {
    for (let x = 0; x < rows[y].length; x++) {
      const ch = rows[y][x];
      if (ch === '.' || ch === ' ') continue;
      ctx.fillStyle = ch === '#' ? main : SCR_PAL[ch] || '#f0f';
      ctx.fillRect(x, y, 1, 1);
    }
  }
  _scrSpriteCache.set(id, sp = { c: canvas, w, h: rows.length });
  return sp;
}
// Draws a sprite with its top-left at (x, y) at integer scale k.
function scrBlit(g, sp, x, y, k = 1) { g.drawImage(sp.c, Math.round(x), Math.round(y), sp.w * k, sp.h * k); }
// Same, centred on (cx, cy).
function scrBlitC(g, sp, cx, cy, k = 1) { scrBlit(g, sp, cx - (sp.w * k) / 2, cy - (sp.h * k) / 2, k); }
// Returns a function R(color, ux, uy, w, h) that draws rectangles in unit space around (cx, cy), one unit = k px.
function scrUnit(g, cx, cy, k) { return (col, ux, uy, w, h) => scrRect(g, col, cx + ux * k, cy + uy * k, w * k, h * k); }
// Rect in unit space: origin (ox, oy), one unit = k px (used by drawing functions that scale, e.g. big creatures).
function scrRectU(g, k, ox, oy, col, ux, uy, w, h) { scrRect(g, col, ox + ux * k, oy + uy * k, w * k, h * k); }
// Sprite centred on (cx, cy), rotated by ang radians.
function scrBlitRot(g, sp, cx, cy, k, ang) {
  g.save(); g.translate(Math.round(cx), Math.round(cy)); g.rotate(ang);
  g.drawImage(sp.c, -(sp.w * k) / 2, -(sp.h * k) / 2, sp.w * k, sp.h * k); g.restore();
}

// ── 6. Sprite data (shared by demos and mascots) ──
const SPRITES = {
  // Marching-grid aliens, two animation frames each
  squidA: ['...##...', '..####..', '.######.', '##.##.##', '########', '..#..#..', '.#.##.#.', '#.#..#.#'],
  squidB: ['...##...', '..####..', '.######.', '##.##.##', '########', '.#.##.#.', '#......#', '.#....#.'],
  crabA: ['..#.....#..', '...#...#...', '..#######..', '.##.###.##.', '###########', '#.#######.#', '#.#.....#.#', '...##.##...'],
  crabB: ['..#.....#..', '#..#...#..#', '#.#######.#', '###.###.###', '###########', '.#########.', '..#.....#..', '.#.......#.'],
  octoA: ['....####....', '.##########.', '############', '###..##..###', '############', '...##..##...', '..##.##.##..', '##........##'],
  octoB: ['....####....', '.##########.', '############', '###..##..###', '############', '..###..###..', '.##..##..##.', '..##....##..'],
  ufo: ['.....######.....', '...##########...', '..############..', '.##.##.##.##.##.', '################', '..###..##..###..', '...#........#...'],
  cannon: ['......#......', '.....###.....', '.....###.....', '.###########.', '#############', '#############', '#############', '#############'],
  bunker: ['......##########......', '....##############....', '...################...', '..##################..', '.####################.', '######################',
           '######################', '######################', '######################', '######################', '#######........#######', '######..........######',
           '#####............#####'],
  heart: ['.##.##.', '#######', '#######', '.#####.', '..###..', '...#...'],
  // Shoot-em-up craft
  ship: ['......w......', '.....wcw.....', '.....wcw.....', '....bwcwb....', '....bbcbb....', '..b.bbbbb.b..', '..bbbbwbbbb..', '.bbbbbbbbbbb.',
         'bbbwebbbebwbb', 'bbb.eeeee.bbb', 'bb.rebbber.bb', 'b..r.ebe.r..b', '...ry.e.yr...', '....y...y....'],
  enemyA: ['.p.......p.', '.pp.....pp.', '.ppp.y.ppp.', 'pppppyppppp', 'pwwpppppwwp', 'ppp.ppp.ppp', '.p..ppp..p.', '....p.p....'],
  enemyB: ['...oooooo...', '..oooooooo..', '.oowwoowwoo.', 'oooooooooooo', 'oyoyoyoyoyoy', '.oooooooooo.', '..oo.oo.oo..', '.o...oo...o.'],
  galaxy: ['..........m....', '...pp.....mm...', '..pppp...mmm...', '.pppppppppmmmm.', 'ppwwppppppppccc', '.pppppppppmmmm.', '..pppp...mmm...', '...pp.....mm...', '..........m....'],
  // Boxy fighting robot (front view, used as mascot)
  robot: ['.....##.....', '.....##.....', '..########..', '.##########.', '.#wwkkkkww#.', '.#wwkkkkww#.', '.##########.', '..########..', '....####....', '.##########.',
          '############', '##.######.##', '##.#yyyy#.##', '##.######.##', '##.##..##.##', '...##..##...', '..###..###..', '.####..####.'],
};

// ── 7. Demos (one init/demo pair per game) ──
// demo(g, u, A): g = 256x192 context, u = seconds since the demo started (0..15), A = assets built by init(A).
// The bottom 10 px are covered by the shared CREDIT / INSERT COIN strip, so gameplay stays above y = 182.

// ───────── ASTRO BLAST: vertical shoot-em-up with waves, explosions and a boss warning ─────────
const ASTRO_WAVES = 4, ASTRO_PER_WAVE = 5;
const astroSpawnT = (w, i) => w * 3.4 + i * 0.3;
const astroKillAge = (w, i) => 1.6 + scrHash(w * 9 + i) * 1.1;
function astroEnemy(w, i, age, out) {            // where enemy i of wave w is `age` seconds after it entered
  out.x = 50 + (w % 3) * 78 + Math.sin(age * 2.2 + w * 1.3) * 34 + (i - 2) * 6;
  out.y = -14 + age * 48;
}
function astroInit(A) {
  A.bg = scrLayer((g) => {
    const gr = g.createLinearGradient(0, 0, 0, SCR_H);
    gr.addColorStop(0, '#04020f'); gr.addColorStop(1, '#1a0510');
    g.fillStyle = gr; g.fillRect(0, 0, SCR_W, SCR_H);
    for (let i = 0; i < 5; i++) {                                   // soft nebula clouds
      const x = scrHash(i * 3 + 1) * SCR_W, y = scrHash(i * 3 + 2) * SCR_H, r = 50 + scrHash(i * 3 + 3) * 50;
      const rg = g.createRadialGradient(x, y, 0, x, y, r);
      rg.addColorStop(0, i % 2 ? 'rgba(255,40,70,0.22)' : 'rgba(120,40,255,0.2)'); rg.addColorStop(1, 'rgba(0,0,0,0)');
      g.fillStyle = rg; g.fillRect(x - r, y - r, r * 2, r * 2);
    }
  });
  A.ship = scrSprite('ship'); A.eA = scrSprite('enemyA'); A.eB = scrSprite('enemyB');
  A.kills = [];                                                     // when and where each enemy is shot down
  for (let w = 0; w < ASTRO_WAVES; w++) {
    for (let i = 0; i < ASTRO_PER_WAVE; i++) {
      const age = astroKillAge(w, i);
      astroEnemy(w, i, age, _scrP);
      A.kills.push({ t: astroSpawnT(w, i) + age, x: _scrP.x, y: _scrP.y });
    }
  }
  A.kills.sort((a, b) => a.t - b.t);
}
function astroDemo(g, u, A) {
  const K = A.kills;
  g.drawImage(A.bg, 0, 0);
  scrStars(g, u, 30, 0, 24, 1, '#6c6c9c', 1); scrStars(g, u, 18, 0, 60, 1, '#c8c8ff', 2); scrStars(g, u, 8, 0, 130, 2, '#ffffff', 3);
  for (let w = 0; w < ASTRO_WAVES; w++) {                           // enemies still alive
    for (let i = 0; i < ASTRO_PER_WAVE; i++) {
      const age = u - astroSpawnT(w, i);
      if (age < 0 || age > astroKillAge(w, i)) continue;
      astroEnemy(w, i, age, _scrP);
      scrBlitC(g, (w + i) & 1 ? A.eA : A.eB, _scrP.x, _scrP.y, 2);
    }
  }
  let done = 0;
  for (let k = 0; k < K.length; k++) {                              // shots and explosions
    const ev = K[k], p = (u - (ev.t - 0.4)) / 0.4;
    if (ev.t <= u) done++;
    if (p >= 0 && p <= 1) {
      const x0 = scrGlide(ev.t - 0.4, K, 0.35, 128), bx = x0 + (ev.x - x0) * p, by = 138 + (ev.y - 138) * p;
      scrRect(g, '#ff9f1a', bx - 2, by - 5, 4, 10); scrRect(g, '#ffffff', bx - 1, by - 5, 2, 10);
    }
    scrBoom(g, ev.x, ev.y, u - ev.t, 22, '#ffe600', '#ff5a1f', k);
  }
  scrBlitC(g, A.ship, scrGlide(u, K, 0.35, 128), 152 + Math.sin(u * 3) * 2, 2);
  if (u > 11 && u < 13.6 && ((u * 4) | 0) % 2 === 0) {              // WARNING band, then the boss drops in
    scrRect(g, 'rgba(255,30,40,0.35)', 0, 74, SCR_W, 30);
    scrText(g, 'WARNING', 128, 83, '#ffffff', 2, 1);
  }
  if (u > 13.2) {
    const by = -30 + scrEase((u - 13.2) / 1.8) * 66;
    scrBlitC(g, A.eB, 128 + Math.sin(u * 1.4) * 50, by, 6);
    scrRect(g, '#40060c', 28, 14, 200, 5); scrRect(g, '#ff2a3a', 29, 15, 198 * (1 - scrClamp((u - 14) / 4) * 0.4), 3);
  }
  scrHud(g, u, 1200 + done * 150, 50000);
  scrBlit(g, A.ship, 6, 166, 1); scrBlit(g, A.ship, 22, 166, 1);
  scrText(g, 'BOMB X3', 250, 172, '#ffc21a', 1, 2);
}

// ───────── NEON RACER: OutRun-style pseudo-3D road, palms, traffic, speedometer ─────────
const RACER_HZ = 84, RACER_BOTTOM = 182;
function racerInit(A) {
  A.bg = scrLayer((g) => {
    const HZ = RACER_HZ;
    const sky = g.createLinearGradient(0, 0, 0, HZ);
    sky.addColorStop(0, '#12002e'); sky.addColorStop(0.5, '#6a1a8a'); sky.addColorStop(0.82, '#ff3f8f'); sky.addColorStop(1, '#ffb347');
    g.fillStyle = sky; g.fillRect(0, 0, SCR_W, HZ);
    for (let i = 0; i < 26; i++) scrRect(g, '#ffffff', scrHash(i) * SCR_W, scrHash(i + 40) * 34, 1, 1);
    const sun = g.createLinearGradient(0, HZ - 42, 0, HZ);
    sun.addColorStop(0, '#fff17a'); sun.addColorStop(1, '#ff4f9a');
    g.fillStyle = sun; g.beginPath(); g.arc(128, HZ, 40, Math.PI, 2 * Math.PI); g.fill();
    g.fillStyle = sky;                                              // the classic cut-out stripes: repaint sky bars over the sun
    for (let i = 0; i < 6; i++) g.fillRect(84, HZ - 5 - i * 6, 88, 1 + i * 0.7);
    for (let layer = 0; layer < 2; layer++) {                       // two ranges of mountains
      g.fillStyle = layer ? '#2a0a4a' : '#4a145e';
      g.beginPath(); g.moveTo(0, HZ);
      for (let x = 0; x <= SCR_W; x += 8) g.lineTo(x, HZ - 3 - (scrHash(x + layer * 99) * 9 + Math.sin(x * 0.05 + layer * 2) * 4 + 5) * (layer ? 0.7 : 1.2));
      g.lineTo(SCR_W, HZ); g.fill();
    }
    g.fillStyle = '#1b0836'; g.fillRect(0, HZ, SCR_W, SCR_H - HZ);
  });
}
// Road centre (out.x) and half width (out.dx) at depth p (0 = horizon, 1 = bottom of the screen).
function racerRoad(p, bend, out) {
  out.x = 128 + bend * 96 * (1 - p) * (1 - p);
  out.dx = 5 + p * 118;
}
const RACER_FROND = [[-1, -0.2], [-0.7, -0.6], [-0.3, -0.85], [0.3, -0.85], [0.7, -0.6], [1, -0.2]];
function racerPalm(g, x, y, s) {                                    // dark silhouette palm tree, s = height in px
  g.fillStyle = '#0d0420';
  g.fillRect(Math.round(x - s * 0.04), Math.round(y - s), Math.max(2, Math.round(s * 0.09)), Math.round(s));
  g.strokeStyle = '#0d0420'; g.lineWidth = Math.max(1, s * 0.05);
  g.beginPath();
  for (let f = 0; f < 6; f++) {
    const fx = RACER_FROND[f][0], fy = RACER_FROND[f][1];
    g.moveTo(x, y - s);
    g.quadraticCurveTo(x + fx * s * 0.28, y - s + fy * s * 0.4, x + fx * s * 0.5, y - s + fy * s * 0.1 + s * 0.2);
  }
  g.stroke();
}
function racerCar(g, x, y, w, body) {                               // rear view of a car whose bottom edge is at y
  const h = w * 0.45;
  scrRect(g, '#0a0614', x - w * 0.5, y - h * 0.3, w, h * 0.3);                 // shadow / bumper
  scrRect(g, body, x - w * 0.5, y - h, w, h * 0.7);
  scrRect(g, body, x - w * 0.36, y - h * 1.45, w * 0.72, h * 0.5);
  scrRect(g, '#1a1030', x - w * 0.3, y - h * 1.38, w * 0.6, h * 0.34);         // rear window
  scrRect(g, '#ff2a3a', x - w * 0.46, y - h * 0.85, w * 0.22, h * 0.24);       // tail lights
  scrRect(g, '#ff2a3a', x + w * 0.24, y - h * 0.85, w * 0.22, h * 0.24);
  scrRect(g, '#111', x - w * 0.52, y - h * 0.32, w * 0.16, h * 0.34);          // tyres
  scrRect(g, '#111', x + w * 0.36, y - h * 0.32, w * 0.16, h * 0.34);
}
const RACER_TRAFFIC = ['#2b8bff', '#ffe600', '#39ff88', '#ffffff'];
function racerDemo(g, u, A) {
  const HZ = RACER_HZ, B = RACER_BOTTOM, run = Math.max(0, u - 2.7);
  const d = run < 3 ? 0.9 * run * run : 8.1 + (run - 3) * 5.4;                  // distance driven, in stripes
  const speed = scrClamp(run / 3) * 292 + Math.sin(u * 2) * 3;
  const bend = run > 0 ? Math.sin(u * 0.55) * 0.9 + Math.sin(u * 0.23) * 0.3 : 0;
  g.drawImage(A.bg, 0, 0);
  for (let y = B - 2; y > HZ; y -= 2) {                                         // road, two pixel rows at a time
    const p = (y - HZ) / (B - HZ);
    racerRoad(p, bend, _scrP);
    const cx = _scrP.x, half = _scrP.dx, band = (((0.55 / (p + 0.05) + d) % 2) + 2) % 2 < 1;
    scrRect(g, band ? '#2d0a55' : '#3c1275', 0, y, SCR_W, 2);
    const rum = half * 0.1 + 1, rc = band ? '#ff2bd6' : '#ffffff';
    scrRect(g, rc, cx - half - rum, y, rum, 2); scrRect(g, rc, cx + half, y, rum, 2);
    scrRect(g, band ? '#4a4864' : '#403e5a', cx - half, y, half * 2, 2);
    if (band) {
      const w = half * 0.025 + 0.6;
      scrRect(g, '#ffd84a', cx - half * 0.34 - w, y, w * 2, 2); scrRect(g, '#ffd84a', cx + half * 0.34 - w, y, w * 2, 2);
    }
  }
  const tp = d * 0.09;                                                          // palm trees on both verges, far to near
  for (let j = 0; j < 7; j++) {
    const z = (j + (tp % 1)) / 7, id = j + Math.floor(tp), p = z * z;
    if (p < 0.02) continue;
    racerRoad(p, bend, _scrP);
    racerPalm(g, _scrP.x + (id & 1 ? 1 : -1) * (_scrP.dx * 1.5 + 5), HZ + p * (B - HZ), 8 + p * 70);
  }
  for (let k = 0; k < 4; k++) {                                                 // traffic in the outer lanes
    const z = (k * 0.27 + d * 0.014) % 1, p = z * z;
    if (p < 0.03 || z > 0.9) continue;
    racerRoad(p, bend, _scrP);
    racerCar(g, _scrP.x + (k & 1 ? 1 : -1) * _scrP.dx * 0.34, HZ + p * (B - HZ), _scrP.dx * 0.3, RACER_TRAFFIC[k]);
  }
  const px = 128 - bend * 12 + Math.sin(u * 1.7) * 3;                           // the player's car
  racerCar(g, px, 176, 46, '#ff2a3a');
  scrRect(g, '#3a0a14', px - 22, 156, 44, 2);                                  // spoiler
  if (run > 0 && ((u * 20) | 0) % 2) scrRect(g, '#ffb347', px - 4, 173, 8, 4);  // exhaust flicker
  // speedometer
  g.fillStyle = 'rgba(8,4,20,0.85)'; g.beginPath(); g.arc(224, 182, 27, Math.PI, 2 * Math.PI); g.fill();
  g.strokeStyle = '#ff2bd6'; g.lineWidth = 2; g.beginPath(); g.arc(224, 182, 26, Math.PI, 2 * Math.PI); g.stroke();
  g.strokeStyle = '#ffffff'; g.lineWidth = 1; g.beginPath();
  for (let i = 0; i <= 8; i++) {
    const a = Math.PI + (i / 8) * Math.PI, c = Math.cos(a), s = Math.sin(a);
    g.moveTo(224 + c * 20, 182 + s * 20); g.lineTo(224 + c * 24, 182 + s * 24);
  }
  g.stroke();
  const na = Math.PI + scrClamp(speed / 300) * Math.PI;
  g.strokeStyle = '#ff4030'; g.lineWidth = 2; g.beginPath(); g.moveTo(224, 182); g.lineTo(224 + Math.cos(na) * 20, 182 + Math.sin(na) * 20); g.stroke();
  scrNum(g, speed, 3, 212, 168, '#ffe600'); scrText(g, 'KM/H', 224, 158, '#ffffff', 1, 1);
  // HUD and the start countdown
  scrText(g, 'TIME', 6, 2, '#ff5a5a'); scrNum(g, Math.max(0, 60 - run), 2, 42, 2, '#ffffff');
  scrText(g, 'SCORE', 88, 2, '#ff5a5a'); scrNum(g, run * run * 210, 7, 132, 2, '#ffffff');
  scrText(g, 'ST 1', 250, 2, '#ffe600', 1, 2);
  if (u < 3.6) {
    const n = 3 - Math.floor(u / 0.9);
    scrTextS(g, n > 0 ? String(n) : 'GO!', 128, 50, n > 0 ? '#ffe600' : '#39ff88', 4, 1);
  }
}

// ───────── PIXEL PAC: maze, chomping hero, dots, power pellet and four ghosts ─────────
const PAC_MAZE = [
  '#####################', '#.........#.........#', '#.###.###.#.###.###.#', '#...................#', '#.###.#.#####.#.###.#',
  '#.....#...#...#.....#', '#.###.#.#####.#.###.#', '#.....#...#...#.....#', '#.###.#.#####.#.###.#', '#...................#',
  '#.###.###.#.###.###.#', '#.........#.........#', '#####################',
];
const PAC_T = 12, PAC_OX = 2, PAC_OY = 20;                          // tile size and maze origin
const PAC_RING = [[1, 3], [19, 3], [19, 9], [1, 9]];                // hero laps a rectangle of corridors (cells)
const PAC_SPEED = 40, PAC_SPEED_BACK = 44, PAC_FLEE = 30;           // px/s
const PAC_POWER_D = 216;                                            // ring distance of the first power pellet
const PAC_POWER_T = PAC_POWER_D / PAC_SPEED, PAC_READY = 1.6;
const PAC_GHOSTS = ['#ff2a2a', '#ffb8de', '#00e5ff', '#ffb847'];
const pacOnRing = (cx, cy) => ((cy === 3 || cy === 9) && cx >= 1 && cx <= 19) || ((cx === 1 || cx === 19) && cy >= 3 && cy <= 9);
function pacInit(A) {
  A.ring = scrMakePath(PAC_RING.map((c) => [PAC_OX + (c[0] + 0.5) * PAC_T, PAC_OY + (c[1] + 0.5) * PAC_T]));
  const open = (cx, cy) => cy >= 0 && cy < 13 && cx >= 0 && cx < 21 && PAC_MAZE[cy][cx] === '.';
  A.bg = scrLayer((g) => {
    scrRect(g, '#02020c', 0, 0, SCR_W, SCR_H);
    for (let cy = 0; cy < 13; cy++) {
      for (let cx = 0; cx < 21; cx++) {
        const x = PAC_OX + cx * PAC_T, y = PAC_OY + cy * PAC_T;
        if (PAC_MAZE[cy][cx] === '#') {
          scrRect(g, '#0a0a48', x, y, PAC_T, PAC_T);
          if (open(cx, cy - 1)) scrRect(g, '#3a5bff', x, y, PAC_T, 2);        // bright edge wherever a wall meets a corridor
          if (open(cx, cy + 1)) scrRect(g, '#3a5bff', x, y + PAC_T - 2, PAC_T, 2);
          if (open(cx - 1, cy)) scrRect(g, '#3a5bff', x, y, 2, PAC_T);
          if (open(cx + 1, cy)) scrRect(g, '#3a5bff', x + PAC_T - 2, y, 2, PAC_T);
        } else if (!pacOnRing(cx, cy)) scrRect(g, '#ffc8a0', x + 5, y + 5, 2, 2);
      }
    }
  });
}
function pacGhost(g, x, y, col, dx, dy, u, mode) {                   // mode 0 normal, 1 frightened, 2 frightened + flashing
  const c = mode === 0 ? col : mode === 2 && ((u * 6) | 0) % 2 ? '#ffffff' : '#2a3cff', w = ((u * 8) | 0) & 1;
  g.fillStyle = c; g.beginPath(); g.arc(x, y - 1, 5.5, Math.PI, 0);
  g.lineTo(x + 5.5, y + 5);
  for (let i = 0; i < 5; i++) g.lineTo(x + 5.5 - (i + 0.5) * 2.2, y + 5 - ((i + w) & 1) * 2);
  g.lineTo(x - 5.5, y + 5); g.closePath(); g.fill();
  if (mode === 0) {
    scrRect(g, '#ffffff', x - 4, y - 3, 3, 4); scrRect(g, '#ffffff', x + 1, y - 3, 3, 4);
    scrRect(g, '#1a3cff', x - 3 + dx * 1.5, y - 2 + dy * 1.5, 2, 2); scrRect(g, '#1a3cff', x + 2 + dx * 1.5, y - 2 + dy * 1.5, 2, 2);
  } else {
    scrRect(g, '#ffd0c0', x - 3, y - 3, 2, 2); scrRect(g, '#ffd0c0', x + 1, y - 3, 2, 2);
    scrRect(g, '#ffd0c0', x - 4, y + 1, 8, 1);
  }
}
function pacDemo(g, u, A) {
  const L = A.ring.len, tt = Math.max(0, u - PAC_READY), power = tt > PAC_POWER_T, s = tt - PAC_POWER_T;
  const D = power ? PAC_POWER_D - PAC_SPEED_BACK * s : PAC_SPEED * tt;    // hero's distance along the ring
  const eatMax = power ? PAC_POWER_D : D;
  g.drawImage(A.bg, 0, 0);
  for (let j = 0; j < 48; j++) {                                          // dots (and pellets) on the ring that are still there
    const d = j * PAC_T;
    if (d <= eatMax || (D < 0 && d >= L + D)) continue;
    scrPathAt(A.ring, d);
    if (d === 216 || d === 288 || d === 504) { if (((u * 3) | 0) % 2 === 0) scrDisc(g, '#ffc8a0', _scrP.x, _scrP.y, 3); }
    else scrRect(g, '#ffc8a0', _scrP.x - 1, _scrP.y - 1, 2, 2);
  }
  const fw = power ? -1 : 1;                                              // hero turns round after the power pellet
  scrPathAt(A.ring, D);
  const hx = _scrP.x, hy = _scrP.y, hdx = _scrP.dx * fw, hdy = _scrP.dy * fw;
  for (let i = 0; i < 4; i++) {                                           // ghosts: chase before the pellet, flee after it
    const gap = 22 + 23 * i;
    let gd = D - gap - Math.sin(u * 3 + i) * 2, mode = 0;
    if (power) {
      gd = PAC_POWER_D - gap - PAC_FLEE * s; mode = s > 4.5 ? 2 : 1;
      const eatS = gap / (PAC_SPEED_BACK - PAC_FLEE);                     // when the hero catches this ghost
      if (s > eatS) {
        if (s < eatS + 0.9) { scrPathAt(A.ring, PAC_POWER_D - gap - PAC_FLEE * eatS); scrText(g, String(200 << i), _scrP.x, _scrP.y - 3, '#00e5ff', 1, 1); }
        continue;
      }
    }
    scrPathAt(A.ring, gd);
    pacGhost(g, _scrP.x, _scrP.y, PAC_GHOSTS[i], _scrP.dx * (power ? -1 : 1), _scrP.dy * (power ? -1 : 1), u, mode);
  }
  const mouth = tt > 0 ? 0.12 + 0.62 * Math.abs(Math.sin(u * 16)) : 0.6, ang = Math.atan2(hdy, hdx);
  g.fillStyle = '#ffe600'; g.beginPath(); g.moveTo(hx, hy); g.arc(hx, hy, 5.8, ang + mouth, ang + 6.2832 - mouth); g.closePath(); g.fill();
  if (u < PAC_READY) scrText(g, 'READY!', 128, 91, '#ffe600', 1, 1);
  scrHud(g, u, 1660 + Math.floor(tt * 40) * 10 + (power ? Math.min(3, Math.floor(s / 1.6)) * 400 : 0), 50000, '#ff5a5a');
}

// ───────── ROBO SMASH: two boxy robots trade blows, health bars, ROUND 1 / FIGHT! / K.O. ─────────
const ROBO_START = 2.6, ROBO_EX = 1.3;                              // first exchange starts after FIGHT!; seconds per exchange
const ROBO_ATTACKER = [0, 1, 0, 0, 1, 0, 0, 0];                     // who strikes in each exchange (0 = left robot)
const ROBO_KICK = [0, 1, 0, 1, 0, 0, 1, 0];                         // 1 = kick, 0 = punch
const ROBO_DAMAGE = [16, 12, 18, 16, 10, 18, 16, 30];
const ROBO_FLOOR = 158;
const _roboS = { x1: 0, x2: 0, p1: 0, p2: 0, k1: 0, k2: 0, h1: 0, h2: 0, hp1: 100, hp2: 100 };
const _roboT = { x1: 0, x2: 0, p1: 0, p2: 0, k1: 0, k2: 0, h1: 0, h2: 0, hp1: 100, hp2: 100 };
// Fight choreography as a pure function of time: fills s with positions, pose amounts (0..1) and health.
function roboState(u, s) {
  s.x1 = 92; s.x2 = 164; s.p1 = s.p2 = s.k1 = s.k2 = s.h1 = s.h2 = 0; s.hp1 = s.hp2 = 100;
  for (let i = 0; i < ROBO_ATTACKER.length; i++) {
    const tau = u - (ROBO_START + i * ROBO_EX);
    if (tau < 0) break;
    const a = ROBO_ATTACKER[i], kick = ROBO_KICK[i];
    if (tau >= 0.45) { if (a) s.hp1 -= ROBO_DAMAGE[i]; else s.hp2 -= ROBO_DAMAGE[i]; }
    if (tau >= ROBO_EX) continue;
    const step = tau < 0.35 ? scrEase(tau / 0.35) : tau < 0.8 ? 1 : 1 - scrEase((tau - 0.8) / 0.5);
    const strike = tau < 0.3 ? 0 : tau < 0.45 ? (tau - 0.3) / 0.15 : tau < 0.7 ? 1 - (tau - 0.45) / 0.25 : 0;
    const hurt = tau > 0.45 && tau < 0.95 ? 1 - (tau - 0.45) / 0.5 : 0;
    if (a === 0) { s.x1 += 22 * step; s.p1 = kick ? 0 : strike; s.k1 = kick ? strike : 0; s.h2 = hurt; s.x2 += 9 * hurt; }
    else { s.x2 -= 22 * step; s.p2 = kick ? 0 : strike; s.k2 = kick ? strike : 0; s.h1 = hurt; s.x1 -= 9 * hurt; }
  }
  s.hp1 = Math.max(0, s.hp1); s.hp2 = Math.max(0, s.hp2);
}
function roboInit(A) {
  A.bg = scrLayer((g) => {
    const sky = g.createLinearGradient(0, 0, 0, 132);
    sky.addColorStop(0, '#0b0530'); sky.addColorStop(0.6, '#4a1a7a'); sky.addColorStop(1, '#ff5a9a');
    g.fillStyle = sky; g.fillRect(0, 0, SCR_W, 132);
    scrDisc(g, '#ffd8f0', 196, 46, 16); scrDisc(g, '#ffb0d8', 191, 42, 10);                // moon
    for (let x = 0, i = 0; x < SCR_W; x += 12 + (i % 3) * 4, i++) {                         // skyline
      const h = 22 + scrHash(i + 7) * 58, w = 12 + (i % 3) * 4;
      scrRect(g, i % 2 ? '#1a0a3a' : '#240f4a', x, 132 - h, w, h);
      for (let wy = 132 - h + 4; wy < 128; wy += 6) for (let wx = x + 2; wx < x + w - 2; wx += 4) if (scrHash(wx * 7 + wy * 3) > 0.62) scrRect(g, scrHash(wx + wy) > 0.5 ? '#ffe680' : '#7ff5ff', wx, wy, 2, 3);
    }
    scrRect(g, '#ff2bd6', 30, 60, 26, 5); scrRect(g, '#00e5ff', 84, 82, 5, 20);              // neon signs
    const fl = g.createLinearGradient(0, 132, 0, SCR_H);
    fl.addColorStop(0, '#2a1650'); fl.addColorStop(1, '#0a0418');
    g.fillStyle = fl; g.fillRect(0, 132, SCR_W, SCR_H - 132);
    scrRect(g, '#ff2bd6', 0, 132, SCR_W, 2);
    g.strokeStyle = 'rgba(0,229,255,0.35)'; g.lineWidth = 1; g.beginPath();                  // floor perspective lines
    for (let i = -8; i <= 8; i++) { g.moveTo(128 + i * 8, 134); g.lineTo(128 + i * 46, SCR_H); }
    for (let r = 0; r < 6; r++) { const y = 134 + r * r * 1.9 + r * 2; g.moveTo(0, y + 0.5); g.lineTo(SCR_W, y + 0.5); }
    g.stroke();
  });
}
// Boxy robot: (x, y) = centre of the feet, dir = +1 faces right. Pose amounts are 0..1.
function roboDraw(g, x, y, dir, walk, punch, kick, fall, body, acc, flash) {
  g.save(); g.translate(Math.round(x), Math.round(y)); g.scale(dir, 1);
  if (fall) g.rotate(-fall * 1.45);
  const c = flash ? '#ffffff' : body, a = flash ? '#ffffff' : acc, dk = flash ? '#dddddd' : '#1b2436';
  const sw = Math.sin(walk) * 3;
  scrRect(g, dk, -12 + sw, -22, 9, 17); scrRect(g, c, -14 + sw, -5, 12, 5);                          // rear leg + foot
  if (kick > 0.05) {                                                                                   // front leg thrust out
    scrRect(g, dk, 2, -28 - kick * 8, 10 + kick * 18, 9); scrRect(g, c, 8 + kick * 18, -32 - kick * 8, 9, 14);
  } else { scrRect(g, dk, 2 - sw, -22, 9, 17); scrRect(g, c, 1 - sw, -5, 13, 5); }
  scrRect(g, a, -12, -28, 24, 7);                                                                      // hips
  scrRect(g, c, -12, -52, 24, 24); scrRect(g, dk, -8, -48, 16, 10); scrRect(g, a, -3, -45, 6, 4);     // torso, chest panel, light
  scrRect(g, a, -16, -52, 8, 9); scrRect(g, a, 8, -52, 8, 9);                                          // shoulders
  scrRect(g, c, -8, -66, 16, 14); scrRect(g, '#ffe600', 0, -62, 8, 5); scrRect(g, dk, -1, -72, 2, 6); scrRect(g, a, -2, -74, 4, 3);   // head, visor, antenna
  scrRect(g, c, -15, -44, 6, 16); scrRect(g, a, -16, -30, 9, 9);                                       // rear arm + fist
  const len = 7 + punch * 24;
  scrRect(g, c, 10, -46, len, 8); scrRect(g, a, 10 + len, -49, 10, 11);                                // front arm + fist
  g.restore();
}
function roboBar(g, x, w, hp, trail, right, label, u) {              // health bar; right = depletes toward the outer edge
  scrRect(g, '#000000', x - 2, 13, w + 4, 11); scrRect(g, '#40060c', x, 15, w, 7);
  const t = w * trail / 100, h = w * hp / 100;
  scrRect(g, '#ff2a2a', right ? x + w - t : x, 15, t, 7);
  scrRect(g, hp > 30 ? '#ffe600' : (((u * 6) | 0) % 2 ? '#ff2a2a' : '#ffe600'), right ? x + w - h : x, 15, h, 7);
  scrRect(g, 'rgba(255,255,255,0.4)', right ? x + w - h : x, 15, h, 2);
  scrText(g, label, right ? x + w : x, 25, '#ffffff', 1, right ? 2 : 0);
}
function roboDemo(g, u, A) {
  const s = _roboS, t2 = _roboT;
  roboState(u, s); roboState(u - 0.5, t2);
  g.drawImage(A.bg, 0, 0);
  const ko = s.hp2 <= 0, fall = ko ? scrEase((u - 12.2) / 0.5) : 0;
  const walk = u * 5;
  const f1 = s.h1 > 0.3 && ((u * 20) | 0) % 2 === 0, f2 = s.h2 > 0.3 && ((u * 20) | 0) % 2 === 0;
  scrRect(g, 'rgba(0,0,0,0.35)', s.x1 - 16, ROBO_FLOOR - 2, 34, 4); scrRect(g, 'rgba(0,0,0,0.35)', s.x2 - 16, ROBO_FLOOR - 2, 34, 4);
  roboDraw(g, s.x1, ROBO_FLOOR, 1, walk, s.p1, s.k1, 0, '#7fd0ff', '#2f6bff', f1);
  roboDraw(g, s.x2, ROBO_FLOOR, -1, walk + 2, s.p2, s.k2, fall, '#ff9a5a', '#ff2a2a', f2 && !ko);
  for (let i = 0; i < ROBO_ATTACKER.length; i++) {                    // impact sparks where a blow lands
    const tau = u - (ROBO_START + i * ROBO_EX + 0.45);
    if (tau > 0 && tau < 0.5) scrBoom(g, ROBO_ATTACKER[i] ? s.x1 + 16 : s.x2 - 16, ROBO_FLOOR - (ROBO_KICK[i] ? 30 : 42), tau, 16, '#ffffff', '#ffe600', i);
  }
  roboBar(g, 10, 96, s.hp1, t2.hp1, false, 'ATLAS', u);
  roboBar(g, 150, 96, s.hp2, t2.hp2, true, 'TITAN', u);
  scrText(g, 'KO', 128, 4, '#ff2a2a', 1, 1);
  scrNum(g, Math.max(0, 99 - Math.max(0, u - ROBO_START)), 2, 120, 14, '#ffffff', 2);
  if (u > 0.4 && u < 1.6) scrTextS(g, 'ROUND 1', 128, 70, '#ffe600', 3, 1);
  if (u >= 1.6 && u < ROBO_START) {
    const k = 1 + (1 - scrEase((u - 1.6) / 0.3)) * 1.5;
    if (((u * 8) | 0) % 2 === 0 || u < 2.1) scrTextS(g, 'FIGHT!', 128, 66, '#ff2a2a', Math.round(3 * k), 1);
  }
  if (ko && u > 12.3) {
    const sh = u < 12.9 ? ((u * 60) | 0) % 3 - 1 : 0;
    scrTextS(g, 'K.O.', 128 + sh * 2, 60, '#ff2a2a', 5, 1);
    if (u > 13.4) scrTextS(g, 'PLAYER 1 WINS', 128, 104, '#ffffff', 1, 1);
  }
}

// ───────── DRAGON KEEP: top-down dungeon crawler, torchlight, skeleton fights, chests, dragon boss ─────────
const DRAGON_PATH = [[36, 44], [120, 44], [120, 96], [214, 96], [214, 150], [120, 150], [120, 122], [36, 122]];   // the knight's patrol
const DRAGON_SPEED = 38;                                            // px/s along the patrol
const DRAGON_SLASHES = [2.8, 5.6, 9.0, 11.6];                       // when the knight cuts down each skeleton
const DRAGON_CHESTS = [[150, 84, 160], [172, 138, 320]];            // x, y, path distance at which the knight opens it
function dragonInit(A) {
  A.path = scrMakePath(DRAGON_PATH);
  A.foes = DRAGON_SLASHES.map((t) => { const p = scrPathAt(A.path, DRAGON_SPEED * t + 20); return { t, x: p.x, y: p.y }; });
  A.heart = scrSprite('heart', '#ff2a3a');
  A.bg = scrLayer((g) => {
    for (let ty = 0; ty < 12; ty++) {                                // flagstone floor
      for (let tx = 0; tx < 16; tx++) {
        const x = tx * 16, y = 12 + ty * 16, v = scrHash(tx * 31 + ty * 7);
        scrRect(g, v > 0.5 ? '#2a2238' : '#241d33', x, y, 16, 16);
        scrRect(g, '#3a3050', x, y, 16, 1); scrRect(g, '#3a3050', x, y, 1, 16); scrRect(g, '#160f22', x + 15, y, 1, 16); scrRect(g, '#160f22', x, y + 15, 16, 1);
        if (v > 0.8) scrRect(g, '#160f22', x + 4 + v * 5, y + 6, 3, 1);
      }
    }
    scrRect(g, '#3d2c4e', 0, 12, SCR_W, 16); scrRect(g, '#3d2c4e', 0, 168, SCR_W, 14);          // brick walls
    scrRect(g, '#3d2c4e', 0, 12, 14, 170); scrRect(g, '#3d2c4e', 242, 12, 14, 170);
    g.fillStyle = '#1a1226';
    for (let y = 12; y < 182; y += 5) g.fillRect(0, y, SCR_W, 1);
    for (let y = 12, r = 0; y < 182; y += 5, r++) for (let x = (r & 1) * 6; x < SCR_W; x += 12) if (y < 28 || y >= 168 || x < 14 || x >= 242) g.fillRect(x, y, 1, 5);
    scrRect(g, '#5a4468', 0, 28, SCR_W, 2); scrRect(g, '#0a0612', 0, 30, SCR_W, 2);
    for (const p of [[75, 80], [176, 124], [190, 56], [66, 152]]) {                              // stone pillars
      scrRect(g, '#0a0612', p[0] - 7, p[1] - 5, 16, 16); scrRect(g, '#6a5a80', p[0] - 6, p[1] - 8, 12, 14);
      scrRect(g, '#8a7aa0', p[0] - 6, p[1] - 8, 12, 2); scrRect(g, '#4a3a60', p[0] + 3, p[1] - 6, 3, 12);
    }
    scrRect(g, '#0a0612', 100, 12, 24, 16); scrRect(g, '#000000', 103, 14, 18, 14);            // dark doorway in the north wall
  });
  A.dark = scrLayer((g) => {                                        // dungeon gloom: dark corners around two torch pools
    g.fillStyle = 'rgba(4,2,14,0.5)'; g.fillRect(0, 0, SCR_W, SCR_H);
    g.globalCompositeOperation = 'destination-out';
    for (const t of [[128, 100, 150], [48, 40, 60], [208, 40, 60]]) {
      const rg = g.createRadialGradient(t[0], t[1], 0, t[0], t[1], t[2]);
      rg.addColorStop(0, 'rgba(0,0,0,0.85)'); rg.addColorStop(1, 'rgba(0,0,0,0)'); g.fillStyle = rg; g.fillRect(0, 0, SCR_W, SCR_H);
    }
  });
  A.glow = scrLayer((g) => {
    const rg = g.createRadialGradient(48, 48, 0, 48, 48, 48);
    rg.addColorStop(0, 'rgba(255,190,90,0.6)'); rg.addColorStop(1, 'rgba(255,120,30,0)'); g.fillStyle = rg; g.fillRect(0, 0, 96, 96);
  }, 96, 96);
}
function dragonKnight(g, x, y, dir, step) {                          // (x, y) = feet
  const s = dir, lf = Math.round(Math.sin(step) * 2);
  scrRect(g, '#1a1a30', x - 4 + lf, y - 4, 3, 4); scrRect(g, '#1a1a30', x + 1 - lf, y - 4, 3, 4);
  scrRect(g, '#2f6bff', x - 5, y - 12, 10, 9); scrRect(g, '#ffe600', x - 1, y - 12, 2, 9);
  scrRect(g, '#c8d0e8', x - 4, y - 19, 8, 7); scrRect(g, '#14101f', x + (s > 0 ? 0 : -3), y - 16, 4, 2); scrRect(g, '#ff2a3a', x - 1, y - 23, 3, 4);
  scrRect(g, '#8f95ad', x - s * 8 - (s > 0 ? 0 : 3), y - 12, 3, 8);                                    // shield
  scrRect(g, '#e8ecff', x + s * 6 - (s > 0 ? 0 : 1), y - 20, 2, 12);                                    // sword
}
function dragonSkeleton(g, x, y, t) {
  const b = Math.round(Math.sin(t * 5) * 1);
  scrRect(g, '#e8e8f0', x - 4, y - 16 + b, 8, 7); scrRect(g, '#14101f', x - 3, y - 14 + b, 2, 2); scrRect(g, '#14101f', x + 1, y - 14 + b, 2, 2);
  scrRect(g, '#e8e8f0', x - 3, y - 9, 6, 2); scrRect(g, '#e8e8f0', x - 4, y - 7, 8, 2); scrRect(g, '#e8e8f0', x - 3, y - 5, 6, 2);
  scrRect(g, '#e8e8f0', x - 7, y - 9, 2, 6); scrRect(g, '#e8e8f0', x + 5, y - 9, 2, 6); scrRect(g, '#e8e8f0', x - 3, y - 3, 2, 3); scrRect(g, '#e8e8f0', x + 1, y - 3, 2, 3);
}
function dragonBeast(g, x, y, k, open, col, col2) {                   // dragon facing left; (x, y) = neck base; k = pixel unit
  g.fillStyle = '#0f6a3a'; g.beginPath();                                                                // wing
  g.moveTo(x + 6 * k, y + 6 * k); g.lineTo(x + 14 * k, y - 12 * k); g.lineTo(x + 20 * k, y + 2 * k); g.lineTo(x + 27 * k, y - 8 * k); g.lineTo(x + 30 * k, y + 8 * k); g.closePath(); g.fill();
  g.fillStyle = col; g.beginPath(); g.moveTo(x + 24 * k, y + 12 * k); g.lineTo(x + 40 * k, y + 22 * k); g.lineTo(x + 24 * k, y + 20 * k); g.closePath(); g.fill();   // tail
  scrRectU(g, k, x, y, col, 2, 6, 22, 14); scrRectU(g, k, x, y, col2, 2, 16, 22, 3); scrRectU(g, k, x, y, col, -2, -4, 9, 16);
  scrRectU(g, k, x, y, col, -14, -8, 15, 11); scrRectU(g, k, x, y, col, -21, -4, 9, 6);
  scrRectU(g, k, x, y, '#177a44', -19, 3 + open * 3, 14, 3); scrRectU(g, k, x, y, '#ffffff', -20, 2, 1.5, 2);
  scrRectU(g, k, x, y, '#ffffff', -15, 2, 1.5, 2); scrRectU(g, k, x, y, '#ffe600', -9, -6, 3.5, 2.5);
  scrRectU(g, k, x, y, '#000000', -8, -5.5, 1.5, 2);
  scrRectU(g, k, x, y, '#e8e0c0', -4, -13, 2, 6); scrRectU(g, k, x, y, '#e8e0c0', -9, -12, 2, 5); scrRectU(g, k, x, y, '#177a44', 6, 20, 5, 7); scrRectU(g, k, x, y, '#177a44', 18, 20, 5, 7);
  for (let i = 0; i < 4; i++) scrRectU(g, k, x, y, '#ffb000', 4 + i * 5, 4, 2, 3);
}
const DRAGON_FLAME = ['#ff5a1f', '#ffb000', '#fff3a0'];
function dragonFlame(g, x0, y0, x1, y1, u) {                          // flickering fire jet from (x0, y0) toward (x1, y1)
  const a = Math.atan2(y1 - y0, x1 - x0), len = Math.hypot(x1 - x0, y1 - y0) * (0.75 + 0.25 * Math.sin(u * 40));
  for (let i = 0; i < 3; i++) {
    const l = len * (1 - i * 0.22), w = 12 - i * 4;
    g.fillStyle = DRAGON_FLAME[i]; g.beginPath(); g.moveTo(x0, y0);
    g.lineTo(x0 + Math.cos(a) * l - Math.sin(a) * w, y0 + Math.sin(a) * l + Math.cos(a) * w);
    g.lineTo(x0 + Math.cos(a) * l * 1.05, y0 + Math.sin(a) * l * 1.05);
    g.lineTo(x0 + Math.cos(a) * l + Math.sin(a) * w, y0 + Math.sin(a) * l - Math.cos(a) * w); g.closePath(); g.fill();
  }
}
function dragonDemo(g, u, A) {
  g.drawImage(A.bg, 0, 0);
  for (let i = 0; i < DRAGON_CHESTS.length; i++) {                   // treasure chests: closed until the knight passes
    const c = DRAGON_CHESTS[i], t = c[2] / DRAGON_SPEED, open = u > t;
    scrRect(g, '#6a3a1a', c[0] - 7, c[1] - 6, 14, 9); scrRect(g, '#ffe600', c[0] - 1, c[1] - 6, 2, 9);
    if (open) { scrRect(g, '#ffd23f', c[0] - 5, c[1] - 9, 10, 3);
    if (u - t < 1.2) { scrText(g, '+50', c[0], c[1] - 20 - (u - t) * 10, '#ffe600', 1, 1);
    scrSparkle(g, c[0] + Math.sin(u * 30) * 6, c[1] - 12, 2, '#ffffff'); } }
    else scrRect(g, '#8a5a2a', c[0] - 7, c[1] - 10, 14, 4);
  }
  for (let i = 0; i < A.foes.length; i++) {                          // skeletons wait until slashed
    const f = A.foes[i];
    if (u < f.t) dragonSkeleton(g, f.x, f.y, u + i); else scrBoom(g, f.x, f.y - 8, u - f.t, 16, '#e8e8f0', '#8f95ad', i);
  }
  const d = DRAGON_SPEED * u;
  scrPathAt(A.path, d);
  const hx = _scrP.x, hy = _scrP.y, dir = _scrP.dx >= 0 ? 1 : -1, hdx = _scrP.dx, hdy = _scrP.dy;
  g.globalCompositeOperation = 'lighter'; g.globalAlpha = 0.35; g.drawImage(A.glow, hx - 48, hy - 60); g.globalAlpha = 1; g.globalCompositeOperation = 'source-over';
  dragonKnight(g, hx, hy + 4, dir, u * 10);
  for (let i = 0; i < DRAGON_SLASHES.length; i++) {                  // sword slash arc
    const tau = u - (DRAGON_SLASHES[i] - 0.1);
    if (tau > 0 && tau < 0.25) {
      const a = Math.atan2(hdy, hdx);
      g.strokeStyle = '#ffffff'; g.lineWidth = 2; g.beginPath(); g.arc(hx + hdx * 8, hy + hdy * 8 - 6, 13, a - 1.1 + tau * 6, a + 0.2 + tau * 6); g.stroke();
    }
  }
  if (u > 12.4) {                                                    // the dragon wakes and breathes fire
    const rise = scrEase((u - 12.4) / 0.8);
    dragonBeast(g, 196, 64 - (1 - rise) * 40, 1.6, u > 13.6 ? 1 : 0, '#1e9a55', '#c8e050');
    if (u > 13.6 && ((u * 6) | 0) % 3 !== 2) dragonFlame(g, 172, 62, hx, hy - 8, u);
    if (u < 13.6 && ((u * 6) | 0) % 2 === 0) scrTextS(g, 'DRAGON!', 128, 92, '#ff2a3a', 2, 1);
  }
  g.drawImage(A.dark, 0, 0);
  for (let ti = 0; ti < 2; ti++) {                                    // torches burn above the darkness
    const tx = ti ? 208 : 48;
    const fl = Math.sin(u * 23 + tx) * 1.2;
    scrRect(g, '#5a3a1a', tx - 1, 24, 3, 6); scrRect(g, '#ff5a1f', tx - 2, 17 + fl, 5, 8); scrRect(g, '#ffe066', tx - 1, 19 + fl, 3, 5);
    g.globalCompositeOperation = 'lighter'; g.globalAlpha = 0.3 + Math.sin(u * 17 + tx) * 0.08; g.drawImage(A.glow, tx - 48, 22 - 48 + 26);
    g.globalAlpha = 1; g.globalCompositeOperation = 'source-over';
  }
  let slain = 0; for (let i = 0; i < A.foes.length; i++) if (u > A.foes[i].t) slain++;
  for (let i = 0; i < 3; i++) scrBlit(g, A.heart, 6 + i * 9, 3, 1);
  scrText(g, 'GOLD', 80, 2, '#ffe600'); scrNum(g, 150 + slain * 100 + (u > 4.2 ? 50 : 0) + (u > 8.4 ? 50 : 0), 5, 116, 2, '#ffffff');
  scrText(g, 'LV 1-3', 250, 2, '#39ff88', 1, 2);
}

// ───────── STAR INVADERS: marching grid, cannon, shields, bombs, mystery ship ─────────
const INV_COLS = 11, INV_ROWS = 5, INV_STEP = 0.32, INV_STEPS_PER_LEG = 17, INV_SHOTS = 14;
const INV_COLORS = ['#ff5aff', '#00e5ff', '#00e5ff', '#39ff88', '#39ff88'], INV_POINTS = [30, 20, 20, 10, 10];
function invGrid(t, out) {                                          // top-left of the invader grid at time t
  const s = Math.floor(t / INV_STEP), leg = Math.floor(s / INV_STEPS_PER_LEG), k = s % INV_STEPS_PER_LEG;
  out.x = 8 + (leg & 1 ? INV_STEPS_PER_LEG - 1 - k : k) * 4;
  out.y = 40 + leg * 8;
  out.frame = s & 1;
}
function invAt(t, r, c, out) {                                       // centre of invader (r, c) at time t
  invGrid(t, out);
  out.x += c * 16 + 6; out.y += r * 14 + 4;
}
function invInit(A) {
  A.spr = [];
  const sets = [['squidA', 'squidB'], ['crabA', 'crabB'], ['crabA', 'crabB'], ['octoA', 'octoB'], ['octoA', 'octoB']];
  for (let r = 0; r < INV_ROWS; r++) A.spr.push([scrSprite(sets[r][0], INV_COLORS[r]), scrSprite(sets[r][1], INV_COLORS[r])]);
  A.cannon = scrSprite('cannon', '#39ff88'); A.ufo = scrSprite('ufo', '#ff2a3a'); A.bunker = scrSprite('bunker', '#39ff88');
  A.killAt = new Float32Array(INV_ROWS * INV_COLS).fill(1e9);        // when each invader is shot down
  A.shots = [];                                                      // {t, x, y}: the cannon's targets in time order
  const hitsInCol = new Uint8Array(INV_COLS);
  for (let k = 0; k < INV_SHOTS; k++) {
    const t = 1.2 + k * 0.95, c = (k * 5 + 3) % INV_COLS, r = INV_ROWS - 1 - hitsInCol[c]++;
    if (r < 0) continue;
    A.killAt[r * INV_COLS + c] = t;
    invAt(t, r, c, _scrP);
    A.shots.push({ t, x: _scrP.x, y: _scrP.y, r });
  }
  A.ufoT = 7.2;
  A.shots.push({ t: A.ufoT, x: 296 - ((A.ufoT - 4) / 4.5) * 320, y: 25, r: -1 });
  A.shots.sort((a, b) => a.t - b.t);
  A.bg = scrLayer((g) => { scrRect(g, '#000000', 0, 0, SCR_W, SCR_H); scrRect(g, '#39ff88', 0, 172, SCR_W, 1); });
}
function invDemo(g, u, A) {
  g.drawImage(A.bg, 0, 0);
  scrText(g, 'SCORE<1>', 6, 2, '#ffffff'); scrText(g, 'HI-SCORE', 128, 2, '#ffffff', 1, 1); scrText(g, 'SCORE<2>', 250, 2, '#ffffff', 1, 2);
  let score = 0;
  invGrid(u, _scrP);
  const gx = _scrP.x, gy = _scrP.y, fr = _scrP.frame;
  for (let r = 0; r < INV_ROWS; r++) {
    for (let c = 0; c < INV_COLS; c++) {
      const kt = A.killAt[r * INV_COLS + c];
      if (u >= kt) { score += INV_POINTS[r]; continue; }
      const sp = A.spr[r][fr];
      scrBlit(g, sp, gx + c * 16 + (12 - sp.w) / 2, gy + r * 14, 1);
    }
  }
  for (let i = 0; i < 4; i++) {                                      // shields, slowly chewed away
    const bx = 26 + i * 56;
    scrBlit(g, A.bunker, bx, 134, 1);
    for (let h = 0; h < 6 + Math.floor(u * 1.4); h++) scrRect(g, '#000000', bx + scrHash(i * 40 + h) * 19, 134 + 4 + scrHash(i * 40 + h + 9) * 9, 3, 3);
  }
  for (let j = 0; j < 3; j++) {                                      // alien bombs zig-zagging down
    const tb = (u - 0.8 - j * 1.9 + 30) % 4.2, col = (j * 4 + 2) % INV_COLS;
    if (tb > 1.4) continue;
    invAt(u - tb, INV_ROWS - 1, col, _scrP);
    const y = _scrP.y + tb * 60;
    if (y < 138) { const z = ((tb * 10) | 0) & 1; scrRect(g, '#ffffff', _scrP.x + z, y, 2, 3); scrRect(g, '#ffffff', _scrP.x + 1 - z, y + 3, 2, 3); }
    else scrBoom(g, _scrP.x, 138, (tb - 1.3) * 3, 8, '#39ff88', '#ffffff', j);
  }
  const ux = 288 - ((u - 4) / 4.5) * 320;
  if (u > 4 && u < A.ufoT) scrBlit(g, A.ufo, ux, 22, 1);
  const shots = A.shots, cx = scrGlide(u, shots, 0.35, 128);
  for (let k = 0; k < shots.length; k++) {                           // cannon shots and explosions
    const s = shots[k], p = (u - (s.t - 0.32)) / 0.32;
    if (p >= 0 && p <= 1) scrRect(g, '#ffffff', s.x - 0.5, 164 + (s.y - 164) * p, 1, 6);
    if (u >= s.t) {
      if (s.r < 0) { scrBoom(g, s.x, s.y, u - s.t, 12, '#ff2a3a', '#ffffff', 40); if (u - s.t < 1) scrText(g, '300', s.x, s.y - 4, '#ff2a3a', 1, 1); score += 300; }
      else scrBoom(g, s.x, s.y, u - s.t, 10, '#ffffff', '#00e5ff', k);
    }
  }
  scrBlit(g, A.cannon, cx - 6, 164, 1);
  scrNum(g, score, 4, 14, 12, '#ffffff'); scrNum(g, 50000, 5, 100, 12, '#ffffff'); scrText(g, '0000', 250, 12, '#ffffff', 1, 2);
  scrText(g, '3', 6, 175, '#ffffff'); scrBlit(g, A.cannon, 20, 176, 1); scrBlit(g, A.cannon, 40, 176, 1);
}

// ───────── TURBO KART: top-down race around a stadium track with skids, drift dust and rank tracking ─────────
const KART_CX = 128, KART_CY = 98, KART_A = 36, KART_R = 52, KART_W = 20;          // track: half straight, radius, half width
const KART_LEN = 4 * KART_A + 2 * Math.PI * KART_R;
const KART_RANKS = ['1ST', '2ND', '3RD', '4TH'];
const KART_COLORS = ['#ff2a3a', '#2f6bff', '#ffe600', '#39ff88'];
const KART_S0 = [30, 44, 16, 0], KART_V = [58, 54, 53, 51];                         // start offsets and speeds (px/s)
// Position and heading (out.x, out.y, out.dx, out.dy) at distance s along the centreline, `lat` toward the inside.
function kartPoint(s, lat, out) {
  const A = KART_A, R = KART_R, arc = Math.PI * R;
  s = ((s % KART_LEN) + KART_LEN) % KART_LEN;
  let x, y, hx, hy;
  if (s < 2 * A) { x = KART_CX - A + s; y = KART_CY + R; hx = 1; hy = 0; }
  else if (s < 2 * A + arc) { const f = Math.PI / 2 - (s - 2 * A) / R; x = KART_CX + A + R * Math.cos(f); y = KART_CY + R * Math.sin(f); hx = Math.sin(f); hy = -Math.cos(f); }
  else if (s < 4 * A + arc) { x = KART_CX + A - (s - 2 * A - arc); y = KART_CY - R; hx = -1; hy = 0; }
  else { const f = -Math.PI / 2 - (s - 4 * A - arc) / R; x = KART_CX - A + R * Math.cos(f); y = KART_CY + R * Math.sin(f); hx = Math.sin(f); hy = -Math.cos(f); }
  out.x = x + lat * hy; out.y = y - lat * hx; out.dx = hx; out.dy = hy;
  return out;
}
function kartStadium(g, r) {                                        // stadium outline path with corner radius r
  const A = KART_A;
  g.beginPath(); g.moveTo(KART_CX - A, KART_CY - r); g.lineTo(KART_CX + A, KART_CY - r); g.arc(KART_CX + A, KART_CY, r, -Math.PI / 2, Math.PI / 2);
  g.lineTo(KART_CX - A, KART_CY + r); g.arc(KART_CX - A, KART_CY, r, Math.PI / 2, (3 * Math.PI) / 2); g.closePath();
}
function kartInit(A) {
  A.bg = scrLayer((g) => {
    for (let x = 0; x < SCR_W; x += 16) scrRect(g, (x >> 4) & 1 ? '#2f8a3f' : '#2a7d3a', x, 0, 16, SCR_H);        // mown grass
    kartStadium(g, KART_R + KART_W + 6); g.strokeStyle = '#111111'; g.lineWidth = 5; g.lineCap = 'round'; g.setLineDash([1, 7]); g.stroke();   // tyre wall
    g.setLineDash([]); g.lineCap = 'butt';
    kartStadium(g, KART_R); g.strokeStyle = '#3c3c4c'; g.lineWidth = KART_W * 2; g.stroke();                       // asphalt
    for (const off of [KART_R + KART_W, KART_R - KART_W]) {                                                        // red/white kerbs
      kartStadium(g, off); g.lineWidth = 4; g.strokeStyle = '#ffffff'; g.setLineDash([8, 8]); g.stroke();
      g.strokeStyle = '#ff2a3a'; g.lineDashOffset = 8; g.stroke(); g.lineDashOffset = 0;
    }
    g.setLineDash([]);
    kartStadium(g, KART_R - KART_W - 2); g.fillStyle = '#25672f'; g.fill();                                        // infield
    g.strokeStyle = 'rgba(255,255,255,0.08)'; g.lineWidth = 2; kartStadium(g, KART_R); g.setLineDash([4, 10]); g.stroke(); g.setLineDash([]);
    for (let i = 0; i < 40; i++) {                                                                                  // skid marks
      const p = kartPoint(scrHash(i) * KART_LEN, (scrHash(i + 50) - 0.5) * 24, _scrP);
      g.fillStyle = 'rgba(0,0,0,0.25)'; g.fillRect(Math.round(p.x), Math.round(p.y), 4, 1);
    }
    for (let y = 0; y < 8; y++) for (let x = 0; x < 2; x++) scrRect(g, (x + y) & 1 ? '#ffffff' : '#111111', KART_CX - 2 + x * 3, KART_CY + KART_R - KART_W + y * 5, 3, 5);   // start line
    for (const t of [[100, 74], [156, 122], [96, 120]]) { scrDisc(g, '#1a1a1a', t[0], t[1], 4); scrDisc(g, '#ff2a3a', t[0], t[1], 2); }
  });
}
function kartDraw(g, x, y, ang, col, u) {
  g.save(); g.translate(Math.round(x), Math.round(y)); g.rotate(ang); g.scale(1.3, 1.3);
  scrRect(g, '#111111', -6, -6, 4, 3); scrRect(g, '#111111', -6, 3, 4, 3); scrRect(g, '#111111', 3, -6, 4, 3); scrRect(g, '#111111', 3, 3, 4, 3);
  scrRect(g, col, -6, -3, 11, 6); scrRect(g, '#ffffff', 5, -2, 3, 4); scrRect(g, '#ffdd88', -2, -2, 4, 4); scrRect(g, '#14101f', 0, -2, 2, 4);
  if (((u * 20) | 0) & 1) scrRect(g, '#ffb000', -9, -1, 3, 2);
  g.restore();
}
function kartDemo(g, u, A) {
  g.drawImage(A.bg, 0, 0);
  scrText(g, 'TURBO', 128, 86, '#ffe600', 1, 1); scrText(g, 'KART', 128, 98, '#ffffff', 1, 1);
  const t0 = Math.max(0, u - 2);                                     // 3-2-1 grid start
  for (let k = 3; k >= 0; k--) {                                     // drawing order: back markers first so the player is on top
    const s = KART_S0[k] + KART_V[k] * t0, lat = Math.sin(u * 1.3 + k * 2) * 9 + (k - 1.5) * 4;
    for (let i = 5; i >= 1; i--) {                                   // dust trail
      kartPoint(s - i * 4, lat, _scrP);
      if (t0 > 0) { g.globalAlpha = 0.5 - i * 0.08; scrRect(g, '#cfc8b0', _scrP.x - 1, _scrP.y - 1, 3, 3); }
    }
    g.globalAlpha = 1;
    kartPoint(s, lat, _scrP);
    kartDraw(g, _scrP.x, _scrP.y, Math.atan2(_scrP.dy, _scrP.dx), KART_COLORS[k], u + k);
  }
  const me = KART_S0[0] + KART_V[0] * t0;
  let rank = 1;
  for (let k = 1; k < 4; k++) if (KART_S0[k] + KART_V[k] * t0 > me) rank++;
  const lap = Math.min(3, 1 + Math.floor(me / KART_LEN));
  scrRect(g, 'rgba(0,0,0,0.55)', 0, 0, SCR_W, 12);
  scrText(g, 'LAP', 6, 2, '#ff5a5a'); scrText(g, lap + '/3', 34, 2, '#ffffff');
  scrTextS(g, KART_RANKS[rank - 1], 128, 2, rank === 1 ? '#ffe600' : '#ffffff', 1, 1);
  scrText(g, 'TIME', 172, 2, '#ff5a5a'); scrNum(g, t0, 2, 204, 2, '#ffffff'); scrText(g, ':', 220, 2, '#ffffff'); scrNum(g, (t0 % 1) * 100, 2, 228, 2, '#ffffff');
  if (u < 2) scrTextS(g, u < 0.7 ? '3' : u < 1.4 ? '2' : '1', 128, 150, '#ff2a3a', 3, 1);
  else if (u < 3) scrTextS(g, 'GO!', 128, 150, '#39ff88', 3, 1);
  if (u > 7 && u < 9 && ((u * 6) | 0) % 2 === 0) scrTextS(g, 'TURBO!', 128, 154, '#ffb000', 2, 1);
}

// ───────── BLOCK DROP: an AI plays falling blocks; line clears flash; all boards are pre-simulated ─────────
const BLK_W = 10, BLK_H = 18, BLK_SLOT = 0.55, BLK_X0 = 88, BLK_Y0 = 20, BLK_CELL = 8;
const BLK_SHAPES = [                                                 // I O T S Z J L as cells within a 4x4 box
  [[0, 1], [1, 1], [2, 1], [3, 1]], [[1, 0], [2, 0], [1, 1], [2, 1]], [[1, 0], [0, 1], [1, 1], [2, 1]], [[1, 0], [2, 0], [0, 1], [1, 1]],
  [[0, 0], [1, 0], [1, 1], [2, 1]], [[0, 0], [0, 1], [1, 1], [2, 1]], [[2, 0], [0, 1], [1, 1], [2, 1]],
];
const BLK_COLORS = [['#00d8f0', '#8ff4ff', '#007a90'], ['#f0d800', '#fff48a', '#8a7a00'], ['#b040f0', '#e0a0ff', '#5a1a8a'], ['#30e060', '#90ffb0', '#147a30'],
                    ['#f03030', '#ff9a9a', '#8a1414'], ['#3060f0', '#9ab4ff', '#14338a'], ['#f08a20', '#ffc880', '#8a4a08']];
function blkRotations(cells) {                                       // four 90-degree turns, each moved to the box corner
  const out = [];
  let c = cells;
  for (let r = 0; r < 4; r++) {
    const mx = Math.min(...c.map((p) => p[0])), my = Math.min(...c.map((p) => p[1]));
    out.push(c.map((p) => [p[0] - mx, p[1] - my]));
    c = c.map((p) => [3 - p[1], p[0]]);
  }
  return out;
}
function blkFits(b, cells, x, y) {
  for (let i = 0; i < 4; i++) {
    const bx = x + cells[i][0], by = y + cells[i][1];
    if (bx < 0 || bx >= BLK_W || by >= BLK_H || (by >= 0 && b[by * BLK_W + bx])) return false;
  }
  return true;
}
// Plays the game once with a simple stacking AI. Returns steps {type, rot, x, y, pre, post, cleared[], lines}.
function blkSimulate() {
  const rand = rng(4242), rots = BLK_SHAPES.map(blkRotations), steps = [];
  let board = new Uint8Array(BLK_W * BLK_H), lines = 0;
  for (let k = 0; k < 40; k++) {
    const type = Math.floor(rand() * 7);
    let best = null;
    for (let rot = 0; rot < 4; rot++) {
      const cells = rots[type][rot], w = 1 + Math.max(...cells.map((p) => p[0]));
      for (let x = 0; x + w <= BLK_W; x++) {
        if (!blkFits(board, cells, x, 0)) continue;
        let y = 0;
        while (blkFits(board, cells, x, y + 1)) y++;
        const pre = board.slice();
        for (let i = 0; i < 4; i++) pre[(y + cells[i][1]) * BLK_W + x + cells[i][0]] = type + 1;
        const cleared = [], post = new Uint8Array(BLK_W * BLK_H);
        let wr = BLK_H - 1;
        for (let r = BLK_H - 1; r >= 0; r--) {
          let full = true;
          for (let c = 0; c < BLK_W; c++) if (!pre[r * BLK_W + c]) full = false;
          if (full) cleared.push(r); else { post.set(pre.subarray(r * BLK_W, r * BLK_W + BLK_W), wr * BLK_W); wr--; }
        }
        let agg = 0, holes = 0, bump = 0, prev = 0;                  // heuristic: low, flat, hole-free stacks with cleared lines
        for (let c = 0; c < BLK_W; c++) {
          let h = 0;
          for (let r = 0; r < BLK_H; r++) if (post[r * BLK_W + c]) { h = BLK_H - r; break; }
          for (let r = BLK_H - h; r < BLK_H; r++) if (!post[r * BLK_W + c]) holes++;
          agg += h; if (c) bump += Math.abs(h - prev); prev = h;
        }
        const score = -0.51 * agg + 0.76 * cleared.length * 4 - 0.36 * holes * 3 - 0.18 * bump;
        if (!best || score > best.score) best = { score, type, rot, x, y, pre, post, cleared };
      }
    }
    if (!best) break;
    lines += best.cleared.length; best.lines = lines;
    steps.push(best); board = best.post;
  }
  return steps;
}
function blkCell(g, x, y, type) {
  const c = BLK_COLORS[type];
  scrRect(g, c[0], x, y, BLK_CELL, BLK_CELL); scrRect(g, c[1], x, y, BLK_CELL, 1); scrRect(g, c[1], x, y, 1, BLK_CELL);
  scrRect(g, c[2], x, y + BLK_CELL - 1, BLK_CELL, 1); scrRect(g, c[2], x + BLK_CELL - 1, y, 1, BLK_CELL);
}
function blkInit(A) {
  A.steps = blkSimulate();
  A.rots = BLK_SHAPES.map(blkRotations);
  A.bg = scrLayer((g) => {
    const gr = g.createLinearGradient(0, 0, 0, SCR_H); gr.addColorStop(0, '#1a0a3a'); gr.addColorStop(1, '#06020f'); g.fillStyle = gr; g.fillRect(0, 0, SCR_W, SCR_H);
    for (let x = 0; x < SCR_W; x += 24) scrRect(g, 'rgba(155,92,255,0.12)', x, 0, 12, SCR_H);
    scrRect(g, '#05030a', BLK_X0 - 4, BLK_Y0 - 4, BLK_W * BLK_CELL + 8, BLK_H * BLK_CELL + 8);
    scrRect(g, '#9b5cff', BLK_X0 - 4, BLK_Y0 - 4, BLK_W * BLK_CELL + 8, 2); scrRect(g, '#9b5cff', BLK_X0 - 4, BLK_Y0 + BLK_H * BLK_CELL + 2, BLK_W * BLK_CELL + 8, 2);
    scrRect(g, '#9b5cff', BLK_X0 - 4, BLK_Y0 - 4, 2, BLK_H * BLK_CELL + 8); scrRect(g, '#9b5cff', BLK_X0 + BLK_W * BLK_CELL + 2, BLK_Y0 - 4, 2, BLK_H * BLK_CELL + 8);
    g.fillStyle = 'rgba(255,255,255,0.05)';
    for (let x = 1; x < BLK_W; x++) g.fillRect(BLK_X0 + x * BLK_CELL, BLK_Y0, 1, BLK_H * BLK_CELL);
    for (let y = 1; y < BLK_H; y++) g.fillRect(BLK_X0, BLK_Y0 + y * BLK_CELL, BLK_W * BLK_CELL, 1);
    scrRect(g, '#05030a', 176, 26, 72, 52); scrRect(g, '#00e5ff', 176, 26, 72, 1); scrRect(g, '#00e5ff', 176, 77, 72, 1);
  });
}
function blkDraw(g, board, rows, u) {
  for (let r = 0; r < BLK_H; r++) {
    const flash = rows && rows.indexOf(r) >= 0;
    for (let c = 0; c < BLK_W; c++) {
      const v = board[r * BLK_W + c];
      if (!v) continue;
      if (flash) scrRect(g, ((u * 20) | 0) & 1 ? '#ffffff' : '#666666', BLK_X0 + c * BLK_CELL, BLK_Y0 + r * BLK_CELL, BLK_CELL, BLK_CELL);
      else blkCell(g, BLK_X0 + c * BLK_CELL, BLK_Y0 + r * BLK_CELL, v - 1);
    }
  }
}
const _blkEmpty = new Uint8Array(BLK_W * BLK_H);
function blkDemo(g, u, A) {
  g.drawImage(A.bg, 0, 0);
  scrText(g, 'NEXT', 212, 30, '#ffe600', 1, 1); scrText(g, 'SCORE', 6, 24, '#00e5ff'); scrText(g, 'LINES', 6, 60, '#00e5ff'); scrText(g, 'LEVEL', 6, 96, '#00e5ff');
  scrText(g, 'BLOCK', 212, 120, '#9b5cff', 1, 1); scrText(g, 'DROP', 212, 130, '#9b5cff', 1, 1);
  const S = A.steps, k = Math.min(S.length - 1, Math.floor(u / BLK_SLOT)), p = k === Math.floor(u / BLK_SLOT) ? (u / BLK_SLOT) % 1 : 1, st = S[k];
  if (p < 0.85) {
    blkDraw(g, k ? S[k - 1].post : _blkEmpty, null, u);
    const cells = A.rots[st.type][p < 0.12 ? 0 : st.rot];
    const x = Math.round(scrLerp(3, st.x, scrEase((p - 0.1) / 0.4))), y = Math.max(0, Math.min(st.y, Math.floor((p / 0.85) * (st.y + 2)) - 1));
    for (let i = 0; i < 4; i++) blkCell(g, BLK_X0 + (x + cells[i][0]) * BLK_CELL, BLK_Y0 + (y + cells[i][1]) * BLK_CELL, st.type);
  } else blkDraw(g, st.pre, st.cleared, u);
  const lines = k ? S[k - 1].lines : 0, next = S[Math.min(S.length - 1, k + 1)], nc = A.rots[next.type][0];
  for (let i = 0; i < 4; i++) blkCell(g, 200 + nc[i][0] * BLK_CELL - 4, 46 + nc[i][1] * BLK_CELL, next.type);
  scrNum(g, lines * 400 + k * 25, 6, 6, 34, '#ffffff'); scrNum(g, lines, 3, 6, 70, '#ffffff'); scrNum(g, 1 + Math.floor(lines / 4), 2, 6, 106, '#ffffff');
}

// ───────── GALAXY WARS: side-scrolling shoot-em-up with parallax planet, waves and a boss ─────────
const GALAXY_WAVES = 5, GALAXY_PER_WAVE = 5;
const galaxySpawnT = (w, i) => w * 2.1 + i * 0.28;
const galaxyKillAge = (w, i) => (270 - (150 + scrHash(w * 11 + i) * 34)) / 72;
function galaxyEnemy(w, i, age, out) {                              // enemy i of wave w, `age` seconds after entering from the right
  out.x = 270 - age * 72;
  out.y = 46 + ((w * 37) % 90) + Math.sin(age * 3 + i * 0.7) * 26;
}
function galaxyInit(A) {
  A.bg = scrLayer((g) => {
    const gr = g.createLinearGradient(0, 0, 0, SCR_H); gr.addColorStop(0, '#0a0524'); gr.addColorStop(1, '#3a0a48'); g.fillStyle = gr; g.fillRect(0, 0, SCR_W, SCR_H);
    for (let i = 0; i < 40; i++) scrRect(g, '#ffffff', scrHash(i) * SCR_W, scrHash(i + 90) * SCR_H, 1, 1);
  });
  A.planet = scrLayer((g) => {
    const pl = g.createRadialGradient(56, 50, 8, 66, 66, 62);
    pl.addColorStop(0, '#ffb060'); pl.addColorStop(0.6, '#c8307a'); pl.addColorStop(1, '#3a0a50');
    g.fillStyle = pl; g.beginPath(); g.arc(66, 66, 60, 0, 6.2832); g.fill();
    g.strokeStyle = 'rgba(255,220,160,0.7)'; g.lineWidth = 3; g.beginPath(); g.ellipse(66, 66, 100, 16, -0.4, 0, 6.2832); g.stroke();
  }, 132, 132);
  A.terrain = scrLayer((g) => {                                     // seamless alien mountain range (periodic in x)
    for (let layer = 0; layer < 2; layer++) {
      g.fillStyle = layer ? '#2a0a3a' : '#4a1458'; g.beginPath(); g.moveTo(0, SCR_H);
      for (let x = 0; x <= SCR_W; x += 4) {
        const a = (x / SCR_W) * 6.2832 * (layer ? 3 : 2);
        g.lineTo(x, 172 - layer * 10 - 14 - Math.sin(a) * 12 - Math.sin(a * 2 + 1) * 6 - (layer ? 0 : Math.sin(a * 3) * 4));
      }
      g.lineTo(SCR_W, SCR_H); g.fill();
    }
    for (let i = 0; i < 7; i++) { scrRect(g, '#ff2bd6', i * 37 + 10, 160 - (i % 3) * 4, 2, 10 + (i % 3) * 4); scrRect(g, '#ffffff', i * 37 + 10, 160 - (i % 3) * 4, 2, 2); }
  });
  A.ship = scrSprite('galaxy'); A.eA = scrSprite('enemyA'); A.eB = scrSprite('enemyB');
  A.kills = []; A.aim = [];
  for (let w = 0; w < GALAXY_WAVES; w++) {
    for (let i = 0; i < GALAXY_PER_WAVE; i++) {
      const age = galaxyKillAge(w, i);
      galaxyEnemy(w, i, age, _scrP);
      A.kills.push({ t: galaxySpawnT(w, i) + age, x: _scrP.x, y: _scrP.y });
    }
  }
  A.kills.sort((a, b) => a.t - b.t);
  A.aim = A.kills.map((k) => ({ t: k.t, x: k.y }));                 // the ship glides vertically, so aim events carry y in x
}
function galaxyBoss(g, x, y, u, hurt) {
  const c = hurt ? '#ffffff' : '#6a2a8a';
  scrRect(g, c, x - 30, y - 38, 60, 76); scrRect(g, '#3a1a5a', x - 30, y - 38, 6, 76); scrRect(g, '#ff2bd6', x - 20, y - 30, 8, 60);
  for (let s = -1; s <= 1; s += 2) { scrRect(g, '#3a1a5a', x - 48, y + s * 26 - 6, 22, 12); scrRect(g, '#ffb000', x - 52, y + s * 26 - 3, 5, 6); }
  for (let i = 0; i < 5; i++) { g.fillStyle = '#c8307a'; g.beginPath(); g.moveTo(x + 30, y - 34 + i * 16); g.lineTo(x + 46, y - 26 + i * 16); g.lineTo(x + 30, y - 18 + i * 16); g.fill(); }
  scrDisc(g, '#14101f', x - 6, y, 13); scrDisc(g, ((u * 6) | 0) & 1 ? '#ffe600' : '#ff8a1f', x - 6, y, 8); scrDisc(g, '#ffffff', x - 8, y - 2, 2);
}
function galaxyDemo(g, u, A) {
  const K = A.kills;
  g.drawImage(A.bg, 0, 0);
  scrStars(g, u, 20, -14, 0, 1, '#8a8ac0', 5); scrStars(g, u, 12, -40, 0, 1, '#ffffff', 6);
  g.drawImage(A.planet, Math.round(150 - u * 2), 20);
  scrStars(g, u, 8, -110, 0, 2, '#ffc8f0', 7);
  const sc = -((u * 46) % SCR_W);
  g.drawImage(A.terrain, Math.round(sc), 0); g.drawImage(A.terrain, Math.round(sc) + SCR_W, 0);
  const shipY = scrGlide(u, A.aim, 0.4, 100) + Math.sin(u * 2) * 3, boss = u > 10;
  for (let i = Math.floor(u / 0.13); i > Math.floor(u / 0.13) - 6; i--) {                       // steady stream of shots
    const tb = i * 0.13, x = 60 + (u - tb) * 320;
    if (x < 256) { const y = scrGlide(tb, A.aim, 0.4, 100) + Math.sin(tb * 2) * 3; scrRect(g, '#ff2bd6', x, y - 1, 8, 3); scrRect(g, '#ffffff', x + 2, y, 6, 1); }
  }
  for (let w = 0; w < GALAXY_WAVES; w++) {
    for (let i = 0; i < GALAXY_PER_WAVE; i++) {
      const age = u - galaxySpawnT(w, i);
      if (age < 0 || age > galaxyKillAge(w, i)) continue;
      galaxyEnemy(w, i, age, _scrP);
      scrBlitRot(g, (w + i) & 1 ? A.eA : A.eB, _scrP.x, _scrP.y, 2, Math.PI / 2);
    }
  }
  let done = 0;
  for (let k = 0; k < K.length; k++) {
    const ev = K[k];
    if (u >= ev.t) done++;
    if (u > ev.t - 0.1 && u < ev.t) scrRect(g, '#ffffff', 60, ev.y - 1, ev.x - 60, 3);            // killing beam
    scrBoom(g, ev.x, ev.y, u - ev.t, 22, '#ffe600', '#ff2bd6', k);
  }
  scrBlitC(g, A.ship, 46, shipY, 2);
  if (u > 8.4 && u < 10 && ((u * 5) | 0) % 2 === 0) { scrRect(g, 'rgba(255,30,60,0.4)', 0, 80, SCR_W, 26); scrTextS(g, 'WARNING', 128, 88, '#ffffff', 2, 1); }
  if (boss) {
    const bx = 300 - scrEase((u - 10) / 2) * 90, by = 96 + Math.sin(u * 1.2) * 40;
    galaxyBoss(g, bx, by, u, u > 13 && ((u * 12) | 0) % 3 === 0);
    if (u > 12) for (let i = 0; i < 4; i++) { const tb = (u - 12) % 1.1 - i * 0.28; if (tb > 0) { scrDisc(g, '#ff5a5a', bx - 50 - tb * 110, by + (i - 1.5) * 16 * tb * 2, 3); } }
    scrRect(g, '#40060c', 60, 14, 136, 5); scrRect(g, '#ff2bd6', 61, 15, 134 * (1 - scrClamp((u - 12) / 6) * 0.55), 3);
  }
  scrText(g, '1P', 6, 2, '#ff5a5a'); scrNum(g, 1200 + done * 100, 7, 26, 2, '#ffffff'); scrText(g, 'HI', 150, 2, '#ff5a5a'); scrNum(g, 500000, 7, 170, 2, '#ffffff');
  scrText(g, 'BEAM', 6, 172, '#ffe600'); scrRect(g, '#3a1a5a', 42, 172, 60, 6); scrRect(g, '#ff2bd6', 42, 172, 12 + ((u * 20) % 48), 6);
}

// ───────── PONG 2000: neon paddles, glowing ball with a trail, sparks on every return ─────────
const PONG_T = 1.15, PONG_GOALS = [[3.8, 1], [7.4, 0], [10.6, 1], [13.4, 1]];           // ball crossing time; [time, scorer side]
function pongBall(u, out) { out.x = 18 + 220 * scrTri(u / PONG_T); out.y = 26 + 144 * scrTri(u * 0.83 + 0.3); }
function pongInit(A) {
  A.bg = scrLayer((g) => {
    scrRect(g, '#04060f', 0, 0, SCR_W, SCR_H);
    g.fillStyle = 'rgba(0,229,255,0.07)';
    for (let x = 0; x < SCR_W; x += 16) g.fillRect(x, 12, 1, 170);
    for (let y = 12; y < 182; y += 16) g.fillRect(0, y, SCR_W, 1);
    for (let y = 22; y < 176; y += 12) scrRect(g, '#9ab8ff', 127, y, 2, 6);                    // centre net
    scrRect(g, '#00e5ff', 0, 14, SCR_W, 2); scrRect(g, '#ff2bd6', 0, 176, SCR_W, 2);
  });
}
function pongGlowRect(g, col, x, y, w, h) {                          // neon: a wide faint copy under a bright core
  g.globalAlpha = 0.25; scrRect(g, col, x - 2, y - 2, w + 4, h + 4); g.globalAlpha = 1; scrRect(g, col, x, y, w, h); scrRect(g, '#ffffff', x + 1, y, 1, h);
}
function pongDemo(g, u, A) {
  g.drawImage(A.bg, 0, 0);
  pongBall(u, _scrP);
  const bx = _scrP.x, by = _scrP.y;
  let sl = 0, sr = 0, flash = 0;
  for (let i = 0; i < PONG_GOALS.length; i++) if (u > PONG_GOALS[i][0]) { if (PONG_GOALS[i][1]) sr++; else sl++; flash = u - PONG_GOALS[i][0] < 0.5 ? 1 : 0; }
  g.globalAlpha = 0.55; scrNum(g, sl, 1, 92, 24, flash ? '#ffe600' : '#00e5ff', 3); scrNum(g, sr, 1, 140, 24, flash ? '#ffe600' : '#ff2bd6', 3); g.globalAlpha = 1;
  pongBall(u - 0.09, _scrP); const ly = _scrP.y;
  pongBall(u - 0.13, _scrP); const ry = _scrP.y;
  pongGlowRect(g, '#00e5ff', 6, ly - 15, 6, 30); pongGlowRect(g, '#ff2bd6', 244, ry - 15, 6, 30);
  for (let i = 8; i >= 1; i--) {                                     // fading trail
    pongBall(u - i * 0.02, _scrP);
    g.globalAlpha = 0.5 - i * 0.055; scrRect(g, '#ffffff', _scrP.x - 3, _scrP.y - 3, 6, 6);
  }
  g.globalAlpha = 1; pongGlowRect(g, '#ffffff', bx - 3, by - 3, 6, 6);
  const n = Math.floor(u / PONG_T), age = u - n * PONG_T;
  if (n >= 1 && age < 0.3) scrBoom(g, n & 1 ? 240 : 16, by, age * 2, 14, '#ffffff', n & 1 ? '#ff2bd6' : '#00e5ff', n);
  scrText(g, 'PONG 2000', 128, 5, '#7a8ab8', 1, 1);
  scrText(g, 'RALLY', 6, 168, '#ffffff'); scrNum(g, n, 2, 50, 168, '#ffe600'); scrText(g, 'SPEED X2', 250, 168, '#ff2bd6', 1, 2);
}

// ───────── SNAKE BYTE: a long snake grows as it eats apples along a serpentine route ─────────
const SNAKE_PATH = [[3, 2], [28, 2], [28, 7], [6, 7], [6, 12], [28, 12], [28, 17], [3, 17]];   // corners in cells
const SNAKE_SPEED = 9, SNAKE_APPLES = [14, 33, 52, 71, 88, 105], SNAKE_Y0 = 12, SNAKE_C = 8;
const SNAKE_COLORS = ['#ffd0e0', '#ff9ec0', '#ff7aa8', '#ff5c93', '#f04c86', '#e04480', '#d63e78', '#cc3a72', '#c0366c', '#b83268', '#b02e64', '#a82a60'];
const SNAKE_COLORS2 = ['#d0fff0', '#9effd0', '#7affb8', '#5cf0a0', '#4ce090', '#44d088', '#3ec080', '#3ab878', '#36b070', '#32a868', '#2ea062', '#2a985c'];
function snakeInit(A) {
  A.cells = [];                                                      // every grid cell of the closed route, in order
  for (let s = 0; s < SNAKE_PATH.length; s++) {
    const a = SNAKE_PATH[s], b = SNAKE_PATH[(s + 1) % SNAKE_PATH.length];
    const n = Math.abs(b[0] - a[0]) + Math.abs(b[1] - a[1]), dx = Math.sign(b[0] - a[0]), dy = Math.sign(b[1] - a[1]);
    for (let i = 0; i < n; i++) A.cells.push([a[0] + dx * i, a[1] + dy * i]);
  }
  A.bg = scrLayer((g) => {
    scrRect(g, '#1a0812', 0, 0, SCR_W, SCR_H);
    g.fillStyle = 'rgba(255,92,147,0.22)';
    for (let y = 0; y < 21; y++) for (let x = 0; x < 32; x++) g.fillRect(x * SNAKE_C + 3, SNAKE_Y0 + y * SNAKE_C + 3, 2, 2);
    g.strokeStyle = '#ff5c93'; g.lineWidth = 2; g.strokeRect(1, SNAKE_Y0 - 1, SCR_W - 2, 170);
    g.strokeStyle = 'rgba(255,92,147,0.35)'; g.lineWidth = 1; g.strokeRect(4.5, SNAKE_Y0 + 2.5, SCR_W - 9, 164);
  });
}
// Draws a snake whose head is at fractional route position h, `len` segments long (palette runs head to tail).
function snakeDraw(g, C, h, len, pal) {
  const n = C.length, hi = Math.floor(h), f = h - hi;
  for (let i = len - 1; i >= 0; i--) {
    const a = C[(((hi - i) % n) + n) % n], b = C[(((hi - i + 1) % n) + n) % n];
    const x = (a[0] + (b[0] - a[0]) * f) * SNAKE_C, y = SNAKE_Y0 + (a[1] + (b[1] - a[1]) * f) * SNAKE_C;
    scrRect(g, pal[Math.min(11, Math.floor((i * 12) / len))], x, y, 8, 8); scrRect(g, 'rgba(255,255,255,0.35)', x, y, 8, 1);
    scrRect(g, 'rgba(0,0,0,0.35)', x + 7, y, 1, 8); scrRect(g, 'rgba(0,0,0,0.35)', x, y + 7, 8, 1);
    if (i === 0) {
      const ex = b[0] - a[0], ey = b[1] - a[1];                     // eyes look where the snake is going
      scrRect(g, '#ffffff', x + 2 + ex * 2 - Math.abs(ey), y + 2 + ey * 2 - Math.abs(ex), 2, 2); scrRect(g, '#ffffff', x + 4 + ex * 2 + Math.abs(ey), y + 4 + ey * 2 + Math.abs(ex), 2, 2);
      scrRect(g, '#14101f', x + 3 + ex * 2, y + 3 + ey * 2, 1, 1);
    }
  }
}
function snakeDemo(g, u, A) {
  const C = A.cells, n = C.length, h = u * SNAKE_SPEED, hi = Math.floor(h), f = h - hi;
  g.drawImage(A.bg, 0, 0);
  let eaten = 0;
  for (let j = 0; j < SNAKE_APPLES.length; j++) if (hi >= SNAKE_APPLES[j]) eaten++;
  for (let j = eaten; j < Math.min(SNAKE_APPLES.length, eaten + 2); j++) {                     // the next two apples
    const c = C[SNAKE_APPLES[j] % n], x = c[0] * SNAKE_C + 4, y = SNAKE_Y0 + c[1] * SNAKE_C + 4, r = ((u * 4) | 0) & 1 ? 5 : 4;
    scrDisc(g, '#ff2a3a', x, y + 1, r); scrRect(g, '#39ff88', x, y - 5, 3, 2); scrRect(g, '#ffffff', x - 2, y - 1, 1, 1);
  }
  if (eaten) {                                                       // "+10" pops up where the last apple was eaten
    const age = (h - SNAKE_APPLES[eaten - 1]) / SNAKE_SPEED, c = C[SNAKE_APPLES[eaten - 1] % n];
    if (age < 0.7) scrText(g, '+10', c[0] * SNAKE_C - 4, SNAKE_Y0 + c[1] * SNAKE_C - 10 - age * 8, '#ffe600');
  }
  const len = 5 + eaten * 2;
  snakeDraw(g, C, h + 62, 12, SNAKE_COLORS2);                       // a rival snake on the far side of the route
  snakeDraw(g, C, h, len, SNAKE_COLORS);
  scrText(g, 'SCORE', 6, 2, '#ff5c93'); scrNum(g, eaten * 10 + hi, 5, 54, 2, '#ffffff');
  scrText(g, 'LENGTH', 130, 2, '#ff5c93'); scrNum(g, len, 2, 186, 2, '#ffffff'); scrText(g, 'LV 3', 250, 2, '#39ff88', 1, 2);
}

// ───────── ZOMBIE ZAP: twin-stick survivor in a flashlight beam; zombies shamble in from all sides ─────────
const ZOMBIE_COUNT = 16, ZOMBIE_SPEED = 26, ZOMBIE_R0 = 150;
const zombieSpawnT = (i) => 0.2 + i * 0.85;
const zombieKillR = (i) => 34 + scrHash(i * 5 + 3) * 34;
const zombieKillT = (i) => zombieSpawnT(i) + (ZOMBIE_R0 - zombieKillR(i)) / ZOMBIE_SPEED;
function zombiePos(i, t, out) {                                       // out.x, out.y and out.a (angle from the hero)
  const r = ZOMBIE_R0 - ZOMBIE_SPEED * (t - zombieSpawnT(i)), a = scrHash(i * 7 + 1) * 6.2832 + Math.sin(t * 1.7 + i) * 0.04;
  out.a = a; out.x = 128 + Math.cos(a) * r * 1.3 + Math.sin(a) * Math.sin(t * 3 + i) * 2; out.y = 96 + Math.sin(a) * r * 0.9;
}
function zombieTarget(t) {                                            // the zombie the hero is shooting at time t (-1 if none)
  let best = -1, bt = 1e9;
  for (let i = 0; i < ZOMBIE_COUNT; i++) {
    const k = zombieKillT(i);
    if (zombieSpawnT(i) <= t && k > t && k < bt) { bt = k; best = i; }
  }
  return best;
}
function zombieInit(A) {
  A.bg = scrLayer((g) => {
    scrRect(g, '#1c2026', 0, 0, SCR_W, SCR_H);
    for (let i = 0; i < 260; i++) scrRect(g, scrHash(i) > 0.5 ? '#262b33' : '#14171c', scrHash(i + 300) * SCR_W, scrHash(i + 600) * SCR_H, 1 + (i % 3), 1);
    scrRect(g, '#2a2f38', 0, 70, SCR_W, 52); scrRect(g, '#2a2f38', 104, 12, 48, 170);
    g.fillStyle = '#c8a820';
    for (let x = 4; x < SCR_W; x += 20) g.fillRect(x, 95, 10, 2);
    for (let y = 16; y < 180; y += 20) g.fillRect(127, y, 2, 10);
    for (const c of [[24, 30], [206, 34], [30, 150], [212, 148]]) {                            // wrecks, crates, barrels in the corners
      scrRect(g, '#0e1014', c[0] - 1, c[1] + 15, 24, 4); scrRect(g, '#5a2a2a', c[0], c[1], 22, 16); scrRect(g, '#8a9098', c[0] + 3, c[1] + 2, 8, 6); scrRect(g, '#3a1a1a', c[0], c[1] + 12, 22, 4);
    }
    for (let i = 0; i < 26; i++) { g.fillStyle = 'rgba(110,10,20,0.55)'; g.fillRect(scrHash(i + 900) * 250, scrHash(i + 950) * 170 + 12, 3 + (i % 4), 2); }
    g.fillStyle = '#1a3a22'; for (const c of [[0, 12, 30, 22], [226, 150, 30, 30], [0, 158, 24, 24]]) g.fillRect(c[0], c[1], c[2], c[3]);
  });
  A.dark = scrLayer((g) => {                                          // flashlight: bright pool around the hero, near-black beyond it
    const rg = g.createRadialGradient(128, 96, 18, 128, 96, 168);
    rg.addColorStop(0, 'rgba(0,0,0,0)'); rg.addColorStop(0.45, 'rgba(0,0,10,0.35)'); rg.addColorStop(1, 'rgba(0,0,10,0.9)');
    g.fillStyle = rg; g.fillRect(0, 0, SCR_W, SCR_H);
  });
}
function zombieDraw(g, x, y, a, t, i) {                               // top-down zombie, arms reaching toward the hero
  g.save(); g.translate(Math.round(x), Math.round(y)); g.rotate(a + Math.PI);
  const sw = Math.sin(t * 6 + i) * 1.5;
  scrRect(g, '#1e6a3a', -4, -5, 8, 10); scrRect(g, '#2a8a4a', 2 + sw, -6, 8, 2); scrRect(g, '#2a8a4a', 2 - sw, 4, 8, 2);
  scrDisc(g, '#5acb7a', 0, 0, 4); scrRect(g, '#ff2a3a', 2, -2, 1, 1); scrRect(g, '#ff2a3a', 2, 1, 1, 1);
  g.restore();
}
function zombieDemo(g, u, A) {
  g.drawImage(A.bg, 0, 0);
  let kills = 0;
  for (let i = 0; i < ZOMBIE_COUNT; i++) {                            // blood splats of the fallen
    const k = zombieKillT(i);
    if (k <= u) { kills++; zombiePos(i, k, _scrP); scrDisc(g, '#5a0a14', _scrP.x, _scrP.y, 4); scrRect(g, '#8a1020', _scrP.x - 5, _scrP.y + 1, 3, 2); }
  }
  const tg = zombieTarget(u);
  let aim = 0;
  if (tg >= 0) { zombiePos(tg, u, _scrP); aim = Math.atan2(_scrP.y - 96, _scrP.x - 128); }
  for (let i = 0; i < ZOMBIE_COUNT; i++) {
    if (zombieSpawnT(i) > u || zombieKillT(i) <= u) continue;
    zombiePos(i, u, _scrP);
    zombieDraw(g, _scrP.x, _scrP.y, _scrP.a, u, i);
  }
  for (let i = 0; i < ZOMBIE_COUNT; i++) { const age = u - zombieKillT(i); if (age >= 0 && age < 0.6) { zombiePos(i, zombieKillT(i), _scrP);
  scrBoom(g, _scrP.x, _scrP.y, age, 18, '#ff2a3a', '#8a0a14', i); } }
  for (let b = 0; b < 6; b++) {                                       // tracer rounds at 10 shots/s, each aimed when fired
    const tb = Math.floor(u * 10 - b) / 10, age = u - tb, t2 = zombieTarget(tb);
    if (t2 < 0 || age > 0.36) continue;
    zombiePos(t2, tb, _scrP);
    const a = Math.atan2(_scrP.y - 96, _scrP.x - 128), d = 14 + age * 230;
    scrRect(g, '#ffe680', 128 + Math.cos(a) * d - 1, 96 + Math.sin(a) * d - 1, 3, 3);
    scrRect(g, '#ff9a1f', 128 + Math.cos(a) * (d - 6) - 1, 96 + Math.sin(a) * (d - 6) - 1, 2, 2);
  }
  g.save(); g.translate(128, 96);                                     // the hero
  scrRect(g, 'rgba(0,0,0,0.4)', -6, 3, 12, 4);
  g.rotate(aim);
  scrRect(g, '#1a3a8a', -4, -5, 8, 10); scrRect(g, '#2f6bff', -3, -4, 6, 8); scrRect(g, '#8f95ad', 3, -1, 11, 3); scrRect(g, '#3a3f55', 5, 0, 6, 1); scrDisc(g, '#ffc9a0', 0, 0, 3);
  if (tg >= 0 && ((u * 20) | 0) & 1) { scrRect(g, '#ffffff', 14, -2, 4, 5); scrRect(g, '#ffb000', 18, -1, 3, 3); }
  g.restore();
  g.drawImage(A.dark, 0, 0);
  if (u < 1.6) scrTextS(g, 'WAVE 03', 128, 60, '#ff2a3a', 2, 1);
  scrText(g, 'SCORE', 6, 2, '#39ff88'); scrNum(g, kills * 100, 6, 54, 2, '#ffffff'); scrText(g, 'KILLS', 150, 2, '#39ff88'); scrNum(g, kills, 3, 190, 2, '#ffffff');
  scrText(g, 'AMMO', 6, 172, '#ffe600'); scrNum(g, Math.max(0, 99 - u * 5), 2, 42, 172, '#ffffff');
  scrText(g, 'HP', 150, 172, '#ff5a5a'); scrRect(g, '#40060c', 170, 172, 70, 7); scrRect(g, '#39ff88', 171, 173, 68 - Math.max(0, u - 8) * 2, 5);
}

// ───────── STREET BRAWL: side-scrolling beat-em-up with parallax city, two heroes and thugs ─────────
const BRAWL_WALK = [[0, 3.2], [6.6, 8.8], [12.4, 15]];              // windows in which the street scrolls; between them the fights happen
const BRAWL_SPEED = 34, BRAWL_FLOOR = 156;
function brawlScroll(u) {                                            // distance scrolled by time u
  let d = 0;
  for (let i = 0; i < BRAWL_WALK.length; i++) d += Math.max(0, Math.min(u, BRAWL_WALK[i][1]) - BRAWL_WALK[i][0]) * BRAWL_SPEED;
  return d;
}
const brawlPulse = (tau, t0) => (tau < t0 || tau > t0 + 0.3 ? 0 : tau < t0 + 0.12 ? (tau - t0) / 0.12 : 1 - (tau - t0 - 0.12) / 0.18);   // 0..1..0 attack swing
function brawlInit(A) {
  A.sky = scrLayer((g) => {
    const gr = g.createLinearGradient(0, 0, 0, 140); gr.addColorStop(0, '#1a0a3a'); gr.addColorStop(0.7, '#8a2a7a'); gr.addColorStop(1, '#ff7a3a');
    g.fillStyle = gr; g.fillRect(0, 0, SCR_W, 140); scrDisc(g, '#ffd8a0', 200, 50, 14);
    g.fillStyle = '#3a2a1a'; g.fillRect(0, 140, SCR_W, SCR_H - 140);
    scrRect(g, '#5a5a70', 0, 138, SCR_W, 22); scrRect(g, '#7a7a90', 0, 138, SCR_W, 2); scrRect(g, '#26262e', 0, 160, SCR_W, 32);   // sidewalk and road
  });
  A.far = scrLayer((g) => {                                          // distant skyline, 512 wide so it can scroll
    for (let x = 0, i = 0; x < 512; i++) {
      const w = 20 + scrHash(i) * 20, h = 50 + scrHash(i + 40) * 50;
      scrRect(g, i & 1 ? '#2a1450' : '#341a60', x, 138 - h, w, h);
      for (let wy = 138 - h + 5; wy < 130; wy += 7) for (let wx = x + 3; wx < x + w - 3; wx += 5) if (scrHash(wx * 3 + wy + i) > 0.55) scrRect(g, '#ffd070', wx, wy, 2, 3);
      x += w;
    }
  }, 512, SCR_H);
  A.near = scrLayer((g) => {                                         // shop fronts with signs, crates and lamp posts
    const signs = ['BAR', 'PIZZA', 'ARCADE', '24H', 'MOTEL', 'NOODLE', 'PAWN', 'CLUB'], cols = ['#ff2bd6', '#ffe600', '#00e5ff', '#39ff88'];
    for (let i = 0; i < 8; i++) {
      const x = i * 64;
      scrRect(g, i & 1 ? '#3a2a4a' : '#2e2240', x, 84, 64, 56); scrRect(g, '#1a1226', x, 84, 64, 3);
      scrRect(g, cols[i % 4], x + 4, 92, 56, 9); scrText(g, signs[i], x + 32, 93, '#14101f', 1, 1);
      scrRect(g, '#10081c', x + 8, 108, 26, 30); scrRect(g, ((i * 5) & 1) ? '#ffe0a0' : '#7ff5ff', x + 10, 110, 22, 24); scrRect(g, '#14101f', x + 20, 110, 2, 24);
      scrRect(g, '#10081c', x + 42, 110, 14, 30);
    }
    for (const lx of [40, 300]) { scrRect(g, '#14101f', lx, 60, 3, 82); scrRect(g, '#14101f', lx, 60, 14, 3); scrRect(g, '#ffe680', lx + 10, 63, 8, 3); }
    for (const cx of [150, 400]) { scrRect(g, '#7a4a1a', cx, 130, 14, 12); scrRect(g, '#5a3210', cx, 135, 14, 2); }
  }, 512, SCR_H);
}
// Human brawler: (x, y) = feet, dir = +1 faces right; punch/kick/fall 0..1.
function brawlDraw(g, x, y, dir, walk, punch, kick, fall, top, pants, hair, band, flash) {
  g.save(); g.translate(Math.round(x), Math.round(y)); g.scale(dir, 1);
  if (fall) g.rotate(-fall * 1.5);
  const skin = flash ? '#ffffff' : '#ffc9a0', tp = flash ? '#ffffff' : top, pn = flash ? '#dddddd' : pants, sw = Math.round(Math.sin(walk) * 3);
  scrRect(g, pn, -5 + sw, -14, 4, 11); scrRect(g, '#14101f', -6 + sw, -3, 6, 3);
  if (kick > 0.05) { scrRect(g, pn, 1, -18 - kick * 4, 4 + kick * 12, 4); scrRect(g, '#14101f', 3 + kick * 12, -20 - kick * 4, 4, 6); }
  else { scrRect(g, pn, 1 - sw, -14, 4, 11); scrRect(g, '#14101f', 0 - sw, -3, 6, 3); }
  scrRect(g, tp, -6, -30, 12, 16); scrRect(g, '#14101f', -6, -16, 12, 2);
  scrRect(g, skin, -8, -29, 3, 11);
  const len = 4 + punch * 14;
  scrRect(g, skin, 4, -28, len, 4); scrRect(g, skin, 4 + len, -29, 5, 6);
  scrRect(g, skin, -4, -40, 9, 10); scrRect(g, hair, -5, -42, 10, 4); scrRect(g, hair, -5, -40, 2, 6);
  if (band) scrRect(g, band, -5, -37, 10, 2);
  scrRect(g, '#14101f', 2, -36, 2, 2);
  g.restore();
}
function brawlDemo(g, u, A) {
  g.drawImage(A.sky, 0, 0);
  const sc = brawlScroll(u), f = Math.round(sc * 0.25) % 512, n = Math.round(sc) % 512;
  g.drawImage(A.far, -f, 0); g.drawImage(A.far, 512 - f, 0);
  g.drawImage(A.near, -n, 0); g.drawImage(A.near, 512 - n, 0);
  g.fillStyle = '#c8c8d8';
  for (let x = -((sc * 1.0) % 48); x < SCR_W; x += 48) g.fillRect(x, 174, 24, 2);
  const walking = u < 3.2 || (u > 6.6 && u < 8.8) || u > 12.4, wk = walking ? u * 9 : 0;
  // fight scripts: thugs (x, fall time), hero swings at fixed offsets from the fight start
  let fightT = -1, thugs = 0;
  if (u >= 3.2 && u < 6.6) { fightT = u - 3.2; thugs = 1; } else if (u >= 8.8 && u < 12.4) { fightT = u - 8.8; thugs = 2; }
  let hp1 = 100, hurt1 = 0;
  if (fightT >= 0) {
    const punch = Math.max(brawlPulse(fightT, 0.3), brawlPulse(fightT, 0.9), brawlPulse(fightT, 1.5)), kick = brawlPulse(fightT, 2.1);
    const thugPunch = brawlPulse(fightT, 1.2);
    hurt1 = fightT > 1.35 && fightT < 1.7 ? 1 : 0; hp1 = fightT > 1.35 ? 78 : 100;
    brawlDraw(g, 96, BRAWL_FLOOR, 1, 0, punch, kick, 0, '#f5f5ff', '#2a4a9a', '#3a2010', '#ff2a3a', hurt1 && ((u * 20) | 0) & 1);
    brawlDraw(g, 62, BRAWL_FLOOR + 4, 1, 0, brawlPulse(fightT, 0.6), brawlPulse(fightT, 1.8), 0, '#39ff88', '#3a3a5a', '#ffd23f', null, false);
    for (let t = 0; t < thugs; t++) {
      const tt = fightT - t * 0.5, hitT = tt > 0.45 && tt < 0.75 || tt > 1.05 && tt < 1.35 || tt > 1.65 && tt < 1.95, fall = scrEase((tt - 2.25) / 0.35);
      const tx = 168 + t * 34 + (hitT ? 5 : 0) + fall * 26, gone = tt > 3.0;
      if (!gone && (fall < 1 || ((u * 10) | 0) & 1)) brawlDraw(g, tx, BRAWL_FLOOR + t * 4, -1, 0, t === 0 ? thugPunch : brawlPulse(tt, 1.2), 0, fall, '#8a2a9a', '#3a3a4a', '#14101f', null, hitT && ((u * 20) | 0) & 1);
      if (tt > 2.25 && tt < 3.0) scrText(g, '100', tx, BRAWL_FLOOR - 50 - (tt - 2.25) * 12, '#ffe600', 1, 1);
      if (tt > 0.45 && tt < 0.75) scrBoom(g, 150 + t * 34, BRAWL_FLOOR - 30, tt - 0.45, 12, '#ffffff', '#ffe600', t);
    }
  } else {
    brawlDraw(g, 96, BRAWL_FLOOR, 1, wk, 0, 0, 0, '#f5f5ff', '#2a4a9a', '#3a2010', '#ff2a3a', false);
    brawlDraw(g, 62, BRAWL_FLOOR + 4, 1, wk + 1.5, 0, 0, 0, '#39ff88', '#3a3a5a', '#ffd23f', null, false);
    const enter = u < 3.2 ? 300 - scrEase((u - 1.4) / 1.8) * 132 : u < 8.8 ? 300 - scrEase((u - 7.0) / 1.8) * 132 : 300;
    if ((u > 1.4 && u < 3.2) || (u > 7.0 && u < 8.8)) brawlDraw(g, enter, BRAWL_FLOOR, -1, u * 8, 0, 0, 0, '#8a2a9a', '#3a3a4a', '#14101f', null, false);
    if (u > 7.0 && u < 8.8) brawlDraw(g, enter + 34, BRAWL_FLOOR + 4, -1, u * 8 + 2, 0, 0, 0, '#8a2a9a', '#3a3a4a', '#14101f', null, false);
  }
  if (walking && ((u * 3) | 0) % 2 === 0) scrTextS(g, 'GO >>>', 210, 60, '#ffe600', 2, 1);
  scrText(g, 'P1', 6, 2, '#ff5a5a'); scrRect(g, '#40060c', 24, 3, 64, 6); scrRect(g, '#ffe600', 25, 4, 62 * hp1 / 100, 4); scrText(g, 'X3', 92, 2, '#ffffff');
  scrText(g, 'P2', 250 - 8 * 2 - 84, 2, '#39ff88'); scrRect(g, '#40060c', 168, 3, 64, 6); scrRect(g, '#39ff88', 169, 4, 62, 4); scrText(g, 'X2', 250, 2, '#ffffff', 1, 2);
  scrText(g, 'SCORE', 100, 12, '#ffffff'); scrNum(g, 1200 + Math.floor(u * 40) * 10, 6, 148, 12, '#ffe600');
}

// ───────── HOOP SHOT: first-person basketball shootout with arcing shots, net physics and SWISH ─────────
const HOOP_SHOTS = [[70, 1], [190, 1], [128, 0], [96, 1], [168, 1], [150, 0], [110, 1]];   // [start x, 1 = swish / 0 = rim-out]
const HOOP_T0 = 0.8, HOOP_GAP = 2.05, HOOP_FLIGHT = 0.85, HOOP_Y = 68;
// Ball state for shot k at time u: out.x, out.y, out.r; returns false when the ball is not visible.
function hoopBall(u, k, out) {
  const tau = u - (HOOP_T0 + k * HOOP_GAP), sx = HOOP_SHOTS[k][0], make = HOOP_SHOTS[k][1];
  if (tau < 0) return false;
  if (tau < HOOP_FLIGHT) {
    const p = tau / HOOP_FLIGHT, tx = make ? 128 : 146;
    out.x = sx + (tx - sx) * p; out.y = 176 + (HOOP_Y - 176) * p - 64 * 4 * p * (1 - p); out.r = 13 * (1 - 0.5 * p);
    return true;
  }
  const s = tau - HOOP_FLIGHT;
  if (make) {                                                        // drops through the net, then bounces on the floor
    out.x = 128; out.r = 6.5;
    out.y = s < 0.35 ? HOOP_Y + 34 * (s / 0.35) : 132 + 22 * Math.min(1, (s - 0.35) * 2) - Math.abs(Math.sin((s - 0.35) * 8)) * 20 * Math.exp(-(s - 0.35) * 2.5);
    return s < 1.4;
  }
  out.x = 146 + s * 110; out.y = HOOP_Y - 70 * s + 300 * s * s; out.r = 6.5 + s * 5;
  return out.y < 200;
}
function hoopInit(A) {
  A.bg = scrLayer((g) => {
    const wall = g.createLinearGradient(0, 0, 0, 140); wall.addColorStop(0, '#0a1230'); wall.addColorStop(1, '#1a2a5a'); g.fillStyle = wall; g.fillRect(0, 0, SCR_W, 140);
    for (let row = 0; row < 3; row++) for (let i = 0; i < 40; i++) {                            // crowd
      const x = i * 6.6 + (row & 1) * 3, y = 92 + row * 13;
      scrRect(g, ['#ff2bd6', '#ffe600', '#00e5ff', '#39ff88', '#6a5aa0', '#3a3a70'][Math.floor(scrHash(i * 3 + row) * 6)], x, y + 4, 6, 9);
      scrDisc(g, ['#ffc9a0', '#a0623a', '#e0a070', '#5a3a22'][Math.floor(scrHash(i + row * 50) * 4)], x + 3, y + 1, 3);
    }
    g.fillStyle = 'rgba(6,10,30,0.5)'; g.fillRect(0, 88, SCR_W, 52);                                 // dim the stands
    scrRect(g, '#ff8a1f', 0, 84, SCR_W, 3); scrRect(g, '#14101f', 0, 87, SCR_W, 4);
    const fl = g.createLinearGradient(0, 140, 0, SCR_H); fl.addColorStop(0, '#c8802a'); fl.addColorStop(1, '#7a4a14'); g.fillStyle = fl; g.fillRect(0, 140, SCR_W, 52);
    scrRect(g, '#ffffff', 0, 140, SCR_W, 2);
    g.strokeStyle = 'rgba(90,50,10,0.5)'; g.lineWidth = 1; g.beginPath();
    for (let i = -10; i <= 10; i++) { g.moveTo(128 + i * 10, 142); g.lineTo(128 + i * 30, SCR_H); }
    g.stroke();
    g.fillStyle = '#2f6bff'; g.beginPath(); g.moveTo(96, 142); g.lineTo(160, 142); g.lineTo(200, 192); g.lineTo(56, 192); g.closePath(); g.fill();
    g.strokeStyle = '#ffffff'; g.lineWidth = 2; g.beginPath(); g.moveTo(96, 142); g.lineTo(56, 192); g.moveTo(160, 142); g.lineTo(200, 192); g.stroke();
    scrRect(g, '#5a6a8a', 126, 0, 4, 16);                                                           // support
  });
}
function hoopDemo(g, u, A) {
  g.drawImage(A.bg, 0, 0);
  let made = 0, shake = 0, swishAge = 9, thrown = 0;
  for (let k = 0; k < HOOP_SHOTS.length; k++) {
    const tau = u - (HOOP_T0 + k * HOOP_GAP) - HOOP_FLIGHT;
    if (u > HOOP_T0 + k * HOOP_GAP) thrown++;
    if (tau > 0 && HOOP_SHOTS[k][1]) { made++; if (tau < swishAge) swishAge = tau; }
    if (tau > 0 && tau < 0.3 && !HOOP_SHOTS[k][1]) shake = Math.round(Math.sin(tau * 60) * 2);
  }
  const bx = 88 + shake;
  g.fillStyle = '#cfe6ff'; g.fillRect(bx, 14, 80, 52); g.fillStyle = 'rgba(255,255,255,0.35)'; g.fillRect(bx + 4, 18, 30, 12);
  g.strokeStyle = '#2f6bff'; g.lineWidth = 3; g.strokeRect(bx + 1.5, 15.5, 77, 49); g.strokeStyle = '#ff8a1f'; g.lineWidth = 2; g.strokeRect(bx + 24.5, 38.5, 31, 23);
  const sway = swishAge < 1 ? Math.sin(swishAge * 30) * 3 * Math.exp(-swishAge * 3) : 0;
  g.strokeStyle = '#ff5a1f'; g.lineWidth = 2; g.beginPath(); g.ellipse(128 + shake, HOOP_Y, 20, 5, 0, Math.PI, 2 * Math.PI); g.stroke();      // back of the rim
  g.strokeStyle = 'rgba(255,255,255,0.75)'; g.lineWidth = 1; g.beginPath();                                                                            // net
  for (let i = 0; i < 8; i++) { const a = (i / 8) * 6.2832 + 0.2; g.moveTo(128 + shake + Math.cos(a) * 20, HOOP_Y + Math.sin(a) * 5);
  g.lineTo(128 + shake + Math.cos(a) * 11 + sway, 94 + Math.sin(a) * 3); }
  g.moveTo(118 + shake, 80); g.lineTo(138 + shake, 80); g.moveTo(120 + shake + sway * 0.5, 88); g.lineTo(136 + shake + sway * 0.5, 88); g.stroke();
  for (let k = 0; k < HOOP_SHOTS.length; k++) {
    if (!hoopBall(u, k, _scrP)) continue;
    scrDisc(g, '#ff8a1f', _scrP.x, _scrP.y, _scrP.r); scrDisc(g, '#ffb060', _scrP.x - _scrP.r * 0.3, _scrP.y - _scrP.r * 0.3, _scrP.r * 0.45);
    g.strokeStyle = '#6a2400'; g.lineWidth = 1; g.beginPath();
    g.moveTo(_scrP.x - _scrP.r, _scrP.y); g.lineTo(_scrP.x + _scrP.r, _scrP.y); g.moveTo(_scrP.x, _scrP.y - _scrP.r); g.lineTo(_scrP.x, _scrP.y + _scrP.r); g.stroke();
  }
  g.strokeStyle = '#ff5a1f'; g.lineWidth = 2; g.beginPath(); g.ellipse(128 + shake, HOOP_Y, 20, 5, 0, 0, Math.PI); g.stroke();                          // front of the rim
  for (let i = 0; i < 5 - Math.min(5, thrown); i++) { scrDisc(g, '#ff8a1f', 14 + i * 15, 166, 6); scrRect(g, '#6a2400', 8 + i * 15, 166, 12, 1); }
  if (swishAge < 1.1 && ((swishAge * 10) | 0) % 2 === 0) scrTextS(g, 'SWISH!', 128, 108, '#ff2bd6', 2, 1);
  scrText(g, 'TIME', 6, 2, '#ff5a5a'); scrNum(g, Math.max(0, 45 - u), 2, 42, 2, '#ffffff');
  scrText(g, 'SCORE', 96, 2, '#ff5a5a'); scrNum(g, made * 2 + (made > 2 ? 3 : 0), 3, 142, 2, '#ffffff'); scrText(g, 'HI 048', 250, 2, '#ffe600', 1, 2);
}

// ───────── FROG HOP: traffic, logs and turtles; the frog's route is planned once so it always lands safely ─────────
const FROG_ROW_H = 13, FROG_Y0 = 12, FROG_HOP = 0.2;
const FROG_SLOTS = [30, 79, 128, 177, 226];
const FROG_LANES = [
  null,
  { kind: 'log', v: 16, gap: 96, w: 44 }, { kind: 'turtle', v: -22, gap: 80, w: 33 }, { kind: 'log', v: 26, gap: 140, w: 78 },
  { kind: 'log', v: 12, gap: 92, w: 38 }, { kind: 'turtle', v: -18, gap: 76, w: 22 },
  null,
  { kind: 'car', v: -30, gap: 78, w: 16, col: '#ff2a3a' }, { kind: 'car', v: 22, gap: 92, w: 16, col: '#ffe600' }, { kind: 'truck', v: -16, gap: 120, w: 36, col: '#ff8a1f' },
  { kind: 'car', v: 40, gap: 100, w: 14, col: '#00e5ff' }, { kind: 'car', v: -24, gap: 84, w: 16, col: '#ff2bd6' },
  null,
];
const frogRowY = (row) => FROG_Y0 + row * FROG_ROW_H;
const frogCount = (L) => Math.ceil((SCR_W + L.w) / L.gap) + 1;
function frogObjX(L, row, n, t) {                                    // left edge of object n of a lane at time t (wraps around)
  const P = frogCount(L) * L.gap;
  return ((((n * L.gap + row * 23 + L.v * t) % P) + P) % P) - L.w;
}
function frogSafe(row, x, t0, t1) {                                  // is the ground/platform under a frog at x free of traffic in [t0, t1]?
  const L = FROG_LANES[row];
  for (let t = t0; t <= t1 + 1e-6; t += 0.1) for (let n = 0; n < frogCount(L); n++) { const ox = frogObjX(L, row, n, t); if (x + 6 > ox && x - 6 < ox + L.w) return false; }
  return true;
}
function frogXAt(e, t) { return e.n >= 0 ? frogObjX(FROG_LANES[e.row], e.row, e.n, t) + e.off : e.x; }
function frogPlanRoute(t0, avoid) {                                  // [{row, t (landing), x, n (platform or -1), off}]; avoid = home slot already taken
  const plan = [{ row: 12, t: t0, x: 128, n: -1, off: 0 }];
  for (let row = 11; row >= 0; row--) {
    const prev = plan[plan.length - 1], L = FROG_LANES[row], roadPrev = FROG_LANES[prev.row] && prev.n < 0;
    let found = null;
    for (let tl = Math.max(t0 + 0.9, prev.t + 0.4); tl < prev.t + 8 && !found; tl += 0.05) {
      const px = frogXAt(prev, tl);
      if (roadPrev && !frogSafe(prev.row, prev.x, prev.t, tl - FROG_HOP)) break;
      if (row === 0) {
        const s = FROG_SLOTS.filter((v) => v !== avoid).reduce((a, b) => (Math.abs(b - px) < Math.abs(a - px) ? b : a));
        if (Math.abs(s - px) <= 46) found = { row, t: tl, x: s, n: -1, off: 0 };
      } else if (!L) found = { row, t: tl, x: scrClamp(px, 12, 244), n: -1, off: 0 };
      else if (L.kind === 'car' || L.kind === 'truck') {
        for (const dx of [0, 8, -8, 16, -16, 24, -24, 32, -32]) {
          const x = scrClamp(px + dx, 12, 244);
          if (frogSafe(row, x, tl - 0.1, tl + 0.4)) { found = { row, t: tl, x, n: -1, off: 0 }; break; }
        }
      } else {
        for (let n = 0; n < frogCount(L) && !found; n++) {
          const ox = frogObjX(L, row, n, tl), x = scrClamp(px, ox + 8, ox + L.w - 8);
          if (ox > 8 && ox + L.w < 248 && Math.abs(x - px) <= 40) found = { row, t: tl, x, n, off: x - ox };
        }
      }
    }
    if (!found) found = { row, t: prev.t + 0.5, x: prev.n < 0 ? prev.x : frogXAt(prev, prev.t + 0.5), n: -1, off: 0 };
    plan.push(found);
  }
  return plan;
}
function frogInit(A) {
  A.plan1 = frogPlanRoute(0, -1);                                    // two crossings per demo, into different home slots
  A.plan2 = frogPlanRoute(A.plan1[A.plan1.length - 1].t + 1.4, A.plan1[A.plan1.length - 1].x);
  A.bg = scrLayer((g) => {
    scrRect(g, '#1a5a2a', 0, frogRowY(0), SCR_W, FROG_ROW_H);
    for (const s of FROG_SLOTS) { scrRect(g, '#0a2a5a', s - 12, frogRowY(0) + 1, 24, FROG_ROW_H - 1); scrRect(g, '#2a8a3a', s - 12, frogRowY(0) + 1, 24, 2); }
    for (let r = 1; r <= 5; r++) {
      scrRect(g, '#1a4a9a', 0, frogRowY(r), SCR_W, FROG_ROW_H);
      g.fillStyle = '#2a6ac0'; for (let x = (r * 17) % 24; x < SCR_W; x += 24) g.fillRect(x, frogRowY(r) + 4 + (r & 1) * 4, 8, 1);
    }
    scrRect(g, '#6a2a9a', 0, frogRowY(6), SCR_W, FROG_ROW_H); scrRect(g, '#8a4ac0', 0, frogRowY(6), SCR_W, 2);
    for (let r = 7; r <= 11; r++) {
      scrRect(g, '#22222e', 0, frogRowY(r), SCR_W, FROG_ROW_H);
      if (r > 7) { g.fillStyle = '#4a4a5e'; for (let x = 0; x < SCR_W; x += 16) g.fillRect(x, frogRowY(r), 8, 1); }
    }
    scrRect(g, '#6a2a9a', 0, frogRowY(12), SCR_W, FROG_ROW_H + 1);
  });
}
function frogDraw(g, x, y, air) {                                    // (x, y) = centre of the frog's cell
  scrRect(g, '#1e9a3a', x - 4, y - 3, 8, 8); scrRect(g, '#39ff64', x - 3, y - 4, 6, 3); scrRect(g, '#39ff64', x - 3, y, 6, 4);
  scrRect(g, '#ffffff', x - 3, y - 6, 2, 2); scrRect(g, '#ffffff', x + 1, y - 6, 2, 2); scrRect(g, '#14101f', x - 3, y - 6, 1, 1); scrRect(g, '#14101f', x + 1, y - 6, 1, 1);
  if (air) { scrRect(g, '#1e9a3a', x - 7, y + 3, 3, 4); scrRect(g, '#1e9a3a', x + 4, y + 3, 3, 4); scrRect(g, '#1e9a3a', x - 6, y - 4, 2, 3); scrRect(g, '#1e9a3a', x + 4, y - 4, 2, 3); }
  else { scrRect(g, '#1e9a3a', x - 6, y + 1, 3, 4); scrRect(g, '#1e9a3a', x + 3, y + 1, 3, 4); }
}
function frogHome(g, h, u) {                                         // a frog safely in its home slot (+50 pops up)
  if (u < h.t) return;
  frogDraw(g, h.x, frogRowY(0) + 7, false);
  if (u - h.t < 1.2) scrText(g, '+50', h.x, 14, '#ffe600', 1, 1);
}
function frogDemo(g, u, A) {
  g.drawImage(A.bg, 0, 0);
  for (let row = 1; row <= 11; row++) {
    const L = FROG_LANES[row];
    if (!L) continue;
    const y = frogRowY(row);
    for (let n = 0; n < frogCount(L); n++) {
      const x = Math.round(frogObjX(L, row, n, u));
      if (x > SCR_W || x + L.w < 0) continue;
      if (L.kind === 'log') { scrRect(g, '#8a5a2a', x, y + 2, L.w, 9); scrRect(g, '#a8743a', x, y + 2, L.w, 2);
      scrRect(g, '#5a3a18', x, y + 9, L.w, 2); scrRect(g, '#5a3a18', x + 2, y + 5, 3, 3); scrRect(g, '#5a3a18', x + L.w - 5, y + 5, 3, 3); }
      else if (L.kind === 'turtle') for (let i = 0; i < L.w / 11; i++) { const cx = x + 5 + i * 11; scrDisc(g, '#1e9a55', cx, y + 6, 5);
      scrRect(g, '#39ff88', cx - 2, y + 3, 4, 3); scrRect(g, '#0f6a3a', cx - 1, y + 7, 2, 2);
      scrRect(g, '#39ff88', cx + (L.v < 0 ? -7 : 5), y + 5, 2, 2); }
      else {
        const front = L.v < 0 ? x : x + L.w - 4;
        scrRect(g, L.col, x, y + 3, L.w, 7); scrRect(g, '#14101f', x + (L.kind === 'truck' ? (L.v < 0 ? 4 : L.w - 12) : 4), y + 4, L.kind === 'truck' ? 8 : L.w - 8, 3);
        scrRect(g, '#ffffff', front, y + 4, 4, 2); scrRect(g, '#111111', x + 2, y + 9, 4, 3); scrRect(g, '#111111', x + L.w - 6, y + 9, 4, 3);
      }
    }
  }
  const home1 = A.plan1[A.plan1.length - 1], home2 = A.plan2[A.plan2.length - 1], P = u >= A.plan2[0].t ? A.plan2 : A.plan1;
  let k = 0;
  while (k + 1 < P.length && P[k + 1].t <= u) k++;
  let fx, fy, air = false;
  const next = P[k + 1];
  if (next && u > next.t - FROG_HOP) {                               // mid-hop from P[k] to next
    const f = (u - (next.t - FROG_HOP)) / FROG_HOP;
    fx = scrLerp(frogXAt(P[k], u), next.x, f); fy = scrLerp(frogRowY(P[k].row), frogRowY(next.row), f) + 6 - Math.sin(f * Math.PI) * 5; air = true;
  } else { fx = frogXAt(P[k], u); fy = frogRowY(P[k].row) + 6; }
  if (u < P[P.length - 1].t) frogDraw(g, Math.round(fx), Math.round(fy), air);
  frogHome(g, home1, u); frogHome(g, home2, u);
  scrHud(g, u, 10 * (k + (P === A.plan2 ? 12 : 0)) + (u >= home1.t ? 50 : 0) + (u >= home2.t ? 50 : 0), 10000, '#ff5a5a');
  scrRect(g, '#39ff64', 6, 175, 2, 4); scrRect(g, '#39ff64', 14, 175, 2, 4); scrText(g, 'TIME', 250, 172, '#ffe600', 1, 2);
  scrRect(g, '#39ff64', 130, 172, Math.max(0, 90 - u * 3), 6);
}

// ───────── DEEP DIVE: underwater diver, light shafts, fish schools, jellyfish, a shark and treasure ─────────
const DIVE_HITS = [6.0, 6.7, 7.4];
function diveShark(u) { return 300 - (u - 4) * 52; }
function diveInit(A) {
  A.bg = scrLayer((g) => {
    const w = g.createLinearGradient(0, 0, 0, SCR_H); w.addColorStop(0, '#7ff0e0'); w.addColorStop(0.3, '#1ab0c8'); w.addColorStop(0.7, '#0a4a7a'); w.addColorStop(1, '#021428');
    g.fillStyle = w; g.fillRect(0, 0, SCR_W, SCR_H);
    g.fillStyle = '#c8a86a'; g.beginPath(); g.moveTo(0, 182);
    for (let x = 0; x <= SCR_W; x += 8) g.lineTo(x, 160 + Math.sin(x * 0.03) * 6 + scrHash(x) * 4);
    g.lineTo(SCR_W, 182); g.fill();
    for (let i = 0; i < 9; i++) {                                                                  // coral and rocks
      const x = 10 + i * 30 + scrHash(i) * 10, h = 8 + scrHash(i + 20) * 16, col = ['#ff5a8a', '#ff8a1f', '#c06bff'][i % 3];
      for (let b = 0; b < 3; b++) scrRect(g, col, x + b * 4 - 4, 168 - h * (b === 1 ? 1 : 0.6), 3, h * (b === 1 ? 1 : 0.6));
      scrRect(g, col, x - 5, 166, 13, 3);
    }
    scrRect(g, '#6a6a80', 60, 170, 24, 12); scrRect(g, '#8a8aa0', 60, 170, 24, 3); scrRect(g, '#5a5a70', 170, 172, 30, 10);
    scrRect(g, '#6a3a1a', 206, 164, 22, 14); scrRect(g, '#ffe600', 216, 164, 3, 14); scrRect(g, '#8a5a2a', 206, 160, 22, 5);   // treasure chest
  });
}
function diveFish(g, x, y, dir, col) {
  scrRect(g, col, x - 4, y - 2, 8, 4); scrRect(g, col, x - 2, y - 3, 4, 6); scrRect(g, col, x - dir * 7, y - 3, 3, 6); scrRect(g, '#ffffff', x + dir * 2, y - 1, 1, 1);
}
function diveDiver(g, x, y, u) {                                      // side view, facing right, fins kicking
  const k = Math.round(Math.sin(u * 8) * 2);
  scrRect(g, '#14101f', x - 15, y - 1 + k, 7, 2); scrRect(g, '#14101f', x - 15, y + 1 - k, 7, 2);
  scrRect(g, '#ffcc00', x - 9, y - 3, 14, 6); scrRect(g, '#8f95ad', x - 7, y - 6, 9, 3);
  scrDisc(g, '#ffc9a0', x + 7, y - 1, 4); scrRect(g, '#8fe8ff', x + 7, y - 3, 4, 4); scrRect(g, '#8f95ad', x + 5, y + 2, 12, 2);
}
function diveDemo(g, u, A) {
  g.drawImage(A.bg, 0, 0);
  g.globalCompositeOperation = 'lighter';
  for (let i = 0; i < 4; i++) {                                                                    // swaying light shafts
    const x0 = 30 + i * 62 + Math.sin(u * 0.4 + i) * 10;
    g.fillStyle = 'rgba(190,255,255,0.09)'; g.beginPath(); g.moveTo(x0, 0); g.lineTo(x0 + 26, 0); g.lineTo(x0 + 56, 170); g.lineTo(x0 + 20, 170); g.closePath(); g.fill();
  }
  g.globalCompositeOperation = 'source-over';
  for (let s = 0; s < 6; s++) for (let seg = 0; seg < 6; seg++) scrRect(g, '#1ea060', 20 + s * 40 + Math.sin(u * 2 + seg * 0.5 + s) * seg * 0.7, 164 - seg * 4, 3, 4);
  for (let j = 0; j < 3; j++) for (let i = 0; i < 5; i++) {                                        // three fish schools
    const dir = j & 1 ? 1 : -1, x = ((((scrHash(j * 9) * 256 + dir * (24 + j * 9) * u + i * 15 * dir) % 300) + 300) % 300) - 22;
    diveFish(g, x, 38 + j * 30 + Math.sin(u * 2 + i) * 4 + i * 2, dir, ['#ffb000', '#ff5a8a', '#39ff88'][j]);
  }
  for (let j = 0; j < 2; j++) {                                                                    // jellyfish
    const x = 70 + j * 110 + Math.sin(u * 0.3 + j * 2) * 20, y = 50 + j * 30 + Math.sin(u * 1.5 + j) * 8, pl = Math.sin(u * 3 + j) * 1.5;
    g.fillStyle = 'rgba(255,120,220,0.75)'; g.beginPath(); g.arc(x, y, 8 + pl * 0.4, Math.PI, 0); g.fill();
    g.strokeStyle = 'rgba(255,160,230,0.7)'; g.lineWidth = 1; g.beginPath();
    for (let t = -2; t <= 2; t++) { g.moveTo(x + t * 3, y); g.lineTo(x + t * 3 + Math.sin(u * 3 + t) * 2, y + 12 + pl); }
    g.stroke();
  }
  const sx = diveShark(u), sy = 76 + Math.sin(u * 1.2) * 16, dead = u > 7.8;
  const cruise = 90 + Math.sin(u * 0.9) * 22, chase = scrEase((u - 4) / 1.5);          // the diver cruises, locks on the shark, then swims to the chest
  const dx = u < 9.5 ? 46 + Math.sin(u * 0.6) * 6 : scrLerp(50, 190, scrEase((u - 9.5) / 2.6));
  const dyy = u < 9.5 ? scrLerp(cruise, sy, chase) : scrLerp(sy, 148, scrEase((u - 9.5) / 2.6));
  if (u > 4 && !(dead && u > 9.2)) {                                                               // the shark
    const flip = dead ? scrEase((u - 7.8) / 0.6) : 0, y = dead ? sy - (u - 7.8) * 14 : sy;
    g.save(); g.translate(Math.round(sx), Math.round(y)); if (flip) g.scale(1, 1 - 2 * flip);
    g.fillStyle = dead ? '#5a6a80' : '#7f8fa8'; g.beginPath(); g.moveTo(-42, 0); g.quadraticCurveTo(-10, -16, 26, -4); g.lineTo(46, -18);
    g.lineTo(40, 0); g.lineTo(46, 14); g.lineTo(26, 4); g.quadraticCurveTo(-10, 14, -42, 0); g.fill();
    g.fillStyle = '#c8d4e0'; g.beginPath(); g.moveTo(-40, 2); g.quadraticCurveTo(-10, 12, 24, 4); g.lineTo(-10, 4); g.fill();
    g.fillStyle = '#7f8fa8'; g.beginPath(); g.moveTo(-6, -12); g.lineTo(6, -26); g.lineTo(12, -8); g.fill();
    scrRect(g, '#14101f', -32, -4, 3, 3); scrRect(g, '#ffffff', -38, 2, 12, 1);
    g.restore();
    if (dead && u < 9.2) scrText(g, '+1000', sx, sy - 30, '#ffe600', 1, 1);
  }
  for (let i = 0; i < DIVE_HITS.length; i++) {                                                     // harpoons and their impacts
    const th = DIVE_HITS[i], hx = diveShark(th) - 34, hy = 76 + Math.sin(th * 1.2) * 16, p = (u - (th - 0.35)) / 0.35;
    if (p >= 0 && p <= 1) { const px = scrLerp(dx + 17, hx, p), py = scrLerp(dyy + 2, hy, p); scrRect(g, '#ffffff', px - 5, py, 10, 2); scrRect(g, '#ffe600', px + 5, py, 3, 2); }
    scrBoom(g, hx, hy, u - th, 14, '#ff2a3a', '#ffffff', i);
  }
  diveDiver(g, dx, dyy, u);
  for (let i = 0; i < 4; i++) { const age = (u * 1.2 + i * 0.25) % 1; scrRect(g, 'rgba(230,255,255,0.8)', dx + 11 + Math.sin(age * 6 + i) * 3, dyy - 6 - age * 30, 2, 2); }
  for (let i = 0; i < 14; i++) {                                                                   // rising bubbles
    const x = scrHash(i * 3) * SCR_W + Math.sin(u * 1.5 + i) * 4, y = 190 - ((scrHash(i * 3 + 1) * 190 + u * (14 + scrHash(i * 3 + 2) * 16)) % 190), r = 2 + (i % 3);
    scrRect(g, 'rgba(220,255,255,0.65)', x, y, r, r);
  }
  if (u > 12.3) {                                                                                  // treasure chest opens
    scrRect(g, '#ffd23f', 208, 161, 18, 4); scrSparkle(g, 216 + Math.sin(u * 20) * 8, 156 - ((u * 20) % 6), 2, '#ffffff');
    if (u - 12.3 < 1.6) scrText(g, '+500', 216, 142 - (u - 12.3) * 8, '#ffe600', 1, 1);
  }
  scrRect(g, 'rgba(0,20,40,0.6)', 0, 0, SCR_W, 11);
  scrText(g, 'SCORE', 6, 2, '#ffe600'); scrNum(g, 1500 + (u > 7.8 ? 1000 : 0) + (u > 12.3 ? 500 : 0) + Math.floor(u * 10) * 10, 6, 54, 2, '#ffffff');
  scrText(g, 'DEPTH', 150, 2, '#ffe600'); scrNum(g, 120 + u * 6, 4, 190, 2, '#ffffff'); scrText(g, 'M', 222, 2, '#ffffff');
  scrText(g, 'AIR', 6, 172, '#ffffff'); scrRect(g, '#02141a', 32, 172, 84, 7); scrRect(g, u > 11 ? '#ff2a3a' : '#39ff88', 33, 173, Math.max(2, 82 - u * 4), 5);
  scrText(g, 'SPEARS X5', 250, 172, '#ffffff', 1, 2);
}

// ───────── BRICK BUSTER: breakout; the ball's whole path is simulated once, then replayed ─────────
const BRICK_COLS = 12, BRICK_ROWS = 6, BRICK_W = 18, BRICK_H = 8, BRICK_X0 = 20, BRICK_Y0 = 28, BRICK_PADDLE_Y = 168;
const BRICK_COLORS = ['#ff2a2a', '#ff8a1f', '#ffe600', '#39ff88', '#00e5ff', '#9b5cff'];
const BRICK_HZ = 60, BRICK_STEPS = 60 * 15 + 10;
// Simulates ball and paddle at 60 Hz. Returns { bx, by, px (paddle centre per step), hit (time each brick breaks, 1e9 = never) }.
function brickSimulate() {
  const bx = new Float32Array(BRICK_STEPS), by = new Float32Array(BRICK_STEPS), px = new Float32Array(BRICK_STEPS);
  const hit = new Float32Array(BRICK_COLS * BRICK_ROWS).fill(1e9), dt = 1 / BRICK_HZ;
  let x = 128, y = 150, vx = 96, vy = -170;
  for (let k = 0; k < BRICK_STEPS; k++) {
    bx[k] = x; by[k] = y; px[k] = scrClamp(x + Math.sin(k * 0.04) * 9, 28, 228);
    const ox = x;
    x += vx * dt; y += vy * dt;
    if (x < 14) { x = 14; vx = Math.abs(vx); } else if (x > 242) { x = 242; vx = -Math.abs(vx); }
    if (y < 16) { y = 16; vy = Math.abs(vy); }
    if (vy > 0 && y >= BRICK_PADDLE_Y - 3) {                         // paddle return: the angle depends on where the ball lands on it
      const off = (scrHash(k) - 0.5) * 1.2, sp = 200;
      vx = scrClamp(vx * 0.5 + off * 130, -125, 125) || 60; vy = -Math.sqrt(sp * sp - vx * vx); y = BRICK_PADDLE_Y - 3;
    }
    const c = Math.floor((x - BRICK_X0) / BRICK_W), r = Math.floor((y - BRICK_Y0) / BRICK_H);
    if (c >= 0 && c < BRICK_COLS && r >= 0 && r < BRICK_ROWS && hit[r * BRICK_COLS + c] > 1e8) {
      hit[r * BRICK_COLS + c] = k * dt;
      if (Math.floor((ox - BRICK_X0) / BRICK_W) !== c) vx = -vx; else vy = -vy;
    }
  }
  return { bx, by, px, hit };
}
function brickInit(A) {
  A.sim = A.sim || brickSimulate();
  A.bg = scrLayer((g) => {
    const gr = g.createLinearGradient(0, 0, 0, SCR_H); gr.addColorStop(0, '#2a0a1a'); gr.addColorStop(1, '#0a0208'); g.fillStyle = gr; g.fillRect(0, 0, SCR_W, SCR_H);
    g.fillStyle = 'rgba(255,61,127,0.07)';
    for (let x = -SCR_H; x < SCR_W; x += 20) { g.beginPath(); g.moveTo(x, SCR_H); g.lineTo(x + 8, SCR_H); g.lineTo(x + 8 + SCR_H, 0); g.lineTo(x + SCR_H, 0); g.fill(); }
    scrRect(g, '#8f95ad', 0, 12, SCR_W, 4); scrRect(g, '#8f95ad', 10, 12, 4, 170); scrRect(g, '#8f95ad', 242, 12, 4, 170);
    scrRect(g, '#ff3d7f', 0, 12, SCR_W, 1); scrRect(g, '#ff3d7f', 10, 12, 1, 170); scrRect(g, '#ff3d7f', 245, 12, 1, 170);
  });
}
function brickDemo(g, u, A) {
  const S = A.sim, k = Math.min(BRICK_STEPS - 1, Math.floor(u * BRICK_HZ));
  g.drawImage(A.bg, 0, 0);
  let broken = 0;
  for (let r = 0; r < BRICK_ROWS; r++) {
    for (let c = 0; c < BRICK_COLS; c++) {
      const ht = S.hit[r * BRICK_COLS + c], x = BRICK_X0 + c * BRICK_W, y = BRICK_Y0 + r * BRICK_H;
      if (ht <= u) {
        broken++;
        const age = u - ht;
        if (age < 0.35) {                                            // shattering brick: fragments fall
          g.globalAlpha = 1 - age / 0.35;
          for (let f = 0; f < 4; f++) scrRect(g, BRICK_COLORS[r], x + f * 4 + scrHash(r * 12 + c + f) * 3, y + age * (60 + f * 20) - 2, 4, 3);
          g.globalAlpha = 1;
        }
        continue;
      }
      scrRect(g, BRICK_COLORS[r], x, y, BRICK_W - 1, BRICK_H - 1); scrRect(g, 'rgba(255,255,255,0.45)', x, y, BRICK_W - 1, 1); scrRect(g, 'rgba(0,0,0,0.35)', x, y + BRICK_H - 2, BRICK_W - 1, 1);
    }
  }
  for (let i = 5; i >= 1; i--) { g.globalAlpha = 0.5 - i * 0.08; const j = Math.max(0, k - i * 2); scrRect(g, '#ffffff', S.bx[j] - 2, S.by[j] - 2, 4, 4); }
  g.globalAlpha = 1;
  scrRect(g, '#ffffff', S.bx[k] - 2, S.by[k] - 2, 5, 5);
  const p = S.px[k];
  scrRect(g, '#c8ccdc', p - 14, BRICK_PADDLE_Y, 28, 5); scrRect(g, '#ff3d7f', p - 16, BRICK_PADDLE_Y, 4, 5);
  scrRect(g, '#ff3d7f', p + 12, BRICK_PADDLE_Y, 4, 5); scrRect(g, '#ffffff', p - 12, BRICK_PADDLE_Y, 24, 1);
  scrHud(g, u, broken * 70, 20000, '#ff5a5a');
  scrText(g, 'LV 03', 250, 2, '#ffe600', 1, 2);
  for (let i = 0; i < 3; i++) scrRect(g, '#c8ccdc', 16 + i * 14, 176, 10, 3);
}

// ───────── JUMP QUEST: run-and-jump platformer over pits, pipes and blobs; coins and a parallax world ─────────
const JUMP_V = 72, JUMP_HERO_X = 72, JUMP_GROUND = 148;
const JUMP_OBJ = [                                                   // world objects: blobs to stomp, pits and pipes to clear
  { x: 190, t: 0 }, { x: 320, t: 1, w: 36 }, { x: 450, t: 2, h: 22 }, { x: 580, t: 0 }, { x: 710, t: 1, w: 40 }, { x: 840, t: 0 }, { x: 960, t: 2, h: 30 }, { x: 1090, t: 0 },
];
const JUMP_COINS_PER_OBJ = 4, JUMP_QBLOCKS = [268, 292, 316, 690, 714, 738, 1010];
const jumpBlobX = (o, u) => o.x - 14 * u;                            // blobs shuffle toward the hero
function jumpInit(A) {
  A.sky = scrLayer((g) => {
    const gr = g.createLinearGradient(0, 0, 0, JUMP_GROUND); gr.addColorStop(0, '#3a8fff'); gr.addColorStop(1, '#bfe9ff'); g.fillStyle = gr; g.fillRect(0, 0, SCR_W, SCR_H);
  });
  A.clouds = scrLayer((g) => {                                       // periodic in x so it can scroll forever
    for (const c of [[30, 26, 1], [140, 46, 0.8], [210, 20, 1.1]]) {
      g.fillStyle = '#ffffff';
      for (const b of [[0, 0, 12], [14, 4, 10], [-14, 4, 10], [26, 8, 7], [-26, 8, 7]]) { g.beginPath(); g.arc(c[0] + b[0] * c[2], c[1] + b[1] * c[2], b[2] * c[2], 0, 6.2832); g.fill(); }
      scrRect(g, '#e4f4ff', c[0] - 30 * c[2], c[1] + 8 * c[2], 60 * c[2], 5 * c[2]);
    }
  });
  A.hills = scrLayer((g) => {
    for (let layer = 0; layer < 2; layer++) {
      g.fillStyle = layer ? '#2a8a3a' : '#4ab05a'; g.beginPath(); g.moveTo(0, SCR_H);
      for (let x = 0; x <= SCR_W; x += 4) g.lineTo(x, JUMP_GROUND - 18 - layer * 10 - Math.sin((x / SCR_W) * 6.2832 * (layer ? 3 : 2) + layer) * 14 - 8);
      g.lineTo(SCR_W, SCR_H); g.fill();
    }
  });
  A.ground = scrLayer((g) => {                                       // 16 px tile strip, periodic
    scrRect(g, '#7a4a1a', 0, JUMP_GROUND, SCR_W, 44); scrRect(g, '#3aa04a', 0, JUMP_GROUND, SCR_W, 5); scrRect(g, '#5aff6a', 0, JUMP_GROUND, SCR_W, 1);
    g.fillStyle = '#5a3210';
    for (let y = JUMP_GROUND + 8; y < SCR_H; y += 8) g.fillRect(0, y, SCR_W, 1);
    for (let y = JUMP_GROUND + 8, r = 0; y < SCR_H; y += 8, r++) for (let x = (r & 1) * 8; x < SCR_W; x += 16) g.fillRect(x, y, 1, 8);
  });
}
// Hero with feet at (x, y), unit k px: red cap, blue overalls; frame animates the run, air = legs tucked.
function jumpHero(g, x, y, k, frame, air) {
  const sw = air ? 0 : Math.round(Math.sin(frame) * 2);
  scrRectU(g, k, x, y, '#6a3a1a', -5 + sw, -3, 5, 3); scrRectU(g, k, x, y, '#6a3a1a', 1 - sw + (air ? 3 : 0), -3 - (air ? 2 : 0), 5, 3);
  scrRectU(g, k, x, y, '#2f6bff', -4 + sw, -8, 3, 5); scrRectU(g, k, x, y, '#2f6bff', 1 - sw + (air ? 3 : 0), -8 - (air ? 2 : 0), 3, 5);
  scrRectU(g, k, x, y, '#ff3b3b', -5, -14, 10, 7); scrRectU(g, k, x, y, '#2f6bff', -4, -11, 8, 5); scrRectU(g, k, x, y, '#ffe600', -3, -11, 1, 1); scrRectU(g, k, x, y, '#ffe600', 2, -11, 1, 1);
  scrRectU(g, k, x, y, '#ffc9a0', air ? 4 : -7, air ? -18 : -12, 3, 4); scrRectU(g, k, x, y, '#ffc9a0', -4, -20, 8, 7);
  scrRectU(g, k, x, y, '#ff3b3b', -5, -23, 9, 4); scrRectU(g, k, x, y, '#ff3b3b', 1, -20, 7, 2); scrRectU(g, k, x, y, '#14101f', 2, -18, 1, 2); scrRectU(g, k, x, y, '#5a3210', 1, -15, 4, 1);
}
function jumpDemo(g, u, A) {
  const wx = JUMP_HERO_X + JUMP_V * u, scroll = JUMP_V * u;          // hero's world x and the world x at the screen's left edge
  g.drawImage(A.sky, 0, 0);
  const cs = Math.round((scroll * 0.12) % SCR_W), hs = Math.round((scroll * 0.3) % SCR_W);
  g.drawImage(A.clouds, -cs, 0); g.drawImage(A.clouds, SCR_W - cs, 0);
  g.drawImage(A.hills, -hs, 0); g.drawImage(A.hills, SCR_W - hs, 0);
  const gs = Math.round(scroll % SCR_W);
  g.drawImage(A.ground, -gs, 0); g.drawImage(A.ground, SCR_W - gs, 0);
  let hop = 0, coins = 0, stomped = 0;
  for (let i = 0; i < JUMP_OBJ.length; i++) {
    const o = JUMP_OBJ[i], ox = o.t === 0 ? jumpBlobX(o, u) : o.x, sx = ox - scroll, d = wx - ox;
    const reach = o.t === 0 ? 30 : o.t === 1 ? o.w / 2 + 18 : 34, apex = o.t === 2 ? o.h + 22 : 32;
    if (Math.abs(d) < reach) hop = Math.max(hop, apex * (1 - (d * d) / (reach * reach)));
    for (let c = 0; c < JUMP_COINS_PER_OBJ; c++) {                   // a small arc of coins above every obstacle
      const cx = ox - 24 + c * 16 - scroll, cwx = ox - 24 + c * 16, cy = JUMP_GROUND - 46 - Math.sin((c / 3) * Math.PI) * 14 - (o.t === 2 ? o.h * 0.4 : 0);
      if (cwx < wx) { coins++; continue; }
      if (cx > SCR_W || cx < -8) continue;
      const w = 1 + Math.abs(Math.cos(u * 8 + c)) * 5;
      scrRect(g, '#ffd23f', cx - w / 2, cy - 4, w, 8); scrRect(g, '#a07800', cx - w / 2, cy - 4, w, 1);
    }
    if (sx < -60 || sx > SCR_W + 60) continue;
    if (o.t === 1) scrRect(g, '#0a0a20', sx - o.w / 2, JUMP_GROUND, o.w, 44);                                          // pit
    else if (o.t === 2) { scrRect(g, '#1ea03a', sx - 12, JUMP_GROUND - o.h, 24, o.h); scrRect(g, '#39ff64', sx - 14, JUMP_GROUND - o.h, 28, 6);
    scrRect(g, '#0f6a2a', sx + 6, JUMP_GROUND - o.h + 6, 4, o.h - 6); scrRect(g, '#7aff9a', sx - 10, JUMP_GROUND - o.h + 6, 2, o.h - 6); }
    else if (d < 0) {                                                                                                  // blob shuffling
      const b = ((u * 6) | 0) & 1;
      g.fillStyle = '#8a4a1a'; g.beginPath(); g.arc(sx, JUMP_GROUND - 4, 8, Math.PI, 0); g.fill(); scrRect(g, '#8a4a1a', sx - 8, JUMP_GROUND - 5, 16, 3);
      scrRect(g, '#ffffff', sx - 5, JUMP_GROUND - 9, 3, 3); scrRect(g, '#ffffff', sx + 2, JUMP_GROUND - 9, 3, 3);
      scrRect(g, '#14101f', sx - 4, JUMP_GROUND - 8, 1, 2); scrRect(g, '#14101f', sx + 3, JUMP_GROUND - 8, 1, 2);
      scrRect(g, '#14101f', sx - 8 + b * 2, JUMP_GROUND - 2, 6, 2); scrRect(g, '#14101f', sx + 2 - b * 2, JUMP_GROUND - 2, 6, 2);
    } else {
      stomped++;
      if (d < 60) { scrRect(g, '#8a4a1a', sx - 8, JUMP_GROUND - 3, 16, 3); scrText(g, '100', sx, JUMP_GROUND - 20 - Math.min(14, d * 0.4), '#ffffff', 1, 1); }
    }
  }
  for (let b = 0; b < JUMP_QBLOCKS.length; b++) {                                                                     // "?" blocks overhead
    const q = JUMP_QBLOCKS[b] - scroll;
    if (q > -16 && q < SCR_W) { scrRect(g, '#ffb000', q, 72, 16, 16); scrRect(g, '#a06800', q + 15, 72, 1, 16); scrRect(g, '#ffe680', q, 72, 16, 1); scrText(g, '?', q + 8, 76, '#a06800', 1, 1); }
  }
  const air = hop > 1;
  scrRect(g, 'rgba(0,0,0,0.25)', JUMP_HERO_X - 6, JUMP_GROUND - 1, 12 - hop * 0.1, 2);
  jumpHero(g, JUMP_HERO_X, JUMP_GROUND - hop, 1, u * 14, air);
  scrRect(g, 'rgba(10,20,60,0.5)', 0, 0, SCR_W, 20);
  scrText(g, 'HERO', 6, 2, '#ffffff'); scrNum(g, coins * 50 + stomped * 100, 6, 6, 11, '#ffffff');
  scrRect(g, '#ffd23f', 76, 12, 5, 7); scrText(g, 'X', 84, 11, '#ffffff'); scrNum(g, coins, 2, 92, 11, '#ffffff');
  scrText(g, 'WORLD', 130, 2, '#ffffff'); scrText(g, '1-1', 130 + 4, 11, '#ffffff'); scrText(g, 'TIME', 250, 2, '#ffffff', 1, 2); scrNum(g, Math.max(0, 300 - u * 2), 3, 226, 11, '#ffffff');
}

// ── 8b. More mascots (drawn once into static art, so the small closures below are fine) ──
function mascotDragon(g, cx, cy, h) {
  const k = h / 40;
  dragonBeast(g, cx - 9.5 * k, cy - 7 * k, k, 1, '#1e9a55', '#c8e050');
}
function mascotKart(g, cx, cy, h) {                                  // go-kart, side view, flames out the back
  const k = h / 16, R = scrUnit(g, cx, cy, k);
  R('#ff2a3a', -12, -1, 26, 6); R('#ff2a3a', 12, 1, 6, 4); R('#ffffff', 13, 2, 3, 1); R('#c81828', -14, -8, 3, 8); R('#ff5a4a', -13, -8, 8, 2);
  scrDisc(g, '#ffe600', cx - 3 * k, cy - 5 * k, 4 * k); R('#14101f', -2, -7, 4, 3); R('#8f95ad', 3, -3, 1.5, 4);
  scrDisc(g, '#111111', cx - 8 * k, cy + 5 * k, 5 * k); scrDisc(g, '#111111', cx + 10 * k, cy + 6 * k, 3.6 * k);
  scrDisc(g, '#c8ccdc', cx - 8 * k, cy + 5 * k, 2 * k); scrDisc(g, '#c8ccdc', cx + 10 * k, cy + 6 * k, 1.4 * k);
  R('#ff9a1f', -19, 1, 5, 2); R('#ffe600', -21, 1.5, 3, 1);
}
function mascotBlocks(g, cx, cy, h) {                                // a T and an L tetromino
  const s = h / 4, cells = [[0, 0, 2], [1, 0, 2], [2, 0, 2], [1, -1, 2], [-2, 1, 6], [-2, 2, 6], [-1, 2, 6], [0, 2, 6]];
  const shift = [[0, 0], [0, 0], [0, 0], [0, 0], [1.6, -1], [1.6, -1], [1.6, -1], [1.6, -1]];
  for (let i = 0; i < cells.length; i++) {
    const c = BLK_COLORS[cells[i][2]], x = cx + (cells[i][0] + shift[i][0]) * s + s * 0.5 - s * 1.2, y = cy + (cells[i][1] + shift[i][1]) * s - s * 0.5 + s * 0.3;
    scrRect(g, c[0], x, y, s, s); scrRect(g, c[1], x, y, s, s * 0.14); scrRect(g, c[1], x, y, s * 0.14, s);
    scrRect(g, c[2], x, y + s * 0.86, s, s * 0.14); scrRect(g, c[2], x + s * 0.86, y, s * 0.14, s);
  }
}
function mascotPong(g, cx, cy, h) {
  const k = h / 16, R = scrUnit(g, cx, cy, k);
  R('#00e5ff', -14, -7, 3, 14); R('#ff2bd6', 11, -5, 3, 14);
  for (let i = 1; i <= 5; i++) { g.globalAlpha = 0.5 - i * 0.08; R('#ffffff', 1 - i * 2, 1 - i * 0.6, 4, 4); }
  g.globalAlpha = 1; R('#ffffff', 2, 0, 5, 5);
}
function mascotSnake(g, cx, cy, h) {                                 // S-curved snake with a forked tongue
  const k = h / 16;
  g.lineJoin = 'round'; g.lineCap = 'butt';
  const curve = () => {
    g.beginPath(); g.moveTo(cx - 9 * k, cy + 7 * k); g.bezierCurveTo(cx + 12 * k, cy + 8 * k, cx + 12 * k, cy, cx, cy);
    g.bezierCurveTo(cx - 12 * k, cy - 1 * k, cx - 12 * k, cy - 8 * k, cx + 5 * k, cy - 7 * k);
  };
  curve(); g.strokeStyle = '#14101f'; g.lineWidth = 6.5 * k; g.stroke();
  const gr = g.createLinearGradient(cx - 10 * k, 0, cx + 10 * k, 0); gr.addColorStop(0, '#a82a60'); gr.addColorStop(1, '#ff7aa8');
  curve(); g.strokeStyle = gr; g.lineWidth = 5 * k; g.stroke();
  g.strokeStyle = 'rgba(255,255,255,0.35)'; g.lineWidth = 1.2 * k; curve(); g.stroke();
  const hx = cx + 5 * k, hy = cy - 7 * k;
  scrRect(g, '#ffd0e0', hx, hy - 3.5 * k, 6 * k, 7 * k); scrRect(g, '#ffffff', hx + 2 * k, hy - 3 * k, 2 * k, 2 * k); scrRect(g, '#ffffff', hx + 2 * k, hy + 1 * k, 2 * k, 2 * k);
  scrRect(g, '#14101f', hx + 3 * k, hy - 2.5 * k, 1 * k, 1 * k); scrRect(g, '#14101f', hx + 3 * k, hy + 1.5 * k, 1 * k, 1 * k);
  scrRect(g, '#ff2a3a', hx + 6 * k, hy - 0.3 * k, 4 * k, 0.8 * k); scrRect(g, '#ff2a3a', hx + 9 * k, hy - 1.3 * k, 1.5 * k, 0.8 * k); scrRect(g, '#ff2a3a', hx + 9 * k, hy + 0.7 * k, 1.5 * k, 0.8 * k);
}
function mascotZombie(g, cx, cy, h) {
  const k = h / 20, R = scrUnit(g, cx, cy, k);
  R('#5a3a6a', -5, 1, 10, 8); R('#3a2a4a', -5, 5, 10, 1); R('#3a3a5a', -5, 9, 4, 8); R('#3a3a5a', 1, 9, 4, 8); R('#14101f', -6, 16, 5, 2); R('#14101f', 1, 16, 5, 2);
  R('#5acb7a', -12, 1, 7, 3); R('#5acb7a', 5, 1, 7, 3); R('#5acb7a', -13, 0, 3, 5); R('#5acb7a', 10, 0, 3, 5);
  R('#5acb7a', -5, -9, 10, 10); R('#2a8a4a', -5, -9, 10, 2); R('#ffffff', -4, -5, 3, 3); R('#ffffff', 1, -5, 3, 3); R('#ff2a3a', -3, -4, 1.5, 1.5); R('#ff2a3a', 2, -4, 1.5, 1.5);
  R('#14101f', -3, -1, 6, 2); R('#ffffff', -2, -1, 1, 1); R('#ffffff', 1, -1, 1, 1);
}
function mascotFist(g, cx, cy, h) {                                  // big fist and an impact burst
  const k = h / 16;
  g.fillStyle = '#ffe600'; g.beginPath();
  for (let i = 0; i < 20; i++) { const rr = (i & 1 ? 8 : 14) * k, a = (i / 20) * 6.2832; g.lineTo(cx + Math.cos(a) * rr, cy + Math.sin(a) * rr * 0.9); }
  g.closePath(); g.fill();
  const R = scrUnit(g, cx, cy, k);
  R('#ff9a5a', -6, -5, 12, 9); for (let i = 0; i < 4; i++) { R('#ffb080', -6 + i * 3, -7, 2.6, 4); R('#c8602a', -6 + i * 3, -3, 2.6, 0.6); }
  R('#ffb080', -8, -1, 3, 5); R('#ffffff', -6, 4, 12, 4); R('#c81828', -6, 6, 12, 2);
}
function mascotBall(g, cx, cy, h) {
  const r = h / 2;
  scrDisc(g, '#ff8a1f', cx, cy, r); scrDisc(g, '#ffb060', cx - r * 0.3, cy - r * 0.3, r * 0.45);
  g.strokeStyle = '#4a1a00'; g.lineWidth = Math.max(1, r * 0.09);
  g.beginPath(); g.moveTo(cx - r, cy); g.lineTo(cx + r, cy); g.moveTo(cx, cy - r); g.lineTo(cx, cy + r); g.stroke();          // the seams
  g.beginPath(); g.arc(cx - r * 1.1, cy, r * 0.95, -0.95, 0.95); g.stroke();
  g.beginPath(); g.arc(cx + r * 1.1, cy, r * 0.95, Math.PI - 0.95, Math.PI + 0.95); g.stroke();
}
function mascotFrog(g, cx, cy, h) {
  const k = h / 16, R = scrUnit(g, cx, cy, k);
  R('#1e9a3a', -9, 4, 5, 5); R('#1e9a3a', 4, 4, 5, 5); R('#39ff64', -8, 8, 6, 2); R('#39ff64', 2, 8, 6, 2);
  R('#39ff64', -6, -3, 12, 10); R('#c8ff8a', -4, 2, 8, 5); R('#1e9a3a', -6, -3, 12, 2);
  R('#39ff64', -7, -8, 5, 6); R('#39ff64', 2, -8, 5, 6); R('#ffffff', -6, -8, 4, 4); R('#ffffff', 2, -8, 4, 4); R('#14101f', -5, -7, 2, 2); R('#14101f', 3, -7, 2, 2);
  R('#14101f', -3, 0, 6, 1);
}
function mascotFish(g, cx, cy, h) {                                  // reef fish and bubbles
  const k = h / 16, R = scrUnit(g, cx, cy, k);
  g.fillStyle = '#ff5a1f'; g.beginPath(); g.moveTo(cx + 8 * k, cy); g.lineTo(cx + 17 * k, cy - 8 * k); g.lineTo(cx + 15 * k, cy); g.lineTo(cx + 17 * k, cy + 8 * k); g.closePath(); g.fill();
  g.beginPath(); g.moveTo(cx - 4 * k, cy - 6 * k); g.lineTo(cx + 2 * k, cy - 12 * k); g.lineTo(cx + 8 * k, cy - 5 * k); g.closePath(); g.fill();
  g.fillStyle = '#ffb000'; g.beginPath(); g.ellipse(cx, cy, 13 * k, 8 * k, 0, 0, 6.2832); g.fill();
  g.fillStyle = '#ffe680'; g.beginPath(); g.ellipse(cx - 1 * k, cy + 3 * k, 10 * k, 4 * k, 0, 0, Math.PI); g.fill();
  R('#ffffff', 2, -6, 2, 12); R('#ffffff', -5, -5, 1.6, 10);
  R('#ffffff', -10, -3.5, 4.5, 4.5); R('#14101f', -8.5, -2.5, 2.5, 2.5); R('#ff5a1f', -13, 1.5, 3, 0.8);
  for (let i = 0; i < 3; i++) scrDisc(g, '#bff8ff', cx - (11 + i * 2.5) * k, cy - (8 + i * 4) * k, (1.6 + i * 0.4) * k);
}
function mascotBrick(g, cx, cy, h) {                                 // wall, ball and paddle
  const k = h / 16, R = scrUnit(g, cx, cy, k);
  for (let i = 0; i < 3; i++) { R(BRICK_COLORS[i], -13 + i * 9, -8, 8, 3.5); R('#ffffff', -13 + i * 9, -8, 8, 0.7); }
  for (let i = 0; i < 2; i++) { R(BRICK_COLORS[3 + i], -9 + i * 9, -4, 8, 3.5); R('#ffffff', -9 + i * 9, -4, 8, 0.7); }
  scrDisc(g, '#ffffff', cx + 2 * k, cy + 3 * k, 2 * k); R('#c8ccdc', -7, 8, 14, 2.5); R('#ff3d7f', -8, 8, 2, 2.5); R('#ff3d7f', 6, 8, 2, 2.5);
  R('#ffffff', 2, 5, 0.6, 2); R('#ffffff', 1.5, 6, 0.6, 2);
}
function mascotHero(g, cx, cy, h) {
  const k = h / 24;
  jumpHero(g, cx, cy + 12 * k, k, 0, true);
}

// ── 8. Mascots: sprite key or drawing function(g, cx, cy, h) that draws a character about h px tall ──
// Used on the title screen, marquee and side decal. (Sprite keys are tinted with the game's main colour.)
function scrMascot(g, def, cx, cy, h) {
  g.save();
  g.shadowColor = '#000000'; g.shadowBlur = 0; g.shadowOffsetX = Math.max(1, h / 24); g.shadowOffsetY = Math.max(1, h / 24);   // hard retro drop shadow
  if (typeof def.mascot === 'function') def.mascot(g, cx, cy, h);
  else {
    const sp = scrSprite(def.mascot, def.pal[0]);
    scrBlitC(g, sp, cx, cy, Math.max(1, Math.round(h / sp.h)));
  }
  g.restore();
}
// Draws the mascot centred at (cx, cy), as large as fits in maxW x maxH (wide mascots shrink, tall ones don't overflow).
function scrMascotBox(g, def, cx, cy, maxW, maxH) {
  const ratio = typeof def.mascot === 'function' ? def.mrat || 1 : SPRITES[def.mascot][0].length / SPRITES[def.mascot].length;
  scrMascot(g, def, cx, cy, Math.min(maxH, maxW / ratio));
}
function mascotCar(g, cx, cy, h) {                                  // sports car, side view
  const k = h / 16, R = scrUnit(g, cx, cy, k);
  R('#ff2a3a', -16, -1, 32, 6); R('#ff5a4a', -9, -6.5, 16, 5.5); R('#8fe8ff', -7.5, -5.5, 6, 3.8); R('#8fe8ff', 0, -5.5, 6, 3.8);
  R('#b81424', -16, 3, 32, 2.5); R('#ffe600', 14, -0.5, 3, 2); R('#ff9a1f', -17, 0, 2, 2.5);
  scrDisc(g, '#111111', cx - 9 * k, cy + 5.5 * k, 3.6 * k); scrDisc(g, '#111111', cx + 9 * k, cy + 5.5 * k, 3.6 * k);
  scrDisc(g, '#c8ccdc', cx - 9 * k, cy + 5.5 * k, 1.5 * k); scrDisc(g, '#c8ccdc', cx + 9 * k, cy + 5.5 * k, 1.5 * k);
}
function mascotPac(g, cx, cy, h) {                                  // hero chasing a ghost
  const k = h / 16;
  g.fillStyle = '#ffe600'; g.beginPath(); g.moveTo(cx - 7 * k, cy); g.arc(cx - 7 * k, cy, 7.5 * k, 0.55, 6.2832 - 0.55); g.closePath(); g.fill();
  scrRect(g, '#000000', cx - 6 * k, cy - 5 * k, 1.6 * k, 1.6 * k);
  const gx = cx + 8 * k, gy = cy;
  g.fillStyle = '#ff2a2a'; g.beginPath(); g.arc(gx, gy - 0.5 * k, 6.5 * k, Math.PI, 0);
  g.lineTo(gx + 6.5 * k, gy + 7 * k);
  for (let i = 0; i < 3; i++) { g.lineTo(gx + (4.3 - i * 4.3) * k, gy + 4.5 * k); g.lineTo(gx + (2.2 - i * 4.3) * k, gy + 7 * k); }
  g.closePath(); g.fill();
  scrRect(g, '#ffffff', gx - 4.5 * k, gy - 3 * k, 3.5 * k, 4.5 * k); scrRect(g, '#ffffff', gx + 1 * k, gy - 3 * k, 3.5 * k, 4.5 * k);
  scrRect(g, '#1a3cff', gx - 3 * k, gy - 1.5 * k, 2 * k, 2.5 * k); scrRect(g, '#1a3cff', gx + 2.5 * k, gy - 1.5 * k, 2 * k, 2.5 * k);
}

// ── 9. Backdrops and lettering (shared by title screens, marquees and side decals) ──
// Paints a w x h backdrop in one of the named styles using the game palette [main, accent, dark, background].
function scrBackdrop(g, w, h, style, pal) {
  const a = pal[0], b = pal[1], c = pal[2], bg = pal[3];
  const grad = (y0, y1, stops) => {
    const gr = g.createLinearGradient(0, y0, 0, y1);
    for (let i = 0; i < stops.length; i += 2) gr.addColorStop(stops[i], stops[i + 1]);
    return gr;
  };
  g.save();
  g.fillStyle = bg; g.fillRect(0, 0, w, h);
  switch (style) {
    case 'stars': {
      g.fillStyle = grad(0, h, [0, bg, 1, c]); g.fillRect(0, 0, w, h);
      const nb = g.createRadialGradient(w * 0.3, h * 0.35, 0, w * 0.3, h * 0.35, w * 0.55);
      nb.addColorStop(0, a + '55'); nb.addColorStop(1, a + '00'); g.fillStyle = nb; g.fillRect(0, 0, w, h);
      for (let i = 0, n = Math.floor((w * h) / 380); i < n; i++) {
        const s = scrHash(i * 3 + 1);
        scrRect(g, s > 0.92 ? b : '#ffffff', scrHash(i * 3 + 2) * w, scrHash(i * 3 + 3) * h, s > 0.97 ? 2 : 1, s > 0.97 ? 2 : 1);
      }
      const r = Math.min(w, h) * 0.22, px = w * 0.82, py = h * 0.74;
      const pl = g.createRadialGradient(px - r * 0.4, py - r * 0.4, r * 0.1, px, py, r);
      pl.addColorStop(0, b); pl.addColorStop(1, c); g.fillStyle = pl; g.beginPath(); g.arc(px, py, r, 0, 6.2832); g.fill();
      g.strokeStyle = a; g.lineWidth = Math.max(1, r * 0.08); g.beginPath(); g.ellipse(px, py, r * 1.7, r * 0.35, -0.35, 0, 6.2832); g.stroke();
      break;
    }
    case 'sunset': {
      const hz = h * 0.62;
      g.fillStyle = grad(0, hz, [0, bg, 0.5, c, 0.85, a, 1, b]); g.fillRect(0, 0, w, hz);
      const sr = Math.min(w * 0.3, hz * 0.62);
      g.fillStyle = grad(hz - sr, hz, [0, '#fff17a', 1, a]); g.beginPath(); g.arc(w / 2, hz, sr, Math.PI, 2 * Math.PI); g.fill();
      g.fillStyle = grad(0, hz, [0, bg, 0.5, c, 0.85, a, 1, b]);
      for (let i = 0; i < 6; i++) g.fillRect(w / 2 - sr, hz - 4 - i * sr * 0.15, sr * 2, 1 + i * 0.6);
      g.fillStyle = bg; g.fillRect(0, hz, w, h - hz);
      g.strokeStyle = b; g.lineWidth = 1; g.globalAlpha = 0.6; g.beginPath();
      for (let i = -10; i <= 10; i++) { g.moveTo(w / 2 + i * 6, hz); g.lineTo(w / 2 + i * w * 0.14, h); }
      for (let r = 1; r <= 6; r++) { const y = hz + (h - hz) * (r / 6) * (r / 6); g.moveTo(0, y); g.lineTo(w, y); }
      g.stroke();
      break;
    }
    case 'grid': {
      g.fillStyle = grad(0, h, [0, bg, 1, c]); g.fillRect(0, 0, w, h);
      g.strokeStyle = b; g.lineWidth = 1; g.globalAlpha = 0.35; g.beginPath();
      for (let x = 0; x <= w; x += 16) { g.moveTo(x + 0.5, 0); g.lineTo(x + 0.5, h); }
      for (let y = 0; y <= h; y += 16) { g.moveTo(0, y + 0.5); g.lineTo(w, y + 0.5); }
      g.stroke(); g.globalAlpha = 0.9; g.strokeStyle = a; g.lineWidth = 2; g.strokeRect(4, 4, w - 8, h - 8);
      break;
    }
    case 'city': {
      const hz = h * 0.72;
      g.fillStyle = grad(0, hz, [0, bg, 0.6, c, 1, a]); g.fillRect(0, 0, w, hz);
      const mr = Math.min(w, h) * 0.11; g.fillStyle = '#ffe8f6'; g.beginPath(); g.arc(w * 0.76, h * 0.22, mr, 0, 6.2832); g.fill();
      for (let x = 0, i = 0; x < w; i++) {
        const bw = 10 + (i % 4) * 5, bh = h * (0.12 + scrHash(i + 3) * 0.32);
        g.fillStyle = i % 2 ? '#140a2c' : '#1c0e3a'; g.fillRect(x, hz - bh, bw, bh + 1);
        for (let wy = hz - bh + 4; wy < hz - 3; wy += 6) for (let wx = x + 2; wx < x + bw - 2; wx += 4) if (scrHash(wx * 7 + wy * 3 + i) > 0.65) scrRect(g, scrHash(wx + wy) > 0.5 ? '#ffe680' : b, wx, wy, 2, 3);
        x += bw;
      }
      g.fillStyle = '#0a0518'; g.fillRect(0, hz, w, h - hz); scrRect(g, a, 0, hz, w, 2);
      break;
    }
    case 'sky': {
      g.fillStyle = grad(0, h, [0, '#2a7bff', 0.65, '#9fdcff', 1, '#d8f4ff']); g.fillRect(0, 0, w, h);
      g.fillStyle = '#ffffff';
      for (let i = 0; i < 5; i++) { const cx = scrHash(i + 11) * w, cy = scrHash(i + 21) * h * 0.5, r = Math.min(w, h) * 0.07;
      for (let b = 0; b < 3; b++) { g.beginPath(); g.arc(cx + (b - 1) * r, cy + (b & 1) * -r * 0.3, r, 0, 6.2832); g.fill(); } }
      g.fillStyle = grad(h * 0.6, h, [0, a, 1, c]); g.beginPath(); g.moveTo(0, h);
      for (let x = 0; x <= w; x += 4) g.lineTo(x, h * 0.78 + Math.sin(x * 0.03) * h * 0.06);
      g.lineTo(w, h); g.fill();
      break;
    }
    case 'burst': {
      const ox = w / 2, oy = h * 0.55, n = 22, R = Math.hypot(w, h);
      for (let i = 0; i < n; i++) {
        g.fillStyle = i & 1 ? c : bg; g.beginPath(); g.moveTo(ox, oy);
        g.lineTo(ox + Math.cos((i / n) * 6.2832) * R, oy + Math.sin((i / n) * 6.2832) * R);
        g.lineTo(ox + Math.cos(((i + 1) / n) * 6.2832) * R, oy + Math.sin(((i + 1) / n) * 6.2832) * R); g.fill();
      }
      const gl = g.createRadialGradient(ox, oy, 0, ox, oy, Math.max(w, h) * 0.6);
      gl.addColorStop(0, a + 'aa'); gl.addColorStop(1, a + '00'); g.fillStyle = gl; g.fillRect(0, 0, w, h);
      break;
    }
    case 'checker': {
      const s = Math.max(8, Math.round(Math.min(w, h) / 12));
      for (let y = 0; y < h; y += s) for (let x = 0; x < w; x += s) if (((x / s) + (y / s)) & 1) scrRect(g, c, x, y, s, s);
      g.fillStyle = grad(0, h, [0, bg + 'ee', 0.5, bg + '00', 1, bg + 'cc']); g.fillRect(0, 0, w, h);
      g.strokeStyle = b; g.globalAlpha = 0.8; g.lineWidth = 2; g.strokeRect(3, 3, w - 6, h - 6);
      break;
    }
    case 'waves': {
      g.fillStyle = grad(0, h, [0, bg, 1, c]); g.fillRect(0, 0, w, h);
      for (let i = 0; i < 9; i++) {
        g.fillStyle = i % 2 ? a + '33' : b + '30'; g.beginPath(); g.moveTo(0, h);
        for (let x = 0; x <= w; x += 4) g.lineTo(x, h * (0.18 + i * 0.09) + Math.sin(x * 0.045 + i * 1.3) * h * 0.04);
        g.lineTo(w, h); g.fill();
      }
      break;
    }
    case 'stripes': {
      g.fillStyle = grad(0, h, [0, bg, 1, c]); g.fillRect(0, 0, w, h);
      const cols = [a, b, a, '#ffffff'], sw = Math.max(w, h) * 0.13;
      for (let i = 0; i < 4; i++) {
        g.fillStyle = cols[i]; g.globalAlpha = i === 3 ? 0.85 : 0.95; g.beginPath();
        const o = -h * 0.2 + i * sw * 1.5 + h * 0.15;
        g.moveTo(-w * 0.2, h * 0.75 + o); g.lineTo(w * 1.2, h * 0.1 + o - w * 0.2); g.lineTo(w * 1.2, h * 0.1 + o - w * 0.2 + sw * (i === 3 ? 0.12 : 0.9));
        g.lineTo(-w * 0.2, h * 0.75 + o + sw * (i === 3 ? 0.12 : 0.9)); g.fill();
      }
      break;
    }
    case 'chevron': {
      g.fillStyle = grad(0, h, [0, bg, 1, c]); g.fillRect(0, 0, w, h);
      const sp = Math.max(w, h) * 0.16;
      for (let i = -2; i < h / sp + 3; i++) {
        g.fillStyle = i & 1 ? a : b; g.globalAlpha = 0.9; g.beginPath();
        const y = i * sp;
        g.moveTo(0, y); g.lineTo(w / 2, y + sp * 0.8); g.lineTo(w, y); g.lineTo(w, y + sp * 0.3); g.lineTo(w / 2, y + sp * 1.1); g.lineTo(0, y + sp * 0.3); g.fill();
      }
      break;
    }
    default: {
      g.fillStyle = grad(0, h, [0, bg, 1, c]); g.fillRect(0, 0, w, h);
    }
  }
  g.restore();
}

const SCR_LOGO_FONT = '"Arial Black", Impact, "Helvetica Neue", Arial, sans-serif';
// Chrome-style logo lettering: glow, extrusion, dark outline, gradient face, highlight. lines = array of strings.
// pixel = true uses the arcade pixel font (screen titles); false uses a heavy italic face (marquee, side decal).
function scrLogo(g, lines, cx, cy, maxW, maxH, pal, pixel) {
  const family = pixel ? ARCADE_FONT : SCR_LOGO_FONT, face = pixel ? '' : 'italic 900 ';
  g.save();
  g.textAlign = 'center'; g.textBaseline = 'middle'; g.lineJoin = 'round';
  let size = maxH / lines.length;
  for (let i = 0; i < lines.length; i++) {
    g.font = face + size + 'px ' + family;
    const w = g.measureText(lines[i]).width;
    if (w > maxW) size *= maxW / w;
  }
  size = Math.floor(size);
  g.font = face + size + 'px ' + family;
  const lh = size * (pixel ? 1.2 : 0.98), y0 = cy - ((lines.length - 1) * lh) / 2, depth = Math.max(2, Math.round(size * 0.1));
  for (let i = 0; i < lines.length; i++) {
    const y = y0 + i * lh, s = lines[i];
    g.shadowColor = pal[0]; g.shadowBlur = size * 0.4;                               // neon glow under everything
    g.strokeStyle = '#05030a'; g.lineWidth = size * 0.2; g.strokeText(s, cx, y + depth * 0.5);
    g.shadowBlur = 0; g.shadowColor = 'transparent';
    g.fillStyle = pal[2];
    for (let d = depth; d >= 1; d--) g.fillText(s, cx + d * 0.6, y + d);              // extrusion
    g.strokeStyle = '#05030a'; g.lineWidth = size * 0.16; g.strokeText(s, cx, y);
    const gr = g.createLinearGradient(0, y - size * 0.5, 0, y + size * 0.5);
    gr.addColorStop(0, '#ffffff'); gr.addColorStop(0.3, pal[1]); gr.addColorStop(0.5, pal[0]); gr.addColorStop(0.53, pal[2]); gr.addColorStop(1, pal[0]);
    g.fillStyle = gr; g.fillText(s, cx, y);
    g.strokeStyle = 'rgba(255,255,255,0.55)'; g.lineWidth = 1; g.strokeText(s, cx, y);
  }
  g.restore();
}

// Small four-point sparkle used on titles and decals.
function scrSparkle(g, x, y, r, col) {
  scrRect(g, col, x - r, y, r * 2 + 1, 1); scrRect(g, col, x, y - r, 1, r * 2 + 1);
  scrRect(g, col, x - r / 2, y - r / 2, r + 1, r + 1);
}

// ── 10. Static screens: title, high scores, insert coin ──
const SCR_NAMES = ['ACE', 'BOB', 'CAT', 'DJK', 'ELI', 'FOX', 'GUS', 'JAM', 'KAY', 'LEO', 'MAX', 'NEO', 'ZAP', 'RAY', 'SAM', 'TOM', 'VIC', 'WOW', 'ZED', 'MOE'];
const SCR_RANK_COLORS = ['#ff3b3b', '#ff8a1f', '#ffe600', '#39ff88', '#00e5ff', '#5b8bff', '#c06bff', '#ffffff'];

// Builds the layers that never change (backdrop, title, logo, high scores); re-run when the web font arrives.
function scrBuildStatics(def, A) {
  A.back = scrLayer((g) => scrBackdrop(g, SCR_W, SCR_H, def.titleStyle, def.pal));
  A.title = scrLayer((g) => {
    g.drawImage(A.back, 0, 0);
    g.fillStyle = 'rgba(0,0,0,0.35)'; g.fillRect(0, 0, SCR_W, 20);
    scrText(g, 'NEON AMUSEMENT PRESENTS', 128, 7, '#c8c8e0', 1, 1);
    scrMascotBox(g, def, 128, 132, 110, 44);
    scrTextS(g, def.tag, 128, 100, def.pal[1], 1, 1);
    scrText(g, '1991 NEON AMUSEMENT', 128, 174, '#9a9ab8', 1, 1);
  });
  A.logo = scrLayer((g) => scrLogo(g, def.lines, 128, 56, 224, 72, def.pal, true));
  A.mascotImg = scrLayer((g) => scrMascotBox(g, def, 40, 40, 76, 44), 80, 80);
  if (!A.rows) {                                                                   // deterministic high-score table
    const r = rng(def.id.length * 977 + def.id.charCodeAt(0) * 31 + def.id.charCodeAt(2));
    let val = def.hs === 'time' ? 7200 + Math.floor(r() * 900) : 40000 + Math.floor(r() * 90000);
    A.rows = [];
    for (let i = 0; i < 8; i++) {
      A.rows.push({ name: SCR_NAMES[Math.floor(r() * SCR_NAMES.length)], val });
      val = def.hs === 'time' ? val + 150 + Math.floor(r() * 300) : Math.floor(val * (0.62 + r() * 0.3));
    }
  }
  A.scoresBg = scrLayer((g) => {                                                   // dimmed backdrop + header
    g.drawImage(A.back, 0, 0);
    g.fillStyle = 'rgba(0,0,0,0.72)'; g.fillRect(0, 0, SCR_W, SCR_H);
    scrTextS(g, def.hs === 'time' ? 'BEST TIMES' : 'HIGH SCORES', 128, 10, def.pal[1], 2, 1);
    scrRect(g, def.pal[0], 24, 30, 208, 2);
    scrText(g, 'TODAYS TOP PLAYERS', 128, 36, '#9a9ab8', 1, 1);
  });
  A.scores = scrLayer((g) => {                                                     // the same plus all eight rows
    g.drawImage(A.scoresBg, 0, 0);
    const ranks = ['1ST', '2ND', '3RD', '4TH', '5TH', '6TH', '7TH', '8TH'];
    for (let i = 0; i < 8; i++) {
      const y = 52 + i * 15, col = SCR_RANK_COLORS[i], v = A.rows[i].val;
      scrTextS(g, ranks[i], 36, y, col); scrTextS(g, A.rows[i].name, 96, y, col);
      const txt = def.hs === 'time' ? Math.floor(v / 6000) + "'" + String(Math.floor((v % 6000) / 100)).padStart(2, '0') + '"' + String(v % 100).padStart(2, '0') : String(v).padStart(6, '0');
      scrTextS(g, txt, 222, y, col, 1, 2);
    }
  });
}
function scrDrawTitle(g, def, A, pt) {
  g.drawImage(A.title, 0, 0);
  for (let i = 0; i < 5; i++) {                                                    // twinkles around the logo
    const ph = (pt * 1.6 + scrHash(i * 5)) % 1;
    if (ph < 0.5) scrSparkle(g, 20 + scrHash(i * 5 + 1) * 216, 22 + scrHash(i * 5 + 2) * 70, 1 + Math.round(ph * 4), '#ffffff');
  }
  const k = scrEase(pt / 0.6);                                                     // logo zooms in
  g.save();
  g.globalAlpha = k; g.translate(128, 56 + (1 - k) * -26); g.scale(1 + (1 - k) * 0.6, 1 + (1 - k) * 0.6); g.translate(-128, -56);
  g.drawImage(A.logo, 0, 0);
  g.restore();
  if (pt > 0.9 && pt < 1.4) scrSparkle(g, 40 + (pt - 0.9) * 320, 40 + Math.sin(pt * 20) * 10, 5, '#ffffff');   // shine
  if (pt > 1 && ((pt * 2) | 0) % 2 === 0) scrTextS(g, 'PUSH START BUTTON', 128, 158, '#ffffff', 1, 1);
}
function scrDrawScores(g, def, A, pt) {
  g.drawImage(A.scoresBg, 0, 0);                                                  // backdrop + header, then one row every 0.25 s
  for (let i = 0; i < 8; i++) {
    if (pt < 0.4 + i * 0.25) break;
    const y = 50 + i * 15;
    g.drawImage(A.scores, 0, y, SCR_W, 15, 0, y, SCR_W, 15);
  }
  if (pt > 2.6 && ((pt * 2) | 0) % 2 === 0) scrTextS(g, 'INSERT COIN', 128, 172, '#ffe600', 1, 1);
}
function scrDrawCoin(g, def, A, pt) {
  scrRect(g, '#000000', 0, 0, SCR_W, SCR_H);
  g.globalAlpha = 0.4; g.drawImage(A.back, 0, 0); g.globalAlpha = 1;
  scrTextS(g, def.name, 128, 16, def.pal[1], 1, 1);
  g.drawImage(A.mascotImg, 88, 32 + Math.round(Math.sin(pt * 4) * 3));
  if (((pt * 2) | 0) % 2 === 0) scrTextS(g, 'INSERT COIN', 128, 116, '#ffe600', 2, 1);
  scrTextS(g, 'CREDIT 00', 128, 142, '#ffffff', 1, 1);
  scrText(g, '1 COIN 1 PLAY', 128, 156, '#9a9ab8', 1, 1);
  if (((pt * 2 + 1) | 0) % 2 === 0) scrTextS(g, 'PRESS START', 128, 168, '#39ff88', 1, 1);
}
function scrDemoFooter(g, u) {                                                     // strip shown under every demo
  scrRect(g, 'rgba(0,0,0,0.78)', 0, 182, SCR_W, 10);
  scrText(g, 'CREDIT 00', 6, 183, '#c8c8d8');
  if (((u * 1.6) | 0) % 2 === 0) scrText(g, 'INSERT COIN', 250, 183, '#ffe600', 1, 2);
}

// ── 11. Cabinet decals: marquee 512x128, side 256x512, control panel 512x192 (drawn once per game, shared) ──
function scrDrawMarquee(g, def) {
  const W = 512, H = 128;
  scrBackdrop(g, W, H, def.titleStyle, def.pal);
  const glow = g.createRadialGradient(256, 64, 10, 256, 64, 230);                  // backlight hot spot behind the logo
  glow.addColorStop(0, def.pal[0] + '66'); glow.addColorStop(1, def.pal[0] + '00');
  g.fillStyle = glow; g.fillRect(0, 0, W, H);
  scrMascotBox(g, def, 58, 62, 88, 78);
  g.save(); g.translate(W, 0); g.scale(-1, 1); scrMascotBox(g, def, 58, 62, 88, 78); g.restore();      // mirrored partner on the right
  scrLogo(g, def.lines, 256, 62, 310, 92, def.pal, false);
  scrText(g, def.tag, 256, 113, '#ffffff', 1, 1);
  for (let i = 0; i < 6; i++) { scrSparkle(g, 110 + scrHash(i * 3) * 300, 12 + scrHash(i * 3 + 1) * 90, 2 + (i % 3), '#ffffff'); }
  const fr = g.createLinearGradient(0, 0, 0, H);                                   // coloured border with inner highlight
  fr.addColorStop(0, def.pal[1]); fr.addColorStop(1, def.pal[0]);
  g.strokeStyle = '#0a0812'; g.lineWidth = 10; g.strokeRect(0, 0, W, H);
  g.strokeStyle = fr; g.lineWidth = 5; g.strokeRect(5, 5, W - 10, H - 10);
  g.strokeStyle = 'rgba(255,255,255,0.5)'; g.lineWidth = 1; g.strokeRect(9.5, 9.5, W - 19, H - 19);
  const gl = g.createLinearGradient(0, 0, 0, H * 0.5);                             // glossy plastic sheen
  gl.addColorStop(0, 'rgba(255,255,255,0.28)'); gl.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = gl; g.fillRect(0, 0, W, H * 0.5);
}

function scrDrawSide(g, def) {
  const W = 256, H = 512, a = def.pal[0], b = def.pal[1];
  scrBackdrop(g, W, H, def.side, def.pal);
  g.save();                                                                        // halftone dots fading down the decal
  g.fillStyle = a; g.globalAlpha = 0.45;
  for (let y = 6, row = 0; y < H; y += 11, row++) {
    for (let x = (row & 1) * 5.5; x < W; x += 11) {
      const r = 4.6 * Math.max(0, 1 - y / (H * 0.62)) * (0.6 + 0.4 * Math.sin(x * 0.05 + y * 0.03));
      if (r > 0.6) { g.beginPath(); g.arc(x, y, r, 0, 6.2832); g.fill(); }
    }
  }
  g.restore();
  g.fillStyle = 'rgba(0,0,0,0.28)'; g.fillRect(0, 0, W, 22); g.fillRect(0, H - 34, W, 34);   // top and bottom bands
  for (let i = 0; i < 6; i++) { g.save(); g.globalAlpha = 0.85; scrMascotBox(g, def, 22 + i * 42, 11, 30, 14); g.restore(); }   // pixel frieze
  scrRect(g, b, 0, 22, W, 3); scrRect(g, b, 0, H - 37, W, 3);
  // starburst badge behind the mascot
  g.save(); g.translate(128, 150); g.fillStyle = b; g.beginPath();
  for (let i = 0; i < 24; i++) { const rr = i & 1 ? 66 : 94, an = (i / 24) * 6.2832; g.lineTo(Math.cos(an) * rr, Math.sin(an) * rr); }
  g.closePath(); g.globalAlpha = 0.9; g.fill(); g.globalAlpha = 1; g.fillStyle = def.pal[2]; g.beginPath(); g.arc(0, 0, 62, 0, 6.2832); g.fill(); g.restore();
  scrMascotBox(g, def, 128, 150, 112, 100);
  scrLogo(g, def.lines, 128, 318, 226, 150, def.pal, false);
  // banner
  g.fillStyle = '#05030a'; g.fillRect(24, 410, 208, 26); g.fillStyle = b; g.fillRect(27, 413, 202, 20);
  scrText(g, '1 OR 2 PLAYERS', 128, 419, '#05030a', 1, 1);
  scrText(g, def.tag, 128, 448, '#ffffff', 1, 1);
  scrText(g, 'NEON AMUSEMENT 1991', 128, 474, '#ffffff', 1, 1);
  const edge = g.createLinearGradient(0, 0, W, 0);                                 // vinyl edge shading
  edge.addColorStop(0, 'rgba(0,0,0,0.5)'); edge.addColorStop(0.08, 'rgba(0,0,0,0)'); edge.addColorStop(0.92, 'rgba(0,0,0,0)'); edge.addColorStop(1, 'rgba(0,0,0,0.5)');
  g.fillStyle = edge; g.fillRect(0, 0, W, H);
  scrWear(g, W, H, 90, def.id.length);
}

// Scratches and scuffs: n thin light/dark lines with a seeded random generator.
function scrWear(g, w, h, n, seed) {
  const r = rng(seed * 7919 + n);
  g.save(); g.lineWidth = 1;
  for (let i = 0; i < n; i++) {
    const x = r() * w, y = r() * h, a = r() * 6.2832, l = 3 + r() * 16;
    g.strokeStyle = r() > 0.5 ? 'rgba(255,255,255,0.14)' : 'rgba(0,0,0,0.25)';
    g.beginPath(); g.moveTo(x, y); g.lineTo(x + Math.cos(a) * l, y + Math.sin(a) * l); g.stroke();
  }
  g.restore();
}

// Control panel layout as fractions of the 512x192 decal (u across, v from the far edge to the player).
const PANEL_LAYOUT = {
  joysticks: [[0.17, 0.52], [0.83, 0.52]],
  buttons: [[[0.31, 0.63], [0.385, 0.5], [0.46, 0.4]], [[0.69, 0.63], [0.615, 0.5], [0.54, 0.4]]],
  start: [[0.37, 0.86], [0.63, 0.86]],
};
const SCR_BUTTON_COLORS = ['#ff2a3a', '#ffe600', '#2f6bff'];
function scrDrawPanel(g, def) {
  const W = 512, H = 192, r = rng(def.id.charCodeAt(0) * 131 + 7);
  const lam = g.createLinearGradient(0, 0, 0, H);
  lam.addColorStop(0, '#22222e'); lam.addColorStop(1, '#101018'); g.fillStyle = lam; g.fillRect(0, 0, W, H);
  for (let i = 0; i < 700; i++) { g.fillStyle = r() > 0.5 ? 'rgba(255,255,255,0.05)' : 'rgba(0,0,0,0.18)'; g.fillRect(r() * W, r() * H, 1 + (r() > 0.8), 1); }   // laminate grain
  g.strokeStyle = def.pal[0]; g.lineWidth = 2; g.strokeRect(6, 6, W - 12, H - 12);
  g.strokeStyle = 'rgba(255,255,255,0.25)'; g.lineWidth = 1; g.strokeRect(10.5, 10.5, W - 21, H - 21);
  for (let p = 0; p < 2; p++) {
    const [jx, jy] = PANEL_LAYOUT.joysticks[p], x = jx * W, y = jy * H;
    g.strokeStyle = def.pal[1]; g.lineWidth = 2; g.beginPath(); g.arc(x, y, 30, 0, 6.2832); g.stroke();       // joystick ring + direction arrows
    g.strokeStyle = 'rgba(255,255,255,0.35)'; g.lineWidth = 1; g.beginPath(); g.arc(x, y, 22, 0, 6.2832); g.stroke();
    g.fillStyle = '#e8e8f4';
    for (let a = 0; a < 4; a++) {
      g.save(); g.translate(x, y); g.rotate((a * Math.PI) / 2); g.beginPath(); g.moveTo(0, -44); g.lineTo(6, -36); g.lineTo(-6, -36); g.closePath(); g.fill(); g.restore();
    }
    scrTextS(g, p ? 'PLAYER 2' : 'PLAYER 1', x, y + 60, def.pal[1], 1, 1);
    for (let b = 0; b < 3; b++) {
      const [bx, by] = PANEL_LAYOUT.buttons[p][b], px = bx * W, py = by * H;
      g.strokeStyle = SCR_BUTTON_COLORS[b]; g.lineWidth = 2; g.beginPath(); g.arc(px, py, 19, 0, 6.2832); g.stroke();
      g.strokeStyle = 'rgba(255,255,255,0.3)'; g.lineWidth = 1; g.beginPath(); g.arc(px, py, 15, 0, 6.2832); g.stroke();
      scrText(g, def.keys[b], px, py + 24, '#d8d8ea', 1, 1);
    }
  }
  for (let s = 0; s < 2; s++) {                                                      // start buttons and their legends
    const [sx, sy] = PANEL_LAYOUT.start[s], x = sx * W, y = sy * H;
    g.fillStyle = '#05030a'; g.fillRect(x - 40, y - 12, 80, 24); g.strokeStyle = s ? '#39ff88' : '#ff2a3a'; g.lineWidth = 2; g.strokeRect(x - 40, y - 12, 80, 24);
    scrText(g, s ? '2 PLAYERS' : '1 PLAYER', x, y - 4, '#ffffff', 1, 1);
    scrText(g, 'START', x, y + 4, '#9a9ab8', 1, 1);
  }
  scrTextS(g, def.name, 256, 22, def.pal[1], 1, 1);
  scrText(g, 'NEON AMUSEMENT', 256, 34, '#7a7a98', 1, 1);
  scrText(g, 'INSERT COIN', 256, 128, '#ffe600', 1, 1);
  scrWear(g, W, H, 60, def.id.length + 3);
  for (let i = 0; i < 5; i++) {                                                      // scuffs around the buttons
    const sg = g.createRadialGradient(r() * W, r() * H, 0, r() * W, r() * H, 26);
    sg.addColorStop(0, 'rgba(255,255,255,0.05)'); sg.addColorStop(1, 'rgba(255,255,255,0)'); g.fillStyle = sg; g.fillRect(0, 0, W, H);
  }
}

// Marquee, side and panel textures for one game, shared by every cabinet showing that game (saves textures and memory).
const scrArtCache = new Map();
function scrStaticArt(def) {
  let art = scrArtCache.get(def.id);
  if (art) return art;
  const m = makeCanvas(512, 128), s = makeCanvas(256, 512), p = makeCanvas(512, 192);
  art = {
    def, m, s, p,
    marqueeTex: canvasTexture(m.canvas), sideTex: canvasTexture(s.canvas), panelTex: canvasTexture(p.canvas),
  };
  scrPaintStaticArt(art);
  scrArtCache.set(def.id, art);
  return art;
}
function scrPaintStaticArt(art) {
  for (const c of [art.m, art.s, art.p]) { c.ctx.clearRect(0, 0, c.canvas.width, c.canvas.height); c.ctx.imageSmoothingEnabled = false; }
  scrDrawMarquee(art.m.ctx, art.def); scrDrawSide(art.s.ctx, art.def); scrDrawPanel(art.p.ctx, art.def);
  art.marqueeTex.needsUpdate = art.sideTex.needsUpdate = art.panelTex.needsUpdate = true;
}

// ── 12. CRT look: baked into every redraw (cheap: a few full-canvas blits) ──
let _scrOverlay = null, _scrBar = null;
// One shared multiply mask: RGB phosphor triads, scanlines, vignette and rounded tube corners.
function scrOverlay() {
  if (_scrOverlay) return _scrOverlay;
  const { canvas, ctx: g } = makeCanvas(SCR_W, SCR_H);
  g.fillStyle = '#ffffff'; g.fillRect(0, 0, SCR_W, SCR_H);
  const mask = ['#ffe8e8', '#e8ffe8', '#e8e8ff'];
  for (let x = 0; x < SCR_W; x++) { g.fillStyle = mask[x % 3]; g.fillRect(x, 0, 1, SCR_H); }
  g.fillStyle = 'rgba(0,0,0,0.24)';
  for (let y = 1; y < SCR_H; y += 2) g.fillRect(0, y, SCR_W, 1);                    // scanlines
  g.globalCompositeOperation = 'multiply';
  const v = g.createRadialGradient(128, 96, 40, 128, 96, 168);
  v.addColorStop(0, '#ffffff'); v.addColorStop(0.55, '#f2f2f2'); v.addColorStop(0.85, '#b0b0b0'); v.addColorStop(1, '#5a5a5a');
  g.fillStyle = v; g.fillRect(0, 0, SCR_W, SCR_H);                                   // vignette + darker corners
  g.globalCompositeOperation = 'source-over';
  g.fillStyle = '#000000'; g.beginPath(); g.rect(0, 0, SCR_W, SCR_H);
  const r = 12;
  g.moveTo(r, 0); g.arcTo(SCR_W, 0, SCR_W, r, r); g.arcTo(SCR_W, SCR_H, SCR_W - r, SCR_H, r);
  g.arcTo(0, SCR_H, 0, SCR_H - r, r); g.arcTo(0, 0, r, 0, r); g.closePath();
  g.fill('evenodd');                                                                 // black outside the rounded tube
  return (_scrOverlay = canvas);
}
// Soft horizontal band that drifts down the screen (mains hum / refresh bar).
function scrBar() {
  if (_scrBar) return _scrBar;
  const { canvas, ctx: g } = makeCanvas(SCR_W, 50);
  const gr = g.createLinearGradient(0, 0, 0, 50);
  gr.addColorStop(0, '#000000'); gr.addColorStop(0.5, '#ffffff'); gr.addColorStop(1, '#000000');
  g.fillStyle = gr; g.fillRect(0, 0, SCR_W, 50);
  return (_scrBar = canvas);
}
// Glitch: torn horizontal bands and noise lines, then the picture rolls vertically and settles. age in seconds.
function scrGlitchBlit(g, raw, age) {
  const k = age / SCR_GLITCH_LEN, f = (age * 30) | 0;
  if (k > 0.55) {
    const ry = Math.round(scrEase(1 - (k - 0.55) / 0.45) * 130);
    g.drawImage(raw, 0, ry - SCR_H); g.drawImage(raw, 0, ry); scrRect(g, '#000000', 0, ry - 3, SCR_W, 3);
    return;
  }
  g.drawImage(raw, 0, 0);
  for (let i = 0; i < 6; i++) {
    const y = (scrHash(f * 7 + i) * 176) | 0, h = 3 + ((scrHash(f * 11 + i) * 16) | 0), dx = ((scrHash(f * 13 + i) - 0.5) * 44) | 0;
    g.drawImage(raw, 0, y, SCR_W, h, dx, y, SCR_W, h);
  }
  g.fillStyle = 'rgba(255,255,255,0.35)';
  for (let i = 0; i < 3; i++) g.fillRect(0, (scrHash(f * 17 + i) * SCR_H) | 0, SCR_W, 1);
}
// Raw frame -> glitch -> phosphor glow -> scanlines/mask/vignette -> hum bar -> flicker.
function scrCompose(inst, t) {
  const g = inst.g, raw = inst.rawCanvas, ga = t - inst.glitchAt;
  g.globalCompositeOperation = 'source-over'; g.globalAlpha = 1; g.imageSmoothingEnabled = false;
  if (ga >= 0 && ga < SCR_GLITCH_LEN) scrGlitchBlit(g, raw, ga); else g.drawImage(raw, 0, 0);
  inst.glow1.drawImage(raw, 0, 0, 128, 96); inst.glow2.drawImage(inst.glowCanvas1, 0, 0, 64, 48);   // two exact 2x box blurs
  g.imageSmoothingEnabled = true; g.globalCompositeOperation = 'lighter'; g.globalAlpha = 0.3;
  g.drawImage(inst.glowCanvas2, 0, 0, SCR_W, SCR_H);                                                // smooth upscale = phosphor bloom
  g.imageSmoothingEnabled = false;
  g.globalCompositeOperation = 'multiply'; g.globalAlpha = 1; g.drawImage(scrOverlay(), 0, 0);
  g.globalCompositeOperation = 'lighter'; g.globalAlpha = 0.05; g.drawImage(scrBar(), 0, ((t * 22 + inst.index * 37) % (SCR_H + 60)) - 50);
  const n = scrHash((t * 60) | 0);
  g.globalCompositeOperation = 'source-over'; g.globalAlpha = 0.02 + n * n * n * 0.12;               // brightness flicker
  g.fillStyle = '#000000'; g.fillRect(0, 0, SCR_W, SCR_H);
  g.globalAlpha = 1;
}

// ── 13. Screen instances, scheduler and the public entry point ──
const scrInstances = [];
let scrFrame = 0, scrNextGlitch = 14, scrHooked = false;
const scrRand = rng(90210);

// Assets of a game: built lazily on first use, and rebuilt when the web font arrives (text baked into layers).
function scrAssets(def) {
  let A = def.A;
  if (!A || A.epoch !== scrFontEpoch) {
    A = def.A = A || {};
    A.epoch = scrFontEpoch;
    def.init(A);
    scrBuildStatics(def, A);
  }
  return A;
}
// Draws one frame of a screen at time t (seconds) and uploads it.
function scrDraw(inst, t) {
  const def = inst.def, A = scrAssets(def), g = inst.rawCtx;
  let c = (((t + inst.offset) % SCR_CYCLE) + SCR_CYCLE) % SCR_CYCLE, ph = 0;
  while (ph < 3 && c >= SCR_PHASES[ph]) { c -= SCR_PHASES[ph]; ph++; }
  g.globalAlpha = 1; g.globalCompositeOperation = 'source-over';
  if (ph === 0) scrDrawTitle(g, def, A, c);
  else if (ph === 1) { g.fillStyle = '#000000'; g.fillRect(0, 0, SCR_W, SCR_H); def.demo(g, c, A); scrDemoFooter(g, c); }
  else if (ph === 2) scrDrawScores(g, def, A, c);
  else scrDrawCoin(g, def, A, c);
  if (c < SCR_FADE) { g.globalAlpha = 1 - c / SCR_FADE; scrRect(g, '#000000', 0, 0, SCR_W, SCR_H); g.globalAlpha = 1; }
  scrCompose(inst, t);
  inst.tex.needsUpdate = true;
  inst.last = t;
}
// Minimum seconds between redraws of this screen: Infinity when it is far, outside the view cone or facing away,
// and slower for mid-distance screens (they cover fewer pixels, so 15 fps is wasted on them).
function scrGap(inst) {
  let p = inst.pos;
  if (!p) {                                                        // find our cabinet in the registry (registered after the art was made)
    if ((inst.lookups++ & 31) === 0) {
      for (let i = 0; i < registry.cabinets.length; i++) if (registry.cabinets[i].art && registry.cabinets[i].art.screenTex === inst.tex) { inst.pos = p = registry.cabinets[i]; break; }
    }
    if (!p) return 1 / SCR_FPS;                                    // unknown position: always visible (still throttled and capped)
  }
  const dx = p.x - player.x, dz = p.z - player.z, d2 = dx * dx + dz * dz;
  if (d2 > SCR_CULL_DIST * SCR_CULL_DIST || player.pitch > 1.0) return Infinity;   // far away, or looking at the ceiling (screens sit below eye level)
  const dot = dx * -Math.sin(player.yaw) + dz * -Math.cos(player.yaw);
  if (dot < (d2 > 4 ? 0.2 * Math.sqrt(d2) : -0.3)) return Infinity;   // behind, or well outside the view direction
  if (p.rot !== undefined && -dx * Math.sin(p.rot) - dz * Math.cos(p.rot) < -0.3) return Infinity;   // screen faces away
  return d2 < 36 ? 1 / SCR_FPS : d2 < 100 ? 1 / 10 : 1 / 6;
}
// Once per frame: pick a random recently-drawn cabinet for the next glitch, then redraw due screens (capped).
function scrTick(t) {
  scrFrame++;
  const n = scrInstances.length;
  if (t >= scrNextGlitch && n) {
    scrNextGlitch = t + SCR_GLITCH_GAP[0] + scrRand() * (SCR_GLITCH_GAP[1] - SCR_GLITCH_GAP[0]);
    const start = Math.floor(scrRand() * n);
    for (let k = 0; k < n; k++) {
      const inst = scrInstances[(start + k) % n];
      if (t - inst.last < 0.5) { inst.glitchAt = t; break; }
    }
  }
  let budget = SCR_MAX_UPDATES;
  for (let k = 0; k < n && budget > 0; k++) {
    const inst = scrInstances[(scrFrame + k) % n];
    if (t - inst.last < scrGap(inst)) continue;                       // not due, or culled (stays stale until visible again)
    scrDraw(inst, t); budget--;
  }
}
// The web font arrived: rebuild text atlases and static art, and refresh every screen.
function scrOnFontsReady() {
  scrFontEpoch++;
  for (const art of scrArtCache.values()) scrPaintStaticArt(art);
  for (let i = 0; i < scrInstances.length; i++) scrInstances[i].last = -1;
}

// Returns { name, color, aspect, screenTex, marqueeTex, sideTex, panelTex, tag, index }.
//   screenTex 256x192 animated (throttled, culled); marqueeTex 512x128, sideTex 256x512, panelTex 512x192 static
//   (shared between cabinets showing the same game). worldPos {x, z, rot} is optional: without it the position is
//   looked up in registry.cabinets, and if that fails the screen counts as always visible.
function makeCabinetArt(index, worldPos) {
  const def = GAMES[((index % GAME_COUNT) + GAME_COUNT) % GAME_COUNT], art = scrStaticArt(def);
  const raw = makeCanvas(SCR_W, SCR_H), screen = makeCanvas(SCR_W, SCR_H), gl1 = makeCanvas(128, 96), gl2 = makeCanvas(64, 48);
  raw.ctx.imageSmoothingEnabled = false; screen.ctx.imageSmoothingEnabled = false;
  const tex = canvasTexture(screen.canvas);
  tex.magFilter = THREE.NearestFilter;                              // crisp pixels up close
  const inst = {
    index, def, tex, pos: worldPos || null, lookups: 0, last: -1, glitchAt: -99, offset: index * SCR_STAGGER + scrHash(index) * 2,
    rawCanvas: raw.canvas, rawCtx: raw.ctx, g: screen.ctx, glowCanvas1: gl1.canvas, glow1: gl1.ctx, glowCanvas2: gl2.canvas, glow2: gl2.ctx,
  };
  scrInstances.push(inst);
  if (!scrHooked) { scrHooked = true; onUpdate(scrTick); fontsReady.then(scrOnFontsReady); }
  scrDraw(inst, 0);                                                 // first frame right away, so no screen starts black
  return { name: def.name, color: def.color, aspect: 4 / 3, screenTex: tex, marqueeTex: art.marqueeTex, sideTex: art.sideTex, panelTex: art.panelTex, tag: def.tag, index };
}
window.__scr = { makeCabinetArt, scrDraw, scrInstances, GAMES, scrArtCache, PANEL_LAYOUT, frogXAt, frogObjX, frogCount, FROG_LANES, FROG_HOP, scrGap };   //@@DEBUG
