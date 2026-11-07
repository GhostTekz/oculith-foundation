// The workflow toolbar (WorkflowBar.jsx, workflows.js): no command is lost in
// the reorganisation (every registered command, and every command that
// existed before it, is reachable from a menu, a workflow tab or the command
// palette), every workflow tool is a registered command with an icon and en/nl
// labels, edition workflows land in tab order and in the Tools menu, the tool
// row fits by dropping labels before tools, Quick Access pins persist, and the
// workflow tab follows the profile. Real registry and state store (browser
// build of Solid, see ../../core/app-test-hooks.mjs).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { register } from 'node:module';
import { readFileSync } from 'node:fs';

register('../../core/app-test-hooks.mjs', import.meta.url);
const { installeerBrowserStubs } = await import('../../core/app-test-hooks.mjs');
installeerBrowserStubs();

const reg = await import('./index.js');
const { menuCommandIds, menuPathOf, MENUS, walkMenus } = await import('./menus.js');
const wf = await import('./workflows.js');
const { paletteResults, PALETTE_HIDDEN } = await import('./palette.js');
const { planFit, ICON_BUTTON_PX, SEPARATOR_PX, MORE_PX } = await import('../components/workflow-fit.js');
const qa = await import('../stores/quickAccess.js');
const store = await import('../stores/workflowStore.js');
const wl = await import('../stores/workspaceLayout.js');
const profiles = await import('../stores/workspaceProfiles.js');
const { state } = await import('../../core/state.ts');

const read = (rel) => readFileSync(new URL(rel, import.meta.url), 'utf8');
const BASELINE = JSON.parse(read('./command-baseline.json'));
const locale = (lang) => JSON.parse(read(`../../i18n/locales/${lang}/common.json`).replace(/^﻿/, ''));
const bundles = { en: locale('en'), nl: locale('nl') };
const translate = (lang, key) => key.replace(/^common:/, '').split('.').reduce((o, k) => o?.[k], bundles[lang]);
const tEn = (key, opts) => {
  const v = translate('en', key);
  return typeof v === 'string' ? v.replace(/\{\{(\w+)\}\}/g, (_, k) => opts?.[k] ?? '') : key;
};

test('no command is lost: every command is reachable from a menu, a workflow tab or the palette', () => {
  const menus = menuCommandIds();
  const workflows = wf.workflowCommandIds();
  const palette = new Set(paletteResults('', tEn, 10_000).map((r) => r.cmd.id));
  const lost = reg.listCommands().map((c) => c.id).filter((id) => !menus.has(id) && !workflows.has(id) && !palette.has(id));
  assert.deepEqual(lost, []);
  // The palette lists every command except the few that need an argument
  // (and itself); those are in a menu.
  for (const cmd of reg.listCommands()) {
    if (PALETTE_HIDDEN.has(cmd.id)) assert.ok(menus.has(cmd.id), `${cmd.id} is in a menu`);
    else assert.ok(palette.has(cmd.id), `${cmd.id} is in the palette`);
  }
});

test('no command is lost: every command from before the workflow toolbar still exists and is in a menu', () => {
  assert.ok(BASELINE.length >= 260, `baseline has ${BASELINE.length} commands`);
  const menus = menuCommandIds();
  const missing = BASELINE.filter((id) => !reg.getCommand(id));
  assert.deepEqual(missing, [], 'registered');
  assert.deepEqual(BASELINE.filter((id) => !menus.has(id)), [], 'still in a menu');
});

test('every workflow tool is a registered command with an icon and en/nl labels', () => {
  assert.deepEqual(wf.WORKFLOW_IDS, ['sheets', 'review', 'markup', 'measure', 'takeoff', 'compare', 'output', 'view']);
  for (const workflow of wf.WORKFLOWS) {
    for (const lang of ['en', 'nl']) {
      assert.equal(typeof translate(lang, workflow.label), 'string', `${lang} ${workflow.label}`);
      for (const group of workflow.groups) assert.equal(typeof translate(lang, group.label), 'string', `${lang} ${group.label}`);
    }
    assert.match(workflow.icon, /^<svg/);
    for (const group of workflow.groups) {
      assert.ok(group.items.length > 0, `${workflow.id}.${group.id} has tools`);
      for (const id of group.items) {
        const cmd = reg.getCommand(id);
        assert.ok(cmd, `${workflow.id}.${group.id}: ${id} is registered`);
        assert.match(cmd.icon || '', /^<svg/, `${id} has an icon (icon + label stay consistent)`);
      }
    }
  }
  // The workflow tabs are commands too: View ▸ Workflow ▸ <tab>, and the palette.
  for (const id of wf.WORKFLOW_IDS) {
    assert.ok(reg.getCommand(`view.workflow.${id}`), id);
    assert.deepEqual(menuPathOf(`view.workflow.${id}`), ['common:menu.view', 'common:menu.workflow']);
  }
  assert.equal(paletteResults('takeoff', tEn)[0].cmd.id, 'view.workflow.takeoff');
});

test('the workflows group the jobs: counting in Takeoff, scale in Measure, pages in Sheets, export in Output', () => {
  const has = (workflowId, id) => wf.getWorkflow(workflowId).groups.some((g) => g.items.includes(id));
  assert.ok(has('takeoff', 'tools.measure.count') && has('takeoff', 'window.panel.quantities'));
  assert.ok(has('measure', 'tools.measure.calibrate') && has('measure', 'tools.measure.length'));
  assert.ok(has('sheets', 'document.extractPages') && has('sheets', 'window.panel.thumbnails'));
  assert.ok(has('compare', 'document.compare') && has('compare', 'view.splitVertical'));
  assert.ok(has('output', 'file.print') && has('output', 'file.export'));
  assert.ok(has('selection', 'arrange.bringToFront') && wf.getWorkflow('selection').contextual === 'selection');
  // Opening the set is the first step: Sheets ▸ Set.
  const set = wf.getWorkflow('sheets').groups[0];
  assert.equal(set.id, 'set');
  assert.deepEqual(set.items, ['file.open', 'file.openRecent', 'batch.combine', 'file.import', 'view.goToSheet']);
  // Page preparation, not page setup, holds OCR; Spaces and Area are areas, not runs or finds.
  const groupOf = (workflowId, id) => wf.getWorkflow(workflowId).groups.find((g) => g.items.includes(id))?.id;
  assert.equal(groupOf('sheets', 'document.ocr'), 'prepare');
  assert.equal(groupOf('takeoff', 'window.panel.spaces'), 'areas');
  assert.equal(groupOf('takeoff', 'tools.measure.area'), 'areas');
  assert.equal(groupOf('takeoff', 'tools.visualSearch'), 'count');
  assert.equal(groupOf('output', 'batch.combine'), undefined, 'Combine opens a set (Sheets)');
});

test('workflow groups hold 2 to 8 tools, a tab at most 5 groups, and a tool once per tab', () => {
  for (const workflow of wf.BUILTIN_WORKFLOWS) {
    if (!workflow.contextual) assert.ok(workflow.groups.length <= 5, `${workflow.id}: ${workflow.groups.length} groups`);
    const seen = new Set();
    for (const group of workflow.groups) {
      if (!workflow.contextual) assert.ok(group.items.length >= 2 && group.items.length <= 8, `${workflow.id}.${group.id}: ${group.items.length}`);
      for (const id of group.items) {
        assert.ok(!seen.has(id), `${workflow.id}: ${id} twice`);
        seen.add(id);
      }
    }
  }
});

test('an edition workflow goes after the tab it names, a taken id is ignored, Tools gets its submenu', () => {
  const extra = { id: 'trade', label: 'common:workflow.takeoff', icon: '<svg/>', after: 'takeoff', groups: [{ id: 'g', label: 'x', items: ['file.open'] }] };
  const composed = wf.composeWorkflows(wf.BUILTIN_WORKFLOWS, [extra, { ...extra, id: 'review' }]);
  assert.deepEqual(composed.filter((w) => !w.contextual).map((w) => w.id),
    ['sheets', 'review', 'markup', 'measure', 'takeoff', 'trade', 'compare', 'output', 'view']);
  const noAfter = wf.composeWorkflows(wf.BUILTIN_WORKFLOWS, [{ ...extra, after: 'nope' }]);
  assert.equal(noAfter.findIndex((w) => w.id === 'trade'), noAfter.findIndex((w) => w.contextual) - 1, 'before the contextual tabs');
  // Profiles limit the tabs; an edition's tab shows unless the list names its own.
  assert.deepEqual(wf.visibleWorkflowIds(['view', 'review']), ['review', 'view']);
  assert.deepEqual(wf.visibleWorkflowIds(null), wf.WORKFLOW_IDS);
  // A profile can leave the edition and add-on tabs out (Document does).
  assert.deepEqual(wf.visibleWorkflowIds(null, { addOns: false }), wf.WORKFLOW_IDS);
  assert.equal(wl.profileShowsAddOnWorkflows('document'), false);
  assert.ok(wl.PROFILE_IDS.filter((id) => id !== 'document').every((id) => wl.profileShowsAddOnWorkflows(id)));
  // Foundation has no edition workflow, so Tools has no extra submenu.
  const tools = MENUS.find((m) => m.id === 'tools');
  assert.ok(!tools.items.some((i) => i.submenu && !i.submenu.startsWith('common:menu.')));
});

test('the tool row fits: labels go from the last group first, then tools move into More', () => {
  const groups = [{ full: 300, count: 4 }, { full: 200, count: 3 }, { full: 250, count: 5 }];
  const seps = 2 * SEPARATOR_PX;
  assert.deepEqual(planFit({ available: 750 + seps, groups }), { compactFrom: Infinity, visibleCount: Infinity });
  assert.deepEqual(planFit({ available: 500 + 5 * ICON_BUTTON_PX + seps, groups }), { compactFrom: 2, visibleCount: Infinity });
  assert.deepEqual(planFit({ available: 300 + 8 * ICON_BUTTON_PX + seps, groups }), { compactFrom: 1, visibleCount: Infinity });
  assert.deepEqual(planFit({ available: 12 * ICON_BUTTON_PX + seps, groups }), { compactFrom: 0, visibleCount: Infinity });
  const narrow = planFit({ available: 6 * ICON_BUTTON_PX + SEPARATOR_PX + MORE_PX, groups });
  assert.deepEqual(narrow, { compactFrom: 0, visibleCount: 6 });
  assert.equal(planFit({ available: 10, groups }).visibleCount, 1, 'one tool always shows');
});

test('Quick Access: default set, pin, unpin, move, reset; kept in preferences', () => {
  state.preferences.quickAccess = null;
  assert.deepEqual(qa.quickAccessIds(), [...qa.DEFAULT_QUICK_ACCESS]);
  assert.equal(qa.pinCommand('tools.measure.count'), true);
  assert.equal(qa.pinCommand('tools.measure.count'), false, 'once');
  assert.equal(qa.isPinned('tools.measure.count'), true);
  assert.deepEqual(state.preferences.quickAccess.at(-1), 'tools.measure.count');
  assert.equal(qa.movePinned('tools.measure.count', -1), true);
  assert.equal(qa.quickAccessIds().at(-2), 'tools.measure.count');
  assert.equal(qa.movePinned('file.open', -1), false, 'first stays first');
  assert.equal(qa.unpinCommand('file.open'), true);
  assert.ok(!qa.quickAccessIds().includes('file.open'));
  assert.deepEqual(qa.normalizeQuickAccess(['a', 'a', '', 3, 'b']), ['a', 'b']);
  assert.equal(qa.normalizeQuickAccess(Array.from({ length: 40 }, (_, i) => `c${i}`)).length, qa.MAX_QUICK_ACCESS);
  qa.resetQuickAccess();
  assert.equal(state.preferences.quickAccess, null);
});

test('the workflow tab follows the profile; a picked tab is remembered until the profile changes', () => {
  profiles.applyWorkspaceProfile('oculith', false);
  assert.equal(store.activeWorkflow(), 'markup', 'the profile opens on its workflow');
  assert.equal(reg.isCommandChecked('view.workflow.markup'), true);
  reg.runCommand('view.workflow.measure');
  assert.equal(store.activeWorkflow(), 'measure');
  assert.equal(state.preferences.activeWorkflow, 'measure');
  profiles.applyWorkspaceProfile('quantityTakeoff', false);
  assert.equal(store.activeWorkflow(), 'takeoff');
  profiles.applyWorkspaceProfile('basic', false);
  assert.deepEqual(store.shownWorkflowIds(), ['sheets', 'review', 'markup', 'measure', 'output', 'view']);
  assert.equal(store.activeWorkflow(), 'review');
  // A tab the profile does not show falls back to the profile's own.
  state.preferences.activeWorkflow = 'compare';
  assert.equal(store.activeWorkflow(), 'review');
  // A contextual tab shows only while its condition holds.
  assert.equal(store.setActiveWorkflow('selection'), true);
  assert.equal(store.activeWorkflow(), 'review', 'no selection: not shown');
  assert.deepEqual(store.contextualWorkflowIds(), []);
  assert.equal(store.setActiveWorkflow('nope'), false);
  // Every profile's workflows are known tabs, and its default is one of them.
  for (const id of wl.PROFILE_IDS) {
    const layout = wl.createProfileLayout(id);
    const shown = wf.visibleWorkflowIds(layout.workflows);
    assert.ok(shown.includes(layout.workflow), `${id} opens on a shown workflow`);
    for (const w of layout.workflows || []) assert.ok(wf.WORKFLOW_IDS.includes(w), `${id}: ${w}`);
  }
  profiles.applyWorkspaceProfile('oculith', false);
});

test('Oculith ▸ Profiles lists every profile, with labels in en and nl', () => {
  const items = [];
  walkMenus((item, path) => { if (path.at(-1) === 'common:menu.profiles') items.push(item.command); });
  assert.deepEqual(items, wl.PROFILE_IDS.map((id) => `oculith.profile.${id}`));
  for (const id of wl.PROFILE_IDS) {
    for (const lang of ['en', 'nl']) assert.equal(typeof translate(lang, reg.getCommand(`oculith.profile.${id}`).label), 'string', `${lang} ${id}`);
  }
});
