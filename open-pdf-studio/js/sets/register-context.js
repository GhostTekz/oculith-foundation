import { sheetRegister } from '../solid/stores/sheetRegisterStore.js';

// A read-only copy for optional add-ons. Keep the store and its write method
// private to the editor; callers cannot change the registered drawing set.
function sourceCopy(source) {
  return Object.freeze({ filePath: source.filePath, page: source.page,
    ...(source.revision !== undefined ? { revision: source.revision } : {}),
    ...(source.sourceSha256 ? { sourceSha256: source.sourceSha256 } : {}) });
}

export function drawingSetSnapshot() {
  const register = sheetRegister();
  return Object.freeze({ name: register.name, sheets: Object.freeze(register.sheets.map((sheet) =>
    Object.freeze({ id: sheet.id, label: sheet.label, title: sheet.title,
      // The number and title were read by a title block template the user marked.
      fromTitleBlockTemplate: !!sheet.titleBlockTemplate,
      current: sourceCopy(sheet),
      history: Object.freeze(sheet.history.map(sourceCopy)),
      aliases: Object.freeze((sheet.sourceAliases || []).map(sourceCopy)) }))) });
}
