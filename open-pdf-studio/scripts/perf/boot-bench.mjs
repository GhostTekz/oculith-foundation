// Start-up timing of the web build in headless Chromium: the median of N
// cold starts (a fresh browser context each run) for the time to the launch
// screen's first paint, the time to `ocudraw:ready`, and the JavaScript the
// page fetched and parsed before ready. With --addon, an installed add-on
// directory (manifest.json, plugin.js, plugin.css and any further module
// files) is offered to the editor the way the desktop shell offers it, by
// URL, and served beside the editor's files.
//
// Usage: node scripts/perf/boot-bench.mjs [--dist DIR] [--addon DIR]
//        [--addon-id ID] [--addon-kind edition|contribution] [--runs N]
//        [--cpu RATE] [--label NAME] [--json FILE]
// The page's own start-up steps (js/core/boot-timeline.js) are reported
// too when the build has them. Chromium is CHROMIUM_PATH or /usr/bin/chromium.
import { createServer } from 'node:http';
import { readFile, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const here = path.dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const option = (name, fallback) => {
  const index = args.indexOf(name);
  return index >= 0 && args[index + 1] ? args[index + 1] : fallback;
};
const dist = path.resolve(option('--dist', path.join(here, '../../dist')));
const addonArg = option('--addon', '');
const addon = addonArg ? path.resolve(addonArg) : null;
const addonKind = option('--addon-kind', 'edition');
const runs = Math.max(1, Number(option('--runs', '7')) | 0);
const cpu = Math.max(1, Number(option('--cpu', '1')) || 1);
const label = option('--label', addon ? 'with add-on' : 'editor alone');
const jsonOut = option('--json', '');
const ADDON_PREFIX = '/__boot-bench-addon/';

const TYPES = {
  '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.html': 'text/html',
  '.json': 'application/json', '.wasm': 'application/wasm', '.svg': 'image/svg+xml',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.woff2': 'font/woff2', '.woff': 'font/woff',
  '.ttf': 'font/ttf', '.otf': 'font/otf', '.bcmap': 'application/octet-stream', '.pfb': 'application/octet-stream',
};

async function serveFile(res, root, relative) {
  const file = path.resolve(root, `.${relative}`);
  if (file !== root && !file.startsWith(root + path.sep)) { res.writeHead(403).end(); return; }
  try {
    const info = await stat(file);
    const target = info.isDirectory() ? path.join(file, 'index.html') : file;
    const body = await readFile(target);
    res.writeHead(200, { 'content-type': TYPES[path.extname(target).toLowerCase()] || 'application/octet-stream',
      'cache-control': 'no-store' });
    res.end(body);
  } catch { res.writeHead(404).end(); }
}

const server = createServer((req, res) => {
  const pathname = decodeURIComponent(new URL(req.url, 'http://bench').pathname);
  if (addon && pathname.startsWith(ADDON_PREFIX)) serveFile(res, addon, `/${pathname.slice(ADDON_PREFIX.length)}`);
  else serveFile(res, dist, pathname === '/' ? '/index.html' : pathname);
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const origin = `http://127.0.0.1:${server.address().port}`;

let entry = null;
if (addon) {
  const manifest = JSON.parse(await readFile(path.join(addon, 'manifest.json'), 'utf8').catch(() => '{}'));
  const css = await readFile(path.join(addon, 'plugin.css'), 'utf8').catch(() => '');
  entry = { id: option('--addon-id', manifest.id || 'bench.addon'), kind: addonKind,
    url: `${ADDON_PREFIX}plugin.js`, css };
}

function median(values) {
  const sorted = values.filter(Number.isFinite).sort((a, b) => a - b);
  if (!sorted.length) return null;
  const mid = sorted.length >> 1;
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

async function oneRun(browser) {
  const context = await browser.newContext({ viewport: { width: 1600, height: 1000 } });
  await context.addInitScript({ content: `(() => {
    window.addEventListener('ocudraw:ready', () => { window.__bootBenchReady = performance.now(); }, { once: true });
    // The launch screen is in index.html: the first frame that lays it out
    // with its stylesheet is the first frame that shows it.
    const shown = () => {
      const screen = document.getElementById('launch-screen');
      if (screen && getComputedStyle(screen).position === 'fixed') window.__bootBenchLaunch = performance.now();
      else requestAnimationFrame(shown);
    };
    requestAnimationFrame(shown);
    const entries = ${JSON.stringify(entry ? [entry] : null)};
    if (entries) window.__TAURI__ = { core: { invoke: async (command) => {
      if (command !== 'edition_plugins') return null;
      // The rest of start-up runs as the web build.
      delete window.__TAURI__;
      return entries;
    } } };
  })();` });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('console', (message) => { if (message.type() === 'error') errors.push(`console: ${message.text()}`); });
  if (cpu > 1) {
    const cdp = await context.newCDPSession(page);
    await cdp.send('Emulation.setCPUThrottlingRate', { rate: cpu });
  }
  await page.goto(origin, { waitUntil: 'commit' });
  await page.waitForFunction(() => typeof window.__bootBenchReady === 'number', null, { timeout: 120_000, polling: 50 });
  const result = await page.evaluate((addonPrefix) => {
    const ready = window.__bootBenchReady;
    const paint = performance.getEntriesByType('paint').find((e) => e.name === 'first-paint');
    let jsBytes = 0, jsFiles = 0, addonBytes = 0, addonFiles = 0;
    for (const resource of performance.getEntriesByType('resource')) {
      const url = new URL(resource.name, location.href);
      if (!/\.m?js$/.test(url.pathname) || resource.responseEnd > ready) continue;
      const bytes = resource.decodedBodySize || resource.encodedBodySize || 0;
      jsBytes += bytes; jsFiles += 1;
      if (url.pathname.startsWith(addonPrefix)) { addonBytes += bytes; addonFiles += 1; }
    }
    const steps = typeof globalThis.__ocudrawBootTimeline === 'function' ? globalThis.__ocudrawBootTimeline() : {};
    return { launchScreen: window.__bootBenchLaunch ?? null, fcp: paint?.startTime ?? null,
      ready, jsBytes, jsFiles, addonBytes, addonFiles, steps, edition: globalThis.__ocudrawEdition?.id || null };
  }, ADDON_PREFIX);
  await context.close();
  return { ...result, errors };
}

const browser = await chromium.launch({ headless: true, executablePath: process.env.CHROMIUM_PATH || '/usr/bin/chromium' });
const samples = [];
try {
  await oneRun(browser); // warm the file cache and the browser
  for (let i = 0; i < runs; i++) samples.push(await oneRun(browser));
} finally {
  await browser.close();
  server.close();
}

const steps = {};
for (const sample of samples) {
  for (const [step, ms] of Object.entries(sample.steps)) (steps[step] ||= []).push(ms);
}
const summary = {
  label, runs, cpu, edition: samples[0]?.edition ?? null,
  launchScreenMs: median(samples.map((s) => s.launchScreen)),
  fcpMs: median(samples.map((s) => s.fcp)),
  readyMs: median(samples.map((s) => s.ready)),
  jsBytesBeforeReady: median(samples.map((s) => s.jsBytes)),
  jsFilesBeforeReady: median(samples.map((s) => s.jsFiles)),
  addonBytesBeforeReady: median(samples.map((s) => s.addonBytes)),
  addonFilesBeforeReady: median(samples.map((s) => s.addonFiles)),
  steps: Object.fromEntries(Object.entries(steps)
    .map(([step, values]) => [step, median(values)])
    .sort((a, b) => a[1] - b[1])),
  errors: [...new Set(samples.flatMap((s) => s.errors))],
};
const ms = (v) => (v == null ? '-' : `${Math.round(v)} ms`);
console.log(`${label} (median of ${runs}, CPU x${cpu}, edition ${summary.edition || 'none'})`);
console.log(`  launch screen  ${ms(summary.launchScreenMs)}   (browser first paint ${ms(summary.fcpMs)})`);
console.log(`  ready          ${ms(summary.readyMs)}`);
console.log(`  JS before ready ${(summary.jsBytesBeforeReady / 1e6).toFixed(2)} MB in ${summary.jsFilesBeforeReady} files` +
  (addon ? ` (add-on ${(summary.addonBytesBeforeReady / 1e6).toFixed(2)} MB in ${summary.addonFilesBeforeReady})` : ''));
for (const [step, value] of Object.entries(summary.steps)) console.log(`    ${step.padEnd(20)} ${ms(value)}`);
if (summary.errors.length) console.log(`  page errors: ${summary.errors.join(' | ')}`);
if (jsonOut) await writeFile(jsonOut, `${JSON.stringify({ summary, samples }, null, 2)}\n`);
