// Batch ▸ Summary (docs/reference/editor/sets-and-batch.md): one Markups Summary over many
// PDFs. The dialog picks the files and runs js/batch/runner.js; no PDF needs
// to be open.

import { registerCommand } from './registry.js';
import { lucide } from '../data/lucideIcons.js';

registerCommand({
  id: 'batch.summary', label: 'common:batchSummary.command', icon: lucide('sheet'), category: 'batch',
  keywords: ['markups summary', 'report', 'csv', 'xlsx', 'export markups', 'set'],
  run: () => import('../stores/dialogStore.js').then((m) => m.openDialog('batch-summary')),
});
