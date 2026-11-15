// Sections an edition adds to the AI connections panel
// (components/dialogs/AiConnectionsDialog.jsx), below the editor's own client
// list. The editor knows nothing about what a section does: it renders the
// section's component, loaded on first open, and hands it the panel's API:
//
//   { scanOf(clientId), propose(plan, label, note?), busy(), port() }
//
// `propose` takes a plan from ai-connections.js (planEdit, planConnect) and
// shows it as a diff for the user to apply, with the same refusals and safe
// write as the editor's own rows. `note` is shown after a successful write.

export const AI_CONNECTIONS_SECTIONS_API_VERSION = 1;

const sections = new Map();
const listeners = new Set();

/**
 * Register a section: `{ id, order?, load }`, where `load()` resolves to a
 * module whose default export is a Solid component taking `{ api }`.
 * Registering an id again replaces it. Returns a function that removes it.
 */
export function registerAiConnectionsSection(section, { apiVersion } = {}) {
  if (apiVersion !== AI_CONNECTIONS_SECTIONS_API_VERSION) {
    throw new Error(`AI connections sections API ${apiVersion} is not supported (this editor has ${AI_CONNECTIONS_SECTIONS_API_VERSION}).`);
  }
  if (!section || typeof section.id !== 'string' || !/^[a-z][a-z0-9.-]{0,63}$/.test(section.id) || typeof section.load !== 'function') {
    throw new Error('An AI connections section needs an id (lowercase) and a load() function.');
  }
  const entry = Object.freeze({ id: section.id, order: Number(section.order) || 0, load: section.load });
  sections.set(entry.id, entry);
  listeners.forEach((fn) => fn());
  return () => {
    if (sections.get(entry.id) === entry) {
      sections.delete(entry.id);
      listeners.forEach((fn) => fn());
    }
  };
}

/** The registered sections, in order. */
export function aiConnectionsSections() {
  return [...sections.values()].sort((a, b) => a.order - b.order || a.id.localeCompare(b.id));
}

export function subscribe(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}
