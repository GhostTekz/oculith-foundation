// Het lagenpaneel (#468) is een Solid-component en draait niet onder kale
// node. De logica staat in annotations/annotatie-lagen.js (getoetst); dit zijn
// vangrails op de bron: waar het paneel staat, de huisstijl, en de teksten.
// Er is één paneel Lagen (links, zoals in the external editor): de markeringslagen bovenaan,
// de PDF-lagen van de tekening eronder.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';

const lees = (pad) => readFileSync(new URL(pad, import.meta.url), 'utf8');
const paneel = lees('./AnnotationLayersPanel.jsx');
const dialoog = lees('../dialogs/AnnotationLayerDeleteDialog.jsx');
const store = lees('../../stores/annotationLayersStore.js');
const app = lees('../../App.jsx');
// The former View ribbon button id still reaches the panel (commands/ribbon-buttons.js).
const lint = lees('../../commands/ribbon-buttons.js');
// De panelen staan in de paneelhosts (werkruimte); het register noemt ze.
const links = lees('../panels/panelRegistry.js');
const dialogHost = lees('../DialogHost.jsx');
const css = lees('../../../../styles/layout.css');

const LOCALES = '../../../i18n/locales';
const blok = (taal) => JSON.parse(lees(`${LOCALES}/${taal}/ribbon.json`)).annotationLayers;

test('één paneel Lagen: de markeringslagen staan in de tab links, niet los ernaast', () => {
  assert.doesNotMatch(app, /AnnotationLayersPanel/, 'geen apart zwevend paneel meer');
  const pdfLagen = lees('./panels/LayersPanel.jsx');
  assert.match(pdfLagen, /import AnnotationLayersPanel from '\.\.\/AnnotationLayersPanel\.jsx'/);
  // Markeringslagen boven, PDF-lagen eronder.
  assert.ok(pdfLagen.indexOf('<AnnotationLayersPanel />') < pdfLagen.indexOf('id="layers-pdf-section"'));
  assert.match(links, /id: 'layers', title: 'properties:leftPanel\.layersTab'/);
  // Via de opdracht van Venster > Panelen; { reveal: true } opent alleen (geen wisselknop).
  assert.match(lint, /'ribbon-annotation-layers': \['window\.panel\.annotationLayers', \{ reveal: true \}\]/);
  const venster = lees('../../commands/window.js');
  assert.match(venster, /SHOWN_AS = \{ annotationLayers: 'layers' \}/);
  assert.match(venster, /annotationLayers: \(\) => import\('\.\.\/stores\/annotationLayersStore\.js'\)\.then\(\(m\) => m\.showAnnotationLayersPanel\(\)\)/);
  assert.doesNotMatch(store, /toggleAnnotationLayersPanel/);
  assert.match(store, /switchToLeftPanelTab\(LAYERS_TAB\)/);
  assert.match(dialogHost, /'annotation-layer-delete': AnnotationLayerDeleteDialog/);
});

test('het paneel toont naam, aantal, zichtbaar, afdrukbaar en vergrendeld', () => {
  for (const sleutel of ['colName', 'colCount', 'colVisible', 'colPrintable', 'colLocked', 'colCurrent']) {
    assert.match(paneel, new RegExp(`annotationLayers\\.${sleutel}`), sleutel);
  }
  for (const actie of ['add', 'rename', 'delete', 'moveUp', 'moveDown',
    'showAll', 'hideAll', 'lockAll', 'unlockAll']) {
    assert.match(paneel, new RegExp(`annotationLayers\\.${actie}'`), actie);
  }
});

test('rechtsklik op een laag: hernoemen, verwijderen, alles selecteren, selectie hierheen, huidige laag', () => {
  const menu = paneel.slice(paneel.indexOf('id="al-row-menu"'));
  for (const [sleutel, actie] of [['rename', 'beginHernoemen'], ['delete', 'requestDeleteAnnotationLayer'],
    ['selectAll', 'selectAnnotationsOnLayer'], ['moveSelectionHere', 'moveSelectionToAnnotationLayer'],
    ['makeCurrent', 'setCurrentAnnotationLayer']]) {
    assert.match(menu, new RegExp(`${actie}[\\s\\S]{0,80}annotationLayers\\.${sleutel}'`), sleutel);
  }
  assert.match(paneel, /onContextMenu=\{\(e\) => openMenu\(e, rij\(\)\)\}/);
  // A row click selects that layer's markups in the Markups List.
  assert.match(paneel, /function kiesLaag\(id\) \{\s*setGekozen\(id\);\s*selectAnnotationsOnLayer\(id\);\s*\}/);
  assert.match(paneel, /onClick=\{\(\) => kiesLaag\(rij\(\)\.id\)\}/);
  const lijst = lees('./panels/AnnotationsPanel.jsx');
  assert.match(lijst, /onSectionHeaderClick/);
  assert.match(lijst, /selectAnnotationsOnLayer\(item\.layerId\)/);
  assert.match(lijst, /event\.shiftKey/);
  assert.match(lijst, /layerRangeIds\(headers, layerAnchorId, item\.layerId\)/);
  assert.match(lijst, /selectAnnotationsOnLayers\(/);
  assert.match(lijst, /closest\?\.\('\.annotations-group-chevron'\)/);
  assert.match(store, /list\.updateAnnotationsList\(\)/);
  assert.match(store, /listStore\.expandGroup\(list\.markupLayerName/);
  // Iconen uit de gevendorde Lucide-set, geen eigen SVG.
  assert.doesNotMatch(paneel, /<svg/);
  assert.match(paneel, /lucide\('eye'\)/);
});

test('verwijderen vraagt wat er met de markeringen gebeurt, in een echte dialoog', () => {
  // Het basisvenster Dialog is verplaatsbaar en sluit niet bij een klik ernaast.
  assert.match(dialoog, /import Dialog from '\.\.\/Dialog\.jsx'/);
  assert.match(dialoog, /<Dialog[\s>]/);
  assert.match(dialoog, /annotationLayers\.deleteMove/);
  assert.match(dialoog, /annotationLayers\.deleteRemove/);
  // Een lege laag gaat zonder vraag weg; een volle laag opent de dialoog.
  assert.match(store, /openDialog\('annotation-layer-delete'/);
});

test('huisstijl: standaardcursor, geen afgeronde hoeken, geen animaties', () => {
  for (const [naam, bron] of [['paneel', paneel], ['dialoog', dialoog]]) {
    assert.doesNotMatch(bron, /cursor\s*:/, `${naam}: geen eigen cursor`);
    assert.doesNotMatch(bron, /border-radius|transition|animation/, `${naam}: geen rondingen of animaties`);
  }
  const begin = css.indexOf('/* Markeringslagen');
  const eind = css.indexOf('/* einde Markeringslagen */');
  assert.ok(begin >= 0 && eind > begin, 'de stijlen van het paneel staan in één blok');
  const stijl = css.slice(begin, eind);
  assert.doesNotMatch(stijl, /cursor\s*:(?!\s*default\b)/, 'alleen de standaardcursor');
  assert.doesNotMatch(stijl, /border-radius|transition|animation/);
  // Oculith-tokens voor het rijmenu en de secties.
  assert.match(stijl, /var\(--ox-/);
});

test('Engels en Nederlands hebben dezelfde sleutels, geen enkele leeg', () => {
  const en = blok('en');
  const nl = blok('nl');
  assert.ok(en && nl, 'blok annotationLayers ontbreekt');
  assert.deepEqual(Object.keys(nl).sort(), Object.keys(en).sort());
  for (const [taal, b] of [['en', en], ['nl', nl]]) {
    for (const [k, v] of Object.entries(b)) assert.ok(typeof v === 'string' && v.trim(), `${taal}.${k} is leeg`);
  }
  const plek = (s) => (s.match(/\{\{\w+\}\}/g) || []).sort().join();
  for (const k of Object.keys(en)) assert.equal(plek(nl[k]), plek(en[k]), `plaatshouders van ${k}`);
});

test('elke gebruikte sleutel bestaat in het Engels', () => {
  const en = blok('en');
  const bronnen = [paneel, dialoog, store, lint, lees('../ContextMenu.jsx'), lees('./panels/LayersPanel.jsx')];
  const gebruikt = new Set();
  for (const bron of bronnen) {
    for (const m of bron.matchAll(/annotationLayers\.(\w+)/g)) gebruikt.add(m[1]);
  }
  assert.ok(gebruikt.size > 10);
  for (const k of gebruikt) assert.ok(k in en, `annotationLayers.${k} ontbreekt in en/ribbon.json`);
});

test('geselecteerde markeringen naar een laag: vanuit het paneel en het contextmenu', () => {
  assert.match(paneel, /moveSelectionToAnnotationLayer\(/);
  assert.match(paneel, /annotationLayers\.moveSelection'/);
  const menu = lees('../ContextMenu.jsx');
  // Het oude "geen lagen beschikbaar" is vervangen door de echte lagen, in het
  // menu van één annotatie én in dat van een meervoudige selectie.
  assert.doesNotMatch(menu, /noLayersAvailable/);
  assert.equal((menu.match(/<LayerSubmenu /g) || []).length, 2);
  assert.match(menu, /moveAnnotationsToAnnotationLayer\(/);
  // Eén undo-stap voor de hele verplaatsing.
  assert.match(store, /recordBulkModify\(/);
});

// De schrijfregel (#468): het document bewaart bij toewijzen een kopie. Het
// paneel, het contextmenu en de verwijderdialoog lopen allemaal via de store.
test('de store schrijft markeringen op de annotaties van het document, zonder de lijst te vervangen', () => {
  const verplaats = store.slice(store.indexOf('export async function moveAnnotationsToAnnotationLayer'));
  assert.match(verplaats.slice(0, 900), /annotationsInDocument\(doc, anns\)/, 'eerst de annotaties van het document zelf opzoeken');
  const verwijder = store.slice(store.indexOf('export async function deleteAnnotationLayer'), store.indexOf('export async function moveAnnotationsToAnnotationLayer'));
  assert.doesNotMatch(verwijder, /doc\.annotations\s*=/, 'geen nieuwe lijst toewijzen en daarna verder werken');
  assert.match(verwijder, /doc\.annotations\.splice\(/);
  // De lagen zelf schrijft alleen het model; de store wijst nooit zelf toe.
  assert.doesNotMatch(store, /\.annotationLayers\s*=/);
});

// Vindbaarheid: "hoe maak ik een laag?" De tab Lagen toont de markeringslagen
// bovenaan, met "Nieuwe laag" als knop met tekst; de lagen van de PDF zelf
// staan eronder, als weergave te schakelen (docs/foundation/PDF-LAYERS.md).
const pdfLagen = lees('./panels/LayersPanel.jsx');
const menu = lees('../ContextMenu.jsx');

test('de sectie PDF-lagen schakelt de weergave via de selectie-API, niet via de PDF', () => {
  const sectie = pdfLagen.slice(pdfLagen.indexOf('id="layers-pdf-section"'));
  assert.match(sectie, /leftPanel\.pdfLayersFromDrawing/);
  // Oog, alleen-deze, alles aan/uit, filter, terug naar standaard.
  for (const id of ['pdf-layers-filter', 'pdf-layers-show-all', 'pdf-layers-hide-all', 'pdf-layers-reset',
    'pdf-layers-save-default']) assert.match(sectie, new RegExp(`id="${id}"`), id);
  assert.match(sectie, /class="al-flag layer-list-eye"/);
  assert.match(sectie, /class="al-flag layer-list-solo"/);
  // Elke wijziging loopt via native-ocg-selection.js (wachtrij, caches, onthouden).
  for (const fn of ['setNativeOcgVisibility', 'soloNativeOcg', 'setAllNativeOcg', 'resetNativeOcgSelection',
    'saveNativeOcgSelectionAsDefault']) assert.match(pdfLagen, new RegExp(`m\\.${fn}\\(`), fn);
  // De PDF-standaard alleen na een bevestiging.
  const opslaan = pdfLagen.slice(pdfLagen.indexOf('const saveAsDefault'));
  assert.ok(opslaan.indexOf('showConfirm') < opslaan.indexOf('saveNativeOcgSelectionAsDefault'));
  // Een laag die niet te schakelen is, blijft uit.
  assert.match(sectie, /disabled=\{!layer\.toggleable\}/);
});

test('"Nieuwe laag" is een knop met zichtbare tekst die meteen laat hernoemen', () => {
  const knop = paneel.slice(paneel.indexOf('id="al-new-layer"'), paneel.indexOf('</button>', paneel.indexOf('id="al-new-layer"')));
  assert.match(knop, /<span>\{t\('annotationLayers\.add'\)\}<\/span>/);
  assert.match(knop, /onClick=\{nieuw\}/);
  const nieuw = paneel.slice(paneel.indexOf('function nieuw()'));
  assert.match(nieuw.slice(0, 200), /setBewerkId\(id\)/);
  // Ook een laag van het contextmenu opent in bewerking.
  assert.match(paneel, /renameRequest\(\)/);
});

test('het contextmenu Laag heeft "Nieuwe laag…" dat de markeringen erop zet', () => {
  const sub = menu.slice(menu.indexOf('function LayerSubmenu'), menu.indexOf('function ArrangeButton'));
  assert.match(sub, /t\('annotation\.newLayer'\)/);
  assert.match(sub, /moveAnnotationsToNewAnnotationLayer\(anns\(\)\)/);
  const nieuw = store.slice(store.indexOf('export async function moveAnnotationsToNewAnnotationLayer'));
  assert.match(nieuw.slice(0, 600), /addAnnotationLayer\(\)[\s\S]*moveAnnotationsToAnnotationLayer\(te, id\)[\s\S]*showAnnotationLayersPanel\(\{ renameId: id \}\)/);
});

test('alle 39 talen: de tab Lagen, PDF-lagen en Markeringslagen hebben elk een eigen naam', () => {
  const talen = readdirSync(new URL(LOCALES, import.meta.url));
  assert.equal(talen.length, 39);
  const json = (taal, ns) => JSON.parse(lees(`${LOCALES}/${taal}/${ns}.json`));
  const en = { common: json('en', 'common').leftPanel };
  assert.equal(json('en', 'properties').leftPanel.layers, 'PDF Layers');
  assert.equal(json('en', 'properties').leftPanel.layersTab, 'Layers');
  assert.equal(blok('en').buttonLabel, 'Markup Layers');
  for (const taal of talen) {
    const props = json(taal, 'properties').leftPanel;
    const al = json(taal, 'ribbon').annotationLayers || {};
    const common = json(taal, 'common').leftPanel;
    const nieuweLaag = json(taal, 'context').annotation.newLayer;
    for (const [k, v] of Object.entries({ tab: props.layersTab, pdf: props.layers, buttonLabel: al.buttonLabel,
      title: al.title, add: al.add, noLayers: common.noLayers, fromDrawing: common.pdfLayersFromDrawing,
      newLayer: nieuweLaag })) {
      assert.ok(typeof v === 'string' && v.trim(), `${taal}: ${k} ontbreekt`);
    }
    assert.notEqual(props.layersTab, al.buttonLabel, `${taal}: de tab en de lintknop heten hetzelfde`);
    assert.notEqual(props.layersTab, props.layers, `${taal}: de tab en de sectie PDF-lagen heten hetzelfde`);
    assert.notEqual(props.layers, al.title, `${taal}: de twee secties heten hetzelfde`);
    assert.ok(common.noLayers.includes(al.title), `${taal}: de lege stand noemt Markeringslagen`);
    assert.ok(nieuweLaag.endsWith('…'), `${taal}: Nieuwe laag… opent nog een stap`);
    if (taal !== 'en') {
      assert.notEqual(common.noLayers, en.common.noLayers, `${taal}: lege stand is Engels`);
      assert.notEqual(common.pdfLayersFromDrawing, en.common.pdfLayersFromDrawing, `${taal}: "uit de tekening" is Engels`);
    }
  }
});
