// ═══════════════ AUDIO: procedural Web Audio (no sound files) ═══════════════
// Owner: audio agent. Entry points: setupAudio(), startAudio(), updateAudio(dt), toggleMute().
//
// Everything you hear is synthesised at runtime. Signal flow:
//
//   cabinet chiptune channels ─► cabinet chain (low-pass ► HRTF panner ► fade) ─┐
//   prop / crowd / coin one-shots ─► (low-pass) ► equal-power panner ──────────┼─► dry bus ─┐
//   room tone (HVAC, murmur) and street wash (at the door) ────────────────────┘            │
//   every positional source also feeds a small send ─► reverb (generated impulse) ──────────┤
//   ► high-pass ► compressor (limiter) ► soft clip ► master fader (mute / overlay duck) ► speakers
//
// Nothing is created before the first user gesture. A 100 ms look-ahead scheduler (setInterval) plays the
// music of the ~6 nearest cabinets and fires sparse, randomised prop / crowd / coin events. Every node is
// created through an AuGroup, so it can be disconnected when it is done and counted against a hard cap.
//
// Adding a sound: write a voice function `fn(g, out, t)` (g = AuGroup, out = node to connect to, t = start time)
// and list it in AU_SFX (played by cabinets), AU_PROP_SPECS (played by a prop kind) or AU_GLOBAL_SPECS.
// Adding a cabinet style: add an entry to AU_FAMILIES (and, if wanted, a name hint in AU_NAME_HINTS).

// ── Tuning ──
const AU_MASTER = 0.9;             // master fader with sound on and the mouse captured
const AU_DUCK = 0.25;              // fader multiplier while the "Click to enter" overlay is showing
const AU_MAX_NODES = 480;          // hard cap on simultaneously alive audio nodes (one-shots refuse to spawn beyond it)
const AU_TICK_MS = 100;            // scheduler period
const AU_LOOKAHEAD = 0.35;         // seconds of music scheduled ahead of the audio clock
const AU_ACTIVE_CABS = 6;          // only the nearest cabinets have voices
const AU_CAB_RANGE = 14;           // metres: cabinets further away are always silent
const AU_CAB_HYSTERESIS = 1.0;     // metres of stickiness so two equally near cabinets do not flip-flop
const AU_CAB_REF = 1.2;            // panner reference distance for cabinets
const AU_CAB_GAIN = 0.3;           // level of a cabinet's mix at 1 m
const AU_CAB_SEND = 0.28;          // reverb send of a cabinet
const AU_PROP_REF = 1.5;           // panner reference distance for props and one-shots
const AU_ROLLOFF = 1.5;            // inverse-distance rolloff factor
const AU_PROP_SEND = 0.3;          // default reverb send of one-shots
const AU_PROP_LEVEL = 0.6;         // default level of prop one-shots relative to their voice functions
const AU_REVERB_RETURN = 0.55;     // reverb level (carpeted room, dark and short)
const AU_RT60 = 1.1;               // seconds
const AU_IR_SECONDS = 1.4;         // impulse response length
const AU_FOOTSTEP = 0.06;          // very quiet carpet shuffle

const audioState = { ctx: null, muted: false, started: false, failed: false };

// Module-private runtime state.
const auRt = {
  bus: null,             // { dry, reverbIn, hp, comp, master }
  buffers: null,         // pre-rendered one-shot samples and noise loops
  live: 0,               // nodes currently alive
  groups: [],            // transient AuGroups waiting to be disposed
  cabs: [], cabsSeen: 0, // per-cabinet audio state, mirrors registry.cabinets
  emitters: [], propsSeen: 0,
  ambience: null, street: null,
  timer: 0, errors: 0, lastError: null,
  masterTarget: -1, mutedAt: 0,
  lx: 0, lz: 0,          // listener floor position
  px: 0, pz: 0, stride: 0, moving: false, stepIdx: 0,
  lastListener: [NaN, 0, 0, 0, 0, 0],
  spot: { x: 0, z: 0 },  // scratch for random emitter positions
  gestureBound: false,
};

// ── Small helpers ──
const auRand = (a, b) => a + Math.random() * (b - a);
const auPick = (arr) => arr[(Math.random() * arr.length) | 0];
const auMtof = (m) => 440 * Math.pow(2, (m - 69) / 12);
const auNz = rng(0xa11ce);                                  // seeded noise for pre-rendered samples
const auNoise = () => auNz() * 2 - 1;

function auPickWeighted(list) {                             // list of [weight, value]
  let sum = 0;
  for (const e of list) sum += e[0];
  let r = Math.random() * sum;
  for (const e of list) { r -= e[0]; if (r <= 0) return e[1]; }
  return list[list.length - 1][1];
}

function auHash(str) {                                      // FNV-1a
  let h = 2166136261 >>> 0;
  for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 16777619) >>> 0; }
  return h;
}

function auCanSpawn(reserve = 0) { return auRt.live + reserve < AU_MAX_NODES; }

// ── AuGroup: a bag of nodes that are created together, live together and are disconnected together ──
class AuGroup {
  // transient groups are collected automatically once their last scheduled sound has ended
  constructor(ac, transient = true) {
    this.ac = ac; this.nodes = []; this.endAt = 0;
    if (transient) auRt.groups.push(this);
  }
  add(node) { this.nodes.push(node); auRt.live++; return node; }
  until(t) { if (t > this.endAt) this.endAt = t; }
  // type: oscillator type name or a PeriodicWave. Started at t0, stopped at t1 (omit t1 for a persistent oscillator).
  osc(type, freq, t0, t1) {
    const o = this.add(this.ac.createOscillator());
    if (typeof type === 'string') o.type = type; else o.setPeriodicWave(type);
    o.frequency.value = freq;
    o.start(t0);
    if (t1 !== undefined) { o.stop(t1); this.until(t1); }
    return o;
  }
  gain(v = 1) { const n = this.add(this.ac.createGain()); n.gain.value = v; return n; }
  filter(type, f, q = 0.7) {
    const n = this.add(this.ac.createBiquadFilter());
    n.type = type; n.frequency.value = f; n.Q.value = q;
    return n;
  }
  // Plays an AudioBuffer from t0. One-shots end by themselves; loops need `until` (or run for the group's life).
  buf(buffer, t0, { rate = 1, loop = false, offset = 0, until } = {}) {
    const s = this.add(this.ac.createBufferSource());
    s.buffer = buffer; s.playbackRate.value = rate; s.loop = loop;
    s.start(t0, offset);
    if (until !== undefined) { s.stop(until); this.until(until); }
    else if (!loop) this.until(t0 + buffer.duration / rate);
    return s;
  }
  panner(x, y, z, { model = 'equalpower', ref = AU_PROP_REF, rolloff = AU_ROLLOFF, cone = null } = {}) {
    const p = this.add(this.ac.createPanner());
    p.panningModel = model; p.distanceModel = 'inverse';
    p.refDistance = ref; p.rolloffFactor = rolloff; p.maxDistance = 200;
    auPlace(p, x, y, z);
    if (cone) {                                             // cone = [dirX, dirZ]: sound is loudest in front
      p.coneInnerAngle = 120; p.coneOuterAngle = 300; p.coneOuterGain = 0.45;
      auOrient(p, cone[0], 0, cone[1]);
    }
    return p;
  }
  dispose() {
    for (const n of this.nodes) {
      try { if (n.stop) n.stop(); } catch (e) { /* never started or already stopped */ }
      try { n.disconnect(); } catch (e) { /* already disconnected */ }
    }
    auRt.live -= this.nodes.length;
    this.nodes.length = 0;
  }
}

function auPlace(p, x, y, z) {
  if (p.positionX) { p.positionX.value = x; p.positionY.value = y; p.positionZ.value = z; }
  else p.setPosition(x, y, z);
}
function auOrient(p, x, y, z) {
  if (p.orientationX) { p.orientationX.value = x; p.orientationY.value = y; p.orientationZ.value = z; }
  else p.setOrientation(x, y, z);
}

// Frees transient groups whose sounds have finished.
function auCollect(now) {
  const gs = auRt.groups;
  for (let i = gs.length - 1; i >= 0; i--) {
    if (gs[i].endAt < now - 0.05) { gs[i].dispose(); gs[i] = gs[gs.length - 1]; gs.pop(); }
  }
}

// ═══════════════ Envelopes and tone primitives ═══════════════

// Percussive envelope: silence -> peak in `atk`, exponential decay (-60 dB) over `dur`, then a 10 ms fade to exact zero.
function auEnvPerc(param, t, peak, atk, dur) {
  param.setValueAtTime(0, t);
  param.linearRampToValueAtTime(peak, t + atk);
  param.exponentialRampToValueAtTime(peak * 0.001, t + dur);
  param.linearRampToValueAtTime(0, t + dur + 0.01);
}

// Oscillator + percussive envelope, optional exponential glide f -> f2. o: { type, f, f2, dur, vol, atk }.
function auTone(g, out, t, o) {
  const dur = o.dur;
  const osc = g.osc(o.type || 'sine', o.f, t, t + dur + 0.03);
  osc.frequency.setValueAtTime(o.f, t);                     // anchor: ramps must start at t, not at "now"
  if (o.f2) osc.frequency.exponentialRampToValueAtTime(o.f2, t + dur);
  const amp = g.gain(0);
  auEnvPerc(amp.gain, t, o.vol, o.atk || 0.003, dur);
  osc.connect(amp); amp.connect(out);
  return osc;
}

// White-noise burst through a sweeping filter with a percussive envelope (explosions, skids, hits).
function auNoiseSweep(g, out, t, { dur, f0, f1, vol, type = 'lowpass', q = 0.8 }) {
  const src = g.buf(auRt.buffers.white, t, { loop: true, offset: Math.random(), until: t + dur + 0.03 });
  const flt = g.filter(type, f0, q);
  flt.frequency.setValueAtTime(f0, t);
  flt.frequency.exponentialRampToValueAtTime(f1, t + dur);
  const amp = g.gain(0);
  auEnvPerc(amp.gain, t, vol, 0.004, dur);
  src.connect(flt); flt.connect(amp); amp.connect(out);
}

// Plays a pre-rendered sample (see auMakeBuffers).
function auShot(g, out, name, t, vol, rate = 1) {
  const src = g.buf(auRt.buffers[name], t, { rate });
  const amp = g.gain(vol);
  src.connect(amp); amp.connect(out);
}

// Notes given as semitones above `base` (Hz), one every `gap` seconds.
function auArpeggio(g, out, t, base, semis, gap, o) {
  semis.forEach((s, i) => auTone(g, out, t + i * gap, { ...o, f: base * Math.pow(2, s / 12) }));
}

// Struck-metal bell: three inharmonic partials with shorter decays for the higher ones.
function auBell(g, out, t, f, dur, vol) {
  const ratios = [1, 2.76, 5.4], levels = [1, 0.45, 0.2];
  for (let i = 0; i < ratios.length; i++) {
    auTone(g, out, t, { f: f * ratios[i], dur: dur / (1 + i * 0.7), vol: vol * levels[i], atk: 0.002 });
  }
}

// Band-limited pulse wave with a given duty cycle (NES-style 12.5 / 25 / 50 %).
const auWaveCache = new WeakMap();
function auPulseWave(ac, duty) {
  let m = auWaveCache.get(ac);
  if (!m) { m = new Map(); auWaveCache.set(ac, m); }
  if (!m.has(duty)) {
    const N = 48, re = new Float32Array(N), im = new Float32Array(N);
    for (let n = 1; n < N; n++) {
      re[n] = (2 / (n * Math.PI)) * Math.sin(2 * Math.PI * n * duty);
      im[n] = (2 / (n * Math.PI)) * (1 - Math.cos(2 * Math.PI * n * duty));
    }
    m.set(duty, ac.createPeriodicWave(re, im));
  }
  return m.get(duty);
}

// ═══════════════ Pre-rendered samples (pure JS synthesis into AudioBuffers) ═══════════════

// Adds a damped sine that starts at t0 to the sample array d.
function auRing(d, sr, t0, f, tau, amp) {
  const i0 = Math.round(t0 * sr);
  const n = Math.min(d.length - i0, Math.round(tau * 7 * sr));
  const w = (2 * Math.PI * f) / sr, k = 1 / (tau * sr);
  for (let i = 0; i < n; i++) d[i0 + i] += amp * Math.sin(w * i) * Math.exp(-i * k);
}
// A tiny mechanical click: two damped rings plus a noise transient.
function auClickAt(d, sr, t0, amp, f) {
  auRing(d, sr, t0, f, 0.0016, amp);
  auRing(d, sr, t0, f * 1.6, 0.0011, amp * 0.6);
  const i0 = Math.round(t0 * sr), n = Math.min(d.length - i0, Math.round(0.004 * sr));
  for (let j = 0; j < n; j++) d[i0 + j] += amp * 0.5 * auNoise() * Math.exp(-j / (0.0008 * sr));
}
// A metal coin/token ring.
function auCoinAt(d, sr, t0, amp, f) {
  auRing(d, sr, t0, f, 0.07, amp);
  auRing(d, sr, t0, f * 1.51, 0.045, amp * 0.6);
  auRing(d, sr, t0, f * 2.09, 0.03, amp * 0.4);
  auClickAt(d, sr, t0, amp * 0.3, f * 0.7);
}
// A puck hitting the rail: woody tock.
function auTockAt(d, sr, t0, amp) {
  auRing(d, sr, t0, 1750, 0.005, amp);
  auRing(d, sr, t0, 950, 0.012, amp * 0.7);
  auClickAt(d, sr, t0, amp * 0.4, 2600);
}

// Renders `seconds` of mono audio with fill(d, sr), then normalises to a 0.9 peak and adds tiny fades (no clicks).
function auBuffer(ac, seconds, fill) {
  const sr = ac.sampleRate, n = Math.max(2, Math.ceil(seconds * sr));
  const d = new Float32Array(n);
  fill(d, sr);
  let peak = 0;
  for (let i = 0; i < n; i++) { const a = Math.abs(d[i]); if (a > peak) peak = a; }
  const k = peak > 0 ? 0.9 / peak : 0;
  const fi = Math.max(1, Math.round(0.0005 * sr)), fo = Math.max(1, Math.round(0.004 * sr));
  for (let i = 0; i < n; i++) d[i] *= k * Math.min(1, i / fi) * Math.min(1, (n - 1 - i) / fo);
  const b = ac.createBuffer(1, n, sr);
  b.copyToChannel(d, 0);
  return b;
}

// Seamlessly looping noise (equal-power crossfade of the tail into the head). kind: 'white' | 'pink' | 'brown'.
function auLoopNoise(ac, seconds, kind) {
  const sr = ac.sampleRate, n = Math.round(seconds * sr), fade = Math.round(0.25 * sr);
  const x = new Float32Array(n + fade);
  let b0 = 0, b1 = 0, b2 = 0, b3 = 0, b4 = 0, b5 = 0, b6 = 0, brown = 0, sq = 0;
  for (let i = 0; i < x.length; i++) {
    const w = auNoise();
    if (kind === 'pink') {                                   // Paul Kellet's economy filter
      b0 = 0.99886 * b0 + w * 0.0555179; b1 = 0.99332 * b1 + w * 0.0750759; b2 = 0.969 * b2 + w * 0.153852;
      b3 = 0.8665 * b3 + w * 0.3104856; b4 = 0.55 * b4 + w * 0.5329522; b5 = -0.7616 * b5 - w * 0.016898;
      x[i] = b0 + b1 + b2 + b3 + b4 + b5 + b6 + w * 0.5362; b6 = w * 0.115926;
    } else if (kind === 'brown') { brown = (brown + 0.02 * w) / 1.02; x[i] = brown * 3.5; }
    else x[i] = w;
    sq += x[i] * x[i];
  }
  const k = (kind === 'white' ? 0.3 : 0.2) / Math.sqrt(sq / x.length);   // fixed RMS keeps peaks below 1
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) out[i] = x[i] * k;
  for (let i = 0; i < fade; i++) {
    const a = (i / fade) * Math.PI / 2;
    out[i] = out[i] * Math.sin(a) + x[n + i] * k * Math.cos(a);
  }
  const b = ac.createBuffer(1, n, sr);
  b.copyToChannel(out, 0);
  return b;
}

// Stereo room impulse response: early reflections, then a decaying noise tail that darkens over time.
function auMakeImpulse(ac) {
  const sr = ac.sampleRate, n = Math.round(AU_IR_SECONDS * sr), buf = ac.createBuffer(2, n, sr);
  const pre = Math.round(0.011 * sr);
  for (let ch = 0; ch < 2; ch++) {
    const d = buf.getChannelData(ch);
    let lp = 0;
    for (let i = pre; i < n; i++) {
      const t = (i - pre) / sr;
      lp += (0.1 + 0.6 * Math.exp(-t / 0.25)) * (auNoise() - lp);    // one-pole low-pass: carpet soaks up the highs
      d[i] = lp * Math.exp((-6.9 * t) / AU_RT60) * Math.min(1, t / 0.004);
    }
    for (let k = 0; k < 6; k++) {                                     // early reflections off walls and ceiling
      const i = Math.min(n - 1, pre + Math.round((0.004 + k * 0.006 + auRand(0, 0.004)) * sr));
      d[i] += (auNz() < 0.5 ? -1 : 1) * 0.35 * (1 - k * 0.13);
    }
  }
  return buf;
}

function auMakeBuffers(ac) {
  const B = {};
  B.white = auLoopNoise(ac, 2, 'white');
  B.pink = auLoopNoise(ac, 6, 'pink');
  B.brown = auLoopNoise(ac, 6, 'brown');

  // ── chip drum kit ──
  B.kick = auBuffer(ac, 0.32, (d, sr) => {
    const tau = 0.038;
    for (let i = 0; i < d.length; i++) {
      const t = i / sr, ph = 2 * Math.PI * (46 * t + 130 * tau * (1 - Math.exp(-t / tau)));
      d[i] = Math.tanh(1.6 * Math.sin(ph) * Math.exp(-t / 0.1));   // light saturation for punch
    }
  });
  B.snare = auBuffer(ac, 0.24, (d, sr) => {
    const hold = Math.max(1, Math.round(sr / 9000));               // sample-and-hold noise = crunchy 8-bit noise channel
    let held = 0;
    for (let i = 0; i < d.length; i++) {
      const t = i / sr;
      if (i % hold === 0) held = auNoise();
      const ph = 2 * Math.PI * (180 * t + 60 * 0.02 * (1 - Math.exp(-t / 0.02)));
      d[i] = 0.75 * held * Math.exp(-t / 0.05) + 0.6 * Math.sin(ph) * Math.exp(-t / 0.03);
    }
  });
  const hat = (seconds, tau) => auBuffer(ac, seconds, (d, sr) => {
    let prev = 0;
    for (let i = 0; i < d.length; i++) { const w = auNoise(); d[i] = (w - prev) * Math.exp(-i / sr / tau); prev = w; }
  });
  B.hatC = hat(0.07, 0.012);
  B.hatO = hat(0.35, 0.07);
  B.clap = auBuffer(ac, 0.3, (d, sr) => {
    let prev = 0;
    for (let i = 0; i < d.length; i++) {
      const t = i / sr;
      let e = 0.6 * (t >= 0.033 ? Math.exp(-(t - 0.033) / 0.07) : 0);
      for (let k = 0; k < 3; k++) if (t >= k * 0.011) e += Math.exp(-(t - k * 0.011) / 0.004);
      const w = auNoise();
      d[i] = 0.5 * (w + prev) * e; prev = w;                        // 2-tap average tames the top end
    }
  });
  B.tom = auBuffer(ac, 0.3, (d, sr) => {
    for (let i = 0; i < d.length; i++) {
      const t = i / sr;
      d[i] = Math.sin(2 * Math.PI * (95 * t + 95 * 0.05 * (1 - Math.exp(-t / 0.05)))) * Math.exp(-t / 0.11);
    }
  });

  // ── mechanical and prop sounds ──
  B.ratchet = auBuffer(ac, 1.0, (d, sr) => {                        // ticket printer
    let t = 0.01;
    for (let k = 0; t < 0.95; k++) {
      auClickAt(d, sr, t, 0.75 + 0.25 * Math.abs(auNoise()), 2100 + 350 * auNoise());
      t += 0.029 + 0.0009 * k + 0.002 * auNoise();
    }
  });
  B.volley = auBuffer(ac, 1.2, (d, sr) => {                         // air-hockey puck rallying between rails
    [0.02, 0.14, 0.26, 0.36, 0.5, 0.61, 0.71, 0.9, 1.02].forEach((t, i) => auTockAt(d, sr, t, 0.8 - 0.03 * i + 0.1 * auNoise()));
  });
  B.goal = auBuffer(ac, 0.7, (d, sr) => {                           // puck drops into the slot and rattles out
    auRing(d, sr, 0.02, 110, 0.06, 1);
    [0.05, 0.16, 0.25, 0.32, 0.37, 0.41, 0.44].forEach((t, i) => auTockAt(d, sr, t, 0.55 - i * 0.06));
  });
  B.coinBounce = auBuffer(ac, 0.9, (d, sr) => {                     // coin dropped on the floor
    [0, 0.19, 0.34, 0.45, 0.53, 0.59, 0.63, 0.65].forEach((t, i) =>
      auCoinAt(d, sr, t, [1, 0.75, 0.55, 0.42, 0.32, 0.24, 0.17, 0.12][i], 3300 + 250 * auNoise()));
  });
  B.tokens = auBuffer(ac, 1.4, (d, sr) => {                         // tokens tumbling into a metal tray
    auRing(d, sr, 0, 180, 0.03, 0.8);
    for (let k = 0; k < 13; k++) auCoinAt(d, sr, 0.03 + auNz() * 1.1, 0.3 + 0.7 * auNz(), 2600 + 2600 * auNz());
  });
  B.thunk = auBuffer(ac, 0.5, (d, sr) => {                          // can dropping in a vending machine
    auRing(d, sr, 0, 78, 0.07, 1); auRing(d, sr, 0, 150, 0.035, 0.5); auClickAt(d, sr, 0, 0.5, 900);
    auRing(d, sr, 0.17, 95, 0.05, 0.4); auClickAt(d, sr, 0.17, 0.25, 900);
  });
  const foot = () => auBuffer(ac, 0.2, (d, sr) => {                 // soft carpet shuffle
    let lp = 0;
    for (let i = 0; i < d.length; i++) {
      const t = i / sr, a = Math.sin((Math.min(1, t / 0.02) * Math.PI) / 2);
      lp += 0.18 * (auNoise() - lp);
      d[i] = lp * a * a * Math.exp(-t / 0.045);
    }
    auRing(d, sr, 0.004, 70, 0.03, 0.05);
  });
  B.footfall = foot();
  B.footfall2 = foot();
  B.flip = auBuffer(ac, 0.45, (d, sr) => {                          // scoreboard digits clacking over
    [0, 0.075, 0.14, 0.22, 0.3].forEach((t, i) => auClickAt(d, sr, t, 0.8 - i * 0.08, 1450));
  });
  B.bumper = auBuffer(ac, 0.3, (d, sr) => {                         // pinball pop bumper
    for (let i = 0; i < d.length; i++) {
      const t = i / sr;
      d[i] = Math.sin(2 * Math.PI * (320 * t + 580 * 0.03 * (1 - Math.exp(-t / 0.03)))) * Math.exp(-t / 0.06);
    }
    auRing(d, sr, 0, 1900, 0.09, 0.35); auRing(d, sr, 0, 3100, 0.05, 0.2); auClickAt(d, sr, 0, 0.5, 2400);
  });
  B.flipper = auBuffer(ac, 0.14, (d, sr) => { auRing(d, sr, 0, 140, 0.03, 1); auClickAt(d, sr, 0, 0.7, 1800); });
  B.crackle = auBuffer(ac, 0.5, (d, sr) => {                        // failing neon tube
    for (let k = 0; k < 6; k++) { const t = 0.02 + auNz() * 0.42; auClickAt(d, sr, t, 0.4 + 0.6 * auNz(), 3600 + 800 * auNoise()); }
  });
  B.pinRoll = auBuffer(ac, 0.7, (d, sr) => {                        // ball rattling down a rail
    let lp = 0;
    for (let i = 0; i < d.length; i++) {
      const t = i / sr;
      lp += 0.25 * (auNoise() - lp);
      d[i] = lp * (0.55 + 0.45 * Math.sin(2 * Math.PI * 31 * t)) * Math.sin((Math.PI * t) / 0.7);
    }
  });
  B.applause = auBuffer(ac, 1.8, (d, sr) => {                       // sparse crackle smoothed into far-off clapping
    let a = 0, b = 0;
    for (let i = 0; i < d.length; i++) {
      const t = i / sr, imp = auNz() < 260 / sr ? auNoise() : 0;
      a += 0.55 * (imp - a); b += 0.55 * (a - b);
      d[i] = b * Math.min(1, t / 0.4) * Math.exp(-Math.max(0, t - 0.7) / 0.45);
    }
  });
  return B;
}

// Soft clip curve: linear up to 0.6, then tanh knee that can never exceed 0.95.
function auSoftClipCurve() {
  const n = 2049, c = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const x = (i / (n - 1)) * 2 - 1, a = Math.abs(x);
    c[i] = Math.sign(x) * (a <= 0.6 ? a : 0.6 + 0.35 * Math.tanh((a - 0.6) / 0.35));
  }
  return c;
}

// ═══════════════ Master bus, listener, room tone ═══════════════

function auBuildMaster(ac) {
  const dry = ac.createGain(), reverbIn = ac.createGain(), reverbOut = ac.createGain();
  const conv = ac.createConvolver();
  conv.buffer = auMakeImpulse(ac);
  reverbOut.gain.value = AU_REVERB_RETURN;
  const hp = ac.createBiquadFilter();                        // removes sub-audible rumble and any DC
  hp.type = 'highpass'; hp.frequency.value = 30; hp.Q.value = 0.5;
  const comp = ac.createDynamicsCompressor();                // limiter
  comp.threshold.value = -12; comp.knee.value = 12; comp.ratio.value = 8;
  comp.attack.value = 0.003; comp.release.value = 0.2;
  const clip = ac.createWaveShaper();
  clip.curve = auSoftClipCurve();
  const master = ac.createGain();                            // mute / duck fader; starts closed so nothing pops
  master.gain.value = 0;
  dry.connect(hp); reverbIn.connect(conv); conv.connect(reverbOut); reverbOut.connect(hp);
  hp.connect(comp); comp.connect(clip); clip.connect(master); master.connect(ac.destination);
  return { dry, reverbIn, hp, comp, master };
}

// Slow sine LFO adding +-depth to an AudioParam.
function auLfo(g, rate, depth, param) {
  const o = g.osc('sine', rate, 0), amt = g.gain(depth);
  o.connect(amt); amt.connect(param);
}

// Always-on bed: HVAC rumble and air, a faint mains hum, and a slowly breathing crowd murmur.
function auBuildRoomTone(ac, bus) {
  const g = new AuGroup(ac, false), B = auRt.buffers;
  const bed = g.gain(1);
  bed.connect(bus.dry);
  const send = g.gain(0.35);
  bed.connect(send); send.connect(bus.reverbIn);
  const loop = (buffer) => g.buf(buffer, 0, { loop: true, offset: Math.random() * buffer.duration });

  // HVAC: low rumble + a breathing "air through ducts" band
  const rumble = loop(B.brown), rlp = g.filter('lowpass', 110, 0.5), rg = g.gain(0.06);
  rumble.connect(rlp); rlp.connect(rg); rg.connect(bed);
  const air = loop(B.pink), abp = g.filter('bandpass', 320, 0.6), ag = g.gain(0.02);
  air.connect(abp); abp.connect(ag); ag.connect(bed);
  auLfo(g, 0.045, 0.008, ag.gain);
  for (const [f, v] of [[120, 0.0022], [240, 0.0012]]) {      // neon transformer / fluorescent hum
    const o = g.osc('sine', f, 0), a = g.gain(v);
    o.connect(a); a.connect(bed);
  }

  // Crowd murmur: several band-passed pink-noise streams whose levels drift independently
  const murmur = g.gain(0.06), murmurSrc = loop(B.pink);
  murmur.connect(bed);
  for (const [f, q, pan, rate] of [[280, 0.9, -0.5, 0.11], [520, 1.2, 0.3, 0.17], [900, 1.6, -0.2, 0.23],
                                   [1500, 2.0, 0.5, 0.31], [700, 1.4, 0.0, 3.7]]) {
    const bp = g.filter('bandpass', f, q), bg = g.gain(0.5);
    murmurSrc.connect(bp); bp.connect(bg);
    if (ac.createStereoPanner) { const p = g.add(ac.createStereoPanner()); p.pan.value = pan; bg.connect(p); p.connect(murmur); }
    else bg.connect(murmur);
    auLfo(g, rate, rate > 1 ? 0.22 : 0.4, bg.gain);            // the 3.7 Hz stream gives the babble a syllable rhythm
  }
  return g;
}

// Muffled traffic wash leaking in through the glass doors, positioned at the door prop (or the south wall).
function auBuildStreet(ac, bus) {
  let door = null;
  for (const p of registry.props) if (p && p.kind === 'door' && Number.isFinite(p.x) && Number.isFinite(p.z)) { door = p; break; }
  const x = door ? door.x : 0, y = door && Number.isFinite(door.y) ? door.y : 1.4, z = door ? door.z : ROOM.d / 2;
  const g = new AuGroup(ac, false), B = auRt.buffers;
  const pan = g.panner(x, y, z, { ref: 2.5, rolloff: 1.2 });
  const send = g.gain(0.4);
  pan.connect(bus.dry); pan.connect(send); send.connect(bus.reverbIn);
  const wash = g.gain(0.15);
  wash.connect(pan);
  const src = g.buf(B.pink, 0, { loop: true, offset: Math.random() * B.pink.duration });
  const lp = g.filter('lowpass', 620, 0.5), swell = g.gain(0.8);
  src.connect(lp); lp.connect(swell); swell.connect(wash);
  auLfo(g, 0.07, 0.25, swell.gain);
  const src2 = g.buf(B.pink, 0, { loop: true, offset: Math.random() * B.pink.duration });
  const bp = g.filter('bandpass', 1400, 0.6), hiss = g.gain(0.10);
  src2.connect(bp); bp.connect(hiss); hiss.connect(wash);
  auRt.emitters.push({ spec: AU_STREET_CARS, x, y: 1.0, z: z + 2.5, next: 0 });
  auRt.emitters.push({ spec: AU_DOOR_CHIME, x, y: 2.2, z, next: 0 });
  return g;
}

function auSetListener(ac, x, y, z, fx, fy, fz) {
  const L = ac.listener, last = auRt.lastListener;
  if (last[0] === x && last[1] === z && last[2] === fx && last[3] === fy && last[4] === fz) return;
  last[0] = x; last[1] = z; last[2] = fx; last[3] = fy; last[4] = fz;
  if (L.positionX) {
    L.positionX.value = x; L.positionY.value = y; L.positionZ.value = z;
    L.forwardX.value = fx; L.forwardY.value = fy; L.forwardZ.value = fz;
  } else {
    L.setPosition(x, y, z); L.setOrientation(fx, fy, fz, 0, 1, 0);
  }
}

// ═══════════════ Cabinet music ═══════════════

const AU_SCALES = {
  major: [0, 2, 4, 5, 7, 9, 11], minor: [0, 2, 3, 5, 7, 8, 10], dorian: [0, 2, 3, 5, 7, 9, 10],
  phrygian: [0, 1, 3, 5, 7, 8, 10], lydian: [0, 2, 4, 6, 7, 9, 11], mixolydian: [0, 2, 4, 5, 7, 9, 10],
  harmMinor: [0, 2, 3, 5, 7, 8, 11], pentaMajor: [0, 2, 4, 7, 9], pentaMinor: [0, 3, 5, 7, 10],
  blues: [0, 3, 5, 6, 7, 10],
};
// Chord roots per bar as scale degrees (4 bars = one loop).
const AU_PROGRESSIONS = [[0, 5, 3, 4], [0, 3, 4, 3], [0, 4, 5, 3], [0, 2, 5, 4], [0, 5, 2, 4], [0, 3, 0, 4], [5, 3, 0, 4]];
// Arpeggio patterns: 0/1/2 = chord tones, 3 = the octave.
const AU_ARP = { up: [0, 1, 2, 3], updown: [0, 1, 2, 3, 2, 1], broken: [0, 2, 1, 3, 2, 1, 3, 2], pedal: [0, 3, 1, 3, 2, 3] };
// Bass patterns per bar: [step 0-15, semitones above the chord root, length in steps].
const AU_BASS = {
  eighth: [[0, 0, 2], [2, 0, 2], [4, 0, 2], [6, 12, 2], [8, 0, 2], [10, 0, 2], [12, 0, 2], [14, 7, 2]],
  gallop: [[0, 0, 1], [2, 0, 1], [3, 0, 1], [4, 0, 1], [6, 0, 1], [7, 0, 1], [8, 0, 1], [10, 0, 1], [11, 0, 1], [12, 0, 1], [14, 0, 1], [15, 12, 1]],
  offbeat: [[2, 0, 2], [6, 0, 2], [10, 0, 2], [14, 7, 2]],
  walk: [[0, 0, 3], [4, 7, 3], [8, 12, 3], [12, 7, 3]],
  long: [[0, 0, 7], [8, 7, 7]],
  octave: [[0, 0, 1], [1, 12, 1], [2, 0, 1], [3, 12, 1], [4, 0, 1], [5, 12, 1], [6, 0, 1], [7, 12, 1],
           [8, 0, 1], [9, 12, 1], [10, 0, 1], [11, 12, 1], [12, 0, 1], [13, 12, 1], [14, 0, 1], [15, 12, 1]],
};
// Drum patterns per bar, one lane per drum; 'x' = hit. Lanes: k kick, s snare, h hat, o open hat, c clap, t tom.
const AU_DRUMS = {
  straight: { k: 'x.....x...x.....', s: '....x.......x...', h: 'x.x.x.x.x.x.x.x.' },
  fourfloor: { k: 'x...x...x...x...', c: '....x.......x...', h: '.x.x.x.x.x.x.x.x', o: '..x...x...x...x.' },
  heavy: { k: 'x..x..x.x.x..x..', s: '....x.......x..x', h: 'x.x.x.x.x.x.x.xx' },
  sparse: { k: 'x.......x.......', s: '........x.......', h: 'x...x...x...x...' },
  bounce: { k: 'x.....x.x.....x.', s: '....x.......x...', h: '..x...x...x...x.', o: '......x.......x.' },
  breaks: { k: 'x..x..x...x.x...', s: '....x..x.x..x...', h: 'xxxxxxxxxxxxxxxx' },
  soft: { k: 'x.......x.......', h: '..x...x...x...x.', t: '............x...' },
};
const AU_DRUM_BITS = { k: 1, s: 2, h: 4, o: 8, c: 16, t: 32 };
const AU_DRUM_SAMPLE = { 1: ['kick', 0.5], 2: ['snare', 0.36], 4: ['hatC', 0.13], 8: ['hatO', 0.12], 16: ['clap', 0.3], 32: ['tom', 0.32] };

// Musical character families. wave: number = pulse duty, or an oscillator type. shape: 'gate' (held) or 'pluck' (decaying).
const AU_FAMILIES = {
  space:    { bpm: [136, 158], scales: ['minor', 'harmMinor', 'phrygian'], lead: { wave: 0.25, shape: 'gate' },
              arp: { wave: 0.125, rate: 1, pat: 'updown' }, bass: 'gallop', bassWave: 'square', drums: 'straight',
              sfx: ['laser', 'laser', 'explosion', 'blip'], sfxRate: 0.7, vib: 0 },
  racer:    { bpm: [150, 172], scales: ['dorian', 'minor', 'mixolydian'], lead: { wave: 'sawtooth', shape: 'gate' },
              arp: null, bass: 'octave', bassWave: 'sawtooth', drums: 'fourfloor',
              sfx: ['skid', 'beep', 'rev', 'coin'], sfxRate: 0.6, engine: true, vib: 8 },
  maze:     { bpm: [116, 132], scales: ['major', 'pentaMajor', 'mixolydian'], lead: { wave: 0.5, shape: 'pluck' },
              arp: { wave: 0.25, rate: 2, pat: 'up' }, bass: 'walk', bassWave: 'triangle', drums: 'sparse',
              sfx: ['waka', 'waka', 'coin', 'powerup'], sfxRate: 0.9, vib: 0 },
  fighter:  { bpm: [112, 134], scales: ['phrygian', 'harmMinor', 'blues'], lead: { wave: 0.125, shape: 'gate' },
              arp: null, bass: 'eighth', bassWave: 'square', drums: 'heavy',
              sfx: ['punch', 'punch', 'explosion', 'die'], sfxRate: 0.9, vib: 0 },
  puzzle:   { bpm: [104, 122], scales: ['major', 'lydian', 'pentaMajor'], lead: { wave: 'triangle', shape: 'pluck' },
              arp: { wave: 0.5, rate: 2, pat: 'broken' }, bass: 'long', bassWave: 'triangle', drums: 'soft',
              sfx: ['blip', 'chain', 'coin'], sfxRate: 0.6, vib: 0 },
  platform: { bpm: [128, 150], scales: ['pentaMajor', 'major', 'mixolydian'], lead: { wave: 0.25, shape: 'pluck' },
              arp: { wave: 0.125, rate: 2, pat: 'pedal' }, bass: 'offbeat', bassWave: 'triangle', drums: 'bounce',
              sfx: ['jump', 'coin', 'stomp', 'powerup'], sfxRate: 0.9, vib: 6 },
  shooter:  { bpm: [140, 164], scales: ['pentaMinor', 'minor', 'blues'], lead: { wave: 0.25, shape: 'gate' },
              arp: { wave: 0.5, rate: 1, pat: 'up' }, bass: 'gallop', bassWave: 'sawtooth', drums: 'breaks',
              sfx: ['laser', 'explosion', 'powerup'], sfxRate: 0.8, vib: 0 },
  dance:    { bpm: [124, 134], scales: ['minor', 'dorian', 'pentaMinor'], lead: { wave: 'sawtooth', shape: 'pluck' },
              arp: { wave: 0.25, rate: 1, pat: 'broken' }, bass: 'offbeat', bassWave: 'sawtooth', drums: 'fourfloor',
              sfx: ['blip', 'powerup'], sfxRate: 0.4, vib: 0 },
};
// Cabinet names that hint at a family (matched against art.name; unknown names fall back to a hash of the name).
const AU_NAME_HINTS = [
  [/\b(rac|drift|road|turbo|rally|speed|kart|cruis|prix|nitro|motor|highway)/, 'racer'],
  [/\b(pac|maze|munch|chomp|ghost)/, 'maze'],
  [/\b(fight|kombat|brawl|punch|ninja|kung|karate|box|combat|dragon|warrior|samurai|street)/, 'fighter'],
  [/\b(puzzle|block|tetr|gem|match|bubble|puyo|drop|column|jewel|candy|crystal)/, 'puzzle'],
  [/\b(jump|hop|plumb|jungle|adventure|kong|platform|island|quest|bros|runner|hero)/, 'platform'],
  [/\b(gun|shoot|sniper|hunt|cop|blast|commando|zombie|duck|target|strike|shot)/, 'shooter'],
  [/\b(danc|rhythm|beat|disco|groove|music|band|dj|karaoke)/, 'dance'],
  [/\b(space|star|galax|invad|astro|alien|cosmic|rocket|asteroid|orbit|nova|laser|planet|ufo|cyber|neon)/, 'space'],
];
const AU_WAVE_VOL = { number: 0.13, sawtooth: 0.075, triangle: 0.2, square: 0.12, sine: 0.2 };

function auStyleFor(cabinet, index) {
  const name = String((cabinet && (cabinet.name || (cabinet.art && cabinet.art.name))) || '').toLowerCase();
  const seed = auHash(name + '#' + index);
  let family = null;
  for (const [re, fam] of AU_NAME_HINTS) if (re.test(name)) { family = fam; break; }
  if (!family) { const keys = Object.keys(AU_FAMILIES); family = keys[(seed >>> 3) % keys.length]; }
  return { family, seed };
}

// Builds a 4-bar loop (64 sixteenth-note steps) deterministically from the seed.
function auMakeSong(family, seed) {
  const fam = AU_FAMILIES[family], r = rng(seed);
  const pick = (arr) => arr[Math.floor(r() * arr.length)];
  const scale = AU_SCALES[pick(fam.scales)], n = scale.length, S = 64;
  const tonic = 36 + Math.floor(r() * 8);
  const bpm = fam.bpm[0] + Math.floor(r() * (fam.bpm[1] - fam.bpm[0] + 1));
  const prog = pick(AU_PROGRESSIONS);
  const song = {
    bpm, stepDur: 60 / bpm / 4, steps: S, family, fam,
    lead: new Int16Array(S), leadLen: new Uint8Array(S), arp: new Int16Array(S), arpLen: fam.arp ? fam.arp.rate : 1,
    bass: new Int16Array(S), bassLen: new Uint8Array(S), drums: new Uint8Array(S),
  };
  const midi = (base, deg) => base + 12 * Math.floor(deg / n) + scale[((deg % n) + n) % n];

  // Lead: a random-walk phrase of 2 bars, answered by a shifted variation that resolves on the last chord.
  const center = n * 3, notes = [];
  let deg = center + prog[0], pos = 0;
  const nearestChordTone = (d, root) => {
    let best = d, bestDist = 99;
    for (let k = -1; k <= 2; k++) for (const o of [0, 2, 4]) {
      const c = root + o + k * n;
      if (Math.abs(c - d) < bestDist) { bestDist = Math.abs(c - d); best = c; }
    }
    return best;
  };
  while (pos < 32) {
    const len = Math.min(pick([1, 1, 2, 2, 2, 3, 4]), 32 - pos);
    if (!(pos % 4 !== 0 && r() < 0.14)) {                    // occasional rest, never on a beat
      deg = Math.max(center - 3, Math.min(center + 8, deg + pick([-2, -1, -1, 0, 1, 1, 2, 3, -3])));
      if (pos % 4 === 0 && r() < 0.7) deg = nearestChordTone(deg, prog[pos >> 4]);
      notes.push({ pos, deg, len });
    }
    pos += len;
  }
  const shift = pick([-2, -1, 1, 2]);
  for (const nt of notes) {
    const lateDeg = nt.pos >= 24 ? nearestChordTone(center + prog[3], prog[3]) : nt.deg + shift;
    song.lead[nt.pos] = midi(tonic, nt.deg); song.leadLen[nt.pos] = nt.len;
    song.lead[nt.pos + 32] = midi(tonic, lateDeg); song.leadLen[nt.pos + 32] = nt.len;
  }

  // Arpeggio over the bar's chord (breaks off for the last 4 steps of the loop)
  if (fam.arp) {
    const seq = AU_ARP[fam.arp.pat], offs = [0, 2, 4, n];
    for (let s = 0, k = 0; s < S - 4; s += fam.arp.rate, k++) {
      song.arp[s] = midi(tonic + 24, prog[s >> 4] + offs[seq[k % seq.length]]);
    }
  }
  // Bass and drums, bar by bar
  for (let bar = 0; bar < 4; bar++) {
    let root = midi(tonic + 12, prog[bar]);
    while (root > tonic + 18) root -= 12;                    // keep the bass low whatever the chord
    for (const [step, semi, len] of AU_BASS[fam.bass]) { song.bass[bar * 16 + step] = root + semi; song.bassLen[bar * 16 + step] = len; }
    const kit = AU_DRUMS[fam.drums];
    for (const lane in kit) for (let s = 0; s < 16; s++) if (kit[lane][s] === 'x') song.drums[bar * 16 + s] |= AU_DRUM_BITS[lane];
  }
  if (fam.drums !== 'soft' && fam.drums !== 'sparse') {      // drum fill on the last beat of the loop
    for (let s = 60; s < 64; s++) song.drums[s] |= s % 2 ? 2 : 32;
  }
  return song;
}

// One note on a monophonic channel: pitch and envelope are scheduled on the persistent oscillator / gain pair.
function auChanNote(ch, t, freq, len, vol, shape) {
  ch.osc.frequency.setValueAtTime(freq, t);
  const p = ch.gain.gain;
  p.setValueAtTime(0, t);
  p.linearRampToValueAtTime(vol, t + 0.004);
  if (shape === 'pluck') {
    p.exponentialRampToValueAtTime(vol * 0.3, t + len * 0.85);
    p.linearRampToValueAtTime(0, t + len);
  } else {
    p.setValueAtTime(vol, t + len - 0.012);
    p.linearRampToValueAtTime(0, t + len);
  }
}

function auDrumHit(ac, out, t, bits) {
  for (const bit of [1, 2, 4, 8, 16, 32]) {
    if (!(bits & bit) || !auCanSpawn(10)) continue;
    const [name, vol] = AU_DRUM_SAMPLE[bit];
    const g = new AuGroup(ac);
    auShot(g, out, name, t, vol * (0.85 + 0.15 * Math.random()), name.startsWith('hat') ? 1 + 0.05 * (Math.random() - 0.5) : 1);
  }
}

// Schedules everything that happens on one sixteenth-note step of a cabinet's loop.
function auCabStep(ac, cab, t) {
  const s = cab.song, i = cab.step, st = s.stepDur, fam = s.fam, v = cab.vol;
  const tt = t + (i & 1 ? (fam.swing || 0) * st : 0);
  if (s.lead[i]) auChanNote(cab.ch.lead, tt, auMtof(s.lead[i]), Math.max(0.05, s.leadLen[i] * st * 0.92), v.lead, fam.lead.shape);
  if (s.arp[i]) auChanNote(cab.ch.arp, tt, auMtof(s.arp[i]), Math.max(0.05, s.arpLen * st * 0.8), v.arp, 'pluck');
  if (s.bass[i]) {
    const shape = fam.bassWave === 'triangle' ? 'gate' : 'pluck';
    auChanNote(cab.ch.bass, tt, auMtof(s.bass[i]), Math.max(0.05, s.bassLen[i] * st * 0.9), v.bass, shape);
  }
  if (s.drums[i]) auDrumHit(ac, cab.inp, tt, s.drums[i]);
  if (i % 16 === 0 && Math.random() < fam.sfxRate && auCanSpawn(24)) {
    const name = auPick(fam.sfx);
    AU_SFX[name](new AuGroup(ac), cab.inp, t + auRand(0, 12) * st);
  }
}

// Schedules all steps that start before `until`.
function auCabAdvance(ac, cab, until) {
  const s = cab.song;
  while (cab.nextTime < until) {
    auCabStep(ac, cab, cab.nextTime);
    cab.nextTime += s.stepDur;
    cab.step = (cab.step + 1) % s.steps;
  }
}

// Builds the persistent voice chain of a cabinet: channels -> low-pass -> panner -> fade -> buses.
function auCabBuild(ac, bus, cab, now) {
  const fam = cab.song.fam, g = new AuGroup(ac, false);
  const inp = g.gain(AU_CAB_GAIN);
  const lp = g.filter('lowpass', 12000, 0.4);
  const pan = g.panner(cab.x, cab.y, cab.z, { model: 'HRTF', ref: AU_CAB_REF, rolloff: AU_ROLLOFF, cone: [Math.sin(cab.rot), Math.cos(cab.rot)] });
  const fade = g.gain(0);
  const send = g.gain(AU_CAB_SEND);
  inp.connect(lp); lp.connect(pan); pan.connect(fade); fade.connect(bus.dry); fade.connect(send); send.connect(bus.reverbIn);

  const channel = (wave) => {
    const osc = g.osc(typeof wave === 'number' ? auPulseWave(ac, wave) : wave, 440, now), amp = g.gain(0);
    osc.connect(amp); amp.connect(inp);
    return { osc, gain: amp };
  };
  const wv = (w) => AU_WAVE_VOL[typeof w === 'number' ? 'number' : w];
  cab.ch = { lead: channel(fam.lead.wave), arp: channel(fam.arp ? fam.arp.wave : 0.5), bass: channel(fam.bassWave) };
  cab.vol = { lead: wv(fam.lead.wave), arp: fam.arp ? wv(fam.arp.wave) * 0.55 : 0, bass: wv(fam.bassWave) * 1.15 };
  if (fam.vib) auLfo(g, 5.5, fam.vib, cab.ch.lead.osc.detune);           // vibrato in cents

  if (fam.engine) {                                                       // racing cabinets: idling engine drone
    const o1 = g.osc('sawtooth', 80, now), o2 = g.osc('square', 40, now), o2g = g.gain(0.5);
    const elp = g.filter('lowpass', 420, 0.8), eg = g.gain(0.05);
    o1.connect(elp); o2.connect(o2g); o2g.connect(elp); elp.connect(eg); eg.connect(inp);
    cab.engine = { o1, o2, lp: elp, gain: eg, rpm: 90, target: 90, until: 0 };
  }
  cab.g = g; cab.inp = inp; cab.lp = lp; cab.fade = fade;
  cab.step = 16 * Math.floor(Math.random() * 4);
  cab.nextTime = now + 0.06;
}

// Random-walk engine revs with the occasional gear change.
function auEngineStep(cab, now) {
  const e = cab.engine;
  if (!e) return;
  if (now > e.until) {
    e.until = now + auRand(0.6, 2.4);
    e.target = Math.random() < 0.2 ? auRand(60, 75) : auRand(75, 200);
  }
  e.rpm += (e.target - e.rpm) * 0.12;
  e.o1.frequency.setTargetAtTime(e.rpm, now, 0.08);
  e.o2.frequency.setTargetAtTime(e.rpm * 0.5, now, 0.08);
  e.lp.frequency.setTargetAtTime(e.rpm * 4, now, 0.1);
}

function auCabActivate(ac, cab, now) {
  if (cab.state === 'fading') { cab.state = 'on'; cab.fade.gain.setTargetAtTime(1, now, 0.25); return; }
  if (!auCanSpawn(20)) return;                                // at the node cap: try again on the next tick
  if (!cab.song) cab.song = auMakeSong(cab.family, cab.seed);
  auCabBuild(ac, auRt.bus, cab, now);
  cab.state = 'on';
  cab.fade.gain.setTargetAtTime(1, now, 0.25);               // fade in: nothing pops when you walk up to a cabinet
}
function auCabDeactivate(cab, now) {
  cab.state = 'fading';
  cab.fade.gain.setTargetAtTime(0, now, 0.1);
  cab.killAt = now + 0.8;
}
function auCabKill(cab) {
  if (cab.g) cab.g.dispose();
  cab.g = null; cab.engine = null; cab.state = 'off';
}

// Chooses which cabinets have voices: the nearest few, with hysteresis so the set does not flicker.
function auSelectCabs(ac, now) {
  const cabs = auRt.cabs, cand = [];
  for (const c of cabs) {
    c.dist = Math.hypot(c.x - auRt.lx, c.z - auRt.lz);
    c.score = c.dist - (c.state === 'on' ? AU_CAB_HYSTERESIS : 0);
    c.want = false;
    if (c.dist < AU_CAB_RANGE) cand.push(c);
  }
  cand.sort((a, b) => a.score - b.score);
  for (let i = 0; i < cand.length && i < AU_ACTIVE_CABS; i++) cand[i].want = true;
  for (const c of cabs) {
    if (c.want && c.state !== 'on') auCabActivate(ac, c, now);
    else if (!c.want && c.state === 'on') auCabDeactivate(c, now);
  }
}

function auCabTick(ac, cab, now) {
  if (cab.nextTime < now + 0.02) cab.nextTime = now + 0.04;   // fell behind (tab was hidden, hiccup): resync, do not burst
  auCabAdvance(ac, cab, now + AU_LOOKAHEAD);
  cab.lp.frequency.setTargetAtTime(900 + 15000 * Math.exp(-cab.dist / 5.5), now, 0.15);   // air absorption
  auEngineStep(cab, now);
}

// ═══════════════ Cabinet sound effects ═══════════════
// Each is fn(g, out, t): out is the cabinet's mix input, so effects are positional too.
const AU_SFX = {
  laser(g, out, t) {
    const f = auRand(1200, 2400);
    auTone(g, out, t, { type: 'square', f, f2: f * auRand(0.08, 0.16), dur: auRand(0.14, 0.24), vol: 0.5 });
  },
  explosion(g, out, t) {
    auNoiseSweep(g, out, t, { dur: auRand(0.5, 0.9), f0: 2400, f1: 90, vol: 0.75 });
    auTone(g, out, t, { f: 110, f2: 32, dur: 0.6, vol: 0.6 });
  },
  coin(g, out, t) {
    auTone(g, out, t, { type: 'square', f: 987.8, dur: 0.07, vol: 0.35 });
    auTone(g, out, t + 0.07, { type: 'square', f: 1318.5, dur: 0.38, vol: 0.35 });
  },
  powerup(g, out, t) {
    const o = g.osc('square', 440, t, t + 0.45), amp = g.gain(0);
    [0, 4, 7, 12, 16, 19, 24, 28].forEach((s, i) => o.frequency.setValueAtTime(440 * Math.pow(2, s / 12), t + i * 0.045));
    amp.gain.setValueAtTime(0, t); amp.gain.linearRampToValueAtTime(0.32, t + 0.005);
    amp.gain.setValueAtTime(0.32, t + 0.36); amp.gain.linearRampToValueAtTime(0, t + 0.44);
    o.connect(amp); amp.connect(out);
  },
  blip(g, out, t) { auTone(g, out, t, { type: 'square', f: auRand(500, 900), f2: auRand(1000, 1800), dur: 0.09, vol: 0.35 }); },
  jump(g, out, t) { auTone(g, out, t, { type: 'square', f: 260, f2: 780, dur: 0.16, vol: 0.42 }); },
  stomp(g, out, t) { auTone(g, out, t, { type: 'square', f: 220, f2: 70, dur: 0.09, vol: 0.5 }); },
  die(g, out, t) {
    const o = g.osc('square', 880, t, t + 0.55), amp = g.gain(0);
    for (let i = 0; i < 7; i++) o.frequency.setValueAtTime(880 * Math.pow(0.87, i * 1.5), t + i * 0.07);
    amp.gain.setValueAtTime(0, t); amp.gain.linearRampToValueAtTime(0.32, t + 0.005);
    amp.gain.setValueAtTime(0.32, t + 0.45); amp.gain.linearRampToValueAtTime(0, t + 0.53);
    o.connect(amp); amp.connect(out);
  },
  punch(g, out, t) {
    auNoiseSweep(g, out, t, { dur: 0.12, f0: 1800, f1: 400, vol: 0.8, type: 'bandpass', q: 0.9 });
    auTone(g, out, t, { f: 140, f2: 55, dur: 0.12, vol: 0.7 });
  },
  waka(g, out, t) {
    auTone(g, out, t, { type: 'triangle', f: 220, f2: 520, dur: 0.1, vol: 0.5 });
    auTone(g, out, t + 0.11, { type: 'triangle', f: 520, f2: 220, dur: 0.1, vol: 0.5 });
  },
  skid(g, out, t) { auNoiseSweep(g, out, t, { dur: 0.5, f0: 1900, f1: 1500, vol: 1.6, type: 'bandpass', q: 3 }); },
  beep(g, out, t) {
    for (let i = 0; i < 3; i++) auTone(g, out, t + i * 0.18, { type: 'square', f: 880, dur: 0.1, vol: 0.3 });
    auTone(g, out, t + 0.6, { type: 'square', f: 1760, dur: 0.35, vol: 0.3 });
  },
  rev(g, out, t) { auTone(g, out, t, { type: 'sawtooth', f: 60, f2: 200, dur: 0.9, vol: 0.35, atk: 0.05 }); },
  chain(g, out, t) {
    auArpeggio(g, out, t, 523.3, [0, 2, 4, 7, 9], 0.06, { type: 'triangle', dur: 0.18, vol: 0.4 });
  },
};

// ═══════════════ Props, crowd and coins: sparse randomised events ═══════════════
// Each voice is fn(g, out, t, panner). Emitters wait a random gap between events, and only fire when the listener is in range.

function auVoicePinballBurst(g, out, t) {
  const n = 2 + ((Math.random() * 5) | 0);
  let tt = t;
  for (let i = 0; i < n; i++) { auShot(g, out, 'bumper', tt, 0.5 * (0.7 + 0.3 * Math.random()), auRand(0.85, 1.25)); tt += auRand(0.07, 0.16); }
  if (Math.random() < 0.6) auBell(g, out, tt + 0.1, auPick([1046.5, 1318.5, 1568]), 0.9, 0.16);
}
function auVoicePinballChime(g, out, t) {
  const f = auPick([784, 1046.5, 1318.5]);
  auBell(g, out, t, f, 1.3, 0.2);
  if (Math.random() < 0.5) auBell(g, out, t + 0.16, f * 1.5, 1.0, 0.16);
}
function auVoiceFlipper(g, out, t) { auShot(g, out, 'flipper', t, 0.5, auRand(0.9, 1.1)); }
function auVoicePinRoll(g, out, t) { auShot(g, out, 'pinRoll', t, 0.35, auRand(0.9, 1.15)); }

function auVoiceClawJingle(g, out, t) {
  const base = auPick([523.25, 587.33, 659.25]);
  auArpeggio(g, out, t, base, [0, 4, 7, 12, 16, 12, 19], 0.12, { type: 'triangle', dur: 0.26, vol: 0.25 });
}
function auVoiceClawWhir(g, out, t) {                        // gantry motor
  const dur = auRand(0.9, 1.6);
  const o = g.osc('sawtooth', 70, t, t + dur + 0.05), f = o.frequency;
  f.setValueAtTime(70, t); f.linearRampToValueAtTime(auRand(100, 130), t + dur * 0.4); f.linearRampToValueAtTime(62, t + dur);
  const lp = g.filter('lowpass', 520, 0.7), amp = g.gain(0);
  amp.gain.setValueAtTime(0, t); amp.gain.linearRampToValueAtTime(0.16, t + 0.12);
  amp.gain.setValueAtTime(0.16, t + dur - 0.15); amp.gain.linearRampToValueAtTime(0, t + dur);
  const wobble = g.osc('sine', 22, t, t + dur + 0.05), wg = g.gain(4);
  wobble.connect(wg); wg.connect(f);
  o.connect(lp); lp.connect(amp); amp.connect(out);
}
function auVoiceClawDrop(g, out, t) {
  auShot(g, out, 'thunk', t, 0.4, 1.4);
  auTone(g, out, t + 0.05, { type: 'square', f: 1400, f2: 900, dur: 0.05, vol: 0.05 });
}
function auVoiceClawWin(g, out, t) {
  auArpeggio(g, out, t, 659.3, [0, 4, 7, 12, 7, 12, 16, 19], 0.09, { type: 'square', dur: 0.16, vol: 0.15 });
}

function auVoicePuckVolley(g, out, t) { auShot(g, out, 'volley', t, 0.6, auRand(0.92, 1.1)); }
function auVoicePuckGoal(g, out, t) {
  auShot(g, out, 'goal', t, 0.6, auRand(0.95, 1.05));
  if (Math.random() < 0.5) auTone(g, out, t + 0.6, { type: 'square', f: 220, dur: 0.4, vol: 0.06 });
}

function auVoicePrizePrint(g, out, t) {                      // ticket printer, sometimes followed by a bell
  const rate = auRand(0.9, 1.1);
  auShot(g, out, 'ratchet', t, 0.55, rate);
  if (Math.random() < 0.5) auShot(g, out, 'ratchet', t + 1.05 / rate, 0.5, rate * 1.05);
  if (Math.random() < 0.4) { auBell(g, out, t + 1.1, 2093, 0.9, 0.18); auBell(g, out, t + 1.3, 2093, 0.9, 0.18); }
}
function auVoicePrizeBell(g, out, t) {
  auBell(g, out, t, 2093, 1.0, 0.2);
  auBell(g, out, t + 0.2, 2093, 1.0, 0.2);
}
function auVoiceCoinCascade(g, out, t) { auShot(g, out, 'tokens', t, 0.5, auRand(0.9, 1.15)); }
function auVoiceCoinBounce(g, out, t) { auShot(g, out, 'coinBounce', t, 0.45, auRand(0.85, 1.2)); }

function auVoiceVendingHum(g, out, t) {                      // refrigeration compressor cycling on for a while
  const dur = auRand(7, 14), end = t + dur + 0.05;
  const env = g.gain(0);
  env.gain.setValueAtTime(0, t); env.gain.linearRampToValueAtTime(1, t + 1.2);
  env.gain.setValueAtTime(1, t + dur - 2); env.gain.linearRampToValueAtTime(0, t + dur);
  [[120, 0.07, 'triangle'], [240, 0.04, 'sine'], [360, 0.02, 'sine']].forEach(([f, v, type]) => {
    const o = g.osc(type, f * (1 + 0.002 * Math.random()), t, end), a = g.gain(v);
    o.connect(a); a.connect(env);
  });
  const rattle = g.buf(auRt.buffers.pink, t, { loop: true, offset: Math.random() * 3, until: end });
  const bp = g.filter('bandpass', 380, 1), rg = g.gain(0.03);
  rattle.connect(bp); bp.connect(rg); rg.connect(env);
  env.connect(out);
}
function auVoiceCanDrop(g, out, t) {
  auShot(g, out, 'thunk', t, 0.5, auRand(0.9, 1.1));
  auShot(g, out, 'coinBounce', t + 0.6, 0.15, 1.3);          // change drops in the return tray
}

function auVoiceScoreFlip(g, out, t) { auShot(g, out, 'flip', t, 0.4, auRand(0.9, 1.1)); }
function auVoiceScoreBeep(g, out, t) {
  auTone(g, out, t, { type: 'square', f: 1568, dur: 0.06, vol: 0.14 });
  auTone(g, out, t + 0.1, { type: 'square', f: 1568, dur: 0.06, vol: 0.14 });
}
function auVoiceCrackle(g, out, t) { auShot(g, out, 'crackle', t, 0.3, auRand(0.9, 1.1)); }

// A car passing outside: filtered noise swelling and sweeping while the source slides across the door.
function auVoiceCarPass(g, out, t, pan) {
  const dur = auRand(3, 4.5), end = t + dur + 0.05;
  const src = g.buf(auRt.buffers.pink, t, { offset: Math.random() * 1.2, until: end });
  const bp = g.filter('bandpass', 200, 1);
  bp.frequency.setValueAtTime(200, t); bp.frequency.exponentialRampToValueAtTime(520, t + dur * 0.5);
  bp.frequency.exponentialRampToValueAtTime(230, t + dur);
  const amp = g.gain(0);
  amp.gain.setValueAtTime(0, t); amp.gain.linearRampToValueAtTime(0.6, t + dur * 0.5); amp.gain.linearRampToValueAtTime(0, t + dur);
  src.connect(bp); bp.connect(amp); amp.connect(out);
  const eng = g.osc('sawtooth', 55, t, end), elp = g.filter('lowpass', 200, 0.7), eg = g.gain(0);
  eng.frequency.setValueAtTime(55, t); eng.frequency.linearRampToValueAtTime(75, t + dur * 0.5); eng.frequency.linearRampToValueAtTime(52, t + dur);
  eg.gain.setValueAtTime(0, t); eg.gain.linearRampToValueAtTime(0.15, t + dur * 0.5); eg.gain.linearRampToValueAtTime(0, t + dur);
  eng.connect(elp); elp.connect(eg); eg.connect(out);
  if (pan.positionX) {
    const x = pan.positionX.value, dir = Math.random() < 0.5 ? -1 : 1;
    pan.positionX.setValueAtTime(x + dir * 7, t); pan.positionX.linearRampToValueAtTime(x - dir * 7, t + dur);
  }
}
function auVoiceHorn(g, out, t) {                            // distant honk
  for (const f of [392, 494]) auTone(g, out, t, { type: 'sawtooth', f, dur: 0.28, vol: 0.12, atk: 0.02 });
}
function auVoiceDoorChime(g, out, t) {                       // ding-dong when the doors open
  auBell(g, out, t, 1318.5, 1.2, 0.2);
  auBell(g, out, t + 0.45, 987.8, 1.6, 0.2);
}

// Distant people: a handful of detuned saw "voices" through vowel formants, swelling like a cheer or groan.
function auVoiceCrowd(g, out, t) {
  const kind = auPickWeighted([[3, 'cheer'], [2, 'groan'], [1, 'ooh'], [1.5, 'applause']]);
  if (kind === 'applause') { auShot(g, out, 'applause', t, 0.5, auRand(0.9, 1.1)); return; }
  const dur = kind === 'ooh' ? 1.4 : auRand(1.1, 1.9), end = t + dur + 0.9;
  const glide = kind === 'cheer' ? 1.18 : kind === 'groan' ? 0.78 : 1;
  const [f1, f2] = kind === 'groan' ? [520, 900] : kind === 'ooh' ? [380, 800] : [720, 1150];
  const env = g.gain(0), sum = g.gain(1);
  env.gain.setValueAtTime(0, t); env.gain.linearRampToValueAtTime(0.6, t + 0.3);
  env.gain.setValueAtTime(0.6, t + dur); env.gain.linearRampToValueAtTime(0, t + dur + 0.8);
  const b1 = g.filter('bandpass', f1, 5), b2 = g.filter('bandpass', f2, 7), b2g = g.gain(0.6);
  sum.connect(b1); b1.connect(env); sum.connect(b2); b2.connect(b2g); b2g.connect(env); env.connect(out);
  const vib = g.osc('sine', 5.2, t, end), vg = g.gain(14);
  vib.connect(vg);
  for (let i = 0; i < 5; i++) {
    const f0 = auRand(110, 260), o = g.osc('sawtooth', f0, t, end), a = g.gain(0.2);
    o.frequency.setValueAtTime(f0, t); o.frequency.linearRampToValueAtTime(f0 * glide, t + dur);
    vg.connect(o.detune); o.connect(a); a.connect(sum);
  }
}

const AU_PROP_SPECS = {
  pinball:    { y: 0.9, gap: [4, 12], range: 12,
                sounds: [[5, auVoicePinballBurst], [2, auVoicePinballChime], [1.5, auVoiceFlipper], [1, auVoicePinRoll]] },
  claw:       { y: 1.0, gap: [6, 16], range: 12,
                sounds: [[3, auVoiceClawJingle], [3, auVoiceClawWhir], [1, auVoiceClawDrop], [0.6, auVoiceClawWin]] },
  airhockey:  { y: 0.9, gap: [3, 9], range: 12, sounds: [[5, auVoicePuckVolley], [1, auVoicePuckGoal]] },
  prize:      { y: 1.1, gap: [5, 12], range: 14, spread: 3, sounds: [[4, auVoicePrizePrint], [2, auVoicePrizeBell], [0.8, auVoiceCoinCascade]] },
  vending:    { y: 1.0, gap: [16, 40], range: 10, sounds: [[3, auVoiceVendingHum], [1, auVoiceCanDrop]] },
  change:     { y: 1.0, gap: [8, 22], range: 11, sounds: [[3, auVoiceCoinCascade], [1, auVoiceCoinBounce]] },
  scoreboard: { y: 2.8, gap: [7, 18], range: 12, sounds: [[4, auVoiceScoreFlip], [1, auVoiceScoreBeep]] },
  sign:       { y: 2.8, gap: [12, 30], range: 8, sounds: [[1, auVoiceCrackle]] },
};
const AU_STREET_CARS = { gap: [16, 40], range: 40, lp: 900, send: 0.5, pan: { ref: 3, rolloff: 1.1 },
                         sounds: [[4, auVoiceCarPass], [0.6, auVoiceHorn]] };
const AU_DOOR_CHIME = { gap: [35, 80], range: 40, pan: { ref: 3, rolloff: 1.1 }, sounds: [[1, auVoiceDoorChime]] };
// Anywhere-in-the-room sounds at a random spot.
const AU_GLOBAL_SPECS = [
  { y: 0.2, gap: [5, 13], range: 40, where: auCoinSpot, sounds: [[3, auVoiceCoinBounce], [1, auVoiceCoinCascade]] },
  { y: 1.6, gap: [14, 32], range: 40, lp: 1700, send: 0.5, level: 1, where: auFarSpot, pan: { ref: 3, rolloff: 1.2 }, sounds: [[1, auVoiceCrowd]] },
];

function auCoinSpot(p) { p.x = auRand(-9, 9); p.z = auRand(-6, 6); }
function auFarSpot(p) {                                      // somewhere in the room at least 6 m from the listener
  for (let i = 0; i < 8; i++) {
    p.x = auRand(-9, 9); p.z = auRand(-6, 6);
    if (Math.hypot(p.x - auRt.lx, p.z - auRt.lz) > 6) return;
  }
}

// Plays one event of an emitter spec at (x, y, z).
function auFire(ac, spec, x, y, z, now) {
  if (!auCanSpawn(24)) return;
  const g = new AuGroup(ac), bus = auRt.bus;
  const pan = g.panner(x, y, z, spec.pan);
  const send = g.gain(spec.send === undefined ? AU_PROP_SEND : spec.send);
  pan.connect(bus.dry); pan.connect(send); send.connect(bus.reverbIn);
  const level = g.gain(spec.level === undefined ? AU_PROP_LEVEL : spec.level);
  if (spec.lp) { const lp = g.filter('lowpass', spec.lp, 0.5); level.connect(lp); lp.connect(pan); }
  else level.connect(pan);
  auPickWeighted(spec.sounds)(g, level, now + 0.02, pan);
}

function auRunEmitters(ac, now) {
  let fired = 0;
  for (const e of auRt.emitters) {
    const spec = e.spec;
    if (e.next === 0) e.next = now + auRand(0.4, spec.gap[1]);
    if (now < e.next) continue;
    e.next = now + auRand(spec.gap[0], spec.gap[1]);
    let x = e.x, z = e.z;
    if (spec.where) { spec.where(auRt.spot); x = auRt.spot.x; z = auRt.spot.z; }
    else if (spec.spread) x += auRand(-spec.spread, spec.spread);
    if (fired >= 3 || Math.hypot(x - auRt.lx, z - auRt.lz) > spec.range) continue;
    auFire(ac, spec, x, e.y, z, now);
    fired++;
  }
}

// Mirrors registry.cabinets / registry.props (which may be filled after setupAudio) into audio state.
function auSyncRegistry() {
  const cabs = registry.cabinets;
  for (; auRt.cabsSeen < cabs.length; auRt.cabsSeen++) {
    const c = cabs[auRt.cabsSeen];
    if (c && Number.isFinite(c.x) && Number.isFinite(c.z)) {
      const style = auStyleFor(c, auRt.cabsSeen);
      auRt.cabs.push({ x: c.x, y: 1.5, z: c.z, rot: c.rot || 0, family: style.family, seed: style.seed, state: 'off',
                       song: null, dist: 99, score: 99, want: false, killAt: 0, g: null });
    }
  }
  const props = registry.props;
  for (; auRt.propsSeen < props.length; auRt.propsSeen++) {
    const p = props[auRt.propsSeen], spec = p && AU_PROP_SPECS[p.kind];
    if (spec && Number.isFinite(p.x) && Number.isFinite(p.z)) {
      auRt.emitters.push({ spec, x: p.x, y: Number.isFinite(p.y) ? p.y : spec.y, z: p.z, next: 0 });
    }
  }
}

// ═══════════════ Footsteps ═══════════════
function auFootstep(ac, running) {
  if (!auCanSpawn(6)) return;
  const idx = auRt.stepIdx++, g = new AuGroup(ac);
  const src = g.buf(auRt.buffers[idx & 1 ? 'footfall2' : 'footfall'], ac.currentTime + 0.005, { rate: auRand(0.88, 1.15) * (running ? 1.08 : 1) });
  const amp = g.gain(AU_FOOTSTEP * (running ? 1.35 : 1) * auRand(0.75, 1.15));
  src.connect(amp);
  let last = amp;
  if (ac.createStereoPanner) { const p = g.add(ac.createStereoPanner()); p.pan.value = idx & 1 ? 0.18 : -0.18; amp.connect(p); last = p; }
  last.connect(auRt.bus.dry);
}

// ═══════════════ Scheduler and per-frame update ═══════════════

// One scheduler pass at audio time `now`.
function auStep(ac, now) {
  auCollect(now);
  auSyncRegistry();
  auSelectCabs(ac, now);
  for (const cab of auRt.cabs) {
    if (cab.state === 'on') auCabTick(ac, cab, now);
    else if (cab.state === 'fading' && now > cab.killAt) auCabKill(cab);
  }
  auRunEmitters(ac, now);
}

function auTick() {
  const ac = audioState.ctx;
  if (!ac || document.hidden) return;
  if (audioState.muted) {                                    // muted: stop scheduling, park the context once the fade is done
    auCollect(ac.currentTime);
    if (ac.state === 'running' && ac.currentTime - auRt.mutedAt > 0.6) {
      for (const c of auRt.cabs) if (c.state !== 'off') auCabKill(c);
      auSuspend(ac);
    }
    return;
  }
  if (ac.state !== 'running') return;
  try { auStep(ac, ac.currentTime); auRt.errors = 0; }
  catch (e) { auRt.lastError = e; if (++auRt.errors > 5) clearInterval(auRt.timer); }   // never let audio take the page down
}

// Fader target: 0 when muted, quieter while the overlay is showing (mouse not captured).
function auApplyMaster(ac) {
  const target = audioState.muted ? 0 : AU_MASTER * (document.pointerLockElement === canvas ? 1 : AU_DUCK);
  if (target === auRt.masterTarget) return;
  auRt.masterTarget = target;
  auRt.bus.master.gain.setTargetAtTime(target, ac.currentTime, audioState.muted ? 0.06 : 0.12);
}

// Per-frame work: listener pose, master fader, footsteps. Must stay cheap.
function auUpdate(ac, dt) {
  const x = player.x, z = player.z, cp = Math.cos(player.pitch);
  auRt.lx = x; auRt.lz = z;
  auSetListener(ac, x, EYE_HEIGHT, z, -Math.sin(player.yaw) * cp, Math.sin(player.pitch), -Math.cos(player.yaw) * cp);
  auApplyMaster(ac);

  const d = Math.hypot(x - auRt.px, z - auRt.pz);
  auRt.px = x; auRt.pz = z;
  if (d > 0.5) { auRt.moving = false; return; }              // teleport (not walking): no footsteps
  if (d < 1e-5) { auRt.moving = false; return; }
  const running = d / Math.max(dt, 1e-3) > 4.25, stepLen = running ? 1.1 : 0.8;
  if (!auRt.moving) { auRt.moving = true; auRt.stride = stepLen * 0.6; }    // first footfall comes quickly after starting
  auRt.stride += d;
  if (auRt.stride >= stepLen) { auRt.stride -= stepLen; if (ac.state === 'running') auFootstep(ac, running); }
}

// ═══════════════ Public entry points ═══════════════

// resume()/suspend() return promises in current browsers but nothing in very old ones; never let either throw.
function auResume(ac) {
  try {
    const p = ac.state !== 'running' && ac.resume && ac.resume();
    if (p && p.catch) p.catch(() => {});
  } catch (e) { /* closed context */ }
}
function auSuspend(ac) {
  try {
    const p = ac.suspend && ac.suspend();
    if (p && p.catch) p.catch(() => {});
  } catch (e) { /* closed context */ }
}

// Builds the whole graph on a context (real or offline).
function auInit(ac) {
  audioState.ctx = ac;
  auRt.buffers = auMakeBuffers(ac);
  auRt.bus = auBuildMaster(ac);
  auRt.ambience = auBuildRoomTone(ac, auRt.bus);
  auSyncRegistry();
  auRt.street = auBuildStreet(ac, auRt.bus);
  for (const spec of AU_GLOBAL_SPECS) auRt.emitters.push({ spec, x: 0, y: spec.y, z: 0, next: 0 });
  auRt.px = player.x; auRt.pz = player.z;
}

function auGesture() {
  if (!audioState.ctx) startAudio();
  else if (!audioState.muted) auResume(audioState.ctx);
}

function setupAudio() {
  // Sound can only start from a user gesture, so just listen for one (startAudio() is also called on pointer lock).
  if (auRt.gestureBound) return;
  auRt.gestureBound = true;
  addEventListener('pointerdown', auGesture, true);
  addEventListener('keydown', auGesture, true);
  document.addEventListener('visibilitychange', () => {      // pause everything while the tab is in the background
    const ac = audioState.ctx;
    if (!ac) return;
    if (document.hidden) { if (ac.state === 'running') auSuspend(ac); }
    else if (!audioState.muted) auResume(ac);
  });
}

function startAudio() {
  if (audioState.ctx) { if (!audioState.muted) auResume(audioState.ctx); return; }
  if (audioState.failed) return;
  const Ctor = window.AudioContext || window.webkitAudioContext;
  if (!Ctor) { audioState.failed = true; return; }
  try {
    const ac = new Ctor();
    auInit(ac);
    audioState.started = true;
    auRt.timer = setInterval(auTick, AU_TICK_MS);
    auResume(ac);
    auApplyMaster(ac);
  } catch (e) {
    audioState.failed = true; audioState.ctx = null;
    console.warn('Audio unavailable:', e && e.message);
  }
}

function toggleMute() {
  audioState.muted = !audioState.muted;
  hudMessage(audioState.failed ? 'Sound unavailable' : audioState.muted ? 'Sound off (M)' : 'Sound on (M)');
  const ac = audioState.ctx;
  if (!ac) return;
  if (audioState.muted) auRt.mutedAt = ac.currentTime;
  else auResume(ac);                                          // wake the context if it was parked while muted
  auApplyMaster(ac);
}

function updateAudio(dt) {
  const ac = audioState.ctx;
  if (!ac) return;
  if (ac.state !== 'running') { auRt.px = player.x; auRt.pz = player.z; return; }
  try { auUpdate(ac, dt); } catch (e) { auRt.lastError = e; }
}

window.__audio = { audioState, auRt, AuGroup, auInit, auStep, auUpdate, auTick, auMakeBuffers, auMakeSong, auStyleFor, auBuildMaster, auBuildRoomTone, auCabBuild, auCabAdvance, auCabActivate, auFire, auLoopNoise, auMakeImpulse, auPulseWave, AU_SFX, AU_PROP_SPECS, AU_GLOBAL_SPECS, AU_FAMILIES, AU_STREET_CARS, AU_DOOR_CHIME, auSoftClipCurve };   //@@DEBUG
