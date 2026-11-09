// A panel taken off the app into a window of its own: resizable, movable to
// any screen, and put back where it was (its host, its place among the
// tabs) on request or when the window is closed. The panel is still run by
// this page (its stores, the open drawing); it is shown in the other
// window, which the shell opens for a blank page of this app (window.open,
// related to this one).
//
// The window's place and size are remembered per panel.

import { createSignal } from 'solid-js';
import { DelegatedEvents, delegateEvents } from 'solid-js/web';

const GEOMETRY_KEY = 'oculithDraw.panelPopout.v1';
const DEFAULT_SIZE = { width: 900, height: 640 };

const [open, setOpen] = createSignal({}); // panelId -> { win, mount, home }

/** The popped-out window of `panelId` ({ win, mount }), or null. */
export const popoutOf = (panelId) => open()[panelId] || null;
/** The panels popped out now. */
export const popoutIds = () => Object.keys(open());

// Where panels live in the app (the workspace layout): `take(id)` removes
// a panel from its host and returns where it was; `put(id, home)` puts it
// back there. Set by the panel hosts.
let place = { take: () => null, put: () => {} };
export function setPanelPlacement(hooks) { place = { ...place, ...hooks }; }

// A panel shown off the app by other means (the thumbnails' own view):
// taken off its host, and put back where it was.
const away = new Map(); // panelId -> home
/** Take `panelId` off the app (it is shown elsewhere). */
export function takeOffApp(panelId) {
  if (away.has(panelId)) return;
  away.set(panelId, place.take(panelId));
}
/** Put `panelId` back where it was before takeOffApp. */
export function putBackInApp(panelId) {
  if (!away.has(panelId)) return;
  const home = away.get(panelId);
  away.delete(panelId);
  place.put(panelId, home);
}

/** Whether panels can pop out here (the desktop app's own windows). */
export const canPopOut = () => typeof window !== 'undefined' && !!window.__TAURI__;

function remembered(panelId) {
  try {
    const all = JSON.parse(localStorage.getItem(GEOMETRY_KEY) || '{}');
    const g = all[panelId];
    return g && [g.width, g.height].every((v) => Number.isFinite(v) && v >= 200) ? g : null;
  } catch {
    return null;
  }
}

function remember(panelId, win) {
  try {
    const g = { width: win.innerWidth, height: win.innerHeight, left: win.screenX, top: win.screenY };
    if (!(g.width >= 200 && g.height >= 200)) return;
    const all = JSON.parse(localStorage.getItem(GEOMETRY_KEY) || '{}');
    all[panelId] = g;
    localStorage.setItem(GEOMETRY_KEY, JSON.stringify(all));
  } catch { /* the place is not kept: the next window opens at the default */ }
}

/** The window features for `panelId`: its remembered place, else the default size. */
export function popoutFeatures(geometry) {
  const g = geometry || DEFAULT_SIZE;
  const parts = ['popup', `width=${Math.round(g.width)}`, `height=${Math.round(g.height)}`];
  if (Number.isFinite(g.left) && Number.isFinite(g.top)) parts.push(`left=${Math.round(g.left)}`, `top=${Math.round(g.top)}`);
  return parts.join(',');
}

// This page's styles, theme and language in the other window, kept in step
// (a panel's own styles load when it first shows).
function mirrorDocument(win) {
  const doc = win.document;
  const copyHead = (node) => {
    if (node.nodeName === 'STYLE' || (node.nodeName === 'LINK' && /stylesheet/i.test(node.rel))) doc.head.appendChild(node.cloneNode(true));
  };
  for (const node of document.head.childNodes) copyHead(node);
  const copyRoot = () => {
    const from = document.documentElement;
    for (const { name, value } of [...from.attributes]) doc.documentElement.setAttribute(name, value);
  };
  copyRoot();
  doc.body.className = `${document.body.className} ws-popout`;
  const heads = new MutationObserver((records) => { for (const r of records) for (const node of r.addedNodes) copyHead(node); });
  heads.observe(document.head, { childList: true });
  const root = new MutationObserver(copyRoot);
  root.observe(document.documentElement, { attributes: true });
  return () => { heads.disconnect(); root.disconnect(); };
}

// The blank page of a new window, once it is there to write into.
function blankReady(win, ms = 3000) {
  return new Promise((resolve) => {
    const ready = () => { try { return win.document?.body && win.document.readyState === 'complete'; } catch { return false; } };
    if (ready()) { resolve(true); return; }
    const t0 = Date.now();
    const tick = () => (ready() ? resolve(true) : Date.now() - t0 > ms ? resolve(false) : setTimeout(tick, 25));
    tick();
  });
}

/**
 * Take `panelId` off the app into its own window titled `title` (at
 * `at` { left, top } on the screen, else where it was last). Resolves to
 * true when it is shown there (an open one is brought to the front).
 */
export async function popOutPanel(panelId, title = '', { at = null } = {}) {
  const have = popoutOf(panelId);
  if (have && !have.win.closed) { have.win.focus(); return true; }
  if (!canPopOut()) return false;
  let win = null;
  try {
    // Dropped somewhere (dragged off the app): the window opens there.
    const g = remembered(panelId) || { ...DEFAULT_SIZE };
    win = window.open('about:blank', `oculith-panel-${panelId}`, popoutFeatures(at ? { ...g, left: at.left, top: at.top } : g));
    if (!win) { console.warn(`[panels] ${panelId}: no window was opened`); return false; }
    if (!(await blankReady(win))) { console.warn(`[panels] ${panelId}: its window did not come up`); win.close(); return false; }
    return showIn(win, panelId, title);
  } catch (error) {
    console.warn(`[panels] ${panelId} could not open in a window of its own:`, error?.message || error);
    try { win?.close(); } catch { /* already gone */ }
    return false;
  }
}

function showIn(win, panelId, title) {
  const doc = win.document;
  doc.title = title ? `${title} · Oculith Draw` : 'Oculith Draw';
  const unmirror = mirrorDocument(win);
  const mount = doc.createElement('div');
  mount.className = 'ws-popout-root';
  mount.dataset.panel = panelId;
  doc.body.appendChild(mount);
  // The panel's clicks and keys reach its handlers in this window too.
  delegateEvents([...DelegatedEvents], doc);
  let closed = false;
  const gone = () => {
    if (closed) return;
    closed = true;
    remember(panelId, win);
    unmirror();
    const home = popoutOf(panelId)?.home;
    setOpen((all) => { const next = { ...all }; delete next[panelId]; return next; });
    place.put(panelId, home);
  };
  win.addEventListener('pagehide', gone);
  win.addEventListener('beforeunload', gone);
  win.addEventListener('resize', () => remember(panelId, win));
  // Closed by this page going away: the window goes with it.
  window.addEventListener('pagehide', () => { if (!win.closed) win.close(); }, { once: true });
  const home = place.take(panelId);
  setOpen((all) => ({ ...all, [panelId]: { win, mount, home, gone, title: doc.title } }));
  return true;
}

// The shell's window of a panel (a page's own close does not always end it).
async function closeShellWindow(title) {
  const api = typeof window !== 'undefined' ? window.__TAURI__?.window : null;
  if (!api?.getAllWindows || !title) return;
  try {
    for (const w of await api.getAllWindows()) {
      if (String(w.label).startsWith('panel-') && (await w.title()) === title) await w.destroy();
    }
  } catch (error) {
    console.warn('[panels] a panel window could not be closed:', error?.message || error);
  }
}

/** Put `panelId` back where it was in the app and close its window. */
export function dockPanel(panelId) {
  const have = popoutOf(panelId);
  if (!have) return;
  const title = have.title;
  have.gone();
  if (!have.win.closed) have.win.close();
  void closeShellWindow(title);
}
