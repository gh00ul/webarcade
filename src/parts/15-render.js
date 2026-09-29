// ═══════════════ RENDER PIPELINE: composer, bloom, colour grade, resize, adaptive quality ═══════════════
// Owner: look agent. Entry points used by other parts: setupRenderPipeline(), resizeRender(w,h), renderFrame(dt).
//
// Pass chain (all in a multisampled half-float HDR target):
//   RenderPass -> UnrealBloomPass -> OutputPass (tone mapping + sRGB) -> grade ShaderPass (screen)
// The grade runs AFTER tone mapping, in display space, so its contrast / split-tone curves behave predictably.

// ── Tuning constants ──────────────────────────────────────────────────────────────────────────
const RENDER_TONE_MAPPING = THREE.ACESFilmicToneMapping;   // filmic roll-off: deep blacks, neon cores go hot-white (art direction assumes ACES)
const RENDER_EXPOSURE = 1.12;

const BLOOM_STRENGTH = 0.26;      // how much glow is added back
const BLOOM_RADIUS = 0.4;         // how far the glow spreads (0..1)
const BLOOM_THRESHOLD = 1.1;     // HDR luminance where glow starts: lit walls stay clean, neon blooms

const GRADE = {
  vignette: 0.42,                 // corner darkening, 0 = off
  chroma: 0.0008,                 // radial RGB split at the frame edge (fraction of the screen width)
  grain: 0.024,                   // film grain amplitude (also acts as dither against banding)
  contrast: 0.16,                 // S-curve strength around mid grey
  splitTone: 0.75,                // 0 = neutral, 1 = full teal shadows / magenta highlights
  saturation: 1.12,
  blackLift: [0.004, 0.010, 0.016],   // adds a hint of teal to pure black so the room is never dead flat
};

// Adaptive quality. Only active when QUALITY.adapt is true (the test harness passes ?noadapt).
// Each step is applied once and never reverted, so the picture cannot flap between settings.
// The decision uses the MEDIAN of the last frames, so isolated hitches (a shader compile or texture upload when a new
// object turns into view, a quick alt-tab) never count; only a typical frame that stays slow does.
const ADAPT = {
  minFps: 45,                     // median frame slower than this for slowSeconds -> step down one level
  slowSeconds: 1.5,
  windowFrames: 30,               // size of the rolling window the median is taken over
  warmupSeconds: 1.5,             // ignored after start / a quality step (shader compiles, texture uploads)
  resizeSettleSeconds: 0.6,       // ignored after a window resize (framebuffer re-allocation hitch)
  pauseSeconds: 2,                // a longer gap is a tab switch or pointer-lock pause, not slowness
  maxCountedSeconds: 0.25,        // longest single frame that adds to the slow time
};

// What each quality level means (level 2 is the starting point).
const QUALITY_LEVELS = [
  { maxPixelRatio: 1.0,  samples: 0, bloomScale: 0.5, grain: false, chroma: false },   // 0: low
  { maxPixelRatio: 1.25, samples: 2, bloomScale: 1.0, grain: false, chroma: true  },   // 1: medium
  { maxPixelRatio: 2.0,  samples: 4, bloomScale: 1.0, grain: true,  chroma: true  },   // 2: high
];

// ── Colour grade shader ───────────────────────────────────────────────────────────────────────
const GradeShader = {
  name: 'ArcadeGrade',
  uniforms: {
    tDiffuse: { value: null },
    uTime: { value: 0 },
    uAspect: { value: 1.78 },
    uVignette: { value: GRADE.vignette },
    uChroma: { value: GRADE.chroma },
    uGrain: { value: GRADE.grain },
    uContrast: { value: GRADE.contrast },
    uSplit: { value: GRADE.splitTone },
    uSaturation: { value: GRADE.saturation },
    uLift: { value: new THREE.Vector3(...GRADE.blackLift) },
  },
  vertexShader: /* glsl */`
    varying vec2 vUv;
    void main() {
      vUv = uv;
      gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    }`,
  fragmentShader: /* glsl */`
    uniform sampler2D tDiffuse;
    uniform float uTime, uAspect, uVignette, uChroma, uGrain, uContrast, uSplit, uSaturation;
    uniform vec3 uLift;
    varying vec2 vUv;

    float hash(vec2 p) {                     // cheap 2D hash, good enough for grain
      vec3 p3 = fract(vec3(p.xyx) * 0.1031);
      p3 += dot(p3, p3.yzx + 33.33);
      return fract((p3.x + p3.y) * p3.z);
    }

    void main() {
      vec2 c = vUv - 0.5;
      float r2 = dot(c * vec2(uAspect, 1.0), c * vec2(uAspect, 1.0));

      // Chromatic aberration: red and blue slide apart radially, growing towards the edges.
      vec3 col;
      if (uChroma > 0.0) {
        vec2 off = c * (uChroma * r2 * 4.0);
        col = vec3(texture2D(tDiffuse, vUv + off).r, texture2D(tDiffuse, vUv).g, texture2D(tDiffuse, vUv - off).b);
      } else {
        col = texture2D(tDiffuse, vUv).rgb;
      }

      float luma = dot(col, vec3(0.2126, 0.7152, 0.0722));

      // Contrast: gentle S-curve that deepens shadows and lifts highlights without clipping.
      col = mix(col, col * col * (3.0 - 2.0 * col), uContrast);

      // Split tone: teal in the shadows, magenta in the highlights.
      vec3 shadowTint = vec3(0.90, 1.00, 1.07);
      vec3 highTint   = vec3(1.08, 0.96, 1.05);
      col *= mix(vec3(1.0), mix(shadowTint, highTint, smoothstep(0.08, 0.75, luma)), uSplit);
      col += uLift;

      // Saturation boost keeps the neon punchy after the tint.
      float l2 = dot(col, vec3(0.2126, 0.7152, 0.0722));
      col = mix(vec3(l2), col, uSaturation);

      // Vignette.
      col *= 1.0 - uVignette * smoothstep(0.10, 0.62, r2 * 1.2);

      // Grain (strongest in the mid-tones) plus +-0.5/255 dither to hide banding in the dark gradients.
      float n = hash(gl_FragCoord.xy + fract(uTime * 7.31) * 173.0) - 0.5;
      col += n * uGrain * (0.35 + smoothstep(0.0, 0.5, l2));
      col += (hash(gl_FragCoord.xy * 1.37 + 11.0) - 0.5) / 255.0;

      gl_FragColor = vec4(max(col, 0.0), 1.0);
    }`,
};

// ── State ─────────────────────────────────────────────────────────────────────────────────────
let composer, bloomPass, gradePass;
let renderWidth = window.innerWidth, renderHeight = window.innerHeight;   // CSS pixels of the last resize
let gradeTime = 0;
let contextLost = false;

// Adaptive-quality bookkeeping (only touched when QUALITY.adapt is true).
let adaptLastMs = 0, adaptCount = 0, adaptSlowFor = 0, adaptIgnoreUntil = 0;
const adaptRing = new Float32Array(ADAPT.windowFrames), adaptSorted = new Float32Array(ADAPT.windowFrames);

const RENDER_BASE_PIXEL_RATIO = QUALITY.pixelRatio;    // the device's own ratio, our upper bound

function setupRenderPipeline() {
  renderer.toneMapping = RENDER_TONE_MAPPING;
  renderer.toneMappingExposure = RENDER_EXPOSURE;

  // Multisampled half-float target: anti-aliased HDR so bright neon can bloom. GPUs that cannot render to float
  // textures (no EXT_color_buffer_float / _half_float) fall back to 8 bit: no glow above white, but no black screen.
  const hdr = !urlFlag('ldr') && (renderer.extensions.has('EXT_color_buffer_float') || renderer.extensions.has('EXT_color_buffer_half_float'));
  const target = new THREE.WebGLRenderTarget(1, 1, { type: hdr ? THREE.HalfFloatType : THREE.UnsignedByteType, samples: 4 });
  composer = new EffectComposer(renderer, target);
  composer.addPass(new RenderPass(scene, camera));

  bloomPass = new UnrealBloomPass(new THREE.Vector2(1, 1), BLOOM_STRENGTH, BLOOM_RADIUS, BLOOM_THRESHOLD);
  composer.addPass(bloomPass);

  composer.addPass(new OutputPass());                    // tone mapping + sRGB encoding

  gradePass = new ShaderPass(GradeShader);               // last pass: renders to the canvas
  composer.addPass(gradePass);

  // A lost GL context must not crash the loop: pause rendering, resume when the browser restores it.
  canvas.addEventListener('webglcontextlost', (e) => { e.preventDefault(); contextLost = true; });
  canvas.addEventListener('webglcontextrestored', () => {
    contextLost = false;
    resizeRender(renderWidth, renderHeight);
    if (QUALITY.adapt) adaptRestart(ADAPT.warmupSeconds);    // everything is re-uploaded: not a sign of a slow GPU
  });

  applyQualityLevel(QUALITY.level);
}

// Applies QUALITY_LEVELS[level]: pixel ratio cap, MSAA samples, bloom resolution, grain, chromatic aberration.
function applyQualityLevel(level) {
  const q = QUALITY_LEVELS[Math.max(0, Math.min(QUALITY_LEVELS.length - 1, level))];
  QUALITY.level = QUALITY_LEVELS.indexOf(q);
  QUALITY.pixelRatio = Math.min(RENDER_BASE_PIXEL_RATIO, q.maxPixelRatio);
  bloomPass.enabled = QUALITY.bloom;
  gradePass.uniforms.uGrain.value = q.grain ? GRADE.grain : 0;
  gradePass.uniforms.uChroma.value = q.chroma ? GRADE.chroma : 0;

  // Changing the MSAA sample count means re-creating the framebuffers: dispose, three.js rebuilds them lazily.
  const samples = urlFlag('nomsaa') ? 0 : q.samples;
  for (const rt of [composer.renderTarget1, composer.renderTarget2]) {
    if (rt.samples !== samples) { rt.samples = samples; rt.dispose(); }
  }
  resizeRender(renderWidth, renderHeight);
}

function resizeRender(w, h) {
  if (!(w > 0 && h > 0)) return;                          // minimised window reports 0 x 0: keep the last size
  renderWidth = w; renderHeight = h;
  const pr = QUALITY.pixelRatio;
  renderer.setPixelRatio(pr);
  renderer.setSize(w, h);
  composer.setPixelRatio(pr);
  composer.setSize(w, h);
  // Low quality: run the bloom blur chain at a fraction of the resolution (it is soft anyway).
  const scale = QUALITY_LEVELS[QUALITY.level].bloomScale;
  if (scale < 1) bloomPass.setSize(Math.max(2, Math.round(w * pr * scale)), Math.max(2, Math.round(h * pr * scale)));
  gradePass.uniforms.uAspect.value = w / Math.max(1, h);
  if (QUALITY.adapt) adaptRestart(ADAPT.resizeSettleSeconds);
}

// Stops measuring for `seconds` and forgets what was measured so far.
function adaptRestart(seconds) {
  adaptIgnoreUntil = performance.now() + seconds * 1000;
  adaptCount = 0; adaptSlowFor = 0;
}

// Watches the median frame time and steps quality down when it stays under ADAPT.minFps.
function adaptQuality() {
  const now = performance.now();
  const frameSec = (now - adaptLastMs) / 1000;
  const first = adaptLastMs === 0;
  adaptLastMs = now;
  if (first) { adaptRestart(ADAPT.warmupSeconds); return; }
  if (frameSec > ADAPT.pauseSeconds) { adaptRestart(ADAPT.resizeSettleSeconds); return; }
  if (now < adaptIgnoreUntil) return;

  adaptRing[adaptCount++ % ADAPT.windowFrames] = frameSec;
  if (adaptCount < ADAPT.windowFrames) return;             // wait until the window is full
  adaptSorted.set(adaptRing); adaptSorted.sort();
  if (adaptSorted[ADAPT.windowFrames >> 1] > 1 / ADAPT.minFps) adaptSlowFor += Math.min(frameSec, ADAPT.maxCountedSeconds);
  else adaptSlowFor = 0;

  if (adaptSlowFor >= ADAPT.slowSeconds && QUALITY.level > 0) {
    applyQualityLevel(QUALITY.level - 1);
    adaptRestart(ADAPT.warmupSeconds);
  }
}

function renderFrame(dt) {
  if (contextLost) return;
  if (QUALITY.adapt) adaptQuality();
  gradeTime += dt;
  gradePass.uniforms.uTime.value = gradeTime;
  composer.render(dt);
}

// Compiles every material's shader up front (off the main thread where the browser supports KHR_parallel_shader_compile), so
// the first frame does not stall for seconds and turning around later never hits a compile. Never rejects.
function precompileScene() {
  const finish = (p) => Promise.race([p, new Promise((resolve) => setTimeout(resolve, 15000))]).catch(() => {});
  try {
    renderer.setRenderTarget(composer.renderTarget1);      // the scene is drawn into the HDR target: its programs differ from canvas ones
    let p = Promise.resolve();
    if (renderer.extensions.has('KHR_parallel_shader_compile')) p = renderer.compileAsync(scene, camera);
    else renderer.compile(scene, camera);                  // no parallel compile: still do it all now rather than in the middle of play
    renderer.setRenderTarget(null);
    return finish(p);
  } catch (e) {
    renderer.setRenderTarget(null);
    return Promise.resolve();
  }
}
