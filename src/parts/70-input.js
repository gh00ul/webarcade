// ═══════════════ INPUT & MOVEMENT: pointer lock, keys, collision, overlay, toast ═══════════════
// Owner: core (stable). Entry point: setupInput(). updatePlayer(dt) is called every frame.

const overlay = document.getElementById('overlay');
const promptEl = document.getElementById('prompt');
const toastEl = document.getElementById('toast');
let locked = false;                       // true while the mouse is captured
let lastUnlockAt = -1e9;                  // performance.now() when the mouse was last released
const keys = new Set();                   // currently held keys (by e.code)

// Brief on-screen message (e.g. "Sound off").
let toastTimer = 0;
function hudMessage(text) {
  toastEl.textContent = text;
  toastEl.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toastEl.classList.remove('show'), 1400);
}

function setupInput() {
  overlay.addEventListener('click', () => {
    if (!promptEl.dataset.ready) return;   // still compiling shaders
    // Chrome returns a promise (rejects if you clicked right after pressing Esc); other browsers return undefined.
    let p;
    try { p = canvas.requestPointerLock(); } catch (e) { showLockError(); return; }
    if (p && p.catch) p.catch(() => {});
  });
  document.addEventListener('pointerlockerror', showLockError);

  document.addEventListener('pointerlockchange', () => {
    locked = document.pointerLockElement === canvas;
    document.body.classList.toggle('locked', locked);
    if (locked) { promptEl.textContent = 'Click to enter'; startAudio(); }
    else { keys.clear(); lastUnlockAt = performance.now(); }
  });

  document.addEventListener('mousemove', (e) => {
    if (!locked) return;
    // Some browsers report NaN / undefined or a huge one-off jump on the first move after locking: ignore those.
    const mx = e.movementX, my = e.movementY;
    if (!(Math.abs(mx) < 1000 && Math.abs(my) < 1000)) return;
    player.yaw   -= mx * LOOK_SENSITIVITY;
    player.pitch -= my * LOOK_SENSITIVITY;
    const limit = Math.PI / 2 - 0.01;     // stop just short of straight up/down
    player.pitch = Math.max(-limit, Math.min(limit, player.pitch));
  });

  addEventListener('keydown', (e) => {
    if (e.code === 'KeyM' && !e.repeat) toggleMute();
    keys.add(e.code);
  });
  addEventListener('keyup', (e) => { keys.delete(e.code); if (e.key === 'Meta') keys.clear(); });   // macOS sends no keyup for keys released while Cmd is held
  addEventListener('blur', () => keys.clear());
}

function showLockError() {
  // Chrome refuses to lock again for about a second after Esc. That is not a real failure: just ask for another click.
  if (performance.now() - lastUnlockAt < 2500) { promptEl.textContent = 'Click again to enter'; return; }
  promptEl.textContent = 'Mouse capture was blocked. Open index.html directly in Chrome, Firefox or Edge, then click again.';
}

const down = (a, b) => keys.has(a) || keys.has(b);     // either of two keys (no rest-args array: this runs every frame)

// Moves the player by (dx, dz) unless a collider is in the way. The room walls just clamp.
function tryMove(dx, dz) {
  const r = PLAYER_RADIUS;
  const limX = ROOM.w / 2 - r, limZ = ROOM.d / 2 - r;
  const nx = Math.max(-limX, Math.min(limX, player.x + dx));
  const nz = Math.max(-limZ, Math.min(limZ, player.z + dz));
  for (let i = 0; i < colliders.length; i++) {           // plain loop: no closure allocated per call
    const b = colliders[i];
    if (nx > b.minX - r && nx < b.maxX + r && nz > b.minZ - r && nz < b.maxZ + r) return;
  }
  player.x = nx; player.z = nz;
}

// dt = seconds since the last frame, so speed is the same at any frame rate.
function updatePlayer(dt) {
  if (locked) {
    const fwd    = Number(down('KeyW', 'ArrowUp'))    - Number(down('KeyS', 'ArrowDown'));
    const strafe = Number(down('KeyD', 'ArrowRight')) - Number(down('KeyA', 'ArrowLeft'));
    if (fwd || strafe) {
      const speed = down('ShiftLeft', 'ShiftRight') ? RUN_SPEED : WALK_SPEED;
      const len = Math.hypot(fwd, strafe);                // so diagonals aren't faster
      const sin = Math.sin(player.yaw), cos = Math.cos(player.yaw);
      const step = (speed * dt) / len;
      // Forward is (-sin, -cos) and right is (cos, -sin) on the floor plane.
      // X and Z are tried separately so you slide along walls and cabinets.
      tryMove((strafe * cos - fwd * sin) * step, 0);
      tryMove(0, (-strafe * sin - fwd * cos) * step);
    }
  }
  camera.position.set(player.x, EYE_HEIGHT, player.z);
  camera.rotation.set(player.pitch, player.yaw, 0);
}
