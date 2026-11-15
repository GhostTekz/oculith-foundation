// Page navigation in the browser: the mouse wheel and the Navigation bar.
//
// 1. Single-page view with "Mouse wheel changes page: Never" (the default):
//    a wheel at the top or bottom of page 5 keeps page 5, whether one notch,
//    a burst of notches, or a stream of small touchpad deltas with momentum;
//    zoomed in, the wheel still scrolls inside the page. "At page edge" turns
//    one page per wheel gesture. Switching to the continuous view and back
//    keeps the page.
// 2. The Navigation bar: First / Previous / Next / Last keep their position
//    while the page number, the page label, the page size and the scale text
//    change (9 → 10, 99 → 100, 999 → 1000, long labels), at several window
//    widths; twenty quick clicks on Next at one spot advance twenty pages.
//
// Synthetic PDFs only. SMOKE_REPORT=1 prints the measurements without
// asserting (used to measure the behaviour before a change).
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium } from 'playwright';
import { PDFDocument, PDFName, PDFString, StandardFonts } from 'pdf-lib';
import { createServer } from 'vite';

const REPORT = process.env.SMOKE_REPORT === '1';
const check = (ok, message) => { if (REPORT) { if (!ok) console.log(`  (would fail) ${message}`); } else assert.ok(ok, message); };

const directory = await mkdtemp(join(tmpdir(), 'ocudraw-page-navigation-'));
// Sheet sizes that give page-size readouts of different lengths.
const SIZES = [[612, 792], [2592, 1728], [1224, 792], [3370, 2384], [842, 595]];

async function makePdf(name, count, label = null) {
  const pdf = await PDFDocument.create();
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  for (let n = 1; n <= count; n++) {
    const size = SIZES[n % SIZES.length];
    const sheet = pdf.addPage(size);
    sheet.drawText(`Page ${n}`, { x: 40, y: size[1] - 60, size: 28, font });
    // A scale note on some sheets: the scale readout changes length per page.
    if (n % 4 === 1) sheet.drawText('POWER PLAN  SCALE: 1/8" = 1\'-0"', { x: 40, y: 40, size: 12, font });
  }
  if (label) {
    const nums = [];
    for (let n = 1; n <= count; n++) {
      nums.push(n - 1, pdf.context.obj({ P: PDFString.of(label(n)) }));
    }
    pdf.catalog.set(PDFName.of('PageLabels'), pdf.context.obj({ Nums: nums }));
  }
  const file = join(directory, name);
  await writeFile(file, await pdf.save());
  return file;
}

const thousand = await makePdf('thousand.pdf', 1000);
const labelled = await makePdf('labelled.pdf', 12, (n) => (n % 3 === 0
  ? `E-${500 + n}.${n} ELECTRICAL LIGHTING AND POWER PLAN LEVEL ${n} NORTH WING ENLARGED`
  : `E-${n}`));

const server = await createServer({ cacheDir: join(directory, '.vite-cache'),
  server: { host: '127.0.0.1', port: 0, hmr: false }, logLevel: 'error' });
let browser;
const report = {};
try {
  await server.listen();
  browser = await chromium.launch({ headless: true, executablePath: process.env.CHROMIUM_PATH || '/usr/bin/chromium' });
  const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto(server.resolvedUrls.local[0], { waitUntil: 'networkidle' });
  // A cold Vite cache optimises dependencies and reloads the page once.
  await page.locator('.draw-open-button').first().waitFor({ timeout: 60_000 });
  await page.waitForLoadState('networkidle');

  // The test PDFs are served from one fake address; createTab and loadPDF
  // get the same full path.
  await page.route('**/__smoke-pdf/**', async (route) => {
    const file = decodeURIComponent(new URL(route.request().url()).pathname.replace(/^\/__smoke-pdf/, ''));
    await route.fulfill({ status: 200, contentType: 'application/pdf', body: await readFile(file) });
  });
  const open = async (file) => {
    await page.evaluate(async (file) => {
      const bytes = new Uint8Array(await (await fetch(`/__smoke-pdf${encodeURI(file)}`)).arrayBuffer());
      const { createTab } = await import('/js/ui/chrome/tabs.js');
      const { loadPDF } = await import('/js/pdf/loader.js');
      const { index } = createTab(file);
      await loadPDF(file, index, bytes);
    }, file);
    await page.locator('#pdf-container.visible').waitFor();
    await page.locator('#nav-next').waitFor();
    await settle();
  };
  const settle = async () => {
    await page.waitForFunction(() => !window.__pdfRenderInFlight, null, { timeout: 30_000 });
    await page.waitForTimeout(120);
  };
  const current = () => page.evaluate(async () => {
    const { state } = await import('/js/core/state.ts');
    return state.documents[state.activeDocumentIndex]?.currentPage;
  });
  const goTo = async (n) => {
    await page.evaluate(async (n) => (await import('/js/pdf/renderer.js')).goToPage(n), n);
    await settle();
  };
  const setPref = (key, value) => page.evaluate(async ({ key, value }) => {
    const { state } = await import('/js/core/state.ts');
    state.preferences[key] = value;
  }, { key, value });
  const fit = () => page.evaluate(async () => (await import('/js/pdf/renderer.js')).fitPage());
  const scroller = () => page.evaluate(() => {
    const el = document.getElementById('pdf-container');
    return { top: el.scrollTop, max: el.scrollHeight - el.clientHeight };
  });
  const centre = async () => {
    const box = await page.locator('#pdf-container').boundingBox();
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  };
  const notches = async (count, dy, gap = 16) => {
    for (let i = 0; i < count; i++) { await page.mouse.wheel(0, dy); await page.waitForTimeout(gap); }
    await page.waitForTimeout(400);
    await settle();
  };
  // A touchpad fling: small deltas, then a decaying momentum tail.
  const fling = async (sign) => {
    for (let i = 0; i < 30; i++) { await page.mouse.wheel(0, sign * 4); await page.waitForTimeout(8); }
    for (let v = 40; v >= 1; v = Math.floor(v * 0.9)) { await page.mouse.wheel(0, sign * v); await page.waitForTimeout(16); }
    await page.waitForTimeout(400);
    await settle();
  };

  // ── 1. Wheel ──────────────────────────────────────────────────────────────
  await open(thousand);
  await fit();
  await goTo(5);
  await centre();
  const wheel = {};
  await notches(1, -100); wheel.upAtTopFit = await current();
  await goTo(5); await notches(1, 100); wheel.downAtBottomFit = await current();
  await goTo(5); await notches(10, 100); wheel.burstDown = await current();
  await goTo(5); await notches(10, -100); wheel.burstUp = await current();
  await goTo(5); await fling(1); wheel.touchpadDown = await current();
  await goTo(5); await fling(-1); wheel.touchpadUp = await current();
  // Zoomed in: the wheel scrolls within page 5 and stops at its edges.
  await page.evaluate(async () => (await import('/js/pdf/renderer.js')).setZoom(3));
  await goTo(5);
  await settle();
  await centre();
  const before = await scroller();
  await notches(3, 100);
  const middle = await scroller();
  wheel.zoomedScrolls = middle.top > before.top;
  await notches(80, 100, 8);
  const bottom = await scroller();
  wheel.zoomedReachesBottom = bottom.top >= bottom.max - 2;
  wheel.zoomedAfterBottom = await current();
  await notches(80, -100, 8);
  wheel.zoomedBackAtTop = (await scroller()).top <= 2;
  wheel.zoomedAfterTop = await current();
  await fit();
  await settle();
  // "At page edge": one page per wheel gesture.
  await setPref('wheelChangesPage', 'edge');
  await goTo(5); await centre(); await notches(1, 100); wheel.edgeOneNotch = await current();
  // A fast spin: ten notches 16 ms apart by the event clock. (Real wheel
  // events from Playwright wait for the page between events, so a render
  // could stretch the spin into separate gestures.)
  await goTo(5); await page.waitForTimeout(400);
  await page.evaluate(() => {
    const target = document.getElementById('pdf-container');
    const r = target.getBoundingClientRect();
    for (let i = 0; i < 10; i++) {
      target.dispatchEvent(new WheelEvent('wheel', { deltaY: 100, clientX: r.x + r.width / 2, clientY: r.y + r.height / 2,
        bubbles: true, cancelable: true }));
    }
  });
  await page.waitForTimeout(400); await settle();
  wheel.edgeBurst = await current();
  await setPref('wheelChangesPage', 'never');
  report.wheel = wheel;
  console.log('wheel', JSON.stringify(wheel));
  check(wheel.upAtTopFit === 5 && wheel.downAtBottomFit === 5, 'one notch at the page edge keeps the page');
  check(wheel.burstDown === 5 && wheel.burstUp === 5, 'a wheel burst keeps the page');
  check(wheel.touchpadDown === 5 && wheel.touchpadUp === 5, 'a touchpad fling keeps the page');
  check(wheel.zoomedScrolls && wheel.zoomedReachesBottom && wheel.zoomedBackAtTop, 'zoomed in, the wheel scrolls the page');
  check(wheel.zoomedAfterBottom === 5 && wheel.zoomedAfterTop === 5, 'zoomed in, the wheel stops at the page edges');
  check(wheel.edgeOneNotch === 6 && wheel.edgeBurst === 6, '"At page edge" turns one page per gesture');

  // Switching views keeps the page.
  await goTo(37);
  await page.locator('#nav-layout-continuous').click();
  await settle(); await page.waitForTimeout(600);
  const inContinuous = await current();
  // The continuous view still scrolls from page to page with the wheel.
  await centre();
  await notches(40, 100, 8);
  await page.waitForTimeout(600);
  const scrolledTo = await current();
  await page.locator('#nav-layout-single').click();
  await settle();
  const backInSingle = await current();
  report.modes = { inContinuous, scrolledTo, backInSingle };
  console.log('modes', JSON.stringify(report.modes));
  check(inContinuous === 37, 'switching to the continuous view keeps page 37');
  check(scrolledTo > 37, 'the wheel scrolls on through the continuous view');
  check(backInSingle === scrolledTo, 'back in the single-page view on the page scrolled to');

  // ── 2. Navigation bar ─────────────────────────────────────────────────────
  const IDS = ['#nav-first', '#nav-prev', '#nav-page-input', '#nav-next', '#nav-last'];
  const boxes = () => page.evaluate((ids) => ids.map((id) => {
    const r = document.querySelector(id)?.getBoundingClientRect();
    return r && r.width ? { x: r.x, w: r.width } : null;
  }), IDS);
  const PAGES = [1, 9, 10, 2, 99, 100, 3, 999, 1000, 4];
  report.shift = {};
  for (const width of [1600, 1280, 1024, 800, 640]) {
    await page.setViewportSize({ width, height: 900 });
    await page.waitForTimeout(200);
    const seen = [];
    for (const n of PAGES) { await goTo(n); seen.push(await boxes()); }
    // Zoom text from two to three digits.
    for (const z of [0.5, 4, 1]) {
      await page.evaluate(async (z) => (await import('/js/pdf/renderer.js')).setZoom(z), z);
      await settle();
      seen.push(await boxes());
    }
    const shift = IDS.map((id, i) => {
      const xs = seen.map((b) => b[i]?.x).filter((x) => x != null);
      return xs.length ? Math.round((Math.max(...xs) - Math.min(...xs)) * 10) / 10 : null;
    });
    report.shift[width] = Object.fromEntries(IDS.map((id, i) => [id, shift[i]]));
  }
  // Long page labels.
  await page.setViewportSize({ width: 1280, height: 900 });
  await open(labelled);
  const seenLabels = [];
  for (const n of [1, 3, 4, 6, 12, 2]) { await goTo(n); seenLabels.push(await boxes()); }
  report.shift.labels1280 = Object.fromEntries(IDS.map((id, i) => {
    const xs = seenLabels.map((b) => b[i]?.x).filter((x) => x != null);
    return [id, Math.round((Math.max(...xs) - Math.min(...xs)) * 10) / 10];
  }));
  const tip = await page.locator('#nav-page-input').getAttribute('title');
  console.log('shift', JSON.stringify(report.shift));
  for (const [key, row] of Object.entries(report.shift)) {
    for (const id of ['#nav-first', '#nav-prev', '#nav-next', '#nav-last']) {
      check(row[id] === null || row[id] <= 0.5, `${id} moved ${row[id]} px (${key})`);
    }
  }
  await goTo(3);
  const longTip = await page.locator('#nav-page-input').getAttribute('title');
  check(/NORTH WING ENLARGED/.test(longTip || ''), `long label has a tooltip (${tip} / ${longTip})`);

  // Twenty quick clicks at one spot.
  await page.setViewportSize({ width: 1280, height: 900 });
  const clicks = {};
  for (const [file, start] of [[thousand, 85], [thousand, 990 - 20]]) {
    await open(file);
    await goTo(start);
    const box = await page.locator('#nav-next').boundingBox();
    for (let i = 0; i < 20; i++) {
      await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
      await page.waitForTimeout(25);
    }
    await page.waitForTimeout(500);
    await settle();
    clicks[`from${start}`] = (await current()) - start;
  }
  // Held PageDown (key repeat) and PageUp.
  await goTo(85);
  await page.locator('#pdf-container').click({ position: { x: 5, y: 5 } }).catch(() => {});
  await page.evaluate(() => document.activeElement?.blur?.());
  for (let i = 0; i < 10; i++) await page.keyboard.down('PageDown');
  await page.keyboard.up('PageDown');
  await settle();
  clicks.pageDownHeld = (await current()) - 85;
  await page.keyboard.press('PageUp');
  await settle();
  clicks.pageUp = (await current()) - 85;
  report.clicks = clicks;
  console.log('clicks', JSON.stringify(clicks));
  check(clicks.from85 === 20 && clicks.from970 === 20, 'twenty clicks advance twenty pages');
  check(clicks.pageDownHeld === 10 && clicks.pageUp === 9, 'PageDown / PageUp turn pages');

  check(errors.length === 0, `page errors: ${errors.join('; ')}`);
  console.log(REPORT ? 'Page navigation measurements done' : 'Page navigation smoke passed');
} finally {
  await browser?.close();
  await server.close();
  await rm(directory, { recursive: true, force: true });
}
