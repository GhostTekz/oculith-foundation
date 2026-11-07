#!/usr/bin/env node
// Regenerates js/solid/data/lucideIcons.js from a local lucide-react install.
//
// Oculith Draw does not depend on Lucide at runtime: this script reads the
// icon node arrays from lucide-react's ESM build (dist/esm/icons/<name>.mjs)
// and writes a small vendored module containing only the icons the UI uses.
// The source used for the committed file is the lucide-react 1.55.0 package
// that the Oculith desktop app pins (Oculith desktop/package-lock.json at
// commit 7efdf6a1). Pass the package directory as the first argument, or set
// LUCIDE_REACT_DIR; the default is open-pdf-studio/node_modules/lucide-react.
//
// Usage (from open-pdf-studio/):
//   node scripts/generate-lucide-icons.mjs [path/to/lucide-react]
// Add a name to ICONS below and rerun; the script fails on an unknown name.

import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const appDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DEFAULT_SOURCE = process.env.LUCIDE_REACT_DIR || path.join(appDir, 'node_modules/lucide-react');
const OUTPUT = path.join(appDir, 'js/solid/data/lucideIcons.js');

export const ICONS = [
  // symbol palette groups (Oculith categories)
  'zap', 'lightbulb', 'flame', 'network', 'shield', 'fan',
  // the external editor markup tools: typewriter, hyperlink, flag, snapshot, format painter, multiply
  'type', 'link', 'flag', 'camera', 'paintbrush', 'copy-plus',
  'align-center-horizontal', 'align-center-vertical', 'align-end-horizontal', 'align-end-vertical',
  'align-horizontal-distribute-center', 'align-horizontal-distribute-end',
  'align-horizontal-distribute-start', 'align-horizontal-space-around', 'align-start-horizontal',
  'align-start-vertical', 'align-vertical-distribute-center', 'align-vertical-distribute-end',
  'align-vertical-distribute-start', 'align-vertical-space-around', 'arrow-down-to-line',
  'arrow-down-up', 'arrow-left-right', 'arrow-right-to-line', 'arrow-up-down', 'arrow-up-right',
  'arrow-up-to-line', 'blend', 'book-open', 'book-open-text', 'bookmark', 'box', 'bring-to-front',
  'chevron-down', 'chevron-up', 'chevron-first', 'chevron-last', 'chevron-left', 'chevron-right',
  'chevrons-left',
  'circle', 'circle-check', 'clipboard', 'clipboard-copy', 'clipboard-paste', 'columns-2',
  'combine', 'contrast', 'copy', 'crop', 'diameter', 'download', 'drafting-compass', 'droplet',
  'droplets', 'eraser', 'expand', 'eye', 'eye-off', 'file', 'file-archive', 'file-cog', 'file-down',
  'file-image', 'file-minus', 'file-output', 'file-pen-line', 'file-plus', 'file-x', 'files',
  'flip-horizontal-2', 'flip-vertical-2', 'folder-open', 'gallery-vertical', 'git-compare-arrows',
  'grid-2x2', 'group', 'hand', 'highlighter', 'history', 'image', 'image-off', 'info', 'keyboard',
  'layers', 'layout-grid', 'list', 'list-ordered', 'list-tree', 'locate', 'lock', 'lock-open', 'magnet',
  'mail', 'map-pin', 'maximize', 'merge', 'message-square', 'message-square-off',
  'message-square-reply', 'minimize', 'minus', 'monitor', 'mouse-pointer-2', 'mouse-pointer-click',
  'move', 'move-horizontal', 'panel-left', 'panel-right', 'panel-top', 'paperclip',
  'pen-tool', 'pencil', 'pentagon', 'plus', 'printer', 'printer-check', 'proportions', 'puzzle',
  'qr-code', 'redo-2', 'refresh-ccw', 'refresh-cw', 'rotate-ccw', 'rotate-cw', 'rows-2',
  'ruler-dimension-line', 'save', 'save-all', 'scaling', 'scan', 'scan-search', 'scan-text',
  'scissors', 'scissors-line-dashed', 'search', 'send-to-back', 'settings', 'sheet', 'shield-check',
  'signature', 'sliders-horizontal', 'spline', 'spline-pointer', 'split', 'square', 'square-dashed',
  'square-dashed-mouse-pointer', 'square-pen', 'square-x', 'stamp', 'sticky-note', 'sun', 'table',
  'tag', 'text-cursor', 'text-cursor-input', 'toolbox', 'trash-2', 'undo-2', 'ungroup',
  'unlink', 'x', 'zoom-in', 'zoom-out',
  // Properties toolbar, document tabs and context menus (the external editor workspace WP4)
  'bold', 'italic', 'underline', 'text-align-start', 'text-align-center', 'text-align-end',
  'file-text', 'app-window',
  // panel hosts and access bars (the external editor workspace WP2)
  'chevrons-right', 'chevrons-down', 'grip-horizontal', 'external-link',
  // Navigation bar and status bar (the external editor workspace WP3)
  'circle-arrow-left', 'circle-arrow-right', 'circle-user', 'corner-down-right', 'grid-2x2-check',
  'grid-3x3', 'repeat-2', 'sun-moon',
  // menu bar, command palette and Window menu (the external editor workspace WP1)
  'log-out', 'command', 'panel-bottom', 'moon', 'file-search',
  // Tool Chest and Markups List panels (the external editor panel parity)
  'share', 'funnel', 'columns-3', 'square-minus', 'square-plus',
  // workflow toolbar, Quick Access and the command palette
  'pin', 'pin-off', 'ruler', 'list-checks', 'cable', 'message-square-text',
  'panel-top-close', 'panel-top-open',
  // edition and add-on workflow tools (distinct icons beside the built-in ones)
  'gauge', 'file-diff', 'land-plot', 'server', 'shapes', 'route', 'sparkles',
];

const ICON_ATTRS = 'xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"';

function escapeAttr(value) {
  return String(value).replaceAll('&', '&amp;').replaceAll('"', '&quot;').replaceAll('<', '&lt;');
}

export function nodeToSvg(node) {
  const children = node.map(([tag, attrs]) => {
    const parts = Object.entries(attrs).filter(([name]) => name !== 'key')
      .map(([name, value]) => `${name}="${escapeAttr(value)}"`);
    return `<${tag} ${parts.join(' ')}/>`;
  }).join('');
  return `<svg ${ICON_ATTRS}>${children}</svg>`;
}

export async function readIconNode(source, name) {
  const file = path.join(source, 'dist/esm/icons', `${name}.mjs`);
  const text = await readFile(file, 'utf8');
  // Deprecated names are re-exports of the renamed icon.
  const alias = text.match(/export \{ default \} from '\.\/([a-z0-9-]+)\.mjs';/);
  if (alias) return readIconNode(source, alias[1]);
  const match = text.match(/const __iconData = (\{[\s\S]*?\n\});/);
  if (!match) throw new Error(`No icon data in ${file}`);
  // The __iconData literal is plain data: name, size, aliases and the node
  // array of [tag, attributes] pairs.
  const node = Function(`"use strict"; return (${match[1]});`)().node;
  if (!Array.isArray(node) || !node.every(([tag, attrs]) => typeof tag === 'string' && attrs && typeof attrs === 'object')) {
    throw new Error(`Unexpected icon node shape in ${file}`);
  }
  return node;
}

async function main() {
  const source = path.resolve(process.argv[2] || DEFAULT_SOURCE);
  const pkg = JSON.parse(await readFile(path.join(source, 'package.json'), 'utf8'));
  const license = (await readFile(path.join(source, 'LICENSE'), 'utf8')).trim();
  const names = [...new Set(ICONS)].sort();
  const entries = [];
  for (const name of names) entries.push([name, nodeToSvg(await readIconNode(source, name))]);
  const licenseComment = license.split('\n').map(line => ` * ${line}`.trimEnd()).join('\n');
  const body = entries.map(([name, svg]) => `  ${JSON.stringify(name)}: ${JSON.stringify(svg)},`).join('\n');
  const out = `/*
 * Vendored Lucide icons for Oculith Draw. GENERATED by
 * scripts/generate-lucide-icons.mjs; do not edit by hand.
 *
 * Source: ${pkg.name} ${pkg.version} (dist/esm/icons/*.mjs), the version pinned by
 * Oculith desktop/package-lock.json at commit 7efdf6a1, read from that
 * package's installed files.
 * Only the icon geometry is copied; strings use a 24px viewBox, currentColor
 * and a 1.75 stroke to match the Oculith desktop icon treatment.
 *
 * License: ISC (Lucide Icons and Contributors; some icons derived from
 * Feather, MIT). The full text is retained below and in
 * src-tauri/package-notices/lucide-LICENSE.
 *
${licenseComment}
 */

export const LUCIDE_VERSION = ${JSON.stringify(pkg.version)};
export const LUCIDE_LICENSE = 'ISC';

export const LUCIDE_ICONS = Object.freeze({
${body}
});

/** SVG markup for a vendored Lucide icon; throws for a name not vendored. */
export function lucide(name) {
  const svg = LUCIDE_ICONS[name];
  if (!svg) throw new Error(\`Lucide icon not vendored: \${name}\`);
  return svg;
}
`;
  await writeFile(OUTPUT, out);
  console.log(`wrote ${path.relative(appDir, OUTPUT)} (${entries.length} icons from ${pkg.name} ${pkg.version})`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main();
}
