//! A page's text for whole-set reads, as PDF.js text items.
//!
//! Reading every sheet's text of a large set through PDF.js runs in the
//! window's own process, and each extra PDF.js document holds a buffer the
//! size of the whole file. Here PDFium reads the characters in this worker,
//! and `group` builds the items with the rules PDF.js's getTextContent uses
//! (pdf.js src/core/evaluator.js: compareWithLastPosition, addFakeSpaces,
//! buildTextContentItem), so a scan sees the same items: where an item
//! starts and ends, where a space goes, and the item's transform, width and
//! height. Only what the scans use is produced: `str`, `transform`,
//! `width` and `height` of each item that holds text.

use serde::Serialize;

/// PDF.js's thresholds, as fractions of the font size.
const TRACKING_SPACE_FACTOR: f64 = 0.102;
const NEGATIVE_SPACE_FACTOR: f64 = -0.2;
const SPACE_IN_FLOW_MIN_FACTOR: f64 = 0.102;
const SPACE_IN_FLOW_MAX_FACTOR: f64 = 0.6;
const VERTICAL_SHIFT_RATIO: f64 = 0.25;

/// One character as PDFium places it on the page (page space).
#[derive(Debug, Clone, PartialEq)]
pub struct Glyph {
    pub ch: char,
    /// Origin on the baseline.
    pub origin: (f64, f64),
    /// The character's text matrix (a, b, c, d) in page space, without the
    /// font size: (a, b) runs along the baseline, (c, d) up.
    pub matrix: [f64; 4],
    /// Font size as set in the content (Tf), before the matrix.
    pub font_size: f64,
    /// Identifies the font (a change of font ends an item, as in PDF.js).
    pub font: u32,
    /// How far the glyph advances along its baseline, in page space.
    pub advance: f64,
    /// The marked content the glyph is drawn in, and whether it is drawn by
    /// a form XObject: PDF.js ends an item at BMC, BDC, EMC and at a form.
    pub segment: u64,
}

/// A PDF.js text item: what runsFromItems reads.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct Item {
    pub str: String,
    pub transform: [f64; 6],
    pub width: f64,
    pub height: f64,
}

struct Open {
    str: String,
    transform: [f64; 6],
    dir: (f64, f64),
    up: (f64, f64),
    height: f64,
    font_size: f64,
    font: u32,
    segment: u64,
}

fn unit(x: f64, y: f64) -> Option<(f64, f64)> {
    let n = x.hypot(y);
    (n > 0.0 && n.is_finite()).then(|| (x / n, y / n))
}

fn dot(a: (f64, f64), b: (f64, f64)) -> f64 {
    a.0 * b.0 + a.1 * b.1
}

/// Group a page's glyphs (content order) into PDF.js text items. `view` is
/// the page's visible box (x0, y0, x1, y1): PDF.js leaves out a glyph whose
/// origin lies outside it.
pub fn group(glyphs: &[Glyph], view: [f64; 4]) -> Vec<Item> {
    let mut items = Vec::new();
    let mut open: Option<Open> = None;
    // End of the last glyph set (PDF.js prevTransform): kept across items.
    let mut prev_end: Option<(f64, f64)> = None;
    // An explicit space glyph since the last glyph set (saveLastChar(" ")).
    let mut space_seen = false;
    let mut start: (f64, f64) = (0.0, 0.0);

    let flush = |open: &mut Option<Open>, items: &mut Vec<Item>, start: (f64, f64), prev_end: Option<(f64, f64)>| {
        if let Some(o) = open.take() {
            if o.str.is_empty() {
                return;
            }
            let end = prev_end.unwrap_or(start);
            let width = dot((end.0 - start.0, end.1 - start.1), o.dir).abs();
            items.push(Item { str: o.str, transform: o.transform, width, height: o.height });
        }
    };

    for g in glyphs {
        if g.ch.is_whitespace() {
            space_seen = true;
            continue;
        }
        let [a, b, c, d] = g.matrix;
        let Some(dir) = unit(a, b) else { continue };
        let up = unit(c, d).unwrap_or((-dir.1, dir.0));
        let along_scale = g.font_size * a.hypot(b);
        let height = g.font_size * c.hypot(d);
        let (x, y) = g.origin;
        // Outside the visible box: PDF.js skips the glyph (its advance still moves on).
        if x + g.advance.max(0.0) < view[0] || x > view[2] || y < view[1] || y > view[3] {
            prev_end = Some((x + dir.0 * g.advance, y + dir.1 * g.advance));
            continue;
        }
        // A change of font or size ends the item (buildTextContentItem).
        // So does marked content or a form XObject starting or ending.
        if open.as_ref().is_some_and(|o| (o.font_size - g.font_size).abs() > 1e-9 || o.font != g.font || o.segment != g.segment) {
            flush(&mut open, &mut items, start, prev_end);
        }
        let mut add_space = false;
        if let (Some(o), Some(pe)) = (open.as_ref(), prev_end) {
            let rel = (x - pe.0, y - pe.1);
            // PDF.js measures the gap in the text space of the glyph now
            // drawn (divided by its matrix's scale) against the font size
            // set with Tf; the shift off the line stays in page space.
            let scale = a.hypot(b);
            let advance_x = dot(rel, o.dir) / if scale > 0.0 { scale } else { 1.0 };
            let advance_y = dot(rel, o.up);
            let fs = o.font_size;
            let mut new_item = false;
            if advance_x < NEGATIVE_SPACE_FACTOR * fs {
                // Back over earlier text: a new item (a new line when it also moved up or down).
                new_item = true;
            } else if advance_y.abs() > o.height {
                new_item = true;
            } else {
                if advance_x <= TRACKING_SPACE_FACTOR * fs {
                    add_space = space_seen;
                } else if advance_x <= SPACE_IN_FLOW_MAX_FACTOR * fs && advance_x >= SPACE_IN_FLOW_MIN_FACTOR * fs {
                    add_space = true;
                } else {
                    new_item = true;
                }
                if !new_item && advance_y.abs() > o.height * VERTICAL_SHIFT_RATIO {
                    // Moved off the line: this glyph starts the next item.
                    new_item = true;
                }
            }
            if new_item {
                add_space = false;
                flush(&mut open, &mut items, start, prev_end);
            }
        }
        if open.is_none() {
            start = (x, y);
            open = Some(Open {
                str: String::new(),
                transform: [dir.0 * along_scale, dir.1 * along_scale, up.0 * height, up.1 * height, x, y],
                dir,
                up,
                height,
                font_size: g.font_size,
                font: g.font,
                segment: g.segment,
            });
        }
        let o = open.as_mut().expect("opened above");
        if add_space && !o.str.is_empty() {
            o.str.push(' ');
        }
        o.str.push(g.ch);
        space_seen = false;
        prev_end = Some((x + dir.0 * g.advance, y + dir.1 * g.advance));
    }
    flush(&mut open, &mut items, start, prev_end);
    items
}

pub use raw::TextReader;

/// PDFium's text functions called directly: pdfium-render does not expose a
/// character's text object, its marked content or the line-end hyphen flag.
/// The worker's bound library file is opened again (the loader returns the
/// same, already initialised library) and the document is opened a second
/// time, for text only, through a Rust file handle like the render path's.
mod raw {
    use super::{group, unit, dot, Glyph, Item};
    use anyhow::{anyhow, Context, Result};
    use serde::Serialize;
    use std::ffi::c_void;
    use std::os::raw::{c_double, c_float, c_int, c_uint, c_ulong};

    type Handle = *mut c_void;

    #[repr(C)]
    struct FsMatrix { a: c_float, b: c_float, c: c_float, d: c_float, e: c_float, f: c_float }
    #[repr(C)]
    struct FsRect { left: c_float, top: c_float, right: c_float, bottom: c_float }
    #[repr(C)]
    struct FileAccess {
        len: c_ulong,
        get_block: unsafe extern "C" fn(*mut c_void, c_ulong, *mut u8, c_ulong) -> c_int,
        param: *mut c_void,
    }

    struct Api {
        _lib: libloading::Library,
        load_custom: unsafe extern "C" fn(*mut FileAccess, *const i8) -> Handle,
        close_doc: unsafe extern "C" fn(Handle),
        load_page: unsafe extern "C" fn(Handle, c_int) -> Handle,
        close_page: unsafe extern "C" fn(Handle),
        crop_box: unsafe extern "C" fn(Handle, *mut c_float, *mut c_float, *mut c_float, *mut c_float) -> c_int,
        media_box: unsafe extern "C" fn(Handle, *mut c_float, *mut c_float, *mut c_float, *mut c_float) -> c_int,
        count_objects: unsafe extern "C" fn(Handle) -> c_int,
        get_object: unsafe extern "C" fn(Handle, c_int) -> Handle,
        text_load: unsafe extern "C" fn(Handle) -> Handle,
        text_close: unsafe extern "C" fn(Handle),
        count_chars: unsafe extern "C" fn(Handle) -> c_int,
        unicode: unsafe extern "C" fn(Handle, c_int) -> c_uint,
        generated: unsafe extern "C" fn(Handle, c_int) -> c_int,
        hyphen: unsafe extern "C" fn(Handle, c_int) -> c_int,
        origin: unsafe extern "C" fn(Handle, c_int, *mut c_double, *mut c_double) -> c_int,
        matrix: unsafe extern "C" fn(Handle, c_int, *mut FsMatrix) -> c_int,
        font_size: unsafe extern "C" fn(Handle, c_int) -> c_double,
        loose_box: unsafe extern "C" fn(Handle, c_int, *mut FsRect) -> c_int,
        text_object: unsafe extern "C" fn(Handle, c_int) -> Handle,
        object_font: unsafe extern "C" fn(Handle) -> Handle,
        count_marks: unsafe extern "C" fn(Handle) -> c_int,
        get_mark: unsafe extern "C" fn(Handle, c_ulong) -> Handle,
        object_type: unsafe extern "C" fn(Handle) -> c_int,
        object_bounds: unsafe extern "C" fn(Handle, *mut c_float, *mut c_float, *mut c_float, *mut c_float) -> c_int,
        form_count: unsafe extern "C" fn(Handle) -> c_int,
        form_object: unsafe extern "C" fn(Handle, c_ulong) -> Handle,
        object_matrix: unsafe extern "C" fn(Handle, *mut FsMatrix) -> c_int,
    }

    impl Api {
        fn open() -> Result<Self> {
            let file = crate::render::pdfium_library_file()?;
            let name = file.map(|f| f.into_os_string()).unwrap_or_else(|| libloading::library_filename("pdfium"));
            // Safety: the same library the worker already loaded and initialised.
            let lib = unsafe { libloading::Library::new(&name) }.with_context(|| format!("open {:?}", name))?;
            macro_rules! f {
                ($name:literal) => {
                    // Safety: the PDFium C API's published signature for this symbol.
                    unsafe { *lib.get($name).with_context(|| String::from_utf8_lossy($name).into_owned())? }
                };
            }
            Ok(Self {
                load_custom: f!(b"FPDF_LoadCustomDocument"),
                close_doc: f!(b"FPDF_CloseDocument"),
                load_page: f!(b"FPDF_LoadPage"),
                close_page: f!(b"FPDF_ClosePage"),
                crop_box: f!(b"FPDFPage_GetCropBox"),
                media_box: f!(b"FPDFPage_GetMediaBox"),
                count_objects: f!(b"FPDFPage_CountObjects"),
                get_object: f!(b"FPDFPage_GetObject"),
                text_load: f!(b"FPDFText_LoadPage"),
                text_close: f!(b"FPDFText_ClosePage"),
                count_chars: f!(b"FPDFText_CountChars"),
                unicode: f!(b"FPDFText_GetUnicode"),
                generated: f!(b"FPDFText_IsGenerated"),
                hyphen: f!(b"FPDFText_IsHyphen"),
                origin: f!(b"FPDFText_GetCharOrigin"),
                matrix: f!(b"FPDFText_GetMatrix"),
                font_size: f!(b"FPDFText_GetFontSize"),
                loose_box: f!(b"FPDFText_GetLooseCharBox"),
                text_object: f!(b"FPDFText_GetTextObject"),
                object_font: f!(b"FPDFTextObj_GetFont"),
                count_marks: f!(b"FPDFPageObj_CountMarks"),
                get_mark: f!(b"FPDFPageObj_GetMark"),
                object_type: f!(b"FPDFPageObj_GetType"),
                object_bounds: f!(b"FPDFPageObj_GetBounds"),
                form_count: f!(b"FPDFFormObj_CountObjects"),
                form_object: f!(b"FPDFFormObj_GetObject"),
                object_matrix: f!(b"FPDFPageObj_GetMatrix"),
                _lib: lib,
            })
        }
    }

    /// The open file PDFium reads blocks from (FPDF_FILEACCESS.m_Param).
    struct Source {
        file: std::fs::File,
    }

    unsafe extern "C" fn get_block(param: *mut c_void, position: c_ulong, buf: *mut u8, size: c_ulong) -> c_int {
        // Safety: `param` is the Source this document was opened with; it
        // lives in the Doc until the document is closed.
        if size == 0 {
            return 1;
        }
        let source = unsafe { &*(param as *const Source) };
        let out = unsafe { std::slice::from_raw_parts_mut(buf, size as usize) };
        let mut done = 0;
        while done < out.len() {
            #[cfg(unix)]
            let read = std::os::unix::fs::FileExt::read_at(&source.file, &mut out[done..], position as u64 + done as u64);
            #[cfg(windows)]
            let read = std::os::windows::fs::FileExt::seek_read(&source.file, &mut out[done..], position as u64 + done as u64);
            match read {
                Ok(0) | Err(_) => return 0,
                Ok(n) => done += n,
            }
        }
        1
    }

    struct Doc {
        path: String,
        mtime: Option<std::time::SystemTime>,
        len: u64,
        handle: Handle,
        // Kept alive (and at a fixed address) while PDFium holds pointers to them.
        _access: Box<FileAccess>,
        _source: Box<Source>,
    }

    /// Reads page text with PDFium's text API, the document kept open for
    /// the next page of the same file.
    pub struct TextReader {
        api: Option<Api>,
        doc: Option<Doc>,
    }

    impl Default for TextReader {
        fn default() -> Self { Self { api: None, doc: None } }
    }

    impl Drop for TextReader {
        fn drop(&mut self) { self.close(); }
    }

    #[derive(Serialize)]
    struct Out<'a> {
        items: &'a [Item],
        view: [f64; 4],
        /// False when PDFium's text for the page is not what PDF.js reads:
        /// it left out text drawn twice (PDF.js keeps both copies), or the
        /// page has text at an angle. The window then reads the page itself.
        exact: bool,
    }

    impl TextReader {
        /// Close the text document (the file was rewritten, or the worker is idle).
        pub fn close(&mut self) {
            if let (Some(api), Some(doc)) = (self.api.as_ref(), self.doc.take()) {
                // Safety: a document this reader opened and has not closed.
                unsafe { (api.close_doc)(doc.handle) };
            }
        }

        pub fn forget(&mut self, path: &str) {
            if self.doc.as_ref().is_some_and(|d| d.path == path) {
                self.close();
            }
        }

        fn document(&mut self, path: &str) -> Result<Handle> {
            if self.api.is_none() {
                self.api = Some(Api::open()?);
            }
            let file = std::fs::File::open(path).with_context(|| format!("open {}", path))?;
            let meta = file.metadata()?;
            let (mtime, len) = (meta.modified().ok(), meta.len());
            if let Some(d) = &self.doc {
                if d.path == path && d.mtime == mtime && d.len == len {
                    return Ok(d.handle);
                }
            }
            self.close();
            let api = self.api.as_ref().expect("opened above");
            let mut source = Box::new(Source { file });
            let mut access = Box::new(FileAccess {
                len: c_ulong::try_from(len).map_err(|_| anyhow!("file too large for PDFium"))?,
                get_block,
                param: &mut *source as *mut Source as *mut c_void,
            });
            // Safety: `access` and `source` stay boxed in the Doc until close.
            let handle = unsafe { (api.load_custom)(&mut *access, std::ptr::null()) };
            if handle.is_null() {
                return Err(anyhow!("PDFium parse failed"));
            }
            self.doc = Some(Doc { path: path.to_string(), mtime, len, handle, _access: access, _source: source });
            Ok(handle)
        }

        /// The text items of page `page_index` as JSON `{"items":[...],"view":[...]}`.
        pub fn page_text_json(&mut self, path: &str, page_index: u32) -> Result<Vec<u8>> {
            let doc = self.document(path)?;
            let api = self.api.as_ref().expect("opened");
            // Safety: every handle below is opened here and closed before return.
            unsafe {
                let page = (api.load_page)(doc, page_index as c_int);
                if page.is_null() {
                    return Err(anyhow!("page {}: not readable", page_index));
                }
                let text = (api.text_load)(page);
                if text.is_null() {
                    (api.close_page)(page);
                    return Err(anyhow!("page text: not readable"));
                }
                let result = read_page(api, page, text);
                (api.text_close)(text);
                (api.close_page)(page);
                let (glyphs, view, exact) = result?;
                let items = group(&glyphs, view);
                Ok(serde_json::to_vec(&Out { items: &items, view, exact })?)
            }
        }
    }

    fn rect(f: unsafe extern "C" fn(Handle, *mut c_float, *mut c_float, *mut c_float, *mut c_float) -> c_int, page: Handle) -> Option<[f64; 4]> {
        let (mut l, mut b, mut r, mut t) = (0.0, 0.0, 0.0, 0.0);
        // Safety: an open page handle.
        (unsafe { f(page, &mut l, &mut b, &mut r, &mut t) } != 0)
            .then(|| [l.min(r) as f64, b.min(t) as f64, l.max(r) as f64, b.max(t) as f64])
    }

    const TEXT_OBJECT: c_int = 1;
    const FORM_OBJECT: c_int = 5;

    /// An affine matrix [a, b, c, d, e, f] (PDF order).
    type Affine = [f64; 6];
    const IDENTITY: Affine = [1.0, 0.0, 0.0, 1.0, 0.0, 0.0];

    /// `m` then `n`: a point mapped by `m`, then by `n`.
    fn then(m: Affine, n: Affine) -> Affine {
        [
            m[0] * n[0] + m[1] * n[2], m[0] * n[1] + m[1] * n[3],
            m[2] * n[0] + m[3] * n[2], m[2] * n[1] + m[3] * n[3],
            m[4] * n[0] + m[5] * n[2] + n[4], m[4] * n[1] + m[5] * n[3] + n[5],
        ]
    }

    fn apply(m: Affine, (x, y): (f64, f64)) -> (f64, f64) {
        (m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5])
    }

    /// A text object of the page: the form XObject that draws it (0: the
    /// page itself) and the matrix from its form's space to the page.
    struct TextObject { object: usize, form: usize, to_page: Affine }

    /// Every text object of the page in content order.
    unsafe fn text_objects(api: &Api, page: Handle) -> Vec<TextObject> {
        fn walk(api: &Api, objects: &mut Vec<TextObject>, form: usize, to_page: Affine, children: Vec<Handle>) {
            for object in children {
                // Safety: handles from the page or a form object of it.
                match unsafe { (api.object_type)(object) } {
                    TEXT_OBJECT => objects.push(TextObject { object: object as usize, form, to_page }),
                    FORM_OBJECT => {
                        let mut m = FsMatrix { a: 1.0, b: 0.0, c: 0.0, d: 1.0, e: 0.0, f: 0.0 };
                        unsafe { (api.object_matrix)(object, &mut m) };
                        let placed = [m.a, m.b, m.c, m.d, m.e, m.f].map(|v| v as f64);
                        let n = unsafe { (api.form_count)(object) }.max(0);
                        let inner = (0..n).map(|i| unsafe { (api.form_object)(object, i as c_ulong) }).collect();
                        walk(api, objects, object as usize, then(placed, to_page), inner);
                    }
                    _ => {}
                }
            }
        }
        let n = unsafe { (api.count_objects)(page) }.max(0);
        let top = (0..n).map(|i| unsafe { (api.get_object)(page, i) }).collect();
        let mut objects = Vec::new();
        walk(api, &mut objects, 0, IDENTITY, top);
        objects
    }

    /// The page's characters in content order, its visible box, and whether
    /// they are all of the text PDF.js reads (see Out::exact).
    unsafe fn read_page(api: &Api, page: Handle, text: Handle) -> Result<(Vec<Glyph>, [f64; 4], bool)> {
        let media = rect(api.media_box, page);
        let crop = rect(api.crop_box, page);
        let view = match (media, crop) {
            (Some(m), Some(c)) => {
                let v = [m[0].max(c[0]), m[1].max(c[1]), m[2].min(c[2]), m[3].min(c[3])];
                if v[0] < v[2] && v[1] < v[3] { v } else { m }
            }
            (Some(m), None) => m,
            (None, Some(c)) => c,
            (None, None) => [f64::MIN, f64::MIN, f64::MAX, f64::MAX],
        };
        let objects = unsafe { text_objects(api, page) };
        let form_of: std::collections::HashMap<usize, usize> = objects.iter().map(|o| (o.object, o.form)).collect();
        // Where each text object comes in the content stream.
        let order_of: std::collections::HashMap<usize, usize> = objects.iter().enumerate().map(|(i, o)| (o.object, i)).collect();
        // The glyphs' content order: PDFium's text page orders characters
        // by their place on the line, PDF.js reads them as drawn.
        let mut order: Vec<usize> = Vec::new();
        let mut last_order = 0usize;
        // Per text object: how far its kept characters reach along the
        // baseline (from the first origin to the last advance), to hold
        // against the extent the object is drawn over.
        let mut reach: std::collections::HashMap<usize, (f64, f64, (f64, f64), f64)> = std::collections::HashMap::new();
        let mut exact = true;
        let count = unsafe { (api.count_chars)(text) };
        let mut glyphs = Vec::with_capacity(count.max(0) as usize);
        // The text object each glyph was drawn by.
        let mut owner: Vec<usize> = Vec::new();
        // Looked up for every glyph: maps, so a dense sheet (one text object
        // per glyph, as exploded CAD text is) stays linear.
        let mut fonts: std::collections::HashMap<usize, u32> = std::collections::HashMap::new();
        let mut segments: std::collections::HashMap<usize, u64> = std::collections::HashMap::new(); // text object -> segment id
        let mut segment_ids: std::collections::HashMap<(Vec<usize>, usize), u64> = std::collections::HashMap::new();
        for i in 0..count {
            unsafe {
                if (api.generated)(text, i) == 1 {
                    continue;
                }
                let hyphen = (api.hyphen)(text, i) == 1;
                let code = (api.unicode)(text, i);
                // Half of a UTF-16 pair (PDFium's wchar_t on Windows): the
                // character cannot be told here, so the page is not exact.
                if (0xD800..=0xDFFF).contains(&code) {
                    exact = false;
                    continue;
                }
                let ch = if hyphen { '-' } else {
                    match char::from_u32(code) {
                        Some(c) if c != '\0' && !(c.is_control() && !c.is_whitespace()) => c,
                        _ => continue,
                    }
                };
                let (mut x, mut y) = (0.0, 0.0);
                if (api.origin)(text, i, &mut x, &mut y) == 0 {
                    exact = false;
                    continue;
                }
                let mut m = FsMatrix { a: 0.0, b: 0.0, c: 0.0, d: 0.0, e: 0.0, f: 0.0 };
                if (api.matrix)(text, i, &mut m) == 0 {
                    continue;
                }
                let matrix = [m.a as f64, m.b as f64, m.c as f64, m.d as f64];
                let dir = unit(matrix[0], matrix[1]).unwrap_or((1.0, 0.0));
                // Text at an angle: the loose box (upright) does not give its
                // advance, so the page is read by PDF.js.
                if dir.0.abs() > 1e-3 && dir.1.abs() > 1e-3 {
                    exact = false;
                }
                let mut r = FsRect { left: 0.0, top: 0.0, right: 0.0, bottom: 0.0 };
                let advance = if (api.loose_box)(text, i, &mut r) != 0 {
                    [(r.left, r.bottom), (r.right, r.bottom), (r.left, r.top), (r.right, r.top)]
                        .iter()
                        .map(|&(px, py)| dot((px as f64 - x, py as f64 - y), dir))
                        .fold(0.0_f64, f64::max)
                } else { 0.0 };
                let object = (api.text_object)(text, i);
                if !object.is_null() {
                    let along = dot((x, y), dir);
                    let size = (api.font_size)(text, i) * matrix[2].hypot(matrix[3]);
                    let e = reach.entry(object as usize).or_insert((along, along, dir, size));
                    e.0 = e.0.min(along);
                    e.1 = e.1.max(along + advance);
                }
                let font_ptr = if object.is_null() { 0 } else { (api.object_font)(object) as usize };
                let next_font = fonts.len() as u32;
                let font = *fonts.entry(font_ptr).or_insert(next_font);
                let segment = match segments.get(&(object as usize)) {
                    Some(&id) => id,
                    None => {
                        // The object's marked content, item by item (each BDC/BMC its own item).
                        let marks: Vec<usize> = if object.is_null() { Vec::new() } else {
                            (0..(api.count_marks)(object).max(0)).map(|k| (api.get_mark)(object, k as c_ulong) as usize).collect()
                        };
                        let key = (marks, form_of.get(&(object as usize)).copied().unwrap_or(usize::MAX));
                        let next = segment_ids.len() as u64;
                        let id = *segment_ids.entry(key).or_insert(next);
                        segments.insert(object as usize, id);
                        id
                    }
                };
                last_order = order_of.get(&(object as usize)).copied().unwrap_or(last_order);
                order.push(last_order);
                owner.push(object as usize);
                glyphs.push(Glyph {
                    ch,
                    origin: (x, y),
                    matrix,
                    font_size: (api.font_size)(text, i),
                    font,
                    advance,
                    segment,
                });
            }
        }
        // Each text object's bounds in page space (form bounds are in the form's).
        let bounds: Vec<Option<[f64; 4]>> = objects.iter().map(|o| {
            let (mut l, mut b, mut r, mut t) = (0.0, 0.0, 0.0, 0.0);
            // Safety: a text object of this page.
            if unsafe { (api.object_bounds)(o.object as Handle, &mut l, &mut b, &mut r, &mut t) } == 0 {
                return None;
            }
            let pts = [(l, b), (r, b), (l, t), (r, t)].map(|(px, py)| apply(o.to_page, (px as f64, py as f64)));
            let xs = pts.map(|p| p.0);
            let ys = pts.map(|p| p.1);
            Some([
                xs.iter().cloned().fold(f64::MAX, f64::min), ys.iter().cloned().fold(f64::MAX, f64::min),
                xs.iter().cloned().fold(f64::MIN, f64::max), ys.iter().cloned().fold(f64::MIN, f64::max),
            ])
        }).collect();
        // The glyphs each text object drew (indexes into `glyphs`).
        let mut by_owner: std::collections::HashMap<usize, Vec<usize>> = std::collections::HashMap::new();
        for (gi, &w) in owner.iter().enumerate() {
            by_owner.entry(w).or_default().push(gi);
        }
        // Text drawn twice over itself: PDFium keeps the first copy only (it
        // compares a text object with the few before it), PDF.js reads both.
        // A dropped copy is drawn again from the copy kept: the nearest
        // earlier object of the same size it overlaps, moved by the
        // difference of their bounds, in the dropped object's own place.
        for (k, o) in objects.iter().enumerate() {
            let Some(bk) = bounds[k] else { continue };
            if !(bk[2] - bk[0] > 0.01 && bk[3] - bk[1] > 0.01) || reach.contains_key(&o.object) {
                continue;
            }
            let twin = (k.saturating_sub(8)..k).rev().filter_map(|j| {
                let bj = bounds[j]?;
                let size = reach.get(&objects[j].object)?.3.max(1.0);
                let same_size = (bj[2] - bj[0] - (bk[2] - bk[0])).abs() <= 0.5 && (bj[3] - bj[1] - (bk[3] - bk[1])).abs() <= 0.5;
                let shift = (bk[0] - bj[0]).hypot(bk[1] - bj[1]);
                (same_size && shift < size).then_some((j, shift))
            }).min_by(|a, b| a.1.total_cmp(&b.1));
            let Some((j, _)) = twin else { continue };
            let bj = bounds[j].expect("twin has bounds");
            let (dx, dy) = (bk[0] - bj[0], bk[1] - bj[1]);
            let marks: Vec<usize> = (0..unsafe { (api.count_marks)(o.object as Handle) }.max(0))
                .map(|m| unsafe { (api.get_mark)(o.object as Handle, m as c_ulong) } as usize)
                .collect();
            let key = (marks, o.form);
            let next = segment_ids.len() as u64;
            let segment = *segment_ids.entry(key).or_insert(next);
            let copies: Vec<Glyph> = by_owner.get(&objects[j].object).into_iter().flatten()
                .map(|&gi| { let g = &glyphs[gi]; Glyph { origin: (g.origin.0 + dx, g.origin.1 + dy), segment, ..g.clone() } })
                .collect();
            let twin_reach = reach[&objects[j].object];
            for g in copies {
                // A later copy may be drawn from this one.
                by_owner.entry(o.object).or_default().push(glyphs.len());
                glyphs.push(g);
                order.push(k);
                owner.push(o.object);
            }
            let along = dot((dx, dy), twin_reach.2);
            reach.insert(o.object, (twin_reach.0 + along, twin_reach.1 + along, twin_reach.2, twin_reach.3));
        }
        // A text object PDFium kept no characters of (and no copy was drawn
        // again), or fewer than it draws: the page is not exact.
        for (k, o) in objects.iter().enumerate() {
            let Some(bk) = bounds[k] else { continue };
            if !(bk[2] - bk[0] > 0.01 && bk[3] - bk[1] > 0.01) {
                continue;
            }
            match reach.get(&o.object) {
                None => { exact = false; break; }
                Some(&(start, end, dir, size)) => {
                    let corners = [(bk[0], bk[1]), (bk[2], bk[1]), (bk[0], bk[3]), (bk[2], bk[3])].map(|p| dot(p, dir));
                    let lo = corners.iter().cloned().fold(f64::MAX, f64::min);
                    let hi = corners.iter().cloned().fold(f64::MIN, f64::max);
                    // The kept characters reach the object's ends, within half
                    // a character (bounds are glyph outlines, reach advances).
                    let slack = 0.5 * size.max(1.0);
                    if start - lo > slack || hi - end > slack {
                        exact = false;
                        break;
                    }
                }
            }
        }
        // Back into content order: by text object, PDFium's order within one.
        let mut keyed: Vec<(usize, usize, Glyph)> = glyphs.into_iter().enumerate().map(|(i, g)| (order[i], i, g)).collect();
        keyed.sort_by_key(|&(o, i, _)| (o, i));
        let glyphs = keyed.into_iter().map(|(_, _, g)| g).collect();
        Ok((glyphs, view, exact))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const VIEW: [f64; 4] = [0.0, 0.0, 1224.0, 792.0];

    /// A line of text at 10 pt, each glyph 6 pt wide unless a gap is given.
    fn line(text: &str, x0: f64, y: f64, gaps: &[(usize, f64)]) -> Vec<Glyph> {
        let mut x = x0;
        text.chars().enumerate().map(|(i, ch)| {
            if let Some((_, gap)) = gaps.iter().find(|(at, _)| *at == i) { x += gap; }
            let g = Glyph { ch, origin: (x, y), matrix: [1.0, 0.0, 0.0, 1.0], font_size: 10.0, font: 0, advance: 6.0, segment: 0 };
            x += 6.0;
            g
        }).collect()
    }

    fn strs(items: &[Item]) -> Vec<&str> {
        items.iter().map(|i| i.str.as_str()).collect()
    }

    #[test]
    fn a_word_is_one_item_with_its_advance_as_width() {
        let items = group(&line("PANEL", 100.0, 500.0, &[]), VIEW);
        assert_eq!(strs(&items), ["PANEL"]);
        assert_eq!(items[0].transform, [10.0, 0.0, 0.0, 10.0, 100.0, 500.0]);
        assert_eq!(items[0].width, 30.0);
        assert_eq!(items[0].height, 10.0);
    }

    #[test]
    fn an_explicit_space_stays_in_the_item() {
        let items = group(&line("LP 1", 100.0, 500.0, &[]), VIEW);
        assert_eq!(strs(&items), ["LP 1"]);
    }

    #[test]
    fn a_gap_within_the_flow_becomes_a_space_and_a_wide_gap_a_new_item() {
        // 3 pt (0.3 of the size): a space in the same item.
        assert_eq!(strs(&group(&line("AB", 0.0, 500.0, &[(1, 3.0)]), VIEW)), ["A B"]);
        // 1 pt (under 0.102): no space.
        assert_eq!(strs(&group(&line("AB", 0.0, 500.0, &[(1, 1.0)]), VIEW)), ["AB"]);
        // 7 pt (over 0.6): two items.
        assert_eq!(strs(&group(&line("AB", 0.0, 500.0, &[(1, 7.0)]), VIEW)), ["A", "B"]);
    }

    #[test]
    fn a_new_line_or_a_jump_back_starts_a_new_item() {
        let mut glyphs = line("ONE", 100.0, 500.0, &[]);
        glyphs.extend(line("TWO", 100.0, 488.0, &[]));
        assert_eq!(strs(&group(&glyphs, VIEW)), ["ONE", "TWO"]);
        // Same line, back to the left of the earlier text.
        let mut back = line("RIGHT", 300.0, 500.0, &[]);
        back.extend(line("LEFT", 100.0, 500.0, &[]));
        assert_eq!(strs(&group(&back, VIEW)), ["RIGHT", "LEFT"]);
    }

    #[test]
    fn a_change_of_font_or_size_ends_the_item() {
        let mut glyphs = line("AB", 100.0, 500.0, &[]);
        glyphs[1].font = 1;
        assert_eq!(strs(&group(&glyphs, VIEW)), ["A", "B"]);
        let mut sized = line("AB", 100.0, 500.0, &[]);
        sized[1].font_size = 12.0;
        assert_eq!(strs(&group(&sized, VIEW)), ["A", "B"]);
    }

    #[test]
    fn a_small_shift_off_the_line_ends_the_item_after_the_glyph_before_it() {
        let mut glyphs = line("AB", 100.0, 500.0, &[]);
        glyphs[1].origin.1 += 3.0; // over a quarter of the height
        assert_eq!(strs(&group(&glyphs, VIEW)), ["A", "B"]);
        let mut slight = line("AB", 100.0, 500.0, &[]);
        slight[1].origin.1 += 1.0;
        assert_eq!(strs(&group(&slight, VIEW)), ["AB"]);
    }

    #[test]
    fn turned_text_runs_along_its_own_baseline() {
        // Rotated 90°: baseline up the page, glyphs stacked on y.
        let glyphs: Vec<Glyph> = "E-101".chars().enumerate().map(|(i, ch)| Glyph {
            ch, origin: (50.0, 100.0 + 6.0 * i as f64), matrix: [0.0, 1.0, -1.0, 0.0], font_size: 10.0, font: 0, advance: 6.0, segment: 0,
        }).collect();
        let items = group(&glyphs, VIEW);
        assert_eq!(strs(&items), ["E-101"]);
        assert_eq!(items[0].transform, [0.0, 10.0, -10.0, 0.0, 50.0, 100.0]);
        assert_eq!(items[0].width, 30.0);
    }

    #[test]
    fn a_scaled_matrix_scales_the_item_size_and_the_thresholds() {
        // Font size 1 drawn through a matrix of 10: the same as 10 pt.
        let glyphs: Vec<Glyph> = line("AB", 0.0, 500.0, &[(1, 3.0)]).into_iter()
            .map(|g| Glyph { matrix: [10.0, 0.0, 0.0, 10.0], font_size: 1.0, ..g }).collect();
        let items = group(&glyphs, VIEW);
        assert_eq!(strs(&items), ["A B"]);
        assert_eq!(items[0].height, 10.0);
    }

    #[test]
    fn the_gap_is_measured_in_the_text_space_of_the_glyph_drawn() {
        // "42" drawn 1.12 times larger through its matrix, same Tf size: a
        // 5.46 pt gap is 4.88 in its text space, under 0.6 of the size: a space.
        let mut glyphs = line("SPACE", 0.0, 500.0, &[]);
        glyphs.iter_mut().for_each(|g| g.font_size = 8.5);
        let x = 30.0 + 5.46;
        for (i, ch) in "42".chars().enumerate() {
            glyphs.push(Glyph { ch, origin: (x + 6.7 * i as f64, 500.0), matrix: [1.1176, 0.0, 0.0, 1.1176], font_size: 8.5, font: 0, advance: 6.7, segment: 0 });
        }
        assert_eq!(strs(&group(&glyphs, VIEW)), ["SPACE 42"]);
    }

    #[test]
    fn marked_content_or_a_form_ends_the_item() {
        // Two cells of a schedule that touch: PDF.js keeps them apart when
        // each is its own marked content.
        let mut glyphs = line("3332", 100.0, 500.0, &[]);
        glyphs[2].segment = 1;
        glyphs[3].segment = 1;
        assert_eq!(strs(&group(&glyphs, VIEW)), ["33", "32"]);
    }

    #[test]
    fn glyphs_outside_the_visible_box_are_left_out() {
        let mut glyphs = line("IN", 100.0, 500.0, &[]);
        glyphs.extend(line("OUT", 2000.0, 500.0, &[]));
        assert_eq!(strs(&group(&glyphs, VIEW)), ["IN"]);
    }
}
