// The launch screen (index.html #launch-screen, styles/launch-screen.css):
// the Oculith monolith whose eye follows the pointer and wanders when it is
// still, smoke rising behind it, the edition's name and what is loading.
// Start-up (boot.js) drives it. An add-on may use the side slot.

const root = () => document.getElementById('launch-screen');
const reduceMotion = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
const MIN_SHOWN_MS = 1800; // long enough to be seen, even when start-up is quick
const shownAt = performance.now();
let stopped = false;

/** The composition's word under the monolith. */
export function setEdition(word) {
  const el = document.getElementById('lsWord');
  if (!el || el.textContent === word) return;
  el.textContent = word;
  el.classList.remove('ls-shown');
  void el.offsetWidth;
  el.classList.add('ls-shown');
}

/** Keep the started composition's word and name for the next launch's first paint (index.html). */
export function rememberIdentity(word, title) {
  try { localStorage.setItem('ocudraw.launchIdentity', JSON.stringify({ word, title })); }
  catch { /* the next launch shows the word once the composition loads */ }
}

/** What is loading, under the edition. */
export function setStatus(text) {
  const el = document.getElementById('lsStatus');
  if (el) el.textContent = text;
}

// No room beside the monolith: the card takes the middle (styles/launch-screen.css).
const NARROW = '(max-width: 760px), (max-height: 600px)';

// The monolith and the side card as one group, centred in the window: the
// card's middle level with the monolith's middle, a gap between them.
function placeSide() {
  const el = root();
  const stage = document.getElementById('lsStage');
  const card = document.getElementById('lsSide');
  if (!el || !stage || !card) return;
  const s = stage.getBoundingClientRect();
  const narrow = window.matchMedia ? window.matchMedia(NARROW).matches : window.innerWidth <= 760;
  const cardW = card.offsetWidth || Math.min(380, window.innerWidth * 0.34);
  const gap = Math.max(48, window.innerWidth * 0.05);
  const total = s.width + gap + cardW;
  // The pair wider than the window (the stage is sized by its height): stacked as well.
  const stacked = !narrow && total > window.innerWidth - 32;
  el.classList.toggle('ls-side-stacked', stacked);
  if (narrow || stacked) { el.style.removeProperty('--ls-shift'); card.style.removeProperty('left'); card.style.removeProperty('top'); return; }
  const left = (window.innerWidth - total) / 2;
  const monoCentre = left + s.width / 2;
  // The stage's centre without the shift (it is centred in the window).
  el.style.setProperty('--ls-shift', `${(monoCentre - window.innerWidth / 2).toFixed(1)}px`);
  card.style.left = `${(left + s.width + gap).toFixed(1)}px`;
  // Level with the monolith's middle, but never past the window's edges
  // (a card taller than the window is capped and scrolls).
  const half = Math.min(card.offsetHeight || 420, window.innerHeight - 32) / 2 + 16;
  const middle = Math.min(Math.max(s.top + s.height / 2, half), window.innerHeight - half);
  card.style.top = `${middle.toFixed(1)}px`;
}

/** The side slot (an element) and its open / close, for an edition plug-in. */
export function side() {
  const el = document.getElementById('lsSide');
  const onResize = () => placeSide();
  return {
    element: el,
    open: () => {
      placeSide();
      window.addEventListener('resize', onResize);
      root()?.classList.add('ls-side-open');
    },
    close: () => {
      window.removeEventListener('resize', onResize);
      root()?.classList.remove('ls-side-open');
    },
  };
}

/**
 * Offer installed add-on actions after the editor is ready. Only a click runs
 * one. `copy` may replace the card's eyebrow, title, description and the
 * label of the button that continues without an action.
 */
export async function showLaunchActions(actions, copy = {}) {
  const slot = side();
  if (!slot.element || !Array.isArray(actions) || !actions.length) return;
  const card = document.createElement('div');
  card.className = 'ls-addon-card';
  card.dataset.addonLaunch = '';
  const eyebrow = document.createElement('p');
  eyebrow.className = 'ls-addon-eyebrow';
  eyebrow.textContent = copy.eyebrow || 'READY TO WORK';
  const title = document.createElement('h2');
  title.textContent = copy.title || 'Open your workspace';
  const description = document.createElement('p');
  description.className = 'ls-addon-description';
  description.textContent = copy.description || 'Choose an add-on action, or continue to your drawing workspace.';
  const choices = document.createElement('div');
  choices.className = 'ls-addon-choices';
  const notice = document.createElement('p');
  notice.className = 'ls-addon-notice';
  notice.setAttribute('role', 'status');
  card.append(eyebrow, title, description, choices, notice);
  const available = actions.flatMap((action) => {
    try {
      const label = action.label();
      return typeof label === 'string' && label.trim() ? [{ action, label: label.trim() }] : [];
    } catch { return []; }
  });
  if (!available.length) return;
  await new Promise((resolve) => {
    let finished = false;
    const done = () => {
      if (finished) return;
      finished = true;
      slot.close();
      resolve();
    };
    for (const { action, label } of available) {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'ls-addon-action';
      button.textContent = label;
      button.addEventListener('click', async () => {
        button.disabled = true;
        try { await action.run(); done(); }
        catch { notice.textContent = 'This action could not open. Try again or continue.'; button.disabled = false; }
      });
      choices.append(button);
    }
    const continueButton = document.createElement('button');
    continueButton.type = 'button';
    continueButton.className = 'ls-addon-continue';
    continueButton.textContent = copy.continueLabel || 'Continue to workspace';
    continueButton.addEventListener('click', done);
    choices.append(continueButton);
    slot.element.replaceChildren(card);
    slot.open();
  });
}

/** Fade the launch screen out (after its minimum time) and remove it. */
export async function finish() {
  const el = root();
  if (!el) return;
  const wait = MIN_SHOWN_MS - (performance.now() - shownAt);
  if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
  el.classList.add('ls-done');
  await new Promise((resolve) => setTimeout(resolve, reduceMotion ? 0 : 750));
  stopped = true;
  el.remove();
}

// The eye follows the pointer; when the pointer is still it glances around.
function wanderingEye(stage) {
  const pupil = stage.querySelector('.ls-mono .ls-pupil');
  if (!pupil || reduceMotion) return;
  let tx = 0, ty = 0, raf = 0, lastMove = 0;
  const set = () => {
    raf = 0;
    stage.style.setProperty('--ex', tx.toFixed(2));
    stage.style.setProperty('--ey', ty.toFixed(2));
  };
  const lookAt = (x, y) => {
    const r = pupil.getBoundingClientRect();
    const dx = x - (r.left + r.width / 2), dy = y - (r.top + r.height / 2);
    const d = Math.hypot(dx, dy) || 1;
    const reach = Math.min(1, d / 420); // near the eye: a small glance
    tx = (dx / d) * 15 * reach;          // the eye is narrow: less sideways
    ty = (dy / d) * 30 * reach;
    if (!raf) raf = requestAnimationFrame(set);
  };
  window.addEventListener('pointermove', (e) => {
    if (stopped) return;
    lastMove = performance.now();
    lookAt(e.clientX, e.clientY);
  }, { passive: true });
  const wander = () => {
    if (stopped) return;
    if (performance.now() - lastMove > 2500) {
      const a = Math.random() * Math.PI * 2, m = 0.35 + Math.random() * 0.65;
      tx = Math.cos(a) * 15 * m; ty = Math.sin(a) * 30 * m;
      if (!raf) raf = requestAnimationFrame(set);
    }
    setTimeout(wander, 2200 + Math.random() * 2400);
  };
  setTimeout(wander, 900);
}

// Smoke behind the monolith: domain-warped noise rising, densest behind the
// eye, in WebGL with no library; the CSS haze stays where WebGL is missing.
const SMOKE_FS = `
precision mediump float;
uniform vec2 uRes; uniform vec2 uEye; uniform float uT;
float hash(vec2 p){ return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
float noise(vec2 p){
  vec2 i = floor(p), f = fract(p); f = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash(i), hash(i + vec2(1.0, 0.0)), f.x),
             mix(hash(i + vec2(0.0, 1.0)), hash(i + vec2(1.0, 1.0)), f.x), f.y);
}
float fbm(vec2 p){
  float v = 0.0, a = 0.5; mat2 m = mat2(1.6, 1.2, -1.2, 1.6);
  for (int i = 0; i < 5; i++) { v += a * noise(p); p = m * p; a *= 0.5; }
  return v;
}
void main(){
  vec2 uv = gl_FragCoord.xy / uRes;
  vec2 p = (uv - uEye) * vec2(uRes.x / uRes.y, 1.0);
  float t = uT * 0.045;
  vec2 b = p * 1.7 + vec2(0.0, -t);
  vec2 q = vec2(fbm(b), fbm(b + vec2(5.2, 1.3)));
  vec2 r = vec2(fbm(b + 3.2 * q + vec2(1.7, 9.2) + 0.15 * t),
                fbm(b + 3.2 * q + vec2(8.3, 2.8) - 0.12 * t));
  float d = fbm(b + 3.6 * r);
  float w = 0.5 + 0.32 * smoothstep(0.7, -0.3, p.y);
  float env = smoothstep(1.05, 0.1, length(vec2(p.x / w, (p.y - 0.02) * 0.8)));
  env *= smoothstep(-0.98, -0.62, p.y) * smoothstep(0.85, 0.42, p.y);
  float s = clamp((d - 0.25) * 2.15, 0.0, 1.0) * env;
  float core = smoothstep(0.62, 0.0, length(p * vec2(1.35, 0.85)));
  vec3 ember = vec3(0.15, 0.065, 0.016);
  vec3 col = mix(ember, vec3(0.5, 0.19, 0.015), smoothstep(0.25, 0.7, s));
  col = mix(col, vec3(1.0, 0.48, 0.04), smoothstep(0.5, 0.92, s) * core);
  float a = clamp(s * (0.74 + 0.3 * core), 0.0, 0.9);
  a += (hash(gl_FragCoord.xy + uT) - 0.5) / 255.0;
  gl_FragColor = vec4(col * a, a);
}`;

function smoke(stage) {
  const cv = stage.querySelector('.ls-smoke');
  const gl = cv?.getContext('webgl', { alpha: true, premultipliedAlpha: true, antialias: false, powerPreference: 'low-power' });
  if (!gl) return;
  const sh = (type, src) => { const o = gl.createShader(type); gl.shaderSource(o, src); gl.compileShader(o); return o; };
  const prog = gl.createProgram();
  gl.attachShader(prog, sh(gl.VERTEX_SHADER, 'attribute vec2 a;void main(){gl_Position=vec4(a,0.0,1.0);}'));
  gl.attachShader(prog, sh(gl.FRAGMENT_SHADER, SMOKE_FS));
  gl.linkProgram(prog);
  if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) return;
  gl.useProgram(prog);
  gl.bindBuffer(gl.ARRAY_BUFFER, gl.createBuffer());
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
  const loc = gl.getAttribLocation(prog, 'a');
  gl.enableVertexAttribArray(loc);
  gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);
  const uRes = gl.getUniformLocation(prog, 'uRes'), uEye = gl.getUniformLocation(prog, 'uEye'), uT = gl.getUniformLocation(prog, 'uT');
  const fit = () => {
    const r = cv.getBoundingClientRect();
    const k = Math.min(window.devicePixelRatio || 1, 1.5) * 0.5;
    cv.width = Math.max(2, Math.round(r.width * k));
    cv.height = Math.max(2, Math.round(r.height * k));
    gl.viewport(0, 0, cv.width, cv.height);
    gl.uniform2f(uRes, cv.width, cv.height);
    // The eye sits at y 318 of the slab's 640, centred.
    const cx = stage.offsetWidth / 2 - cv.offsetLeft;
    const cy = stage.offsetHeight * (318 / 640) - cv.offsetTop;
    gl.uniform2f(uEye, cx / cv.offsetWidth, 1 - cy / cv.offsetHeight);
  };
  const t0 = performance.now() - 40000; // mid-drift from the first frame
  const draw = (now) => { gl.uniform1f(uT, (now - t0) / 1000); gl.drawArrays(gl.TRIANGLES, 0, 3); };
  fit();
  draw(performance.now());
  stage.classList.add('smoke-on');
  if (reduceMotion) return;
  let last = 0;
  const tick = (now) => {
    if (stopped) return;
    requestAnimationFrame(tick);
    if (now - last < 32) return; // ~30 fps is plenty for smoke
    last = now;
    draw(now);
  };
  requestAnimationFrame(tick);
  window.addEventListener('resize', () => { if (!stopped) { fit(); draw(performance.now()); } });
}

/** Start the eye and the smoke. */
export function startLaunchScreen() {
  const stage = document.getElementById('lsStage');
  if (!stage) return;
  wanderingEye(stage);
  try { smoke(stage); } catch { /* the CSS haze stands in */ }
}
