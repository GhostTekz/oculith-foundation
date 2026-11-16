import { createEffect, createMemo, createSignal, onCleanup, onMount, For, Show } from 'solid-js';
import {
  compareActive,
  compareOldPath,
  compareNewPath,
  compareMode,
  compareOldPage,
  compareNewPage,
  compareOldPageCount,
  compareNewPageCount,
  compareConfirmedPairs,
  compareSessionId,
  compareCurrentConfirmedPair,
  compareOffset,
  compareZoom,
  compareChanges,
  compareFocusedChange,
  compareShowAdded,
  compareShowRemoved,
  compareShowModified,
  compareShowBox,
  compareShowContour,
  compareFocused,
  compareFitRequest,
  compareDetecting,
  setCompareShowAdded,
  setCompareShowRemoved,
  setCompareShowModified,
  setCompareShowBox,
  setCompareShowContour,
  setFocusedChange,
  exitCompare,
  nextPagePair,
  prevPagePair,
  canNextPagePair,
  canPrevPagePair,
  setCompareZoom,
  setCompareMode,
  setCompareOffset,
  requestCompareFit,
  requestCompareReset,
  comparePanelTab,
  setComparePanelTab,
  compareTextChanges,
  compareTextComparing,
  setCompareTextChanges,
  setCompareTextComparing,
  setPagePair,
  confirmCurrentPagePair,
  removeCurrentConfirmedPair,
  goToConfirmedPair,
  goToAdjacentConfirmedPair,
  confirmSuggestedPagePair,
  applyComparePlan,
} from '../../../compare/compare-store.js';
import {
  renderCompareSideBySide,
  renderCompareOverlay,
  paintHighlights,
  clearCompareDocCache,
  getCompareDocSourceBytes,
  detectComparePair,
  getCompareDoc,
  COMPARE_BASE_SCALE,
  scaledCompareOffset,
} from '../../../compare/compare-viewport.js';
import { runTextCompare, clearTextCompareCache } from '../../../compare/text-compare.js';
import { diffWords } from '../../../compare/text-diff.js';
import { useTranslation } from '../../../i18n/useTranslation.js';
import { state } from '../../../core/state.js';
import { diffAnnotationsForPair } from '../../../compare/compare-annotations.js';
import { buildCompareChangeReport, buildBatchCompareChangeReport, createCompareChangeReportModel, suggestedCompareReportName, suggestedComparePdfReportName, suggestedBatchCompareReportName, suggestedBatchComparePdfReportName } from '../../../compare/change-report.js';
import { runConfirmedPairBatch, summarizeBatchPairs, MAX_BATCH_PAIRS } from '../../../compare/batch-compare.js';
import { suggestPagePairsFromDocs } from '../../../compare/page-label-matches.js';
import { canConfirmSuggestedPair } from '../../../compare/page-pairs.js';
import { buildComparePlan, parseComparePlanBytes, serializeComparePlan, suggestedComparePlanName, validateComparePlan } from '../../../compare/compare-plan.js';
import { comparePdfContentIdentity, compareSnapshotIdentityMatches, compareSnapshotMatches, readCompareSnapshots, removeCompareSnapshot, saveCompareSnapshot } from '../../../compare/compare-snapshots.js';
import { getCachedPdfBytes } from '../../../pdf/loader.js';
import { openFileDialog, readBinaryFile, saveFileDialog, writeBinaryFile } from '../../../core/platform.js';

// Verticale scheidingslijn tussen toolbar-groepen — Windows/Visual-Studio-stijl.
function Sep() {
  return <span class="compare-toolbar-separator" aria-hidden="true"></span>;
}

export default function CompareView() {
  const { t } = useTranslation('ribbon');
  let oldCanvasRef;
  let newCanvasRef;
  let oldHiCanvasRef;   // side-by-side: diff overlay on OLD page
  let newHiCanvasRef;   // side-by-side: diff overlay on NEW page
  let overlayNewCanvasRef;
  let overlayOldCanvasRef;
  let overlayHighlightCanvasRef;
  let bodyRef;
  let overlayWrapRef;
  // Side-by-side: elk document in een EIGEN scroll-paneel, met gespiegelde
  // scrollpositie — zo toont links en rechts altijd dezelfde plek, ook diep
  // ingezoomd (één gedeelde scroller schoof het andere document uit beeld).
  let oldPaneRef;
  let newPaneRef;
  let oldWrapRef;  // scaled wrapper holding OLD page + its diff overlay
  let newWrapRef;  // scaled wrapper holding NEW page + its diff overlay
  let _scrollSyncing = false;
  let focusAfterRender = null;
  // Spiegel de scrollpositie proportioneel: de twee pagina's kunnen
  // verschillende afmetingen hebben, dus een absolute pixel-kopie zou
  // uiteenlopen. We rekenen met de fractie van de scrollbare ruimte zodat
  // "midden van links" ook "midden van rechts" toont.
  const syncScroll = (src, dst) => {
    if (_scrollSyncing || !src || !dst) return;
    _scrollSyncing = true;
    const sx = src.scrollWidth - src.clientWidth;
    const sy = src.scrollHeight - src.clientHeight;
    const dx = dst.scrollWidth - dst.clientWidth;
    const dy = dst.scrollHeight - dst.clientHeight;
    const left = sx > 0 ? (src.scrollLeft / sx) * dx : src.scrollLeft;
    const top = sy > 0 ? (src.scrollTop / sy) * dy : src.scrollTop;
    // Scroll positions can round to whole pixels. Do not echo subpixel
    // corrections between panes: that feedback slowly walks the page away.
    if (Math.abs(dst.scrollLeft - left) >= 1) dst.scrollLeft = left;
    if (Math.abs(dst.scrollTop - top) >= 1) dst.scrollTop = top;
    requestAnimationFrame(() => { _scrollSyncing = false; });
  };
  // Pannen door slepen in een paneel; de scroll-sync spiegelt de beweging
  // automatisch naar het andere paneel. Pointer-capture zorgt dat snelle
  // sleepbewegingen buiten het element niet verloren gaan.
  const startPanDrag = (e, pane) => {
    // Left button or middle button drags to pan.
    if (!pane || (e.button !== 0 && e.button !== 1)) return;
    focusAfterRender = null;
    const rect = pane.getBoundingClientRect();
    // Klik op de scrollbalk zelf niet kapen.
    if (e.clientX - rect.left > pane.clientWidth || e.clientY - rect.top > pane.clientHeight) return;
    e.preventDefault();
    try { pane.setPointerCapture?.(e.pointerId); } catch {}
    let lastX = e.clientX;
    let lastY = e.clientY;
    const move = (ev) => {
      pane.scrollLeft -= ev.clientX - lastX;
      pane.scrollTop -= ev.clientY - lastY;
      lastX = ev.clientX;
      lastY = ev.clientY;
    };
    const up = () => {
      try { pane.releasePointerCapture?.(e.pointerId); } catch {}
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  };
  // Middle mouse button (button 1) over a scrollable pane otherwise triggers the
  // browser's autoscroll, which hijacks the gesture so the pointer-based pan in
  // startPanDrag never runs. preventDefault() on pointerdown does NOT stop it —
  // for a mouse the autoscroll is a default of the separate mousedown event. So
  // suppress it here, bound as a DIRECT native listener (on:mousedown) so the
  // preventDefault is honoured before the default action fires.
  const killMiddleAutoscroll = (e) => { if (e.button === 1) e.preventDefault(); };
  const [highlight, setHighlight] = createSignal(null); // {x,y,w,h} flash highlight
  const [oldLayerOpacity, setOldLayerOpacity] = createSignal(50);
  const visibleAlignment = () => scaledCompareOffset(compareOffset(),
    COMPARE_BASE_SCALE * compareZoom() / cssScale());
  let highlightTimer = null;
  const [reportExporting, setReportExporting] = createSignal(false);
  const [reportError, setReportError] = createSignal('');
  const [markupNotice, setMarkupNotice] = createSignal('');
  const [batchRunning, setBatchRunning] = createSignal(false);
  const [batchProgress, setBatchProgress] = createSignal(null);
  const [batchResult, setBatchResult] = createSignal(null);
  const [batchSummary, setBatchSummary] = createSignal(null);
  const [batchError, setBatchError] = createSignal('');
  const [planPreview, setPlanPreview] = createSignal(null);
  const [planPreviewIdentity, setPlanPreviewIdentity] = createSignal(null);
  const [planBusy, setPlanBusy] = createSignal(false);
  const [planError, setPlanError] = createSignal('');
  const [recentPlans, setRecentPlans] = createSignal(readCompareSnapshots());
  const [snapshotNotice, setSnapshotNotice] = createSignal('');
  let planOperationSeq = 0;
  let lastCompareSession = compareSessionId();
  const selectedPlanDocuments = () => ({
    oldPath: compareOldPath(), newPath: compareNewPath(),
    oldPageCount: compareOldPageCount(), newPageCount: compareNewPageCount(),
  });
  const selectedPdfIdentity = async selected => {
    await Promise.all([getCompareDoc(selected.oldPath), getCompareDoc(selected.newPath)]);
    const oldBytes = getCompareDocSourceBytes(selected.oldPath);
    const newBytes = getCompareDocSourceBytes(selected.newPath);
    const identity = await comparePdfContentIdentity(oldBytes, newBytes);
    getCompareDocSourceBytes(selected.oldPath);
    getCompareDocSourceBytes(selected.newPath);
    return identity;
  };
  createEffect(() => {
    const session = compareSessionId();
    if (session !== lastCompareSession) {
      lastCompareSession = session;
      clearCompareDocCache();
      clearTextCompareCache();
    }
    compareActive();
    compareOldPath();
    compareNewPath();
    compareOldPageCount();
    compareNewPageCount();
    planOperationSeq++;
    setPlanPreview(null);
    setPlanPreviewIdentity(null);
    setPlanBusy(false);
    setPlanError('');
    setSnapshotNotice('');
  });
  const saveComparePlan = async () => {
    if (!compareActive() || batchRunning() || planBusy()) return;
    const seq = ++planOperationSeq;
    const session = compareSessionId();
    const pairs = compareConfirmedPairs();
    const alignment = compareOffset();
    const selected = selectedPlanDocuments();
    setPlanError('');
    setPlanBusy(true);
    try {
      const identity = await selectedPdfIdentity(selected);
      const plan = buildComparePlan({ ...selected, offset: alignment, pairs, identity });
      const path = await saveFileDialog(suggestedComparePlanName(plan.documents.old.path, plan.documents.new.path),
        [{ name: 'OcuDraw compare plan', extensions: ['json'] }]);
      if (!path) return;
      if (seq !== planOperationSeq || session !== compareSessionId()
          || pairs !== compareConfirmedPairs() || alignment !== compareOffset()) {
        throw new Error('Comparison changed while saving. Save the plan again.');
      }
      if (!compareSnapshotIdentityMatches(identity, await selectedPdfIdentity(selected))) {
        throw new Error('Selected PDF contents changed while saving. Save the plan again.');
      }
      if (seq !== planOperationSeq || session !== compareSessionId() || !compareActive()
          || pairs !== compareConfirmedPairs() || alignment !== compareOffset()) {
        throw new Error('Comparison changed while saving. Save the plan again.');
      }
      await writeBinaryFile(path, new TextEncoder().encode(serializeComparePlan(plan)));
    } catch (error) {
      if (seq === planOperationSeq) setPlanError(error?.message || 'Could not save compare plan.');
    } finally {
      if (seq === planOperationSeq) setPlanBusy(false);
    }
  };
  const loadComparePlan = async () => {
    if (!compareActive() || batchRunning() || planBusy()) return;
    const seq = ++planOperationSeq;
    const session = compareSessionId();
    const selected = selectedPlanDocuments();
    setPlanPreview(null);
    setPlanPreviewIdentity(null);
    setPlanError('');
    setPlanBusy(true);
    try {
      const picked = await openFileDialog(['json']);
      const path = Array.isArray(picked) ? picked[0] : picked;
      if (!path) return;
      const bytes = await readBinaryFile(path);
      if (seq !== planOperationSeq || session !== compareSessionId() || !compareActive()) {
        throw new Error('Comparison changed while loading the plan.');
      }
      const plan = parseComparePlanBytes(bytes, selected);
      if (plan.identity) {
        const current = await selectedPdfIdentity(selected);
        if (!compareSnapshotIdentityMatches(plan.identity, current)) {
          throw new Error('Selected PDF contents differ from this compare plan. Confirm page matches again and save a new plan.');
        }
      }
      if (seq !== planOperationSeq || session !== compareSessionId()) {
        throw new Error('Comparison changed while checking the plan.');
      }
      setPlanPreview(plan);
      setPlanPreviewIdentity(plan.identity || null);
    } catch (error) {
      if (seq === planOperationSeq) setPlanError(error?.message || 'Could not load compare plan.');
    } finally {
      if (seq === planOperationSeq) setPlanBusy(false);
    }
  };
  const replaceFromPlan = async () => {
    if (!planPreview() || batchRunning() || planBusy()) return;
    const plan = planPreview();
    const identity = planPreviewIdentity();
    const seq = ++planOperationSeq;
    const session = compareSessionId();
    const pairs = compareConfirmedPairs();
    const alignment = compareOffset();
    setPlanBusy(true);
    try {
      if (identity) {
        const current = await selectedPdfIdentity(selectedPlanDocuments());
        if (seq !== planOperationSeq || session !== compareSessionId() || plan !== planPreview()
            || pairs !== compareConfirmedPairs() || alignment !== compareOffset()) {
          throw new Error('Comparison changed while checking the saved session. Review it again.');
        }
        if (!compareSnapshotIdentityMatches(identity, current)) {
          throw new Error('Selected PDF contents differ from this saved session. Confirm page matches again and save a new session.');
        }
      }
      applyComparePlan(plan);
      setPlanPreview(null);
      setPlanPreviewIdentity(null);
      setPlanError('');
    } catch (error) {
      if (seq === planOperationSeq) setPlanError(error?.message || 'Could not apply compare plan.');
    } finally { if (seq === planOperationSeq) setPlanBusy(false); }
  };
  const saveRecentPlan = async () => {
    if (!compareActive() || batchRunning() || planBusy()) return;
    const seq = ++planOperationSeq;
    const session = compareSessionId();
    const pairs = compareConfirmedPairs();
    const alignment = compareOffset();
    const selected = selectedPlanDocuments();
    setPlanError('');
    setSnapshotNotice('');
    setPlanBusy(true);
    try {
      const plan = buildComparePlan({ ...selected, offset: alignment, pairs });
      const identity = await selectedPdfIdentity(selected);
      if (seq !== planOperationSeq || session !== compareSessionId()
          || pairs !== compareConfirmedPairs() || alignment !== compareOffset()) {
        throw new Error('Comparison changed while saving. Save the session again.');
      }
      setRecentPlans(saveCompareSnapshot(plan, identity));
      setSnapshotNotice('Comparison saved on this device.');
    } catch (error) {
      if (seq === planOperationSeq) setPlanError(error?.message || 'Could not save comparison locally.');
    } finally { if (seq === planOperationSeq) setPlanBusy(false); }
  };
  const previewRecentPlan = async entry => {
    if (!compareActive() || batchRunning() || planBusy()) return;
    const seq = ++planOperationSeq;
    const session = compareSessionId();
    const selected = selectedPlanDocuments();
    setPlanError('');
    setSnapshotNotice('');
    setPlanPreview(null);
    setPlanPreviewIdentity(null);
    setPlanBusy(true);
    try {
      if (!entry.identity) throw new Error('This older session has no PDF fingerprint. Confirm its pairs again and save a new session.');
      const plan = validateComparePlan(entry.plan, selected);
      const current = await selectedPdfIdentity(selected);
      if (seq !== planOperationSeq || session !== compareSessionId()) {
        throw new Error('Comparison changed while checking the saved session. Review it again.');
      }
      if (!compareSnapshotIdentityMatches(entry.identity, current)) {
        throw new Error('Selected PDF contents differ from this saved session. Confirm page matches again and save a new session.');
      }
      setPlanPreview(plan);
      setPlanPreviewIdentity(entry.identity);
    } catch (error) {
      if (seq === planOperationSeq) setPlanError(error?.message || 'Could not review saved comparison.');
    } finally { if (seq === planOperationSeq) setPlanBusy(false); }
  };
  const removeRecentPlan = entry => {
    setPlanError('');
    setSnapshotNotice('');
    try {
      setRecentPlans(removeCompareSnapshot(entry.id));
      setSnapshotNotice('Saved comparison removed from this device.');
    } catch (error) {
      setPlanError(error?.message || 'Could not remove saved comparison.');
    }
  };
  const batchRows = createMemo(() => summarizeBatchPairs(batchSummary(), batchRunning() ? batchProgress()?.pair : null));
  const batchRowStyle = status => ({
    completed: 'background:rgba(22,163,74,0.10);',
    failed: 'background:rgba(220,38,38,0.13);',
    running: 'background:color-mix(in srgb, var(--theme-accent) 16%, transparent);',
    unprocessed: 'background:var(--theme-hover); color:var(--theme-text-secondary);',
  })[status] || '';
  const [labelReview, setLabelReview] = createSignal(null);
  const [labelsLoading, setLabelsLoading] = createSignal(false);
  const [labelError, setLabelError] = createSignal('');
  let labelRequestSeq = 0;
  createEffect(() => {
    compareSessionId();
    compareActive();
    compareOldPath();
    compareNewPath();
    labelRequestSeq++;
    setLabelReview(null);
    setLabelsLoading(false);
    setLabelError('');
  });
  const suggestLabels = async () => {
    if (!compareActive() || labelsLoading()) return;
    const seq = ++labelRequestSeq;
    const session = compareSessionId();
    const oldPath = compareOldPath();
    const newPath = compareNewPath();
    setLabelReview(null);
    setLabelError('');
    setLabelsLoading(true);
    try {
      const [oldDoc, newDoc] = await Promise.all([getCompareDoc(oldPath), getCompareDoc(newPath)]);
      const review = await suggestPagePairsFromDocs(oldDoc, newDoc);
      if (seq === labelRequestSeq && session === compareSessionId() && compareActive()) setLabelReview(review);
    } catch (error) {
      if (seq === labelRequestSeq) setLabelError(error?.message || 'Could not read PDF page labels.');
    } finally {
      if (seq === labelRequestSeq) setLabelsLoading(false);
    }
  };
  let batchController = null;
  createEffect(() => {
    const active = compareActive();
    const oldPath = compareOldPath();
    const newPath = compareNewPath();
    const matches = compareConfirmedPairs();
    const alignment = compareOffset();
    if (batchController && (!active || batchController.oldPath !== oldPath || batchController.newPath !== newPath
        || batchController.matches !== matches || batchController.alignment !== alignment)) {
      batchController.abort();
    }
    const isStale = result => result && (result.oldPath !== oldPath || result.newPath !== newPath
        || result.offset.dx !== (alignment.dx || 0) || result.offset.dy !== (alignment.dy || 0)
        || result.offset.rotation !== (alignment.rotation || 0)
        || result.pairs.length !== matches.length || result.pairs.some((pair, index) =>
          pair.oldPage !== matches[index].oldPage || pair.newPage !== matches[index].newPage
          || pair.confirmedAt !== matches[index].confirmedAt));
    if (!active || isStale(batchResult()) || isStale(batchSummary())) {
      setBatchResult(null);
      setBatchSummary(null);
      setBatchProgress(null);
    }
  });
  onCleanup(() => batchController?.abort());

  const runBatch = async () => {
    if (batchRunning()) return;
    setBatchError('');
    setBatchResult(null);
    setBatchSummary(null);
    setBatchProgress(null);
    const controller = new AbortController();
    controller.oldPath = compareOldPath();
    controller.newPath = compareNewPath();
    controller.matches = compareConfirmedPairs();
    controller.alignment = compareOffset();
    batchController = controller;
    setBatchSummary({
      oldPath: controller.oldPath, newPath: controller.newPath,
      offset: controller.alignment, pairs: controller.matches,
      results: [], failures: [], completed: 0,
    });
    setBatchRunning(true);
    const stillCurrent = () => compareActive() && compareOldPath() === controller.oldPath
      && compareNewPath() === controller.newPath && compareConfirmedPairs() === controller.matches
      && compareOffset() === controller.alignment;
    try {
      const result = await runConfirmedPairBatch({
        oldPath: controller.oldPath, newPath: controller.newPath,
        pairs: controller.matches, offset: controller.alignment,
        detectPair: detectComparePair, annotationChanges: diffAnnotationsForPair,
        signal: controller.signal,
        onProgress: progress => {
          if (!stillCurrent()) return;
          setBatchProgress(progress);
          if (progress.result || progress.failure) {
            setBatchSummary(current => current && ({
              ...current, completed: progress.completed,
              results: progress.result ? [...current.results, progress.result] : current.results,
              failures: progress.failure ? [...current.failures, progress.failure] : current.failures,
            }));
          }
        },
      });
      if (stillCurrent()) {
        setBatchSummary(result);
        setBatchResult(result);
      }
    } catch (error) {
      if (stillCurrent()) setBatchError(error?.message || 'Batch comparison failed.');
    } finally {
      if (batchController === controller) batchController = null;
      setBatchRunning(false);
    }
  };

  const exportBatchReport = async (format = 'csv') => {
    const result = batchResult();
    if (!result || reportExporting()) return;
    setBatchError('');
    setReportExporting(true);
    try {
      const pdf = format === 'pdf';
      const name = pdf
        ? suggestedBatchComparePdfReportName(result.oldPath, result.newPath)
        : suggestedBatchCompareReportName(result.oldPath, result.newPath);
      const path = await saveFileDialog(name, pdf
        ? [{ name: 'PDF', extensions: ['pdf'] }]
        : [{ name: 'CSV', extensions: ['csv'] }]);
      if (!path) return;
      if (batchResult() !== result) throw new Error('Batch results changed. Export again.');
      let bytes;
      if (pdf) {
        const [module, response] = await Promise.all([
          import('../../../compare/change-report-pdf.js'),
          fetch('/pdfjs/web/standard_fonts/LiberationSans-Regular.ttf'),
        ]);
        if (!response.ok) throw new Error('Could not load the bundled PDF report font.');
        bytes = await module.buildBatchCompareChangeReportPdf(result, new Uint8Array(await response.arrayBuffer()));
      } else {
        bytes = new TextEncoder().encode(buildBatchCompareChangeReport(result));
      }
      if (batchResult() !== result) throw new Error('Batch results changed. Export again.');
      await writeBinaryFile(path, bytes);
    } catch (error) {
      setBatchError(error?.message || 'Could not export the batch report.');
    } finally {
      setReportExporting(false);
    }
  };
  const [draftOldPage, setDraftOldPage] = createSignal(compareOldPage());
  const [draftNewPage, setDraftNewPage] = createSignal(compareNewPage());
  createEffect(() => {
    setDraftOldPage(compareOldPage());
    setDraftNewPage(compareNewPage());
  });
  const showDraftPair = () => {
    const old = Math.max(1, Math.min(compareOldPageCount(), Math.trunc(Number(draftOldPage()) || 1)));
    const next = Math.max(1, Math.min(compareNewPageCount(), Math.trunc(Number(draftNewPage()) || 1)));
    if (old !== compareOldPage() || next !== compareNewPage()) setPagePair(old, next);
  };
  const confirmDraftPair = () => {
    showDraftPair();
    confirmCurrentPagePair();
  };

  // Instant CSS-transform preview while zooming. The bitmap stays at the
  // last hi-quality render scale; we visually scale the wrapper so the user
  // sees an immediate response. After a short debounce we trigger a true
  // re-render at the new scale and reset cssScale back to 1.
  const [cssScale, setCssScale] = createSignal(1);
  // The compareZoom value at which the current bitmap was rendered.
  let renderedZoom = compareZoom();
  let zoomDebounceTimer = null;
  const ZOOM_DEBOUNCE_MS = 150;
  // Set true when a zoom already re-anchored the scroll position itself (e.g.
  // cursor-anchored wheel, center-anchored +/− buttons). In that case the
  // post-render f-multiply must be skipped: the scroll is already expressed in
  // final visual terms, and the bitmap swap keeps the same visual size, so
  // re-scaling the scroll would double-apply the zoom factor and drift.
  let _scrollAlreadyAnchored = false;

  const visibleTypes = () => ({
    added: compareShowAdded(),
    removed: compareShowRemoved(),
    modified: compareShowModified(),
  });

  // Detection-px -> bitmap-px ratio. Maps a change bbox (measured in the fixed
  // detection raster) onto the CURRENTLY RENDERED bitmap. We use renderedZoom,
  // not the live zoom, because the highlight canvas is sized to the bitmap and
  // rides the same CSS `scale(cssScale)` wrapper as the page canvas — so any
  // in-progress zoom preview is applied once, by the wrapper, to both.
  const highlightRatio = () => {
    const visualScale = 1.5 * renderedZoom;
    const list = compareChanges();
    const detectScale = list[0]?.detectScale || visualScale;
    return visualScale / detectScale;
  };

  // Structurele annotatie-verschillen — los van de pixel-diff van de PDF-inhoud.
  // De app-annotaties zitten in een aparte overlay (doc.annotations), niet in
  // het gerenderde PDF-raster, dus de pixel-diff ziet ze niet. Reactief op het
  // pagina-paar én op de annotaties van beide documenten.
  const annotationChanges = createMemo(() =>
    compareActive()
      ? diffAnnotationsForPair(compareOldPath(), compareOldPage(), compareNewPath(), compareNewPage())
      : []
  );
  // Gecombineerde lijst voor het wijzigingen-paneel: PDF-inhoud + annotaties.
  const allChanges = createMemo(() => [...(compareChanges() || []), ...annotationChanges()]);
  // Navigatie/flash-ratio: annotatie-records staan in pagina-coördinaten
  // (× visualScale), inhouds-records in detectie-px (× highlightRatio).
  const changeRatio = (c) => (c && (c.source === 'annotation' || c.source === 'text'))
    ? (1.5 * renderedZoom)
    : highlightRatio();

  // ── Tekstmodus-arcering ────────────────────────────────────────────────
  // Met de Tekst-tab actief vervangt de tekststroom-diff de pixel-diff op de
  // pagina's: pixel-detectie slaat op tekstdocumenten vals af op elke
  // sub-pixel-verschuiving, terwijl de tekst-diff exact weet welke regels
  // veranderd zijn. Rects staan in pagina-weergaveruimte (schaal 1, oorsprong
  // linksboven) → ratio 1.5 × renderedZoom, gelijk aan de pagina-bitmap.
  const textModeActive = () => comparePanelTab() === 'text' && Array.isArray(compareTextChanges());
  // Pseudo-change-records (drawHighlights-vorm) voor één zijde/pagina.
  const textPaneChanges = (side) => {
    const page = side === 'old' ? compareOldPage() : compareNewPage();
    const out = [];
    for (const c of compareTextChanges() || []) {
      const rects = side === 'old' ? c.oldRects : c.newRects;
      for (const r of rects || []) {
        if (r.page !== page) continue;
        out.push({ type: c.type, x: r.x, y: r.y, width: r.w, height: r.h, _rec: c });
      }
    }
    return out;
  };
  // Omsluitende bbox van de rects van een tekst-record op één zijde/pagina —
  // voor het selectie-accent en het inzoomen bij klik.
  const textChangeBBox = (c, side) => {
    const page = side === 'old' ? compareOldPage() : compareNewPage();
    const rects = (side === 'old' ? c.oldRects : c.newRects) || [];
    let bb = null;
    for (const r of rects) {
      if (r.page !== page) continue;
      if (!bb) bb = { x1: r.x, y1: r.y, x2: r.x + r.w, y2: r.y + r.h };
      else {
        bb.x1 = Math.min(bb.x1, r.x);
        bb.y1 = Math.min(bb.y1, r.y);
        bb.x2 = Math.max(bb.x2, r.x + r.w);
        bb.y2 = Math.max(bb.y2, r.y + r.h);
      }
    }
    return bb ? { type: c.type, source: 'text', x: bb.x1, y: bb.y1, width: bb.x2 - bb.x1, height: bb.y2 - bb.y1 } : null;
  };
  const paintTextHighlights = (canvas, side) => {
    const sel = compareFocusedChange();
    const selBBox = sel && sel.source === 'text' ? textChangeBBox(sel, side) : null;
    paintHighlights(canvas, textPaneChanges(side), {
      ratio: 1.5 * renderedZoom,
      visibleTypes: { added: true, removed: true, modified: true },
      showBox: true,
      showContour: false,
      selected: selBBox,
      clear: true,
    });
  };

  // Paint one highlight canvas restricted to a subset of change types. Used by
  // both modes: overlay shows all three; side-by-side shows removed+modified on
  // OLD and added+modified on NEW so each edit lands on the page it belongs to.
  const paintPaneHighlights = (canvas, allow) => {
    if (!canvas) return;
    const v = visibleTypes();
    const sel = compareFocusedChange();
    // Only draw the selection accent on a pane that shows the selected type,
    // so a "removed" selection doesn't get a border on the NEW pane.
    const selForPane = sel && allow[sel.type] && v[sel.type] ? sel : null;
    const vis = {
      added: !!v.added && !!allow.added,
      removed: !!v.removed && !!allow.removed,
      modified: !!v.modified && !!allow.modified,
    };
    const style = { showBox: compareShowBox(), showContour: compareShowContour() };
    // Content changes are measured in detection-px → highlightRatio(). This call
    // clears the canvas first.
    paintHighlights(canvas, compareChanges(), {
      ratio: highlightRatio(), visibleTypes: vis, ...style,
      selected: selForPane && selForPane.source !== 'annotation' ? selForPane : null,
      clear: true,
    });
    // Annotation changes are measured in page-points (scale 1) → 1.5*renderedZoom,
    // the SAME mapping the page render uses. Previously these weren't painted at
    // all (only listed), and a selected annotation got drawn with the content
    // ratio — landing in the wrong place. Layer them on top without clearing.
    paintHighlights(canvas, annotationChanges(), {
      ratio: 1.5 * renderedZoom, visibleTypes: vis, ...style,
      selected: selForPane && selForPane.source === 'annotation' ? selForPane : null,
      clear: false,
    });
  };

  // Keep every highlight canvas the same pixel size as its page canvas, then
  // repaint. Runs after a render and whenever the change list/toggles change.
  const repaintHighlights = () => {
    // Tekstmodus: alléén de tekststroom-diff arceren (rood = verwijderd op
    // OUD, groen = toegevoegd op NIEUW, amber = gewijzigd op beide zijden);
    // de pixel-diff-laag blijft in deze modus onzichtbaar zodat er geen twee
    // tegenstrijdige markeringen door elkaar lopen.
    const textMode = textModeActive();
    if (compareMode() === 'overlay') {
      if (!overlayHighlightCanvasRef || !overlayNewCanvasRef) return;
      overlayHighlightCanvasRef.width = overlayNewCanvasRef.width;
      overlayHighlightCanvasRef.height = overlayNewCanvasRef.height;
      if (textMode) paintTextHighlights(overlayHighlightCanvasRef, 'new');
      else paintPaneHighlights(overlayHighlightCanvasRef, { added: true, removed: true, modified: true });
    } else {
      if (oldHiCanvasRef && oldCanvasRef) {
        oldHiCanvasRef.width = oldCanvasRef.width;
        oldHiCanvasRef.height = oldCanvasRef.height;
        if (textMode) paintTextHighlights(oldHiCanvasRef, 'old');
        else paintPaneHighlights(oldHiCanvasRef, { added: false, removed: true, modified: true });
      }
      if (newHiCanvasRef && newCanvasRef) {
        newHiCanvasRef.width = newCanvasRef.width;
        newHiCanvasRef.height = newCanvasRef.height;
        if (textMode) paintTextHighlights(newHiCanvasRef, 'new');
        else paintPaneHighlights(newHiCanvasRef, { added: true, removed: false, modified: true });
      }
    }
  };

  // Scroll a single pane so the change's centre lands in the middle of the
  // viewport. Shared by overlay (bodyRef) and side-by-side (both panes).
  const scrollPaneToChange = (pane, wrap, c, smooth = true) => {
    if (!pane || !wrap) return;
    // highlightRatio() maps to bitmap-px; the wrapper's CSS scale turns that
    // into on-screen (content) px, so fold cssScale in to hit the right spot
    // even if a zoom preview is still in flight.
    const ratio = changeRatio(c) * cssScale();
    // A wrapper's offset parent can be outside its scroll pane. Measure the
    // actual page origin so toolbar height and centered paper stay out of it.
    const pageRect = wrap.getBoundingClientRect();
    const paneRect = pane.getBoundingClientRect();
    const cx = pane.scrollLeft + pageRect.left - paneRect.left - pane.clientLeft
      + (c.x + c.width / 2) * ratio;
    const cy = pane.scrollTop + pageRect.top - paneRect.top - pane.clientTop
      + (c.y + c.height / 2) * ratio;
    pane.scrollTo({
      left: Math.max(0, cx - pane.clientWidth / 2),
      top: Math.max(0, cy - pane.clientHeight / 2),
      behavior: smooth ? 'smooth' : 'auto',
    });
  };

  // Click a change → center it in the pane(s) AND zoom in so it fills a
  // comfortable part of the viewport. Reuses scrollPaneToChange (instant centre)
  // + zoomAnchored (keeps that centre fixed while scaling), so both panes stay
  // in sync via the existing scroll/zoom mirroring. Only ever zooms IN.
  const zoomToChange = (c) => {
    const isOverlay = compareMode() === 'overlay';
    const pairs = isOverlay
      ? [[bodyRef, overlayWrapRef]]
      : [[oldPaneRef, oldWrapRef], [newPaneRef, newWrapRef]];
    const refPane = pairs[0][0];
    if (!refPane) return;
    // 1. instantly centre the change in each pane at the current zoom
    _scrollSyncing = true;
    for (const [pane, wrap] of pairs) scrollPaneToChange(pane, wrap, c, false);
    requestAnimationFrame(() => { _scrollSyncing = false; });
    // 2. zoom so the change fills ~55% of the pane — clamp to zoom-in only
    const curW = Math.max(1, c.width * changeRatio(c));
    const curH = Math.max(1, c.height * changeRatio(c));
    const frac = 0.55;
    let factor = Math.min(refPane.clientWidth * frac / curW, refPane.clientHeight * frac / curH);
    factor = Math.min(factor, 8 / Math.max(0.01, compareZoom())); // never past max zoom
    if (factor <= 1.02) return; // already large enough → leave it centred
    // 3. zoom around the pane centre, where the change now sits
    const rect = refPane.getBoundingClientRect();
    zoomAnchored(refPane, rect.left + refPane.clientWidth / 2, rect.top + refPane.clientHeight / 2, factor);
    // A fitted sheet cannot always scroll to the requested center yet. Once
    // its larger bitmap is laid out, center the actual selected region again.
    focusAfterRender = c;
  };

  const focusOnChange = (c) => {
    // Toggle selection if same record clicked again.
    const cur = compareFocusedChange();
    if (cur === c) {
      setFocusedChange(null);
      repaintHighlights();
      return;
    }
    setFocusedChange(c);

    // Centre + zoom in on the clicked change (both panes / overlay).
    zoomToChange(c);

    if (compareMode() === 'overlay' && bodyRef && overlayWrapRef) {
      const ratio = changeRatio(c);
      setHighlight({ x: c.x * ratio, y: c.y * ratio, w: c.width * ratio, h: c.height * ratio });
      if (highlightTimer) clearTimeout(highlightTimer);
      highlightTimer = setTimeout(() => setHighlight(null), 1000);
    }
    repaintHighlights();
  };

  let busy = false;
  let pending = false;
  // When set, the next doRender() will skip change detection. Used by zoom-
  // only re-renders since detection bboxes are computed in a fixed
  // detection-px space and are independent of the display scale.
  let pendingSkipDetection = false;

  const doRender = async (opts2 = {}) => {
    if (busy) {
      pending = true;
      // Keep skip flag sticky-true so zoom-only renders never trigger
      // detection, but if any non-zoom render is requested while busy, clear
      // it so detection runs once after the busy render.
      if (!opts2.skipDetection) pendingSkipDetection = false;
      return;
    }
    busy = true;
    const skipDetection = !!opts2.skipDetection || pendingSkipDetection;
    pendingSkipDetection = false;
    const zoomAtRender = compareZoom();
    try {
      const opts = {
        oldPath: compareOldPath(),
        newPath: compareNewPath(),
        oldPage: compareOldPage(),
        newPage: compareNewPage(),
        scale: 1.5 * zoomAtRender,
        offset: compareOffset(),
        skipDetection,
      };
      if (!opts.oldPath || !opts.newPath) return;
      if (compareMode() === 'overlay') {
        if (overlayOldCanvasRef && overlayNewCanvasRef && overlayHighlightCanvasRef) {
          await renderCompareOverlay(
            overlayOldCanvasRef,
            overlayNewCanvasRef,
            opts,
            overlayHighlightCanvasRef,
          );
          repaintHighlights();
        }
      } else {
        if (oldCanvasRef && newCanvasRef) {
          await renderCompareSideBySide(oldCanvasRef, newCanvasRef, opts);
          repaintHighlights();
        }
      }
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error('[compare] render failed', err);
    } finally {
      busy = false;
      // The freshly painted bitmap matches zoomAtRender. Reset CSS preview
      // so what the user sees is the crisp HQ bitmap (not a CSS-stretched
      // copy). We also remember the zoom so further wheel events can compute
      // a fresh CSS-only delta from this baseline.
      const prevZoom = renderedZoom;
      renderedZoom = zoomAtRender;
      // Zoom-anker: de content is een factor f groter/kleiner geworden —
      // schaal de scrollposities mee zodat beide panelen (en de overlay)
      // dezelfde plek blijven tonen i.p.v. naar linksboven te driften.
      // Dit vertaalt de scrollpositie uit de CSS-preview-ruimte (bitmap nog op
      // de oude schaal) naar de nieuwe native-bitmap-ruimte. Bij cursor-zoom
      // is de scroll al op het cursor-punt gezet in preview-ruimte; deze factor
      // houdt datzelfde punt vast wanneer de scherpe bitmap de preview vervangt.
      const f = prevZoom > 0 ? zoomAtRender / prevZoom : 1;
      if (_scrollAlreadyAnchored) {
        // Scroll was pre-set to hold a specific anchor; the visual size is
        // unchanged by the bitmap swap, so leave scroll untouched.
        _scrollAlreadyAnchored = false;
      } else if (Math.abs(f - 1) > 1e-4) {
        _scrollSyncing = true;
        for (const pane of [oldPaneRef, newPaneRef, bodyRef]) {
          if (!pane) continue;
          pane.scrollLeft *= f;
          pane.scrollTop *= f;
        }
        requestAnimationFrame(() => { _scrollSyncing = false; });
      }
      // If the user kept zooming during render, recompute cssScale relative
      // to the new baseline so the preview stays consistent.
      const cur = compareZoom();
      setCssScale(cur === renderedZoom ? 1 : cur / renderedZoom);
      if (focusAfterRender && cur === renderedZoom) {
        const change = focusAfterRender;
        focusAfterRender = null;
        queueMicrotask(() => {
          if (!compareFocused() || compareFocusedChange() !== change) return;
          const pairs = compareMode() === 'overlay'
            ? [[bodyRef, overlayWrapRef]]
            : [[oldPaneRef, oldWrapRef], [newPaneRef, newWrapRef]];
          _scrollSyncing = true;
          for (const [pane, wrap] of pairs) scrollPaneToChange(pane, wrap, change, false);
          requestAnimationFrame(() => { _scrollSyncing = false; });
        });
      }
      // Repaint highlights at the crisp scale (ratio changed with the bitmap).
      repaintHighlights();
      if (pending) {
        pending = false;
        doRender();
      }
    }
  };

  const scheduleHQRender = () => {
    if (zoomDebounceTimer) clearTimeout(zoomDebounceTimer);
    zoomDebounceTimer = setTimeout(() => {
      zoomDebounceTimer = null;
      // Zoom-only re-render: skip change detection entirely. Bbox results
      // are in detection-pixel space and don't change with display scale.
      doRender({ skipDetection: true });
    }, ZOOM_DEBOUNCE_MS);
  };

  // Non-zoom deps trigger an immediate HQ render. Zoom is handled in a
  // separate effect below with debouncing + CSS-transform preview.
  createEffect(() => {
    compareOldPath();
    compareNewPath();
    compareMode();
    compareOldPage();
    compareNewPage();
    compareOffset();
    if (compareActive()) {
      focusAfterRender = null;
      // Reset CSS preview state — after a path/page/mode change the bitmap
      // baseline is whatever the next render produces.
      setCssScale(1);
      if (zoomDebounceTimer) {
        clearTimeout(zoomDebounceTimer);
        zoomDebounceTimer = null;
      }
      queueMicrotask(doRender);
    }
  });

  // Zoom: instant CSS preview + debounced HQ re-render.
  createEffect(() => {
    const z = compareZoom();
    if (!compareActive()) return;
    // Visual scale relative to whatever the bitmap was last rendered at.
    if (renderedZoom > 0) {
      setCssScale(z / renderedZoom);
    }
    scheduleHQRender();
  });

  // Repaint highlight overlay when the changes list, visibility toggles, or
  // selection change — without re-running the full PDF render. Runs in BOTH
  // modes now (side-by-side paints per pane, overlay paints one canvas).
  createEffect(() => {
    compareChanges();
    annotationChanges();
    compareShowAdded();
    compareShowRemoved();
    compareShowModified();
    compareShowBox();
    compareShowContour();
    compareFocusedChange();
    compareMode();
    comparePanelTab();
    compareTextChanges();
    compareOldPage();
    compareNewPage();
    if (compareActive()) {
      queueMicrotask(repaintHighlights);
    }
  });

  // Fit / reset requests from the toolbar. Compute a zoom that makes the NEW
  // page fill the available viewport (fit) or snap to 100% (reset).
  createEffect(() => {
    const req = compareFitRequest();
    if (!req.kind || !compareActive()) return;
    focusAfterRender = null;
    // Reset scroll to the top-left so the (re)fitted page is fully framed
    // rather than left scrolled where the previous zoom sat. Flag the upcoming
    // render to keep this scroll instead of scaling the old one.
    const resetScroll = () => {
      _scrollAlreadyAnchored = true;
      _scrollSyncing = true;
      for (const p of [oldPaneRef, newPaneRef, bodyRef]) { if (p) { p.scrollLeft = 0; p.scrollTop = 0; } }
      requestAnimationFrame(() => { _scrollSyncing = false; });
    };
    if (req.kind === 'reset') {
      setCompareZoom(1);
      resetScroll();
      return;
    }
    // Fit: the rendered bitmap is (natural * 1.5 * renderedZoom) px. Work out
    // the natural (scale-1.5) size, then pick a zoom so it fits the pane.
    queueMicrotask(() => {
      const baseCanvas = compareMode() === 'overlay' ? overlayNewCanvasRef : newCanvasRef;
      const pane = compareMode() === 'overlay' ? bodyRef : newPaneRef;
      if (!baseCanvas || !pane || renderedZoom <= 0) return;
      const naturalW = baseCanvas.width / renderedZoom;   // px at zoom=1
      const naturalH = baseCanvas.height / renderedZoom;
      if (naturalW <= 0 || naturalH <= 0) return;
      const padding = 28; // breathing room inside the pane
      const availW = Math.max(1, pane.clientWidth - padding);
      const availH = Math.max(1, pane.clientHeight - padding);
      const z = Math.min(availW / naturalW, availH / naturalH);
      setCompareZoom(z);
      resetScroll();
    });
  });

  onCleanup(() => {
    if (zoomDebounceTimer) {
      clearTimeout(zoomDebounceTimer);
      zoomDebounceTimer = null;
    }
    clearCompareDocCache();
    clearTextCompareCache();
  });

  // Tekstvergelijking: draait één keer per documentpaar zodra de gebruiker de
  // Tekst-tab opent (lazy — extractie van alle pagina's is niet gratis).
  let _textRunSeq = 0;
  createEffect(() => {
    if (comparePanelTab() !== 'text' || !compareActive()) return;
    if (compareTextChanges() !== null || compareTextComparing()) return;
    const oldP = compareOldPath();
    const newP = compareNewPath();
    if (!oldP || !newP) return;
    const seq = ++_textRunSeq;
    setCompareTextComparing(true);
    runTextCompare(oldP, newP)
      .then((list) => { if (seq === _textRunSeq) setCompareTextChanges(list); })
      .catch((err) => {
        // eslint-disable-next-line no-console
        console.warn('[compare] text compare failed', err);
        if (seq === _textRunSeq) setCompareTextChanges([]);
      })
      .finally(() => { if (seq === _textRunSeq) setCompareTextComparing(false); });
  });

  // Klik op een tekstverschil → spring naar de betreffende pagina('s), licht
  // de bijbehorende arcering op (selectie-accent) en centreer/zoom erop.
  const gotoTextChange = (c) => {
    const op = c.oldPage != null ? c.oldPage : c.newPage;
    const np = c.newPage != null ? c.newPage : c.oldPage;
    setPagePair(op, np);
    setFocusedChange(c);
    // Na de paginawissel (render is async, maar de rect-coördinaten zijn
    // schaal-onafhankelijk) centreren op de nieuwe zijde als die bestaat,
    // anders op de oude.
    queueMicrotask(() => {
      const bb = textChangeBBox(c, c.newRects?.length ? 'new' : 'old');
      if (bb) zoomToChange(bb);
      repaintHighlights();
    });
  };

  // Esc closes compare mode (capture phase so it wins over other Esc handlers).
  // PageDown/PageUp bladert door de pagina-paren — met 28 pagina's is alleen
  // de kleine ‹/›-knop onwerkbaar. Toetsen in invoervelden (dx/dy/rot) blijven
  // met rust.
  onMount(() => {
    const onKey = (e) => {
      if (!compareActive() || !compareFocused()) return;
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        exitCompare();
        return;
      }
      const tag = e.target?.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
      if (e.key === 'PageDown') {
        e.preventDefault();
        e.stopPropagation();
        nextPagePair();
      } else if (e.key === 'PageUp') {
        e.preventDefault();
        e.stopPropagation();
        prevPagePair();
      }
    };
    document.addEventListener('keydown', onKey, true);
    onCleanup(() => document.removeEventListener('keydown', onKey, true));
  });

  // Cursor-anchored wheel zoom, matching the main viewer's feel: the point
  // under the cursor stays put while zooming. Works without Ctrl (the previous
  // implementation was a no-op unless Ctrl was held — the main reason zoom felt
  // "limited"). Shift+wheel keeps native scrolling; Ctrl+wheel still zooms.
  // Zoom by `factor`, keeping the viewport point (ax, ay) — expressed in the
  // pane's client coordinates — fixed on screen. Immediately adjusts scroll so
  // the anchor holds through the CSS preview; flags the render to skip its
  // post-swap re-scale so the factor isn't double-applied.
  const zoomAnchored = (pane, ax, ay, factor) => {
    focusAfterRender = null;
    if (!pane) { setCompareZoom(compareZoom() * factor); return; }
    const rect = pane.getBoundingClientRect();
    const offX = ax - rect.left;
    const offY = ay - rect.top;
    // Point under the anchor, in the current rendered coordinate space.
    const px = pane.scrollLeft + offX;
    const py = pane.scrollTop + offY;
    const z0 = compareZoom();
    const z1 = Math.max(0.1, Math.min(8, z0 * factor));
    const applied = z1 / z0;
    if (Math.abs(applied - 1) < 1e-6) return;
    const newLeft = Math.max(0, px * applied - offX);
    const newTop = Math.max(0, py * applied - offY);
    _scrollAlreadyAnchored = true;
    setCompareZoom(z1);
    _scrollSyncing = true;
    pane.scrollLeft = newLeft;
    pane.scrollTop = newTop;
    if (compareMode() === 'side') {
      const other = pane === oldPaneRef ? newPaneRef : oldPaneRef;
      if (other) { other.scrollLeft = newLeft; other.scrollTop = newTop; }
    }
    requestAnimationFrame(() => { _scrollSyncing = false; });
  };

  // The pane the cursor/interaction is currently over (side-by-side) or the
  // overlay scroll body.
  const activePane = (clientX) => {
    if (compareMode() !== 'side') return bodyRef;
    if (clientX == null || !oldPaneRef || !newPaneRef) return oldPaneRef;
    return clientX < oldPaneRef.getBoundingClientRect().right ? oldPaneRef : newPaneRef;
  };

  // Wiel-paginanavigatie zoals de enkelpagina-weergave (navigation-events.js):
  // gewoon scrollen beweegt binnen de pagina; onderaan + verder scrollen →
  // volgend pagina-paar, bovenaan + terugscrollen → vorig paar. Beide zijden
  // wisselen samen (nextPagePair/prevPagePair — de scroll-sync spiegelt de
  // scrollpositie al). Ctrl+wiel (of de wheelZoomWithoutCtrl-voorkeur) zoomt
  // cursor-veranker(d), net als de hoofd-viewer.
  let _wheelNavCooldown = false;
  const WHEEL_EDGE_SLACK = 2;
  const _navPanes = () => (compareMode() === 'side' ? [oldPaneRef, newPaneRef] : [bodyRef]);
  const _alignAfterNav = (toTop) => {
    const apply = () => {
      _scrollSyncing = true;
      for (const p of _navPanes()) {
        if (!p) continue;
        p.scrollTop = toTop ? 0 : Math.max(0, p.scrollHeight - p.clientHeight);
      }
      requestAnimationFrame(() => { _scrollSyncing = false; });
    };
    apply();
    // Na de (async) render van de nieuwe pagina kan de hoogte anders zijn —
    // nog één keer uitlijnen zodra de nieuwe bitmap er staat.
    setTimeout(apply, 250);
  };
  const tryWheelPageNav = (pane, deltaY) => {
    if (!pane || _wheelNavCooldown || !deltaY) return false;
    const canScroll = pane.scrollHeight > pane.clientHeight + 1;
    const atBottom = !canScroll
      || pane.scrollTop + pane.clientHeight >= pane.scrollHeight - WHEEL_EDGE_SLACK;
    const atTop = !canScroll || pane.scrollTop <= WHEEL_EDGE_SLACK;
    if (deltaY > 0 && atBottom && canNextPagePair()) {
      _wheelNavCooldown = true;
      nextPagePair();
      _alignAfterNav(true);
      setTimeout(() => { _wheelNavCooldown = false; }, 350);
      return true;
    }
    if (deltaY < 0 && atTop && canPrevPagePair()) {
      _wheelNavCooldown = true;
      prevPagePair();
      _alignAfterNav(false);
      setTimeout(() => { _wheelNavCooldown = false; }, 350);
      return true;
    }
    return false;
  };

  const handleWheel = (e) => {
    // Wheels over the change-list side panel scroll that list natively.
    if (e.target?.closest?.('.compare-change-list')) return;
    // Shift+wheel: let the browser scroll natively (horizontal), don't zoom.
    if (e.shiftKey) return;
    if (e.ctrlKey || e.metaKey || state.preferences?.wheelZoomWithoutCtrl) {
      e.preventDefault();
      const factor = e.deltaY < 0 ? 1.1 : 1 / 1.1;
      zoomAnchored(activePane(e.clientX), e.clientX, e.clientY, factor);
      return;
    }
    // Gewoon wiel: native scroll binnen het paneel (de onScroll-sync spiegelt
    // de andere zijde); op de rand → doorbladeren naar het volgende/vorige
    // pagina-paar.
    if (tryWheelPageNav(activePane(e.clientX), e.deltaY)) e.preventDefault();
  };

  // +/− buttons zoom around the centre of the (first) pane so the view doesn't
  // lurch toward the top-left corner.
  const zoomButton = (factor) => {
    const pane = compareMode() === 'side' ? oldPaneRef : bodyRef;
    if (!pane) { setCompareZoom(compareZoom() * factor); return; }
    const rect = pane.getBoundingClientRect();
    zoomAnchored(pane, rect.left + pane.clientWidth / 2, rect.top + pane.clientHeight / 2, factor);
  };

  // Click outside the change list deselects the focused change.
  const handleBodyClick = () => {
    if (compareFocusedChange()) setFocusedChange(null);
  };

  const exportChangeReport = async (format = 'csv') => {
    if (reportExporting() || compareDetecting()) return;
    setReportError('');
    setReportExporting(true);
    try {
      const oldPath = compareOldPath();
      const newPath = compareNewPath();
      const oldPage = compareOldPage();
      const newPage = compareNewPage();
      const alignment = compareOffset();
      const pairing = compareCurrentConfirmedPair();
      const pdf = format === 'pdf';
      const filename = pdf
        ? suggestedComparePdfReportName(oldPath, newPath, oldPage, newPage)
        : suggestedCompareReportName(oldPath, newPath, oldPage, newPage);
      const path = await saveFileDialog(filename, pdf
        ? [{ name: 'PDF', extensions: ['pdf'] }]
        : [{ name: 'CSV', extensions: ['csv'] }]);
      if (!path) return;
      // Read the live pair after the dialog returns: navigating while a native
      // Save dialog is open cannot silently label results as another page.
      const stillCurrent = () => oldPath === compareOldPath() && newPath === compareNewPath()
          && oldPage === compareOldPage() && newPage === compareNewPage()
          && alignment === compareOffset() && pairing === compareCurrentConfirmedPair()
          && !compareDetecting();
      if (!stillCurrent()) {
        setReportError('Comparison changed. Export again after detection finishes.');
        return;
      }
      const report = {
        oldPath, newPath, oldPage, newPage, offset: alignment, pairing, changes: allChanges(),
      };
      let bytes;
      if (pdf) {
        const [module, response] = await Promise.all([
          import('../../../compare/change-report-pdf.js'),
          fetch('/pdfjs/web/standard_fonts/LiberationSans-Regular.ttf'),
        ]);
        if (!response.ok) throw new Error('Could not load the bundled PDF report font.');
        bytes = await module.buildCompareChangeReportPdf(report, new Uint8Array(await response.arrayBuffer()));
      } else {
        bytes = new TextEncoder().encode(buildCompareChangeReport(report));
      }
      if (!stillCurrent()) {
        setReportError('Comparison changed. Export again after detection finishes.');
        return;
      }
      await writeBinaryFile(path, bytes);
    } catch (error) {
      setReportError(error?.message || 'Could not export the change report.');
    } finally {
      setReportExporting(false);
    }
  };

  const exportRevisionMarkups = async (scope) => {
    if (reportExporting() || compareDetecting()) return;
    setReportError('');
    setMarkupNotice('');
    const oldPath = compareOldPath();
    const newPath = compareNewPath();
    const oldPage = compareOldPage();
    const newPage = compareNewPage();
    const pairing = compareCurrentConfirmedPair();
    const alignment = compareOffset();
    const session = compareSessionId();
    const selected = compareFocusedChange();
    const visual = compareChanges();
    const index = visual.indexOf(selected);
    const selectedOnly = scope === 'selected';
    if (!pairing || !visual.length || (selectedOnly && (index < 0 || selected?.source === 'annotation' || !selected?.detectScale))) {
      setReportError('Select a detected visual region on a manually confirmed page pair.');
      return;
    }
    if (visual.some(change => change?.source === 'annotation' || !change?.detectScale)) {
      setReportError('Visual detection is incomplete. Detect changes again before exporting.');
      return;
    }
    const chosenIndices = selectedOnly ? [index] : visual.map((_, i) => i);
    const stillCurrent = () => compareActive() && session === compareSessionId()
      && oldPath === compareOldPath() && newPath === compareNewPath()
      && oldPage === compareOldPage() && newPage === compareNewPage()
      && pairing === compareCurrentConfirmedPair() && alignment === compareOffset()
      && (!selectedOnly || selected === compareFocusedChange()) && visual === compareChanges()
      && comparePanelTab() === 'changes' && !compareDetecting();
    setReportExporting(true);
    try {
      const module = await import('../../../compare/revision-markup-pdf.js');
      if (!stillCurrent()) throw new Error('Comparison changed. Select the visual region again.');
      const outputPath = await saveFileDialog(
        selectedOnly ? module.suggestedRevisionMarkupName(newPath, newPage, index + 1)
          : module.suggestedRevisionMarkupsName(newPath, newPage),
        [{ name: 'PDF', extensions: ['pdf'] }],
      );
      if (!outputPath) return;
      if (module.outputPathMatchesSource(outputPath, oldPath, newPath)) {
        throw new Error('Save the marked-up copy under a different name from either source PDF.');
      }
      if (!stillCurrent()) throw new Error('Comparison changed while choosing the output file.');
      const [oldDoc, newDoc] = await Promise.all([getCompareDoc(oldPath), getCompareDoc(newPath)]);
      const verified = await module.verifyComparisonSourceBytes({
        oldPath, newPath, oldDoc, newDoc,
        getCachedBytes: getCachedPdfBytes, readCurrentBytes: readBinaryFile,
      });
      if (!stillCurrent()) throw new Error('Comparison changed while verifying the source PDFs.');
      const report = createCompareChangeReportModel({
        oldPath, newPath, oldPage, newPage, offset: alignment, pairing,
        changes: allChanges(),
      });
      const result = await module.buildRevisionMarkupsPdf({
        newBytes: verified.newBytes, report, changes: chosenIndices.map(i => report.changes[i]),
        pdfPage: await newDoc.getPage(newPage), targetPath: newPath,
      });
      if (!stillCurrent()) throw new Error('Comparison changed while creating the markup.');
      const finalCheck = await module.verifyComparisonSourceBytes({
        oldPath, newPath, oldDoc, newDoc,
        getCachedBytes: getCachedPdfBytes, readCurrentBytes: readBinaryFile,
      });
      if (!stillCurrent() || finalCheck.identity.old !== verified.identity.old
          || finalCheck.identity.new !== verified.identity.new) {
        throw new Error('A source PDF changed. Reload both PDFs and detect changes again.');
      }
      await writeBinaryFile(outputPath, result.bytes);
      setMarkupNotice(`${result.entries.length} editable revision ${result.entries.length === 1 ? 'markup' : 'markups'} saved in a PDF copy. Open it to review or edit.`);
    } catch (error) {
      setReportError(error?.message || 'Could not export revision markups.');
    } finally {
      setReportExporting(false);
    }
  };

  return (
    <Show when={compareActive()}>
      <div
        class="compare-view"
        style={`position:absolute; inset:0; display:${compareFocused() ? 'flex' : 'none'}; flex-direction:column;`}
        onWheel={handleWheel}
      >
        <div
          class="compare-toolbar"
        >
          {/* Titel + weergavemodus */}
          <strong>{t('compare.title') || 'Compare PDFs'}</strong>
          <select class="compare-view-mode" aria-label="Comparison view" value={compareMode()}
            onChange={e => setCompareMode(e.currentTarget.value)}>
            <option value="side">{t('compare.sideBySide') || 'Side-by-side'}</option>
            <option value="overlay">{t('compare.overlay') || 'Overlay'}</option>
          </select>

          <Sep />

          {/* Paginanavigatie */}
          <span class="compare-toolbar-muted">{t('compare.page') || 'Page'}</span>
          <button class="pref-btn pref-btn-secondary" disabled={!canPrevPagePair()} title={t('compare.page') || 'Page'} onClick={prevPagePair}>{'‹'}</button>
          <span style="min-width:58px; text-align:center; font-variant-numeric:tabular-nums;">{compareOldPage()}/{compareOldPageCount()} · {compareNewPage()}/{compareNewPageCount()}</span>
          <button class="pref-btn pref-btn-secondary" disabled={!canNextPagePair()} title={t('compare.page') || 'Page'} onClick={nextPagePair}>{'›'}</button>

          <Sep />

          {/* Zoom */}
          <span class="compare-toolbar-muted">{t('compare.zoom') || 'Zoom'}</span>
          <button class="pref-btn pref-btn-secondary" title="-" onClick={() => zoomButton(1 / 1.2)}>−</button>
          <span style="min-width:42px; text-align:center; font-variant-numeric:tabular-nums;">{Math.round(compareZoom() * 100)}%</span>
          <button class="pref-btn pref-btn-secondary" title="+" onClick={() => zoomButton(1.2)}>+</button>
          <button class="pref-btn pref-btn-secondary" title={t('compare.fit') || 'Passend'} onClick={requestCompareFit}>{t('compare.fit') || 'Passend'}</button>
          <button class="pref-btn pref-btn-secondary" title={t('compare.reset') || '100%'} onClick={requestCompareReset}>{t('compare.reset') || '100%'}</button>

          <span style="flex:1;"></span>
          <button
            class="compare-exit"
            onClick={exitCompare}
            title="Esc"
          >
            ✕ {t('compare.exit') || 'Vergelijken sluiten'}
          </button>
        </div>
        <details class="compare-review-tools">
          <summary>
            Review tools · {compareConfirmedPairs().length} confirmed matches
            {' · '}{compareCurrentConfirmedPair() ? 'Current pair confirmed' : 'Current pair unconfirmed'}
            <Show when={batchRunning()}> · Batch {batchProgress()?.completed || 0}/{batchProgress()?.total || 0}</Show>
          </summary>
          <div class="compare-review-tools-content">
          <div class="compare-toolbar compare-display-options">
          {/* Markering */}
          <span class="compare-toolbar-muted">{t('compare.marking') || 'Markering'}</span>
          <label style="display:inline-flex; align-items:center; gap:4px; cursor:pointer;" title={t('compare.boxHint') || 'Toon wijzigingen als gevuld vlak'}>
            <input type="checkbox" checked={compareShowBox()} onChange={(e) => setCompareShowBox(e.currentTarget.checked)} />
            {t('compare.box') || 'Vlak'}
          </label>
          <label style="display:inline-flex; align-items:center; gap:4px; cursor:pointer;" title={t('compare.contourHint') || 'Toon wijzigingen met een omtreklijn'}>
            <input type="checkbox" checked={compareShowContour()} onChange={(e) => setCompareShowContour(e.currentTarget.checked)} />
            {t('compare.contour') || 'Contour'}
          </label>

          {/* Uitlijnen (alleen overlay) */}
          <Show when={compareMode() === 'overlay'}>
            <Sep />
            <label class="compare-toolbar-muted" for="compare-old-opacity">Earlier page</label>
            <input id="compare-old-opacity" type="range" min="0" max="100" step="5"
              value={oldLayerOpacity()} onInput={e => setOldLayerOpacity(Number(e.currentTarget.value))}
              aria-label="Earlier page opacity" />
            <output for="compare-old-opacity" style="min-width:32px; font-variant-numeric:tabular-nums;">{oldLayerOpacity()}%</output>
            <Sep />
            <span class="compare-toolbar-muted">{t('compare.align') || 'Align'}</span>
            <label class="compare-toolbar-muted" for="compare-align-dx">dx</label>
            <input
              id="compare-align-dx" type="number"
              style="width:56px;"
              value={compareOffset().dx}
              onInput={(e) => setCompareOffset({ dx: parseFloat(e.target.value) || 0 })}
            />
            <label class="compare-toolbar-muted" for="compare-align-dy">dy</label>
            <input
              id="compare-align-dy" type="number"
              style="width:56px;"
              value={compareOffset().dy}
              onInput={(e) => setCompareOffset({ dy: parseFloat(e.target.value) || 0 })}
            />
            <label class="compare-toolbar-muted" for="compare-align-rotation">rot</label>
            <input
              id="compare-align-rotation" type="number"
              step="0.1"
              style="width:56px;"
              value={compareOffset().rotation}
              onInput={(e) => setCompareOffset({ rotation: parseFloat(e.target.value) || 0 })}
            />
          </Show>

        </div>
        <div class="compare-page-pairs" style="display:flex; align-items:center; flex-wrap:wrap; gap:6px; padding:5px 10px; background:var(--theme-panel-bg); border-bottom:1px solid var(--theme-panel-border); color:var(--theme-text); font-size:12px;">
          <strong>Page pairs</strong>
          <label for="compare-old-page">Old</label>
          <input id="compare-old-page" type="number" min="1" max={compareOldPageCount()} value={draftOldPage()} onInput={e => setDraftOldPage(e.currentTarget.value)} style="width:48px;" />
          <label for="compare-new-page">New</label>
          <input id="compare-new-page" type="number" min="1" max={compareNewPageCount()} value={draftNewPage()} onInput={e => setDraftNewPage(e.currentTarget.value)} style="width:48px;" />
          <button class="pref-btn pref-btn-secondary" onClick={showDraftPair}>Show pair</button>
          <button class="pref-btn pref-btn-primary" onClick={confirmDraftPair}>Confirm match</button>
          <Show when={compareCurrentConfirmedPair()} fallback={<span title="This page pair has not been confirmed">Unconfirmed pair</span>}>
            {pair => <span title={`Manually confirmed ${pair().confirmedAt}`}>✓ Confirmed manually</span>}
          </Show>
          <Show when={compareCurrentConfirmedPair()}>
            <button class="pref-btn pref-btn-secondary" onClick={removeCurrentConfirmedPair} title="Remove this confirmed match">Remove match</button>
          </Show>
          <span style="flex:1;"></span>
          <button class="pref-btn pref-btn-secondary" disabled={!compareCurrentConfirmedPair() || compareConfirmedPairs()[0] === compareCurrentConfirmedPair()} onClick={() => goToAdjacentConfirmedPair(-1)} title="Previous confirmed pair">‹</button>
          <select aria-label="Confirmed page pairs" value={compareCurrentConfirmedPair() ? `${compareOldPage()}:${compareNewPage()}` : ''} onChange={e => {
            const [old, next] = e.currentTarget.value.split(':').map(Number);
            if (old && next) goToConfirmedPair(old, next);
          }}>
            <option value="">{compareConfirmedPairs().length ? `${compareConfirmedPairs().length} confirmed matches` : 'No confirmed matches'}</option>
            <For each={compareConfirmedPairs()}>{pair => <option value={`${pair.oldPage}:${pair.newPage}`}>Old {pair.oldPage} → new {pair.newPage}</option>}</For>
          </select>
          <button class="pref-btn pref-btn-secondary" disabled={!compareCurrentConfirmedPair() || compareConfirmedPairs().at(-1) === compareCurrentConfirmedPair()} onClick={() => goToAdjacentConfirmedPair(1)} title="Next confirmed pair">›</button>
        </div>
        <div class="compare-label-review" style="padding:5px 10px; background:var(--theme-panel-bg); border-bottom:1px solid var(--theme-panel-border); color:var(--theme-text); font-size:12px;">
          <div style="display:flex; align-items:center; flex-wrap:wrap; gap:7px;">
            <strong>Page-label matching</strong>
            <button class="pref-btn pref-btn-secondary" disabled={labelsLoading()} onClick={suggestLabels}>Suggest matches</button>
            <Show when={labelsLoading()}><span role="status">Reading embedded PDF labels…</span></Show>
            <Show when={labelReview()}>{review => <span role="status">{review().suggestions.length} suggestions · {review().ambiguities.length} ambiguous labels · {review().unmatchedOld.length} unmatched old · {review().unmatchedNew.length} unmatched new</span>}</Show>
            <Show when={labelError()}><span role="alert" style="color:var(--theme-danger, #b91c1c);">{labelError()}</span></Show>
          </div>
          <Show when={labelReview()}>{review => (
            <details style="margin-top:5px; max-height:230px; overflow:auto;">
              <summary>Review exact page-label suggestions and unmatched sheets</summary>
              <p>Labels are matched exactly, including letter case. No page-index matches are assumed.</p>
              <Show when={!review().hasOldLabels || !review().hasNewLabels}>
                <p>{!review().hasOldLabels ? 'Old PDF has no embedded page labels. ' : ''}{!review().hasNewLabels ? 'New PDF has no embedded page labels.' : ''}</p>
              </Show>
              <Show when={review().suggestions.length} fallback={<p>No unique label matches found. Match pages manually above.</p>}>
                <strong>Unique label matches — inspect and confirm each pair</strong>
                <For each={review().suggestions}>{pair => {
                  const confirmed = () => compareConfirmedPairs().some(item => item.oldPage === pair.oldPage && item.newPage === pair.newPage);
                  return <div style="display:flex; align-items:center; flex-wrap:wrap; gap:7px; padding:3px 0; border-bottom:1px solid var(--theme-panel-border);">
                    <span style="min-width:130px; overflow-wrap:anywhere;">{pair.label}</span>
                    <span>Old {pair.oldPage} → new {pair.newPage}</span>
                    <button class="pref-btn pref-btn-secondary" onClick={() => setPagePair(pair.oldPage, pair.newPage)}>Inspect</button>
                    <button class="pref-btn pref-btn-primary" disabled={!canConfirmSuggestedPair(compareConfirmedPairs(), pair.oldPage, pair.newPage)} onClick={() => confirmSuggestedPagePair(pair.oldPage, pair.newPage)}>{confirmed() ? 'Confirmed' : 'Confirm match'}</button>
                    <Show when={!confirmed() && !canConfirmSuggestedPair(compareConfirmedPairs(), pair.oldPage, pair.newPage)}><span>Conflicts with an existing match</span></Show>
                  </div>;
                }}</For>
              </Show>
              <Show when={review().ambiguities.length}>
                <p><strong>Ambiguous labels — match these manually</strong></p>
                <For each={review().ambiguities}>{item => <div>{item.label}: old pages {item.oldPages.join(', ')} · new pages {item.newPages.join(', ')}</div>}</For>
              </Show>
              <Show when={review().unmatchedOld.length}>
                <p><strong>Unmatched old pages</strong></p>
                <div>{review().unmatchedOld.map(item => `${item.page}${item.label ? ` (${item.label})` : ' (no label)'}`).join(', ')}</div>
              </Show>
              <Show when={review().unmatchedNew.length}>
                <p><strong>Unmatched new pages</strong></p>
                <div>{review().unmatchedNew.map(item => `${item.page}${item.label ? ` (${item.label})` : ' (no label)'}`).join(', ')}</div>
              </Show>
            </details>
          )}</Show>
        </div>
        <div class="compare-plan" style="padding:5px 10px; background:var(--theme-panel-bg); border-bottom:1px solid var(--theme-panel-border); color:var(--theme-text); font-size:12px;">
          <div style="display:flex; align-items:center; flex-wrap:wrap; gap:7px;">
            <strong>Compare plan</strong>
            <button class="pref-btn pref-btn-secondary" disabled={batchRunning() || planBusy()} onClick={saveComparePlan}>Save plan JSON</button>
            <button class="pref-btn pref-btn-secondary" disabled={batchRunning() || planBusy()} onClick={loadComparePlan}>Load plan JSON</button>
            <button class="pref-btn pref-btn-secondary" disabled={batchRunning() || planBusy()} onClick={saveRecentPlan}>Save session locally</button>
            <span>Plans and local sessions store PDF fingerprints, never PDF bytes.</span>
            <Show when={planBusy()}><span role="status">Working with plan…</span></Show>
            <Show when={snapshotNotice()}><span role="status">{snapshotNotice()}</span></Show>
            <Show when={planError()}><span role="alert" style="color:var(--theme-danger, #b91c1c);">{planError()}</span></Show>
          </div>
          <details class="compare-snapshots" style="margin-top:5px;">
            <summary style="cursor:pointer;">Saved sessions ({recentPlans().length})</summary>
            <p style="margin:4px 0; color:var(--theme-text-secondary);">Stored on this device: PDF paths, page counts, confirmed pairs, alignment, and SHA-256 fingerprints. PDF contents and detection results are not stored.</p>
            <Show when={recentPlans().length} fallback={<div>No saved comparison sessions yet.</div>}>
              <div style="max-height:170px; overflow:auto;">
                <For each={recentPlans()}>{entry => <div class="compare-snapshot" style="padding:5px 0; border-top:1px solid var(--theme-panel-border); overflow-wrap:anywhere;">
                  <div><strong>{new Date(entry.savedAt).toLocaleString()}</strong> · {entry.plan.pairs.length} confirmed pairs</div>
                  <div>Old: {entry.plan.documents.old.path} ({entry.plan.documents.old.pageCount} pages) · New: {entry.plan.documents.new.path} ({entry.plan.documents.new.pageCount} pages)</div>
                  <button class="pref-btn pref-btn-secondary" disabled={batchRunning() || planBusy() || !entry.identity || !compareSnapshotMatches(entry.plan, selectedPlanDocuments())} onClick={() => previewRecentPlan(entry)}>Review saved session</button>
                  <button class="pref-btn pref-btn-secondary" onClick={() => removeRecentPlan(entry)}>Remove saved session</button>
                  <Show when={!entry.identity}><span> Older session without PDF fingerprints: confirm its pairs again and save a new session.</span></Show>
                  <Show when={entry.identity && !compareSnapshotMatches(entry.plan, selectedPlanDocuments())}><span> Open the same PDFs to review this session.</span></Show>
                </div>}</For>
              </div>
            </Show>
          </details>
          <Show when={planPreview()}>
            <div style="margin-top:6px; padding:6px; border:1px solid var(--theme-panel-border); background:var(--theme-hover);">
              <strong>Review before replacing current matches</strong>
              <div style="overflow-wrap:anywhere;">Old: {planPreview()?.documents.old.path} ({planPreview()?.documents.old.pageCount} pages) · New: {planPreview()?.documents.new.path} ({planPreview()?.documents.new.pageCount} pages)</div>
              <div>{planPreview()?.pairs.length} manually confirmed pairs · alignment dx {planPreview()?.alignment.dx}, dy {planPreview()?.alignment.dy}, rotation {planPreview()?.alignment.rotation}°</div>
              <div>{planPreviewIdentity() ? 'PDF contents matched; checked again on replacement.' : 'Older plan without fingerprints: verify the selected revisions before replacing matches.'}</div>
              <details style="max-height:120px; overflow:auto;"><summary>Review saved page pairs</summary>
                <For each={planPreview()?.pairs || []}>{pair => <div>Old {pair.oldPage} → new {pair.newPage} · confirmed {pair.confirmedAt}</div>}</For>
              </details>
              <div style="display:flex; align-items:center; flex-wrap:wrap; gap:7px; margin-top:5px;">
                <button class="pref-btn pref-btn-primary" disabled={batchRunning() || planBusy()} onClick={replaceFromPlan}>Replace {compareConfirmedPairs().length} current matches with plan</button>
                <button class="pref-btn pref-btn-secondary" onClick={() => { setPlanPreview(null); setPlanPreviewIdentity(null); }}>Discard plan</button>
              </div>
            </div>
          </Show>
        </div>
        <div class="compare-batch" style="display:flex; align-items:center; flex-wrap:wrap; gap:7px; padding:5px 10px; background:var(--theme-panel-bg); border-bottom:1px solid var(--theme-panel-border); color:var(--theme-text); font-size:12px;" aria-live="polite">
          <strong>Batch review</strong>
          <button class="pref-btn pref-btn-primary" disabled={batchRunning() || !compareConfirmedPairs().length || compareConfirmedPairs().length > MAX_BATCH_PAIRS} onClick={runBatch}>Compare confirmed pairs</button>
          <Show when={batchRunning()}>
            <button class="pref-btn pref-btn-secondary" onClick={() => batchController?.abort()}>Stop after current pair</button>
            <span role="status">{batchProgress()?.completed || 0}/{batchProgress()?.total || 0} complete{batchProgress()?.pair ? ` · old ${batchProgress().pair.oldPage} → new ${batchProgress().pair.newPage}` : ''}</span>
          </Show>
          <Show when={!batchRunning() && batchResult()}>
            <span role="status">{batchResult()?.canceled
              ? `Stopped after ${batchResult().completed} of ${batchResult().pairs.length} pairs · partial results`
              : `${batchResult().completed} pairs complete`}
              {' · '}{batchResult()?.failures.length} failed · {batchRows().filter(row => row.status === 'unprocessed').length} not processed</span>
            <button class="pref-btn pref-btn-secondary" disabled={reportExporting()} onClick={() => exportBatchReport('csv')}>Export batch CSV</button>
            <button class="pref-btn pref-btn-secondary" disabled={reportExporting()} onClick={() => exportBatchReport('pdf')}>Export batch PDF</button>
          </Show>
          <Show when={compareConfirmedPairs().length > MAX_BATCH_PAIRS}><span>Maximum {MAX_BATCH_PAIRS} pairs per batch.</span></Show>
          <Show when={batchError()}><span role="alert" style="color:var(--theme-danger, #b91c1c);">{batchError()}</span></Show>
        </div>
        <Show when={batchSummary()}>
          <div class="compare-batch-results" style="background:var(--theme-panel-bg); border-bottom:1px solid var(--theme-panel-border); color:var(--theme-text); font-size:12px;">
            <details open>
              <summary style="padding:5px 10px; cursor:default; font-weight:600;">Batch results · {batchRows().filter(row => row.status === 'completed').length} complete · {batchRows().filter(row => row.status === 'failed').length} failed · {batchRows().filter(row => row.status === 'unprocessed').length} not processed</summary>
              <div style="max-height:180px; overflow:auto;">
                <table aria-label="Batch comparison results" style="width:100%; border-collapse:collapse; text-align:left;">
                  <thead><tr><th style="padding:4px 10px;">Old page</th><th style="padding:4px 10px;">New page</th><th style="padding:4px 10px;">Outcome</th><th style="padding:4px 10px;">Action</th></tr></thead>
                  <tbody>
                    <For each={batchRows()}>{row => <tr style={batchRowStyle(row.status)}>
                      <td style="padding:3px 10px;">{row.pair.oldPage}</td>
                      <td style="padding:3px 10px;">{row.pair.newPage}</td>
                      <td style="padding:3px 10px; overflow-wrap:anywhere;">
                        {row.status === 'completed' ? `${row.changeCount} ${row.changeCount === 1 ? 'change' : 'changes'}`
                          : row.status === 'failed' ? `Failed: ${row.error}`
                            : row.status === 'running' ? 'Comparing…' : 'Not processed'}
                      </td>
                      <td style="padding:3px 10px;"><button class="pref-btn pref-btn-secondary" onClick={() => goToConfirmedPair(row.pair.oldPage, row.pair.newPage)}>Go to pair</button></td>
                    </tr>}</For>
                  </tbody>
                </table>
              </div>
            </details>
          </div>
        </Show>
          </div>
        </details>
        <div class="compare-workspace" style="flex:1; display:flex; min-height:0;">
          <div
            class="compare-body"
            ref={bodyRef}
            onClick={handleBodyClick}
            on:mousedown={killMiddleAutoscroll}
            onPointerDown={(e) => { if (compareMode() !== 'side') startPanDrag(e, bodyRef); }}
            style={compareMode() === 'side'
              ? 'flex:1; overflow:hidden; display:flex; align-items:stretch; padding:0; gap:0;'
              : 'flex:1; overflow:auto; display:flex; align-items:flex-start; padding:14px; gap:14px;'}
          >
            <Show
              when={compareMode() === 'side'}
              fallback={
                <div style="flex:0 0 auto; margin:0 auto; display:flex; flex-direction:column; align-items:center; gap:8px;">
                  {/* The old page is a visual review layer. Detection and PDF
                      exports continue to use their separate source canvases. */}
                  <div
                    ref={overlayWrapRef}
                    style={`position:relative; background:#ffffff; box-shadow:0 0 0 1px #444; line-height:0; transform:scale(${cssScale()}); transform-origin:0 0;`}
                  >
                    <canvas ref={overlayNewCanvasRef} style="display:block;"></canvas>
                    <div class="compare-old-layer" style={`position:absolute; left:0; top:0; width:100%; height:100%; pointer-events:none; mix-blend-mode:multiply; opacity:${oldLayerOpacity() / 100}; transform-origin:50% 50%; transform:translate(${visibleAlignment().dx}px, ${visibleAlignment().dy}px) rotate(${visibleAlignment().rotation}deg);`}>
                      <canvas ref={overlayOldCanvasRef} style="display:block;"></canvas>
                    </div>
                    <canvas
                      ref={overlayHighlightCanvasRef}
                      style="position:absolute; left:0; top:0; pointer-events:none;"
                    ></canvas>
                    <Show when={highlight()}>
                      {(h) => (
                        <div
                          style={`position:absolute; left:${h().x}px; top:${h().y}px; width:${h().w}px; height:${h().h}px; border:2px solid #ffd700; background:rgba(255,215,0,0.15); pointer-events:none; box-sizing:border-box;`}
                        />
                      )}
                    </Show>
                  </div>
                </div>
              }
            >
              <div style="flex:1 1 50%; min-width:0; position:relative; display:flex; border-right:1px solid #555;">
                <div style="position:absolute; top:6px; left:8px; z-index:2; padding:2px 8px; background:rgba(40,40,40,0.85); color:#ddd; font-size:11px; pointer-events:none;">
                  {t('compare.oldDoc') || 'Old'}
                </div>
                <div
                  ref={oldPaneRef}
                  class="compare-pane compare-pane-old"
                  onScroll={() => syncScroll(oldPaneRef, newPaneRef)}
                  on:mousedown={killMiddleAutoscroll}
                  onPointerDown={(e) => startPanDrag(e, oldPaneRef)}
                  style="flex:1; overflow:auto;"
                >
                  <div style="padding:14px; display:inline-block; line-height:0;">
                    {/* Page + diff overlay share a scaled wrapper so the red/
                        yellow highlights stay pixel-aligned with the render. */}
                    <div
                      ref={oldWrapRef}
                      style={`position:relative; line-height:0; transform:scale(${cssScale()}); transform-origin:0 0;`}
                    >
                      <canvas
                        ref={oldCanvasRef}
                        style="display:block; background:#ffffff; box-shadow:0 0 0 1px #444;"
                      ></canvas>
                      <canvas
                        ref={oldHiCanvasRef}
                        style="position:absolute; left:0; top:0; pointer-events:none;"
                      ></canvas>
                    </div>
                  </div>
                </div>
              </div>
              <div style="flex:1 1 50%; min-width:0; position:relative; display:flex;">
                <div style="position:absolute; top:6px; left:8px; z-index:2; padding:2px 8px; background:rgba(40,40,40,0.85); color:#ddd; font-size:11px; pointer-events:none;">
                  {t('compare.newDoc') || 'New'}
                </div>
                <div
                  ref={newPaneRef}
                  class="compare-pane compare-pane-new"
                  onScroll={() => syncScroll(newPaneRef, oldPaneRef)}
                  on:mousedown={killMiddleAutoscroll}
                  onPointerDown={(e) => startPanDrag(e, newPaneRef)}
                  style="flex:1; overflow:auto;"
                >
                  <div style="padding:14px; display:inline-block; line-height:0;">
                    <div
                      ref={newWrapRef}
                      style={`position:relative; line-height:0; transform:scale(${cssScale()}); transform-origin:0 0;`}
                    >
                      <canvas
                        ref={newCanvasRef}
                        style="display:block; background:#ffffff; box-shadow:0 0 0 1px #444;"
                      ></canvas>
                      <canvas
                        ref={newHiCanvasRef}
                        style="position:absolute; left:0; top:0; pointer-events:none;"
                      ></canvas>
                    </div>
                  </div>
                </div>
              </div>
            </Show>
          </div>
          <ChangeListPanel
            t={t}
            changes={allChanges}
            onFocus={focusOnChange}
            focused={compareFocusedChange}
            onTextFocus={gotoTextChange}
            onExport={exportChangeReport}
            onMarkup={() => exportRevisionMarkups('selected')}
            onMarkupAll={() => exportRevisionMarkups('all')}
            markupDisabled={reportExporting() || compareDetecting() || !compareCurrentConfirmedPair()
              || !compareChanges().includes(compareFocusedChange()) || comparePanelTab() !== 'changes'}
            markupAllDisabled={reportExporting() || compareDetecting() || !compareCurrentConfirmedPair()
              || !compareChanges().length || comparePanelTab() !== 'changes'}
            markupNotice={markupNotice()}
            exportDisabled={reportExporting() || compareDetecting()}
            reportError={reportError()}
          />
        </div>
      </div>
    </Show>
  );
}

// Arrow keys move among the visible change controls without selecting a
// region. Enter or Space then performs the same action as a pointer click.
function navigateChangeList(event) {
  if (event.altKey || event.ctrlKey || event.metaKey) return;
  if (!['ArrowUp', 'ArrowDown', 'Home', 'End'].includes(event.key)) return;
  const current = event.target.closest?.('.compare-list-target');
  if (!current || !event.currentTarget.contains(current)) return;
  const targets = [...event.currentTarget.querySelectorAll('.compare-list-target')];
  const index = targets.indexOf(current);
  if (index < 0) return;
  const next = event.key === 'Home' ? 0 : event.key === 'End' ? targets.length - 1
    : Math.max(0, Math.min(targets.length - 1, index + (event.key === 'ArrowDown' ? 1 : -1)));
  event.preventDefault();
  event.stopPropagation();
  const destination = targets[next];
  destination?.focus({ preventScroll: true });
  if (destination) {
    const listRect = event.currentTarget.getBoundingClientRect();
    const itemRect = destination.getBoundingClientRect();
    if (itemRect.top < listRect.top) event.currentTarget.scrollTop += itemRect.top - listRect.top;
    else if (itemRect.bottom > listRect.bottom) event.currentTarget.scrollTop += itemRect.bottom - listRect.bottom;
  }
}

function ChangeListPanel(props) {
  const typeLabel = (type) => {
    const k = type === 'added' ? 'compare.added'
      : type === 'removed' ? 'compare.removed'
      : 'compare.modified';
    return props.t(k) || (type === 'added' ? 'Toegevoegd' : type === 'removed' ? 'Verwijderd' : 'Gewijzigd');
  };
  const typeIcon = (type) => type === 'added' ? '+' : type === 'removed' ? '−' : 'Δ';
  const typeColor = (type) => type === 'added' ? '#16a34a' : type === 'removed' ? '#dc2626' : '#ca8a04';

  // Per-type collapse state (default: expanded).
  const [collapsed, setCollapsed] = createSignal({ added: false, removed: false, modified: false });
  const toggleCollapsed = (type) => {
    setCollapsed({ ...collapsed(), [type]: !collapsed()[type] });
  };

  const groupedByType = () => {
    const result = { added: [], removed: [], modified: [] };
    const list = props.changes() || [];
    list.forEach((c, idx) => {
      // Preserve original index for stable numbering.
      const type = result[c.type] ? c.type : 'modified';
      result[type].push({ change: c, index: idx });
    });
    return result;
  };

  const visibleFor = (type) => {
    if (type === 'added') return compareShowAdded();
    if (type === 'removed') return compareShowRemoved();
    return compareShowModified();
  };
  const setVisibleFor = (type, val) => {
    if (type === 'added') setCompareShowAdded(val);
    else if (type === 'removed') setCompareShowRemoved(val);
    else setCompareShowModified(val);
  };

  const TypeToggle = (tProps) => (
    <button
      class="compare-type-toggle"
      aria-pressed={visibleFor(tProps.type)}
      onClick={() => setVisibleFor(tProps.type, !visibleFor(tProps.type))}
      title={typeLabel(tProps.type)}
    >
      <span
        style={`width:10px; height:10px; display:inline-block; background:${visibleFor(tProps.type) ? typeColor(tProps.type) : 'var(--theme-text-secondary)'}; border:1px solid var(--theme-border);`}
      ></span>
      {typeLabel(tProps.type)} ({tProps.count})
    </button>
  );

  const total = () => (props.changes() || []).length;

  return (
    <div
      class="compare-change-list"
      onClick={(e) => e.stopPropagation()}
    >
      {/* Tab-strip: visuele wijzigingen vs. tekstvergelijking. */}
      <div class="compare-panel-tabs">
        <For each={['changes', 'text']}>
          {(tab) => (
            <button
              class="compare-panel-tab"
              aria-current={comparePanelTab() === tab ? 'page' : undefined}
              onClick={() => setComparePanelTab(tab)}
            >
              {tab === 'changes'
                ? `${props.t('compare.changes') || 'Wijzigingen'} (${compareDetecting() ? '…' : total()})`
                : `${props.t('compare.textTab') || 'Tekst'}${compareTextChanges() ? ` (${compareTextChanges().length})` : ''}`}
            </button>
          )}
        </For>
      </div>
      <Show when={comparePanelTab() === 'text'}>
        <TextDiffList t={props.t} onFocus={props.onTextFocus} focused={props.focused} />
      </Show>
      <Show when={comparePanelTab() === 'changes'}>
      <div style="padding:6px 8px; border-bottom:1px solid var(--theme-panel-border); background:var(--theme-panel-bg);">
        <div style="display:flex; gap:5px;">
          <button class="pref-btn pref-btn-secondary" style="flex:1;" disabled={props.exportDisabled}
            onClick={() => props.onExport('csv')} title="Export the current page pair and its detected changes as CSV">
            Export change CSV
          </button>
          <button class="pref-btn pref-btn-secondary" style="flex:1;" disabled={props.exportDisabled}
            onClick={() => props.onExport('pdf')} title="Export the current page pair and its detected changes as PDF">
            Export change PDF
          </button>
        </div>
        <button class="pref-btn pref-btn-secondary" style="width:100%; margin-top:5px;" disabled={props.markupDisabled}
          onClick={props.onMarkup} title="Save a copy of the new PDF with the selected unreviewed visual region as an editable markup">
          Export selected region as marked-up PDF
        </button>
        <button class="pref-btn pref-btn-secondary" style="width:100%; margin-top:5px;" disabled={props.markupAllDisabled}
          onClick={props.onMarkupAll} title="Save a copy of the new PDF with every unreviewed detected visual region on this confirmed page pair as a separate editable markup">
          Export all detected regions on this pair
        </button>
        <Show when={props.markupNotice}>
          <div role="status" style="color:var(--theme-accent); font-size:11px; margin-top:4px;">{props.markupNotice}</div>
        </Show>
        <Show when={props.reportError}>
          <div role="alert" class="compare-report-error">{props.reportError}</div>
        </Show>
      </div>
      <div class="compare-type-filters">
        <TypeToggle type="added" count={groupedByType().added.length} />
        <TypeToggle type="removed" count={groupedByType().removed.length} />
        <TypeToggle type="modified" count={groupedByType().modified.length} />
      </div>
      <div class="compare-results-scroll" onKeyDown={navigateChangeList}>
        <Show
          when={total() > 0}
          fallback={
            <div class="compare-empty">
              {/* Tijdens een lopende detectie is "Geen wijzigingen" misleidend —
                  toon dan een neutrale bezig-indicator (geen i18n-key nodig). */}
              {compareDetecting() ? '…' : (props.t('compare.noChanges') || 'Geen wijzigingen')}
            </div>
          }
        >
          <For each={['added', 'removed', 'modified']}>
            {(type) => (
              <Show when={visibleFor(type) && groupedByType()[type].length > 0}>
                <div>
                  <button type="button" class="compare-change-group compare-list-target"
                    aria-expanded={!collapsed()[type]}
                    onClick={() => toggleCollapsed(type)}
                    onKeyDown={(event) => {
                      if ((event.key === 'ArrowLeft' && !collapsed()[type]) ||
                          (event.key === 'ArrowRight' && collapsed()[type])) {
                        event.preventDefault();
                        event.stopPropagation();
                        toggleCollapsed(type);
                      }
                    }}
                  >
                    <span style="width:10px; display:inline-block;">{collapsed()[type] ? '▶' : '▼'}</span>
                    <span
                      style={`width:10px; height:10px; display:inline-block; background:${typeColor(type)}; border:1px solid #555;`}
                    ></span>
                    <span>{typeLabel(type)} ({groupedByType()[type].length})</span>
                  </button>
                  <Show when={!collapsed()[type]}>
                    <For each={groupedByType()[type]}>
                      {(item) => {
                        const c = item.change;
                        const isFocused = () => props.focused() === c;
                        return (
                          <button type="button" class={`compare-change-row compare-list-target${isFocused() ? ' focused' : ''}`}
                            aria-current={isFocused() ? 'true' : undefined}
                            onClick={(e) => { e.stopPropagation(); props.onFocus(c); }}
                          >
                            <span
                              style={`width:22px; height:22px; flex:0 0 auto; display:flex; align-items:center; justify-content:center; background:${typeColor(c.type)}; color:#fff; font-weight:bold; font-size:13px;`}
                            >
                              {typeIcon(c.type)}
                            </span>
                            <span style="flex:1; min-width:0;">
                              <span style="display:block; font-weight:bold; white-space:nowrap; overflow:hidden; text-overflow:ellipsis;">
                                {item.index + 1}. {c.source === 'annotation' ? c.label : typeLabel(c.type)}
                              </span>
                              <span class="compare-row-detail">
                                {c.source === 'annotation'
                                  ? `✎ ${props.t('compare.annotation') || 'Annotatie'}`
                                  : `~${Math.round(c.width)}×${Math.round(c.height)} px @ (${Math.round(c.x)}, ${Math.round(c.y)})`}
                              </span>
                            </span>
                          </button>
                        );
                      }}
                    </For>
                  </Show>
                </div>
              </Show>
            )}
          </For>
        </Show>
      </div>
      </Show>
    </div>
  );
}

// Lijst van tekstverschillen (Tekst-tab). Elk record toont paginanummer(s),
// soort en de tekst oud → nieuw; klik springt naar het betreffende
// pagina-paar. Bij 'modified' worden de gewijzigde woorden geaccentueerd.
function TextDiffList(props) {
  const typeColor = (type) => type === 'added' ? '#16a34a' : type === 'removed' ? '#dc2626' : '#ca8a04';
  const typeIcon = (type) => type === 'added' ? '+' : type === 'removed' ? '−' : 'Δ';
  const typeLabel = (type) => props.t(
    type === 'added' ? 'compare.added' : type === 'removed' ? 'compare.removed' : 'compare.modified'
  ) || type;
  const pageLabel = (c) => {
    const pg = props.t('compare.page') || 'Pagina';
    if (c.type === 'added') return `${pg} ${c.newPage}`;
    if (c.type === 'removed') return `${pg} ${c.oldPage}`;
    return c.oldPage === c.newPage ? `${pg} ${c.oldPage}` : `${pg} ${c.oldPage} → ${c.newPage}`;
  };
  // Accentueer de gewijzigde woorden binnen een modified-record.
  const renderParts = (parts, color) => (
    <For each={parts}>
      {(p, idx) => (
        <>
          {idx() > 0 ? ' ' : ''}
          {p.changed
            ? <span style={`background:${color}; color:#fff; padding:0 1px;`}>{p.text}</span>
            : <span>{p.text}</span>}
        </>
      )}
    </For>
  );
  const textStyle = 'font-size:11px; white-space:pre-wrap; word-break:break-word; max-height:88px; overflow:hidden;';
  return (
    <div class="compare-results-scroll" onKeyDown={navigateChangeList}>
      <Show
        when={!compareTextComparing()}
        fallback={<div class="compare-empty">…</div>}
      >
        <Show
          when={(compareTextChanges() || []).length > 0}
          fallback={
            <div class="compare-empty">
              {props.t('compare.noTextChanges') || 'Geen tekstverschillen'}
            </div>
          }
        >
          <For each={compareTextChanges()}>
            {(c, i) => {
              const words = () => c.type === 'modified' ? diffWords(c.oldText, c.newText) : null;
              const isFocused = () => props.focused?.() === c;
              return (
                <button type="button" class={`compare-text-row compare-list-target${isFocused() ? ' focused' : ''}`}
                  aria-current={isFocused() ? 'true' : undefined}
                  onClick={(e) => { e.stopPropagation(); props.onFocus?.(c); }}
                >
                  <span style="display:flex; align-items:center; gap:6px; margin-bottom:3px;">
                    <span
                      style={`width:16px; height:16px; flex:0 0 auto; display:inline-flex; align-items:center; justify-content:center; background:${typeColor(c.type)}; color:#fff; font-weight:bold; font-size:11px;`}
                    >
                      {typeIcon(c.type)}
                    </span>
                    <span style="font-weight:bold;">{i() + 1}. {typeLabel(c.type)}</span>
                    <span class="compare-text-page">{pageLabel(c)}</span>
                  </span>
                  <Show when={c.oldText}>
                    <span style={`display:block; ${textStyle} color:var(--compare-old-text);`}>
                      <Show when={words()} fallback={c.oldText}>
                        {renderParts(words().oldParts, '#dc2626')}
                      </Show>
                    </span>
                  </Show>
                  <Show when={c.oldText && c.newText}>
                    <span style="display:block; color:var(--theme-text-secondary); font-size:10px; line-height:1; padding:1px 0;">↓</span>
                  </Show>
                  <Show when={c.newText}>
                    <span style={`display:block; ${textStyle} color:var(--compare-new-text);`}>
                      <Show when={words()} fallback={c.newText}>
                        {renderParts(words().newParts, '#16a34a')}
                      </Show>
                    </span>
                  </Show>
                </button>
              );
            }}
          </For>
        </Show>
      </Show>
    </div>
  );
}
