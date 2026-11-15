// Batch menu operations (docs/reference/editor/sets-and-batch.md): each opens the batch dialog for
// one operation; the dialog picks the files and runs js/batch/runner.js. No
// PDF needs to be open. OCR and Print need the desktop app (the OCR engine
// and the printer spooler are native); in the browser they stay disabled.
// Slip Sheet runs the Sets panel's "Slip sheet…" flow.

import { registerCommand } from './registry.js';
import { lucide } from '../data/lucideIcons.js';
import { isTauri } from '../../core/platform.js';
import { revealPanel } from './window.js';
import {
  cropMarginsIcon, rotateRightIcon, headerFooterIcon, ocrIcon, compressIcon, extractPagesIcon,
} from '../data/ribbonIcons.js';
import { flattenIcon } from '../data/contextMenuIcons.js';

const openBatch = (op) => import('../stores/dialogStore.js').then((m) => m.openDialog('batch-ops', { op }));

const OPS = [
  ['cropPageSetup', cropMarginsIcon, ['crop', 'page setup', 'page size', 'margins', 'resize']],
  ['rotate', rotateRightIcon, ['rotate pages', 'turn', 'orientation']],
  ['split', extractPagesIcon, ['split', 'extract pages', 'separate']],
  ['headersFooters', headerFooterIcon, ['header', 'footer', 'page numbers', 'file name']],
  ['applyStamp', lucide('stamp'), ['stamp', 'approved', 'reviewed', 'dynamic stamp']],
  ['ocr', ocrIcon, ['ocr', 'recognize text', 'scan', 'searchable']],
  ['reduceFileSize', compressIcon, ['compress', 'reduce', 'optimize', 'smaller']],
  ['repair', lucide('file-cog'), ['repair', 'fix', 'damaged', 'rebuild']],
  ['flatten', flattenIcon, ['flatten', 'burn markups', 'issue']],
  ['print', lucide('printer'), ['print', 'plot', 'printer']],
];
const DESKTOP = new Set(['ocr', 'print']);

for (const [op, icon, keywords] of OPS) {
  registerCommand({
    id: `batch.${op}`, label: `common:batchOps.command.${op}`, icon, category: 'batch',
    enabled: DESKTOP.has(op) ? () => isTauri() : undefined,
    keywords: [...keywords, 'batch', 'set', 'many files'],
    run: () => openBatch(op),
  });
}

registerCommand({
  id: 'batch.slipSheet', label: 'common:batchOps.command.slipSheet', icon: lucide('files'), category: 'batch',
  keywords: ['slip sheet', 'revision', 'replace sheets', 'carry markups', 'set'],
  run: async () => {
    await revealPanel('sheets');
    const { requestSlipSheet } = await import('../../sets/slip-sheet-request.js');
    requestSlipSheet();
  },
});
