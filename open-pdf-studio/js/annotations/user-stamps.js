// User stamps (docs/reference/editor/markup-tools.md): templates made in the stamp editor, kept in
// preferences (`userStamps`) and exported/imported as JSON.

import { createSignal } from 'solid-js';
import { state } from '../core/state.js';
import {
  CONTRACTOR_STAMPS, STAMP_LIMITS, cleanStampTemplate, parseUserStampsJson, serializeUserStamps,
} from './stamp-templates.js';

// Bumped on every change, so pickers and the editor re-read the list.
const [userStampsVersion, setUserStampsVersion] = createSignal(0);
export { userStampsVersion };

let persistPreferences = async () => {
  const { savePreferences } = await import('../core/preferences.js');
  savePreferences();
};
/** Tests replace the preferences writer. */
export function setUserStampPersistence(fn) { persistPreferences = fn; }

/** The user stamps, validated. */
export function getUserStamps() {
  userStampsVersion();
  const raw = state.preferences?.userStamps;
  return (Array.isArray(raw) ? raw : []).map(cleanStampTemplate)
    .filter(template => template && template.id.startsWith('user:'));
}

/** Built-in contractor stamps first, then the user's. */
export function allStampTemplates() {
  return [...CONTRACTOR_STAMPS, ...getUserStamps()];
}

export function findStampTemplate(id) {
  return allStampTemplates().find(template => template.id === id) || null;
}

function store(list) {
  state.preferences.userStamps = list;
  setUserStampsVersion(v => v + 1);
  return persistPreferences();
}

/** Add or replace a user stamp. Returns the stored template, or null. */
export async function saveUserStamp(template) {
  const clean = cleanStampTemplate(template);
  if (!clean || !clean.id.startsWith('user:')) return null;
  const list = getUserStamps();
  const index = list.findIndex(item => item.id === clean.id);
  if (index < 0 && list.length >= STAMP_LIMITS.stamps) return null;
  if (index >= 0) list[index] = clean; else list.push(clean);
  await store(list);
  return clean;
}

export async function deleteUserStamp(id) {
  const list = getUserStamps();
  if (!list.some(item => item.id === id)) return false;
  await store(list.filter(item => item.id !== id));
  return true;
}

export function exportUserStampsJson() {
  return serializeUserStamps(getUserStamps());
}

/** Import a stamps JSON text; returns { added, skipped }. */
export async function importUserStampsJson(text) {
  const list = getUserStamps();
  const { stamps, skipped } = parseUserStampsJson(text, allStampTemplates().map(item => item.id));
  const room = Math.max(0, STAMP_LIMITS.stamps - list.length);
  const added = stamps.slice(0, room);
  if (added.length) await store([...list, ...added]);
  return { added: added.length, skipped: skipped + stamps.length - added.length };
}
