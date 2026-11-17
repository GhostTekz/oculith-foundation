import assert from 'node:assert/strict';
import test from 'node:test';
import { installHost, loadHostModules } from '../plugin/host.js';
import { addSheet, createSheetRegister } from './sheet-register.js';
import { saveSheetRegister, sheetRegister } from '../solid/stores/sheetRegisterStore.js';

test('add-ons see a frozen drawing-set copy without a write method or store reference', async () => {
  const path = '/drawings/M-101.pdf';
  const { register } = addSheet(createSheetRegister('Tower'), {
    filePath: path, page: 2, label: 'M-101', revision: 'B', sourceSha256: 'a'.repeat(64),
  });
  saveSheetRegister(register);
  installHost();
  const id = 'js/sets/register-context.js';
  await loadHostModules([id]);
  const module = globalThis.__ocudrawHost.module(id);
  assert.deepEqual(Object.keys(module), ['drawingSetSnapshot']);
  const snapshot = module.drawingSetSnapshot();
  assert.equal(snapshot.sheets[0].current.sourceSha256, 'a'.repeat(64));
  assert.equal(snapshot.sheets[0].current.page, 2);
  assert.equal(snapshot.sheets[0].fromTitleBlockTemplate, false);
  assert.equal(Object.isFrozen(snapshot.sheets[0].current), true);
  assert.throws(() => { snapshot.sheets[0].label = 'altered'; }, TypeError);
  assert.equal(sheetRegister().sheets[0].label, 'M-101');
  saveSheetRegister({ ...register, sheets: [{ ...register.sheets[0], titleBlockTemplate: 't1' }] });
  assert.equal(module.drawingSetSnapshot().sheets[0].fromTitleBlockTemplate, true);
  saveSheetRegister(createSheetRegister('Replacement'));
  assert.equal(snapshot.sheets.length, 1);
  assert.equal(module.drawingSetSnapshot().sheets.length, 0);
});
