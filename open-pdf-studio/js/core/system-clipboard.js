// Images on the system clipboard for the drawing (paste, snapshot, copy of an
// image markup).
//
// On Linux the webview (WebKitGTK) reads and writes the clipboard through
// GTK in the app's main process. A paste there crashed the whole app
// (WebKitGTK 2.54.1: a segfault in WebKit's callback for GTK's clipboard
// targets, gtkclipboard.c request_targets_received_func): Ctrl+V let the
// webview's own paste run and, when its paste event was late, read the
// clipboard a second time with navigator.clipboard.read(). On Linux the
// desktop app therefore moves images through the native clipboard commands
// (read_clipboard_image_png / write_clipboard_image_png, off the main
// thread), and the webview never touches the clipboard for the drawing.
// Text fields keep the webview's own copy and paste. Windows and macOS are
// unchanged.

import { isTauri, invoke } from './platform.js';
import { isWebKitGtk } from '../pdf/page-canvas-context.js';

/** Does the drawing use the native clipboard commands instead of the webview's? */
export function useNativeClipboard(userAgent = typeof navigator !== 'undefined' ? navigator.userAgent : '', tauri = isTauri()) {
  return !!tauri && isWebKitGtk(userAgent);
}

/**
 * A clipboard failure, in the app's startup diagnostics (as a frontend
 * error) as well as the console: the desktop app has no console to read.
 */
export function reportClipboardError(where, error) {
  const message = String(error?.message || error || 'unknown error').slice(0, 300);
  console.warn(`[clipboard] ${where}:`, error);
  try {
    void window.__TAURI__?.core?.invoke?.('startup_diagnostic', { phase: 'frontend-error', detail: `[clipboard] ${where}: ${message}` })?.catch?.(() => {});
  } catch { /* no diagnostics */ }
}

/** The image on the system clipboard as a PNG Blob, or null (none, or unreadable). */
export async function readClipboardImage() {
  if (useNativeClipboard()) {
    try {
      const bytes = await invoke('read_clipboard_image_png');
      const u8 = bytes instanceof Uint8Array ? bytes : bytes ? new Uint8Array(bytes) : null;
      return u8?.length ? new Blob([u8], { type: 'image/png' }) : null;
    } catch (error) {
      // No image is the usual answer (text on the clipboard); anything else is a failure.
      if (!/no image on clipboard|empty/i.test(String(error?.message || error))) reportClipboardError('read', error);
      return null;
    }
  }
  try {
    if (!navigator.clipboard?.read) return null;
    for (const item of await navigator.clipboard.read()) {
      const type = item.types.find((t) => t.startsWith('image/'));
      if (type) return await item.getType(type);
    }
  } catch { /* no permission or no image */ }
  return null;
}

/** Put a PNG Blob on the system clipboard. Throws when that fails. */
export async function writeClipboardImage(blob) {
  if (useNativeClipboard()) {
    await invoke('write_clipboard_image_png', new Uint8Array(await blob.arrayBuffer()));
    return;
  }
  await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })]);
}
