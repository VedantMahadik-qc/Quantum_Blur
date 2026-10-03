// Quantum Reel: one photo -> escalating Moth quantum edits -> a beat-synced vertical video.
//
// Pipeline: the framed photo is uploaded once, then every step is dispatched to Moth at once,
// each running the engine on the photo at an escalating strength (step N is the climax).
// They run in parallel rather than as a daisy chain because Moth's queue time ranges from
// seconds to hours, and a chain would wait in that queue once per step. Until a quantum result
// lands its frame is a classical canvas stand-in, so the reel plays immediately and sharpens
// as Moth answers.
//
// Video: frames are cut on the beat grid of a synthesized soundtrack. Every cut gets a flash,
// a zoom punch and a chromatic-aberration burst; the climax strobes back through the whole
// chain before slamming onto the final frame. Playback is clocked by the audio, and export
// records the canvas and the music into one file with MediaRecorder.

const $ = (s) => document.querySelector(s);
const mkCanvas = (w, h) => Object.assign(document.createElement('canvas'), { width: w, height: h });
const ctxOf = (c) => c.getContext('2d');
const ease = (a) => a * a * (3 - 2 * a);
const r3 = (v) => Math.round(v * 1000) / 1000;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const hz = (m) => 440 * 2 ** ((m - 69) / 12);
const fmtTime = (s) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;
function mulberry32(a) {
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const STORE = 'quantum-reel-v1';
const POLL_MS = 2500;

// work: the size sent to Moth (engines top out at 1024 px a side); out: the video size
const FORMATS = {
  reel: { work: [576, 1024], out: [720, 1280] },
  square: { work: [1024, 1024], out: [1080, 1080] },
};

// lo..hi is the strength range a reel climbs through; the preset's curve shapes the climb.
// preview() is the classical stand-in shown until the quantum frame arrives.
const ENGINES = {
  'blur-v1': {
    name: 'Quantum Blur', input: 'image', lo: 0.05, hi: 0.8,
    params: (s, last) => ({ strength: r3(s), reach: last ? 0.3 : 0, style: 'rx' }),
    preview(x, photo, s, w, h) {
      x.filter = `blur(${(s * Math.max(w, h) * 0.03).toFixed(1)}px) saturate(${1 + 0.3 * s})`;
      x.drawImage(photo, 0, 0, w, h);
    },
  },
  'deep-fryer-v1': {
    name: 'Quantum Deep Fryer', input: 'image', lo: 0.08, hi: 0.9,
    params: (s, last) => ({ gates: last ? [['rx', r3(s)], ['ry', r3(s * 0.6)]] : [['rx', r3(s)]], tile_size: 4 }),
    preview(x, photo, s, w, h) {
      x.filter = `saturate(${1 + 3 * s}) contrast(${1 + 1.2 * s}) hue-rotate(${Math.round(s * 120)}deg)`;
      x.drawImage(photo, 0, 0, w, h);
    },
  },
  'telablur-v1': {
    name: 'Quantum Teleblur', input: 'image1', target: true, lo: 0.12, hi: 1,
    params: (s) => ({ strength: r3(s), direction: 'full' }),
    preview(x, photo, s, w, h, target) {
      x.drawImage(photo, 0, 0, w, h);
      x.globalAlpha = s;
      x.filter = `blur(${((1 - Math.abs(2 * s - 1)) * w * 0.012).toFixed(1)}px)`;
      x.drawImage(target, 0, 0, w, h);
    },
  },
};

const PRESETS = {
  glitch: { name: 'The Cyber Glitch', blurb: 'Fast cuts, strobe flashes, heavy glitch', steps: 8, track: 'cyber',
    curve: (k, n) => k / n },
  bloom: { name: 'Decoherence Bloom', blurb: 'Smooth quantum blur with chromatic pulses', steps: 6, track: 'lofi',
    curve: (k, n) => (k / n) ** 1.6 },
  drop: { name: 'The Beat Drop', blurb: 'Slow build through 4 subtle steps, then rapid-fire cuts', steps: 8, track: 'phonk',
    curve: (k, n) => (k <= 4 ? 0.2 * k / 4 : 0.45 + 0.55 * (k - 4) / (n - 4)) },
};

const TRACKS = {
  cyber: { name: 'Cyberpunk Bass', bpm: 120, beats: 24 },
  phonk: { name: 'Hard Phonk', bpm: 140, beats: 32 },
  lofi: { name: 'Lo-Fi Chill', bpm: 90, beats: 16, lowpass: 4200 },
  none: { name: 'No music (120 BPM grid)', bpm: 120, beats: 24 },
};

// ---------- state ----------
const S = { engine: 'blur-v1', preset: 'glitch', track: 'cyber', format: 'reel', fit: 'crop', muted: false };
let photo = null;      // the user's image (HTMLImageElement)
let customTarget = null;  // optional Teleblur target
let work = null;       // photo framed to the format at Moth's size: frame 0 of every reel
let reel = null;       // the current reel (see generate)
let timeline = null;   // beat-grid events for reel.preset x S.track

// ---------- images ----------
function loadImg(src) {
  return new Promise((res, rej) => {
    const im = new Image();
    im.onload = () => res(im);
    im.onerror = () => rej(new Error(`could not load ${src}`));
    im.src = src;
  });
}
function toCanvas(img, w, h) {
  const c = mkCanvas(w, h);
  ctxOf(c).drawImage(img, 0, 0, w, h);
  return c;
}
const blobOf = (canvas, type = 'image/png', q) => new Promise((r) => canvas.toBlob(r, type, q));

// Fit the photo to the format: crop to fill, or letterbox over a blurred copy of itself.
function framePhoto(img, [w, h], fit) {
  const c = mkCanvas(w, h), x = ctxOf(c);
  const iw = img.naturalWidth || img.width, ih = img.naturalHeight || img.height;
  const cover = Math.max(w / iw, h / ih), contain = Math.min(w / iw, h / ih);
  const draw = (k) => x.drawImage(img, (w - iw * k) / 2, (h - ih * k) / 2, iw * k, ih * k);
  if (fit === 'crop') draw(cover);
  else {
    x.filter = 'blur(28px) brightness(0.5) saturate(1.4)';
    draw(cover * 1.12);
    x.filter = 'none';
    draw(contain);
  }
  return c;
}

// Default Teleblur target: the photo re-imagined as a neon two-slit interference pattern.
function interference(src) {
  const { width: w, height: h } = src, c = mkCanvas(w, h), x = ctxOf(c);
  x.drawImage(src, 0, 0);
  const img = x.getImageData(0, 0, w, h), d = img.data;
  const sources = [[0.28, 0.3], [0.72, 0.42], [0.5, 0.82]].map(([a, b]) => [a * w, b * h]);
  const k = (2 * Math.PI) / (Math.max(w, h) * 0.05);
  const pal = [[12, 6, 40], [139, 92, 246], [34, 230, 255], [255, 79, 216]];
  for (let py = 0; py < h; py++) {
    for (let px = 0; px < w; px++) {
      const i = (py * w + px) * 4;
      const lum = (0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2]) / 255;
      let phase = 0;
      for (const [sx, sy] of sources) phase += Math.cos(Math.hypot(px - sx, py - sy) * k);
      const v = Math.min(0.999, Math.max(0, 0.5 + 0.5 * Math.cos(phase * 1.2 + lum * 5)));
      const f = v * (pal.length - 1), j = Math.floor(f), t = f - j, a = pal[j], b = pal[j + 1];
      for (let ch = 0; ch < 3; ch++) d[i + ch] = Math.min(255, a[ch] + (b[ch] - a[ch]) * t + lum * 70);
    }
  }
  x.putImageData(img, 0, 0);
  return c;
}

// ---------- api ----------
async function api(path, body) {
  const r = await fetch(path, body ? { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body) } : undefined);
  const d = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(d.error || `${r.status} ${r.statusText}`);
  return d;
}
async function uploadCanvas(canvas, name) {
  const blob = await blobOf(canvas, 'image/jpeg', 0.92);
  const r = await fetch('/api/upload', { method: 'POST', body: blob,
    headers: { 'Content-Type': 'image/jpeg', 'X-Filename': name } });
  const d = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(d.error || 'upload failed');
  return d.asset_id;
}

// ---------- quantum pipeline ----------
class Superseded extends Error {}

function rebuildPreviews(R) {
  const E = ENGINES[R.engine], [w, h] = FORMATS[R.format].work;
  for (let k = 1; k <= R.n; k++) {
    if (R.steps[k - 1].quantum) continue;
    const c = mkCanvas(w, h), x = ctxOf(c);
    E.preview(x, R.frames[0], R.strengths[k - 1], w, h, R.target);
    R.frames[k] = c;
  }
}

async function generate() {
  if (!work) return;
  ensureAudio();
  const E = ENGINES[S.engine], P = PRESETS[S.preset], n = P.steps;
  const strengths = Array.from({ length: n }, (_, i) => E.lo + (E.hi - E.lo) * P.curve(i + 1, n));
  const R = reel = {
    engine: S.engine, preset: S.preset, format: S.format, fit: S.fit, n, strengths,
    target: E.target ? (customTarget ? framePhoto(customTarget, FORMATS[S.format].work, 'crop') : interference(work)) : null,
    steps: strengths.map(() => ({ status: 'pending' })), frames: [work],
    stage: 'upload', error: null, startedAt: Date.now(),
  };
  rebuildPreviews(R);
  rebuildTimeline();
  updateControls();
  play(0);
  renderProgress();
  const alive = () => reel === R;
  try {
    const photoAsset = await uploadCanvas(work, 'photo.jpg');
    const targetAsset = R.target ? await uploadCanvas(R.target, 'target.jpg') : null;
    if (!alive()) return;
    R.stage = 'quantum';
    const res = await Promise.allSettled(R.steps.map((_, i) => runStep(R, i + 1, photoAsset, targetAsset)));
    const bad = res.find((r) => r.status === 'rejected');
    if (bad) throw bad.reason;
    R.stage = 'shaders';
    renderProgress();
    await sleep(500);  // let the final frames decode before calling it done
    if (!alive()) return;
    R.stage = 'done';
  } catch (e) {
    if (e instanceof Superseded || !alive()) return;
    R.stage = 'error';
    R.error = e.message;
  }
  renderProgress();
  updateControls();
}

async function runStep(R, k, inputAsset, targetAsset) {
  const E = ENGINES[R.engine], st = R.steps[k - 1], [w, h] = FORMATS[R.format].work;
  const files = { [E.input]: `asset:${inputAsset}` };
  if (E.target) files.image2 = `asset:${targetAsset}`;
  Object.assign(st, { status: 'submitting', since: Date.now() });
  renderProgress();
  const job = await api('/api/run', { engine: R.engine, params: E.params(R.strengths[k - 1], k === R.n), files });
  if (reel !== R) throw new Superseded();
  Object.assign(st, { status: 'queued', jobId: job.job_id });
  renderProgress();
  for (;;) {
    let r = null;
    try { r = await api(`/api/job/${job.job_id}`); } catch { /* transient: try again */ }
    if (reel !== R) throw new Superseded();
    if (r?.status === 'completed') {
      const aid = r.outputs?.[0]?.asset_id;
      if (!aid) throw new Error(`Step ${k} finished without an image`);
      R.frames[k] = toCanvas(await loadImg(`/api/asset/${aid}`), w, h);
      Object.assign(st, { status: 'completed', quantum: true, assetId: aid });
      renderProgress();
      return aid;
    }
    if (['failed', 'error', 'cancelled'].includes(r?.status)) {
      st.status = 'failed';
      throw new Error(`Step ${k} failed on Moth: ${r.error || r.status}`);
    }
    if (r?.status === 'processing' || r?.status === 'running') st.status = 'processing';
    renderProgress();
    await sleep(POLL_MS);
  }
}

function renderProgress() {
  const R = reel, box = $('#progress');
  box.hidden = !R;
  if (!R) return;
  const n = R.n, landed = R.steps.filter((s) => s.quantum).length;
  const weight = { completed: 1, processing: 0.6, queued: 0.3, submitting: 0.12 };
  let frac = 0.06 + 0.9 * R.steps.reduce((a, s) => a + (weight[s.status] || 0), 0) / n, msg;
  const dispatched = R.steps.filter((s) => s.jobId).length;
  const running = R.steps.some((s) => s.status === 'processing');
  if (R.stage === 'upload') { msg = 'Uploading photo to Moth…'; frac = 0.03; }
  else if (R.stage === 'shaders') { msg = 'Applying Transition Shaders…'; frac = 0.98; }
  else if (R.stage === 'done') { msg = `Quantum Reel ready · ${n}/${n} quantum frames`; frac = 1; }
  else if (R.stage === 'error') msg = `${R.error}. Missing frames use classical previews; press Generate to retry.`;
  else if (dispatched < n) msg = `Dispatching Quantum Circuit ${Math.min(n, dispatched + 1)}/${n}…`;
  else msg = `Sampling Wavepacket ${Math.min(n, landed + 1)}/${n}…${running ? '' : ' (waiting in the Moth queue)'}`;
  box.classList.toggle('busy', !['done', 'error'].includes(R.stage));
  box.classList.toggle('err', R.stage === 'error');
  $('#bar').style.width = `${Math.round(frac * 100)}%`;
  $('#msg').textContent = msg;
  const dots = $('#dots');
  if (dots.children.length !== n) dots.innerHTML = '<i></i>'.repeat(n);
  R.steps.forEach((s, i) => {
    dots.children[i].className = s.quantum ? 'ok' : s.status === 'failed' ? 'bad'
      : ['submitting', 'queued', 'processing'].includes(s.status) ? 'run' : '';
    dots.children[i].title = `Step ${i + 1}: ${s.quantum ? 'quantum ✓' : s.status}`;
  });
  renderElapsed();
  const badge = $('#badge');
  badge.hidden = false;
  badge.classList.toggle('q', landed === n);
  badge.textContent = landed === n ? 'Quantum ✓' : `Classical preview · ${landed}/${n} quantum`;
}
function renderElapsed() {
  const R = reel;
  $('#elapsed').textContent = R && !['done', 'error'].includes(R.stage) ? fmtTime((Date.now() - R.startedAt) / 1000) : '';
}
setInterval(renderElapsed, 1000);

// ---------- beat-grid timeline ----------
// Events sit on beats. An event with `frame` is a cut to that frame (optionally a crossfade);
// every event is also a "hit" that fires a flash, zoom punch, chromatic burst and glitch.
function buildTimeline(presetId, n, trackId) {
  const T = TRACKS[trackId], spb = 60 / T.bpm, B = T.beats;
  const ev = [];
  const at = (beat, o) => ev.push({ beat, t: beat * spb, flash: 0, zoom: 0, ca: 0, glitch: 0, tint: 'white', ...o });
  const toBar = (x) => 4 * Math.max(1, Math.round(x / 4));
  const q = (x, g) => Math.round(x / g) * g;
  // `count` beats spread over [from, to) snapped to the grid, strictly increasing
  const spread = (count, from, to, grid) => {
    const out = [];
    for (let k = 0, last = -Infinity; k < count; k++) {
      last = Math.max(last + grid, from + q((k * (to - from)) / count, grid));
      out.push(last);
    }
    return out;
  };
  const strobe = (from, step, tint) => { // the climax: every earlier state in quick succession
    for (let j = 0; j < n; j++) at(from + j * step, { frame: j, flash: 0.45, zoom: 0.04, ca: 0.8, glitch: 0.8, tint: j % 2 ? 'white' : tint });
  };
  const rnd = mulberry32(n * 7919 + B);
  let drift = () => 1;

  if (presetId === 'glitch') {
    const slam = toBar(B / 2), buildEnd = slam - n * 0.25;
    spread(n, 0, buildEnd, 0.5).forEach((b, k) =>
      at(b, { frame: k, flash: 0.85, zoom: 0.08, ca: 1, glitch: 0.6, tint: k % 2 ? 'cyan' : 'white' }));
    strobe(buildEnd, 0.25, 'cyan');
    at(slam, { frame: n, flash: 1, zoom: 0.12, ca: 1.8, glitch: 1 });
    const rewind = B - (n - 1) * 0.25;  // the loop ends by rewinding the chain in sixteenths
    for (let b = slam + 1; b < rewind; b++) {
      at(b, { flash: 0.3, zoom: 0.08, ca: 0.9, glitch: 0.35, tint: b % 2 ? 'cyan' : 'white' });
      if ((b - slam) % 2 === 1 && b + 1 < rewind) {  // stutter back into the chain on the off-beat
        at(b + 0.5, { frame: 1 + Math.floor(rnd() * (n - 1)), flash: 0.25, ca: 1.2, glitch: 1, tint: 'cyan' });
        at(b + 0.75, { frame: n, ca: 0.6, glitch: 0.5 });
      }
    }
    for (let j = 1; j < n; j++) at(rewind + (j - 1) * 0.25, { frame: n - j, flash: 0.2, ca: 0.6, glitch: 0.7, tint: 'cyan' });
    drift = (t) => 1 + 0.015 * Math.sin(t * 0.9);
  } else if (presetId === 'bloom') {
    const slam = toBar(B * 0.625), buildEnd = slam - n * 0.25;
    const beats = spread(n, 0, buildEnd, 1);
    beats.forEach((b, k) => {
      const gap = (beats[k + 1] ?? buildEnd) - b;
      at(b, { frame: k, fade: k ? Math.min(1.5, gap * 0.6) * spb : 0, flash: k ? 0.12 : 0.5, tint: 'cyan', zoom: 0.03, ca: 1 });
      for (let p = b + 1; p < b + gap; p++) at(p, { ca: 0.45, zoom: 0.015 });  // chromatic pulse on each beat
    });
    strobe(buildEnd, 0.25, 'violet');
    at(slam, { frame: n, flash: 0.75, tint: 'cyan', zoom: 0.08, ca: 1.6 });
    for (let b = slam + 1; b < B; b++) at(b, { flash: b % 4 === 0 ? 0.25 : 0.1, tint: 'violet', zoom: 0.04, ca: 0.8 });
    const dur = B * spb;
    drift = (t) => 1 + 0.06 * (t / dur);  // slow push-in across the whole reel
  } else {  // drop
    const subtle = Math.min(4, n - 2), rapid = (n - 1 - subtle) * 0.5;
    const slam = toBar(B * 0.625), buildEnd = slam - n * 0.25 - rapid;
    const beats = spread(subtle + 1, 0, buildEnd, 1);
    beats.forEach((b, k) => {
      const gap = (beats[k + 1] ?? buildEnd) - b;
      at(b, { frame: k, fade: k ? Math.min(1, gap * 0.5) * spb : 0, flash: k ? 0 : 0.6, zoom: 0.02, ca: 0.3 });
    });
    // riser: pulses on every beat, doubling to eighths in the last bar, growing toward the drop
    for (let p = 1; p < buildEnd; p += p >= buildEnd - 4 ? 0.5 : 1) {
      if (beats.includes(p)) continue;
      const r = p / buildEnd;
      at(p, { ca: 0.2 + 0.8 * r, zoom: 0.01 + 0.03 * r, flash: r > 0.8 ? 0.15 : 0, tint: 'cyan' });
    }
    for (let j = 0; j < n - 1 - subtle; j++)
      at(buildEnd + j * 0.5, { frame: subtle + 1 + j, flash: 0.8, zoom: 0.08, ca: 1.2, glitch: 0.5, tint: j % 2 ? 'cyan' : 'white' });
    strobe(buildEnd + rapid, 0.25, 'cyan');
    at(slam, { frame: n, flash: 1, zoom: 0.14, ca: 2.2, glitch: 1 });
    for (let b = slam + 1; b < B; b++) at(b, { flash: 0.4, zoom: 0.08, ca: 1, glitch: b % 2 ? 0.4 : 0, tint: b % 2 ? 'cyan' : 'white' });
    const riseEnd = buildEnd * spb;
    drift = (t) => (t < riseEnd ? 1 + 0.1 * ease(t / riseEnd) : 1);  // push in through the build, snap out on the drop
  }
  ev.sort((a, b) => a.t - b.t);
  return { ev, cuts: ev.filter((e) => e.frame !== undefined), dur: B * spb, spb, drift };
}

function rebuildTimeline() {
  timeline = reel ? buildTimeline(reel.preset, reel.n, S.track) : null;
}

// ---------- compositor ----------
const view = $('#view'), vx = ctxOf(view);
const buf = { comp: null, r: null, g: null, b: null, vignette: null, w: 0, h: 0 };
const TINTS = { white: '#ffffff', cyan: '#7ff6ff', violet: '#c4a6ff' };

function ensureBuffers(w, h) {
  if (view.width !== w || view.height !== h) { view.width = w; view.height = h; }
  if (buf.w === w && buf.h === h) return;
  Object.assign(buf, { w, h, comp: mkCanvas(w, h), r: mkCanvas(w, h), g: mkCanvas(w, h), b: mkCanvas(w, h), vignette: mkCanvas(w, h) });
  const x = ctxOf(buf.vignette), grad = x.createRadialGradient(w / 2, h / 2, Math.min(w, h) * 0.35, w / 2, h / 2, Math.hypot(w, h) / 2);
  grad.addColorStop(0, 'rgba(0,0,0,0)');
  grad.addColorStop(1, 'rgba(0,0,0,0.5)');
  x.fillStyle = grad;
  x.fillRect(0, 0, w, h);
}

function stateAt(t) {
  const { ev, cuts } = timeline;
  let hi = -1, ci = -1;
  for (let i = 0; i < ev.length && ev[i].t <= t; i++) hi = i;
  for (let i = 0; i < cuts.length && cuts[i].t <= t; i++) ci = i;
  const cut = cuts[ci >= 0 ? ci : cuts.length - 1];
  const prev = cuts[ci > 0 ? ci - 1 : cuts.length - 1];
  return { cut, prev, hi, uc: ci >= 0 ? t - cut.t : Infinity };
}

// Effects of the hits still ringing at time t. Overlapping hits (fast strobes) take the
// strongest value of each effect instead of restarting it, so pulses don't stutter.
function hitFx(t, hi, w) {
  const fx = { flash: 0, zoom: 0, ca: 0, glitch: 0, tint: 'white', seed: hi * 97 };
  const f = 1 / 30;  // flashes last one or two video frames
  for (let i = hi; i >= 0; i--) {
    const e = timeline.ev[i], u = t - e.t;
    if (u > 0.4) break;
    const flash = e.flash * (u < f ? 1 : u < 2 * f ? 0.4 : 0);
    if (flash > fx.flash) { fx.flash = flash; fx.tint = e.tint; }
    fx.zoom = Math.max(fx.zoom, e.zoom * (u < 0.05 ? u / 0.05 : Math.max(0, 1 - (u - 0.05) / 0.3) ** 2));  // 1.0 -> 1.08 -> 1.0
    fx.ca = Math.max(fx.ca, e.ca * w * 0.02 * Math.max(0, 1 - u / 0.15) ** 1.5);  // 0.15 s chromatic burst, in px
    if (u < 0.12 && e.glitch > fx.glitch) { fx.glitch = e.glitch; fx.seed = i * 97 + Math.floor(u * 30); }
  }
  return fx;
}

function drawScaled(x, img, s, w, h) {
  x.drawImage(img, (w - w * s) / 2, (h - h * s) / 2, w * s, h * s);
}

function renderReel(t) {
  const R = reel, [w, h] = FORMATS[R.format].out;
  ensureBuffers(w, h);
  const { cut, prev, hi, uc } = stateAt(t);
  const fx = hitFx(t, hi, w), s = (1 + fx.zoom) * timeline.drift(t);

  const cx = ctxOf(buf.comp);
  cx.globalAlpha = 1;
  cx.fillStyle = '#000';
  cx.fillRect(0, 0, w, h);
  const fade = cut.fade && uc < cut.fade ? ease(uc / cut.fade) : 1;
  if (fade < 1) drawScaled(cx, R.frames[prev.frame], s, w, h);
  cx.globalAlpha = fade;
  drawScaled(cx, R.frames[cut.frame], s, w, h);
  cx.globalAlpha = 1;

  if (fx.ca > 0.5) chroma(buf.comp, fx.ca, w, h);
  else vx.drawImage(buf.comp, 0, 0);
  if (fx.glitch > 0) glitch(buf.comp, fx.glitch, w, h, fx.seed);
  vx.drawImage(buf.vignette, 0, 0);
  if (fx.flash > 0) {
    vx.globalAlpha = Math.min(1, fx.flash);
    vx.fillStyle = TINTS[fx.tint] || TINTS.white;
    vx.fillRect(0, 0, w, h);
    vx.globalAlpha = 1;
  }
}

// Split into R, G, B and re-add them offset: a chromatic aberration of `off` px.
function chroma(src, off, w, h) {
  for (const [c, col] of [[buf.r, '#f00'], [buf.g, '#0f0'], [buf.b, '#00f']]) {
    const x = ctxOf(c);
    x.globalCompositeOperation = 'copy';
    x.drawImage(src, 0, 0);
    x.globalCompositeOperation = 'multiply';
    x.fillStyle = col;
    x.fillRect(0, 0, w, h);
    x.globalCompositeOperation = 'source-over';
  }
  vx.fillStyle = '#000';
  vx.fillRect(0, 0, w, h);
  vx.globalCompositeOperation = 'lighter';
  vx.drawImage(buf.r, -off, 0);
  vx.drawImage(buf.g, 0, off * 0.2);
  vx.drawImage(buf.b, off, 0);
  vx.globalCompositeOperation = 'source-over';
}

// Displace a few horizontal bands sideways, some tinted: a digital-glitch tear.
function glitch(src, amt, w, h, seed) {
  const rnd = mulberry32(seed);
  for (let i = 0, count = Math.round(2 + 7 * amt); i < count; i++) {
    const bh = (0.008 + rnd() * 0.06) * h, y = rnd() * (h - bh), dx = (rnd() * 2 - 1) * w * 0.09 * amt;
    vx.drawImage(src, 0, y, w, bh, dx, y, w, bh);
    if (rnd() < 0.35) {
      vx.globalCompositeOperation = 'screen';
      vx.fillStyle = rnd() < 0.5 ? 'rgba(34,230,255,0.35)' : 'rgba(255,79,216,0.3)';
      vx.fillRect(0, y, w, bh);
      vx.globalCompositeOperation = 'source-over';
    }
  }
}

function renderStill() {
  const [w, h] = FORMATS[S.format].out;
  ensureBuffers(w, h);
  vx.fillStyle = '#000';
  vx.fillRect(0, 0, w, h);
  if (work) vx.drawImage(work, 0, 0, w, h);
}

// ---------- soundtracks (synthesized, so royalty-free by construction) ----------
const SR = 44100;

function synth(ctx, out) {
  const noise = ctx.createBuffer(1, SR, SR);
  { const d = noise.getChannelData(0), r = mulberry32(7); for (let i = 0; i < d.length; i++) d[i] = r() * 2 - 1; }
  const vca = (t, peak, a, d, dest = out) => {
    const g = ctx.createGain();
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(peak, t + a);
    g.gain.exponentialRampToValueAtTime(0.0005, t + a + d);
    g.gain.setValueAtTime(0, t + a + d + 0.001);
    g.connect(dest);
    return g;
  };
  const noiseAt = (t, len) => {
    const s = ctx.createBufferSource();
    s.buffer = noise; s.loop = true;
    s.start(t, (t * 7.31) % 0.9);
    s.stop(t + len);
    return s;
  };
  const filt = (type, f, Q, dest) => {
    const b = ctx.createBiquadFilter();
    b.type = type; b.frequency.value = f; b.Q.value = Q;
    b.connect(dest);
    return b;
  };
  const pan = (p, dest) => { const s = ctx.createStereoPanner(); s.pan.value = p; s.connect(dest); return s; };
  const osc = (type, f, t, len, dest) => {
    const o = ctx.createOscillator();
    o.type = type; o.frequency.value = f;
    o.connect(dest); o.start(t); o.stop(t + len + 0.05);
    return o;
  };
  const shaper = (amt, dest) => {
    const w = ctx.createWaveShaper(), c = new Float32Array(1024);
    for (let i = 0; i < c.length; i++) { const x = i / 511.5 - 1; c[i] = Math.tanh(x * amt) / Math.tanh(amt); }
    w.curve = c; w.connect(dest);
    return w;
  };
  return {
    kick(t, v = 1, f0 = 160, f1 = 44, len = 0.42) {
      const o = osc('sine', f0, t, len, vca(t, v, 0.002, len));
      o.frequency.setValueAtTime(f0, t);
      o.frequency.exponentialRampToValueAtTime(f1, t + 0.11);
      noiseAt(t, 0.03).connect(filt('highpass', 3000, 0.7, vca(t, v * 0.25, 0.001, 0.015)));
    },
    snare(t, v = 0.5, len = 0.18) {
      noiseAt(t, len + 0.05).connect(filt('bandpass', 1900, 0.7, vca(t, v, 0.001, len)));
      const o = osc('triangle', 220, t, 0.12, vca(t, v * 0.6, 0.001, 0.09));
      o.frequency.setValueAtTime(220, t);
      o.frequency.exponentialRampToValueAtTime(160, t + 0.06);
    },
    clap(t, v = 0.5) {
      for (const [dt, len] of [[0, 0.012], [0.011, 0.012], [0.022, 0.16]])
        noiseAt(t + dt, len + 0.03).connect(filt('bandpass', 1250, 1.1, vca(t + dt, v, 0.001, len)));
    },
    hat(t, v = 0.15, open = false, p = 0) {
      noiseAt(t, 0.4).connect(filt('highpass', 7500, 0.8, vca(t, v, 0.001, open ? 0.22 : 0.035, pan(p, out))));
    },
    saw(t, f, len, v, cut = 1200, q = 4, env = 2) {  // detuned saw pair into an enveloped resonant lowpass
      const lp = ctx.createBiquadFilter();
      lp.type = 'lowpass'; lp.Q.value = q;
      lp.frequency.setValueAtTime(cut * env, t);
      lp.frequency.exponentialRampToValueAtTime(cut, t + Math.min(len, 0.2));
      lp.connect(vca(t, v, 0.004, len));
      for (const d of [-8, 8]) osc('sawtooth', f, t, len, lp).detune.value = d;
    },
    b808(t, f, len, v = 0.8, glideTo = 0, drive = 2.5) {
      const o = osc('sine', f, t, len, shaper(drive, vca(t, v, 0.005, len)));
      if (glideTo) {
        o.frequency.setValueAtTime(f, t + len * 0.55);
        o.frequency.exponentialRampToValueAtTime(glideTo, t + len * 0.8);
      }
    },
    bell(t, f, v = 0.2, len = 0.3) {  // 808-style cowbell: two squares through a bandpass
      const bp = filt('bandpass', f * 1.25, 1.4, vca(t, v, 0.001, len));
      osc('square', f, t, len, bp);
      osc('square', f * 1.48, t, len, bp);
    },
    keys(t, notes, len, v = 0.1) {  // soft e-piano chord
      const lp = filt('lowpass', 2400, 0.5, vca(t, v, 0.015, len));
      for (const m of notes) {
        osc('sine', hz(m), t, len, lp);
        osc('triangle', hz(m), t, len, lp).detune.value = 6;
      }
    },
    sub(t, f, len, v = 0.3) { osc('sine', f, t, len, vca(t, v, 0.01, len)); },
    crackle(t, dur, v = 0.5) {  // vinyl hiss and pops
      const len = Math.ceil(dur * SR), b = ctx.createBuffer(1, len, SR), d = b.getChannelData(0), r = mulberry32(99);
      for (let i = 0; i < len; i++) d[i] = (r() - 0.5) * 0.05 + (r() < 0.0004 ? (r() - 0.5) * 1.4 : 0);
      const s = ctx.createBufferSource();
      s.buffer = b;
      const g = ctx.createGain();
      g.gain.value = v;
      s.connect(filt('bandpass', 2500, 0.4, g));
      g.connect(out);
      s.start(t);
    },
  };
}

const SONGS = {
  cyber(X, spb, B) {  // A minor, four-on-the-floor, rolling octave saw bass that opens up over the loop
    const roots = [33, 33, 29, 31, 33, 28];
    for (let b = 0; b < B; b++) {
      const t = b * spb, bar = Math.floor(b / 4), beat = b % 4, root = roots[bar % roots.length];
      const chord = root === 29 || root === 31 ? [0, 4, 7, 12] : [0, 3, 7, 12];
      X.kick(t, 1);
      if (beat % 2 === 1) X.clap(t, 0.5);
      for (let s = 0; s < 4; s++) {
        const ts = t + (s * spb) / 4;
        X.hat(ts, s === 2 ? 0.09 : s % 2 ? 0.06 : 0.04, s === 2, s % 2 ? 0.25 : -0.25);
        if (s) X.saw(ts, hz(root + (s === 2 ? 12 : 0)), (spb / 4) * 0.85, 0.3, 260 + (1400 * b) / B, 6, 3);
      }
      if (bar >= 2) for (let e = 0; e < 2; e++) X.saw(t + (e * spb) / 2, hz(root + 36 + chord[(b * 2 + e) % 4]), spb * 0.4, 0.07, 2200, 2, 2);
      if (bar === B / 4 - 1 && beat === 3) for (let s = 0; s < 4; s++) X.snare(t + (s * spb) / 4, 0.2 + 0.1 * s);
    }
  },
  phonk(X, spb, B) {  // F# minor drift phonk: cowbell riff, distorted 808 slides, half-time snare
    const roots = [30, 30, 26, 28];
    const bellA = [78, 0, 81, 78, 85, 0, 83, 81, 78, 0, 81, 83, 81, 78, 76, 78];
    const bellB = [85, 0, 83, 85, 88, 0, 85, 83, 81, 0, 83, 81, 78, 0, 76, 81];
    for (let b = 0; b < B; b++) {
      const t = b * spb, bar = Math.floor(b / 4), beat = b % 4, root = roots[bar % 4];
      if (beat === 0) {
        X.kick(t, 1, 170, 40, 0.5);
        X.b808(t, hz(root), spb * 1.9, 0.8, bar % 4 === 3 ? hz(root + 5) : 0);
      }
      if (beat === 1) X.kick(t + spb / 2, 0.85, 170, 40, 0.4);
      if (beat === 2) {
        X.snare(t, 0.55, 0.22);
        X.clap(t, 0.45);
        X.b808(t + spb / 2, hz(root), spb * 1.4, 0.7);
      }
      if (beat === 3 && bar % 2 === 1) for (let k = 0; k < 6; k++) X.hat(t + (k * spb) / 6, 0.05 + 0.012 * k, false, 0.2);
      else for (let e = 0; e < 2; e++) X.hat(t + (e * spb) / 2, e ? 0.09 : 0.06, false, 0.15);
      const bell = bar >= 4 ? bellB : bellA, i0 = (b % 8) * 2;
      for (let e = 0; e < 2; e++) if (bell[i0 + e]) X.bell(t + (e * spb) / 2, hz(bell[i0 + e]), 0.17, spb * 0.45);
    }
  },
  lofi(X, spb, B) {  // swung boom-bap under Fmaj7 - Em7 - Dm7 - Cmaj7, with vinyl crackle
    const chords = [[53, 57, 60, 64], [52, 55, 59, 62], [50, 53, 57, 60], [48, 52, 55, 59]];
    const sw = spb * 0.58;  // swung off-beat
    for (let b = 0; b < B; b++) {
      const t = b * spb, bar = Math.floor(b / 4), beat = b % 4, ch = chords[bar % 4];
      if (beat === 0) {
        X.kick(t, 0.8, 120, 45, 0.35);
        X.keys(t, ch, spb * 2.2, 0.09);
        X.sub(t, hz(ch[0] - 24), spb * 1.6, 0.35);
      }
      if (beat === 2) {
        X.kick(t + sw, 0.65, 120, 45, 0.3);
        X.keys(t + sw, ch.slice(1), spb * 1.3, 0.07);
        X.sub(t + sw, hz(ch[0] - 17), spb, 0.28);
      }
      if (beat % 2 === 1) X.snare(t, 0.22, 0.14);
      X.hat(t, 0.04, false, -0.2);
      X.hat(t + sw, 0.028, false, 0.2);
    }
    X.crackle(0, B * spb + 2, 0.5);
  },
};

// Render one loop offline. The tail past the loop point is folded back onto the start so
// notes ring across the seam, then the loop is normalized.
async function renderTrack(id) {
  const T = TRACKS[id], spb = 60 / T.bpm, len = Math.round(T.beats * spb * SR), tail = 2 * SR;
  const ctx = new OfflineAudioContext(2, len + tail, SR);
  const comp = ctx.createDynamicsCompressor();
  comp.threshold.value = -14; comp.ratio.value = 4; comp.attack.value = 0.003; comp.release.value = 0.15;
  comp.connect(ctx.destination);
  let bus = comp;
  if (T.lowpass) {
    bus = ctx.createBiquadFilter();
    bus.type = 'lowpass'; bus.frequency.value = T.lowpass;
    bus.connect(comp);
  }
  SONGS[id](synth(ctx, bus), spb, T.beats);
  const rendered = await ctx.startRendering();
  const out = new AudioBuffer({ length: len, numberOfChannels: 2, sampleRate: SR });
  let peak = 0;
  for (let c = 0; c < 2; c++) {
    const d = rendered.getChannelData(c), o = out.getChannelData(c);
    o.set(d.subarray(0, len));
    for (let i = 0; i < tail; i++) o[i] += d[len + i];
    for (let i = 0; i < len; i++) peak = Math.max(peak, Math.abs(o[i]));
  }
  const k = peak > 0 ? 0.89 / peak : 1;
  for (let c = 0; c < 2; c++) { const o = out.getChannelData(c); for (let i = 0; i < len; i++) o[i] *= k; }
  return out;
}
const trackCache = {};
const trackBuffer = (id) => (id === 'none' ? Promise.resolve(null) : (trackCache[id] ||= renderTrack(id)));

// ---------- playback (clocked by the audio so cuts stay on the beat) ----------
let actx = null, monitor = null, recordDest = null;
const player = { playing: false, pausedAt: 0, clock: null, src: null, token: 0 };

function ensureAudio() {
  if (!actx) {
    actx = new AudioContext();
    monitor = actx.createGain();
    monitor.gain.value = S.muted ? 0 : 1;
    monitor.connect(actx.destination);
    recordDest = actx.createMediaStreamDestination();
  }
  if (actx.state === 'suspended') actx.resume();
}

function stopAudio() {
  if (player.src) { try { player.src.stop(); } catch { /* already stopped */ } player.src.disconnect(); player.src = null; }
}

async function play(from = 0) {
  if (!reel) return;
  const token = ++player.token;
  stopAudio();
  const dur = timeline.dur;
  from = ((from % dur) + dur) % dur;
  let buffer = null;
  if (actx && S.track !== 'none') {
    player.pausedAt = from;
    player.playing = false;
    setPlayIcon();
    buffer = await trackBuffer(S.track);
    if (token !== player.token) return;  // something else started meanwhile
  }
  if (buffer) {
    const src = actx.createBufferSource();
    src.buffer = buffer;
    src.loop = true;
    src.connect(monitor);
    src.connect(recordDest);
    const when = actx.currentTime + 0.05;
    src.start(when, from);
    player.src = src;
    player.clock = () => actx.currentTime - when + from;
  } else {
    const t0 = performance.now();
    player.clock = () => (performance.now() - t0) / 1000 + from;
  }
  player.playing = true;
  setPlayIcon();
}
function pause() {
  player.pausedAt = now();
  player.token++;
  stopAudio();
  player.playing = false;
  setPlayIcon();
}
function now() {
  if (!player.playing) return player.pausedAt;
  const t = Math.max(0, player.clock());
  return timeline ? t % timeline.dur : t;
}
function setPlayIcon() { $('#play').textContent = player.playing ? '❚❚' : '▶'; }

let lastTimeText = '';
function frameLoop() {
  requestAnimationFrame(frameLoop);
  if (reel && timeline) {
    const t = now();
    renderReel(t);
    const txt = `${fmtTime(t)} / ${fmtTime(timeline.dur)}`;
    if (txt !== lastTimeText) $('#time').textContent = lastTimeText = txt;
  } else renderStill();
}

// ---------- export ----------
let recorder = null;

function pickType() {
  if (!window.MediaRecorder) return null;
  return ['video/mp4;codecs=avc1.640028,mp4a.40.2', 'video/mp4;codecs=avc1.4d0028,mp4a.40.2',
    'video/mp4;codecs=avc1.42e01e,mp4a.40.2', 'video/mp4', 'video/webm;codecs=vp9,opus',
    'video/webm;codecs=vp8,opus', 'video/webm'].find((t) => MediaRecorder.isTypeSupported(t)) || null;
}

function recordStream() {
  const tracks = [...view.captureStream(30).getVideoTracks()];
  if (S.track !== 'none') tracks.push(...recordDest.stream.getAudioTracks());
  return new MediaStream(tracks);
}

// Chrome's encoder drops about a second of frames the first time it records, so the first
// export starts with a short throwaway recording.
let encoderWarm = false;
async function warmEncoder(type) {
  if (encoderWarm) return;
  const rec = new MediaRecorder(recordStream(), { mimeType: type });
  const stopped = new Promise((r) => { rec.onstop = r; });
  rec.start();
  await sleep(1200);
  rec.stop();
  await stopped;
  encoderWarm = true;
}

// The export is a real-time recording of one loop. A hidden tab stops drawing frames, so
// hiding the tab (or pausing / regenerating) cancels the export instead of saving a frozen video.
async function exportVideo() {
  const type = pickType();
  if (!reel || recorder || !type) return;
  const btn = $('#download'), label = btn.textContent;
  const notice = (text) => {
    btn.textContent = text;
    setTimeout(() => { if (!recorder) btn.textContent = label; }, 3000);
  };
  if (document.hidden) return notice('Keep this tab visible to export');
  ensureAudio();
  recorder = { cancelled: null };
  btn.disabled = true;
  btn.textContent = 'Preparing…';
  let chunks = [];
  try {
    await play(0);
    await warmEncoder(type);
    const rec = new MediaRecorder(recordStream(), { mimeType: type, videoBitsPerSecond: 10e6, audioBitsPerSecond: 192e3 });
    rec.ondataavailable = (e) => e.data.size && chunks.push(e.data);
    const done = new Promise((r) => { rec.onstop = r; });
    await play(0);
    rec.start(250);
    btn.textContent = '● Recording…';
    btn.classList.add('recording');
    const startClock = player.clock, dur = timeline.dur;
    const timer = setInterval(() => {  // not tied to animation frames, which stop in hidden tabs
      if (document.hidden) recorder.cancelled = 'Keep this tab visible to export';
      else if (!player.playing || player.clock !== startClock) recorder.cancelled = 'Export cancelled';
      else if (startClock() < dur + 0.08) return;
      clearInterval(timer);
      rec.stop();
    }, 50);
    await done;
  } finally {
    btn.classList.remove('recording');
    btn.textContent = label;
    btn.disabled = false;
  }
  const { cancelled } = recorder;
  recorder = null;
  if (cancelled) return notice(cancelled);
  const ext = type.startsWith('video/mp4') ? 'mp4' : 'webm';
  const blob = new Blob(chunks, { type: type.split(';')[0] });
  window.lastReel = blob;  // handy for checking the export from the console
  const a = Object.assign(document.createElement('a'), { download: `quantum-reel-${reel.preset}.${ext}`, href: URL.createObjectURL(blob) });
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 60000);
}

async function saveFinalFrame() {
  if (!reel) return;
  const [w, h] = FORMATS[reel.format].out, c = toCanvas(reel.frames[reel.n], w, h);
  const a = Object.assign(document.createElement('a'), { download: 'quantum-reel-final.png', href: URL.createObjectURL(await blobOf(c)) });
  a.click();
}

// ---------- inputs ----------
// The photo is normalized to a JPEG of at most 1600 px and that same JPEG is what gets
// restored after a reload, so regenerating later re-uploads identical bytes and the server
// cache hands back the jobs that already ran.
async function setPhoto(file) {
  if (!file?.type.startsWith('image/')) return;
  const raw = await loadImg(URL.createObjectURL(file));
  const k = Math.min(1, 1600 / Math.max(raw.width, raw.height));
  const url = toCanvas(raw, Math.round(raw.width * k), Math.round(raw.height * k)).toDataURL('image/jpeg', 0.9);
  photo = await loadImg(url);
  $('#thumb').src = url;
  $('#thumb').hidden = false;
  $('#dropText').textContent = file.name;
  try { localStorage.setItem(`${STORE}:photo`, url); } catch { /* too big for storage: it just won't be restored */ }
  reframe();
}
async function setTarget(file) {
  if (!file?.type.startsWith('image/')) return;
  const url = URL.createObjectURL(file);
  customTarget = await loadImg(url);
  $('#targetThumb').src = url;
  $('#targetThumb').hidden = false;
  $('#targetText').textContent = `Morph target: ${file.name}`;
  markStale();
}

// A new photo or framing invalidates the reel, so drop it and show the framed photo.
function reframe() {
  if (photo) work = framePhoto(photo, FORMATS[S.format].work, S.fit);
  if (reel) { pause(); reel = null; timeline = null; }
  renderProgress();
  updateControls();
}

function markStale() {
  $('#generate').classList.toggle('stale', !!reel && (reel.engine !== S.engine || reel.preset !== S.preset));
}

function updateControls() {
  const has = !!reel;
  $('#empty').hidden = !!work;
  $('#generate').disabled = !work;
  $('#hint').hidden = !work || has;
  $('#badge').hidden = !has;
  for (const id of ['#play', '#download', '#saveFrame']) $(id).disabled = !has;
  $('#download').textContent = `⬇ Download ${pickType()?.startsWith('video/webm') ? 'WebM' : 'MP4'}`;
  if (!pickType()) { $('#download').disabled = true; $('#download').title = 'This browser cannot record video'; }
  if (!has) $('#time').textContent = '0:00 / 0:00';
  $('#targetDrop').hidden = !ENGINES[S.engine].target;
  setSeg('#format', S.format);
  setSeg('#fit', S.fit);
  document.querySelectorAll('.preset').forEach((b) => {
    b.classList.toggle('on', b.dataset.v === S.preset);
    b.setAttribute('aria-checked', b.dataset.v === S.preset);
  });
  $('#engine').value = S.engine;
  $('#track').value = S.track;
  $('#mute').textContent = S.muted ? '🔇' : '🔊';
  markStale();
}
function setSeg(sel, v) {
  document.querySelectorAll(`${sel} button`).forEach((b) => {
    b.classList.toggle('on', b.dataset.v === v);
    b.setAttribute('aria-checked', b.dataset.v === v);
  });
}

// ---------- persistence (settings + photo, per browser) ----------
function saveSettings() { try { localStorage.setItem(STORE, JSON.stringify(S)); } catch { /* storage off */ } }

// ---------- wiring ----------
for (const [id, E] of Object.entries(ENGINES)) $('#engine').add(new Option(E.name, id));
for (const [id, T] of Object.entries(TRACKS)) $('#track').add(new Option(id === 'none' ? T.name : `${T.name} · ${T.bpm} BPM`, id));
for (const [id, P] of Object.entries(PRESETS)) {
  const b = Object.assign(document.createElement('button'), { type: 'button', className: 'preset' });
  b.dataset.v = id;
  b.setAttribute('role', 'radio');
  b.innerHTML = `<b></b><span class="bpm">${P.steps} steps</span><small></small>`;
  b.querySelector('b').textContent = P.name;
  b.querySelector('small').textContent = P.blurb;
  b.onclick = () => {
    S.preset = id;
    S.track = P.track;  // each vibe comes with its matching beat; the dropdown can still change it
    saveSettings();
    onTrackChange();
    updateControls();
  };
  $('#presets').appendChild(b);
}
$('#engine').onchange = (e) => { S.engine = e.target.value; saveSettings(); updateControls(); };
$('#track').onchange = (e) => { S.track = e.target.value; saveSettings(); onTrackChange(); };
document.querySelectorAll('#format button').forEach((b) => { b.onclick = () => { S.format = b.dataset.v; saveSettings(); reframe(); }; });
document.querySelectorAll('#fit button').forEach((b) => { b.onclick = () => { S.fit = b.dataset.v; saveSettings(); reframe(); }; });

// The soundtrack only changes the beat grid, not the quantum frames, so it applies live.
function onTrackChange() {
  if (!reel) return;
  const wasPlaying = player.playing, t = now();
  rebuildTimeline();
  if (wasPlaying) play(t);
  else player.pausedAt = t % timeline.dur;
  if (actx && S.track !== 'none') trackBuffer(S.track);
}

$('#generate').onclick = generate;
$('#play').onclick = () => { ensureAudio(); player.playing ? pause() : play(player.pausedAt); };
$('#mute').onclick = () => {
  S.muted = !S.muted;
  if (monitor) monitor.gain.value = S.muted ? 0 : 1;
  saveSettings();
  updateControls();
};
$('#download').onclick = exportVideo;
$('#saveFrame').onclick = saveFinalFrame;
$('#file').onchange = (e) => setPhoto(e.target.files[0]);
$('#targetFile').onchange = (e) => setTarget(e.target.files[0]);
$('#empty').onclick = () => $('#file').click();
document.addEventListener('keydown', (e) => {
  if (e.code === 'Space' && reel && !['INPUT', 'SELECT', 'BUTTON'].includes(e.target.tagName)) {
    e.preventDefault();
    $('#play').click();
  }
});

// drop a photo anywhere; drop onto the target box to set the Teleblur target
function dropZone(el, onFile) {
  el.addEventListener('dragover', (e) => { e.preventDefault(); e.stopPropagation(); el.classList.add('over'); });
  el.addEventListener('dragleave', () => el.classList.remove('over'));
  el.addEventListener('drop', (e) => {
    e.preventDefault(); e.stopPropagation();
    el.classList.remove('over');
    const f = [...e.dataTransfer.files].find((x) => x.type.startsWith('image/'));
    if (f) onFile(f);
  });
}
dropZone($('#targetDrop'), setTarget);
dropZone($('#drop'), setPhoto);
dropZone($('#screen'), setPhoto);
document.addEventListener('dragover', (e) => e.preventDefault());
document.addEventListener('drop', (e) => {
  e.preventDefault();
  const f = [...e.dataTransfer.files].find((x) => x.type.startsWith('image/'));
  if (f) setPhoto(f);
});

// ---------- start ----------
(async function init() {
  try {
    Object.assign(S, JSON.parse(localStorage.getItem(STORE) || '{}'));
    if (!ENGINES[S.engine]) S.engine = 'blur-v1';
    if (!PRESETS[S.preset]) S.preset = 'glitch';
    if (!TRACKS[S.track]) S.track = 'cyber';
    if (!FORMATS[S.format]) S.format = 'reel';
    const saved = localStorage.getItem(`${STORE}:photo`);
    if (saved) {
      photo = await loadImg(saved);
      $('#thumb').src = saved;
      $('#thumb').hidden = false;
      $('#dropText').textContent = 'Last photo (drop a new one to replace)';
      work = framePhoto(photo, FORMATS[S.format].work, S.fit);
    }
  } catch { /* storage unavailable or corrupt: start fresh */ }
  updateControls();
  requestAnimationFrame(frameLoop);
})();
