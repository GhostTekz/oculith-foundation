// Tools ▸ Line Styles…: the line-style manager (custom line styles and
// imported .PAT hatch patterns, docs/reference/editor/markup-tools.md).

import { registerCommand } from './registry.js';
import { lucide } from '../data/lucideIcons.js';
import { openDialog } from '../stores/dialogStore.js';

registerCommand({
  id: 'tools.lineStyles', label: 'common:lineStyles.menu', icon: lucide('spline'), category: 'tools',
  keywords: ['line style', 'linetype', 'gas', 'water', 'fibre', 'hatch', 'pat', 'as-built'],
  run: () => openDialog('line-styles', {}),
});
