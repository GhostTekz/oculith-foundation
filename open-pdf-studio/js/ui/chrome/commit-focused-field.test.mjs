import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { commitFocusedPropertyField } from './commit-focused-field.js';

function field(tagName, inPanel) {
  const el = { tagName, blurred: 0, blur() { this.blurred++; },
    closest: (s) => (s === '#properties-panel' && inPanel ? {} : null) };
  return el;
}

test('a focused Properties field is blurred so its change event commits it', () => {
  const subject = field('INPUT', true);
  assert.equal(commitFocusedPropertyField({ activeElement: subject }), true);
  assert.equal(subject.blurred, 1);
  const note = field('TEXTAREA', true);
  commitFocusedPropertyField({ activeElement: note });
  assert.equal(note.blurred, 1);
});

test('focus elsewhere is left alone', () => {
  const find = field('INPUT', false);
  assert.equal(commitFocusedPropertyField({ activeElement: find }), false);
  assert.equal(find.blurred, 0);
  const btn = field('BUTTON', true);
  assert.equal(commitFocusedPropertyField({ activeElement: btn }), false);
  assert.equal(commitFocusedPropertyField({ activeElement: null }), false);
  assert.equal(commitFocusedPropertyField(null), false);
});

test('switchToTab commits the field before the active document changes', () => {
  const src = readFileSync(new URL('./tabs.js', import.meta.url), 'utf8');
  const fn = src.slice(src.indexOf('export function switchToTab'));
  const commit = fn.indexOf('commitFocusedPropertyField()');
  assert.ok(commit > 0);
  assert.ok(commit < fn.indexOf('state.activeDocumentIndex = '), 'before the switch');
  assert.match(fn.slice(0, commit), /if \(index !== state\.activeDocumentIndex\) $/u);
});
