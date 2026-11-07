// Registers every command (the registry module holds the API and the seed
// commands). Import this once at start-up (MenuBar.jsx does); the menus
// (menus.js), the command palette, toolbars and keyboard-handlers.js then
// find the commands by id.

export * from './registry.js';
import './file.js';
import './edit.js';
import './edit-tools.js';
import './view.js';
import './window.js';
import './document.js';
import './tools.js';
import './arrange.js';
import './oculith.js';
import './batch-summary.js';
import './batch-ops.js';
import './capture.js';
import './visual-search.js';
import './line-styles.js';
import './set-batch-link.js';
// The context-menu actions (replies, lock, default style, …) for the palette.
import './markup-actions.js';
// Previous / Next View, Dimmer and Dark Mode (Navigation bar work package).
import '../../ui/chrome/navigation-commands.js';
import './multiview.js';
// Workflow toolbar tabs and the edition's own commands.
import './workflow.js';
