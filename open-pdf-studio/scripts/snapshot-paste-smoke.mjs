// Snapshot and paste as the Linux desktop app does them (WebKitGTK): the
// browser poses as WebKitGTK under a stubbed desktop shell whose native
// clipboard commands keep one image, and the webview's Clipboard API throws
// if it is touched at all.
//
// A snapshot (G) of drawing A goes to the native clipboard. The window then
// loses focus (as a file dialog takes it when drawing B is opened), and
// Ctrl+V on drawing B places the snapshot where it was taken. When the
// clipboard write fails, the snapshot still pastes and the failure is
// recorded in the startup diagnostics. An image copied elsewhere afterwards
// (another size) pastes as that image instead.
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer as createTcpServer } from 'node:net';
import { PDFDocument } from 'pdf-lib';
import { chromium } from 'playwright';
import { createServer } from 'vite';

const WEBKITGTK = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15';

process.env.OCUDRAW_EDITION = 'community';
const temp = await mkdtemp(join(tmpdir(), 'snapshot-paste-smoke-'));
const tcp = createTcpServer();
await new Promise((resolve, reject) => tcp.once('error', reject).listen(0, '127.0.0.1', resolve));
const port = tcp.address().port;
await new Promise((resolve) => tcp.close(resolve));
const server = await createServer({ cacheDir: join(temp, 'vite-cache'),
  server: { host: '127.0.0.1', port, strictPort: true, hmr: false }, logLevel: 'error' });
await server.listen();
const browser = await chromium.launch({ headless: true,
  executablePath: process.env.CHROMIUM_PATH || '/usr/bin/chromium' });

const pdf = async (w, h) => {
  const doc = await PDFDocument.create();
  doc.addPage([w, h]);
  return Array.from(await doc.save());
};

try {
  const context = await browser.newContext({ userAgent: WEBKITGTK, viewport: { width: 1400, height: 900 } });
  await context.addInitScript(() => {
    window.__clip = { png: null, failWrite: false, calls: [], diagnostics: [] };
    window.__TAURI__ = {
      core: { invoke: async (command, args) => {
        const clip = window.__clip;
        if (command === 'write_clipboard_image_png') {
          clip.calls.push(command);
          if (clip.failWrite) throw new Error('clipboard owner lost');
          clip.png = new Uint8Array(args);
          return null;
        }
        if (command === 'read_clipboard_image_png') {
          clip.calls.push(command);
          if (!clip.png) throw new Error('no image on clipboard: empty');
          return clip.png.buffer.slice(0);
        }
        if (command === 'startup_diagnostic') { clip.diagnostics.push(args); return null; }
        if (command === 'render_pdf_page_region') {
          // The native region render: an 8-byte size header, then RGBA.
          const w = 16, h = 9;
          const out = new Uint8Array(8 + w * h * 4).fill(200);
          new DataView(out.buffer).setUint32(0, w, true);
          new DataView(out.buffer).setUint32(4, h, true);
          return out;
        }
        if (command === 'edition_plugins') return [];
        return null;
      } },
      event: { listen: async () => () => {} },
    };
    // The webview's own clipboard must not be used on Linux.
    Object.defineProperty(navigator, 'clipboard', { configurable: true, get() {
      throw new Error('the webview clipboard was used');
    } });
  });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto(server.resolvedUrls.local[0], { waitUntil: 'networkidle' });
  await page.waitForFunction(() => document.title === 'Oculith Draw Foundation', null, { timeout: 60_000 });

  const [a, b] = [await pdf(600, 400), await pdf(800, 600)];
  const tabs = await page.evaluate(async ({ a, b }) => {
    const { createTab } = await import('/js/ui/chrome/tabs.js');
    const { loadPDF } = await import('/js/pdf/loader.js');
    const out = [];
    for (const [name, bytes] of [['a.pdf', a], ['b.pdf', b]]) {
      const { index } = createTab(name);
      await loadPDF(name, index, new Uint8Array(bytes));
      out.push(index);
    }
    return out;
  }, { a, b });
  await page.waitForFunction(() => document.querySelector('.page-wrapper, #pdf-canvas'));

  // Snapshot on drawing A, leave the app, Ctrl+V on drawing B.
  const snapshotThenPasteOnB = async ({ failWrite }) => page.evaluate(async ({ tabs, failWrite }) => {
    const { switchToTab } = await import('/js/ui/chrome/tabs.js');
    const { state } = await import('/js/core/state.ts');
    const { snapshotRegion } = await import('/js/tools/screenshot.js');
    window.__clip.failWrite = failWrite;
    switchToTab(tabs[0]);
    await new Promise((r) => setTimeout(r, 300));
    const taken = await snapshotRegion(1, { x: 40, y: 50, width: 160, height: 90 });
    if (!taken) throw new Error('the snapshot was not taken');
    await new Promise((r) => setTimeout(r, 50));
    window.dispatchEvent(new Event('blur'));
    switchToTab(tabs[1]);
    await new Promise((r) => setTimeout(r, 300));
    return state.documents[tabs[1]].annotations.length;
  }, { tabs, failWrite });
  const imagesOnB = () => page.evaluate(async (tabs) => {
    const { state } = await import('/js/core/state.ts');
    return state.documents[tabs[1]].annotations.filter((x) => x.type === 'image')
      .map((x) => ({ x: Math.round(x.x), y: Math.round(x.y), w: Math.round(x.width), h: Math.round(x.height) }));
  }, tabs);
  const pressPaste = async (count) => {
    await page.locator('body').click({ position: { x: 700, y: 500 } }).catch(() => {});
    await page.keyboard.press('Escape');
    await page.keyboard.press('Control+v');
    for (let i = 0; i < 100 && (await imagesOnB()).length < count; i++) await page.waitForTimeout(100);
  };

  // 1. The snapshot reaches the native clipboard and pastes onto B where it was taken.
  await snapshotThenPasteOnB({ failWrite: false });
  assert.ok(await page.evaluate(() => window.__clip.png?.length > 0), 'the snapshot reached the native clipboard');
  await pressPaste(1);
  let images = await imagesOnB();
  assert.equal(images.length, 1, 'the snapshot was pasted onto drawing B');
  assert.deepEqual({ w: images[0].w, h: images[0].h }, { w: 160, h: 90 }, 'at the size it was taken');
  assert.deepEqual({ x: images[0].x, y: images[0].y }, { x: 50, y: 60 }, 'where it was taken, one step on');

  // 2. The clipboard write fails: the snapshot still pastes, and the failure is recorded.
  await page.evaluate(() => { window.__clip.png = null; });
  await snapshotThenPasteOnB({ failWrite: true });
  await pressPaste(2);
  images = await imagesOnB();
  assert.equal(images.length, 2, 'the snapshot pasted although the clipboard write failed');
  const diagnostics = await page.evaluate(() => window.__clip.diagnostics);
  assert.ok(diagnostics.some((d) => d.phase === 'frontend-error' && /^\[clipboard\] snapshot write .*clipboard owner lost/.test(d.detail)),
    `the failed write is in the diagnostics: ${JSON.stringify(diagnostics)}`);

  // 3. An image of another size copied elsewhere afterwards pastes as that image.
  await page.evaluate(async () => {
    const canvas = document.createElement('canvas');
    canvas.width = 33; canvas.height = 21;
    canvas.getContext('2d').fillRect(0, 0, 33, 21);
    const blob = await new Promise((r) => canvas.toBlob(r, 'image/png'));
    window.__clip.png = new Uint8Array(await blob.arrayBuffer());
  });
  await pressPaste(3);
  images = await imagesOnB();
  assert.equal(images.length, 3, 'the other image was pasted');
  assert.notDeepEqual({ w: images[2].w, h: images[2].h }, { w: 160, h: 90 }, 'as itself, not the snapshot');

  const calls = await page.evaluate(() => window.__clip.calls);
  assert.ok(calls.includes('write_clipboard_image_png') && calls.includes('read_clipboard_image_png'), calls.join(', '));
  assert.deepEqual(errors.filter((e) => /clipboard/i.test(e)), [], 'the webview clipboard was never touched');
  console.log(`Snapshot paste smoke passed: a snapshot went to the native clipboard and pasted onto another drawing after the window lost focus, where it was taken; it pasted when the clipboard write failed, which was recorded; an image of another size pasted as itself; the webview clipboard was never used (${calls.length} native clipboard calls).`);
} finally {
  await browser.close();
  await server.close();
  await rm(temp, { recursive: true, force: true });
}
