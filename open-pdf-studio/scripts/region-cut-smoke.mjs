// Cut a region of one drawing and paste it onto another, as the Linux desktop
// app does it (WebKitGTK UA, a stubbed desktop shell).
//
// With the select tool, a marquee over an empty part of drawing A (vector
// lines, no markups) leaves a region selection that stays after the mouse is
// released. Ctrl+X takes that part of the page as a vector snippet: the page
// comes from the native page extraction (stubbed here; the whole file is not
// read into the webview), and the page itself does not change. On drawing B,
// Ctrl+V places it where it was taken, at its size, undoable. The page context
// menu pastes it too, and offers Copy for a region. A markup copied after the
// region pastes the markup; a region copied after that pastes the region.
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer as createTcpServer } from 'node:net';
import { PDFDocument, rgb } from 'pdf-lib';
import { chromium } from 'playwright';
import { createServer } from 'vite';

const WEBKITGTK = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15';

process.env.OCUDRAW_EDITION = 'community';
const temp = await mkdtemp(join(tmpdir(), 'region-cut-smoke-'));
const tcp = createTcpServer();
await new Promise((resolve, reject) => tcp.once('error', reject).listen(0, '127.0.0.1', resolve));
const port = tcp.address().port;
await new Promise((resolve) => tcp.close(resolve));
const server = await createServer({ cacheDir: join(temp, 'vite-cache'),
  server: { host: '127.0.0.1', port, strictPort: true, hmr: false }, logLevel: 'error' });
await server.listen();
const browser = await chromium.launch({ headless: true,
  executablePath: process.env.CHROMIUM_PATH || '/usr/bin/chromium' });

// Drawing A: two sheets of vector lines. Drawing B: one empty, larger sheet.
const drawingA = await PDFDocument.create();
for (const [w, h] of [[600, 400], [500, 500]]) {
  const page = drawingA.addPage([w, h]);
  for (let i = 0; i < 12; i++) {
    page.drawLine({ start: { x: 20 + i * 40, y: 20 }, end: { x: 20 + i * 40, y: h - 20 }, thickness: 0.5, color: rgb(0, 0, 0.6) });
  }
  page.drawRectangle({ x: 120, y: 220, width: 100, height: 60, borderColor: rgb(0.7, 0, 0), borderWidth: 1 });
}
const drawingB = await PDFDocument.create();
drawingB.addPage([800, 600]);
const bytesA = await drawingA.save();
const bytesB = await drawingB.save();
// What the native page extraction returns: one page as a standalone PDF.
const onePage = async (bytes, index) => {
  const src = await PDFDocument.load(bytes);
  const out = await PDFDocument.create();
  const [page] = await out.copyPages(src, [index]);
  out.addPage(page);
  return Array.from(await out.save());
};
const extractable = {
  'a.pdf': [await onePage(bytesA, 0), await onePage(bytesA, 1)],
  'b.pdf': [await onePage(bytesB, 0)],
};

try {
  const context = await browser.newContext({ userAgent: WEBKITGTK, viewport: { width: 1400, height: 900 } });
  await context.addInitScript((extractable) => {
    window.__shell = { extractCalls: [], calls: [] };
    window.__TAURI__ = {
      core: { invoke: async (command, args) => {
        window.__shell.calls.push(command);
        if (command === 'extract_pdf_page') {
          window.__shell.extractCalls.push({ ...args });
          const page = extractable[args.path]?.[args.pageIndex];
          if (!page) throw new Error(`no page ${args.pageIndex} in ${args.path}`);
          // Slow enough that a paste can arrive while the cut still runs.
          await new Promise((r) => setTimeout(r, 150));
          return new Uint8Array(page).buffer;
        }
        if (command === 'read_clipboard_image_png') throw new Error('no image on clipboard: empty');
        if (command === 'edition_plugins') return [];
        return null;
      } },
      event: { listen: async () => () => {} },
    };
    // The webview's own clipboard must not be used on Linux.
    Object.defineProperty(navigator, 'clipboard', { configurable: true, get() {
      throw new Error('the webview clipboard was used');
    } });
  }, extractable);
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto(server.resolvedUrls.local[0], { waitUntil: 'networkidle' });
  await page.waitForFunction(() => document.title === 'Oculith Draw Foundation', null, { timeout: 60_000 });

  const tabs = await page.evaluate(async ({ a, b }) => {
    const { createTab } = await import('/js/ui/chrome/tabs.js');
    const { loadPDF } = await import('/js/pdf/loader.js');
    const { state } = await import('/js/core/state.ts');
    window.__state = state;
    const out = [];
    for (const [name, bytes] of [['a.pdf', a], ['b.pdf', b]]) {
      const { index } = createTab(name);
      await loadPDF(name, index, new Uint8Array(bytes));
      out.push(index);
    }
    return out;
  }, { a: Array.from(bytesA), b: Array.from(bytesB) });
  await page.waitForFunction(() => document.querySelector('.page-wrapper, #pdf-canvas'));

  const showTab = (i) => page.evaluate(async (index) => {
    const { switchToTab } = await import('/js/ui/chrome/tabs.js');
    const { setTool } = await import('/js/tools/manager.js');
    switchToTab(index);
    await new Promise((r) => setTimeout(r, 400));
    setTool('select');
    await new Promise((r) => setTimeout(r, 100));
  }, tabs[i]);
  // Page points of page 1 of the active drawing on the screen.
  const onScreen = (x, y) => page.evaluate(async ({ x, y }) => {
    const { paginaNaarClient } = await import('/js/pdf/weergave-ruimte.js');
    const p = paginaNaarClient(1, x, y);
    if (!p) throw new Error('page 1 is not on screen');
    return p;
  }, { x, y });
  const marquee = async (from, to) => {
    const a = await onScreen(from.x, from.y);
    const b = await onScreen(to.x, to.y);
    await page.mouse.move(a.x - 5, a.y - 5);
    await page.mouse.move(a.x, a.y);
    await page.mouse.down();
    await page.mouse.move(b.x, b.y, { steps: 12 });
    await page.mouse.up();
    await page.waitForTimeout(250);
  };
  const region = () => page.evaluate(() => {
    const r = window.__state.regionSelection;
    return r ? { page: r.page, x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) } : null;
  });
  const markupsOn = (i) => page.evaluate((index) => window.__state.documents[index].annotations.map((x) => ({
    type: x.type, page: x.page, x: Math.round(x.x), y: Math.round(x.y), w: Math.round(x.width), h: Math.round(x.height),
    srcBox: x.srcBox ? Object.values(x.srcBox).map(Math.round) : null,
  })), tabs[i]);
  const snippetsOn = async (i) => (await markupsOn(i)).filter((x) => x.type === 'vectorSnippet');
  const waitForCount = async (i, type, count) => {
    for (let k = 0; k < 100; k++) {
      if ((await markupsOn(i)).filter((x) => x.type === type).length >= count) return;
      await page.waitForTimeout(50);
    }
  };
  const contextMenuItem = (label) => page.locator('.context-menu.visible > .context-menu-item')
    .filter({ has: page.locator('.context-menu-label', { hasText: new RegExp(`^${label}$`) }) });

  // 1. The marquee over empty drawing stays as a region selection.
  await showTab(0);
  await marquee({ x: 100, y: 80 }, { x: 260, y: 200 });
  assert.deepEqual(await region(), { page: 1, x: 100, y: 80, w: 160, h: 120 }, 'the region stays selected after mouse-up');
  await page.evaluate(async () => (await import('/js/annotations/rendering.js')).redrawAnnotations());
  await page.waitForTimeout(150);
  assert.ok(await region(), 'and survives a redraw');
  assert.deepEqual(await markupsOn(0), [], 'no markups on drawing A');

  // 2. Ctrl+X takes the region from the file natively; drawing A is unchanged.
  await page.keyboard.press('Control+x');
  await page.waitForFunction(() => /^Region copied/.test(window.__state.statusMessage || ''), null, { timeout: 15_000 });
  const extractCalls = await page.evaluate(() => window.__shell.extractCalls);
  assert.equal(extractCalls.length, 1, 'the native page extraction was used');
  assert.equal(extractCalls[0].path, 'a.pdf');
  assert.equal(extractCalls[0].pageIndex, 0);
  assert.equal(extractCalls[0].expectedLen, bytesA.length, 'with the length of the file as opened');
  assert.deepEqual(await markupsOn(0), [], 'cutting does not change drawing A');
  assert.ok(await region(), 'the region stays selected after the cut');

  // 3. Ctrl+V on drawing B places it where it was taken, at its size; undoable.
  await page.evaluate(() => window.dispatchEvent(new Event('blur')));
  await showTab(1);
  assert.equal(await region(), null, 'switching drawings ends the region selection');
  await page.keyboard.press('Control+v');
  await waitForCount(1, 'vectorSnippet', 1);
  let snippets = await snippetsOn(1);
  assert.equal(snippets.length, 1, 'the region was pasted onto drawing B');
  assert.deepEqual({ page: snippets[0].page, x: snippets[0].x, y: snippets[0].y, w: snippets[0].w, h: snippets[0].h },
    { page: 1, x: 100, y: 80, w: 160, h: 120 }, 'at the source position and size');
  assert.deepEqual(snippets[0].srcBox, [100, 200, 260, 320], 'cut from that box of sheet A (PDF space)');
  assert.ok(await page.evaluate((index) => window.__state.documents[index].selectedAnnotations?.[0]?.type === 'vectorSnippet', tabs[1]),
    'and selected');
  await page.keyboard.press('Control+z');
  await page.waitForTimeout(200);
  assert.equal((await snippetsOn(1)).length, 0, 'undo removes it');

  // 4. Right-click > Paste on an empty part of drawing B.
  const empty = await onScreen(700, 520);
  await page.mouse.click(empty.x, empty.y, { button: 'right' });
  await contextMenuItem('Paste').click();
  await waitForCount(1, 'vectorSnippet', 1);
  snippets = await snippetsOn(1);
  assert.equal(snippets.length, 1, 'the context menu pasted the region');
  assert.deepEqual({ x: snippets[0].x, y: snippets[0].y, w: snippets[0].w, h: snippets[0].h }, { x: 100, y: 80, w: 160, h: 120 });

  // 5. A region on B: the page menu offers Cut and Copy; Copy, then Ctrl+V.
  await marquee({ x: 400, y: 300 }, { x: 560, y: 420 });
  assert.deepEqual(await region(), { page: 1, x: 400, y: 300, w: 160, h: 120 });
  const inside = await onScreen(480, 360);
  await page.mouse.click(inside.x, inside.y, { button: 'right' });
  assert.equal(await contextMenuItem('Cut').isDisabled(), false, 'Cut is offered for a region');
  assert.equal(await contextMenuItem('Copy').isDisabled(), false, 'Copy is offered for a region');
  await contextMenuItem('Copy').click();
  // Pasted while the extraction still runs: the paste waits for the cut.
  await page.keyboard.press('Control+v');
  await waitForCount(1, 'vectorSnippet', 2);
  snippets = await snippetsOn(1);
  assert.equal(snippets.length, 2, 'the copied region pasted');
  assert.deepEqual({ x: snippets[1].x, y: snippets[1].y, w: snippets[1].w, h: snippets[1].h }, { x: 400, y: 300, w: 160, h: 120 });
  assert.deepEqual((await page.evaluate(() => window.__shell.extractCalls)).at(-1), { path: 'b.pdf', pageIndex: 0, expectedLen: bytesB.length });

  // 6. A markup copied after the region pastes the markup ...
  await page.evaluate(async (index) => {
    const { createAnnotation } = await import('/js/annotations/factory.js');
    const doc = window.__state.documents[index];
    const box = createAnnotation({ type: 'box', page: 1, x: 600, y: 60, width: 80, height: 50, color: '#ff0000', strokeColor: '#ff0000', lineWidth: 2 });
    doc.annotations.push(box);
    doc.selectedAnnotations = [box];
    doc.selectedAnnotation = box;
  }, tabs[1]);
  await page.keyboard.press('Control+c');
  await page.keyboard.press('Control+v');
  await waitForCount(1, 'box', 2);
  assert.equal((await markupsOn(1)).filter((x) => x.type === 'box').length, 2, 'the later markup copy pasted');
  assert.equal((await snippetsOn(1)).length, 2, 'not the region');

  // ... and a region copied after that pastes the region again.
  await marquee({ x: 300, y: 450 }, { x: 380, y: 520 });
  assert.deepEqual(await region(), { page: 1, x: 300, y: 450, w: 80, h: 70 });
  await page.keyboard.press('Control+c');
  await page.keyboard.press('Control+v');
  await waitForCount(1, 'vectorSnippet', 3);
  snippets = await snippetsOn(1);
  assert.equal(snippets.length, 3, 'the later region copy pasted');
  assert.deepEqual({ x: snippets[2].x, y: snippets[2].y }, { x: 300, y: 450 });
  assert.equal((await markupsOn(1)).filter((x) => x.type === 'box').length, 2);

  // 7. Esc ends the region selection.
  await page.keyboard.press('Escape');
  assert.equal(await region(), null, 'Esc ends the region selection');

  const calls = await page.evaluate(() => window.__shell.calls);
  assert.ok(!calls.includes('read_file'), 'the source file was not read whole');
  assert.deepEqual(errors, [], 'no page errors');
  const extracted = (await page.evaluate(() => window.__shell.extractCalls)).length;
  console.log(`Region cut smoke passed: a marquee over empty drawing stayed selected; Ctrl+X cut it through the native page extraction (${extracted} calls) without changing the source; Ctrl+V and the context menu pasted it onto another drawing at the source position and size, undoably; the page menu offered Cut/Copy for a region and a paste waited for a running cut; a later markup copy pasted the markup and a later region copy the region; Esc ended the selection.`);
} finally {
  await browser.close();
  await server.close();
  await rm(temp, { recursive: true, force: true });
}
