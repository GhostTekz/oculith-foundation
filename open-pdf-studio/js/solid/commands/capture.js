// Capture commands (WP2, docs/reference/editor/markup-tools.md): the File Attachment tool (F) and
// photos on the selected markup. Labels live in common.json › capture.

import { registerCommand } from './registry.js';
import { lucide } from '../data/lucideIcons.js';
import { SHORTCUTS, shortcutKeys } from '../../tools/shortcut-table.js';
import { editable, isTool, useTool, selection } from './util.js';
import { capturePhotos } from '../../annotations/capture.js';
import { TOOL_OF_COMMAND } from './tools.js';

const single = () => (selection().length === 1 ? selection()[0] : null);
const fileAttachmentKey = SHORTCUTS.find((e) => e.tool === 'fileAttachment');

TOOL_OF_COMMAND['tools.markup.fileAttachment'] = 'fileAttachment';
registerCommand({
  id: 'tools.markup.fileAttachment', label: 'common:capture.commands.fileAttachment', icon: lucide('paperclip'),
  shortcut: fileAttachmentKey ? shortcutKeys(fileAttachmentKey)[0] : null, category: 'tools.markup',
  enabled: editable, checked: () => isTool('fileAttachment'), keywords: ['attach', 'file', 'push pin', 'embed'],
  run: () => useTool('fileAttachment'),
});
registerCommand({
  id: 'tools.markup.attachPhoto', label: 'common:capture.commands.attachPhoto', icon: lucide('camera'),
  category: 'tools.markup', keywords: ['capture', 'photo', 'picture', 'camera', 'as-built'],
  enabled: () => editable() && !!single() && !single().locked && !single().readOnly,
  run: () => import('../../annotations/capture-actions.js').then((m) => m.attachPhotosTo(single())),
});
registerCommand({
  id: 'tools.markup.viewPhotos', label: 'common:capture.commands.viewPhotos', icon: lucide('image'),
  category: 'tools.markup', keywords: ['capture', 'photo', 'viewer'],
  enabled: () => !!single() && capturePhotos(single()).length > 0,
  run: () => import('../../annotations/capture-actions.js').then((m) => m.openPhotoViewer(single())),
});
