import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { createServer } from 'vite';

let server;
let browser;
try {
  server = await createServer({ server: { host: '127.0.0.1', port: 0 }, logLevel: 'error' });
  await server.listen();
  browser = await chromium.launch({
    headless: true,
    executablePath: process.env.CHROMIUM_PATH || '/usr/bin/chromium',
  });
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(server.resolvedUrls.local[0], { waitUntil: 'networkidle' });

  // plan-review panel hosts (docs/reference/editor/workspace.md, WP2): each host
  // has an inner edge (.ws-host-edge-<host>) that resizes on drag and arrow
  // keys and collapses/expands on click; sizes persist per profile in
  // preferences.workspaceLayout.profileSizes.
  async function chooseProfile(name) {
    await page.locator('.menu-bar-title', { hasText: 'Oculith' }).click();
    await page.locator('.menu-popup .menu-item', { hasText: 'Profiles' }).hover();
    await page.locator('.menu-popup-sub .menu-item', { hasText: new RegExp(`^\\s*${name}\\s*$`) }).click();
    await page.waitForTimeout(220);
  }
  async function setLanguage(language) {
    await page.evaluate(async (value) => {
      const { state } = await import('/js/core/state.ts');
      const { savePreferences } = await import('/js/core/preferences.js');
      const { changeLanguage } = await import('/js/i18n/useTranslation.js');
      state.preferences.language = value;
      savePreferences();
      await changeLanguage(value);
    }, language);
  }
  const panel = (host) => `.ws-host-${host} .ws-host-panel`;
  async function width(selector) {
    return (await page.locator(selector).boundingBox()).width;
  }
  async function height(selector) {
    return (await page.locator(selector).boundingBox()).height;
  }
  async function saved(profile, host) {
    return page.evaluate(([p, h]) => {
      const prefs = JSON.parse(localStorage.getItem('pdfEditorPreferences'));
      return prefs.workspaceLayout.profileSizes?.[p]?.[h] ?? prefs.workspaceLayout.hosts[h].size;
    }, [profile, host]);
  }
  async function drag(selector, dx, dy) {
    const box = await page.locator(selector).boundingBox();
    const x = box.x + box.width / 2;
    const y = box.y + Math.min(box.height / 2, 100);
    await page.mouse.move(x, y);
    await page.mouse.down();
    await page.mouse.move(x + dx, y + dy, { steps: 6 });
    await page.mouse.up();
    await page.waitForTimeout(220);
  }

  await chooseProfile('Oculith');
  const leftBefore = await width(panel('left'));
  await drag('.ws-host-edge-left', 90, 0);
  assert.ok(await width(panel('left')) > leftBefore + 70, 'dragging the left edge grows the host');
  assert.ok(Math.abs(await width(panel('left')) - await saved('oculith', 'left')) < 2, 'rendered size is saved');

  // RTL: the left host sits on the right edge; dragging toward the canvas
  // (to the left) still grows it.
  await setLanguage('ar');
  assert.equal(await page.evaluate(() => document.documentElement.dir), 'rtl');
  const rtlBefore = await width(panel('left'));
  await drag('.ws-host-edge-left', -60, 0);
  assert.ok(await width(panel('left')) > rtlBefore + 45, 'RTL drag toward the canvas grows the host');
  const rtlAfterDrag = await width(panel('left'));
  await page.locator('.ws-host-edge-left').focus();
  await page.keyboard.press('ArrowLeft');
  await page.waitForTimeout(220);
  assert.ok(await width(panel('left')) > rtlAfterDrag + 10, 'RTL arrow key toward the canvas grows the host');
  await setLanguage('en');

  // A click on the edge collapses the host; another click brings it back.
  const leftOpen = await width(panel('left'));
  await page.locator('.ws-host-edge-left').click();
  await page.waitForTimeout(220);
  assert.match(await page.locator('.ws-host-left').getAttribute('class'), /collapsed/);
  await page.locator('.ws-host-edge-left').click();
  await page.waitForTimeout(220);
  assert.ok(Math.abs(await width(panel('left')) - leftOpen) < 2, 'expands to the same size');

  // Bottom host (Markups List): drag the edge up.
  const dockBefore = await height('.markups-dock');
  await drag('.ws-host-edge-bottom', 0, -60);
  assert.ok(await height('.markups-dock') > dockBefore + 45, 'dragging the bottom edge grows the Markups List');

  // Oculith Advanced: Properties in the right host, resized with the keyboard.
  await chooseProfile('Oculith Advanced');
  const inspectorBefore = await width(panel('right'));
  await page.locator('.ws-host-edge-right').focus();
  await page.keyboard.press('ArrowLeft');
  await page.waitForTimeout(220);
  assert.ok(await width(panel('right')) > inspectorBefore + 10, 'arrow key grows the right host');

  await page.reload({ waitUntil: 'networkidle' });
  await page.locator(panel('right')).waitFor();
  assert.ok(await width(panel('right')) > inspectorBefore + 10, 'right size restored after reload');
  await chooseProfile('Oculith');
  assert.ok(await width(panel('left')) > leftBefore + 70, 'Oculith profile keeps its own left size');
  assert.ok(await height('.markups-dock') > dockBefore + 45, 'and its bottom size');

  // Narrow window: the canvas column keeps room and nothing scrolls sideways.
  await page.setViewportSize({ width: 900, height: 800 });
  await page.waitForTimeout(220);
  assert.ok(await width('.main-view') > 150);
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1), 'no horizontal page scroll');
  assert.deepEqual(errors, []);
  console.log('Oculith panel layout smoke passed: host edge drag/keys/click, RTL, per-profile persistence, narrow layout');
} finally {
  await browser?.close();
  await server?.close();
}
