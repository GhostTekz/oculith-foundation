// Set Batch Link (docs/reference/editor/sets-and-batch.md): Batch Link over a Set or picked
// PDFs, with /GoToR links between the files, and Generate Bookmarks from Page
// Labels for the open document.

import { registerCommand } from './registry.js';
import { lucide } from '../data/lucideIcons.js';
import { editable, ask } from './util.js';

registerCommand({
  id: 'batch.setLink', label: 'common:setBatchLink.command', icon: lucide('external-link'), category: 'batch',
  keywords: ['batch link', 'set', 'sheet reference', 'gotor', 'cross document', 'hyperlink', 'remove links', 'bookmarks'],
  run: () => import('../stores/dialogStore.js').then((m) => m.openDialog('set-batch-link')),
});

registerCommand({
  id: 'document.bookmarksFromLabels', label: 'common:setBatchLink.bookmarksCommand', icon: lucide('bookmark'), category: 'document',
  enabled: editable, keywords: ['bookmarks', 'outline', 'page labels', 'sheet numbers', 'generate'],
  run: async () => {
    const [app, { default: i18n }, { updateStatusMessage }] = await Promise.all([
      import('../../pdf/label-bookmarks-app.js'), import('../../i18n/config.js'), import('../../ui/chrome/status-bar.js'),
    ]);
    const labels = await app.activeDocumentLabels();
    if (!labels) { updateStatusMessage(i18n.t('common:setBatchLink.noLabels')); return 0; }
    const existing = (await import('../../core/state.js')).getActiveDocument()?.bookmarks?.length || 0;
    if (existing && !(await ask(i18n.t('common:setBatchLink.confirmReplaceBookmarks', { count: existing, labels: labels.length }),
      i18n.t('common:setBatchLink.bookmarksCommand')))) return 0;
    const count = await app.generateBookmarksFromLabels();
    updateStatusMessage(i18n.t('common:setBatchLink.bookmarksDone', { count }));
    return count;
  },
});
