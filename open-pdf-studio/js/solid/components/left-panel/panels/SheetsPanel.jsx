import { For, Show, createMemo, createSignal, onMount, onCleanup } from 'solid-js';
import { activeTab } from '../../../stores/leftPanelStore.js';
import { sheetRegister, saveSheetRegister, userTitleBlockTemplates, saveUserTitleBlockTemplates } from '../../../stores/sheetRegisterStore.js';
import { setTitleBlockTemplates, updateSheet, replaceSheet, relinkSheet, relinkHistoricalSource, removeSheet, parseSheetRegister, filterSheets, sortSheetsByLabel, adjacentSheet, drawingLogCsv } from '../../../../sets/sheet-register.js';
import { addPdfPages, assertRecordedContentUnchanged, fingerprintPdfBytes, inspectPdfPages, matchingCurrentPdfSource, relinkMatchingPdfSource } from '../../../../sets/pdf-page-import.js';
import { inspectSheetFile, inspectHistoricalFiles } from '../../../../sets/sheet-file-status.js';
import { extractFileName, fileExists, isTauri, openFileDialog, readBinaryFile, saveFileDialog, writeBinaryFile, invoke } from '../../../../core/platform.js';
import { createTab } from '../../../../ui/chrome/tabs.js';
import { loadPDFIfNeeded } from '../../../../pdf/loader.js';
import { goToPage } from '../../../../pdf/renderer.js';
import { state } from '../../../../core/state.js';
import { openDialog } from '../../../stores/dialogStore.js';
import { useTranslation } from '../../../../i18n/useTranslation.js';
import { onSlipSheetRequest } from '../../../../sets/slip-sheet-request.js';
import { verifySheetRevisionCompare } from '../../../../sets/sheet-revision-compare.js';
import { buildSetRevisionSummary } from '../../../../sets/set-revision-summary.js';
import { buildSetPageGeometryAudit } from '../../../../sets/set-page-geometry.js';
import { buildSetTransmittalReadiness } from '../../../../sets/set-transmittal-readiness.js';
import { createCurrentDrawingLog, assertCurrentDrawingLog, currentDrawingLogCsv } from '../../../../sets/current-drawing-log.js';
import { applySheetMetadataReview, sheetMetadataReviewIssues } from '../../../../sets/sheet-metadata-review.js';
import { applyTitleBlockPlan, combinedTemplates, planTitleBlockApply } from '../../../../sets/title-block-template.js';
import { startCompare } from '../../../../compare/compare-store.js';
import { getPdfBytes } from '../../../../pdf/loader.js';

function safeName(name) {
  return (name || 'drawing-set').replace(/[\\/:*?"<>|]/g, '_');
}

export default function SheetsPanel() {
  const { t } = useTranslation('common');
  const [selectedId, setSelectedId] = createSignal(null);
  const [message, setMessage] = createSignal('');
  const [availability, setAvailability] = createSignal({});
  const [historyAvailability, setHistoryAvailability] = createSignal({});
  const [nextRevision, setNextRevision] = createSignal('');
  const [sourceCandidate, setSourceCandidate] = createSignal(null);
  const [applyingSource, setApplyingSource] = createSignal(false);
  const [importing, setImporting] = createSignal(false);
  const [exportingPdf, setExportingPdf] = createSignal(false);
  const [publishingSet, setPublishingSet] = createSignal(false);
  const [openingSheet, setOpeningSheet] = createSignal(false);
  const [slipReading, setSlipReading] = createSignal(false);
  const [suggestingDetails, setSuggestingDetails] = createSignal(false);
  const [detailSuggestion, setDetailSuggestion] = createSignal(null);
  const [compareCandidate, setCompareCandidate] = createSignal(null);
  const [compareBusy, setCompareBusy] = createSignal(false);
  const [revisionSummary, setRevisionSummary] = createSignal(null);
  const [summaryBusy, setSummaryBusy] = createSignal(false);
  const [geometryAudit, setGeometryAudit] = createSignal(null);
  const [geometryBusy, setGeometryBusy] = createSignal(false);
  const [transmittalReview, setTransmittalReview] = createSignal(null);
  const [transmittalBusy, setTransmittalBusy] = createSignal(false);
  const [packageSelectedIds, setPackageSelectedIds] = createSignal([]);
  const [packageIssueDetails, setPackageIssueDetails] = createSignal({ date: '', reference: '', note: '' });
  const [packagePreview, setPackagePreview] = createSignal(null);
  const [packageBusy, setPackageBusy] = createSignal(false);
  const [metadataReview, setMetadataReview] = createSignal(null);
  const [metadataBusy, setMetadataBusy] = createSignal(false);
  const [templateBusy, setTemplateBusy] = createSignal(false);
  const [templateResult, setTemplateResult] = createSignal(null);
  const titleBlockTemplates = createMemo(() => {
    const inSet = new Set((sheetRegister().titleBlockTemplates || []).map(item => item.id));
    const inDefaults = new Set(userTitleBlockTemplates().map(item => item.id));
    return combinedTemplates(sheetRegister().titleBlockTemplates, userTitleBlockTemplates())
      .map(template => ({ template, inSet: inSet.has(template.id), inDefaults: inDefaults.has(template.id) }));
  });
  const [query, setQuery] = createSignal('');
  const [revisionFilter, setRevisionFilter] = createSignal('');
  const [exportingCurrentView, setExportingCurrentView] = createSignal(false);
  const visibleSheets = createMemo(() => sortSheetsByLabel(filterSheets(sheetRegister(), query(), revisionFilter())));
  const visibleReadyPackageIds = createMemo(() => {
    const review = transmittalReview();
    if (review?.register !== sheetRegister()) return [];
    const visibleIds = new Set(visibleSheets().map(sheet => sheet.id));
    return review.rows.filter(row => row.status === 'ready' && visibleIds.has(row.sheetId))
      .map(row => row.sheetId);
  });
  const metadataIssues = createMemo(() => metadataReview()?.register === sheetRegister()
    ? sheetMetadataReviewIssues(sheetRegister(), metadataReview().rows) : new Map());
  const selectedIndex = () => visibleSheets().findIndex(sheet => sheet.id === selectedId());
  const currentRevisions = createMemo(() => [...new Set(sheetRegister().sheets.map(sheet => sheet.revision).filter(Boolean))]
    .sort((first, second) => first.localeCompare(second)));
  const selected = () => visibleSheets().find(sheet => sheet.id === selectedId());

  function onSheetListKeyDown(event) {
    const row = event.target.closest?.('.sheets-row');
    if (!row || !event.currentTarget.contains(row)) return;
    const rows = [...event.currentTarget.querySelectorAll('.sheets-row')];
    const index = rows.indexOf(row);
    let next;
    if (event.key === 'ArrowDown') next = Math.min(index + 1, rows.length - 1);
    else if (event.key === 'ArrowUp') next = Math.max(index - 1, 0);
    else if (event.key === 'Home') next = 0;
    else if (event.key === 'End') next = rows.length - 1;
    else return;
    event.preventDefault();
    event.stopPropagation();
    rows[next]?.focus();
    rows[next]?.click();
  }

  function inspectFile(path) {
    return inspectSheetFile(path, filePath => invoke('allow_fs_scope', { path: filePath }), fileExists);
  }

  async function refreshAvailability() {
    if (!isTauri()) return;
    const register = sheetRegister();
    const [entries, historical] = await Promise.all([
      Promise.all(register.sheets.map(async sheet => [sheet.id, await inspectFile(sheet.filePath)])),
      inspectHistoricalFiles(register, inspectFile),
    ]);
    setAvailability(Object.fromEntries(entries));
    setHistoryAvailability(historical);
  }

  onMount(refreshAvailability);
  // Batch ▸ Slip Sheet (sets/slip-sheet-request.js).
  onMount(() => onCleanup(onSlipSheetRequest(() => {
    if (sheetRegister().sheets.length) void slipSheet(); else setMessage(t('batchOps.slipSheetNeedsSet'));
  })));

  function commit(register) {
    saveSheetRegister(register);
    setDetailSuggestion(null);
    setCompareCandidate(null);
    setRevisionSummary(null);
    setGeometryAudit(null);
    setTransmittalReview(null);
    setPackageSelectedIds([]);
    setPackagePreview(null);
    setMetadataReview(null);
    setMessage('');
    void refreshAvailability();
  }

  async function suggestDetails() {
    const register = sheetRegister();
    const sheet = selected();
    if (!sheet || suggestingDetails()) return;
    setSuggestingDetails(true);
    setDetailSuggestion(null);
    setMessage('');
    try {
      const { suggestDetailsForSheet } = await import('../../../../sets/sheet-title-suggest-app.js');
      const suggestion = await suggestDetailsForSheet(sheet);
      if (sheetRegister() !== register || selectedId() !== sheet.id) return;
      setDetailSuggestion({ ...suggestion, register, sheetId: sheet.id,
        label: suggestion.label || sheet.label, title: suggestion.title || sheet.title,
        found: !!(suggestion.label || suggestion.title) });
      if (!suggestion.label && !suggestion.title) {
        setMessage(suggestion.selectableText
          ? 'No clearly labeled sheet number or title was found in the lower or right title-block area. Enter details manually.'
          : 'No selectable PDF text was found in the lower or right title-block area. Enter details manually for image-only sheets.');
      }
    } catch (error) { setMessage(`Could not read title-block text: ${error.message}`); }
    finally { setSuggestingDetails(false); }
  }

  function applyDetailSuggestion() {
    const candidate = detailSuggestion();
    const sheet = selected();
    if (!candidate?.found || !sheet || candidate.sheetId !== sheet.id
      || candidate.register !== sheetRegister()) return;
    try {
      commit(updateSheet(sheetRegister(), sheet.id, { label: candidate.label, title: candidate.title }));
      setMessage('Sheet details updated from the reviewed suggestion.');
    } catch (error) { setMessage(error.message); }
  }

  async function reviewSetMetadata() {
    if (metadataBusy() || !sheetRegister().sheets.length) return;
    const register = sheetRegister();
    setMetadataBusy(true);
    setMetadataReview(null);
    setMessage('');
    try {
      const { suggestDetailsForSheets } = await import('../../../../sets/sheet-title-suggest-app.js');
      const suggestions = await suggestDetailsForSheets(register.sheets);
      if (sheetRegister() !== register) return;
      setMetadataReview({ register, rows: sortSheetsByLabel(register.sheets).map(sheet => {
        const result = suggestions.get(sheet.id) || { error: 'Could not read the registered PDF.' };
        const label = result.label || sheet.label;
        const title = result.title || sheet.title;
        return { sheetId: sheet.id, filePath: sheet.filePath, page: sheet.page,
          sourceSha256: sheet.sourceSha256, originalLabel: sheet.label, originalTitle: sheet.title,
          label, title, evidence: result.evidence || {}, error: result.error || '',
          selectableText: result.selectableText, selected: !result.error
            && (label !== sheet.label || title !== sheet.title) };
      }) });
    } catch (error) { setMessage(`Could not review sheet metadata: ${error.message}`); }
    finally { setMetadataBusy(false); }
  }

  async function reviewIndexSheetTitles() {
    const register = sheetRegister();
    const indexSheet = selected();
    if (!indexSheet || metadataBusy()) return;
    setMetadataBusy(true);
    setMetadataReview(null);
    setMessage('');
    try {
      const { readIndexSheetTitles } = await import('../../../../sets/index-sheet-titles-app.js');
      const parsed = await readIndexSheetTitles(indexSheet, register.sheets);
      if (sheetRegister() !== register || selectedId() !== indexSheet.id) return;
      const paths = new Set();
      for (const sheet of register.sheets.filter(item => parsed.matched.has(item.id))) {
        paths.add(sheet.filePath);
      }
      const observed = new Map();
      for (const path of paths) {
        try {
          if (isTauri()) await invoke('allow_fs_scope', { path });
          const bytes = await readBinaryFile(path);
          observed.set(path, bytes?.length ? await fingerprintPdfBytes(bytes) : 'missing');
        } catch { observed.set(path, 'missing'); }
      }
      if (sheetRegister() !== register || selectedId() !== indexSheet.id) return;
      const conflicts = new Map(parsed.conflicts.map(item => [item.sheetId, item]));
      const rows = sortSheetsByLabel(register.sheets).filter(sheet => parsed.matched.has(sheet.id) || conflicts.has(sheet.id))
        .map(sheet => {
          const match = parsed.matched.get(sheet.id);
          const conflict = conflicts.get(sheet.id);
          const error = conflict ? conflict.reason : !sheet.sourceSha256
            ? 'No recorded PDF fingerprint for this target sheet.'
            : observed.get(sheet.filePath) !== sheet.sourceSha256
              ? 'Target PDF is missing or changed. Relink or record its source first.' : '';
          return { sheetId: sheet.id, filePath: sheet.filePath, page: sheet.page,
            sourceSha256: sheet.sourceSha256, originalLabel: sheet.label, originalTitle: sheet.title,
            label: sheet.label, title: match?.title || sheet.title, selected: !!match && !error
              && match.title !== sheet.title, error, evidence: {
              label: `Exact index match: ${sheet.label}`,
              title: match ? `Index page ${indexSheet.page}, line at y=${match.y}: ${match.evidence}`
                : conflict.lines.join(' / '),
            } };
        });
      setMetadataReview({ mode: 'index', register, rows, indexSource: {
        filePath: indexSheet.filePath, page: indexSheet.page,
        sourceSha256: indexSheet.sourceSha256, label: indexSheet.label,
      }, unmatched: parsed.unmatched, selectableText: parsed.selectableText });
      if (!rows.length && !parsed.unmatched.length) setMessage(parsed.selectableText
        ? 'No distinct sheet ID and title rows were found on the selected page.'
        : 'No selectable text was found on the selected page. Image-only indexes need manual entry.');
    } catch (error) { setMessage(`Could not review index sheet: ${error.message}`); }
    finally { setMetadataBusy(false); }
  }

  function editMetadataRow(id, changes) {
    setMetadataReview(current => current && ({ ...current,
      rows: current.rows.map(row => row.sheetId === id ? { ...row, ...changes } : row) }));
  }

  async function applyMetadataReview() {
    const review = metadataReview();
    if (!review || metadataBusy() || review.register !== sheetRegister()) return;
    setMetadataBusy(true);
    try {
      const next = review.mode === 'index'
        ? (await import('../../../../sets/index-sheet-titles.js')).applyIndexSheetTitleReview(review.register, review.rows)
        : applySheetMetadataReview(review.register, review.rows);
      const selected = review.rows.filter(row => row.selected);
      const sources = new Map();
      if (review.indexSource) sources.set(review.indexSource.filePath,
        new Set([review.indexSource.sourceSha256]));
      for (const row of selected) {
        if (!sources.has(row.filePath)) sources.set(row.filePath, new Set());
        sources.get(row.filePath).add(row.sourceSha256);
      }
      for (const [path, fingerprints] of sources) {
        if (isTauri()) await invoke('allow_fs_scope', { path });
        const bytes = await readBinaryFile(path);
        if (!bytes?.length || !fingerprints.has(await fingerprintPdfBytes(bytes)) || fingerprints.size !== 1) {
          throw new Error(`The PDF ${extractFileName(path)} changed since review. Review the set again.`);
        }
      }
      if (sheetRegister() !== review.register || metadataReview() !== review) {
        throw new Error('The drawing set or review changed. Review the set again.');
      }
      commit(next);
      setMessage(`${selected.length} sheet${selected.length === 1 ? '' : 's'} updated from the reviewed metadata.`);
    } catch (error) { setMessage(error.message); }
    finally { setMetadataBusy(false); }
  }

  // Title block templates: read every registered sheet's page once, let the
  // matching template fill its number, title, revision and date, and list
  // the sheets no template matched. The PDFs are checked against their
  // fingerprints and never changed.
  async function applyTitleBlockTemplates() {
    const register = sheetRegister();
    const templates = combinedTemplates(register.titleBlockTemplates, userTitleBlockTemplates());
    if (templateBusy() || !register.sheets.length || !templates.length) return;
    setTemplateBusy(true);
    setTemplateResult(null);
    setMessage('');
    try {
      const { readTemplatePages } = await import('../../../../sets/title-block-template-app.js');
      const pages = await readTemplatePages(register.sheets);
      if (sheetRegister() !== register) throw new Error('The drawing set changed while its sheets were read. Apply the templates again.');
      const plan = planTitleBlockApply(register, pages, templates);
      const changed = plan.rows.filter(row => Object.keys(row.changes).length);
      // A template the set used is kept with the set.
      let next = applyTitleBlockPlan(register, plan);
      const used = templates.filter(template => plan.rows.some(row => row.templateId === template.id));
      for (const template of used) {
        if (!(next.titleBlockTemplates || []).some(item => item.id === template.id)) {
          next = setTitleBlockTemplates(next, [...(next.titleBlockTemplates || []), template]);
        }
      }
      if (next !== register) commit(next);
      setTemplateResult({ matched: plan.rows.length, changed: changed.length, unmatched: plan.unmatched, conflicts: plan.conflicts });
      setMessage(`${plan.rows.length} of ${register.sheets.length} sheets matched a title block template; ${changed.length} updated.`);
    } catch (error) { setMessage(`Could not apply title block templates: ${error.message}`); }
    finally { setTemplateBusy(false); }
  }

  function removeTitleBlockTemplate(entry) {
    const where = entry.inSet && entry.inDefaults ? 'this drawing set and your defaults' : entry.inSet ? 'this drawing set' : 'your defaults';
    if (!confirm(`Remove the title block template “${entry.template.name}” from ${where}?`)) return;
    try {
      if (entry.inSet) {
        commit(setTitleBlockTemplates(sheetRegister(), (sheetRegister().titleBlockTemplates || []).filter(item => item.id !== entry.template.id)));
      }
      if (entry.inDefaults) saveUserTitleBlockTemplates(userTitleBlockTemplates().filter(item => item.id !== entry.template.id));
    } catch (error) { setMessage(error.message); }
  }

  async function addPdfs() {
    if (importing()) return;
    setImporting(true);
    try {
      const picked = await openFileDialog(['pdf'], { multiple: true });
      if (!picked) return;
      let register = sheetRegister();
      let added = 0;
      let alreadyPresent = 0;
      let relinked = 0;
      let contentMatches = 0;
      const skipped = [];
      for (const path of (Array.isArray(picked) ? picked : [picked])) {
        try {
          if (isTauri()) await invoke('allow_fs_scope', { path });
          const bytes = await readBinaryFile(path);
          const [{ pageCount, pageLabels }, fingerprint] = await Promise.all([
            inspectPdfPages(bytes), fingerprintPdfBytes(bytes),
          ]);
          assertRecordedContentUnchanged(register, path, fingerprint);
          const matched = matchingCurrentPdfSource(register, fingerprint, pageCount);
          let fileRegister = register;
          let fileRelinked = 0;
          if (matched?.some(sheet => sheet.filePath !== path)
            && confirm(`This PDF has the same contents as ${matched.length} current sheet${matched.length === 1 ? '' : 's'} in the drawing set. Relink those sheets to ${extractFileName(path)}? Cancel keeps their recorded paths.`)) {
            fileRegister = relinkMatchingPdfSource(register, matched, path, fingerprint);
            fileRelinked = matched.filter(sheet => sheet.filePath !== path).length;
          }
          const result = addPdfPages(fileRegister, path, pageCount, pageLabels, fingerprint);
          register = result.register;
          relinked += fileRelinked;
          added += result.added.length;
          alreadyPresent += result.alreadyPresent;
          contentMatches += result.contentMatches;
        } catch (error) { skipped.push(`${extractFileName(path)}: ${error.message}`); }
      }
      if (register !== sheetRegister()) commit(register);
      setMessage(`${added} sheet${added === 1 ? '' : 's'} added.${relinked ? ` ${relinked} relinked to the selected PDF.` : ''}${alreadyPresent ? ` ${alreadyPresent} already in this set.` : ''}${contentMatches ? ` ${contentMatches} matched existing PDF contents; use Relink or Record revision to change their source.` : ''}${skipped.length ? ` ${skipped.join(' ')}` : ''}`);
    } catch (error) { setMessage(error.message); }
    finally { setImporting(false); }
  }

  async function slipSheet() {
    if (slipReading() || !sheetRegister().sheets.length) return;
    setSlipReading(true);
    try {
      const picked = await openFileDialog(['pdf'], { multiple: true });
      if (!picked) return;
      const { inspectRevisionPdf, readRevisionFile } = await import('../../../../sets/slip-sheet-run.js');
      const { planSlipSheet, slipSheetCollisionText } = await import('../../../../sets/slip-sheet-match.js');
      const files = [];
      const skipped = [];
      for (const path of (Array.isArray(picked) ? picked : [picked])) {
        try { files.push({ filePath: path, ...(await inspectRevisionPdf(await readRevisionFile(path))) }); }
        catch (error) { skipped.push(`${extractFileName(path)}: ${error.message}`); }
      }
      if (!files.length) { setMessage(skipped.join(' ')); return; }
      const { rows, collisions } = planSlipSheet(sheetRegister(), files);
      setMessage([...skipped, slipSheetCollisionText(collisions)].filter(Boolean).join(' '));
      openDialog('slipSheet', { files: files.map(({ filePath, pageCount }) => ({ filePath, pageCount })), rows,
        onDone: (text) => { setSelectedId(null); setSourceCandidate(null); setMessage(text); void refreshAvailability(); } });
    } catch (error) { setMessage(error.message); }
    finally { setSlipReading(false); }
  }

  function edit(id, changes) {
    try { commit(updateSheet(sheetRegister(), id, changes)); }
    catch (error) { setMessage(error.message); }
  }

  async function choosePdf() {
    const picked = await openFileDialog(['pdf']);
    return Array.isArray(picked) ? picked[0] : picked;
  }

  async function chooseSource(mode) {
    const sheet = selected();
    if (!sheet) return;
    setSourceCandidate(null);
    try {
      const path = await choosePdf();
      if (!path) return;
      if (isTauri()) await invoke('allow_fs_scope', { path });
      const bytes = await readBinaryFile(path);
      const [{ pageCount, pageLabels }, fingerprint] = await Promise.all([
        inspectPdfPages(bytes), fingerprintPdfBytes(bytes),
      ]);
      if (selectedId() !== sheet.id || sheetRegister().sheets.find(item => item.id === sheet.id) !== sheet) return;
      if (mode === 'relink' && sheet.sourceSha256 && fingerprint !== sheet.sourceSha256) {
        throw new Error('Selected PDF does not match the recorded sheet. Use Choose revised PDF to record changed contents as a new revision.');
      }
      const labeledPage = pageLabels?.findIndex(label => label?.trim().toLocaleLowerCase() === sheet.label.toLocaleLowerCase()) ?? -1;
      setSourceCandidate({ sheetId: sheet.id, sheetSnapshot: sheet, mode, path, pageCount, pageLabels, fingerprint,
        page: labeledPage >= 0 ? labeledPage + 1 : Math.min(sheet.page, pageCount) });
      setMessage('');
    } catch (error) { setMessage(error.message); }
  }

  async function chooseHistoricalSource(sheetId, historyIndex) {
    const sheet = sheetRegister().sheets.find(item => item.id === sheetId);
    const prior = sheet?.history[historyIndex];
    if (!prior) return;
    setSourceCandidate(null);
    if (!prior.sourceSha256) {
      setMessage('This earlier revision has no recorded PDF fingerprint. Reimport it at its recorded path before relinking.');
      return;
    }
    try {
      const path = await choosePdf();
      if (!path) return;
      if (isTauri()) await invoke('allow_fs_scope', { path });
      const bytes = await readBinaryFile(path);
      const [{ pageCount }, fingerprint] = await Promise.all([
        inspectPdfPages(bytes), fingerprintPdfBytes(bytes),
      ]);
      if (selectedId() !== sheetId || sheetRegister().sheets.find(item => item.id === sheetId)?.history[historyIndex] !== prior) return;
      relinkHistoricalSource(sheetRegister(), sheetId, historyIndex, path, fingerprint, pageCount);
      setSourceCandidate({ sheetId, mode: 'history', historyIndex, recordedPath: prior.filePath,
        path, page: prior.page, pageCount, fingerprint });
      setMessage('');
    } catch (error) { setMessage(error.message); }
  }

  async function applySource() {
    const sheet = selected();
    const candidate = sourceCandidate();
    if (!sheet || !candidate || candidate.sheetId !== sheet.id || applyingSource()) return;
    setApplyingSource(true);
    try {
      if (candidate.mode !== 'history' && sheet !== candidate.sheetSnapshot) {
        throw new Error('Sheet details changed. Choose the PDF again.');
      }
      if (candidate.mode === 'history' && sheet.history[candidate.historyIndex]?.filePath !== candidate.recordedPath) {
        throw new Error('Earlier revision changed. Choose its PDF again.');
      }
      const bytes = await readBinaryFile(candidate.path);
      const [{ pageCount }, fingerprint] = await Promise.all([
        inspectPdfPages(bytes), fingerprintPdfBytes(bytes),
      ]);
      if (sourceCandidate() !== candidate || selectedId() !== sheet.id) return;
      if (candidate.mode !== 'history' && sheetRegister().sheets.find(item => item.id === sheet.id) !== sheet) {
        throw new Error('Sheet details changed. Choose the PDF again.');
      }
      if (fingerprint !== candidate.fingerprint || candidate.page > pageCount) {
        throw new Error('Selected PDF changed since it was chosen. Choose it again.');
      }
      if (candidate.mode === 'history') {
        const currentPrior = sheetRegister().sheets.find(item => item.id === sheet.id)?.history[candidate.historyIndex];
        if (currentPrior?.filePath !== candidate.recordedPath || currentPrior.page !== candidate.page
          || currentPrior.sourceSha256 !== candidate.fingerprint) {
          throw new Error('Earlier revision changed. Choose its PDF again.');
        }
      }
      let next;
      if (candidate.mode === 'history') {
        next = relinkHistoricalSource(sheetRegister(), sheet.id, candidate.historyIndex,
          candidate.path, fingerprint, pageCount);
      } else if (candidate.mode === 'replace') {
        next = replaceSheet(sheetRegister(), sheet.id, candidate.path, nextRevision(),
          new Date().toISOString(), candidate.page, fingerprint);
      } else {
        next = relinkSheet(sheetRegister(), sheet.id, candidate.path, candidate.page, fingerprint);
      }
      commit(next);
      if (candidate.mode === 'history' && !isTauri()) {
        setHistoryAvailability(current => ({ ...current, [candidate.path]: 'Present' }));
      }
      setSourceCandidate(null);
      if (candidate.mode === 'replace') setNextRevision('');
      setMessage(candidate.mode === 'replace' ? 'Revision recorded.'
        : candidate.mode === 'history' ? 'Earlier revision relinked to the verified PDF.' : 'Sheet source relinked.');
    } catch (error) { setMessage(error.message); }
    finally { setApplyingSource(false); }
  }

  function removeSelected() {
    const sheet = selected();
    if (!sheet || !confirm(`Remove ${sheet.label} from this drawing set? The PDF will stay on disk.`)) return;
    commit(removeSheet(sheetRegister(), sheet.id));
    setSelectedId(null);
    setSourceCandidate(null);
  }

  async function openSource(sheet, source, historical = false) {
    if (openingSheet()) return;
    setOpeningSheet(true);
    const description = historical
      ? `earlier revision ${source.revision || 'Unnumbered'} of ${sheet.label}`
      : sheet.label;
    const setSourceAvailability = status => historical
      ? setHistoryAvailability(current => ({ ...current, [source.filePath]: status }))
      : setAvailability(current => ({ ...current, [sheet.id]: status }));
    try {
      setMessage(`Opening ${description} · ${extractFileName(source.filePath)} · Page ${source.page}…`);
      if (isTauri()) {
        const status = await inspectFile(source.filePath);
        setSourceAvailability(status);
        if (status !== 'Present') {
          setMessage(status === 'Missing'
            ? `Cannot open ${description}: PDF missing at ${source.filePath}. ${historical
              ? 'Use Relink on this earlier revision to locate an identical PDF.'
              : 'Use Relink to point to its new location.'}`
            : `Cannot check file access for ${description}: ${source.filePath}. ${historical
              ? 'Use Relink on this earlier revision if the PDF moved.'
              : 'Use Relink if the file moved.'}`);
          return;
        }
      } else {
        const bytes = await readBinaryFile(source.filePath);
        if (!bytes?.length) {
          setSourceAvailability('Missing');
          setMessage(`Cannot open ${description}: PDF unavailable in this browser session (${source.filePath}). ${historical
            ? 'Use Relink on this earlier revision to locate an identical PDF.'
            : 'Add the PDF again or use Relink.'}`);
          return;
        }
        setSourceAvailability('Present');
      }
      const { index } = createTab(source.filePath);
      await loadPDFIfNeeded(source.filePath, index);
      const document = state.documents[index];
      if (source.page > (document?.pdfDoc?.numPages || 0)) {
        throw new Error(`Page ${source.page} is not in ${extractFileName(source.filePath)}.`);
      }
      await goToPage(source.page);
      setMessage(historical
        ? `Viewing earlier revision ${source.revision || 'Unnumbered'} of ${sheet.label} · Page ${source.page}. Current source remains revision ${sheet.revision || 'Unnumbered'}.`
        : '');
    } catch (error) { setMessage(`Cannot open ${description}: ${error.message}`); }
    finally { setOpeningSheet(false); }
  }

  function openSheet(sheet) { return openSource(sheet, sheet); }

  async function readCompareSource(path) {
    if (isTauri()) await invoke('allow_fs_scope', { path });
    return readBinaryFile(path);
  }

  async function checkRevisionSummary() {
    if (summaryBusy()) return;
    const register = sheetRegister();
    setRevisionSummary(null);
    setSummaryBusy(true);
    setMessage('');
    try {
      const summary = await buildSetRevisionSummary(register, readCompareSource);
      if (sheetRegister() === register) setRevisionSummary(summary);
    } catch (error) { setMessage(`Could not check revision summary: ${error.message}`); }
    finally { setSummaryBusy(false); }
  }

  async function checkPageGeometry() {
    if (geometryBusy()) return;
    const register = sheetRegister();
    setGeometryAudit(null);
    setGeometryBusy(true);
    setMessage('');
    try {
      const audit = await buildSetPageGeometryAudit(register, readCompareSource);
      if (sheetRegister() === register) setGeometryAudit(audit);
    } catch (error) { setMessage(`Could not check page geometry: ${error.message}`); }
    finally { setGeometryBusy(false); }
  }

  async function checkTransmittalReadiness() {
    if (transmittalBusy() || packageBusy() || !sheetRegister().sheets.length) return;
    const register = sheetRegister();
    setTransmittalReview(null);
    setPackageSelectedIds([]);
    setPackagePreview(null);
    setTransmittalBusy(true);
    setMessage('');
    try {
      const review = await buildSetTransmittalReadiness(register, readCompareSource);
      if (sheetRegister() === register) setTransmittalReview(review);
    } catch (error) { setMessage(`Could not check transmittal readiness: ${error.message}`); }
    finally { setTransmittalBusy(false); }
  }

  function selectPackageSheet(id, checked) {
    setPackageSelectedIds(current => checked ? [...new Set([...current, id])]
      : current.filter(item => item !== id));
    setPackagePreview(null);
  }

  function updatePackageIssueDetail(field, value) {
    setPackageIssueDetails(current => ({ ...current, [field]: value }));
    setPackagePreview(null);
  }

  async function previewSetPackage() {
    if (packageBusy()) return;
    const register = sheetRegister();
    const review = transmittalReview();
    const selectedIds = packageSelectedIds();
    const issueDetails = packageIssueDetails();
    setPackageBusy(true);
    setPackagePreview(null);
    setMessage('');
    try {
      const { createSetPackagePlan, buildSetPackage } = await import('../../../../sets/set-transmittal-package.js');
      const plan = createSetPackagePlan(register, review, selectedIds, issueDetails);
      const built = await buildSetPackage(plan, readCompareSource);
      if (sheetRegister() !== register || transmittalReview() !== review
          || packageSelectedIds() !== selectedIds || packageIssueDetails() !== issueDetails) return;
      setPackagePreview({ ...built, plan, review, selectedIds, issueDetails });
    } catch (error) { setMessage(`Could not preview issue package: ${error.message}`); }
    finally { setPackageBusy(false); }
  }

  function assertPackagePreviewCurrent(preview) {
    if (!preview || packagePreview() !== preview || sheetRegister() !== preview.plan.register
        || transmittalReview() !== preview.review || packageSelectedIds() !== preview.selectedIds
        || packageIssueDetails() !== preview.issueDetails) {
      throw new Error('The package selection or drawing set changed. Preview it again.');
    }
  }

  async function exportSetPackage() {
    const preview = packagePreview();
    if (!preview || packageBusy()) return;
    setPackageBusy(true);
    setMessage('');
    try {
      assertPackagePreviewCurrent(preview);
      const path = await saveFileDialog(`${safeName(preview.plan.name)}-issue.zip`,
        [{ name: 'ZIP', extensions: ['zip'] }]);
      if (!path) return;
      if (!/\.zip$/i.test(path)) throw new Error('Choose a ZIP output path ending in .zip.');
      assertPackagePreviewCurrent(preview);
      await assertSafeExportDestination(path, preview.plan.register);
      assertPackagePreviewCurrent(preview);
      const { recheckSetPackageSources } = await import('../../../../sets/set-transmittal-package.js');
      await recheckSetPackageSources(preview.plan, readCompareSource);
      assertPackagePreviewCurrent(preview);
      await assertSafeExportDestination(path, preview.plan.register);
      assertPackagePreviewCurrent(preview);
      await writeBinaryFile(path, preview.bytes);
      setPackagePreview(null);
      setMessage(`${preview.manifest.sheets.length} selected sheet${preview.manifest.sheets.length === 1 ? '' : 's'} exported in an issue package.`);
    } catch (error) { setMessage(`Could not export issue package: ${error.message}`); }
    finally { setPackageBusy(false); }
  }

  const transmittalStatus = status => ({ ready: 'Source ready', missing: 'Missing or inaccessible PDF',
    unreadable: 'Unreadable PDF', unverified: 'No recorded SHA-256',
    changed: 'Changed PDF bytes', 'invalid-page': 'Recorded page missing' })[status] || 'Needs review';
  const transmittalAction = (issue, row) => ({
    missing: 'Restore access to the recorded PDF, or Relink to an identical copy.',
    unreadable: 'Restore a readable PDF at this path, then run the check again.',
    unverified: 'Use Add PDFs to record this page’s SHA-256 after resolving any changed-source rows for this PDF.',
    changed: 'Restore the recorded PDF bytes, or use Choose revised PDF to record a new revision.',
    'invalid-page': `Recorded page ${row.page} is outside this PDF (${row.pageCount} pages). Check the source and relink the correct page.`,
  })[issue];

  const geometryStatus = status => ({ verified: 'Verified', changed: 'Changed PDF bytes',
    missing: 'Missing PDF', unreadable: 'Unreadable PDF', unverified: 'No recorded SHA-256',
    'missing-page': 'Recorded page missing' })[status] || 'Unavailable';
  const boxText = box => `${box.x.toFixed(2)}, ${box.y.toFixed(2)} · ${box.width.toFixed(2)} × ${box.height.toFixed(2)}`;

  async function reviewFromSummary(row) {
    if (revisionSummary()?.register !== sheetRegister() || row.status !== 'ready') return;
    setQuery('');
    setRevisionFilter('');
    setSelectedId(row.sheetId);
    setSourceCandidate(null);
    await reviewRevisionCompare(row.sheetId, row.historyIndex);
    if (compareCandidate()?.sheetId === row.sheetId) {
      document.querySelector('[aria-label="Review sheet revision comparison"]')?.scrollIntoView({ block: 'nearest' });
    }
  }

  function sourceStateLabel(source) {
    return ({ exact: 'Exact SHA-256 match', changed: 'Changed PDF bytes', missing: 'Missing PDF',
      unreadable: 'Unreadable PDF', unrecorded: 'No recorded SHA-256',
      'invalid-page': 'Recorded page missing' })[source.state] || 'Unverified';
  }

  function summaryStatus(row) {
    if (row.status === 'no-prior') return 'No earlier revision';
    if (row.status === 'same-path') return 'Blocked · same PDF path';
    return row.status === 'ready' ? 'Ready to review' : 'Blocked · check sources';
  }

  async function reviewRevisionCompare(sheetId, historyIndex) {
    if (compareBusy()) return;
    const register = sheetRegister();
    setCompareCandidate(null);
    setCompareBusy(true);
    setMessage('');
    try {
      const verified = await verifySheetRevisionCompare(register, sheetId, historyIndex, readCompareSource);
      if (sheetRegister() !== register || selectedId() !== sheetId) return;
      setCompareCandidate({ register, sheetId, historyIndex,
        old: { filePath: verified.old.filePath, page: verified.old.page, revision: verified.old.revision },
        current: { filePath: verified.current.filePath, page: verified.current.page, revision: verified.current.revision } });
    } catch (error) { setMessage(`Could not compare revisions: ${error.message}`); }
    finally { setCompareBusy(false); }
  }

  async function openReviewedComparison() {
    const candidate = compareCandidate();
    if (!candidate || compareBusy() || sheetRegister() !== candidate.register || selectedId() !== candidate.sheetId) return;
    setCompareBusy(true);
    setMessage('');
    try {
      // Read again at confirmation; the preview never authorizes stale bytes.
      const verified = await verifySheetRevisionCompare(candidate.register, candidate.sheetId,
        candidate.historyIndex, readCompareSource, { checkPages: false });
      if (sheetRegister() !== candidate.register || selectedId() !== candidate.sheetId
        || compareCandidate() !== candidate) return;
      const sources = [verified.old, verified.current];
      for (const source of sources) {
        const open = state.documents.find(doc => doc?.filePath === source.filePath);
        if (open?.modified) throw new Error(`${extractFileName(source.filePath)} has unsaved edits. Save or close that tab before comparing saved revisions.`);
        if (open?._isLoading) throw new Error(`${extractFileName(source.filePath)} is still opening. Try again when its tab is ready.`);
        if (open?.pdfDoc) {
          const loaded = await getPdfBytes(source.filePath);
          if (!loaded || await fingerprintPdfBytes(loaded) !== source.sourceSha256) {
            throw new Error(`${extractFileName(source.filePath)} is open with different bytes. Close and reopen that tab before comparing.`);
          }
        }
      }
      if (sheetRegister() !== candidate.register || compareCandidate() !== candidate) return;
      for (const source of sources) {
        const { index } = createTab(source.filePath, false);
        await loadPDFIfNeeded(source.filePath, index, isTauri() ? null : source.bytes);
        const open = state.documents[index];
        const loaded = await getPdfBytes(source.filePath);
        if (!open?.pdfDoc || !loaded || await fingerprintPdfBytes(loaded) !== source.sourceSha256) {
          throw new Error(`${extractFileName(source.filePath)} could not be opened from its verified saved bytes.`);
        }
      }
      if (sources.some(source => state.documents.find(doc => doc?.filePath === source.filePath)?.modified)) {
        throw new Error('A compared PDF gained unsaved edits. Save or close that tab before comparing saved revisions.');
      }
      if (sheetRegister() !== candidate.register || compareCandidate() !== candidate
        || selectedId() !== candidate.sheetId) return;
      startCompare({ oldFilePath: verified.old.filePath, newFilePath: verified.current.filePath,
        oldPage: verified.old.page, newPage: verified.current.page, mode: 'side' });
      setCompareCandidate(null);
    } catch (error) { setMessage(`Could not compare revisions: ${error.message}`); }
    finally { setCompareBusy(false); }
  }

  function navigateSheet(direction) {
    if (openingSheet()) return;
    const target = adjacentSheet(visibleSheets(), selectedId(), direction);
    if (!target) return;
    setSelectedId(target.id);
    setNextRevision('');
    setSourceCandidate(null);
    setCompareCandidate(null);
    void openSheet(target);
  }

  function assertCurrentExportSource(register, fileStatus = null) {
    if (sheetRegister() !== register || (fileStatus && availability() !== fileStatus)) {
      throw new Error('The drawing set or file status changed during export. Review it and try again.');
    }
  }

  async function assertSafeExportDestination(path, register) {
    const { assertSafeSetDestination } = await import('../../../../sets/publish-destination.js');
    await assertSafeSetDestination(path, register, isTauri() ? {
      fileExists: async destination => {
        await invoke('allow_fs_scope', { path: destination });
        // The plugin stat can report false when scope access is denied;
        // the native check must also confirm that the path is new.
        return await fileExists(destination) || await invoke('file_exists', { path: destination });
      },
    } : {});
  }

  async function exportFile(extension, contentFor, includeFileStatus = false) {
    try {
      const register = sheetRegister();
      const fileStatus = includeFileStatus ? availability() : null;
      const content = contentFor(register, fileStatus);
      const path = await saveFileDialog(`${safeName(register.name)}.${extension}`,
        [{ name: extension.toUpperCase(), extensions: [extension] }]);
      if (!path) return;
      assertCurrentExportSource(register, fileStatus);
      await assertSafeExportDestination(path, register);
      assertCurrentExportSource(register, fileStatus);
      await writeBinaryFile(path, new TextEncoder().encode(content));
    } catch (error) { setMessage(error.message); }
  }

  async function exportDrawingLogPdf() {
    if (exportingPdf()) return;
    setExportingPdf(true);
    setMessage('');
    try {
      const register = sheetRegister();
      const fileStatus = availability();
      const path = await saveFileDialog(`${safeName(register.name)}-drawing-log.pdf`,
        [{ name: 'PDF', extensions: ['pdf'] }]);
      if (!path) return;
      assertCurrentExportSource(register, fileStatus);
      const [module, response] = await Promise.all([
        import('../../../../sets/drawing-log-pdf.js'),
        fetch('/pdfjs/web/standard_fonts/LiberationSans-Regular.ttf'),
      ]);
      if (!response.ok) throw new Error('Could not load the bundled drawing log font.');
      const bytes = await module.buildDrawingLogPdf(register, fileStatus, new Uint8Array(await response.arrayBuffer()));
      assertCurrentExportSource(register, fileStatus);
      await assertSafeExportDestination(path, register);
      assertCurrentExportSource(register, fileStatus);
      await writeBinaryFile(path, bytes);
      setMessage('Drawing log PDF exported.');
    } catch (error) { setMessage(`Could not export drawing log PDF: ${error.message}`); }
    finally { setExportingPdf(false); }
  }

  async function exportCurrentViewLog(extension) {
    if (exportingCurrentView()) return;
    setExportingCurrentView(true);
    setMessage('');
    try {
      const register = sheetRegister();
      const fileStatus = availability();
      const view = createCurrentDrawingLog(register, query(), revisionFilter());
      const assertFresh = () => {
        assertCurrentDrawingLog(view, sheetRegister(), query(), revisionFilter());
        assertCurrentExportSource(register, fileStatus);
      };
      const path = await saveFileDialog(`${safeName(register.name)}-current-view-drawing-log.${extension}`,
        [{ name: extension.toUpperCase(), extensions: [extension] }]);
      if (!path) return;
      if (!path.toLowerCase().endsWith(`.${extension}`)) throw new Error(`Choose a .${extension} output path.`);
      assertFresh();
      let bytes;
      if (extension === 'csv') {
        bytes = new TextEncoder().encode(currentDrawingLogCsv(view, fileStatus));
      } else {
        const [module, response] = await Promise.all([
          import('../../../../sets/drawing-log-pdf.js'),
          fetch('/pdfjs/web/standard_fonts/LiberationSans-Regular.ttf'),
        ]);
        if (!response.ok) throw new Error('Could not load the bundled drawing log font.');
        bytes = await module.buildDrawingLogPdf(view.register, fileStatus, new Uint8Array(await response.arrayBuffer()),
          new Date(), { currentView: view });
      }
      assertFresh();
      await assertSafeExportDestination(path, register);
      assertFresh();
      await writeBinaryFile(path, bytes);
      setMessage(`Current-view drawing log exported for ${view.register.sheets.length} sheet${view.register.sheets.length === 1 ? '' : 's'}.`);
    } catch (error) { setMessage(`Could not export current-view drawing log: ${error.message}`); }
    finally { setExportingCurrentView(false); }
  }

  async function publishCurrentSet() {
    if (publishingSet()) return;
    setPublishingSet(true);
    setMessage('');
    try {
      const register = sheetRegister();
      const { buildCurrentSetPdf } = await import('../../../../sets/publish-current-pdf.js');
      const bytes = await buildCurrentSetPdf(register, async path => {
        if (isTauri()) await invoke('allow_fs_scope', { path });
        return readBinaryFile(path);
      });
      // A revision recorded while source PDFs were being read must not cause
      // the old manifest to be published under the new set name.
      if (sheetRegister() !== register) throw new Error('The drawing set changed during publishing. Try again.');
      const path = await saveFileDialog(`${safeName(register.name)}-current-revisions.pdf`,
        [{ name: 'PDF', extensions: ['pdf'] }]);
      if (!path) return;
      if (sheetRegister() !== register) throw new Error('The drawing set changed during publishing. Try again.');
      await assertSafeExportDestination(path, register);
      if (sheetRegister() !== register) throw new Error('The drawing set changed during publishing. Try again.');
      await writeBinaryFile(path, bytes);
      setMessage(`${register.sheets.length} current sheet${register.sheets.length === 1 ? '' : 's'} published in one PDF.`);
    } catch (error) { setMessage(`Could not publish current sheets: ${error.message}`); }
    finally { setPublishingSet(false); }
  }

  async function importManifest() {
    try {
      const path = await openFileDialog(['json']);
      if (!path) return;
      const bytes = await readBinaryFile(Array.isArray(path) ? path[0] : path);
      const register = parseSheetRegister(new TextDecoder().decode(bytes));
      if (sheetRegister().sheets.length && !confirm('Replace the current drawing set with this manifest?')) return;
      commit(register);
      setSelectedId(null);
      setSourceCandidate(null);
      setQuery('');
      setRevisionFilter('');
      setHistoryAvailability({});
    } catch (error) { setMessage(`Could not import drawing set: ${error.message}`); }
  }

  return (
    <div class={`left-panel-content${activeTab() === 'sheets' ? ' active' : ''}`} id="sheets-panel">
      <div class="left-panel-header"><span>Drawing set</span></div>
      <div class="sheets-panel-scroll">
        <label class="sheets-field">Set name
          <input aria-label="Set name" value={sheetRegister().name}
            onChange={(event) => { try { commit({ ...sheetRegister(), name: event.currentTarget.value.trim() }); } catch (error) { setMessage(error.message); } }} />
        </label>
        <div class="sheets-actions">
          <button onClick={addPdfs} disabled={importing()}>{importing() ? 'Reading PDFs…' : 'Add PDFs'}</button>
          <button onClick={refreshAvailability} disabled={!isTauri()}>Check files</button>
        </div>
        <button class="sheets-wide-action" onClick={slipSheet} disabled={slipReading() || !sheetRegister().sheets.length}
          title={t('slipSheet.buttonHint')}>{slipReading() ? t('slipSheet.reading') : t('slipSheet.button')}</button>
        <Show when={message()}><div class="sheets-message" role="status">{message()}</div></Show>
        <div class="sheets-search">
          <input type="search" aria-label="Search sheets" placeholder="Search ID, title, revision, PDF name"
            title="All words must match across sheet IDs, titles, revisions, or PDF names" value={query()}
            onInput={(event) => { setQuery(event.currentTarget.value); setSourceCandidate(null); }} />
          <select aria-label="Filter current revision" value={revisionFilter()}
            onChange={(event) => { setRevisionFilter(event.currentTarget.value); setSourceCandidate(null); }}>
            <option value="">All current revisions</option>
            <For each={currentRevisions()}>{(revision) => <option value={revision}>Revision {revision}</option>}</For>
          </select>
          <div class="sheets-count">Showing {visibleSheets().length} of {sheetRegister().sheets.length} sheets</div>
        </div>
        <div class="sheets-navigation" role="group" aria-label="Drawing set navigation" aria-busy={openingSheet()}>
          <button type="button" onClick={() => navigateSheet('previous')}
            disabled={openingSheet() || selectedIndex() <= 0}>Previous sheet</button>
          <span>{selectedIndex() < 0 ? 'Select a sheet' : `${selectedIndex() + 1} of ${visibleSheets().length}`}</span>
          <button type="button" onClick={() => navigateSheet('next')}
            disabled={openingSheet() || selectedIndex() >= visibleSheets().length - 1}>Next sheet</button>
        </div>
        <div class="sheets-metadata-review">
          <button class="sheets-wide-action" type="button" onClick={reviewSetMetadata}
            disabled={metadataBusy() || !sheetRegister().sheets.length}>
            {metadataBusy() ? 'Checking sheet metadata…' : 'Review sheet numbers and titles'}
          </button>
          <button class="sheets-wide-action" type="button" onClick={reviewIndexSheetTitles}
            disabled={metadataBusy() || !selected()}>
            {metadataBusy() ? 'Reading index sheet…' : 'Review titles from selected index sheet'}
          </button>
          <button class="sheets-wide-action" type="button" disabled={!selected()}
            onClick={() => {
              const sheet = selected();
              if (sheet) openDialog('set-batch-link', { indexSource: { id: sheet.id, label: sheet.label,
                filePath: sheet.filePath, page: sheet.page, sourceSha256: sheet.sourceSha256 } });
            }}>Review index navigation links</button>
          <Show when={metadataReview()?.register === sheetRegister()}>
            <div class="sheets-history-title">{metadataReview().mode === 'index' ? 'Review index sheet titles' : 'Review proposed sheet details'}</div>
            <p class="sheets-suggestion-note">{metadataReview().mode === 'index'
              ? `Selectable rows on ${metadataReview().indexSource.label}, page ${metadataReview().indexSource.page}, matched by exact sheet ID. Only titles can change. Check every source line, then apply selected rows; PDFs stay unchanged.`
              : 'Selectable title-block text only. Check each proposed value and source line. The register changes only when you apply selected rows; PDFs stay unchanged.'}</p>
            <div class="sheets-metadata-count">{metadataReview().rows.filter(row => row.selected).length} selected · {metadataReview().rows.filter(row => row.error).length} unavailable</div>
            <Show when={metadataReview().mode === 'index' && metadataReview().unmatched.length}>
              <details class="sheets-suggestion-source"><summary>{metadataReview().unmatched.length} unmatched index row{metadataReview().unmatched.length === 1 ? '' : 's'}</summary>
                <For each={metadataReview().unmatched}>{(row) => <div>{row.text} · {row.reason}</div>}</For>
              </details>
            </Show>
            <div class="sheets-metadata-list" role="group" aria-label="Sheet metadata proposals">
              <For each={metadataReview().rows}>{(row) => <div class={`sheets-metadata-row${row.error || metadataIssues().has(row.sheetId) ? ' invalid' : ''}`}>
                <label class="sheets-metadata-select"><input type="checkbox" aria-label={`Apply metadata for ${row.originalLabel}`}
                  checked={row.selected} disabled={!!row.error || metadataBusy()}
                  onChange={event => editMetadataRow(row.sheetId, { selected: event.currentTarget.checked })} />
                  <strong>{row.originalLabel}</strong> · {extractFileName(row.filePath)} · Page {row.page}</label>
                <Show when={row.error} fallback={<>
                  <label class="sheets-field">Proposed sheet ID<input aria-label={`Proposed sheet ID for ${row.originalLabel}`}
                    value={row.label} disabled={metadataBusy() || metadataReview().mode === 'index'} aria-invalid={metadataIssues().has(row.sheetId)}
                    onInput={event => editMetadataRow(row.sheetId, { label: event.currentTarget.value })} /></label>
                  <small class="sheets-suggestion-evidence">{row.evidence.label || 'No labeled sheet number found; current ID retained.'}</small>
                  <label class="sheets-field">Proposed title<input aria-label={`Proposed title for ${row.originalLabel}`}
                    value={row.title} disabled={metadataBusy()}
                    onInput={event => editMetadataRow(row.sheetId, { title: event.currentTarget.value })} /></label>
                  <small class="sheets-suggestion-evidence">{row.evidence.title || (row.selectableText
                    ? 'No labeled title found; current title retained.' : 'No selectable title-block text found; enter manually if needed.')}</small>
                  <Show when={metadataIssues().get(row.sheetId)}><div class="sheets-metadata-error">{metadataIssues().get(row.sheetId)}</div></Show>
                </>}><>
                  <div class="sheets-metadata-error">{row.error}</div>
                  <Show when={metadataReview().mode === 'index' && row.evidence?.title}>
                    <small class="sheets-suggestion-evidence">{row.evidence.title}</small>
                  </Show>
                </></Show>
              </div>}</For>
            </div>
            <div class="sheets-actions"><button type="button" onClick={applyMetadataReview}
              disabled={metadataBusy() || !metadataReview().rows.some(row => row.selected) || metadataIssues().size > 0}>Apply selected details</button>
              <button type="button" onClick={() => setMetadataReview(null)} disabled={metadataBusy()}>Dismiss review</button></div>
          </Show>
        </div>
        <div class="sheets-revision-summary">
          <button class="sheets-wide-action" type="button" onClick={checkRevisionSummary}
            disabled={summaryBusy() || !sheetRegister().sheets.length}>
            {summaryBusy() ? 'Checking saved revisions…' : 'Check set revision summary'}
          </button>
          <Show when={revisionSummary()?.register === sheetRegister()}>
            <div class="sheets-history-title">Latest prior revision by sheet</div>
            <p class="sheets-suggestion-note">Read-only check of the saved PDFs and recorded SHA-256 fingerprints. Compare rechecks both files before opening.</p>
            <For each={revisionSummary().sheets}>{(row) => <div class="sheets-summary-row">
              <div class="sheets-summary-heading"><strong>{row.label}</strong><span>{summaryStatus(row)}</span></div>
              <div>Current {row.current.revision || 'Unnumbered'} · {extractFileName(row.current.filePath)} · Page {row.current.page} · {sourceStateLabel(row.current)}</div>
              <Show when={row.prior}>
                <div>Prior {row.prior.revision || 'Unnumbered'} · {extractFileName(row.prior.filePath)} · Page {row.prior.page} · {sourceStateLabel(row.prior)}</div>
              </Show>
              <details class="sheets-summary-hashes"><summary>Source paths and SHA-256</summary>
                <div>Current: {row.current.filePath}</div>
                <div>Recorded: <code>{row.current.sourceSha256 || 'None'}</code></div>
                <div>Observed: <code>{row.current.observedSha256 || 'Unavailable'}</code></div>
                <Show when={row.prior}>
                  <div>Prior: {row.prior.filePath}</div>
                  <div>Recorded: <code>{row.prior.sourceSha256 || 'None'}</code></div>
                  <div>Observed: <code>{row.prior.observedSha256 || 'Unavailable'}</code></div>
                </Show>
              </details>
              <Show when={row.status === 'ready'}>
                <button type="button" aria-label={`Review ${row.label} latest revision comparison`}
                  disabled={compareBusy()} onClick={() => reviewFromSummary(row)}>Review comparison</button>
              </Show>
            </div>}</For>
          </Show>
        </div>
        <div class="sheets-revision-summary">
          <button class="sheets-wide-action" type="button" onClick={checkPageGeometry}
            disabled={geometryBusy() || !sheetRegister().sheets.length}>
            {geometryBusy() ? 'Checking page geometry…' : 'Check page geometry'}
          </button>
          <Show when={geometryAudit()?.register === sheetRegister()}>
            <div class="sheets-history-title">Current registered pages</div>
            <p class="sheets-suggestion-note">Read-only measurements from saved PDFs. Dimensions appear only when the full PDF matches its recorded SHA-256. Page-box differences describe PDF geometry; they are not automatic errors.</p>
            <For each={geometryAudit().rows}>{(row) => <div class="sheets-summary-row">
              <div class="sheets-summary-heading"><strong>{row.label}</strong><span>{geometryStatus(row.status)}</span></div>
              <div>{extractFileName(row.filePath)} · Page {row.page}</div>
              <Show when={row.geometry}>
                <div>Displayed {row.geometry.widthInches.toFixed(2)} × {row.geometry.heightInches.toFixed(2)} in · Rotation {row.geometry.rotation}°</div>
                <div>{row.geometry.differingBoxes.length
                  ? `Boxes differing from Media: ${row.geometry.differingBoxes.join(', ')}`
                  : 'Media, Crop, Bleed, Trim and Art boxes coincide'}</div>
                <details class="sheets-summary-hashes"><summary>Page boxes and source SHA-256</summary>
                  <For each={['Media', 'Crop', 'Bleed', 'Trim', 'Art']}>{(name) =>
                    <div>{name}: {boxText(row.geometry.boxes[name.toLowerCase()])}</div>}</For>
                  <div>Box coordinates: x, y · width × height in PDF user-space units</div>
                  <div>Recorded: <code>{row.recordedSha256}</code></div>
                  <div>Observed: <code>{row.observedSha256}</code></div>
                </details>
              </Show>
              <Show when={!row.geometry}><details class="sheets-summary-hashes"><summary>Source evidence</summary>
                <div>Path: {row.filePath}</div>
                <div>Recorded: <code>{row.recordedSha256 || 'None'}</code></div>
                <div>Observed: <code>{row.observedSha256 || 'Unavailable'}</code></div>
              </details></Show>
            </div>}</For>
          </Show>
        </div>
        <div class="sheets-revision-summary" aria-label="Transmittal readiness review">
          <button class="sheets-wide-action" type="button" onClick={checkTransmittalReadiness}
            disabled={transmittalBusy() || !sheetRegister().sheets.length}>
            {transmittalBusy() ? 'Checking current sheet sources…' : 'Check transmittal readiness'}
          </button>
          <Show when={transmittalReview()?.register === sheetRegister()}>
            <div class="sheets-history-title">Current sheet source readiness · {transmittalReview().readyCount} of {transmittalReview().rows.length} ready</div>
            <p class="sheets-suggestion-note">This read-only snapshot checks recorded PDF bytes and page numbers. Recheck before sending a set; this review does not create or change a package.</p>
            <For each={transmittalReview().rows}>{(row) => <div class="sheets-summary-row">
              <div class="sheets-summary-heading"><strong>{row.label}</strong><span>{transmittalStatus(row.status)}</span></div>
              <div>{row.title || 'Untitled'} · Revision {row.revision || 'Unnumbered'} · {extractFileName(row.filePath)} · Page {row.page}{row.pageCount ? ` of ${row.pageCount}` : ''}</div>
              <Show when={row.status === 'ready'}><label class="sheets-package-select">
                <input type="checkbox" aria-label={`Include ${row.label} in issue package`}
                  checked={packageSelectedIds().includes(row.sheetId)} disabled={packageBusy()}
                  onChange={event => selectPackageSheet(row.sheetId, event.currentTarget.checked)} /> Include in issue package
              </label></Show>
              <For each={row.issues}>{(issue) => <div class="sheets-metadata-error">{transmittalAction(issue, row)}</div>}</For>
              <details class="sheets-summary-hashes"><summary>Source path and SHA-256</summary>
                <div>Path: {row.filePath}</div>
                <div>Recorded: <code>{row.recordedSha256 || 'None'}</code></div>
                <div>Observed: <code>{row.observedSha256 || 'Unavailable'}</code></div>
              </details>
            </div>}</For>
            <div class="sheets-actions">
              <button type="button" disabled={packageBusy() || !visibleReadyPackageIds().length || visibleReadyPackageIds().length > 200}
                onClick={() => { setPackageSelectedIds(visibleReadyPackageIds()); setPackagePreview(null); }}>Select visible ready</button>
              <button type="button" disabled={packageBusy() || !transmittalReview().readyCount || transmittalReview().readyCount > 200}
                onClick={() => { setPackageSelectedIds(transmittalReview().rows.filter(row => row.status === 'ready').map(row => row.sheetId)); setPackagePreview(null); }}>Select all ready</button>
              <button type="button" disabled={packageBusy() || !packageSelectedIds().length}
                onClick={() => { setPackageSelectedIds([]); setPackagePreview(null); }}>Clear selection</button>
            </div>
            <p class="sheets-suggestion-note">{visibleReadyPackageIds().length} ready in the current search and revision view · {packageSelectedIds().length} selected · maximum 200 sheets. Source PDFs can contain other pages; the package includes only selected pages.</p>
            <div class="sheets-package-details" role="group" aria-label="Issue package details">
              <label>Issue date <input type="date" value={packageIssueDetails().date} disabled={packageBusy()}
                onInput={event => updatePackageIssueDetail('date', event.currentTarget.value)} /></label>
              <label>Issue reference <input type="text" maxlength="80" value={packageIssueDetails().reference}
                placeholder="Optional" disabled={packageBusy()}
                onInput={event => updatePackageIssueDetail('reference', event.currentTarget.value)} /></label>
              <label>Transmittal note <textarea maxlength="500" value={packageIssueDetails().note}
                placeholder="Optional" disabled={packageBusy()}
                onInput={event => updatePackageIssueDetail('note', event.currentTarget.value)} /></label>
            </div>
            <p class="sheets-suggestion-note">Issue details identify this local package. Exporting it does not send it.</p>
            <button class="sheets-wide-action" type="button" onClick={previewSetPackage}
              disabled={packageBusy() || !packageSelectedIds().length}>
              {packageBusy() ? 'Preparing package…' : 'Preview issue package'}
            </button>
            <Show when={packagePreview()?.review === transmittalReview() ? packagePreview() : null}>
              {(preview) => <div class="sheets-candidate" data-set-package-preview>
                <div class="sheets-history-title">Issue package preview</div>
                <div>{preview().manifest.sheets.length} selected pages · {preview().manifest.sources.length} verified source PDFs · {(preview().bytes.length / 1048576).toFixed(1)} MiB ZIP</div>
                <div class="sheets-suggestion-note">Issue {preview().manifest.issue.reference || 'Unreferenced'} · {preview().manifest.issue.date || 'No date'}{preview().manifest.issue.note ? ` · ${preview().manifest.issue.note}` : ''}</div>
                <p class="sheets-suggestion-note">The ZIP contains current-sheets.pdf and manifest.json. Original multi-page source PDFs and absolute source paths are excluded. Export rechecks each source before writing.</p>
                <details class="sheets-summary-hashes"><summary>Review package manifest</summary>
                  <pre class="sheets-package-manifest">{JSON.stringify(preview().manifest, null, 2)}</pre>
                </details>
                <div class="sheets-actions"><button type="button" onClick={exportSetPackage} disabled={packageBusy()}>Export issue package ZIP</button>
                  <button type="button" onClick={() => setPackagePreview(null)} disabled={packageBusy()}>Dismiss preview</button></div>
              </div>}
            </Show>
          </Show>
        </div>
        <div class="sheets-list" role="group" aria-label="Registered sheets" onKeyDown={onSheetListKeyDown}>
          <For each={visibleSheets()} fallback={<p class="sheets-empty">{sheetRegister().sheets.length
            ? 'No sheets match this search or revision filter.'
            : 'Add PDFs to register every page in the drawing set. Edit sheet IDs and revisions below.'}</p>}>
            {(sheet) => <button type="button" class={`sheets-row${selectedId() === sheet.id ? ' selected' : ''}`}
              aria-pressed={selectedId() === sheet.id}
              onClick={() => { setSelectedId(sheet.id); setNextRevision(''); setSourceCandidate(null); setCompareCandidate(null); }}
              onDblClick={() => openSheet(sheet)} title={sheet.filePath}>
              <strong>{sheet.label}</strong><span>{sheet.revision || '—'}</span>
              <small>{sheet.title || `${extractFileName(sheet.filePath)} · Page ${sheet.page}`}{availability()[sheet.id] === 'Missing' ? ' · Missing file' : availability()[sheet.id] === 'Unavailable' ? ' · Access unavailable' : ''}</small>
            </button>}
          </For>
        </div>
        <Show when={selected()}>
          {(sheet) => <div class="sheets-detail">
            <div class="sheets-detail-title">Sheet details</div>
            <label class="sheets-field">Sheet ID<input aria-label="Sheet ID" value={sheet().label} onChange={(event) => edit(sheet().id, { label: event.currentTarget.value })} /></label>
            <label class="sheets-field">Title<input aria-label="Sheet title" value={sheet().title} onChange={(event) => edit(sheet().id, { title: event.currentTarget.value })} /></label>
            <button class="sheets-wide-action" onClick={suggestDetails} disabled={suggestingDetails()}
              title="Read selectable PDF text in the lower or right title-block area">
              {suggestingDetails() ? 'Reading title-block text…' : 'Suggest from selectable PDF text'}
            </button>
            <Show when={detailSuggestion()?.sheetId === sheet().id && detailSuggestion()?.register === sheetRegister() ? detailSuggestion() : null}>
              {(candidate) => <div class="sheets-candidate" aria-label="Review title-block suggestions">
                <div class="sheets-history-title">Review PDF text suggestions</div>
                <div class="sheets-source">Source: {extractFileName(sheet().filePath)} · Page {sheet().page}</div>
                <p class="sheets-suggestion-note">Only selectable text in the lower or right title-block area was read. A value needs a labeled field with no conflicting match. Check both fields before applying; image-only pages need manual entry.</p>
                <label class="sheets-field">Suggested sheet ID<input aria-label="Suggested sheet ID" value={candidate().label}
                  onInput={(event) => setDetailSuggestion(current => ({ ...current, label: event.currentTarget.value }))} /></label>
                <small class="sheets-suggestion-evidence">{candidate().evidence.label || 'No labeled sheet number found; current ID retained.'}</small>
                <label class="sheets-field">Suggested title<input aria-label="Suggested sheet title" value={candidate().title}
                  onInput={(event) => setDetailSuggestion(current => ({ ...current, title: event.currentTarget.value }))} /></label>
                <small class="sheets-suggestion-evidence">{candidate().evidence.title || 'No labeled title found; current title retained.'}</small>
                <Show when={candidate().snippets.length}>
                  <details class="sheets-suggestion-source"><summary>Source text snippets</summary>
                    <For each={candidate().snippets}>{(line) => <div>{line}</div>}</For>
                  </details>
                </Show>
                <div class="sheets-actions"><button onClick={applyDetailSuggestion}
                  disabled={!candidate().found || (candidate().label === sheet().label && candidate().title === sheet().title)}>Apply suggestions</button>
                  <button onClick={() => setDetailSuggestion(null)}>Dismiss</button></div>
              </div>}
            </Show>
            <label class="sheets-field">Revision<input aria-label="Revision" value={sheet().revision} onChange={(event) => edit(sheet().id, { revision: event.currentTarget.value })} /></label>
            <label class="sheets-field">Sheet date<input aria-label="Sheet date" value={sheet().date || ''} onChange={(event) => edit(sheet().id, { date: event.currentTarget.value })} /></label>
            <div class="sheets-history-title">Current source</div>
            <div class="sheets-source">{extractFileName(sheet().filePath)} · Page {sheet().page} · Revision {sheet().revision || 'Unnumbered'}</div>
            <div class="sheets-path" title={sheet().filePath}>{sheet().filePath}</div>
            <div class="sheets-actions"><button onClick={() => openSheet(sheet())}>Open sheet</button><button onClick={() => chooseSource('relink')}>Relink</button><button onClick={removeSelected}>Remove</button></div>
            <label class="sheets-field">Next revision<input aria-label="Next revision" value={nextRevision()} onInput={(event) => setNextRevision(event.currentTarget.value)} /></label>
            <button class="sheets-wide-action" onClick={() => chooseSource('replace')}>Choose revised PDF</button>
            <Show when={sourceCandidate()?.sheetId === sheet().id}>
              <div class="sheets-candidate">
                <div class="sheets-history-title">{sourceCandidate().mode === 'replace' ? 'New revision source'
                  : sourceCandidate().mode === 'history' ? 'Relink earlier revision' : 'Relink current source'}</div>
                <div class="sheets-path" title={sourceCandidate().path}>{sourceCandidate().path}</div>
                <Show when={sourceCandidate().mode === 'relink'}>
                  <div class="sheets-source">{sheet().sourceSha256
                    ? 'Exact PDF fingerprint match · the registered sheet source is preserved.'
                    : 'No fingerprint was recorded for this sheet. The selected PDF cannot be verified against the original; check it before confirming.'}</div>
                </Show>
                <Show when={sourceCandidate().mode === 'history'} fallback={
                  <label class="sheets-field">PDF page
                    <select aria-label="New source page" value={sourceCandidate().page}
                      onChange={(event) => setSourceCandidate(current => ({ ...current, page: Number(event.currentTarget.value) }))}>
                      <For each={Array.from({ length: sourceCandidate().pageCount }, (_, index) => index + 1)}>
                        {(page) => <option value={page}>Page {page}{sourceCandidate().pageLabels?.[page - 1] ? ` · ${sourceCandidate().pageLabels[page - 1]}` : ''}</option>}
                      </For>
                    </select>
                  </label>}>
                  <div class="sheets-source">Exact PDF match · Recorded page {sourceCandidate().page} of {sourceCandidate().pageCount}</div>
                </Show>
                <div class="sheets-actions"><button onClick={applySource} disabled={applyingSource()}>{sourceCandidate().mode === 'replace' ? 'Record revision'
                  : sourceCandidate().mode === 'history' ? 'Confirm earlier relink' : 'Confirm relink'}</button><button onClick={() => setSourceCandidate(null)}>Cancel</button></div>
              </div>
            </Show>
            <Show when={sheet().history.length}><div class="sheets-history-title">Earlier revisions</div>
              <For each={[...sheet().history].reverse()}>{(item, reverseIndex) => <div class="sheets-history-item" title={item.filePath}>
                <div><strong>Revision {item.revision || 'Unnumbered'}</strong> · {extractFileName(item.filePath)} · Page {item.page}
                  <small>Replaced {item.replacedAt}{historyAvailability()[item.filePath] === 'Missing' ? ' · Missing file' : historyAvailability()[item.filePath] === 'Unavailable' ? ' · Access unavailable' : ''}</small>
                </div>
                <button type="button" aria-label={`Open ${sheet().label} earlier revision ${item.revision || 'Unnumbered'}`}
                  onClick={() => openSource(sheet(), item, true)} disabled={openingSheet()}>Open</button>
                <button type="button" aria-label={`Relink ${sheet().label} earlier revision ${item.revision || 'Unnumbered'}`}
                  onClick={() => chooseHistoricalSource(sheet().id, sheet().history.length - reverseIndex() - 1)}>Relink</button>
                <button type="button" aria-label={`Compare ${sheet().label} earlier revision ${item.revision || 'Unnumbered'} to current`}
                  onClick={() => reviewRevisionCompare(sheet().id, sheet().history.length - reverseIndex() - 1)}
                  disabled={compareBusy()}>Compare</button>
              </div>}</For>
            </Show>
            <Show when={compareCandidate()?.sheetId === sheet().id && compareCandidate()?.register === sheetRegister()}>
              <div class="sheets-candidate" aria-label="Review sheet revision comparison">
                <div class="sheets-history-title">Compare {sheet().label} revisions</div>
                <div class="sheets-source">Earlier revision {compareCandidate().old.revision || 'Unnumbered'} · {extractFileName(compareCandidate().old.filePath)} · Page {compareCandidate().old.page}</div>
                <div class="sheets-source">Current revision {compareCandidate().current.revision || 'Unnumbered'} · {extractFileName(compareCandidate().current.filePath)} · Page {compareCandidate().current.page}</div>
                <p class="sheets-suggestion-note">Both saved PDFs matched their recorded fingerprints. Confirm to open this page pair in Compare. The drawing set will not change.</p>
                <div class="sheets-actions"><button onClick={openReviewedComparison} disabled={compareBusy()}>{compareBusy() ? 'Checking PDFs…' : 'Open comparison'}</button>
                  <button onClick={() => setCompareCandidate(null)} disabled={compareBusy()}>Cancel</button></div>
              </div>
            </Show>
          </div>}
        </Show>
        <div class="sheets-templates" aria-label="Title block templates">
          <div class="sheets-history-title">Title block templates</div>
          <p class="sheets-suggestion-note">Mark the title block fields once on a sheet, then fill the sheet number, title, revision and date of every sheet with the same layout. Selectable PDF text only.</p>
          <For each={titleBlockTemplates()}>{(entry) => <div class="sheets-history-item">
            <div><strong>{entry.template.name}</strong>
              <small>{Math.round(entry.template.size.width)} × {Math.round(entry.template.size.height)} pt · {entry.template.anchors.length} fixed words · {[entry.inSet && 'this set', entry.inDefaults && 'my defaults'].filter(Boolean).join(', ')}</small>
            </div>
            <button type="button" aria-label={`Remove title block template ${entry.template.name}`} onClick={() => removeTitleBlockTemplate(entry)}>Remove</button>
          </div>}</For>
          <div class="sheets-actions">
            <button type="button" onClick={() => openDialog('title-block-template', {})}>New template…</button>
            <button type="button" onClick={applyTitleBlockTemplates}
              disabled={templateBusy() || !sheetRegister().sheets.length || !titleBlockTemplates().length}>
              {templateBusy() ? 'Reading sheets…' : 'Apply to set'}</button>
          </div>
          <Show when={templateResult()}>{(result) => <div class="sheets-candidate" aria-label="Title block template result">
            <div class="sheets-metadata-count">{result().matched} matched · {result().changed} updated · {result().unmatched.length} not matched</div>
            <Show when={result().unmatched.length}>
              <details class="sheets-suggestion-source" open><summary>Sheets not matched (unchanged)</summary>
                <For each={result().unmatched}>{(row) => <div><strong>{row.label}</strong> · {row.reason}</div>}</For>
              </details>
            </Show>
            <Show when={result().conflicts.length}>
              <details class="sheets-suggestion-source" open><summary>Sheet numbers not taken</summary>
                <For each={result().conflicts}>{(row) => <div><strong>{row.label}</strong> · {row.reason}</div>}</For>
              </details>
            </Show>
            <div class="sheets-actions"><button type="button" onClick={() => setTemplateResult(null)}>Dismiss</button></div>
          </div>}</Show>
        </div>
        <div class="sheets-export">
          <button onClick={publishCurrentSet} disabled={publishingSet() || !sheetRegister().sheets.length}>{publishingSet() ? 'Preparing current sheets…' : 'Publish current sheets PDF'}</button>
          <p class="sheets-suggestion-note">Current view: {visibleSheets().length} of {sheetRegister().sheets.length} sheets. These exports include the displayed current revision only.</p>
          <button onClick={() => exportCurrentViewLog('csv')} disabled={exportingCurrentView() || !visibleSheets().length}>Export current view CSV</button>
          <button onClick={() => exportCurrentViewLog('pdf')} disabled={exportingCurrentView() || !visibleSheets().length}>{exportingCurrentView() ? 'Preparing current-view log…' : 'Export current view PDF'}</button>
          <button onClick={() => exportFile('csv', drawingLogCsv, true)}>Export drawing log</button>
          <button onClick={exportDrawingLogPdf} disabled={exportingPdf()}>{exportingPdf() ? 'Preparing drawing log PDF…' : 'Export drawing log PDF'}</button>
          <button onClick={() => exportFile('json', register => JSON.stringify(register, null, 2))}>Export set manifest</button>
          <button onClick={importManifest}>Import set manifest</button>
        </div>
      </div>
    </div>
  );
}
