// The passive MultiView pane (docs/reference/editor/workspace.md): a read-only second view of
// a document. One page, rendered with PDF.js at the pane's own scale, plus an
// annotation canvas drawn with the shared drawAnnotation() in page
// coordinates. The live pane (#pdf-container) keeps the real renderer; this
// view never takes tools. A pointer down asks the store to make it active.

import { renderPdfJsPageToCanvas } from './pdfjs-canvas-render.js';
import { annotationToScreen } from './multiview-sync.js';
import { nativeOcgPdfJsConfig } from './native-ocg-selection.js';
import { weergaveRotatie } from './weergave-ruimte.js';
import { drawAnnotation, metWeergaveZoom } from '../annotations/rendering.js';
import { drawExtensionUnderlays } from '../annotations/extension-overlay.js';
import { metSchaalBronnen } from '../annotations/schaal-bronnen.js';
import { apRenderParams, apOverslaan } from './ap-render-state.js';
import { edition } from '../editions/active.js';

const dprNow = () => (typeof window !== 'undefined' && window.devicePixelRatio) || 1;
const MAX_AXIS_PX = 4096;

export function createPassivePane(host, { onShow = null } = {}) {
  const pageBox = document.createElement('div');
  pageBox.className = 'mv-page';
  const pdfCanvas = document.createElement('canvas');
  pdfCanvas.className = 'mv-pdf-canvas';
  const annCanvas = document.createElement('canvas');
  annCanvas.className = 'mv-annotation-canvas';
  pageBox.append(pdfCanvas, annCanvas);
  host.append(pageBox);

  let current = null; // { doc, page, scale, matrix, cssW, cssH, apIds }
  let gen = 0;
  let annFrame = 0;
  let apHertekenen = 0;

  // De /AP-markeringen in de bitmap kloppen niet meer (een markering bewerkt,
  // verborgen of verwijderd): de pagina één keer opnieuw tekenen.
  function planApHertekening() {
    if (apHertekenen || !current) return;
    apHertekenen = setTimeout(() => {
      apHertekenen = 0;
      if (!current) return;
      const { doc, page, scale } = current;
      current.verouderd = true;
      show(doc, { page, scale, scrollLeft: host.scrollLeft, scrollTop: host.scrollTop })
        .catch((e) => console.warn('[multiview] /AP-hertekening', e));
    }, 150);
  }

  function drawAnnotations() {
    annFrame = 0;
    if (!current) return;
    const { doc, page, matrix, cssW, cssH } = current;
    const dpr = dprNow();
    const w = Math.max(1, Math.floor(cssW * dpr));
    const h = Math.max(1, Math.floor(cssH * dpr));
    if (annCanvas.width !== w || annCanvas.height !== h) { annCanvas.width = w; annCanvas.height = h; }
    annCanvas.style.width = `${Math.floor(cssW)}px`;
    annCanvas.style.height = `${Math.floor(cssH)}px`;
    const ctx = annCanvas.getContext('2d');
    if (!ctx) return;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, w, h);
    ctx.setTransform(dpr * matrix[0], dpr * matrix[1], dpr * matrix[2], dpr * matrix[3], dpr * matrix[4], dpr * matrix[5]);
    const annotations = doc.annotations || [];
    // Onbewerkte ingelezen markeringen staan al met hun eigen /AP in de
    // pagina-bitmap (ap-render-state.js): niet nog eens natekenen.
    const { overslaan, klopt } = apOverslaan(doc, page, current.apIds);
    if (!klopt) planApHertekening();
    metWeergaveZoom(current.scale, () => metSchaalBronnen(() => {
      drawExtensionUnderlays(ctx, page, doc);
      for (const a of annotations) if (edition.rendering?.isUnderlay?.(a) && a.page === page && !overslaan.has(a.id)) { ctx.save(); try { drawAnnotation(ctx, a); } catch (e) { console.warn('[multiview] drawAnnotation', e); } ctx.restore(); }
      for (const annotation of annotations) {
        if (annotation.page !== page) continue;
        if (edition.rendering?.isUnderlay?.(annotation)) continue;
        if (overslaan.has(annotation.id)) continue;
        ctx.save();
        try { drawAnnotation(ctx, annotation); } catch (e) { console.warn('[multiview] drawAnnotation', e); }
        ctx.restore();
      }
    }));
  }

  /** Repaint the annotation layer on the next frame (markup edits). */
  function scheduleAnnotations() {
    if (annFrame || !current) return;
    annFrame = requestAnimationFrame(drawAnnotations);
  }

  /**
   * Show `doc` at { page, scale } and then scroll to { scrollLeft, scrollTop }.
   * Re-renders the PDF only when the document, page, scale or rotation changed.
   */
  async function show(doc, view) {
    if (!doc?.pdfDoc) { clear(); return false; }
    const pdfDoc = doc.pdfDoc;
    const pageNum = Math.min(Math.max(1, view.page || 1), pdfDoc.numPages);
    const scale = view.scale > 0 ? view.scale : 1;
    const extra = doc.pageRotations?.[pageNum] || 0;
    const viewRot = weergaveRotatie(doc) || 0;
    const key = `${pageNum}|${scale}|${extra}|${viewRot}`;
    const myGen = ++gen;
    if (!(current && current.doc === doc && current.pdfDoc === pdfDoc && current.key === key && !current.verouderd)) {
      const page = await pdfDoc.getPage(pageNum);
      if (myGen !== gen) return false;
      const rotation = ((page.rotate + extra) % 360 + 360) % 360;
      const base = page.getViewport({ scale: 1, rotation });
      let screen = page.getViewport({ scale, rotation: (rotation + viewRot) % 360 });
      // Same high-zoom cap as the live renderer: render smaller, CSS-stretch.
      const maxAxis = Math.max(screen.width, screen.height) * dprNow();
      const renderVp = maxAxis > MAX_AXIS_PX
        ? page.getViewport({ scale: scale * (MAX_AXIS_PX / maxAxis), rotation: (rotation + viewRot) % 360 })
        : screen;
      try {
        const loader = await import('./loader.js');
        await loader.ensureAnnotationsForPage(pageNum, doc);
      } catch (e) { console.warn('[multiview] annotations for page', e); }
      if (myGen !== gen) return false;
      // Onbewerkte ingelezen markeringen uit hun eigen /AP, zoals de hoofdweergave.
      const { renderParams, ids: apIds } = await apRenderParams(page);
      if (myGen !== gen) return false;
      const ok = await renderPdfJsPageToCanvas({
        page, viewport: renderVp, canvas: pdfCanvas, dpr: dprNow(), renderParams,
        optionalContentConfigPromise: nativeOcgPdfJsConfig(doc), isCurrent: () => myGen === gen,
      });
      if (!ok || myGen !== gen) return false;
      pdfCanvas.style.width = `${Math.floor(screen.width)}px`;
      pdfCanvas.style.height = `${Math.floor(screen.height)}px`;
      pageBox.style.width = `${Math.floor(screen.width)}px`;
      pageBox.style.height = `${Math.floor(screen.height)}px`;
      current = {
        doc, pdfDoc, page: pageNum, scale, key,
        matrix: annotationToScreen(base, screen), cssW: screen.width, cssH: screen.height, apIds,
      };
      host.dataset.page = String(pageNum);
      drawAnnotations();
    }
    if (Number.isFinite(view.scrollLeft)) host.scrollLeft = view.scrollLeft;
    if (Number.isFinite(view.scrollTop)) host.scrollTop = view.scrollTop;
    onShow?.();
    return true;
  }

  function clear() {
    gen++;
    current = null;
    delete host.dataset.page;
    onShow?.();
    for (const c of [pdfCanvas, annCanvas]) {
      c.width = 0; c.height = 0; c.style.width = '0px'; c.style.height = '0px';
    }
  }

  function box() {
    return {
      scrollLeft: host.scrollLeft, scrollTop: host.scrollTop,
      clientWidth: host.clientWidth, clientHeight: host.clientHeight,
      scrollWidth: host.scrollWidth, scrollHeight: host.scrollHeight,
    };
  }

  function destroy() {
    gen++;
    if (annFrame) cancelAnimationFrame(annFrame);
    if (apHertekenen) clearTimeout(apHertekenen);
    pageBox.remove();
    current = null;
  }

  return {
    show, clear, box, destroy, scheduleAnnotations,
    get page() { return current?.page || 0; },
    get scale() { return current?.scale || 0; },
    get doc() { return current?.doc || null; },
    get pageSize() { return current ? { width: current.cssW / current.scale, height: current.cssH / current.scale } : null; },
  };
}
