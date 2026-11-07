//! PDFium rendering integration for Open PDF Studio.
//!
//! Wraps the `pdfium-render` crate with the bindings we need for
//! `render_pdf_page` and `render_thumbnail` Tauri commands. Owns a
//! single static `Pdfium` instance for the lifetime of the app.
//!
//! Thread-safety: the `thread_safe` feature of `pdfium-render` wraps every
//! call in an internal mutex, so multiple Tauri command threads can
//! invoke PDFium concurrently — they just serialise inside PDFium.

use std::path::Path;
use std::sync::OnceLock;
use pdfium_render::prelude::*;
use ocg_render_copy::LayerVisibility;

/// Global PDFium instance. Initialised once at app start by
/// `init_pdfium`. Subsequent calls to `pdfium()` are zero-cost lookups.
static PDFIUM: OnceLock<Pdfium> = OnceLock::new();

/// Initialise the PDFium runtime by dynamically loading the DLL at the
/// given directory. Call this exactly once during app startup, before
/// any Tauri command runs.
///
/// On failure (DLL missing / corrupt / wrong arch) this returns an
/// error containing the underlying message — the caller should treat
/// this as fatal because no PDF rendering is possible without PDFium.
pub fn init_pdfium(dll_dir: &Path) -> Result<(), String> {
    let _guard = inproc_guard();
    if PDFIUM.get().is_some() {
        return Ok(()); // Already initialised — idempotent.
    }

    let bindings = Pdfium::bind_to_library(
        Pdfium::pdfium_platform_library_name_at_path(dll_dir),
    )
    .map_err(|e| format!("Failed to load PDFium DLL from {:?}: {}", dll_dir, e))?;

    let pdfium = Pdfium::new(bindings);

    PDFIUM
        .set(pdfium)
        .map_err(|_| "PDFium was concurrently initialised".to_string())?;

    Ok(())
}

/// Access the global PDFium instance. Panics if `init_pdfium` was
/// never called or failed — callers should rely on app-start order to
/// guarantee initialisation.
pub fn pdfium() -> &'static Pdfium {
    PDFIUM
        .get()
        .expect("PDFium not initialised. Call init_pdfium() during app startup.")
}

use std::collections::HashMap;
use std::sync::{Arc, Mutex};

/// Serialises ALL in-proc PDFium FFI work — document loading and page / region /
/// thumbnail rendering — onto a single global lock.
///
/// The wrapper's `thread_safe` feature provides Send/Sync, not sufficient
/// serialization (upstream #262). We serialize complete operations, including
/// document destruction and initialization. Worker processes have separate C
/// state and process requests sequentially.
///
/// The guard is only ever held across synchronous FFI work — never across an
/// `.await` — so it cannot stall or deadlock the async runtime. Callers that
/// compose (e.g. `render_thumbnail_to_json` → `render_page_to_rgba`) must lock
/// at exactly one level to avoid re-entrant self-deadlock; see those functions.
static PDFIUM_INPROC_LOCK: Mutex<()> = Mutex::new(());

/// Acquire the in-proc PDFium lock, recovering from a poisoned mutex (a prior
/// panic mid-render) rather than permanently disabling all rendering.
///
/// `pub(crate)`: the CAD export (`cad_export.rs`) reads page objects through
/// the same PDFium library and must hold this lock while it does.
pub(crate) fn inproc_guard() -> std::sync::MutexGuard<'static, ()> {
    PDFIUM_INPROC_LOCK.lock().unwrap_or_else(|p| p.into_inner())
}

/// Wrapper around a loaded PDFium document. Holds the parsed byte buffer
/// alive for the document's lifetime via `Arc<Vec<u8>>`, and the raw
/// `PdfDocument<'static>` (lifetime extended unsafely via the static
/// PDFIUM ref). We never let the bytes outlive the wrapper, so this is
/// sound.
pub struct PdfiumDocumentHandle {
    // Order matters: `_bytes` must outlive `document`.
    document: Option<PdfDocument<'static>>,
    _bytes: Arc<Vec<u8>>,
}

impl PdfiumDocumentHandle {
    /// Construct a handle from raw PDF bytes. Returns Err on parse failure
    /// (corrupt PDF / unsupported encryption / etc).
    pub fn load_from_bytes(bytes: Arc<Vec<u8>>) -> Result<Self, String> {
        // Guard against an uninitialised PDFium (init_pdfium is now non-fatal,
        // so the library may be absent on a misbuilt bundle) — return an error
        // instead of letting pdfium() panic on the first render.
        if PDFIUM.get().is_none() {
            return Err("PDFium is not available — rendering is disabled on this build.".into());
        }
        // Safety: the document borrows from `bytes` and from `PDFIUM`. Both
        // live for 'static: `_bytes` is kept alive in the same struct, and
        // PDFIUM is a OnceLock<Pdfium> that is never dropped.
        let bytes_ref: &'static [u8] = unsafe {
            std::slice::from_raw_parts(bytes.as_ptr(), bytes.len())
        };

        let document = {
            // Loading is an in-proc PDFium FFI call: serialise it against all
            // rendering so opening a document can't race an in-flight render.
            let _guard = inproc_guard();
            pdfium()
                .load_pdf_from_byte_slice(bytes_ref, None)
                .map_err(|e| format!("Failed to load PDF via PDFium: {}", e))?
        };

        Ok(Self {
            document: Some(document),
            _bytes: bytes,
        })
    }

    pub fn document(&self) -> &PdfDocument<'static> {
        self.document.as_ref().expect("live PDFium document")
    }
}

impl Drop for PdfiumDocumentHandle {
    fn drop(&mut self) {
        // FPDF_CloseDocument is FFI too; the backing bytes must still be alive.
        let _guard = inproc_guard();
        drop(self.document.take());
    }
}

/// Document-handle cache. Tauri state. Keyed by full file path. Bounded by
/// count (LRU): every open document holds PDFium parse state in this process.
pub struct PdfiumDocCache(pub Mutex<DocMap<PdfiumDocumentHandle>>);

pub type DocMap<T> = crate::byte_lru::ByteLru<String, Arc<T>>;
const PDFIUM_DOC_CACHE_MAX_DOCS: usize = 6;

pub fn new_doc_map<T>() -> DocMap<T> {
    crate::byte_lru::ByteLru::new(PDFIUM_DOC_CACHE_MAX_DOCS, usize::MAX)
}

impl Default for PdfiumDocCache {
    fn default() -> Self {
        Self(Mutex::new(new_doc_map()))
    }
}

/// Insert a document, and close what the bound evicted off this thread:
/// closing a PDFium document waits for the global FFI lock.
fn insert_doc<T: Send + Sync + 'static>(map: &mut DocMap<T>, path: &str, handle: Arc<T>) {
    let evicted = map.insert(path.to_string(), handle, 0);
    if !evicted.is_empty() {
        std::thread::spawn(move || drop(evicted));
    }
}

/// Get an Arc-wrapped PdfiumDocumentHandle for `path`. Reads bytes from
/// disk on cache miss. For the production hot path where bytes are already
/// cached, prefer `get_or_load_pdfium_doc_with_bytes`.
pub fn get_or_load_pdfium_doc(
    path: &str,
    cache: &PdfiumDocCache,
) -> Result<Arc<PdfiumDocumentHandle>, String> {
    {
        let mut map = cache.0.lock().map_err(|e| format!("Pdfium doc cache lock: {}", e))?;
        if let Some(h) = map.get(path) {
            return Ok(h.clone());
        }
    }

    let bytes = std::fs::read(path).map_err(|e| format!("Read {}: {}", path, e))?;
    let arc_bytes = Arc::new(bytes);
    let handle = Arc::new(PdfiumDocumentHandle::load_from_bytes(arc_bytes)?);

    let mut map = cache.0.lock().map_err(|e| format!("Pdfium doc cache lock: {}", e))?;
    // Double-check after parse to avoid race-double-load.
    if let Some(existing) = map.get(path) {
        return Ok(existing.clone());
    }
    insert_doc(&mut map, path, handle.clone());
    Ok(handle)
}

/// Same as above but bytes are supplied directly. Used by Tauri commands
/// that already cache bytes via PdfBytesCache.
pub fn get_or_load_pdfium_doc_with_bytes(
    path: &str,
    bytes: Arc<Vec<u8>>,
    cache: &PdfiumDocCache,
) -> Result<Arc<PdfiumDocumentHandle>, String> {
    {
        let mut map = cache.0.lock().map_err(|e| format!("Pdfium doc cache lock: {}", e))?;
        if let Some(h) = map.get(path) {
            return Ok(h.clone());
        }
    }

    let handle = Arc::new(PdfiumDocumentHandle::load_from_bytes(bytes)?);

    let mut map = cache.0.lock().map_err(|e| format!("Pdfium doc cache lock: {}", e))?;
    if let Some(existing) = map.get(path) {
        return Ok(existing.clone());
    }
    insert_doc(&mut map, path, handle.clone());
    Ok(handle)
}

/// A document loaded from bytes captured before invalidation must not enter
/// the app's path-keyed document cache afterward. Isolated callers with their
/// own short-lived caches can keep using `get_or_load_pdfium_doc_with_bytes`.
pub fn get_or_load_pdfium_doc_for_render(
    path: &str,
    bytes: Arc<Vec<u8>>,
    cache: &PdfiumDocCache,
    pixmap_cache: &PixmapCacheState,
    generation: Option<u64>,
) -> Result<Arc<PdfiumDocumentHandle>, String> {
    get_or_load_at_generation(path, &cache.0, pixmap_cache, generation, || {
        PdfiumDocumentHandle::load_from_bytes(bytes).map(Arc::new)
    })
}

fn get_or_load_at_generation<T, F>(
    path: &str,
    cache: &Mutex<DocMap<T>>,
    pixmap_cache: &PixmapCacheState,
    generation: Option<u64>,
    load: F,
) -> Result<Arc<T>, String>
where
    T: Send + Sync + 'static,
    F: FnOnce() -> Result<Arc<T>, String>,
{
    let Some(generation) = generation else {
        return load();
    };
    // The pixmap lock also protects this document-cache lookup. Invalidation
    // acquires the locks in the same order and evicts both caches atomically.
    {
        let guard = pixmap_cache.0.lock().map_err(|e| format!("Pixmap cache lock: {}", e))?;
        if guard.as_ref().is_some_and(|c| c.is_current(path, generation)) {
            let mut map = cache.lock().map_err(|e| format!("Pdfium doc cache lock: {}", e))?;
            if let Some(handle) = map.get(path) {
                return Ok(handle.clone());
            }
        }
    }

    let handle = load()?;
    let guard = pixmap_cache.0.lock().map_err(|e| format!("Pixmap cache lock: {}", e))?;
    if guard.as_ref().is_some_and(|c| c.is_current(path, generation)) {
        let mut map = cache.lock().map_err(|e| format!("Pdfium doc cache lock: {}", e))?;
        if let Some(existing) = map.get(path) {
            return Ok(existing.clone());
        }
        insert_doc(&mut map, path, handle.clone());
    }
    Ok(handle)
}

/// Page size in PDF points (width, height) as rendered, i.e. with the page's
/// /Rotate applied: the same shape `render_page_to_rgba` produces, without
/// rendering anything. Printing uses it to pick the paper orientation before
/// the printer DC exists.
pub fn page_size_pt(doc: &PdfDocument<'static>, page_index: u32) -> Result<(f32, f32), String> {
    // Same locking rule as render_page_to_rgba: the guard outlives `page`.
    let _guard = inproc_guard();
    let pages = doc.pages();
    let page = pages
        .get(page_index as i32)
        .map_err(|e| format!("Page {} not found: {}", page_index, e))?;
    Ok((page.width().value, page.height().value))
}

/// Render a single page to RGBA pixel bytes at the requested scale and
/// rotation. Returns (width, height, rgba) where rgba length is
/// width * height * 4.
///
/// `scale = 1.0` produces 1 PDF point = 1 pixel. The caller is
/// responsible for any DPR adjustment.
///
/// `rotation` is in degrees, must be one of 0, 90, 180, 270.
///
/// /AP annotation streams are rendered (FPDF_ANNOT flag on) so sticky
/// notes from Acrobat etc. appear, matching Chrome/Edge behaviour.
pub fn render_page_to_rgba(
    doc: &PdfDocument<'static>,
    page_index: u32,
    scale: f32,
    rotation: i32,
) -> Result<(u32, u32, Vec<u8>), String> {
    render_page_to_rgba_with_annotations(doc, page_index, scale, rotation, None)
}

/// As [`render_page_to_rgba`], plus the annotations named in
/// `annot_appearance` (by /NM or /Annots position) rastered from their own
/// appearance (/AP).
/// `None` = no annotations, exactly like `render_page_to_rgba`.
pub fn render_page_to_rgba_with_annotations(
    doc: &PdfDocument<'static>,
    page_index: u32,
    scale: f32,
    rotation: i32,
    annot_appearance: Option<&AnnotShow>,
) -> Result<(u32, u32, Vec<u8>), String> {
    // Serialise all in-proc PDFium work (see PDFIUM_INPROC_LOCK). Declared
    // first so the guard outlives `pages`/`page`, whose Drop also calls PDFium.
    let _guard = inproc_guard();
    let pages = doc.pages();
    let page = pages
        .get(page_index as i32)
        .map_err(|e| format!("Page {} not found: {}", page_index, e))?;

    let width_pt = page.width().value;
    let height_pt = page.height().value;

    let target_w = (width_pt * scale).ceil() as i32;
    let target_h = (height_pt * scale).ceil() as i32;

    let rot = match rotation.rem_euclid(360) {
        0 => PdfPageRenderRotation::None,
        90 => PdfPageRenderRotation::Degrees90,
        180 => PdfPageRenderRotation::Degrees180,
        270 => PdfPageRenderRotation::Degrees270,
        other => return Err(format!("Unsupported rotation: {}", other)),
    };

    let config = PdfRenderConfig::new()
        .set_target_width(target_w)
        .set_maximum_height(target_h)
        .rotate(rot, true)
        .render_form_data(true)
        // ANNOTATION OWNERSHIP: PDFium does NOT render /Annot entries; our
        // own annotation-converter.js reads them into state.documents[]
        // and the annotation-canvas overlay draws them on top. This means
        // user deletes/edits via the UI reflect immediately — no need to
        // re-serialize the PDF + re-render to see the change. The fallback
        // before this was render_annotations(true) which double-rendered
        // every annotation (once by PDFium into the bitmap, once by our
        // overlay) and made deletes invisible until save+reload.
        //
        // KNOWN GAP: any /Annot subtype that annotation-converter doesn't
        // import will not be drawn. The converter currently covers
        // Highlight, Underline, StrikeOut, Square, Polygon, PolyLine, Ink,
        // FreeText, Circle, Line, Stamp, and the project's private OPS
        // subtypes. Exotic subtypes from third-party editors may be lost.
        //
        // Exception: untouched imported markups the app hands over by /NM
        // are rastered from their own /AP (js/pdf/ap-render-state.js); every
        // other markup is hidden for this render.
        .render_annotations(annot_appearance.is_some())
        // FPDF_LCD_TEXT: subpixel antialiased text. Matches what Chromium /
        // Edge use by default.
        .use_lcd_text_rendering(true)
        .set_format(PdfBitmapFormat::BGRA);
    // Native OCG default visibility is honored by the bundled PDFium (see
    // pdfium-worker/tests/ocg_visibility.rs). A layer view chosen in the
    // Layers panel reaches this page as an in-memory render copy whose
    // default configuration lists the chosen groups (ocg-render-copy); the
    // render request carries that visibility and the pixmap cache never
    // serves a default-state render for it (lookup_for_render). PDFs the
    // copy cannot be built for are detected before a change
    // (js/pdf/native-ocg-support.js), and the panel disables its toggles.

    if let Some(show) = annot_appearance {
        apply_annotation_appearance(&page, &show.names, &show.indices)?;
    }
    let bitmap = page
        .render_with_config(&config)
        .map_err(|e| format!("PDFium render failed: {}", e))?;

    let actual_w = bitmap.width() as u32;
    let actual_h = bitmap.height() as u32;
    let rgba = bitmap.as_rgba_bytes();

    Ok((actual_w, actual_h, rgba))
}

/// Which annotations a render rasters from their own appearance: by /NM, or
/// by position in the page's /Annots array (markups without a unique /NM).
#[derive(Debug, Clone, Default, PartialEq)]
pub struct AnnotShow {
    pub names: Vec<String>,
    pub indices: Vec<u32>,
}

impl AnnotShow {
    /// `None` when neither list was sent: no annotations, the old behaviour.
    pub fn from_request(names: Option<Vec<String>>, indices: Option<Vec<u32>>) -> Option<Self> {
        if names.is_none() && indices.is_none() {
            return None;
        }
        Some(Self { names: names.unwrap_or_default(), indices: indices.unwrap_or_default() })
    }
}

/// Rasters only the annotations with a /NM in `names` or at a position in
/// `indices` (FPDFPage_GetAnnot counts the /Annots array literally) from their
/// own appearance; every other non-widget annotation gets the Hidden flag for
/// this render. Same rule as pdfium-worker/src/render.rs (the worker and the
/// in-process fallback must give identical pixels). Flags are set on every
/// render with annotations, so a cached document never carries an earlier
/// choice; renders without annotations ignore them. An unreadable array entry
/// is skipped and the positions after it still count.
pub fn apply_annotation_appearance(page: &PdfPage, names: &[String], indices: &[u32]) -> Result<(), String> {
    let names: std::collections::HashSet<&str> = names.iter().map(String::as_str).collect();
    let indices: std::collections::HashSet<u32> = indices.iter().copied().collect();
    let annotations = page.annotations();
    for index in annotations.as_range() {
        let Ok(annotation) = annotations.get(index) else { continue };
        if annotation.annotation_type() == PdfPageAnnotationType::Widget {
            continue;
        }
        let keep = indices.contains(&(index as u32))
            || annotation.name().is_some_and(|nm| names.contains(nm.as_str()));
        if annotation.is_hidden() != !keep {
            let mut annotation = annotation;
            annotation
                .set_is_hidden(!keep)
                .map_err(|e| format!("annotation flag: {}", e))?;
        }
    }
    Ok(())
}

// ─── Tauri-layer pixmap cache ─────────────────────────────────────────────────

use std::collections::{BTreeMap, VecDeque};

pub type PixmapKey = (String, u32, u32, i32);

/// A fully-rendered pixmap in the IPC wire format of the render commands:
/// `[width u32 LE][height u32 LE][RGBA bytes]`. Stored Arc-wrapped so cache
/// hits clone cheaply (atomic refcount); a hit still makes the one copy the
/// IPC response needs (`tauri::ipc::Response` owns a `Vec`), straight from
/// these bytes.
pub struct CachedPixmap {
    pub width: u32,
    pub height: u32,
    framed: Vec<u8>,
}

impl CachedPixmap {
    /// Takes wire-format bytes (header + RGBA) as they are.
    pub fn from_framed(width: u32, height: u32, framed: Vec<u8>) -> Self {
        debug_assert_eq!(framed.len(), 8 + width as usize * height as usize * 4);
        Self { width, height, framed }
    }

    /// Frames bare RGBA pixels (one copy).
    pub fn from_rgba(width: u32, height: u32, rgba: &[u8]) -> Self {
        Self { width, height, framed: frame_rgba(width, height, rgba) }
    }

    /// The RGBA pixels, without the size header.
    pub fn rgba(&self) -> &[u8] {
        &self.framed[8..]
    }

    /// The wire-format bytes (size header + RGBA).
    pub fn framed(&self) -> &[u8] {
        &self.framed
    }

    /// Bytes this entry holds.
    pub fn byte_len(&self) -> usize {
        self.framed.len()
    }
}

/// `[width u32 LE][height u32 LE][rgba]` in one allocation.
pub fn frame_rgba(width: u32, height: u32, rgba: &[u8]) -> Vec<u8> {
    let mut framed = Vec::with_capacity(8 + rgba.len());
    framed.extend_from_slice(&width.to_le_bytes());
    framed.extend_from_slice(&height.to_le_bytes());
    framed.extend_from_slice(rgba);
    framed
}

/// Byte-bounded LRU cache of fully-rendered pixmaps. Key: (path, page_idx,
/// scale_q = round(scale*10000), rotation). An entry limit alone does not
/// bound memory when construction sheets produce large RGBA buffers.
const PIXMAP_CACHE_MAX_ENTRIES: usize = 40;
// The page keeps its own bitmap caches; this one only spares a re-render
// of a page just shown, so it stays small (it was 256 MB of duplicates).
const PIXMAP_CACHE_MAX_BYTES: usize = 64 * 1024 * 1024;
// Keys rendered once but not stored (see `should_store`).
const PIXMAP_CACHE_SEEN_KEYS: usize = 64;

struct PixmapEntry {
    pixmap: Arc<CachedPixmap>,
    tick: u64,
}

pub struct PixmapCache {
    map: HashMap<PixmapKey, PixmapEntry>,
    // Recency order: tick -> key. A hit moves the key to a new tick.
    order: BTreeMap<u64, PixmapKey>,
    next_tick: u64,
    bytes: usize,
    // Keys rendered once and sent without a cache copy. The webview keeps
    // its own bitmap of every frame, so a frame is only worth a copy here
    // once the same key is asked for again.
    seen: VecDeque<PixmapKey>,
    max_entries: usize,
    max_bytes: usize,
    // Tokens are unique across documents and invalidations. Removing a path
    // drops its token, so closed documents do not accumulate here.
    path_generations: HashMap<String, u64>,
    next_generation: u64,
}

impl PixmapCache {
    fn new(max_entries: usize) -> Self {
        Self::with_limits(max_entries, PIXMAP_CACHE_MAX_BYTES)
    }

    fn with_limits(max_entries: usize, max_bytes: usize) -> Self {
        Self {
            map: HashMap::new(),
            order: BTreeMap::new(),
            next_tick: 0,
            bytes: 0,
            seen: VecDeque::with_capacity(PIXMAP_CACHE_SEEN_KEYS),
            max_entries,
            max_bytes,
            path_generations: HashMap::new(),
            next_generation: 1,
        }
    }

    fn bump_tick(&mut self) -> u64 {
        self.next_tick += 1;
        self.next_tick
    }

    /// A cached pixmap; a hit becomes the most recently used entry.
    pub fn get(&mut self, key: &PixmapKey) -> Option<Arc<CachedPixmap>> {
        let tick = self.bump_tick();
        let entry = self.map.get_mut(key)?;
        self.order.remove(&entry.tick);
        entry.tick = tick;
        self.order.insert(tick, key.clone());
        Some(entry.pixmap.clone())
    }

    pub fn generation(&mut self, path: &str) -> u64 {
        *self.path_generations.entry(path.to_string()).or_insert_with(|| {
            let generation = self.next_generation;
            self.next_generation = self.next_generation.checked_add(1).expect("pixmap generation exhausted");
            generation
        })
    }

    pub fn is_current(&self, path: &str, generation: u64) -> bool {
        self.path_generations.get(path) == Some(&generation)
    }

    /// Whether a fresh render of `key` (`bytes` long) should be copied into
    /// the cache. False for a frame the cache would refuse anyway, and for
    /// the first render of a key: that one is only remembered, so the copy
    /// is made when the key comes back.
    pub fn should_store(&mut self, generation: u64, key: &PixmapKey, bytes: usize) -> bool {
        if bytes > self.max_bytes || !self.is_current(&key.0, generation) {
            return false;
        }
        if self.map.contains_key(key) {
            return true;
        }
        if let Some(pos) = self.seen.iter().position(|k| k == key) {
            self.seen.remove(pos);
            return true;
        }
        if self.seen.len() >= PIXMAP_CACHE_SEEN_KEYS {
            self.seen.pop_front();
        }
        self.seen.push_back(key.clone());
        false
    }

    fn remove_key(&mut self, key: &PixmapKey) {
        if let Some(old) = self.map.remove(key) {
            self.order.remove(&old.tick);
            self.bytes -= old.pixmap.byte_len();
        }
    }

    /// Only cache a render if no invalidation occurred since it began.
    /// The caller holds the cache mutex for both this check and the insert.
    pub fn insert_if_generation(
        &mut self,
        generation: u64,
        key: PixmapKey,
        value: Arc<CachedPixmap>,
    ) -> bool {
        if !self.is_current(&key.0, generation) {
            return false;
        }
        self.remove_key(&key);
        if value.byte_len() > self.max_bytes {
            return true; // Valid render, but too large to retain.
        }
        let tick = self.bump_tick();
        self.bytes += value.byte_len();
        self.order.insert(tick, key.clone());
        self.map.insert(key, PixmapEntry { pixmap: value, tick });
        while self.map.len() > self.max_entries || self.bytes > self.max_bytes {
            let Some((_, oldest)) = self.order.pop_first() else { break };
            if let Some(old) = self.map.remove(&oldest) {
                self.bytes -= old.pixmap.byte_len();
            }
        }
        true
    }

    pub fn clear(&mut self) {
        self.path_generations.clear();
        self.map.clear();
        self.order.clear();
        self.seen.clear();
        self.bytes = 0;
    }

    /// Alle pixmaps van één document weg (document gesloten).
    pub fn remove_path(&mut self, path: &str) {
        self.path_generations.remove(path);
        let keys: Vec<PixmapKey> = self.map.keys().filter(|k| k.0 == path).cloned().collect();
        for key in &keys {
            self.remove_key(key);
        }
        self.seen.retain(|k| k.0 != path);
    }

    /// (entries, bytes held).
    pub fn stats(&self) -> (usize, usize) {
        (self.map.len(), self.bytes)
    }
}

/// Tauri state wrapper.
#[derive(Default)]
pub struct PixmapCacheState(pub Mutex<Option<PixmapCache>>);

impl PixmapCacheState {
    /// Selected OCG renders are transient. Never return a default-state
    /// pixmap or generation token for them, even when the path/page matches.
    pub fn lookup_for_render(
        &self,
        key: &PixmapKey,
        visibility: &[LayerVisibility],
    ) -> (Option<Arc<CachedPixmap>>, Option<u64>) {
        if !visibility.is_empty() { return (None, None); }
        let Ok(mut guard) = self.0.lock() else { return (None, None); };
        let cache = guard.get_or_insert_with(|| PixmapCache::new(PIXMAP_CACHE_MAX_ENTRIES));
        (cache.get(key), Some(cache.generation(&key.0)))
    }

    pub fn generation_for_visibility(&self, path: &str, visibility: &[LayerVisibility]) -> Option<u64> {
        if visibility.is_empty() { self.snapshot_generation(path) } else { None }
    }

    pub fn ensure(&self) {
        let mut guard = self.0.lock().unwrap();
        if guard.is_none() {
            *guard = Some(PixmapCache::new(PIXMAP_CACHE_MAX_ENTRIES));
        }
    }

    pub fn snapshot_generation(&self, path: &str) -> Option<u64> {
        let mut guard = self.0.lock().ok()?;
        Some(guard.get_or_insert_with(|| PixmapCache::new(PIXMAP_CACHE_MAX_ENTRIES)).generation(path))
    }

    /// Run a cache lookup or insert only while this render's generation is
    /// current. The closure runs under the generation lock, so invalidation
    /// cannot race between the check and the other cache operation.
    pub fn with_generation<T>(
        &self,
        path: &str,
        generation: Option<u64>,
        operation: impl FnOnce() -> T,
    ) -> Option<T> {
        let generation = generation?;
        let guard = self.0.lock().ok()?;
        if !guard.as_ref()?.is_current(path, generation) {
            return None;
        }
        Some(operation())
    }

    /// Evict both caches while holding the generation lock, so a new render
    /// cannot see the new generation alongside an old document handle.
    pub fn remove_path_with_doc_cache(
        &self,
        path: &str,
        doc_cache: &PdfiumDocCache,
        evict_related: impl FnOnce() -> Result<(), String>,
    ) -> Result<Option<Arc<PdfiumDocumentHandle>>, String> {
        self.remove_path_with_cache(path, &doc_cache.0, evict_related)
    }

    fn remove_path_with_cache<T>(
        &self,
        path: &str,
        cache: &Mutex<DocMap<T>>,
        evict_related: impl FnOnce() -> Result<(), String>,
    ) -> Result<Option<Arc<T>>, String> {
        let mut guard = self.0.lock().map_err(|e| format!("Pixmap cache lock: {}", e))?;
        if let Some(cache) = guard.as_mut() {
            cache.remove_path(path);
        }
        let removed = cache.lock().map_err(|e| format!("Pdfium doc cache lock: {}", e))?
            .remove(path);
        evict_related()?;
        Ok(removed)
    }

    pub fn clear_with_doc_cache(
        &self,
        doc_cache: &PdfiumDocCache,
        evict_related: impl FnOnce() -> Result<(), String>,
    ) -> Result<Vec<Arc<PdfiumDocumentHandle>>, String> {
        let mut guard = self.0.lock().map_err(|e| format!("Pixmap cache lock: {}", e))?;
        if let Some(cache) = guard.as_mut() {
            cache.clear();
        }
        let handles = doc_cache.0.lock().map_err(|e| format!("Pdfium doc cache lock: {}", e))?
            .drain();
        evict_related()?;
        Ok(handles)
    }
}

#[cfg(test)]
mod pixmap_cache_tests {
    use super::{get_or_load_at_generation, CachedPixmap, PixmapCache, PixmapCacheState};
    use std::collections::HashMap;
    use std::sync::{mpsc, Arc, Mutex};
    use ocg_render_copy::LayerVisibility;

    fn pixmap(byte: u8) -> Arc<CachedPixmap> {
        Arc::new(CachedPixmap::from_rgba(1, 1, &[byte; 4]))
    }

    #[test]
    fn byte_budget_evicts_large_pixmaps_even_below_entry_limit() {
        let mut cache = PixmapCache::with_limits(40, 24);
        let key = |page| ("drawing.pdf".to_string(), page, 10_000, 0);
        let generation = cache.generation("drawing.pdf");
        for page in 0..3 {
            assert!(cache.insert_if_generation(generation, key(page), pixmap(page as u8)));
        }
        assert!(cache.get(&key(0)).is_none());
        assert!(cache.get(&key(1)).is_some());
        assert!(cache.get(&key(2)).is_some());
        assert_eq!(cache.stats(), (2, 24));
        assert!(cache.insert_if_generation(generation, key(3), Arc::new(CachedPixmap::from_rgba(1, 7, &[0; 28]))));
        assert!(cache.get(&key(3)).is_none(), "an oversized render must not be retained");
        assert_eq!(cache.stats(), (2, 24));
    }

    #[test]
    fn a_hit_makes_an_entry_most_recent() {
        let mut cache = PixmapCache::with_limits(2, 1 << 20);
        let key = |page| ("drawing.pdf".to_string(), page, 10_000, 0);
        let generation = cache.generation("drawing.pdf");
        cache.insert_if_generation(generation, key(0), pixmap(0));
        cache.insert_if_generation(generation, key(1), pixmap(1));
        assert!(cache.get(&key(0)).is_some());
        cache.insert_if_generation(generation, key(2), pixmap(2));
        assert!(cache.get(&key(0)).is_some(), "the recently used entry stays");
        assert!(cache.get(&key(1)).is_none(), "the least recently used entry goes");
        assert_eq!(cache.stats(), (2, 24));
        cache.remove_path("drawing.pdf");
        assert_eq!(cache.stats(), (0, 0));
    }

    #[test]
    fn a_frame_is_copied_in_only_when_its_key_comes_back() {
        let mut cache = PixmapCache::with_limits(40, 100);
        let key = ("drawing.pdf".to_string(), 0, 10_000, 0);
        let generation = cache.generation("drawing.pdf");
        assert!(!cache.should_store(generation, &key, 12), "first render: remembered, not copied");
        assert!(cache.should_store(generation, &key, 12), "second render of the key: stored");
        assert!(!cache.should_store(generation, &("drawing.pdf".to_string(), 1, 10_000, 0), 101), "too large for the cache");
        let other = ("drawing.pdf".to_string(), 2, 10_000, 0);
        assert!(!cache.should_store(generation, &other, 12));
        cache.remove_path("drawing.pdf");
        let generation = cache.generation("drawing.pdf");
        assert!(!cache.should_store(generation, &other, 12), "invalidation forgets remembered keys");
        assert!(!cache.should_store(generation + 1, &other, 12), "stale generation");
    }

    #[test]
    fn cached_frames_keep_the_wire_header() {
        let pixmap = CachedPixmap::from_rgba(2, 1, &[1, 2, 3, 4, 5, 6, 7, 8]);
        assert_eq!(pixmap.framed(), &[2, 0, 0, 0, 1, 0, 0, 0, 1, 2, 3, 4, 5, 6, 7, 8]);
        assert_eq!(pixmap.rgba(), &[1, 2, 3, 4, 5, 6, 7, 8]);
    }

    #[test]
    fn in_flight_render_cannot_repopulate_an_invalidated_path() {
        let state = Arc::new(PixmapCacheState::default());
        state.ensure();
        let path = "drawing.pdf";
        let key = (path.to_string(), 0, 10_000, 0);
        let other_key = ("other.pdf".to_string(), 0, 10_000, 0);
        {
            let mut guard = state.0.lock().unwrap();
            let cache = guard.as_mut().unwrap();
            let generation = cache.generation("other.pdf");
            assert!(cache.insert_if_generation(
                generation,
                other_key.clone(),
                pixmap(9),
            ));
        }

        let (started_tx, started_rx) = mpsc::channel();
        let (resume_tx, resume_rx) = mpsc::channel();
        let render_state = Arc::clone(&state);
        let render_key = key.clone();
        let in_flight = std::thread::spawn(move || {
            let generation = render_state.0.lock().unwrap().as_mut().unwrap().generation("drawing.pdf");
            started_tx.send(()).unwrap();
            resume_rx.recv().unwrap();
            render_state
                .0
                .lock()
                .unwrap()
                .as_mut()
                .unwrap()
                .insert_if_generation(generation, render_key, pixmap(1))
        });

        started_rx.recv().unwrap();
        state
            .0
            .lock()
            .unwrap()
            .as_mut()
            .unwrap()
            .remove_path(path);
        resume_tx.send(()).unwrap();
        assert!(
            !in_flight.join().unwrap(),
            "stale render must not enter the cache"
        );

        let mut guard = state.0.lock().unwrap();
        let cache = guard.as_mut().unwrap();
        assert!(cache.get(&key).is_none());
        assert!(
            cache.get(&other_key).is_some(),
            "other documents stay cached"
        );
        let generation = cache.generation(path);
        assert!(cache.insert_if_generation(generation, key.clone(), pixmap(2)));
        assert_eq!(cache.get(&key).unwrap().rgba(), &[2, 2, 2, 2]);
    }

    #[test]
    fn clearing_cache_rejects_an_earlier_render() {
        let state = PixmapCacheState::default();
        state.ensure();
        let key = ("drawing.pdf".to_string(), 0, 10_000, 0);
        let mut guard = state.0.lock().unwrap();
        let cache = guard.as_mut().unwrap();
        let generation = cache.generation("drawing.pdf");
        cache.clear();
        assert!(!cache.insert_if_generation(generation, key.clone(), pixmap(1)));
        assert!(cache.get(&key).is_none());
    }

    #[test]
    fn changing_one_document_preserves_another_documents_render_token() {
        let mut cache = PixmapCache::new(40);
        let first = ("first.pdf".to_string(), 0, 10_000, 0);
        let second = ("second.pdf".to_string(), 0, 10_000, 0);
        let first_generation = cache.generation(&first.0);
        let second_generation = cache.generation(&second.0);
        cache.remove_path(&first.0);

        assert!(!cache.insert_if_generation(first_generation, first.clone(), pixmap(1)));
        assert!(cache.insert_if_generation(second_generation, second.clone(), pixmap(2)));
        assert_eq!(cache.get(&second).unwrap().rgba()[0], 2);
        assert_ne!(cache.generation(&first.0), first_generation);

        cache.clear();
        assert!(!cache.insert_if_generation(second_generation, second, pixmap(3)));
    }

    #[test]
    fn selected_visibility_cannot_hit_or_populate_default_pixmap_cache() {
        let state = PixmapCacheState::default();
        let key = ("drawing.pdf".to_string(), 0, 10_000, 0);
        let (cached, generation) = state.lookup_for_render(&key, &[]);
        assert!(cached.is_none());
        let generation = generation.unwrap();
        state.0.lock().unwrap().as_mut().unwrap()
            .insert_if_generation(generation, key.clone(), pixmap(1));
        assert_eq!(state.lookup_for_render(&key, &[]).0.unwrap().rgba()[0], 1);
        let selected = [LayerVisibility { object_number: 6, generation: 0, visible: true }];
        assert!(state.lookup_for_render(&key, &selected).0.is_none());
        assert!(state.generation_for_visibility("drawing.pdf", &selected).is_none());
        // Without a generation token, selected output cannot enter this map;
        // default-state output remains available to a later default request.
        assert_eq!(state.lookup_for_render(&key, &[]).0.unwrap().rgba()[0], 1);
    }

    #[test]
    fn selected_visibility_cannot_hit_or_populate_default_thumbnail_cache() {
        let state = PixmapCacheState::default();
        let thumbnails = Mutex::new(HashMap::<(String, u32, u32, i32), String>::new());
        let key = ("drawing.pdf".to_string(), 0, 100, 0);
        let default_generation = state.generation_for_visibility("drawing.pdf", &[]);
        state.with_generation("drawing.pdf", default_generation, || {
            thumbnails.lock().unwrap().insert(key.clone(), "default".into());
        });
        let selected = [LayerVisibility { object_number: 6, generation: 0, visible: true }];
        let selected_generation = state.generation_for_visibility("drawing.pdf", &selected);
        assert!(state.with_generation("drawing.pdf", selected_generation, || {
            thumbnails.lock().unwrap().get(&key).cloned()
        }).is_none());
        assert!(state.with_generation("drawing.pdf", selected_generation, || {
            thumbnails.lock().unwrap().insert(key.clone(), "selected".into());
        }).is_none());
        assert_eq!(thumbnails.lock().unwrap().get(&key).map(String::as_str), Some("default"));
    }

    #[test]
    fn old_document_load_cannot_reenter_cache_after_invalidation() {
        let pixmaps = Arc::new(PixmapCacheState::default());
        let documents = Arc::new(Mutex::new(super::new_doc_map::<u8>()));
        let generation = pixmaps.snapshot_generation("drawing.pdf");
        let (started_tx, started_rx) = mpsc::channel();
        let (resume_tx, resume_rx) = mpsc::channel();
        let render_pixmaps = Arc::clone(&pixmaps);
        let render_documents = Arc::clone(&documents);
        let in_flight = std::thread::spawn(move || {
            get_or_load_at_generation(
                "drawing.pdf",
                &render_documents,
                &render_pixmaps,
                generation,
                || {
                    started_tx.send(()).unwrap();
                    resume_rx.recv().unwrap();
                    Ok(Arc::new(1_u8))
                },
            )
            .unwrap()
        });

        started_rx.recv().unwrap();
        pixmaps.remove_path_with_cache("drawing.pdf", &documents, || Ok(())).unwrap();
        resume_tx.send(()).unwrap();
        assert_eq!(*in_flight.join().unwrap(), 1);
        assert!(documents.lock().unwrap().is_empty());

        let current = pixmaps.snapshot_generation("drawing.pdf");
        let new_handle = get_or_load_at_generation(
            "drawing.pdf",
            &documents,
            &pixmaps,
            current,
            || Ok(Arc::new(2_u8)),
        )
        .unwrap();
        assert_eq!(*new_handle, 2);
        let cached = get_or_load_at_generation(
            "drawing.pdf",
            &documents,
            &pixmaps,
            current,
            || panic!("current document should be cached"),
        )
        .unwrap();
        assert!(Arc::ptr_eq(&new_handle, &cached));
    }

    #[test]
    fn selected_render_bypasses_default_document_cache_even_during_invalidation() {
        let pixmaps = Arc::new(PixmapCacheState::default());
        let documents = Arc::new(Mutex::new(super::new_doc_map::<u8>()));
        documents.lock().unwrap().insert("drawing.pdf".into(), Arc::new(1), 0);
        let (started_tx, started_rx) = mpsc::channel();
        let (resume_tx, resume_rx) = mpsc::channel();
        let p = Arc::clone(&pixmaps);
        let d = Arc::clone(&documents);
        let selected = std::thread::spawn(move || {
            get_or_load_at_generation("drawing.pdf", &d, &p, None, || {
                started_tx.send(()).unwrap();
                resume_rx.recv().unwrap();
                Ok(Arc::new(2_u8))
            }).unwrap()
        });
        started_rx.recv().unwrap();
        pixmaps.remove_path_with_cache("drawing.pdf", &documents, || Ok(())).unwrap();
        resume_tx.send(()).unwrap();
        assert_eq!(*selected.join().unwrap(), 2);
        assert!(documents.lock().unwrap().is_empty(),
            "selected render must not repopulate the default cache");
    }

    #[test]
    fn in_flight_thumbnail_cannot_repopulate_after_invalidation() {
        let pixmaps = Arc::new(PixmapCacheState::default());
        let documents = Mutex::new(super::new_doc_map::<u8>());
        let thumbnails = Arc::new(Mutex::new(HashMap::<(String, u32, u32, i32), String>::new()));
        let path = "drawing.pdf";
        let key = (path.to_string(), 0, 200, 0);
        thumbnails.lock().unwrap().insert((path.to_string(), 1, 200, 0), "prior".into());
        let generation = pixmaps.snapshot_generation("drawing.pdf");

        let (started_tx, started_rx) = mpsc::channel();
        let (resume_tx, resume_rx) = mpsc::channel();
        let render_pixmaps = Arc::clone(&pixmaps);
        let render_thumbnails = Arc::clone(&thumbnails);
        let render_key = key.clone();
        let in_flight = std::thread::spawn(move || {
            started_tx.send(()).unwrap();
            resume_rx.recv().unwrap();
            render_pixmaps.with_generation("drawing.pdf", generation, || {
                render_thumbnails.lock().unwrap().insert(render_key, "old".into())
            })
        });

        started_rx.recv().unwrap();
        pixmaps.remove_path_with_cache(path, &documents, || {
            thumbnails.lock().unwrap().retain(|(p, _, _, _), _| p != path);
            Ok(())
        }).unwrap();
        resume_tx.send(()).unwrap();
        assert!(in_flight.join().unwrap().is_none());
        assert!(thumbnails.lock().unwrap().is_empty());

        let current = pixmaps.snapshot_generation("drawing.pdf");
        pixmaps.with_generation("drawing.pdf", current, || {
            thumbnails.lock().unwrap().insert(key.clone(), "new".into())
        });
        assert_eq!(thumbnails.lock().unwrap().get(&key).map(String::as_str), Some("new"));
    }

    #[test]
    fn final_worker_barrier_evicts_results_cached_during_invalidation() {
        let pixmaps = PixmapCacheState::default();
        let documents = Mutex::new(super::new_doc_map::<u8>());
        let thumbnails = Mutex::new(HashMap::<String, String>::new());
        let path = "drawing.pdf";
        let key = (path.to_string(), 0, 10_000, 0);
        pixmaps.snapshot_generation("drawing.pdf");

        // First local eviction happens before awaiting worker acknowledgements.
        pixmaps.remove_path_with_cache(path, &documents, || Ok(())).unwrap();
        let during_invalidation = pixmaps.snapshot_generation("drawing.pdf").unwrap();
        {
            let mut guard = pixmaps.0.lock().unwrap();
            let cache = guard.as_mut().unwrap();
            assert!(cache.insert_if_generation(during_invalidation, key.clone(), pixmap(1)));
        }
        thumbnails.lock().unwrap().insert(path.into(), "old".into());

        // A worker can finish ahead of its invalidate request. The final
        // barrier evicts that temporary result and invalidates its token.
        pixmaps.remove_path_with_cache(path, &documents, || {
            thumbnails.lock().unwrap().remove(path);
            Ok(())
        }).unwrap();
        let mut guard = pixmaps.0.lock().unwrap();
        let cache = guard.as_mut().unwrap();
        assert!(cache.get(&key).is_none());
        assert!(thumbnails.lock().unwrap().is_empty());
        assert!(!cache.insert_if_generation(during_invalidation, key, pixmap(1)));
    }
}

// ─── Thumbnail rendering ───────────────────────────────────────────────────────

/// Render a low-resolution thumbnail of a single page, encoded as a
/// JSON string `{"dataURL":"data:image/jpeg;base64,...","width":N,"height":N}`.
///
/// `max_width` is in pixels — the page is scaled so the longest side
/// fits within this. Aspect ratio preserved.
///
/// The JSON shape matches the legacy wire format that left-panel.js
/// expects: it does `JSON.parse(result)` and accesses `.dataURL`,
/// `.width`, `.height`.
pub fn render_thumbnail_to_json(
    doc: &PdfDocument<'static>,
    page_index: u32,
    max_width: u32,
    rotation: i32,
) -> Result<String, String> {
    // Read the page width under the in-proc PDFium lock, then release it before
    // render_page_to_rgba (which re-acquires the same, non-re-entrant lock).
    let w_pt = {
        let _guard = inproc_guard();
        let pages = doc.pages();
        let page = pages
            .get(page_index as i32)
            .map_err(|e| format!("Page {}: {}", page_index, e))?;
        page.width().value
    };
    // The parameter is named `max_width` and callers (left-panel.js thumbnail
    // path) treat it as "thumbnail width is exactly this many pixels".
    // Earlier this used `w_pt.max(h_pt)` (max-axis semantics) which made
    // portrait pages render at narrower-than-requested widths (e.g. A4
    // portrait at maxWidth=140 became 99×140 instead of 140×198), giving
    // visibly different sizes than the JS-replay vector path (which is
    // strictly width-targeted). Mismatched thumbnail widths in the panel
    // produced the user-reported "different sizes" issue. Width-target the
    // scale so both paths produce identical (140×<aspect-h>) thumbnails.
    let scale = max_width as f32 / w_pt;

    let (w, h, rgba) = render_page_to_rgba(doc, page_index, scale, rotation)?;

    // Convert RGBA -> RGB for JPEG (JPEG doesn't support alpha).
    let mut rgb = Vec::with_capacity((w * h * 3) as usize);
    for chunk in rgba.chunks(4) {
        rgb.push(chunk[0]);
        rgb.push(chunk[1]);
        rgb.push(chunk[2]);
    }

    let mut jpeg_bytes = Vec::with_capacity(rgb.len() / 4);
    {
        use image::codecs::jpeg::JpegEncoder;
        use image::ImageEncoder;
        let encoder = JpegEncoder::new_with_quality(&mut jpeg_bytes, 75);
        encoder
            .write_image(&rgb, w, h, image::ExtendedColorType::Rgb8)
            .map_err(|e| format!("JPEG encode: {}", e))?;
    }

    use base64::Engine;
    let b64 = base64::engine::general_purpose::STANDARD.encode(&jpeg_bytes);
    let data_url = format!("data:image/jpeg;base64,{}", b64);

    Ok(format!(
        r#"{{"dataURL":"{}","width":{},"height":{}}}"#,
        data_url, w, h
    ))
}

// ─── Region / tile rendering ───────────────────────────────────────────────────

/// Render only a sub-rectangle of a PDF page to RGBA pixel bytes. The
/// output bitmap is sized `(region_w_pt * scale, region_h_pt * scale)` —
/// vastly smaller than rendering the full page at high zoom.
///
/// `region_*_pt` are in PDF user-space POINTS (1pt = 1/72 inch). They
/// describe which sub-rectangle of the page (origin top-left, before
/// rotation) to render. `scale` is the zoom factor (1.0 = 100%).
///
/// Used by the tile-mode render path for high-zoom viewing — only the
/// visible viewport region is rasterised, avoiding the giant full-page
/// bitmap and browser canvas-size limit.
///
/// Returns `(bitmap_width_px, bitmap_height_px, rgba_bytes)`.
///
/// # Limitations
/// - `rotation` must be 0 for this release. Non-zero values return `Err`.
///   Rotation support will be added in a subsequent step.
pub fn render_page_region_to_rgba(
    doc: &PdfDocument<'static>,
    page_index: u32,
    scale: f32,
    rotation: i32,
    region_x_pt: f32,
    region_y_pt: f32,
    region_w_pt: f32,
    region_h_pt: f32,
) -> Result<(u32, u32, Vec<u8>), String> {
    render_page_region_to_rgba_with_annotations(
        doc, page_index, scale, rotation, region_x_pt, region_y_pt, region_w_pt, region_h_pt, None,
    )
}

/// As [`render_page_region_to_rgba`], with the /AP pass of
/// [`render_page_to_rgba_with_annotations`].
#[allow(clippy::too_many_arguments)]
pub fn render_page_region_to_rgba_with_annotations(
    doc: &PdfDocument<'static>,
    page_index: u32,
    scale: f32,
    rotation: i32,
    region_x_pt: f32,
    region_y_pt: f32,
    region_w_pt: f32,
    region_h_pt: f32,
    annot_appearance: Option<&AnnotShow>,
) -> Result<(u32, u32, Vec<u8>), String> {
    if rotation != 0 {
        return Err(format!(
            "render_page_region_to_rgba: rotation {} not yet supported (only 0 is implemented)",
            rotation
        ));
    }

    if region_w_pt <= 0.0 || region_h_pt <= 0.0 {
        return Err(format!(
            "render_page_region_to_rgba: region dimensions must be positive (got {}x{})",
            region_w_pt, region_h_pt
        ));
    }

    // Serialise all in-proc PDFium work (see PDFIUM_INPROC_LOCK). Declared
    // first so the guard outlives `pages`/`page`, whose Drop also calls PDFium.
    let _guard = inproc_guard();
    let pages = doc.pages();
    let page = pages
        .get(page_index as i32)
        .map_err(|e| format!("Page {} not found: {}", page_index, e))?;

    // Output bitmap pixel dimensions.
    let bitmap_w = (region_w_pt * scale).ceil() as i32;
    let bitmap_h = (region_h_pt * scale).ceil() as i32;

    if bitmap_w <= 0 || bitmap_h <= 0 {
        return Err(format!(
            "render_page_region_to_rgba: computed bitmap size {}x{} is invalid",
            bitmap_w, bitmap_h
        ));
    }

    // Build the affine matrix that maps the full page coordinate space to
    // bitmap pixels, then shifts so that `region_x_pt, region_y_pt` lands
    // at pixel (0,0).
    //
    // PDF user-space convention for FPDF_RenderPageBitmapWithMatrix (via
    // pdfium-render's `transform()` path):
    //   x' = a*x + c*y + e
    //   y' = b*x + d*y + f
    //
    //   a = scale_x  (x scale factor)
    //   d = scale_y  (y scale factor — positive; PDFium handles Y-flip internally)
    //   e = -region_x_pt * scale_x  (translate so region left edge → pixel 0)
    //   f = -region_y_pt * scale_y  (translate so region top edge → pixel 0)
    //   b = c = 0    (no shear / rotation)
    let scale_x = scale;
    let scale_y = scale;

    let tx = -region_x_pt * scale_x;
    let ty = -region_y_pt * scale_y;

    // PdfRenderConfig field order: transform(a, b, c, d, e, f)
    // We call set_fixed_size so the bitmap is exactly (bitmap_w × bitmap_h)
    // and use_auto_scaling = false, so no additional scale is baked in.
    // transform() sets do_render_form_data = false, which causes
    // FPDF_RenderPageBitmapWithMatrix to be used.
    let config = PdfRenderConfig::new()
        .set_fixed_size(bitmap_w, bitmap_h)
        .transform(scale_x, 0.0, 0.0, scale_y, tx, ty)
        .map_err(|e| format!("render_page_region_to_rgba: invalid transform matrix: {}", e))?
        // ANNOTATION OWNERSHIP: see render_page_to_rgba above. Tiles must
        // omit /Annot entries too so the overlay-canvas is the single
        // source of truth at every zoom level. Without this, high-zoom
        // tiles would still bake annotations into the bitmap and deleted
        // annotations would persist visually in tile regions.
        // (Same /AP exception as the whole-page render.)
        .render_annotations(annot_appearance.is_some())
        .use_lcd_text_rendering(true)
        .set_format(PdfBitmapFormat::BGRA);

    if let Some(show) = annot_appearance {
        apply_annotation_appearance(&page, &show.names, &show.indices)?;
    }
    let bitmap = page
        .render_with_config(&config)
        .map_err(|e| format!("PDFium region render failed: {}", e))?;

    let actual_w = bitmap.width() as u32;
    let actual_h = bitmap.height() as u32;

    // as_rgba_bytes() handles the BGRA→RGBA conversion automatically (matches
    // the existing render_page_to_rgba output shape).
    let rgba = bitmap.as_rgba_bytes();

    Ok((actual_w, actual_h, rgba))
}

// ─── Printen van een pagina die al op papiergrootte is opgemaakt ─────────────

/// Wat er op een pagina staat, voor het printen van een pagina die de
/// printdialoog al op papiergrootte heeft opgemaakt (`print_windows`,
/// plaatsing `Vel`): alleen het deel met inhoud hoeft gerenderd te worden.
pub struct PaginaInhoud {
    /// De zichtbare pagina (MediaBox en CropBox) in gebruikersruimte.
    pub kader: crate::print_plaatsing::PdfRechthoek,
    /// De omhullende van elk object in gebruikersruimte.
    pub objecten: Vec<crate::print_plaatsing::PdfRechthoek>,
    /// Per object de resolutie op de pagina (dpi) als het een afbeelding is.
    pub afbeelding_dpi: Vec<Option<f64>>,
    /// De pagina heeft een /Rotate: de omhullenden gelden dan niet in weergaveruimte.
    pub gedraaid: bool,
}

/// Lees de objecten van een pagina (zonder te renderen).
pub fn page_content(doc: &PdfDocument<'static>, page_index: u32) -> Result<PaginaInhoud, String> {
    use crate::print_plaatsing::PdfRechthoek;
    let _guard = inproc_guard();
    let pages = doc.pages();
    let page = pages
        .get(page_index as i32)
        .map_err(|e| format!("Page {} not found: {}", page_index, e))?;
    let gedraaid = !matches!(page.rotation(), Ok(PdfPageRenderRotation::None));
    let rechthoek = |r: PdfRect| PdfRechthoek {
        links: r.left().value as f64,
        onder: r.bottom().value as f64,
        rechts: r.right().value as f64,
        boven: r.top().value as f64,
    };
    let kader = match page.boundaries().bounding() {
        Ok(b) => rechthoek(b.bounds),
        Err(_) => PdfRechthoek { links: 0.0, onder: 0.0, rechts: page.width().value as f64, boven: page.height().value as f64 },
    };
    let mut objecten = Vec::new();
    let mut afbeelding_dpi = Vec::new();
    for object in page.objects().iter() {
        let Ok(omhulling) = object.bounds() else { continue };
        objecten.push(rechthoek(omhulling.to_rect()));
        afbeelding_dpi.push(object.as_image_object().and_then(|beeld| {
            let (x, y) = (beeld.horizontal_dpi().ok()?, beeld.vertical_dpi().ok()?);
            Some(x.max(y) as f64)
        }));
    }
    Ok(PaginaInhoud { kader, objecten, afbeelding_dpi, gedraaid })
}

/// Render een deel van een (niet gedraaide) pagina voor de printer: precies
/// `scale` pixels per punt, deel vanaf de linkerbovenhoek van de pagina in
/// punten. Geeft (breedte, hoogte, rgba); het beeld dekt
/// `breedte / scale` x `hoogte / scale` punten vanaf (x, y).
///
/// Dezelfde matrix als `render_page_region_to_rgba`, maar zonder LCD-tekst
/// (dat is voor schermen). Dat de plek op de pixel klopt, ook op een pagina
/// met gebroken puntmaten, bewaakt `print_windows::tests`.
pub fn render_page_part_for_print(
    doc: &PdfDocument<'static>,
    page_index: u32,
    scale: f32,
    x_pt: f32,
    y_pt: f32,
    w_pt: f32,
    h_pt: f32,
) -> Result<(u32, u32, Vec<u8>), String> {
    if !(scale > 0.0 && w_pt > 0.0 && h_pt > 0.0) {
        return Err(format!("render_page_part_for_print: invalid part {w_pt}x{h_pt} pt at scale {scale}"));
    }
    let _guard = inproc_guard();
    let pages = doc.pages();
    let page = pages
        .get(page_index as i32)
        .map_err(|e| format!("Page {} not found: {}", page_index, e))?;
    let bitmap_w = (w_pt * scale).ceil().max(1.0) as i32;
    let bitmap_h = (h_pt * scale).ceil().max(1.0) as i32;
    let config = PdfRenderConfig::new()
        .set_fixed_size(bitmap_w, bitmap_h)
        .transform(scale, 0.0, 0.0, scale, -x_pt * scale, -y_pt * scale)
        .map_err(|e| format!("render_page_part_for_print: invalid transform: {e}"))?
        .render_annotations(false)
        .use_lcd_text_rendering(false)
        .set_format(PdfBitmapFormat::BGRA);
    let bitmap = page
        .render_with_config(&config)
        .map_err(|e| format!("PDFium print render failed: {e}"))?;
    Ok((bitmap.width() as u32, bitmap.height() as u32, bitmap.as_rgba_bytes()))
}

#[cfg(test)]
mod lifetime_tests {
    use super::*;

    #[test]
    #[ignore = "requires OPDS_TEST_PDFIUM_DIR and OPDS_TEST_PDF"]
    fn document_drop_waits_for_inproc_guard() {
        let library = std::env::var("OPDS_TEST_PDFIUM_DIR").expect("PDFium directory");
        init_pdfium(Path::new(&library)).unwrap();
        let bytes = std::fs::read(std::env::var("OPDS_TEST_PDF").expect("test PDF")).unwrap();
        let handle = PdfiumDocumentHandle::load_from_bytes(Arc::new(bytes)).unwrap();
        let guard = inproc_guard();
        let (started_tx, started_rx) = std::sync::mpsc::channel();
        let (done_tx, done_rx) = std::sync::mpsc::channel();
        let thread = std::thread::spawn(move || {
            started_tx.send(()).unwrap();
            drop(handle);
            done_tx.send(()).unwrap();
        });
        started_rx.recv().unwrap();
        let blocked = done_rx.recv_timeout(std::time::Duration::from_millis(50)).is_err();
        drop(guard);
        if blocked { done_rx.recv_timeout(std::time::Duration::from_secs(5)).unwrap(); }
        thread.join().unwrap();
        assert!(blocked, "FPDF_CloseDocument must wait for the process-wide lock");
    }
}
