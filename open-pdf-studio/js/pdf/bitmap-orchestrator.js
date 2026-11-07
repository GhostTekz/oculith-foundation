// bitmap-orchestrator.js
//
// Thin wrapper that reads viewport state and triggers async fills for the
// current view. Delegates the actual work:
//   - whole-page raster -> ensureExactBitmap() in page-bitmap-cache.js
//   - visible-region high-zoom augment -> invoke('render_pdf_page_region')
//     + tile-cache.js
//
// When a bitmap/tile arrives, we write it onto the viewport singleton and
// set viewport.dirty = true so the RAF loop in pdf-viewport.js paints it.
//
// Concurrency: each function bumps a module-private generation counter on
// entry. After every await we re-check that our generation is still current
// before mutating viewport state, so a slower in-flight request can't
// overwrite a newer one (e.g. zoom-in while a previous render is pending).

import { holdShownPage, viewport } from './pdf-viewport.js';
import {
    MAX_WHOLE_PAGE_AXIS_PX,
    computeZoomBucket,
    ensureExactBitmap,
    getBestAvailableBitmap,
    getCachedBitmapNearScale,
    wholePageRenderScale,
} from './page-bitmap-cache.js';
import { tileCacheFindCovering, tileCacheGet, tileCacheSet } from './tile-cache.js';
import { neighborTileRegion, tileCoversViewport, visiblePdfRegion } from './tile-coverage.js';
import { rectNaarPagina, viewportGeometrie } from './weergave-rotatie.js';
import { state } from '../core/state.js';
import { nativeOcgSelectionForPath } from './native-ocg-selection.js';
import { sourceRenderRevision, sourceRenderCurrent, sourceWriteActive } from './source-render-revision.js';
import {
    ensureProgressiveBitmapForCurrentView,
    isExtremePage,
    isHeavyPage,
    isRenderSuperseded,
    renderLane,
} from './progressive-render.js';
import { createInflightKeyGate } from './inflight-key-gate.js';
import { regioOpRenderRaster } from './device-pixel.js';
import {
    needsVisibleTile,
    prewarmCoveragePlan,
    prewarmTileRenderScale,
    tileCoverageRenderScale,
    tileRenderScaleForZoom,
    tileSupportsZoom,
} from './tile-render-policy.js';


// PDFium / browser canvas axis limit. Above this, we cap the whole-page
// bitmap resolution and rely on the tile augment for crispness in the
// visible region.
const MAX_BITMAP_AXIS_PX = MAX_WHOLE_PAGE_AXIS_PX;

// Tile region buffer: extend the visible region by this fraction on each
// side, and snap region origin to a grid of this step. Small pans within
// the buffer stay cache-hits.
const TILE_BUFFER_FRACTION = 0.25;

let _bitmapGen = 0;
const _tileRequests = createInflightKeyGate();
// The view tile and the neighbour prefetch share _tileRequests: a result is
// used only while its token is current, and the generation only grows, so a
// queued request on this lane with an older generation is safe to drop.
const VIEW_TILE_LANE = renderLane('view-tile');

export function cancelBitmapRendersForFile(filePath) {
    if (viewport.filePath !== filePath) return;
    ++_bitmapGen;
    _tileRequests.cancel();
    // The sheet keeps its last frame until the new render lands; nulling the
    // bitmap alone painted it white for the whole re-render.
    holdShownPage(filePath);
    viewport.currentBitmap = null;
    viewport.currentTile = null;
    viewport.currentTileMeta = null;
    viewport.dirty = true;
}

// Tegels staan in de paginaruimte (na de eigen /Rotate en de paginarotatie).
// Het scherm kan die pagina gedraaid tonen (weergave draaien, #200): wat in
// beeld is, rekenen we daarom eerst in de weergaveruimte uit en draaien het
// dan terug naar de paginaruimte.
//
// Hypothetisch zichtbaar gebied bij `zoom`, gecentreerd op het huidige midden
// van het beeld (zo blijft gecentreerd inzoomen een cache-hit).
function zichtbaarBijZoom(zoom, cssW, cssH) {
    const g = viewportGeometrie(viewport);
    const midU = (cssW / 2 - viewport.offsetX) / viewport.zoom;
    const midV = (cssH / 2 - viewport.offsetY) / viewport.zoom;
    const visW = Math.min(g.schermBreedte, cssW / zoom);
    const visH = Math.min(g.schermHoogte, cssH / zoom);
    const visU = Math.max(0, Math.min(g.schermBreedte - visW, midU - visW / 2));
    const visV = Math.max(0, Math.min(g.schermHoogte - visH, midV - visH / 2));
    const r = rectNaarPagina({ x: visU, y: visV, width: visW, height: visH }, g.paginaBreedte, g.paginaHoogte, g.rotatie);
    return { x: r.x, y: r.y, w: r.width, h: r.height };
}

// Maat van de pagina in de paginaruimte (punten).
function paginaMaatPt() {
    const g = viewportGeometrie(viewport);
    return { w: g.paginaBreedte, h: g.paginaHoogte };
}

export async function ensureBitmapForCurrentView() {
    if (sourceWriteActive(viewport.filePath)) return;
    if (!viewport.active || !viewport.filePath || viewport.pageType !== 'raster') {
        viewport.currentBitmap = null;
        viewport.dirty = true;
        return;
    }

    // Additief pad: een ZWARE raster-pagina (grote content-stream) met de voorkeur
    // aan, vullen we progressief tegel-voor-tegel in i.p.v. één trage whole-page
    // render. Niet-zware pagina's of voorkeur uit → exact het bestaande pad hieronder.
    const dpr = window.devicePixelRatio || 1;
    const targetScale = viewport.zoom * dpr;
    const maxAxisPt = Math.max(viewport.pageW, viewport.pageH);
    if (maxAxisPt <= 0) {
        viewport.currentBitmap = null;
        viewport.dirty = true;
        return;
    }
    const capScale = MAX_BITMAP_AXIS_PX / maxAxisPt;

    const filePath = viewport.filePath;
    const sourceRevision = sourceRenderRevision(filePath);
    const _prefOn = !!(state.preferences && state.preferences.progressiveRender);
    const _heavy = _prefOn ? await isHeavyPage(viewport.filePath, viewport.pageNum) : false;
    const _extreme = _heavy ? await isExtremePage(viewport.filePath, viewport.pageNum) : false;
    if (_prefOn && _heavy && (!_extreme || !needsVisibleTile(viewport.zoom, dpr, capScale))) {
        console.log(`[prog-guard] zware pagina p${viewport.pageNum} → progressief pad`);
        _bitmapGen++; // maak een eventuele in-flight gewone render stale
        return ensureProgressiveBitmapForCurrentView();
    }

    if (_prefOn && _extreme) {
        _bitmapGen++;
        const fallback = getBestAvailableBitmap(
            viewport.filePath,
            viewport.pageNum,
            viewport.rotation,
            wholePageRenderScale(capScale, maxAxisPt, MAX_BITMAP_AXIS_PX),
        );
        if (fallback) {
            viewport.currentBitmap = fallback.bitmap;
            viewport.dirty = true;
        }
        return;
    }

    const myGen = ++_bitmapGen;

    // One render per settle, at the exact zoom * dpr, clamped AFTER rounding
    // so the frame stays within the 4096 px axis cap (and the worker's
    // shared-memory slot). This function only runs once zoom/pan has been
    // still for a moment (pdf-viewport.js's _kickOrchestratorAfterZoom
    // debounce), so the old intermediate power-of-two bucket render bought
    // no responsiveness: it rendered the page twice per settle, and on a
    // dense sheet each full render costs the same at any scale.
    const renderScale = wholePageRenderScale(targetScale, maxAxisPt, MAX_BITMAP_AXIS_PX);
    const filePathNow = viewport.filePath;
    const pageNum = viewport.pageNum;
    const rotation = viewport.rotation;

    // Already rendered at (about) this scale: draw it, nothing to fetch.
    const ready = getCachedBitmapNearScale(filePathNow, pageNum, rotation, renderScale);
    if (ready && ready.bitmap) {
        viewport.currentBitmap = ready.bitmap;
        viewport.dirty = true;
        return;
    }

    // Synchronous: show the best already-cached bitmap immediately. Handles
    // the "zoom-in while async render is in flight" case — we never blank
    // out the page while we wait for the exact render.
    const fallback = getBestAvailableBitmap(filePathNow, pageNum, rotation, renderScale);
    if (fallback) {
        viewport.currentBitmap = fallback.bitmap;
        viewport.dirty = true;
    }

    // Async: fetch the exact scale. ensureExactBitmap dedups concurrent calls.
    const exactEntry = await ensureExactBitmap(filePathNow, pageNum, rotation, renderScale);
    if (myGen !== _bitmapGen || !sourceRenderCurrent(filePath, sourceRevision)) return;
    if (exactEntry && exactEntry.bitmap) {
        viewport.currentBitmap = exactEntry.bitmap;
        viewport.dirty = true;
    }
}

// Rustvenster voor de pre-warm: direct na "prog klaar" begint de gebruiker
// vaak juist te zoomen/pannen. Elke prewarm-regio kost ~0,3-1,9 s scene-CPU
// aan de Rust-kant (gemeten op MV-03); vuurt hij meteen, dan staat het échte
// interactie-werk (eerste tegel van de nieuwe run, on-demand zoomtegel) in de
// rij achter de prewarm — precies het "venster hangt nog even na het tilen"-
// gevoel. Daarom: pas starten na PREWARM_CALM_MS ononderbroken rust
// (zoom/offset/canvasmaat stabiel én geen lopende progressieve run) en
// helemaal opgeven na PREWARM_GIVEUP_MS onrust — de on-demand-render dekt
// het dan alsnog.
const PREWARM_CALM_MS = 1200;
const PREWARM_GIVEUP_MS = 10000;

/**
 * Pre-warm van zoom-tegels (300%-pre-cache voor zware pagina's): rendert vast
 * de tegel(s) die het tegel-pad zou opvragen bij gecentreerd inzoomen naar
 * ~150% en ~300%, en zet ze in de tile-cache onder exact dezelfde sleutels als
 * ensureTileForCurrentView. Gecentreerd inzoomen is daarna direct scherp
 * (cache-hit); ver pannen valt terug op de normale on-demand-render.
 * Aangeroepen door het progressieve pad ná de eerste volledige render;
 * fire-and-forget, wacht eerst op een rustvenster (zie PREWARM_CALM_MS) en
 * stopt stil bij tab-/paginawissel of hervatte gebruikersinteractie.
 */
export async function prewarmZoomTiles(filePath, pageNum) {
    if (sourceWriteActive(filePath)) return;
    const canvas = document.getElementById('pdf-canvas');
    if (!canvas || !viewport.active || viewport.filePath !== filePath || viewport.pageNum !== pageNum) return;
    const selection = nativeOcgSelectionForPath(filePath);
    const sourceRevision = sourceRenderRevision(filePath);
    const selectionCurrent = () => sourceRenderCurrent(filePath, sourceRevision)
        && nativeOcgSelectionForPath(filePath).revision === selection.revision;

    // View-handtekening: wijzigt zodra de gebruiker zoomt/pant of het venster
    // van maat verandert — de goedkoopste betrouwbare "interactie"-detector
    // op deze plek (geen extra event-listeners nodig).
    const viewSig = () =>
        `${viewport.zoom.toFixed(4)}|${Math.round(viewport.offsetX)}|${Math.round(viewport.offsetY)}|${canvas.width}x${canvas.height}`;
    const { progressiveRunActive } = await import('./progressive-render.js');

    const tWait0 = performance.now();
    let sig = viewSig();
    let calmSince = tWait0;
    for (;;) {
        await new Promise((r) => setTimeout(r, 200));
        if (!viewport.active || viewport.filePath !== filePath || viewport.pageNum !== pageNum) return;
        if (!selectionCurrent()) return;
        const s = viewSig();
        if (s !== sig || progressiveRunActive()) {
            sig = s;
            calmSince = performance.now();
        }
        if (performance.now() - calmSince >= PREWARM_CALM_MS) break;
        if (performance.now() - tWait0 > PREWARM_GIVEUP_MS) return; // druk gebleven — overslaan
    }

    const dpr = window.devicePixelRatio || 1;
    const cssW = canvas.width / dpr;
    const cssH = canvas.height / dpr;
    const maxAxisPt = Math.max(viewport.pageW, viewport.pageH);
    if (maxAxisPt <= 0 || cssW < 1 || cssH < 1) return;
    const capScale = MAX_BITMAP_AXIS_PX / maxAxisPt;

    // Gecentreerd zoomen houdt het midden van het beeld in beeld; daaromheen
    // ligt de toekomstige zichtregio (zie zichtbaarBijZoom).
    const pag = paginaMaatPt();

    // Eén brede 150%-regio op 300%-resolutie dekt alle tussenliggende
    // zoomstanden in beide richtingen. Gebruik deze route zolang de bitmap
    // binnen de bestaande aslimiet past. De tweeregio-route hieronder blijft
    // de terugval voor bredere schermen totdat de vaste tegelmatrix gereed is.
    const coveragePlan = prewarmCoveragePlan({
        zooms: [1.5, 2, 3],
        devicePixelRatio: dpr,
    });
    if (coveragePlan && needsVisibleTile(coveragePlan.supportZoom, dpr, capScale)) {
        const zoom = coveragePlan.regionZoom;
        const vis = zichtbaarBijZoom(zoom, cssW, cssH);
        const bufW = vis.w * TILE_BUFFER_FRACTION;
        const bufH = vis.h * TILE_BUFFER_FRACTION;
        const region = {
            x: Math.max(0, vis.x - bufW),
            y: Math.max(0, vis.y - bufH),
            w: Math.min(pag.w, vis.w + 2 * bufW),
            h: Math.min(pag.h, vis.h + 2 * bufH),
        };
        const renderScale = coveragePlan.renderScale;
        const outputW = Math.ceil(region.w * renderScale);
        const outputH = Math.ceil(region.h * renderScale);

        if (outputW <= MAX_BITMAP_AXIS_PX && outputH <= MAX_BITMAP_AXIS_PX) {
            const zoomBucket = computeZoomBucket(renderScale);
            const stepX = pag.w * TILE_BUFFER_FRACTION;
            const stepY = pag.h * TILE_BUFFER_FRACTION;
            const regionBucket = `${Math.round(Math.floor(region.x / stepX) * stepX * 100)},${Math.round(Math.floor(region.y / stepY) * stepY * 100)}`;
            const covering = tileCacheFindCovering(filePath, pageNum, viewport.rotation, {
                regionXpt: region.x,
                regionYpt: region.y,
                regionWpt: region.w,
                regionHpt: region.h,
                requiredScale: renderScale,
            });
            if (covering) return;

            try {
                const { invokeTileRegion, perfMark } = await import('./progressive-render.js');
                const started = performance.now();
                const raw = await invokeTileRegion({
                    path: filePath,
                    pageIndex: pageNum - 1,
                    scale: renderScale,
                    rotation: viewport.rotation || 0,
                    regionXPt: region.x,
                    regionYPt: region.y,
                    regionWPt: region.w,
                    regionHPt: region.h,
                    ocgVisibility: selection.ocgVisibility,
                });
                if (!selectionCurrent()) return;
                if (!viewport.active || viewport.filePath !== filePath || viewport.pageNum !== pageNum) return;
                const bytes = raw instanceof Uint8Array ? raw : new Uint8Array(raw);
                perfMark(`prewarm-coverage-invoke z=${zoom}-${coveragePlan.supportZoom} ${Math.round(performance.now() - started)}ms (${(bytes.length / 1048576).toFixed(1)}MB)`);
                if (bytes?.length > 8) {
                    const dv = new DataView(bytes.buffer, bytes.byteOffset, 8);
                    const w = dv.getUint32(0, true);
                    const h = dv.getUint32(4, true);
                    if (w * h * 4 === bytes.length - 8) {
                        const cacheStarted = performance.now();
                        const imageData = new ImageData(
                            new Uint8ClampedArray(bytes.buffer, bytes.byteOffset + 8, w * h * 4),
                            w,
                            h,
                        );
                        await tileCacheSet(filePath, pageNum, zoomBucket, viewport.rotation, regionBucket, imageData, {
                            regionXpt: region.x,
                            regionYpt: region.y,
                            regionWpt: region.w,
                            regionHpt: region.h,
                            zoom,
                            renderScale,
                        }, sourceRevision);
                        perfMark(`prewarm-coverage-cacheSet ${w}x${h} ${Math.round(performance.now() - cacheStarted)}ms`);
                        console.log(`[tile-orch] prewarm coverage z=${zoom}-${coveragePlan.supportZoom} bucket=${zoomBucket} reg=${regionBucket} (${w}x${h})`);
                        return;
                    }
                }
            } catch (e) {
                console.warn('[tile-orch] prewarm coverage faalde:', e);
            }
        }
    }

    // 1.5 en 3.0 landen (met dpr ~1.25) in zoom-buckets 2 en 4 — dat dekt
    // inzoomen tot ruim 300%.
    for (const zoom of [1.5, 3.0]) {
        if (!selectionCurrent()) return;
        if (!needsVisibleTile(zoom, dpr, capScale)) continue;
        if (!viewport.active || viewport.filePath !== filePath || viewport.pageNum !== pageNum) return;
        // Gebruiker weer bezig (view gewijzigd of nieuwe progressieve run)?
        // Dan direct stoppen — de interactie-render heeft voorrang op de
        // speculatieve pre-warm.
        if (viewSig() !== sig || progressiveRunActive()) return;

        // Zelfde formule als ensureTileForCurrentView, met hypothetische zoom.
        const vis = zichtbaarBijZoom(zoom, cssW, cssH);
        const bufW = vis.w * TILE_BUFFER_FRACTION;
        const bufH = vis.h * TILE_BUFFER_FRACTION;
        const region = {
            x: Math.max(0, vis.x - bufW),
            y: Math.max(0, vis.y - bufH),
            w: Math.min(pag.w, vis.w + 2 * bufW),
            h: Math.min(pag.h, vis.h + 2 * bufH),
        };
        const stepX = pag.w * TILE_BUFFER_FRACTION;
        const stepY = pag.h * TILE_BUFFER_FRACTION;
        const regionBucket = `${Math.round(Math.floor(region.x / stepX) * stepX * 100)},${Math.round(Math.floor(region.y / stepY) * stepY * 100)}`;
        const zoomBucket = computeZoomBucket(zoom * dpr);
        const cached = tileCacheGet(filePath, pageNum, zoomBucket, viewport.rotation, regionBucket);
        if (cached && tileSupportsZoom(cached.regionMeta?.renderScale, zoom, dpr)) continue;

        // The 150% and 200% views often share one power-of-two bucket. Render
        // the wider 150%-region once at enough density for 200%, but only when
        // both zoom levels actually belong to the same bucket at this DPR.
        const supportZoom = zoom === 1.5 ? 2 : zoom;
        const renderScale = prewarmTileRenderScale({
            regionZoom: zoom,
            supportZoom,
            devicePixelRatio: dpr,
            zoomBucket,
        });
        Object.assign(region, regioOpRenderRaster(region, renderScale, pag.w, pag.h));

        try {
            const { invokeTileRegion, perfMark } = await import('./progressive-render.js');
            const _pw0 = performance.now();
            const raw = await invokeTileRegion({
                path: filePath,
                pageIndex: pageNum - 1,
                scale: renderScale,
                rotation: viewport.rotation || 0,
                regionXPt: region.x,
                regionYPt: region.y,
                regionWPt: region.w,
                regionHPt: region.h,
                ocgVisibility: selection.ocgVisibility,
            });
            if (!selectionCurrent()) return;
            if (!viewport.active || viewport.filePath !== filePath || viewport.pageNum !== pageNum) return;
            const bytes = raw instanceof Uint8Array ? raw : new Uint8Array(raw);
            perfMark(`prewarm-invoke z=${zoom} ${Math.round(performance.now() - _pw0)}ms (${(bytes.length / 1048576).toFixed(1)}MB)`);
            if (!bytes || bytes.length <= 8) continue;
            const dv = new DataView(bytes.buffer, bytes.byteOffset, 8);
            const w = dv.getUint32(0, true);
            const h = dv.getUint32(4, true);
            if (w * h * 4 !== bytes.length - 8) continue;
            const _pw1 = performance.now();
            const imageData = new ImageData(new Uint8ClampedArray(bytes.buffer, bytes.byteOffset + 8, w * h * 4), w, h);
            await tileCacheSet(filePath, pageNum, zoomBucket, viewport.rotation, regionBucket, imageData, {
                regionXpt: region.x,
                regionYpt: region.y,
                regionWpt: region.w,
                regionHpt: region.h,
                zoom,
                renderScale,
            }, sourceRevision);
            perfMark(`prewarm-cacheSet z=${zoom} ${w}x${h} ${Math.round(performance.now() - _pw1)}ms`);
            console.log(`[tile-orch] prewarm z=${zoom} bucket=${zoomBucket} reg=${regionBucket} (${w}x${h})`);
        } catch (e) {
            console.warn('[tile-orch] prewarm faalde:', e);
            return;
        }
    }
}

export async function ensureTileForCurrentView(canvas, opties = {}) {
    // Beweging mag een lopende regiorender niet afbreken of verdubbelen.
    // begin() laat de vorige key vallen, dus een render op elk wieltik
    // komt nooit af. Na afloop opnieuw vragen als het zicht dan nog open ligt.
    const motion = opties?.motion === true;
    if (motion && _tileRequests.busy()) return;
    if (sourceWriteActive(viewport.filePath)) return;
    if (!viewport.active || !viewport.filePath || viewport.pageType !== 'raster' || !canvas) {
        _tileRequests.cancel();
        viewport.currentTile = null;
        viewport.currentTileMeta = null;
        return;
    }
    const maxAxisPt = Math.max(viewport.pageW, viewport.pageH);
    if (maxAxisPt <= 0) return;
    const capScale = MAX_BITMAP_AXIS_PX / maxAxisPt;
    const dpr = window.devicePixelRatio || 1;
    if (!needsVisibleTile(viewport.zoom, dpr, capScale)) {
        _tileRequests.cancel();
        // Whole-page bitmap is sufficient; clear any stale tile so the
        // renderer doesn't draw a low-zoom tile on top of a fresh raster.
        viewport.currentTile = null;
        viewport.currentTileMeta = null;
        return;
    }

    const cssW = canvas.width / dpr;
    const cssH = canvas.height / dpr;

    const visRegion = visiblePdfRegion(viewport, cssW, cssH);
    if (visRegion.w * viewport.zoom < 1 || visRegion.h * viewport.zoom < 1) {
        viewport.currentTile = null;
        viewport.currentTileMeta = null;
        return;
    }

    // Houd een al zichtbare scherpe tegel vast. De algemene cache-selector
    // kiest terecht de minst oversamplede kandidaat, maar tijdens herhaald
    // zoomen zou dat een brede 300%-coverage bij 150% vervangen door een
    // smallere tegel die de volgende zoomstap niet meer aankan.
    if (
        viewport.currentTile
        && tileCoversViewport(viewport.currentTileMeta, viewport, cssW, cssH, dpr)
    ) {
        _tileRequests.cancel();
        viewport.dirty = true;
        return;
    }

    // Add buffer for pan-within-buffer cache hits. Alles in de paginaruimte
    // (visiblePdfRegion draait een weergaverotatie al terug).
    const pag = paginaMaatPt();
    const bufW = visRegion.w * TILE_BUFFER_FRACTION;
    const bufH = visRegion.h * TILE_BUFFER_FRACTION;
    const bufferedRegion = {
        x: Math.max(0, visRegion.x - bufW),
        y: Math.max(0, visRegion.y - bufH),
        w: Math.min(pag.w, visRegion.w + 2 * bufW),
        h: Math.min(pag.h, visRegion.h + 2 * bufH),
    };

    // Snap region origin to buffer-step grid for cache stability across pans.
    const stepX = pag.w * TILE_BUFFER_FRACTION;
    const stepY = pag.h * TILE_BUFFER_FRACTION;
    const snappedX = Math.floor(bufferedRegion.x / stepX) * stepX;
    const snappedY = Math.floor(bufferedRegion.y / stepY) * stepY;
    const regionBucket = `${Math.round(snappedX * 100)},${Math.round(snappedY * 100)}`;

    const zoomBucket = computeZoomBucket(viewport.zoom * dpr);
    const filePath = viewport.filePath;
    const sourceRevision = sourceRenderRevision(filePath);
    const pageNum = viewport.pageNum;
    const rotation = viewport.rotation || 0;
    const requestedZoom = viewport.zoom;
    const selection = nativeOcgSelectionForPath(filePath);
    const requestKey = `${filePath}|${pageNum}|${zoomBucket}|${rotation}|${regionBucket}|${selection.revision}|${sourceRevision}`;

    // GIS-style tile-cover lookup: zoom buckets describe how a tile was
    // produced, not where it may be reused. A tile from another zoom level is
    // immediately valid when it covers the complete visible PDF region and
    // has enough physical pixels for the current screen.
    const covering = tileCacheFindCovering(filePath, pageNum, rotation, {
        regionXpt: visRegion.x,
        regionYpt: visRegion.y,
        regionWpt: visRegion.w,
        regionHpt: visRegion.h,
        requiredScale: requestedZoom * dpr,
    });
    if (covering?.bitmap) {
        _tileRequests.cancel();
        viewport.currentTile = covering.bitmap;
        viewport.currentTileMeta = covering.regionMeta;
        viewport.dirty = true;
        return;
    }

    // Cache hit?
    const hit = tileCacheGet(filePath, pageNum, zoomBucket, rotation, regionBucket);
    if (hit && tileSupportsZoom(hit.regionMeta?.renderScale, requestedZoom, dpr)) {
        // De bucketsleutel is een grof paginaraster, geen bewijs dat de tegel
        // het zicht dekt. Tijdens bewegen zo'n treffer niet hergebruiken:
        // anders start er geen scherpe render voor het openliggende stuk.
        const hitDekt = tileCoversViewport(hit.regionMeta, viewport, cssW, cssH, dpr);
        if (hitDekt || !motion) {
            _tileRequests.cancel();
            viewport.currentTile = hit.bitmap;
            viewport.currentTileMeta = hit.regionMeta;
            viewport.dirty = true;
            return;
        }
    }

    // Cache miss: async Rust render of the region at the requested zoom.
    const requestToken = _tileRequests.begin(requestKey);
    if (!requestToken) return;
    let geplaatst = false;
    try {
        const { invokeTileRegion } = await import('./progressive-render.js');
        const renderScale = tileCoverageRenderScale({
            zoom: requestedZoom,
            devicePixelRatio: dpr,
            regionWpt: bufferedRegion.w,
            regionHpt: bufferedRegion.h,
            maxBitmapAxisPx: MAX_BITMAP_AXIS_PX,
        });
        // Start and end the region on the tile's own pixel grid: with a
        // device-pixel view offset (pdf-viewport.js) the tile then lands on
        // whole device pixels instead of being resampled by a fraction.
        Object.assign(bufferedRegion, regioOpRenderRaster(bufferedRegion, renderScale, pag.w, pag.h));
        const rgbaData = await invokeTileRegion({
            path: filePath,
            pageIndex: pageNum - 1,
            scale: renderScale,
            rotation,
            regionXPt: bufferedRegion.x,
            regionYPt: bufferedRegion.y,
            regionWPt: bufferedRegion.w,
            regionHPt: bufferedRegion.h,
            ocgVisibility: selection.ocgVisibility,
            renderLane: VIEW_TILE_LANE,
            renderGeneration: requestToken.generation,
        });
        if (!_tileRequests.isCurrent(requestToken) || !sourceRenderCurrent(filePath, sourceRevision)) return;
        const bytes = rgbaData instanceof Uint8Array ? rgbaData : new Uint8Array(rgbaData);
        if (!bytes || bytes.length <= 8) return;
        const view = new DataView(bytes.buffer, bytes.byteOffset, 8);
        const w = view.getUint32(0, true);
        const h = view.getUint32(4, true);
        if (w * h * 4 !== bytes.length - 8) {
            console.warn('[tile-orch] size mismatch', w, h, bytes.length - 8);
            return;
        }
        const rgba = new Uint8ClampedArray(bytes.buffer, bytes.byteOffset + 8, bytes.length - 8);
        const imageData = new ImageData(rgba, w, h);
        const regionMeta = {
            regionXpt: bufferedRegion.x,
            regionYpt: bufferedRegion.y,
            regionWpt: bufferedRegion.w,
            regionHpt: bufferedRegion.h,
            zoom: requestedZoom,
            renderScale,
        };
        await tileCacheSet(filePath, pageNum, zoomBucket, rotation, regionBucket, imageData, regionMeta, sourceRevision);
        if (!_tileRequests.isCurrent(requestToken) || !sourceRenderCurrent(filePath, sourceRevision)) return;
        const cached = tileCacheGet(filePath, pageNum, zoomBucket, rotation, regionBucket);
        if (cached && cached.bitmap) {
            viewport.currentTile = cached.bitmap;
            viewport.currentTileMeta = cached.regionMeta;
            viewport.dirty = true;
            geplaatst = true;
            console.log(`[tile-orch] cached p${pageNum} @ z=${requestedZoom.toFixed(2)} reg=${regionBucket}`);
        }
    } catch (e) {
        if (!isRenderSuperseded(e)) console.warn('[tile-orch] render failed:', e);
    } finally {
        const afgerond = _tileRequests.finish(requestToken);
        if (afgerond && geplaatst && canvas) {
            const dprNu = window.devicePixelRatio || 1;
            const cssNuW = canvas.width / dprNu;
            const cssNuH = canvas.height / dprNu;
            if (cssNuW >= 1 && cssNuH >= 1
                && !tileCoversViewport(viewport.currentTileMeta, viewport, cssNuW, cssNuH, dprNu)) {
                void ensureTileForCurrentView(canvas, { motion: true });
            }
        }
    }
}

// De tegel dekt het zicht nog. Haal de volgende alvast in de tegelcache,
// zonder currentTile te vervangen en zonder een lopende weergave-render af
// te breken. Pas als het zicht de huidige tegel verlaat, vraagt `finally`
// alsnog de tegel van dat zicht.
export async function prefetchNeighborWhileCovered(canvas) {
    if (_tileRequests.busy()) return;
    if (sourceWriteActive(viewport.filePath)) return;
    if (!viewport.active || !viewport.filePath || viewport.pageType !== 'raster' || !canvas) return;
    const maxAxisPt = Math.max(viewport.pageW, viewport.pageH);
    if (maxAxisPt <= 0) return;
    const capScale = MAX_BITMAP_AXIS_PX / maxAxisPt;
    const dpr = window.devicePixelRatio || 1;
    if (!needsVisibleTile(viewport.zoom, dpr, capScale)) return;

    const cssW = canvas.width / dpr;
    const cssH = canvas.height / dpr;
    if (cssW < 1 || cssH < 1) return;
    const visRegion = visiblePdfRegion(viewport, cssW, cssH);
    if (visRegion.w * viewport.zoom < 1 || visRegion.h * viewport.zoom < 1) return;

    const covered = viewport.currentTile
        && tileCoversViewport(viewport.currentTileMeta, viewport, cssW, cssH, dpr);
    if (!covered) {
        return ensureTileForCurrentView(canvas, { motion: true });
    }

    const tile = viewport.currentTileMeta;
    const pag = paginaMaatPt();
    const neighbor = neighborTileRegion(
        { x: tile.regionXpt, y: tile.regionYpt, w: tile.regionWpt, h: tile.regionHpt },
        visRegion,
        pag,
    );
    if (!neighbor) return;

    const filePath = viewport.filePath;
    const sourceRevision = sourceRenderRevision(filePath);
    const pageNum = viewport.pageNum;
    const rotation = viewport.rotation || 0;
    const requestedZoom = viewport.zoom;
    const already = tileCacheFindCovering(filePath, pageNum, rotation, {
        regionXpt: neighbor.x,
        regionYpt: neighbor.y,
        regionWpt: neighbor.w,
        regionHpt: neighbor.h,
        requiredScale: requestedZoom * dpr,
    });
    if (already?.bitmap) return;

    const zoomBucket = computeZoomBucket(requestedZoom * dpr);
    const selection = nativeOcgSelectionForPath(filePath);
    const regionBucket = `pf:${Math.round(neighbor.x * 100)},${Math.round(neighbor.y * 100)},${Math.round(neighbor.w * 100)},${Math.round(neighbor.h * 100)}`;
    const requestKey = `prefetch|${filePath}|${pageNum}|${zoomBucket}|${rotation}|${regionBucket}|${selection.revision}|${sourceRevision}`;
    const requestToken = _tileRequests.begin(requestKey);
    if (!requestToken) return;
    try {
        const { invokeTileRegion } = await import('./progressive-render.js');
        const renderScale = tileCoverageRenderScale({
            zoom: requestedZoom,
            devicePixelRatio: dpr,
            regionWpt: neighbor.w,
            regionHpt: neighbor.h,
            maxBitmapAxisPx: MAX_BITMAP_AXIS_PX,
        });
        const region = regioOpRenderRaster(
            { x: neighbor.x, y: neighbor.y, w: neighbor.w, h: neighbor.h },
            renderScale,
            pag.w,
            pag.h,
        );
        if (Math.abs(region.x - tile.regionXpt) < 0.5 && Math.abs(region.y - tile.regionYpt) < 0.5) return;
        const rgbaData = await invokeTileRegion({
            path: filePath,
            pageIndex: pageNum - 1,
            scale: renderScale,
            rotation,
            regionXPt: region.x,
            regionYPt: region.y,
            regionWPt: region.w,
            regionHPt: region.h,
            ocgVisibility: selection.ocgVisibility,
            renderLane: VIEW_TILE_LANE,
            renderGeneration: requestToken.generation,
        });
        if (!_tileRequests.isCurrent(requestToken) || !sourceRenderCurrent(filePath, sourceRevision)) return;
        const bytes = rgbaData instanceof Uint8Array ? rgbaData : new Uint8Array(rgbaData);
        if (!bytes || bytes.length <= 8) return;
        const view = new DataView(bytes.buffer, bytes.byteOffset, 8);
        const w = view.getUint32(0, true);
        const h = view.getUint32(4, true);
        if (w * h * 4 !== bytes.length - 8) {
            console.warn('[tile-orch] prefetch size mismatch', w, h, bytes.length - 8);
            return;
        }
        const rgba = new Uint8ClampedArray(bytes.buffer, bytes.byteOffset + 8, bytes.length - 8);
        const imageData = new ImageData(rgba, w, h);
        const regionMeta = {
            regionXpt: region.x,
            regionYpt: region.y,
            regionWpt: region.w,
            regionHpt: region.h,
            zoom: requestedZoom,
            renderScale,
        };
        await tileCacheSet(filePath, pageNum, zoomBucket, rotation, regionBucket, imageData, regionMeta, sourceRevision);
    } catch (e) {
        if (!isRenderSuperseded(e)) console.warn('[tile-orch] prefetch faalde:', e);
    } finally {
        const afgerond = _tileRequests.finish(requestToken);
        if (!afgerond || !canvas) return;
        const dprNu = window.devicePixelRatio || 1;
        const cssNuW = canvas.width / dprNu;
        const cssNuH = canvas.height / dprNu;
        if (cssNuW >= 1 && cssNuH >= 1
            && !tileCoversViewport(viewport.currentTileMeta, viewport, cssNuW, cssNuH, dprNu)) {
            void ensureTileForCurrentView(canvas, { motion: true });
        }
    }
}
