// ═══════════════ MAIN: build order, resize, render loop ═══════════════
// Owner: core (stable).

function onResize() {
  const w = window.innerWidth, h = window.innerHeight;
  if (!(w > 0 && h > 0)) return;     // minimised window: keep the last good size (0 x 0 would give a NaN aspect)
  resizeRender(w, h);
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
}
addEventListener('resize', onResize);

setupRenderPipeline();
buildLighting();
buildRoom();
buildCabinets();
buildProps();
buildGameProps();
setupAudio();
setupInput();
onResize();
window.__dbg = { player, camera, colliders, registry, renderer, scene, updaters, QUALITY, frames: 0, jsMs: 0 };   //@@DEBUG

Object.assign(window.__dbg, { updatePlayer, tryMove, keys });   //@@DEBUG
renderer.info.autoReset = false;   //@@DEBUG
const clock = new THREE.Clock();

// Runs one hook; a hook that throws is reported once and dropped, so one broken animation cannot freeze the whole scene.
function runUpdater(i, t, dt) {
  try { updaters[i](t, dt); return true; }
  catch (e) { console.error('Update hook disabled after an error:', e); updaters.splice(i, 1); return false; }
}

function frame() {
  const dt = Math.min(clock.getDelta(), 0.05);   // cap dt so a lag spike can't teleport you
  const t = clock.elapsedTime;
  const t0 = performance.now();   //@@DEBUG
  updatePlayer(dt);
  for (let i = 0; i < updaters.length; i++) if (!runUpdater(i, t, dt)) i--;
  updateAudio(dt);
  window.__dbg.jsMs += (performance.now() - t0 - window.__dbg.jsMs) * 0.1;   //@@DEBUG
  renderer.info.reset();   //@@DEBUG
  renderFrame(dt);
  window.__dbg.frames++;   //@@DEBUG
}

// Compile the shaders first (asynchronously), then start the loop and offer "Click to enter": the first frame is then
// cheap instead of stalling for seconds, and turning around later never hits a shader compile.
precompileScene().then(() => {
  promptEl.textContent = 'Click to enter';
  promptEl.dataset.ready = '1';        // tells the loading watchdog in the page (and the click handler) that we are ready
  promptEl.style.fontSize = '';
  renderer.setAnimationLoop(frame);
});
