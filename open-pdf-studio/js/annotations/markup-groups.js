// Markup groups (the external editor parity, docs/reference/editor/markups-list.md).
//
// Model, on every member of a group:
//   groupId    the top-level group's id. Everything that selects, moves or
//              copies "the group" keys on it (select-tool.js, multiply.js).
//   groupPath  [{ id, name, dominant }] from the top-level group down to the
//              innermost group the markup is in. groupPath[0].id === groupId.
//              `name` is the group's Subject in the Markups List ("Group" by
//              default, "Zone 1" in an external editor file); `dominant` is the id of
//              the dominant markup (the first selected), whose columns the
//              group row shows and which carries /GroupNesting in the PDF.
// A markup with only a groupId (a collection from before groupPath, a Tool
// Chest group) is a one-level group without a name. The two halves of a
// replacement (#508) also share a groupId (the caret's id): that is one
// correction, not a markup group, and is never listed as one.
//
// Pure: no DOM, no app imports beyond the correction model.

import { expandCorrectionGroups } from './corrections/model.js';

export const DEFAULT_GROUP_NAME = 'Group';

const nieuwId = () => 'grp_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 11);

/** The groupId a correction pair gives its halves itself, else null. */
export function correctionOwnGroup(annotations, ann) {
  if (!ann?.groupId) return null;
  if (expandCorrectionGroups(annotations, [ann]).length < 2) return null;
  return ann.type === 'caret' ? ann.id : ann.inReplyTo;
}

/**
 * The group levels a markup is in, top-level first ([] when it is in none).
 * @param {object} ann
 * @param {Set<string>} [correctionGroups]  ids of correction-pair groups
 */
export function groupPathOf(ann, correctionGroups) {
  if (!ann?.groupId) return [];
  if (Array.isArray(ann.groupPath) && ann.groupPath.length && ann.groupPath[0]?.id === ann.groupId) {
    return ann.groupPath;
  }
  if (correctionGroups?.has(ann.groupId)) return [];
  return [{ id: ann.groupId, name: '', dominant: null }];
}

/** Ids of the groups that only bind the halves of a replacement (#508). */
export function correctionGroupIds(annotations) {
  const uit = new Set();
  for (const a of annotations || []) {
    if (a?.type === 'caret' && a.intent === 'Replace' && a.groupId === a.id) uit.add(a.id);
  }
  return uit;
}

/** Every markup in the group `groupId`, at any level. */
export function membersOfGroup(annotations, groupId, correctionGroups = correctionGroupIds(annotations)) {
  if (!groupId) return [];
  return (annotations || []).filter((a) => groupPathOf(a, correctionGroups).some((g) => g.id === groupId));
}

/** The group level `groupId` as its members store it (name, dominant). */
export function groupLevel(annotations, groupId, correctionGroups = correctionGroupIds(annotations)) {
  for (const a of annotations || []) {
    const g = groupPathOf(a, correctionGroups).find((x) => x.id === groupId);
    if (g) return g;
  }
  return null;
}

/** The selection grown to whole top-level groups (the external editor selects a group as one). */
export function expandToGroups(annotations, selection) {
  const cg = correctionGroupIds(annotations);
  const tops = new Set();
  for (const a of selection || []) {
    const p = groupPathOf(a, cg);
    if (p.length) tops.add(p[0].id);
  }
  const uit = [...(selection || [])];
  const gezien = new Set(uit);
  if (tops.size) {
    for (const a of annotations || []) {
      if (gezien.has(a)) continue;
      const p = groupPathOf(a, cg);
      if (p.length && tops.has(p[0].id)) { uit.push(a); gezien.add(a); }
    }
  }
  return uit;
}

function zetPad(ann, pad, correctionGroups, annotations) {
  if (pad.length) {
    ann.groupPath = pad.map((g) => ({ id: g.id, name: g.name ?? '', dominant: g.dominant ?? null }));
    ann.groupId = pad[0].id;
    return;
  }
  delete ann.groupPath;
  // A replacement inside a group keeps its own pair link.
  const eigen = correctionOwnGroup(annotations, ann);
  if (eigen && !correctionGroups?.has?.(ann.groupId)) ann.groupId = eigen;
  else if (!correctionGroups?.has?.(ann.groupId)) delete ann.groupId;
}

// The units a selection groups: whole top-level groups and loose markups,
// in selection order.
function eenheden(annotations, selection, cg) {
  const uit = [];
  const perGroep = new Map();
  for (const a of selection || []) {
    const p = groupPathOf(a, cg);
    if (p.length) {
      if (!perGroep.has(p[0].id)) {
        const unit = { groupId: p[0].id, members: membersOfGroup(annotations, p[0].id, cg) };
        perGroep.set(p[0].id, unit);
        uit.push(unit);
      }
    } else {
      uit.push({ groupId: null, members: [a] });
    }
  }
  return uit;
}

/**
 * Group (Ctrl+G). Whole groups in the selection become subgroups of the new
 * group (nesting); loose markups grouped with exactly one nested group are
 * added to its top level instead (the external editor). The dominant markup is
 * `options.dominant` (the right-clicked one) or the first selected.
 * Mutates the members; returns { changed, before, groupId } or null.
 * @param {object[]} annotations
 * @param {object[]} selection
 * @param {{ dominant?: object, name?: string, id?: string, clone?: Function }} [options]
 */
export function groupMarkups(annotations, selection, options = {}) {
  const cg = correctionGroupIds(annotations);
  const sel = (selection || []).filter(Boolean);
  const units = eenheden(annotations, sel, cg);
  if (units.length < 2) return null;
  const alle = units.flatMap((u) => u.members);
  if (alle.some((a) => a.locked)) return null;
  const clone = options.clone || ((a) => JSON.parse(JSON.stringify(a)));
  const before = alle.map(clone);

  const groepen = units.filter((u) => u.groupId);
  const los = units.filter((u) => !u.groupId);
  const genest = groepen.length === 1
    && groepen[0].members.some((a) => groupPathOf(a, cg).length > 1);
  if (genest && los.length === units.length - 1) {
    // Into the top level of the nested group.
    const top = groupPathOf(groepen[0].members[0], cg)[0];
    for (const u of los) for (const a of u.members) zetPad(a, [top], cg, annotations);
    return { changed: alle, before, groupId: top.id };
  }
  const dominant = options.dominant && alle.includes(options.dominant) ? options.dominant : sel[0];
  const level = { id: options.id || nieuwId(), name: options.name || DEFAULT_GROUP_NAME, dominant: dominant.id };
  for (const a of alle) zetPad(a, [level, ...groupPathOf(a, cg)], cg, annotations);
  return { changed: alle, before, groupId: level.id };
}

/**
 * Ungroup (Ctrl+Shift+G): removes the top level of every group the
 * selection touches; nested groups become top-level groups (the external editor: one level
 * at a time). Returns { changed, before } or null.
 */
export function ungroupMarkups(annotations, selection, options = {}) {
  const cg = correctionGroupIds(annotations);
  const tops = new Set();
  for (const a of selection || []) {
    const p = groupPathOf(a, cg);
    if (p.length) tops.add(p[0].id);
  }
  if (!tops.size) return null;
  const doelen = (annotations || []).filter((a) => {
    const p = groupPathOf(a, cg);
    return p.length && tops.has(p[0].id);
  });
  const clone = options.clone || ((a) => JSON.parse(JSON.stringify(a)));
  const before = doelen.map(clone);
  for (const a of doelen) zetPad(a, groupPathOf(a, cg).slice(1), cg, annotations);
  return { changed: doelen, before };
}

/**
 * Remove Selected from Group: each selected markup leaves every group it is
 * in; a selected subgroup (`groupIds`) leaves the groups above it and keeps
 * its own nesting. A group level left with fewer than two units dissolves.
 */
export function removeFromGroup(annotations, selection, options = {}) {
  const cg = correctionGroupIds(annotations);
  const subgroepen = new Set(options.groupIds || []);
  const raak = new Map(); // ann -> new path
  for (const id of subgroepen) {
    for (const a of membersOfGroup(annotations, id, cg)) {
      const p = groupPathOf(a, cg);
      const i = p.findIndex((g) => g.id === id);
      if (i > 0) raak.set(a, p.slice(i));
    }
  }
  for (const a of selection || []) {
    if (raak.has(a)) continue;
    if (groupPathOf(a, cg).length) raak.set(a, []);
  }
  if (!raak.size) return null;
  const tops = new Set();
  for (const a of raak.keys()) tops.add(groupPathOf(a, cg)[0].id);
  const geraakt = (annotations || []).filter((a) => raak.has(a) || tops.has(groupPathOf(a, cg)[0]?.id));
  const clone = options.clone || ((a) => JSON.parse(JSON.stringify(a)));
  const before = geraakt.map(clone);
  for (const [a, pad] of raak) zetPad(a, pad, cg, annotations);
  normalizeGroups(annotations, geraakt, cg);
  return { changed: geraakt, before };
}

/**
 * Put markups into an existing group (a drop on its row in the Markups
 * List): they leave the groups they were in and join that group's level.
 * Markups already in the group stay where they are.
 */
export function addToGroup(annotations, markups, groupId, options = {}) {
  const cg = correctionGroupIds(annotations);
  const lid = membersOfGroup(annotations, groupId, cg)[0];
  if (!lid) return null;
  const pad = groupPathOf(lid, cg);
  const prefix = pad.slice(0, pad.findIndex((g) => g.id === groupId) + 1);
  const nieuw = (markups || []).filter((a) => a && !groupPathOf(a, cg).some((g) => g.id === groupId));
  if (!nieuw.length || nieuw.some((a) => a.locked)) return null;
  const oudeTops = new Set(nieuw.map((a) => groupPathOf(a, cg)[0]?.id).filter(Boolean));
  const geraakt = (annotations || []).filter((a) => nieuw.includes(a)
    || oudeTops.has(groupPathOf(a, cg)[0]?.id) || groupPathOf(a, cg)[0]?.id === prefix[0].id);
  const clone = options.clone || ((a) => JSON.parse(JSON.stringify(a)));
  const before = geraakt.map(clone);
  for (const a of nieuw) zetPad(a, prefix, cg, annotations);
  normalizeGroups(annotations, geraakt, cg);
  return { changed: geraakt, before };
}

/**
 * Remove Group Nesting: one flat group with every markup of the group (at
 * any level: a nested group flattens below itself).
 */
export function removeGroupNesting(annotations, groupId, options = {}) {
  const cg = correctionGroupIds(annotations);
  const leden = membersOfGroup(annotations, groupId, cg);
  const diepte = (a) => groupPathOf(a, cg).findIndex((g) => g.id === groupId);
  if (!leden.some((a) => groupPathOf(a, cg).length > diepte(a) + 1)) return null;
  const clone = options.clone || ((a) => JSON.parse(JSON.stringify(a)));
  const before = leden.map(clone);
  for (const a of leden) zetPad(a, groupPathOf(a, cg).slice(0, diepte(a) + 1), cg, annotations);
  return { changed: leden, before };
}

/** Rename a group (its Subject in the Markups List). */
export function renameGroup(annotations, groupId, name, options = {}) {
  const naam = String(name ?? '').trim();
  if (!naam) return null;
  const cg = correctionGroupIds(annotations);
  const leden = membersOfGroup(annotations, groupId, cg);
  if (!leden.length) return null;
  const clone = options.clone || ((a) => JSON.parse(JSON.stringify(a)));
  const before = leden.map(clone);
  for (const a of leden) {
    zetPad(a, groupPathOf(a, cg).map((g) => (g.id === groupId ? { ...g, name: naam } : g)), cg, annotations);
  }
  return { changed: leden, before };
}

/**
 * Dissolve every group level among `scope` that holds fewer than two units
 * (a markup, or a subgroup one level down), and give a level whose dominant
 * left a new dominant (its first member).
 */
export function normalizeGroups(annotations, scope, cg = correctionGroupIds(annotations)) {
  let veranderd = true;
  while (veranderd) {
    veranderd = false;
    const units = new Map(); // level id -> Set of unit keys
    const ledenVan = new Map();
    for (const a of scope) {
      const p = groupPathOf(a, cg);
      p.forEach((g, i) => {
        if (!units.has(g.id)) { units.set(g.id, new Set()); ledenVan.set(g.id, []); }
        units.get(g.id).add(p[i + 1]?.id ?? `m:${a.id}`);
        ledenVan.get(g.id).push(a);
      });
    }
    for (const [id, set] of units) {
      if (set.size >= 2) continue;
      for (const a of ledenVan.get(id)) zetPad(a, groupPathOf(a, cg).filter((g) => g.id !== id), cg, annotations);
      veranderd = true;
      break;
    }
    if (veranderd) continue;
    for (const [id, leden] of ledenVan) {
      const level = groupPathOf(leden[0], cg).find((g) => g.id === id);
      if (level.dominant && leden.some((a) => a.id === level.dominant)) continue;
      if (!level.dominant && !leden.some((a) => Array.isArray(a.groupPath))) continue;
      for (const a of leden) {
        zetPad(a, groupPathOf(a, cg).map((g) => (g.id === id ? { ...g, dominant: leden[0].id } : g)), cg, annotations);
      }
    }
  }
}

/**
 * Pasted or multiplied copies: groups copied whole get fresh ids (a copy is
 * a new group, not more members of the old one); a markup copied without the
 * rest of its group leaves the group. `sources[i]` was copied to `clones[i]`.
 */
export function relinkCopiedGroups(sources, clones, { newId = nieuwId } = {}) {
  const lijst = clones || [];
  // Run after relinkPastedCorrections: a copied replacement keeps its pair.
  const cg = correctionGroupIds(lijst);
  const nieuweIds = new Map((sources || []).map((s, i) => [s?.id, lijst[i]?.id]));
  const paden = new Map(lijst.filter(Boolean).map((c) => [c, groupPathOf(c, cg)]));
  const telling = new Map();
  for (const pad of paden.values()) for (const g of pad) telling.set(g.id, (telling.get(g.id) || 0) + 1);
  const ids = new Map();
  for (const [c, oud] of paden) {
    if (!oud.length) continue;
    const pad = oud.filter((g) => telling.get(g.id) >= 2).map((g) => {
      if (!ids.has(g.id)) ids.set(g.id, newId());
      return { id: ids.get(g.id), name: g.name, dominant: nieuweIds.get(g.dominant) ?? null };
    });
    if (pad.length) { c.groupPath = pad; c.groupId = pad[0].id; } else zetPad(c, [], cg, lijst);
  }
  normalizeGroups(lijst, lijst.filter(Boolean), cg);
  return lijst;
}

// --- Group row totals (the external editor: the sum when every member has the measure) ----

const LENGTE = new Set(['measureDistance', 'measurePerimeter']);

function som(members, past, waarde) {
  if (!members.length || !members.every(past)) return null;
  let unit = null;
  let total = 0;
  for (const a of members) {
    const v = Number(waarde(a));
    if (!Number.isFinite(v)) return null;
    const u = a.measureUnit || '';
    if (unit === null) unit = u;
    else if (u !== unit) return null;
    total += v;
  }
  return { value: total, unit: unit || '' };
}

/**
 * Count, Length and Area of a group: the sum over its members, or null when
 * a member does not have that measure (the cell is blank, as in the external editor).
 */
export function groupTotals(members) {
  const m = (members || []).filter(Boolean);
  const count = m.length && m.every((a) => a.type === 'count') ? m.length : null;
  return {
    count,
    length: som(m, (a) => LENGTE.has(a.type), (a) => a.measureValue),
    area: som(m, (a) => a.type === 'measureArea', (a) => a.measureValue),
  };
}

/** Totals as one line for the group row ("Length 12.5 ft"). */
export function groupTotalsText(totals, labels = { count: 'Count', length: 'Length', area: 'Area' }) {
  const delen = [];
  const getal = (v) => (Math.round(v * 100) / 100).toLocaleString('en-US');
  if (totals?.count != null) delen.push(`${labels.count} ${totals.count}`);
  if (totals?.length) delen.push(`${labels.length} ${getal(totals.length.value)}${totals.length.unit ? ` ${totals.length.unit}` : ''}`);
  if (totals?.area) delen.push(`${labels.area} ${getal(totals.area.value)}${totals.area.unit ? ` ${totals.area.unit}` : ''}`);
  return delen.join(' · ');
}

// --- Category eyes ---------------------------------------------------------

/**
 * The eye of a category (a list section or a group): 'shown' when every
 * member that its layer does not hide is shown, 'hidden' when none is,
 * 'mixed' otherwise; 'layer' when the layers hide them all.
 * @param {object[]} members
 * @param {(ann: object) => boolean} hiddenByLayer
 */
export function categoryEyeState(members, hiddenByLayer = () => false) {
  const eigen = (members || []).filter((a) => a && !hiddenByLayer(a));
  if (!eigen.length) return (members || []).length ? 'layer' : 'shown';
  const verborgen = eigen.filter((a) => a.hidden).length;
  if (verborgen === 0) return 'shown';
  return verborgen === eigen.length ? 'hidden' : 'mixed';
}

/**
 * Click on a category eye: hide all when all are shown, else show all.
 * Members hidden by their layer keep their own flag. Mutates; returns
 * { changed, before } (empty when nothing changed).
 */
export function toggleCategoryHidden(members, hiddenByLayer = () => false, options = {}) {
  const eigen = (members || []).filter((a) => a && !hiddenByLayer(a));
  const hide = categoryEyeState(eigen) === 'shown';
  const changed = eigen.filter((a) => !!a.hidden !== hide);
  const clone = options.clone || ((a) => JSON.parse(JSON.stringify(a)));
  const before = changed.map(clone);
  for (const a of changed) {
    if (hide) a.hidden = true;
    else delete a.hidden;
  }
  return { changed, before, hidden: hide };
}
