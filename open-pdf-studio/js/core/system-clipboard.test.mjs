import assert from 'node:assert/strict';
import test from 'node:test';
import { readClipboardImage, useNativeClipboard, writeClipboardImage } from './system-clipboard.js';

const WEBKITGTK = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15';
const WEBVIEW2 = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36 Edg/130.0.0.0';
const MAC = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko)';

// The desktop app on Linux, with a native clipboard that records its calls
// and a webview clipboard that must not be used.
function linuxDesktop(native) {
  const calls = [];
  const webview = [];
  globalThis.window = { __TAURI__: { core: { invoke: async (...args) => { calls.push(args); return native(...args); } } } };
  Object.defineProperty(globalThis, 'navigator', { configurable: true, value: {
    userAgent: WEBKITGTK,
    clipboard: { read: async () => { webview.push('read'); return []; }, write: async () => { webview.push('write'); } },
  } });
  return { calls, webview };
}

test('only the Linux desktop app moves clipboard images natively', () => {
  assert.equal(useNativeClipboard(WEBKITGTK, true), true);
  assert.equal(useNativeClipboard(WEBKITGTK, false), false, 'a browser keeps the Clipboard API');
  assert.equal(useNativeClipboard(WEBVIEW2, true), false);
  assert.equal(useNativeClipboard(MAC, true), false);
});

test('on Linux a paste reads the image natively, never through the webview', async () => {
  const png = new Uint8Array([137, 80, 78, 71]);
  const { calls, webview } = linuxDesktop(() => png);
  const blob = await readClipboardImage();
  assert.equal(blob.type, 'image/png');
  assert.deepEqual(new Uint8Array(await blob.arrayBuffer()), png);
  assert.deepEqual(calls.map(([cmd]) => cmd), ['read_clipboard_image_png']);
  assert.deepEqual(webview, []);
});

test('on Linux no image on the clipboard is null, and the webview is still not asked', async () => {
  const { webview } = linuxDesktop(() => { throw new Error('no image on clipboard'); });
  assert.equal(await readClipboardImage(), null);
  assert.deepEqual(webview, []);
});

test('on Linux a copied image goes to the native clipboard as PNG bytes', async () => {
  const { calls, webview } = linuxDesktop(() => undefined);
  await writeClipboardImage(new Blob([new Uint8Array([1, 2, 3])], { type: 'image/png' }));
  assert.equal(calls.length, 1);
  assert.equal(calls[0][0], 'write_clipboard_image_png');
  assert.deepEqual(calls[0][1], new Uint8Array([1, 2, 3]));
  assert.deepEqual(webview, []);
});

test('on Linux a failed read is recorded in the startup diagnostics, no image is not', async () => {
  const { calls } = linuxDesktop((cmd) => { if (cmd === 'read_clipboard_image_png') throw new Error('clipboard backend unavailable'); });
  assert.equal(await readClipboardImage(), null);
  const reports = calls.filter(([cmd]) => cmd === 'startup_diagnostic');
  assert.equal(reports.length, 1);
  assert.equal(reports[0][1].phase, 'frontend-error');
  assert.match(reports[0][1].detail, /^\[clipboard\] read: clipboard backend unavailable/);
  const quiet = linuxDesktop(() => { throw new Error('no image on clipboard: empty'); });
  assert.equal(await readClipboardImage(), null);
  assert.deepEqual(quiet.calls.map(([cmd]) => cmd), ['read_clipboard_image_png']);
});
