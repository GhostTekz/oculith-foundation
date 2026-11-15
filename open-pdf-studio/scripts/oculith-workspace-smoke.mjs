import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium } from 'playwright';
import { PDFDocument } from 'pdf-lib';
import { createServer } from 'vite';

const directory = await mkdtemp(join(tmpdir(), 'oculith-workspace-'));
const pdfPath = join(directory, 'review-sheet.pdf');
const pdf = await PDFDocument.create();
pdf.addPage([612, 792]);
await writeFile(pdfPath, await pdf.save());

let server;
let browser;
try {
  server = await createServer({ server: { host: '127.0.0.1', port: 0 }, logLevel: 'error' });
  await server.listen();
  const url = server.resolvedUrls.local[0];
  browser = await chromium.launch({
    headless: true,
    executablePath: process.env.CHROMIUM_PATH || '/usr/bin/chromium',
  });
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(url, { waitUntil: 'networkidle' });

  // plan-review workspace (docs/reference/editor/workspace.md): profiles come
  // from Oculith ▸ Profiles in the menu bar; panels live in the left / right
  // / bottom hosts, each with an access bar.
  async function chooseProfile(name) {
    await page.locator('.menu-bar-title', { hasText: 'Oculith' }).click();
    await page.locator('.menu-popup .menu-item', { hasText: 'Profiles' }).hover();
    await page.locator('.menu-popup-sub .menu-item', { hasText: new RegExp(`^\\s*${name}\\s*$`) }).click();
    await page.waitForTimeout(200);
  }
  const activeTab = (host) => page.locator(`.ws-access-${host} .ws-access-tab.active`).getAttribute('data-panel');
  const hostClass = (host) => page.locator(`.ws-host-${host}`).getAttribute('class');

  // Oculith (default): Tool Chest left, no Properties on the right, Markups List below.
  assert.equal(await activeTab('left'), 'toolChest');
  assert.match(await hostClass('right'), /collapsed/);
  assert.equal(await activeTab('bottom'), 'markupsList');
  assert.match(await page.locator('.markups-dock').getAttribute('class'), /\bopen\b/);
  assert.equal(await page.locator('.ws-vtoolbar .ox-toolbar-btn').count() > 0, true, 'right vertical toolbar');
  await chooseProfile('Oculith Advanced');
  assert.equal(await activeTab('left'), 'thumbnails');
  assert.equal(await activeTab('right'), 'properties');
  await chooseProfile('Quantity Takeoff');
  assert.equal(await activeTab('left'), 'measurements');
  assert.equal(await activeTab('bottom'), 'quantities');
  await page.reload({ waitUntil: 'networkidle' });
  assert.equal(await activeTab('left'), 'measurements', 'profile restored after reload');
  await chooseProfile('Document');
  assert.equal(await activeTab('left'), 'thumbnails');
  assert.match(await hostClass('bottom'), /collapsed/);
  await page.reload({ waitUntil: 'networkidle' });
  assert.equal(await activeTab('left'), 'thumbnails');
  assert.match(await hostClass('bottom'), /collapsed/);
  await chooseProfile('Oculith');
  assert.equal(await activeTab('left'), 'toolChest');

  const chooser = page.waitForEvent('filechooser');
  await page.locator('.draw-open-button').click();
  await (await chooser).setFiles(pdfPath);
  await page.locator('#pdf-container.visible').waitFor({ timeout: 15000 });
  assert.match(await page.locator('.properties-toolbar .ptb-doc-name').innerText(), /review-sheet\.pdf/);
  const canvasTop = (await page.locator('#pdf-container').boundingBox()).y;
  // Menu row, properties bar and tabs take 101 px; the workflow toolbar
  // (tabs and one tool row) adds its own height.
  const workflowBar = (await page.locator('#workflow-bar').boundingBox())?.height || 0;
  assert.ok(workflowBar <= 66, `workflow toolbar is ${workflowBar} px`);
  assert.ok(canvasTop <= 101 + workflowBar, `canvas starts at y=${canvasTop}`);

  await page.locator('.ws-host-left .sp-symbol-btn.sp-symbol-oculith').first().click();
  const sheet = await page.locator('#pdf-canvas').boundingBox();
  assert.ok(sheet);
  const clickPoint = { x: sheet.x + 180, y: sheet.y + 160 };
  await page.mouse.click(clickPoint.x, clickPoint.y);
  await page.keyboard.press('Escape');
  await page.mouse.click(clickPoint.x, clickPoint.y);
  // The Properties toolbar switches to the markup's fields (WP4).
  await page.locator('.properties-toolbar #properties-toolbar-type-menu').waitFor({ timeout: 10000 });
  const width = page.locator('.properties-toolbar .ptb-width input');
  await width.fill('4');
  await width.press('Enter');
  const annotations = await page.evaluate(async () => {
    const { state } = await import('/js/core/state.ts');
    return state.documents[state.activeDocumentIndex].annotations.map(a => ({ lineWidth: a.lineWidth }));
  });
  assert.equal(annotations.length, 1);
  assert.deepEqual(annotations[0], { lineWidth: 4 });
  assert.deepEqual(errors, []);
  console.log('Oculith workspace smoke passed: profiles from the menu bar, restore, panel hosts, Properties toolbar edit');
} finally {
  await browser?.close();
  await server?.close();
  await rm(directory, { recursive: true, force: true });
}
