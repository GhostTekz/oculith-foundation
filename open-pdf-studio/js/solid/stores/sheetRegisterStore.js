import { createSignal } from 'solid-js';
import { createSheetRegister, parseSheetRegister } from '../../sets/sheet-register.js';
import { parseTitleBlockTemplates } from '../../sets/title-block-template.js';

const STORAGE_KEY = 'oculithDraw.sheetRegister.v1';
// Title block templates kept as the user's defaults, for every drawing set.
const TEMPLATES_KEY = 'oculithDraw.titleBlockTemplates.v1';

function load() {
  try {
    const saved = globalThis.localStorage?.getItem(STORAGE_KEY);
    return saved ? parseSheetRegister(saved) : createSheetRegister();
  } catch (error) {
    console.warn('Could not restore drawing set:', error);
    return createSheetRegister();
  }
}

function loadUserTemplates() {
  try {
    const saved = globalThis.localStorage?.getItem(TEMPLATES_KEY);
    return saved ? parseTitleBlockTemplates(JSON.parse(saved)) : [];
  } catch (error) {
    console.warn('Could not restore title block templates:', error);
    return [];
  }
}

const [sheetRegister, setSheetRegister] = createSignal(load());
const [userTitleBlockTemplates, setUserTitleBlockTemplates] = createSignal(loadUserTemplates());

export function saveSheetRegister(register) {
  const checked = parseSheetRegister(register);
  globalThis.localStorage?.setItem(STORAGE_KEY, JSON.stringify(checked));
  setSheetRegister(checked);
}

export function saveUserTitleBlockTemplates(templates) {
  const checked = parseTitleBlockTemplates(templates);
  globalThis.localStorage?.setItem(TEMPLATES_KEY, JSON.stringify(checked));
  setUserTitleBlockTemplates(checked);
}

export { sheetRegister, userTitleBlockTemplates };
