// ═══════════════ LIGHTING & ATMOSPHERE: environment map, lights, ceiling cans, beams, haze, flicker ═══════════════
// Owner: look agent. Entry point: buildLighting(). Runs BEFORE the room/cabinets are built.
//
// Light budget: 10 real lights in total for the whole scene (1 hemisphere + 6 point + 3 spot). No other part adds any.
// Public helper for other parts:  neonGlowSprite(color, size, intensity)  (see the bottom of this file).
//@@import import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';

// ── Tuning constants ──────────────────────────────────────────────────────────────────────────
const FOG_COLOR = 0x09061a;
const FOG_DENSITY = 0.032;                    // exponential: ~85 % clear at 12 m, far wall stays visible
const ENV_INTENSITY = 0.34;                   // strength of the neon-studio reflections on every standard material
const HEMI = { sky: 0x3f4f92, ground: 0x160f26, intensity: 0.32 };  // dim cool ambient fill

// Point lights (candela, decay 2). Placed next to the neon strips / over the counter so spill reads on carpet and cabinet tops.
const POINT_LIGHTS = [
  { name: 'counter',  color: 0xffa64d, intensity: 26, x:  0.0, y: 3.0, z: -5.4, range: 11 },   // warm amber over the prize counter
  { name: 'island',   color: NEON.purple, intensity: 22, x: 0.0, y: 3.0, z:  0.0, range: 12 },
  { name: 'west',     color: NEON.pink,   intensity: 28, x: -6.6, y: 3.0, z: -0.7, range: 13 },
  { name: 'east',     color: NEON.cyan,   intensity: 28, x:  6.6, y: 3.0, z: -0.7, range: 13 },
  { name: 'southwest', color: 0xc23cff,   intensity: 22, x: -5.6, y: 3.0, z:  5.0, range: 12 },
  { name: 'southeast', color: 0x18b8ff,   intensity: 22, x:  5.6, y: 3.0, z:  5.0, range: 12 },
];

// Ceiling can fixtures with a visible additive beam. `real: true` also gets a SpotLight (3 in total incl. the door).
// (x, z) = fixture position on the ceiling, (tx, tz) = where the beam lands on the floor.
const CEILING_CANS = [
  { x: -4.2, z:  2.8, tx: -3.4, tz:  1.6, color: NEON.pink,   real: true,  intensity: 95 },
  { x:  4.2, z:  2.8, tx:  3.4, tz:  1.6, color: NEON.cyan,   real: true,  intensity: 95 },
  { x: -3.6, z: -2.8, tx: -2.9, tz: -1.9, color: NEON.purple, real: false },
  { x:  3.6, z: -2.8, tx:  2.9, tz: -1.9, color: 0x4d7dff,    real: false },
  { x:  0.0, z: -3.9, tx:  0.0, tz: -6.0, color: 0xffb060,    real: false, ty: 1.06, pool: false },   // warm spot on the prize counter top
  { x: -7.4, z:  3.6, tx: -6.5, tz:  2.2, color: NEON.cyan,   real: false },
  { x:  7.4, z:  3.6, tx:  6.5, tz:  2.2, color: NEON.pink,   real: false },
  { x:  0.0, z:  3.4, tx:  0.0, tz:  2.3, color: 0x8f6bff,    real: false },
];
const CAN_HEIGHT = 3.9;                       // fixture lens height
const BEAM_HALF_ANGLE = 0.15;                 // radians (cone half-angle of the visible beam)
const BEAM_STRENGTH = 0.3;                    // additive brightness of the visible cones
const POOL_STRENGTH = 0.30;                   // brightness of the soft light pool painted where a beam hits the floor
const SPOT_ANGLE = 0.52, SPOT_PENUMBRA = 0.85;

// Street light bleeding in through the glass doors in the south wall (spot placed outside, pointing in).
const DOOR_SPOT = { color: 0x5b8cff, intensity: 70, x: 0, y: 2.6, z: 7.6, tx: 0, ty: 0, tz: 3.6, angle: 0.62 };

// Haze / dust motes.
const MOTE_COUNT = 900;
const MOTE_SIZE = 0.04;                       // metres
const MOTE_BASE_ALPHA = 0.22;
const MOTE_BEAM_BOOST = 1.6;                  // motes inside a beam glint brighter

// Occasional neon flicker: a light buzzes for a moment every FLICKER_MIN..MAX seconds. Nothing runs in between.
const FLICKER_MIN = 9, FLICKER_MAX = 24;      // seconds between events
const FLICKER_LENGTH = [0.35, 0.9];           // seconds a flicker lasts
const FLICKER_LIGHTS = ['west', 'east', 'southwest'];

// ── Shared state ──────────────────────────────────────────────────────────────────────────────
const _lightByName = {};                      // name -> light (for the flicker and for other parts via registry.lights)

// ── Light creation ────────────────────────────────────────────────────────────────────────────
function lightRegister(light, name) {
  scene.add(light);
  registry.lights.push(light);
  if (name) _lightByName[name] = light;
  return light;
}

function lightAddPoint({ name, color, intensity, x, y, z, range }) {
  const light = new THREE.PointLight(color, intensity, range, 2);   // colour, candela, range, decay
  light.position.set(x, y, z);
  light.userData.baseIntensity = intensity;
  return lightRegister(light, name);
}

function lightAddSpot(color, intensity, [x, y, z], [tx, ty, tz], angle, name) {
  const light = new THREE.SpotLight(color, intensity, 16, angle, SPOT_PENUMBRA, 2);
  light.position.set(x, y, z);
  light.target.position.set(tx, ty, tz);
  scene.add(light.target);
  light.userData.baseIntensity = intensity;
  return lightRegister(light, name);
}

// ── Procedural "neon studio" environment (reflections on glossy plastic, glass and metal) ─────
// A tiny dark box with emissive strips and panels; PMREM turns it into a prefiltered reflection map.
function buildEnvironment() {
  const env = new THREE.Scene();
  const shell = new THREE.Mesh(
    new THREE.BoxGeometry(24, 8, 18),
    new THREE.MeshBasicMaterial({ color: 0x030208, side: THREE.BackSide }));
  env.add(shell);

  const glowMats = {};
  const glow = (color, boost) => {
    const key = color + ':' + boost;
    return glowMats[key] || (glowMats[key] = new THREE.MeshBasicMaterial({ color: new THREE.Color(color).multiplyScalar(boost) }));
  };
  const panel = (color, boost, [sx, sy, sz], [x, y, z]) => {
    const m = new THREE.Mesh(new THREE.BoxGeometry(sx, sy, sz), glow(color, boost));
    m.position.set(x, y, z);
    env.add(m);
  };

  // Ceiling strips (long, so they read as neon tubes on curved chrome).
  panel(NEON.cyan,   7, [14, 0.25, 0.25], [0, 3.9, -3.2]);
  panel(NEON.pink,   7, [14, 0.25, 0.25], [0, 3.9,  3.2]);
  panel(NEON.purple, 6, [0.25, 0.25, 12], [-7, 3.9, 0]);
  panel(NEON.purple, 6, [0.25, 0.25, 12], [ 7, 3.9, 0]);
  // Wall strips at head height.
  panel(NEON.pink, 5, [0.2, 0.2, 14], [-11.8, 1.6, 0]);
  panel(NEON.cyan, 5, [0.2, 0.2, 14], [ 11.8, 1.6, 0]);
  // Big warm panel (prize counter side) and a cold "street" panel (glass doors side).
  panel(0xffa050, 3.2, [7, 1.6, 0.2], [0, 1.4, -8.8]);
  panel(0x5b8cff, 3.0, [4, 2.6, 0.2], [0, 1.1,  8.8]);
  // A few small hard highlights, like the ceiling cans, so glass gets crisp reflections.
  for (const [x, z, c] of [[-4, 2, NEON.pink], [4, 2, NEON.cyan], [-4, -3, NEON.purple], [4, -3, NEON.blue], [0, 0, NEON.pink]]) {
    panel(c, 9, [0.5, 0.05, 0.5], [x, 3.98, z]);
  }
  env.position.y = -1.7;                       // put the "camera" (the origin) at eye height

  const pmrem = new THREE.PMREMGenerator(renderer);
  const target = pmrem.fromScene(env, 0.03);
  scene.environment = target.texture;
  scene.environmentIntensity = ENV_INTENSITY;
  pmrem.dispose();
  env.traverse((o) => { if (o.isMesh) { o.geometry.dispose(); } });
  for (const m of Object.values(glowMats)) m.dispose();
  shell.material.dispose();
}

// ── Ceiling cans, beams, floor pools ──────────────────────────────────────────────────────────
const _canUp = new THREE.Vector3(0, -1, 0);   // local axis every fixture/beam points along

// Fixture geometry in local space: lens at the origin, body extending up (+y); aimed by the matrix later.
function lightCanGeometries(matrix, color) {
  const body = new THREE.CylinderGeometry(0.1, 0.14, 0.36, 14);
  body.translate(0, 0.18 + 0.01, 0);
  const rim = new THREE.CylinderGeometry(0.155, 0.155, 0.03, 14);
  rim.translate(0, 0.015, 0);
  const lens = new THREE.CircleGeometry(0.125, 14);
  lens.rotateX(Math.PI / 2);                   // faces -y (down the beam)
  lens.translate(0, -0.005, 0);

  const c = new THREE.Color(color).multiplyScalar(3.2);
  const colors = [];
  for (let i = 0; i < lens.attributes.position.count; i++) colors.push(c.r, c.g, c.b);
  lens.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));

  return { metal: [body, rim].map((g) => g.applyMatrix4(matrix)), lens: lens.applyMatrix4(matrix) };
}

// Additive beam material: bright core, soft edges (fresnel), fading away from the lens and near the camera.
function lightBeamMaterial(color, strength) {
  return new THREE.ShaderMaterial({
    uniforms: { uColor: { value: new THREE.Color(color).multiplyScalar(strength) } },
    vertexShader: /* glsl */`
      varying float vT; varying vec3 vN; varying vec3 vV;
      void main() {
        vT = -position.y;                              // 0 at the lens, 1 at the far end of the cone
        vec4 mv = modelViewMatrix * vec4(position, 1.0);
        vN = normalize(normalMatrix * normal);
        vV = -mv.xyz;
        gl_Position = projectionMatrix * mv;
      }`,
    fragmentShader: /* glsl */`
      uniform vec3 uColor;
      varying float vT; varying vec3 vN; varying vec3 vV;
      void main() {
        float facing = abs(dot(normalize(vN), normalize(vV)));
        float core = pow(facing, 1.7);
        float along = pow(1.0 - vT, 1.5) * smoothstep(0.0, 0.06, vT);
        float nearFade = mix(0.25, 1.0, smoothstep(1.5, 7.0, length(vV))) * smoothstep(0.2, 1.2, length(vV));
        gl_FragColor = vec4(uColor * core * along * nearFade, 1.0);
      }`,
    transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide, fog: false,
  });
}

// Soft radial light pool lying on the floor where a beam lands (cheap stand-in for spill on the carpet).
function lightPoolMaterial(color) {
  return new THREE.MeshBasicMaterial({
    map: glowTexture(), color: new THREE.Color(color).multiplyScalar(POOL_STRENGTH),
    transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, fog: false,
    polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2,
  });
}

// Builds every fixture: merged bodies (1 draw call), merged lenses (1), one cone + one floor pool per beam.
// Returns the beam list for the dust shader: [{ apex, dir, length, color }].
function buildCeilingCans() {
  const beamGeo = new THREE.ConeGeometry(Math.tan(BEAM_HALF_ANGLE), 1, 28, 1, true);
  beamGeo.translate(0, -0.5, 0);               // unit cone: apex at the origin, wide end at y = -1
  const poolGeo = new THREE.PlaneGeometry(1, 1);
  poolGeo.rotateX(-Math.PI / 2);

  const metal = [], lenses = [], beams = [];
  const beamMats = {}, poolMats = {};
  const dir = new THREE.Vector3(), from = new THREE.Vector3(), quat = new THREE.Quaternion(), mat4 = new THREE.Matrix4();
  const one = new THREE.Vector3(1, 1, 1);

  for (const can of CEILING_CANS) {
    const ty = can.ty || 0;
    from.set(can.x, CAN_HEIGHT, can.z);
    dir.set(can.tx - can.x, ty - CAN_HEIGHT, can.tz - can.z);
    const length = dir.length();
    dir.normalize();
    quat.setFromUnitVectors(_canUp, dir);
    mat4.compose(from, quat, one);

    const parts = lightCanGeometries(mat4, can.color);
    metal.push(...parts.metal);
    lenses.push(parts.lens);

    // Ceiling stem so the can visibly hangs from the ceiling.
    const stem = new THREE.CylinderGeometry(0.012, 0.012, ROOM.h - CAN_HEIGHT - 0.1, 6);
    stem.translate(can.x, (ROOM.h + CAN_HEIGHT) / 2 + 0.06, can.z);
    metal.push(stem);

    const beamKey = can.color;
    const beam = new THREE.Mesh(beamGeo, beamMats[beamKey] || (beamMats[beamKey] = lightBeamMaterial(can.color, BEAM_STRENGTH)));
    beam.position.copy(from);
    beam.quaternion.copy(quat);
    beam.scale.setScalar(length);
    beam.renderOrder = 2;
    beam.frustumCulled = false;                // cones are large and cheap; avoids popping at the edge
    scene.add(beam);

    const halo = neonGlowSprite(can.color, 0.8, 1.1);   // bloom-like halo around the lens
    halo.position.copy(from);
    scene.add(halo);

    if (can.pool !== false) {                  // `pool: false` where the beam ends on furniture, not the floor
      const pool = new THREE.Mesh(poolGeo, poolMats[beamKey] || (poolMats[beamKey] = lightPoolMaterial(can.color)));
      pool.position.set(can.tx, ty + 0.014, can.tz);
      pool.scale.setScalar(Math.tan(BEAM_HALF_ANGLE) * length * 2.6);
      pool.renderOrder = 1;
      scene.add(pool);
    }

    beams.push({ apex: from.clone(), dir: dir.clone(), length, color: new THREE.Color(can.color) });

    if (can.real) {
      lightAddSpot(can.color, can.intensity, [can.x, CAN_HEIGHT - 0.05, can.z], [can.tx, ty, can.tz], SPOT_ANGLE, 'can' + beams.length);
    }
  }

  const bodyMesh = new THREE.Mesh(mergeGeometries(metal),
    new THREE.MeshStandardMaterial({ color: 0x14141c, metalness: 0.85, roughness: 0.38 }));
  const lensMesh = new THREE.Mesh(mergeGeometries(lenses), new THREE.MeshBasicMaterial({ vertexColors: true }));
  scene.add(bodyMesh, lensMesh);
  return beams;
}

// ── Haze & dust motes ─────────────────────────────────────────────────────────────────────────
// Every mote is animated in the vertex shader from a time uniform (no per-particle JS). Motes that drift
// through a beam glint in the beam's colour.
function buildDust(beams) {
  const rand = rng(1337);
  const pos = new Float32Array(MOTE_COUNT * 3), seed = new Float32Array(MOTE_COUNT * 4);
  for (let i = 0; i < MOTE_COUNT; i++) {
    pos.set([(rand() - 0.5) * (ROOM.w - 1), rand() * ROOM.h, (rand() - 0.5) * (ROOM.d - 1)], i * 3);
    seed.set([rand(), 0.4 + rand() * 0.9, 0.6 + rand() * 0.8, rand()], i * 4);   // phase, speed, size, tint
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  geo.setAttribute('aSeed', new THREE.BufferAttribute(seed, 4));
  geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 20);   // motes wrap inside the room; never cull

  const n = beams.length;
  const apex = beams.map((b) => new THREE.Vector4(b.apex.x, b.apex.y, b.apex.z, Math.tan(BEAM_HALF_ANGLE)));
  const dirs = beams.map((b) => new THREE.Vector4(b.dir.x, b.dir.y, b.dir.z, b.length));
  const cols = beams.map((b) => new THREE.Vector3(b.color.r, b.color.g, b.color.b));

  const material = new THREE.ShaderMaterial({
    defines: { BEAMS: n },
    uniforms: {
      uTime: { value: 0 }, uViewH: { value: 540 }, uSize: { value: MOTE_SIZE }, uRoomH: { value: ROOM.h },
      uAlpha: { value: MOTE_BASE_ALPHA }, uBoost: { value: MOTE_BEAM_BOOST },
      uBeamApex: { value: apex }, uBeamDir: { value: dirs }, uBeamCol: { value: cols },
    },
    vertexShader: /* glsl */`
      attribute vec4 aSeed;
      uniform float uTime, uViewH, uSize, uRoomH, uAlpha, uBoost;
      uniform vec4 uBeamApex[BEAMS];
      uniform vec4 uBeamDir[BEAMS];
      uniform vec3 uBeamCol[BEAMS];
      varying vec3 vColor; varying float vAlpha;
      void main() {
        float t = uTime * aSeed.y * 0.35;
        vec3 p = position;
        p.x += sin(t + aSeed.x * 40.0) * 0.55 + sin(t * 0.37 + aSeed.w * 20.0) * 0.3;
        p.z += cos(t * 0.8 + aSeed.x * 23.0) * 0.55;
        p.y = mod(p.y + uTime * 0.018 * aSeed.y, uRoomH);                   // slow rise, wraps at the ceiling

        // Base dust colour: cool grey-violet, a few warm specks.
        vec3 base = mix(vec3(0.55, 0.6, 0.95), vec3(1.0, 0.75, 0.55), step(0.86, aSeed.w));
        vec3 glint = vec3(0.0);
        for (int i = 0; i < BEAMS; i++) {                                    // brighten inside each beam cone
          vec3 rel = p - uBeamApex[i].xyz;
          float s = dot(rel, uBeamDir[i].xyz);
          float r = length(rel - uBeamDir[i].xyz * s);
          float cone = uBeamApex[i].w * s;
          float inside = step(0.0, s) * step(s, uBeamDir[i].w) * (1.0 - smoothstep(0.35, 1.0, r / max(cone, 0.001)));
          glint += uBeamCol[i] * inside;
        }
        float twinkle = 0.65 + 0.35 * sin(uTime * (0.6 + aSeed.y) + aSeed.x * 60.0);
        vColor = base * 0.55 + glint * uBoost * 2.2;
        float edgeFade = smoothstep(0.0, 0.5, p.y) * (1.0 - smoothstep(uRoomH - 0.5, uRoomH, p.y));   // fade near floor/ceiling
        vec4 mv = viewMatrix * vec4(p, 1.0);
        float nearFade = smoothstep(0.35, 1.6, -mv.z);
        vAlpha = uAlpha * twinkle * edgeFade * nearFade * (1.0 + length(glint) * 2.5);
        gl_Position = projectionMatrix * mv;
        gl_PointSize = clamp(uSize * aSeed.z * projectionMatrix[1][1] * uViewH * 0.5 / max(-mv.z, 0.1), 1.5, 12.0);
      }`,
    fragmentShader: /* glsl */`
      varying vec3 vColor; varying float vAlpha;
      void main() {
        float d = length(gl_PointCoord - 0.5) * 2.0;
        float soft = pow(clamp(1.0 - d, 0.0, 1.0), 1.6);
        gl_FragColor = vec4(vColor * soft * vAlpha, 1.0);
      }`,
    transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, fog: false,
  });

  const points = new THREE.Points(geo, material);
  points.frustumCulled = false;
  points.renderOrder = 3;
  scene.add(points);

  // Only two uniforms change at runtime: time, and the viewport height (for point sizes).
  onUpdate((t) => {
    material.uniforms.uTime.value = t;
    material.uniforms.uViewH.value = canvas.height;
  });
}

// ── Neon flicker ──────────────────────────────────────────────────────────────────────────────
// Event-driven: sleeps until the next scheduled event, buzzes one light for < 1 s, then sleeps again.
function setupFlicker() {
  const rand = rng(90210);
  const targets = FLICKER_LIGHTS.map((n) => _lightByName[n]).filter(Boolean);
  if (!targets.length) return;
  let nextAt = 6 + rand() * 8;                 // first event a few seconds after the start
  let until = 0, light = null;

  onUpdate((t) => {
    if (light) {
      if (t < until) {
        const step = Math.floor(t * 34);       // buzz at ~34 Hz: on/off decided per step from a hash
        const on = ((Math.sin(step * 12.9898) * 43758.5453) % 1 + 1) % 1 > 0.42;
        light.intensity = light.userData.baseIntensity * (on ? 1 : 0.12);
      } else {
        light.intensity = light.userData.baseIntensity;
        light = null;
        nextAt = t + FLICKER_MIN + rand() * (FLICKER_MAX - FLICKER_MIN);
      }
    } else if (t >= nextAt) {
      light = targets[Math.floor(rand() * targets.length)];
      until = t + FLICKER_LENGTH[0] + rand() * (FLICKER_LENGTH[1] - FLICKER_LENGTH[0]);
    }
  });
}

// ── Public helper: additive neon glow sprite ──────────────────────────────────────────────────
// neonGlowSprite(color, size = 1, intensity = 1.6) -> THREE.Sprite
//   A soft round glow that always faces the camera; put it on a sign, a lamp or a light bulb for a halo.
//   `color` is a hex int, `size` the sprite's diameter in metres, `intensity` an HDR multiplier (1..3).
//   The texture is shared and materials are cached per colour+intensity, so many sprites stay cheap
//   (one draw call each). It writes no depth and is not fogged; set sprite.position and scene.add() it.
let _glowTexture = null;
const _glowMaterials = new Map();

function glowTexture() {
  if (_glowTexture) return _glowTexture;
  const { canvas: c, ctx } = makeCanvas(128, 128);
  const g = ctx.createRadialGradient(64, 64, 0, 64, 64, 64);
  g.addColorStop(0.00, 'rgba(255,255,255,1)');
  g.addColorStop(0.10, 'rgba(255,255,255,0.72)');
  g.addColorStop(0.30, 'rgba(255,255,255,0.24)');
  g.addColorStop(0.60, 'rgba(255,255,255,0.05)');
  g.addColorStop(1.00, 'rgba(255,255,255,0)');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, 128, 128);
  _glowTexture = canvasTexture(c, { srgb: false, anisotropy: 1 });
  return _glowTexture;
}

function neonGlowSprite(color, size = 1, intensity = 1.6) {
  const key = color + ':' + intensity;
  let material = _glowMaterials.get(key);
  if (!material) {
    material = new THREE.SpriteMaterial({
      map: glowTexture(), color: new THREE.Color(color).multiplyScalar(intensity),
      blending: THREE.AdditiveBlending, transparent: true, depthWrite: false, fog: false,
    });
    _glowMaterials.set(key, material);
  }
  const sprite = new THREE.Sprite(material);
  sprite.scale.set(size, size, 1);
  return sprite;
}

// ── Entry point ───────────────────────────────────────────────────────────────────────────────
function buildLighting() {
  scene.fog = new THREE.FogExp2(FOG_COLOR, FOG_DENSITY);
  buildEnvironment();

  lightRegister(new THREE.HemisphereLight(HEMI.sky, HEMI.ground, HEMI.intensity), 'hemi');
  POINT_LIGHTS.forEach(lightAddPoint);
  lightAddSpot(DOOR_SPOT.color, DOOR_SPOT.intensity, [DOOR_SPOT.x, DOOR_SPOT.y, DOOR_SPOT.z],
    [DOOR_SPOT.tx, DOOR_SPOT.ty, DOOR_SPOT.tz], DOOR_SPOT.angle, 'door');

  const beams = buildCeilingCans();            // also adds the SpotLights of the "real" cans
  buildDust(beams);
  setupFlicker();
}
