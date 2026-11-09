// The MCP `tools/list` descriptor table in mcp_server.rs is one large
// `serde_json::json!` literal; its recursive macro expansion exceeds the
// default limit of 128 once the tool count grew past ~30.
#![recursion_limit = "256"]

mod atomic_file;
pub mod byte_lru;
mod addon_management;
mod edition_helper;
mod display_list_cache;
pub mod cad_export;
pub mod cad_import;
pub mod datamap;
mod identity_migration;
mod email;
pub mod linux_runtime;
pub mod logboek;
pub mod mcp_addon_tools;
pub mod mcp_app_bridge;
pub mod mcp_koppeling;
pub mod mcp_server;
pub mod mcp_tool_meta;
// OCR (Tesseract) is desktop only; Android has no Tesseract build.
#[cfg(not(target_os = "android"))]
pub mod ocr;
pub mod pdfium_renderer;
pub mod handtekening;
pub mod print_formulieren;
pub mod print_instelling;
pub mod print_plaatsing;
// DEVMODE-hulp, de printerlijst uit de spooler en de GDI-printkern: alleen
// Windows.
#[cfg(target_os = "windows")]
pub mod print_devmode;
#[cfg(target_os = "windows")]
pub mod print_lijst;
#[cfg(target_os = "windows")]
mod standaard_app;
#[cfg(target_os = "windows")]
pub mod print_windows;
pub mod render_to_png;
mod remote_pdf;
mod ocr_font_scope;
pub mod window_mgmt;
pub mod startup_diagnostics;
mod generated_backing;
mod template_scope;
mod reader_position_scope;
mod file_range;
pub mod worker_pool;

pub struct StartupOpts {
    pub mcp_server: bool,
    pub mcp_port: u16,
}

impl Default for StartupOpts {
    fn default() -> Self {
        Self { mcp_server: false, mcp_port: 9223 }
    }
}

use std::fs;
use std::fs::File;
use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use base64::{Engine as _, engine::general_purpose::STANDARD as BASE64};
use tauri::{Emitter, Manager};
use tauri_plugin_fs::FsExt;

const APP_STORAGE_DIR: &str = "OcuDrawCommunity";
const APP_PRODUCT_NAME: &str = "Oculith Draw Foundation";

/// The installed product name: a distributor's installer may set its own.
#[cfg_attr(not(target_os = "linux"), allow(dead_code))]
fn app_product_name(app: &tauri::AppHandle) -> String {
    app.config().product_name.clone().unwrap_or_else(|| APP_PRODUCT_NAME.to_string())
}

/// tauri-bundler names the Linux launcher after the product name.
#[cfg_attr(not(target_os = "linux"), allow(dead_code))]
fn app_desktop_file(app: &tauri::AppHandle) -> String {
    format!("{}.desktop", app_product_name(app))
}

// Store the file paths passed via command line
struct OpenedFiles(Mutex<Vec<String>>);

// Add-on files opened with the app; the frontend asks before installing them.
struct OpenedAddonFiles(Mutex<Vec<String>>);

fn is_addon_file_arg(arg: &str) -> bool {
    !arg.starts_with('-') && arg.to_lowercase().ends_with(".ocaddon")
}

#[tauri::command(async)]
fn addon_opened_files_take(state: tauri::State<OpenedAddonFiles>) -> Vec<String> {
    std::mem::take(&mut *state.0.lock().unwrap())
}

// Store locked file handles to prevent other apps from writing
struct LockedFiles(Mutex<HashMap<String, File>>);

// Cache PDF file bytes to avoid re-reading from disk on every render call.
// Byte-bounded LRU: a long session over many large sets no longer keeps
// every file it ever opened. The newest file always stays, however large.
const PDF_BYTES_CACHE_MAX_BYTES: usize = 768 * 1024 * 1024;
const PDF_BYTES_CACHE_MAX_ENTRIES: usize = 16;

struct PdfBytes {
    files: byte_lru::ByteLru<String, Arc<Vec<u8>>>,
    // Bumped by every removal. A read that ran outside the lock enters the
    // cache only if nothing was invalidated meanwhile, so a save can never
    // be followed by an older read landing in the cache.
    epoch: u64,
}

struct PdfBytesCache(Mutex<PdfBytes>);

impl Default for PdfBytesCache {
    fn default() -> Self {
        Self(Mutex::new(PdfBytes {
            files: byte_lru::ByteLru::new(PDF_BYTES_CACHE_MAX_ENTRIES, PDF_BYTES_CACHE_MAX_BYTES),
            epoch: 0,
        }))
    }
}

impl PdfBytesCache {
    fn remove(&self, path: &str) -> Result<(), String> {
        let mut cache = self.0.lock().map_err(|e| format!("Bytes cache lock: {}", e))?;
        cache.files.remove(path);
        cache.epoch += 1;
        Ok(())
    }

    fn clear(&self) -> Result<(), String> {
        let mut cache = self.0.lock().map_err(|e| format!("Bytes cache lock: {}", e))?;
        cache.files.clear();
        cache.epoch += 1;
        Ok(())
    }
}

/// The file's bytes, from the cache or read once. Shared, not copied: a
/// clone per call was a full copy of the file (hundreds of MB on a set).
/// The read runs without the cache lock, so a cold read of one large file
/// does not hold up every other document's lookups.
fn cached_pdf_bytes(bytes_cache: &PdfBytesCache, path: &str) -> Result<Arc<Vec<u8>>, String> {
    let epoch = {
        let mut cache = bytes_cache.0.lock().map_err(|e| format!("Bytes cache lock: {}", e))?;
        if let Some(cached) = cache.files.get(path) {
            return Ok(cached.clone());
        }
        cache.epoch
    };
    let read = Arc::new(fs::read(path).map_err(|e| format!("Read: {}", e))?);
    let mut cache = bytes_cache.0.lock().map_err(|e| format!("Bytes cache lock: {}", e))?;
    if cache.epoch != epoch {
        // Invalidated while reading: use this read once, cache nothing.
        return Ok(read);
    }
    if let Some(cached) = cache.files.get(path) {
        return Ok(cached.clone()); // a concurrent read won the race
    }
    let size = read.len();
    let evicted = cache.files.insert(path.to_string(), read.clone(), size);
    drop(cache);
    drop(evicted);
    Ok(read)
}

// Cache parsed DocumentHandle objects so the font registry inside each
// handle survives across page renders. The handle holds a Mutex<FontRegistry>
// internally — extracting glyph outlines for a font (the dominant cost on
// text-heavy pages) only runs the first time that font is encountered in
// the document. Without this cache every Tauri command would create a
// fresh DocumentHandle and re-extract every glyph from scratch.
struct DocHandleCache(Mutex<display_list_cache::GenerationCache<open_pdf_render::DocumentHandle>>);

/// Gebouwde TileScenes voor het zware-blad-tegelpad (route A): één scene is
/// de complete display-list + chunk-index (~140-300 MB op extreme CAD-bladen)
/// en vervangt de ~1,1 GB PDFium-parse-state per worker. Cap 2: actief blad +
/// vergelijk-/vorig blad. Key: pad|mtime|len|pagina|rotatie.
struct TileSceneCache(Mutex<Vec<(String, Arc<open_pdf_render::tile_render::TileScene>)>>);
const TILE_SCENE_CACHE_CAP: usize = 2;

/// Cache for already-rendered thumbnails. Keyed by (path, page, max_width, rotation).
/// Hits return instantly without touching the renderer or JPEG encoder, which
/// makes scrolling back to previously-rendered pages essentially free.
/// Bounded: a long session no longer keeps every thumbnail it rendered.
struct ThumbnailCache(Mutex<byte_lru::ByteLru<(String, u32, u32, i32), String>>);
const THUMBNAIL_CACHE_MAX_BYTES: usize = 32 * 1024 * 1024;
const THUMBNAIL_CACHE_MAX_ENTRIES: usize = 2048;

impl Default for ThumbnailCache {
    fn default() -> Self {
        Self(Mutex::new(byte_lru::ByteLru::new(THUMBNAIL_CACHE_MAX_ENTRIES, THUMBNAIL_CACHE_MAX_BYTES)))
    }
}

/// Cache for `analyze_page_type` results. Keyed by (path, page_index). The
/// underlying lopdf classifier is cheap on most pages but for construction
/// PDFs with multi-megabyte content streams the size-shortcut in
/// `analyze_page_type` keeps it fast even cold; this cache makes warm hits
/// effectively free (HashMap lookup) so per-page navigation has zero analyze
/// cost after the first visit (or after `analyze_page_type_batch` warms it).
struct PageTypeCache(Mutex<HashMap<(String, u32), String>>);

/// Page-point area of additive parts minus holes. Without the `geos` feature
/// the desktop shell answers with an error and the measurement keeps the
/// shoelace total. See docs/GEOS.md.
// Commands marked `command(async)` run on the async runtime's threads, not
// the main thread: a plain synchronous command waits for the window's event
// loop, and file, session and page commands measured a fixed ~1 s each while
// the app was busy. Commands that touch windows, dialogs, the clipboard or
// the desktop stay plain.
#[tauri::command(async)]
fn geos_net_area(parts: Vec<Vec<[f64; 2]>>, holes: Vec<Vec<[f64; 2]>>) -> Result<f64, String> {
    #[cfg(feature = "geos")]
    {
        let parts = rings_from_pairs(parts);
        let holes = rings_from_pairs(holes);
        return open_pdf_geos::net_area(&parts, &holes).map_err(|err| err.to_string());
    }
    #[cfg(not(feature = "geos"))]
    {
        let _ = (parts, holes);
        Err("geometry engine is not linked".into())
    }
}

/// One polygonal takeoff: additive rings, then rings already classified as holes.
#[derive(serde::Deserialize)]
#[cfg_attr(not(feature = "geos"), allow(dead_code))]
struct GeosAreaShape {
    parts: Vec<Vec<[f64; 2]>>,
    #[serde(default)]
    holes: Vec<Vec<[f64; 2]>>,
}

/// Page-point area of the union of several shapes. Without the `geos` feature
/// the desktop shell answers with an error and the schedule keeps the sum of
/// its rows. See docs/GEOS.md.
#[tauri::command(async)]
fn geos_group_net_area(shapes: Vec<GeosAreaShape>) -> Result<f64, String> {
    #[cfg(feature = "geos")]
    {
        let shapes = shapes
            .into_iter()
            .map(|shape| open_pdf_geos::AreaShape {
                parts: rings_from_pairs(shape.parts),
                holes: rings_from_pairs(shape.holes),
            })
            .collect::<Vec<_>>();
        return open_pdf_geos::group_net_area(&shapes).map_err(|err| err.to_string());
    }
    #[cfg(not(feature = "geos"))]
    {
        let _ = shapes;
        Err("geometry engine is not linked".into())
    }
}

/// Crossing points of two open page-space paths. Without the `geos` feature
/// the desktop shell answers with an error and the trim keeps the segment
/// crossing already applied in JavaScript. See docs/GEOS.md.
#[tauri::command(async)]
fn geos_crossings(a: Vec<[f64; 2]>, b: Vec<[f64; 2]>) -> Result<Vec<[f64; 2]>, String> {
    #[cfg(feature = "geos")]
    {
        let a: Vec<(f64, f64)> = a.into_iter().map(|point| (point[0], point[1])).collect();
        let b: Vec<(f64, f64)> = b.into_iter().map(|point| (point[0], point[1])).collect();
        return open_pdf_geos::crossing_points(&a, &b)
            .map(|points| points.into_iter().map(|(x, y)| [x, y]).collect())
            .map_err(|err| err.to_string());
    }
    #[cfg(not(feature = "geos"))]
    {
        let _ = (a, b);
        Err("geometry engine is not linked".into())
    }
}

/// One-sided parallel of a committed offset. Without the `geos` feature the
/// desktop shell answers with an error and the copy keeps the JavaScript
/// mitre. See docs/GEOS.md.
#[tauri::command(async)]
fn geos_offset_curve(
    points: Vec<[f64; 2]>,
    distance: f64,
    side: f64,
    closed: bool,
) -> Result<Vec<[f64; 2]>, String> {
    #[cfg(feature = "geos")]
    {
        let line: Vec<(f64, f64)> = points.into_iter().map(|point| (point[0], point[1])).collect();
        return open_pdf_geos::offset_curve(&line, distance, side, closed)
            .map(|curve| curve.into_iter().map(|(x, y)| [x, y]).collect())
            .map_err(|err| err.to_string());
    }
    #[cfg(not(feature = "geos"))]
    {
        let _ = (points, distance, side, closed);
        Err("geometry engine is not linked".into())
    }
}

/// True when `(x, y)` is strictly inside `ring`. A point on the boundary is false.
/// Without the `geos` feature the desktop shell answers with an error.
#[tauri::command(async)]
fn geos_contains(ring: Vec<[f64; 2]>, x: f64, y: f64) -> Result<bool, String> {
    #[cfg(feature = "geos")]
    {
        let ring: Vec<(f64, f64)> = ring.into_iter().map(|point| (point[0], point[1])).collect();
        return open_pdf_geos::contains_point(&ring, x, y).map_err(|err| err.to_string());
    }
    #[cfg(not(feature = "geos"))]
    {
        let _ = (ring, x, y);
        Err("geometry engine is not linked".into())
    }
}

/// True when `(x, y)` is inside `ring` or on its boundary.
/// Without the `geos` feature the desktop shell answers with an error.
#[tauri::command(async)]
fn geos_covers(ring: Vec<[f64; 2]>, x: f64, y: f64) -> Result<bool, String> {
    #[cfg(feature = "geos")]
    {
        let ring: Vec<(f64, f64)> = ring.into_iter().map(|point| (point[0], point[1])).collect();
        return open_pdf_geos::covers_point(&ring, x, y).map_err(|err| err.to_string());
    }
    #[cfg(not(feature = "geos"))]
    {
        let _ = (ring, x, y);
        Err("geometry engine is not linked".into())
    }
}

/// Douglas-Peucker reduction. `tolerance` is page points.
/// Without the `geos` feature the desktop shell answers with an error.
#[tauri::command(async)]
fn geos_simplify(
    points: Vec<[f64; 2]>,
    tolerance: f64,
    closed: bool,
) -> Result<Vec<[f64; 2]>, String> {
    #[cfg(feature = "geos")]
    {
        let line: Vec<(f64, f64)> = points.into_iter().map(|point| (point[0], point[1])).collect();
        return open_pdf_geos::simplify_line(&line, tolerance, closed)
            .map(|curve| curve.into_iter().map(|(x, y)| [x, y]).collect())
            .map_err(|err| err.to_string());
    }
    #[cfg(not(feature = "geos"))]
    {
        let _ = (points, tolerance, closed);
        Err("geometry engine is not linked".into())
    }
}

/// One polygonized face. `shell` and each hole omit the repeated first point.
#[derive(serde::Serialize)]
#[cfg_attr(not(feature = "geos"), allow(dead_code))]
struct GeosFace {
    shell: Vec<[f64; 2]>,
    holes: Vec<Vec<[f64; 2]>>,
    area: f64,
}

/// Closed faces of page-space linework. A line that does not close adds no face.
/// Without the `geos` feature the desktop shell answers with an error.
#[tauri::command(async)]
fn geos_polygonize(lines: Vec<Vec<[f64; 2]>>) -> Result<Vec<GeosFace>, String> {
    #[cfg(feature = "geos")]
    {
        let lines = rings_from_pairs(lines);
        return open_pdf_geos::polygonize(&lines)
            .map(|faces| faces.into_iter().map(geos_face).collect())
            .map_err(|err| err.to_string());
    }
    #[cfg(not(feature = "geos"))]
    {
        let _ = lines;
        Err("geometry engine is not linked".into())
    }
}

#[cfg(feature = "geos")]
fn geos_face(face: open_pdf_geos::PolygonFace) -> GeosFace {
    GeosFace {
        shell: face.shell.into_iter().map(|(x, y)| [x, y]).collect(),
        holes: face
            .holes
            .into_iter()
            .map(|hole| hole.into_iter().map(|(x, y)| [x, y]).collect())
            .collect(),
        area: face.area,
    }
}

/// Page-point area of the intersection of two simple rings.
/// Without the `geos` feature the desktop shell answers with an error.
#[tauri::command(async)]
fn geos_intersection_area(a: Vec<[f64; 2]>, b: Vec<[f64; 2]>) -> Result<f64, String> {
    #[cfg(feature = "geos")]
    {
        let a: Vec<(f64, f64)> = a.into_iter().map(|point| (point[0], point[1])).collect();
        let b: Vec<(f64, f64)> = b.into_iter().map(|point| (point[0], point[1])).collect();
        return open_pdf_geos::intersection_area(&a, &b).map_err(|err| err.to_string());
    }
    #[cfg(not(feature = "geos"))]
    {
        let _ = (a, b);
        Err("geometry engine is not linked".into())
    }
}

/// Page-point area of ring `a` minus ring `b`.
/// Without the `geos` feature the desktop shell answers with an error.
#[tauri::command(async)]
fn geos_difference_area(a: Vec<[f64; 2]>, b: Vec<[f64; 2]>) -> Result<f64, String> {
    #[cfg(feature = "geos")]
    {
        let a: Vec<(f64, f64)> = a.into_iter().map(|point| (point[0], point[1])).collect();
        let b: Vec<(f64, f64)> = b.into_iter().map(|point| (point[0], point[1])).collect();
        return open_pdf_geos::difference_area(&a, &b).map_err(|err| err.to_string());
    }
    #[cfg(not(feature = "geos"))]
    {
        let _ = (a, b);
        Err("geometry engine is not linked".into())
    }
}

#[cfg(feature = "geos")]
fn rings_from_pairs(rings: Vec<Vec<[f64; 2]>>) -> Vec<Vec<(f64, f64)>> {
    rings
        .into_iter()
        .map(|ring| ring.into_iter().map(|point| (point[0], point[1])).collect())
        .collect()
}

#[tauri::command(async)]
fn get_opened_file(state: tauri::State<OpenedFiles>) -> Vec<String> {
    state.0.lock().unwrap().clone()
}

#[tauri::command(async)]
fn get_session_file_path() -> String {
    if let Some(data_dir) = datamap::lokale_datamap() {
        let app_dir = data_dir.join(APP_STORAGE_DIR);
        if !app_dir.exists() {
            let _ = fs::create_dir_all(&app_dir);
        }
        app_dir.join("session.json").to_string_lossy().to_string()
    } else {
        "session.json".to_string()
    }
}

#[tauri::command(async)]
fn save_session(data: String) -> Result<bool, String> {
    let path = get_session_file_path();
    atomic_file::write(std::path::Path::new(&path), data.as_bytes()).map_err(|e| e.to_string())?;
    Ok(true)
}

#[tauri::command(async)]
fn load_session() -> Option<String> {
    let path = get_session_file_path();
    fs::read_to_string(&path).ok()
}

fn get_preferences_file_path() -> String {
    if let Some(data_dir) = datamap::lokale_datamap() {
        let app_dir = data_dir.join(APP_STORAGE_DIR);
        if !app_dir.exists() {
            let _ = fs::create_dir_all(&app_dir);
        }
        app_dir.join("preferences.json").to_string_lossy().to_string()
    } else {
        "preferences.json".to_string()
    }
}

#[tauri::command(async)]
fn save_preferences(data: String) -> Result<bool, String> {
    let path = get_preferences_file_path();
    atomic_file::write(std::path::Path::new(&path), data.as_bytes()).map_err(|e| e.to_string())?;
    Ok(true)
}

#[tauri::command(async)]
fn load_preferences() -> Option<String> {
    let path = get_preferences_file_path();
    fs::read_to_string(&path).ok()
}

// Symboolcatalogi als losse bestanden naast preferences.json (#354): grote
// gedownloade collecties horen niet in het instellingenbestand — dat wordt
// bij elke voorkeurswijziging integraal herschreven en de localStorage-
// spiegel kent een quotum. Kleine catalogi blijven gewoon inline in de
// voorkeuren; alleen grote landen hier (beide opties bestaan naast elkaar).
fn get_catalogs_dir() -> std::path::PathBuf {
    let basis = datamap::lokale_datamap().unwrap_or_else(|| std::path::PathBuf::from("."));
    let dir = basis.join(APP_STORAGE_DIR).join("catalogs");
    if !dir.exists() {
        let _ = fs::create_dir_all(&dir);
    }
    dir
}

/// Catalogus-id -> veilige bestandsnaam: alleen alfanumeriek, '-', '_' en
/// '.'; al het andere wordt '_'. Voorkomt padtrucs via het id.
fn veilige_catalogus_bestandsnaam(id: &str) -> String {
    let schoon: String = id
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() || c == '-' || c == '_' || c == '.' { c } else { '_' })
        .collect();
    let schoon = schoon.trim_matches('.').to_string();
    let schoon = if schoon.is_empty() { "catalogus".to_string() } else { schoon };
    format!("{}.json", schoon)
}

#[tauri::command(async)]
fn save_catalog(id: String, data: String) -> Result<bool, String> {
    let path = get_catalogs_dir().join(veilige_catalogus_bestandsnaam(&id));
    atomic_file::write(&path, data.as_bytes()).map_err(|e| e.to_string())?;
    Ok(true)
}

#[tauri::command(async)]
fn load_catalog(id: String) -> Option<String> {
    let path = get_catalogs_dir().join(veilige_catalogus_bestandsnaam(&id));
    fs::read_to_string(&path).ok()
}

#[tauri::command(async)]
fn delete_catalog(id: String) -> Result<bool, String> {
    let path = get_catalogs_dir().join(veilige_catalogus_bestandsnaam(&id));
    match fs::remove_file(&path) {
        Ok(_) => Ok(true),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(false),
        Err(e) => Err(e.to_string()),
    }
}

#[tauri::command(async)]
fn get_username() -> String {
    whoami::username()
}

/// Optional editor add-on. The command shape is kept for existing clients.
/// A release serves verified script bytes as an asset; development sends the
/// script over IPC because its pages come from the development server.
///
/// An edition plug-in may be split into module files (`modules`, under
/// `chunks/`) that plugin.js imports on demand. A release serves them beside
/// plugin.js; the program-text form carries their text in `modules`.
#[derive(serde::Serialize)]
struct EditionPlugin {
    url: Option<String>,
    js: Option<String>,
    css: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    modules: Option<HashMap<String, String>>,
}

#[derive(serde::Serialize)]
struct EditionPluginEntry {
    id: String,
    kind: &'static str,
    url: Option<String>,
    js: Option<String>,
    css: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    modules: Option<HashMap<String, String>>,
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct AddonManifest {
    schema_version: u32,
    id: String,
    version: String,
    host_api_version: u32,
    editor_version: String,
    #[serde(default, deserialize_with = "deserialize_addon_target")]
    target: Option<AddonTarget>,
    files: HashMap<String, String>,
    helper: Option<String>,
    sidecars: Option<Vec<String>>,
    /// Edition packages: the further module files plugin.js imports (each
    /// also listed and hashed in `files`).
    modules: Option<Vec<String>>,
}

#[derive(serde::Deserialize)]
#[serde(deny_unknown_fields)]
struct AddonTarget {
    os: String,
    arch: String,
}

fn deserialize_addon_target<'de, D: serde::Deserializer<'de>>(deserializer: D) -> Result<Option<AddonTarget>, D::Error> {
    <AddonTarget as serde::Deserialize>::deserialize(deserializer).map(Some)
}

fn addon_target_matches(target: &AddonTarget) -> bool {
    if !matches!(target.os.as_str(), "linux" | "windows" | "macos")
        || !matches!(target.arch.as_str(), "x64" | "arm64" | "universal")
        || (target.arch == "universal" && target.os != "macos") {
        return false;
    }
    let os = std::env::consts::OS;
    let arch = match std::env::consts::ARCH {
        "x86_64" => "x64",
        "x86" => "ia32",
        "aarch64" => "arm64",
        other => other,
    };
    target.os == os && (target.arch == arch || (os == "macos" && target.arch == "universal"))
}

fn addon_manifest_target_compatible(manifest: &AddonManifest) -> bool {
    let native_files = manifest.helper.is_some() || manifest.files.keys().any(|name| name.starts_with("bin/"));
    match &manifest.target {
        Some(target) => addon_target_matches(target),
        None => !native_files,
    }
}

struct SelectedAddon {
    id: String,
    script: Vec<u8>,
    css: String,
    helper: Option<(std::path::PathBuf, String)>,
    bundled: bool,
    files: Option<HashMap<String, String>>,
    /// The verified package directory, when the add-on is a full package.
    root: Option<std::path::PathBuf>,
    /// The plug-in's further module files and their verified bytes, served
    /// under /edition/ beside plugin.js.
    modules: Vec<(String, Vec<u8>)>,
}

/// Selection is fixed for the process lifetime. An add-on update takes effect
/// on restart, so the script and helper cannot silently come from two versions.
static SELECTED_ADDON: std::sync::OnceLock<Option<SelectedAddon>> = std::sync::OnceLock::new();
static VERIFIED_PACKAGES: std::sync::OnceLock<Vec<VerifiedPackage>> = std::sync::OnceLock::new();
const EDITION_URL_PREFIX: &str = "/edition/";
/// Where an edition plug-in's further module files live in its directory.
const EDITION_MODULE_DIR: &str = "chunks/";
const MAX_EDITION_MODULES: usize = 48;
const MAX_EDITION_MODULE_BYTES: u64 = 64 * 1024 * 1024;

/// A module file name: `chunks/<name>.js`, one plain file name.
fn valid_edition_module_name(name: &str) -> bool {
    name.strip_prefix(EDITION_MODULE_DIR).and_then(|rest| rest.strip_suffix(".js"))
        .is_some_and(|stem| !stem.is_empty() && stem.len() <= 128 && !stem.starts_with('.')
            && stem.bytes().all(|b| b.is_ascii_alphanumeric() || matches!(b, b'.' | b'-' | b'_')))
}

/// Read the listed module files, each checked against its manifest hash.
/// The bytes kept are the bytes checked, so what is served is what was verified.
fn verified_edition_modules(root: &std::path::Path, names: &[String], files: &HashMap<String, String>) -> Option<Vec<(String, Vec<u8>)>> {
    if names.len() > MAX_EDITION_MODULES { return None; }
    let mut modules: Vec<(String, Vec<u8>)> = Vec::with_capacity(names.len());
    let mut total = 0u64;
    for name in names {
        if !valid_edition_module_name(name) || modules.iter().any(|(seen, _)| seen == name) { return None; }
        let bytes = read_bounded_addon_file(&addon_file(root, name)?, MAX_EDITION_MODULE_BYTES)?;
        if bytes.is_empty() || !sha256_bytes_match(&bytes, files.get(name)?) { return None; }
        std::str::from_utf8(&bytes).ok()?;
        total += bytes.len() as u64;
        if total > MAX_EDITION_MODULE_BYTES { return None; }
        modules.push((name.clone(), bytes));
    }
    Some(modules)
}

/// The module files beside an unpackaged (bundled or development) plug-in:
/// every `chunks/*.js` file, without links.
fn bundled_edition_modules(root: &std::path::Path) -> Option<Vec<(String, Vec<u8>)>> {
    let dir = root.join(EDITION_MODULE_DIR.trim_end_matches('/'));
    let Ok(meta) = fs::symlink_metadata(&dir) else { return Some(Vec::new()); };
    if !meta.is_dir() { return None; }
    let mut names = Vec::new();
    for entry in fs::read_dir(&dir).ok()? {
        let entry = entry.ok()?;
        let name = format!("{EDITION_MODULE_DIR}{}", entry.file_name().to_str()?);
        if !valid_edition_module_name(&name) { continue; }
        names.push(name);
    }
    names.sort();
    if names.len() > MAX_EDITION_MODULES { return None; }
    let mut modules = Vec::with_capacity(names.len());
    for name in names {
        let bytes = read_bounded_addon_file(&addon_file(root, &name)?, MAX_EDITION_MODULE_BYTES)?;
        std::str::from_utf8(&bytes).ok()?;
        modules.push((name, bytes));
    }
    Some(modules)
}

fn module_texts(modules: &[(String, Vec<u8>)]) -> Option<HashMap<String, String>> {
    if modules.is_empty() { return None; }
    modules.iter().map(|(name, bytes)| String::from_utf8(bytes.clone()).ok().map(|text| (name.clone(), text))).collect()
}
const HOST_API_VERSION: u32 = 1;
const MAX_ENABLED_PACKAGES: usize = 64;

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct EnabledAddons {
    schema_version: u32,
    ids: Vec<String>,
}

struct VerifiedPackage {
    id: String,
    script: Vec<u8>,
    css: String,
    helper: Option<(std::path::PathBuf, String)>,
    sidecars: Vec<(String, String)>,
}

fn addon_helper_name() -> &'static str { if cfg!(windows) { "helper.exe" } else { "helper" } }

fn addon_companion_name(index: usize) -> String {
    format!("companion-{index}{}", if cfg!(windows) { ".exe" } else { "" })
}

fn addon_helper_header(path: &std::path::Path) -> bool {
    use std::io::Read;
    let Ok(mut file) = fs::File::open(path) else { return false; };
    let mut bytes = [0u8; 4096];
    let Ok(size) = file.read(&mut bytes) else { return false; };
    let bytes = &bytes[..size];
    match std::env::consts::OS {
        "linux" => {
            let machine = match std::env::consts::ARCH { "x86_64" => 62, "aarch64" => 183, _ => return false };
            bytes.len() >= 20 && bytes.starts_with(b"\x7fELF") && bytes[4] == 2 && bytes[5] == 1
                && u16::from_le_bytes([bytes[18], bytes[19]]) == machine
        }
        "windows" => {
            if bytes.len() < 64 || !bytes.starts_with(b"MZ") { return false; }
            let offset = u32::from_le_bytes(bytes[60..64].try_into().unwrap()) as usize;
            let machine = match std::env::consts::ARCH { "x86_64" => 0x8664, "aarch64" => 0xaa64, _ => return false };
            offset <= bytes.len().saturating_sub(6) && &bytes[offset..offset + 4] == b"PE\0\0"
                && u16::from_le_bytes([bytes[offset + 4], bytes[offset + 5]]) == machine
        }
        "macos" => {
            let machine = match std::env::consts::ARCH { "x86_64" => 0x01000007, "aarch64" => 0x0100000c, _ => return false };
            bytes.len() >= 8 && u32::from_le_bytes(bytes[0..4].try_into().unwrap()) == 0xfeedfacf
                && u32::from_le_bytes(bytes[4..8].try_into().unwrap()) == machine
        }
        _ => false,
    }
}

fn verified_helper_file(path: &std::path::Path, expected: &str) -> bool {
    let Ok(meta) = fs::symlink_metadata(path) else { return false; };
    if !meta.is_file() || meta.file_type().is_symlink() || meta.len() == 0 || meta.len() > 128 * 1024 * 1024 { return false; }
    #[cfg(unix)] {
        use std::os::unix::fs::PermissionsExt;
        if meta.permissions().mode() & 0o111 == 0 { return false; }
    }
    addon_hash_matches(path, expected) && addon_helper_header(path)
}

fn valid_addon_id(id: &str) -> bool {
    !id.is_empty() && id.len() <= 128
        && id.bytes().next().is_some_and(|b| b.is_ascii_alphanumeric())
        && id.bytes().all(|b| b.is_ascii_alphanumeric() || matches!(b, b'.' | b'-' | b'_'))
}

fn valid_addon_version(version: &str) -> bool {
    !version.is_empty() && version.len() <= 64
        && version.bytes().all(|b| b.is_ascii_alphanumeric() || matches!(b, b'.' | b'-' | b'+' | b'_'))
}

fn addon_relative_path(name: &str) -> Option<std::path::PathBuf> {
    use std::path::Component;
    if name.is_empty() || name.contains('\\') || name.contains(':') || name.split('/').any(|part| part == "." || part == "..") { return None; }
    let path = std::path::Path::new(name);
    if path.components().any(|part| !matches!(part, Component::Normal(_))) { return None; }
    Some(path.to_owned())
}

fn addon_file(root: &std::path::Path, name: &str) -> Option<std::path::PathBuf> {
    if fs::symlink_metadata(root).ok()?.file_type().is_symlink() { return None; }
    let relative = addon_relative_path(name)?;
    let mut path = root.to_owned();
    for part in relative.components() {
        path.push(part);
        if fs::symlink_metadata(&path).ok()?.file_type().is_symlink() { return None; }
    }
    if !path.is_file() { return None; }
    let real_root = dunce::canonicalize(root).ok()?;
    let real_file = dunce::canonicalize(&path).ok()?;
    real_file.starts_with(real_root).then_some(path)
}

fn sha256_file(path: &std::path::Path) -> Option<String> {
    use sha2::{Digest, Sha256};
    use std::io::Read;
    let mut file = fs::File::open(path).ok()?;
    let mut digest = Sha256::new();
    let mut buffer = [0u8; 64 * 1024];
    loop {
        let count = file.read(&mut buffer).ok()?;
        if count == 0 { break; }
        digest.update(&buffer[..count]);
    }
    Some(format!("{:x}", digest.finalize()))
}

fn addon_hash_matches(path: &std::path::Path, expected: &str) -> bool {
    expected.len() == 64
        && expected.bytes().all(|b| b.is_ascii_hexdigit())
        && sha256_file(path).is_some_and(|hash| hash.eq_ignore_ascii_case(expected))
}

fn sha256_bytes_match(bytes: &[u8], expected: &str) -> bool {
    use sha2::{Digest, Sha256};
    expected.len() == 64
        && expected.bytes().all(|b| b.is_ascii_hexdigit())
        && format!("{:x}", Sha256::digest(bytes)).eq_ignore_ascii_case(expected)
}

fn read_bounded_addon_file(path: &std::path::Path, limit: u64) -> Option<Vec<u8>> {
    use std::io::Read;
    let file = fs::File::open(path).ok()?;
    if file.metadata().ok()?.len() > limit { return None; }
    let mut bytes = Vec::new();
    file.take(limit + 1).read_to_end(&mut bytes).ok()?;
    (bytes.len() as u64 <= limit).then_some(bytes)
}

fn user_addon(app: &tauri::AppHandle) -> Option<SelectedAddon> {
    let addons = datamap::tauri_map(app, datamap::TauriMap::Data).ok()?.join("addons");
    let root = addons.join("active");
    if fs::symlink_metadata(&addons).ok()?.file_type().is_symlink()
        || fs::symlink_metadata(&root).ok()?.file_type().is_symlink() { return None; }
    verified_edition_package(&root, &app.package_info().version.to_string())
}

/// The full edition package rules, shared by the startup loader and the
/// in-app installer so both accept exactly the same packages.
fn verified_edition_package(root: &std::path::Path, editor_version: &str) -> Option<SelectedAddon> {
    if fs::symlink_metadata(root).ok()?.file_type().is_symlink() { return None; }
    let manifest_path = addon_file(root, "manifest.json")?;
    if manifest_path.metadata().ok()?.len() > 1024 * 1024 { return None; }
    let manifest: AddonManifest = serde_json::from_slice(&fs::read(manifest_path).ok()?).ok()?;
    if manifest.schema_version != 1 || manifest.host_api_version != HOST_API_VERSION
        || !addon_manifest_target_compatible(&manifest)
        || manifest.editor_version != editor_version
        || !valid_addon_version(&manifest.version)
        || manifest.id.is_empty()
        || !manifest.id.bytes().next().is_some_and(|b| b.is_ascii_alphanumeric())
        || !manifest.id.bytes().all(|b| b.is_ascii_alphanumeric() || matches!(b, b'.' | b'-' | b'_')) {
        return None;
    }
    if manifest.files.len() > 64 || !manifest.files.contains_key("plugin.js") { return None; }
    if manifest.helper.as_ref().is_some_and(|name| !manifest.files.contains_key(name)) { return None; }
    for (name, expected) in &manifest.files {
        let path = addon_file(root, name)?;
        if !addon_hash_matches(&path, expected) { return None; }
    }
    let script_path = addon_file(root, "plugin.js")?;
    if script_path.metadata().ok()?.len() > 64 * 1024 * 1024 { return None; }
    let script = fs::read(script_path).ok()?;
    if script.is_empty() || !sha256_bytes_match(&script, manifest.files.get("plugin.js")?) { return None; }
    let css = if manifest.files.contains_key("plugin.css") {
        let css_path = addon_file(root, "plugin.css")?;
        if css_path.metadata().ok()?.len() > 16 * 1024 * 1024 { return None; }
        let bytes = fs::read(css_path).ok()?;
        if !sha256_bytes_match(&bytes, manifest.files.get("plugin.css")?) { return None; }
        String::from_utf8(bytes).ok()?
    } else { String::new() };
    let modules = verified_edition_modules(root, manifest.modules.as_deref().unwrap_or(&[]), &manifest.files)?;
    let helper = if let Some(name) = manifest.helper {
        Some((addon_file(root, &name)?, manifest.files.get(&name)?.clone()))
    } else { None };
    Some(SelectedAddon { id: manifest.id, script, css, helper, bundled: false, files: Some(manifest.files), root: Some(root.to_path_buf()), modules })
}

fn bundled_addon(app: &tauri::AppHandle) -> Option<SelectedAddon> {
    let root = if tauri::is_dev() {
        std::env::var_os("OCUDRAW_EDITION_PLUGIN_DIR")
            .map(std::path::PathBuf::from)
            .unwrap_or(app.path().resource_dir().ok()?.join("edition"))
    } else {
        app.path().resource_dir().ok()?.join("edition")
    };
    let script = fs::read(root.join("plugin.js")).ok()?;
    if script.is_empty() { return None; }
    let css = fs::read_to_string(root.join("plugin.css")).unwrap_or_default();
    let modules = bundled_edition_modules(&root)?;
    Some(SelectedAddon { id: "bundled.edition".into(), script, css, helper: None, bundled: true, files: None, root: None, modules })
}

/// The directory of a full edition package that a distributor ships inside
/// the installer (its resources). It is checked exactly like an installed one.
pub(crate) fn bundled_edition_package_dir(app: &tauri::AppHandle) -> Option<std::path::PathBuf> {
    if tauri::is_dev() {
        if let Some(dir) = std::env::var_os("OCUDRAW_EDITION_PACKAGE_DIR") { return Some(dir.into()); }
    }
    Some(app.path().resource_dir().ok()?.join("edition-package"))
}

pub(crate) fn bundled_edition_package(app: &tauri::AppHandle) -> Option<SelectedAddon> {
    verified_edition_package(&bundled_edition_package_dir(app)?, &app.package_info().version.to_string())
}

fn selected_addon(app: &tauri::AppHandle) -> Option<&'static SelectedAddon> {
    // A package the user installed, then one shipped with this installation.
    SELECTED_ADDON.get_or_init(|| user_addon(app)
        .or_else(|| bundled_edition_package(app))
        .or_else(|| bundled_addon(app))).as_ref()
}

fn enabled_addon_ids(addons: &std::path::Path) -> Vec<String> {
    let Some(index_path) = addon_file(addons, "enabled.json") else { return Vec::new(); };
    let Some(bytes) = read_bounded_addon_file(&index_path, 64 * 1024) else { return Vec::new(); };
    let Ok(index) = serde_json::from_slice::<EnabledAddons>(&bytes) else { return Vec::new(); };
    if index.schema_version != 1 || index.ids.len() > MAX_ENABLED_PACKAGES { return Vec::new(); }
    let mut seen = std::collections::HashSet::new();
    index.ids.into_iter().filter(|id| valid_addon_id(id) && seen.insert(id.clone())).collect()
}

pub(crate) fn package_helper_enabled(app: &tauri::AppHandle, id: &str) -> bool {
    if !valid_addon_id(id) { return false; }
    let Ok(data) = datamap::tauri_map(app, datamap::TauriMap::Data) else { return false; };
    enabled_addon_ids(&data.join("addons")).iter().any(|enabled| enabled == id)
}

fn verified_package(root: &std::path::Path, id: &str, editor_version: &str) -> Option<VerifiedPackage> {
    if !valid_addon_id(id) || fs::symlink_metadata(root).ok()?.file_type().is_symlink() { return None; }
    let manifest_path = addon_file(root, "manifest.json")?;
    let manifest: AddonManifest = serde_json::from_slice(&read_bounded_addon_file(&manifest_path, 1024 * 1024)?).ok()?;
    let sidecars = manifest.sidecars.as_deref().unwrap_or(&[]);
    if !matches!(manifest.schema_version, 2 | 3 | 4) || manifest.host_api_version != HOST_API_VERSION
        || manifest.modules.is_some()
        || manifest.id != id || manifest.editor_version != editor_version
        || !valid_addon_version(&manifest.version)
        || !addon_manifest_target_compatible(&manifest)
        || (manifest.schema_version == 2 && manifest.helper.is_some())
        || (manifest.schema_version < 4 && manifest.sidecars.is_some())
        || (manifest.schema_version == 4 &&
            (sidecars.is_empty() || sidecars.len() > 4 || sidecars.iter().enumerate()
                .any(|(index, name)| name != &addon_companion_name(index + 1))))
        || (manifest.schema_version >= 3 &&
            (manifest.helper.as_deref() != Some(addon_helper_name()) || manifest.target.is_none()
                || manifest.target.as_ref().is_some_and(|target| target.arch == "universal")))
        || manifest.files.is_empty() || manifest.files.len() > if manifest.schema_version == 2 { 3 } else { 4 + sidecars.len() }
        || !manifest.files.contains_key("plugin.js")
        || (manifest.schema_version >= 3 && !manifest.files.contains_key(addon_helper_name()))
        || (manifest.schema_version == 4 && !manifest.files.contains_key("NOTICES.txt"))
        || sidecars.iter().any(|name| !manifest.files.contains_key(name))
        || manifest.files.keys().any(|name| name != "plugin.js" && name != "plugin.css" && name != "NOTICES.txt"
            && !(manifest.schema_version >= 3 && name == addon_helper_name()) && !sidecars.contains(name)) {
        return None;
    }
    let mut listed = 0;
    for entry in fs::read_dir(root).ok()? {
        let entry = entry.ok()?;
        let name = entry.file_name();
        let name = name.to_str()?;
        let allowed = name == "manifest.json" || manifest.files.contains_key(name);
        let kind = entry.file_type().ok()?;
        if !allowed || !kind.is_file() || kind.is_symlink() { return None; }
        listed += 1;
        if listed > manifest.files.len() + 1 { return None; }
    }
    if listed != manifest.files.len() + 1 { return None; }
    let script_path = addon_file(root, "plugin.js")?;
    let script = read_bounded_addon_file(&script_path, 64 * 1024 * 1024)?;
    if script.is_empty() { return None; }
    if !sha256_bytes_match(&script, manifest.files.get("plugin.js")?) { return None; }
    std::str::from_utf8(&script).ok()?;
    let css = if let Some(expected) = manifest.files.get("plugin.css") {
        let css_path = addon_file(root, "plugin.css")?;
        let bytes = read_bounded_addon_file(&css_path, 16 * 1024 * 1024)?;
        if bytes.is_empty() { return None; }
        if !sha256_bytes_match(&bytes, expected) { return None; }
        String::from_utf8(bytes).ok()?
    } else { String::new() };
    if let Some(expected) = manifest.files.get("NOTICES.txt") {
        let path = addon_file(root, "NOTICES.txt")?;
        let bytes = read_bounded_addon_file(&path, 4 * 1024 * 1024)?;
        if bytes.is_empty() || !sha256_bytes_match(&bytes, expected) { return None; }
        std::str::from_utf8(&bytes).ok()?;
    }
    for name in sidecars {
        let path = addon_file(root, name)?;
        if !verified_helper_file(&path, manifest.files.get(name)?) { return None; }
    }
    let helper = if manifest.schema_version >= 3 {
        let path = addon_file(root, addon_helper_name())?;
        let hash = manifest.files.get(addon_helper_name())?;
        if !verified_helper_file(&path, hash) { return None; }
        Some((path, hash.clone()))
    } else { None };
    let sidecars = sidecars.iter().map(|name| (name.clone(), manifest.files.get(name).unwrap().clone())).collect();
    Some(VerifiedPackage { id: id.into(), script, css, helper, sidecars })
}

fn verified_packages(app: &tauri::AppHandle) -> &'static [VerifiedPackage] {
    VERIFIED_PACKAGES.get_or_init(|| {
        let Some(addons) = datamap::tauri_map(app, datamap::TauriMap::Data).ok().map(|path| path.join("addons")) else { return Vec::new(); };
        if fs::symlink_metadata(&addons).ok().is_none_or(|meta| meta.file_type().is_symlink()) { return Vec::new(); }
        let packages = addons.join("packages");
        if fs::symlink_metadata(&packages).ok().is_none_or(|meta| meta.file_type().is_symlink()) { return Vec::new(); }
        let editor_version = app.package_info().version.to_string();
        enabled_addon_ids(&addons).into_iter()
            .filter_map(|id| verified_package(&packages.join(&id), &id, &editor_version))
            .collect()
    })
}

pub(crate) fn selected_helper_available(app: &tauri::AppHandle) -> bool {
    let Some(selected) = selected_addon(app) else { return false; };
    if selected.helper.is_some() { return true; }
    selected.bundled && selected_helper_path(app).is_some()
}

pub(crate) fn selected_helper_path(app: &tauri::AppHandle) -> Option<std::path::PathBuf> {
    let selected = selected_addon(app)?;
    if let Some((path, expected)) = &selected.helper {
        let root = selected.root.as_ref()?;
        if fs::symlink_metadata(root).ok()?.file_type().is_symlink() { return None; }
        let name = path.strip_prefix(root).ok()?.to_str()?;
        let checked = addon_file(root, name)?;
        for (name, expected) in selected.files.as_ref()? {
            if !addon_hash_matches(&addon_file(root, name)?, expected) { return None; }
        }
        return addon_hash_matches(&checked, expected).then_some(checked);
    }
    if !selected.bundled { return None; }
    // A bundled editor can supply a helper through its own trusted install.
    None
}

pub(crate) fn package_helper_path(app: &tauri::AppHandle, id: &str) -> Option<std::path::PathBuf> {
    if !package_helper_enabled(app, id) { return None; }
    let package = verified_packages(app).iter().find(|package| package.id == id)?;
    let (path, expected) = package.helper.as_ref()?;
    let addons = datamap::tauri_map(app, datamap::TauriMap::Data).ok()?.join("addons");
    let root = addons.join("packages").join(id);
    let checked = addon_file(&root, addon_helper_name())?;
    if &checked != path || !verified_helper_file(&checked, expected) { return None; }
    for (name, expected) in &package.sidecars {
        if !verified_helper_file(&addon_file(&root, name)?, expected) { return None; }
    }
    Some(checked)
}

#[tauri::command(async)]
fn edition_plugin(app: tauri::AppHandle, inline: Option<bool>) -> Option<EditionPlugin> {
    let addon = selected_addon(&app)?;
    if tauri::is_dev() || inline.unwrap_or(false) {
        let js = String::from_utf8(addon.script.clone()).ok()?;
        let modules = module_texts(&addon.modules);
        if modules.is_none() && !addon.modules.is_empty() { return None; }
        return Some(EditionPlugin { url: None, js: Some(js), css: addon.css.clone(), modules });
    }
    Some(EditionPlugin { url: Some(format!("{EDITION_URL_PREFIX}plugin.js")), js: None, css: addon.css.clone(), modules: None })
}

#[tauri::command(async)]
fn edition_plugins(app: tauri::AppHandle, inline: Option<bool>) -> Vec<EditionPluginEntry> {
    let use_inline = tauri::is_dev() || inline.unwrap_or(false);
    let mut entries = Vec::new();
    if let Some(selected) = selected_addon(&app) {
        if use_inline {
            let modules = module_texts(&selected.modules);
            if let (Ok(js), true) = (String::from_utf8(selected.script.clone()), modules.is_some() || selected.modules.is_empty()) {
                entries.push(EditionPluginEntry {
                    id: selected.id.clone(), kind: "edition",
                    url: None, js: Some(js), css: selected.css.clone(), modules,
                });
            }
        } else {
            entries.push(EditionPluginEntry {
                id: selected.id.clone(), kind: "edition",
                url: Some(format!("{EDITION_URL_PREFIX}plugin.js")), js: None, css: selected.css.clone(), modules: None,
            });
        }
    }
    for package in verified_packages(&app) {
        if entries.iter().any(|entry| entry.id == package.id) { continue; }
        let js = if use_inline { String::from_utf8(package.script.clone()).ok() } else { None };
        if use_inline && js.is_none() { continue; }
        entries.push(EditionPluginEntry {
            id: package.id.clone(), kind: "contribution",
            url: (!use_inline).then(|| format!("{EDITION_URL_PREFIX}packages/{}/plugin.js", package.id)),
            js, css: package.css.clone(), modules: None,
        });
    }
    entries
}

/// The editor's files and verified add-on scripts under `/edition/`.
struct EditionAssets<R: tauri::Runtime>(Box<dyn tauri::Assets<R>>);

impl<R: tauri::Runtime> tauri::Assets<R> for EditionAssets<R> {
    fn setup(&self, app: &tauri::App<R>) {
        self.0.setup(app)
    }

    fn get(&self, key: &tauri::utils::assets::AssetKey) -> Option<std::borrow::Cow<'_, [u8]>> {
        if key.as_ref() == "/edition/plugin.js" {
            if let Some(addon) = SELECTED_ADDON.get().and_then(Option::as_ref) {
                return Some(std::borrow::Cow::Borrowed(&addon.script));
            }
        }
        if let Some(name) = key.as_ref().strip_prefix(EDITION_URL_PREFIX).filter(|name| name.starts_with(EDITION_MODULE_DIR)) {
            if let Some(addon) = SELECTED_ADDON.get().and_then(Option::as_ref) {
                if let Some((_, bytes)) = addon.modules.iter().find(|(listed, _)| listed == name) {
                    return Some(std::borrow::Cow::Borrowed(bytes));
                }
            }
        }
        if let Some(id) = key.as_ref().strip_prefix("/edition/packages/").and_then(|path| path.strip_suffix("/plugin.js")) {
            if let Some(package) = VERIFIED_PACKAGES.get().and_then(|packages| packages.iter().find(|package| package.id == id)) {
                return Some(std::borrow::Cow::Borrowed(&package.script));
            }
        }
        self.0.get(key)
    }

    fn iter(&self) -> Box<tauri::utils::assets::AssetsIter<'_>> {
        self.0.iter()
    }

    fn csp_hashes(
        &self,
        html_path: &tauri::utils::assets::AssetKey,
    ) -> Box<dyn Iterator<Item = tauri::utils::assets::CspHash<'_>> + '_> {
        self.0.csp_hashes(html_path)
    }
}

#[cfg(test)]
mod addon_tests {
    use super::*;

    fn addon_test_dir() -> std::path::PathBuf {
        let unique = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos();
        let root = std::env::temp_dir().join(format!("oculith-multi-addon-test-{}-{unique}", std::process::id()));
        fs::create_dir_all(&root).unwrap();
        root
    }

    fn write_test_package(packages: &std::path::Path, id: &str, script: &[u8]) {
        let root = packages.join(id);
        fs::create_dir_all(&root).unwrap();
        fs::write(root.join("plugin.js"), script).unwrap();
        fs::write(root.join("manifest.json"), serde_json::to_vec(&serde_json::json!({
            "schemaVersion": 2, "id": id, "version": "1.0.0", "hostApiVersion": HOST_API_VERSION,
            "editorVersion": "2026.68.0", "files": { "plugin.js": sha256_file(&root.join("plugin.js")).unwrap() }
        })).unwrap()).unwrap();
    }

    fn write_split_edition(root: &std::path::Path, chunks: &[(&str, &[u8])]) -> serde_json::Value {
        fs::create_dir_all(root.join("chunks")).unwrap();
        fs::write(root.join("plugin.js"), b"export const start = () => import('./chunks/panel-a1.js');").unwrap();
        let mut files = serde_json::Map::new();
        files.insert("plugin.js".into(), sha256_file(&root.join("plugin.js")).unwrap().into());
        let mut modules = Vec::new();
        for (name, bytes) in chunks {
            fs::write(root.join(name), bytes).unwrap();
            files.insert((*name).into(), sha256_file(&root.join(name)).unwrap().into());
            modules.push(serde_json::Value::from(*name));
        }
        let manifest = serde_json::json!({
            "schemaVersion": 1, "id": "split.edition", "version": "2026.68.0", "hostApiVersion": HOST_API_VERSION,
            "editorVersion": "2026.68.0", "files": files, "modules": modules,
        });
        fs::write(root.join("manifest.json"), serde_json::to_vec(&manifest).unwrap()).unwrap();
        manifest
    }

    #[test]
    fn edition_package_module_files_are_verified_and_kept_as_checked() {
        let root = addon_test_dir();
        let edition = root.join("edition");
        let mut manifest = write_split_edition(&edition, &[("chunks/panel-a1.js", b"export default 1;"), ("chunks/shared-b2.js", b"export const x = 2;")]);
        let selected = verified_edition_package(&edition, "2026.68.0").expect("split package");
        assert_eq!(selected.modules.iter().map(|(name, _)| name.as_str()).collect::<Vec<_>>(), ["chunks/panel-a1.js", "chunks/shared-b2.js"]);
        assert_eq!(selected.modules[0].1, b"export default 1;");
        assert_eq!(module_texts(&selected.modules).unwrap()["chunks/shared-b2.js"], "export const x = 2;");

        // A changed module file fails the package, like a changed plugin.js.
        fs::write(edition.join("chunks/shared-b2.js"), b"tampered").unwrap();
        assert!(verified_edition_package(&edition, "2026.68.0").is_none());
        fs::write(edition.join("chunks/shared-b2.js"), b"export const x = 2;").unwrap();
        assert!(verified_edition_package(&edition, "2026.68.0").is_some());

        // Every module must be a listed, hashed chunks/<name>.js file.
        for bad in ["chunks/missing-c3.js", "plugin.js", "chunks/../plugin.js", "chunks/a/b.js", "other/panel.js", "chunks/.hidden.js", "chunks/panel.mjs"] {
            let mut changed = manifest.clone();
            changed["modules"].as_array_mut().unwrap().push(bad.into());
            if bad == "chunks/missing-c3.js" { changed["files"][bad] = "0".repeat(64).into(); }
            fs::write(edition.join("manifest.json"), serde_json::to_vec(&changed).unwrap()).unwrap();
            assert!(verified_edition_package(&edition, "2026.68.0").is_none(), "{bad}");
        }
        let mut repeated = manifest.clone();
        repeated["modules"].as_array_mut().unwrap().push("chunks/panel-a1.js".into());
        fs::write(edition.join("manifest.json"), serde_json::to_vec(&repeated).unwrap()).unwrap();
        assert!(verified_edition_package(&edition, "2026.68.0").is_none());

        // A single-file package (no modules) still loads.
        manifest.as_object_mut().unwrap().remove("modules");
        fs::write(edition.join("manifest.json"), serde_json::to_vec(&manifest).unwrap()).unwrap();
        assert!(verified_edition_package(&edition, "2026.68.0").unwrap().modules.is_empty());
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn unpackaged_plugin_modules_are_the_chunk_files_beside_it() {
        let root = addon_test_dir();
        assert!(bundled_edition_modules(&root).unwrap().is_empty());
        fs::create_dir_all(root.join("chunks")).unwrap();
        fs::write(root.join("chunks/b-2.js"), b"export const b = 2;").unwrap();
        fs::write(root.join("chunks/a-1.js"), b"export const a = 1;").unwrap();
        fs::write(root.join("chunks/notes.txt"), b"ignored").unwrap();
        let modules = bundled_edition_modules(&root).unwrap();
        assert_eq!(modules.iter().map(|(name, _)| name.as_str()).collect::<Vec<_>>(), ["chunks/a-1.js", "chunks/b-2.js"]);
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn independent_packages_cannot_carry_module_files() {
        let root = addon_test_dir();
        let packages = root.join("packages");
        write_test_package(&packages, "first.addon", b"export default 1;");
        let package = packages.join("first.addon");
        let mut manifest: serde_json::Value = serde_json::from_slice(&fs::read(package.join("manifest.json")).unwrap()).unwrap();
        manifest["modules"] = serde_json::json!([]);
        fs::write(package.join("manifest.json"), serde_json::to_vec(&manifest).unwrap()).unwrap();
        assert!(verified_package(&package, "first.addon", "2026.68.0").is_none());
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn enabled_index_filters_invalid_and_duplicate_ids() {
        let root = addon_test_dir();
        fs::write(root.join("enabled.json"), r#"{"schemaVersion":1,"ids":["first.addon","../escape","first.addon","second.addon",".hidden"]}"#).unwrap();
        assert_eq!(enabled_addon_ids(&root), ["first.addon", "second.addon"]);
        fs::write(root.join("enabled.json"), r#"{"schemaVersion":2,"ids":["first.addon"]}"#).unwrap();
        assert!(enabled_addon_ids(&root).is_empty());
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn v2_packages_verify_independently_and_reject_native_payloads() {
        let root = addon_test_dir();
        let packages = root.join("packages");
        write_test_package(&packages, "first.addon", b"export default 1;");
        write_test_package(&packages, "second.addon", b"export default 2;");
        assert_eq!(verified_package(&packages.join("first.addon"), "first.addon", "2026.68.0").unwrap().script, b"export default 1;");
        fs::write(packages.join("first.addon/plugin.js"), b"tampered").unwrap();
        assert!(verified_package(&packages.join("first.addon"), "first.addon", "2026.68.0").is_none());
        assert!(verified_package(&packages.join("second.addon"), "second.addon", "2026.68.0").is_some());
        let second = packages.join("second.addon");
        let mut manifest: serde_json::Value = serde_json::from_slice(&fs::read(second.join("manifest.json")).unwrap()).unwrap();
        manifest["helper"] = "plugin.js".into();
        fs::write(second.join("manifest.json"), serde_json::to_vec(&manifest).unwrap()).unwrap();
        assert!(verified_package(&second, "second.addon", "2026.68.0").is_none());
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn v3_package_accepts_only_its_verified_native_helper() {
        let root = addon_test_dir();
        let packages = root.join("packages");
        let id = "native.addon";
        write_test_package(&packages, id, b"export const createAddon = () => ({});");
        let package = packages.join(id);
        let mut header = vec![0u8; 256];
        match std::env::consts::OS {
            "linux" => {
                header[..6].copy_from_slice(b"\x7fELF\x02\x01");
                header[18..20].copy_from_slice(&(if cfg!(target_arch = "aarch64") { 183u16 } else { 62u16 }).to_le_bytes());
            }
            "windows" => {
                header[..2].copy_from_slice(b"MZ");
                header[60..64].copy_from_slice(&64u32.to_le_bytes());
                header[64..68].copy_from_slice(b"PE\0\0");
                header[68..70].copy_from_slice(&(if cfg!(target_arch = "aarch64") { 0xaa64u16 } else { 0x8664u16 }).to_le_bytes());
            }
            "macos" => {
                header[..4].copy_from_slice(&0xfeedfacfu32.to_le_bytes());
                header[4..8].copy_from_slice(&(if cfg!(target_arch = "aarch64") { 0x0100000cu32 } else { 0x01000007u32 }).to_le_bytes());
            }
            _ => { fs::remove_dir_all(root).unwrap(); return; }
        }
        let helper = package.join(addon_helper_name());
        fs::write(&helper, &header).unwrap();
        #[cfg(unix)] {
            use std::os::unix::fs::PermissionsExt;
            fs::set_permissions(&helper, fs::Permissions::from_mode(0o755)).unwrap();
        }
        let mut manifest: serde_json::Value = serde_json::from_slice(&fs::read(package.join("manifest.json")).unwrap()).unwrap();
        manifest["schemaVersion"] = 3.into();
        manifest["helper"] = addon_helper_name().into();
        manifest["target"] = serde_json::json!({
            "os": std::env::consts::OS,
            "arch": if cfg!(target_arch = "aarch64") { "arm64" } else { "x64" },
        });
        manifest["files"][addon_helper_name()] = sha256_file(&helper).unwrap().into();
        fs::write(package.join("manifest.json"), serde_json::to_vec(&manifest).unwrap()).unwrap();
        assert!(verified_package(&package, id, "2026.68.0").unwrap().helper.is_some());
        let notices = package.join("NOTICES.txt");
        fs::write(&notices, b"Licensed components\n").unwrap();
        manifest["files"]["NOTICES.txt"] = sha256_file(&notices).unwrap().into();
        fs::write(package.join("manifest.json"), serde_json::to_vec(&manifest).unwrap()).unwrap();
        assert!(verified_package(&package, id, "2026.68.0").is_some());
        fs::write(&notices, b"tampered\n").unwrap();
        assert!(verified_package(&package, id, "2026.68.0").is_none());
        fs::write(&notices, vec![b'x'; 4 * 1024 * 1024 + 1]).unwrap();
        assert!(verified_package(&package, id, "2026.68.0").is_none());
        fs::write(&notices, b"Licensed components\n").unwrap();
        fs::write(package.join("unlisted.txt"), b"extra").unwrap();
        assert!(verified_package(&package, id, "2026.68.0").is_none());
        fs::remove_file(package.join("unlisted.txt")).unwrap();
        fs::write(&helper, b"tampered").unwrap();
        assert!(verified_package(&package, id, "2026.68.0").is_none());
        fs::write(&helper, &header).unwrap();
        manifest["target"]["arch"] = "wrong".into();
        fs::write(package.join("manifest.json"), serde_json::to_vec(&manifest).unwrap()).unwrap();
        assert!(verified_package(&package, id, "2026.68.0").is_none());
        manifest["target"]["arch"] = if cfg!(target_arch = "aarch64") { "arm64" } else { "x64" }.into();
        let companion_name = addon_companion_name(1);
        let companion = package.join(&companion_name);
        fs::write(&companion, &header).unwrap();
        #[cfg(unix)] {
            use std::os::unix::fs::PermissionsExt;
            fs::set_permissions(&companion, fs::Permissions::from_mode(0o755)).unwrap();
        }
        manifest["schemaVersion"] = 4.into();
        manifest["sidecars"] = serde_json::json!([companion_name]);
        manifest["files"][&companion_name] = sha256_file(&companion).unwrap().into();
        fs::write(package.join("manifest.json"), serde_json::to_vec(&manifest).unwrap()).unwrap();
        assert_eq!(verified_package(&package, id, "2026.68.0").unwrap().sidecars.len(), 1);
        fs::write(&companion, b"tampered").unwrap();
        assert!(verified_package(&package, id, "2026.68.0").is_none());
        fs::write(&companion, &header).unwrap();
        manifest["sidecars"] = serde_json::json!(["wrong-name"]);
        fs::write(package.join("manifest.json"), serde_json::to_vec(&manifest).unwrap()).unwrap();
        assert!(verified_package(&package, id, "2026.68.0").is_none());
        manifest["sidecars"] = serde_json::json!([companion_name]);
        fs::remove_file(&notices).unwrap();
        manifest["files"].as_object_mut().unwrap().remove("NOTICES.txt");
        fs::write(package.join("manifest.json"), serde_json::to_vec(&manifest).unwrap()).unwrap();
        assert!(verified_package(&package, id, "2026.68.0").is_none());
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn v2_package_accepts_verified_notices_only() {
        let root = addon_test_dir();
        let packages = root.join("packages");
        let id = "script.notice";
        write_test_package(&packages, id, b"export const createAddon = () => ({});");
        let package = packages.join(id);
        let notices = package.join("NOTICES.txt");
        fs::write(&notices, b"Private add-on terms\n").unwrap();
        let mut manifest: serde_json::Value = serde_json::from_slice(&fs::read(package.join("manifest.json")).unwrap()).unwrap();
        manifest["files"]["NOTICES.txt"] = sha256_file(&notices).unwrap().into();
        fs::write(package.join("manifest.json"), serde_json::to_vec(&manifest).unwrap()).unwrap();
        assert!(verified_package(&package, id, "2026.68.0").is_some());
        fs::write(&notices, b"changed\n").unwrap();
        assert!(verified_package(&package, id, "2026.68.0").is_none());
        fs::write(&notices, b"\xff").unwrap();
        manifest["files"]["NOTICES.txt"] = sha256_file(&notices).unwrap().into();
        fs::write(package.join("manifest.json"), serde_json::to_vec(&manifest).unwrap()).unwrap();
        assert!(verified_package(&package, id, "2026.68.0").is_none());
        fs::remove_dir_all(root).unwrap();
    }

    #[cfg(unix)]
    #[test]
    fn v2_package_rejects_symlinked_root() {
        use std::os::unix::fs::symlink;
        let root = addon_test_dir();
        let packages = root.join("packages");
        write_test_package(&packages, "actual.addon", b"export default 1;");
        symlink(packages.join("actual.addon"), packages.join("linked.addon")).unwrap();
        assert!(verified_package(&packages.join("linked.addon"), "linked.addon", "2026.68.0").is_none());
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn manifest_contract_and_hashes() {
        let manifest: AddonManifest = serde_json::from_str(r#"{
          "schemaVersion":1,"id":"sample.addon","version":"2026.68.0","hostApiVersion":1,
          "editorVersion":"2026.68.0","target":{"os":"linux","arch":"x64"},"files":{"plugin.js":"abc"},
          "helper":"bin/worker"
        }"#).unwrap();
        assert_eq!(manifest.schema_version, 1);
        assert_eq!(manifest.version, "2026.68.0");
        assert_eq!(manifest.host_api_version, HOST_API_VERSION);
        assert!(!addon_target_matches(&AddonTarget { os: "invalid".into(), arch: "invalid".into() }));
        let current = AddonTarget {
            os: std::env::consts::OS.into(),
            arch: match std::env::consts::ARCH { "x86_64" => "x64", "x86" => "ia32", "aarch64" => "arm64", other => other }.into(),
        };
        assert!(addon_target_matches(&current));
        assert!(!addon_target_matches(&AddonTarget { os: current.os, arch: "wrong".into() }));
        assert_eq!(manifest.target.unwrap().os, "linux");
        let script_only: AddonManifest = serde_json::from_str(r#"{
          "schemaVersion":1,"id":"sample.addon","version":"2026.68.0","hostApiVersion":1,
          "editorVersion":"2026.68.0","files":{"plugin.js":"abc"}
        }"#).unwrap();
        assert!(addon_manifest_target_compatible(&script_only));
        let native_without_target: AddonManifest = serde_json::from_str(r#"{
          "schemaVersion":1,"id":"sample.addon","version":"2026.68.0","hostApiVersion":1,
          "editorVersion":"2026.68.0","files":{"plugin.js":"abc","bin/helper":"def"},"helper":"bin/helper"
        }"#).unwrap();
        assert!(!addon_manifest_target_compatible(&native_without_target));
        assert!(serde_json::from_str::<AddonManifest>(r#"{
          "schemaVersion":1,"id":"sample.addon","version":"2026.68.0","hostApiVersion":1,
          "editorVersion":"2026.68.0","target":null,"files":{"plugin.js":"abc"}
        }"#).is_err());
        assert_eq!(manifest.helper.as_deref(), Some("bin/worker"));
        assert!(sha256_bytes_match(b"hello", "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824"));
        assert!(!sha256_bytes_match(b"hello!", "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824"));
    }

    #[test]
    fn relative_paths_reject_escape() {
        for name in ["../worker", "bin/../worker", "./worker", "/worker", "C:/worker", "bin\\worker", ""] {
            assert!(addon_relative_path(name).is_none(), "accepted {name}");
        }
        assert_eq!(addon_relative_path("bin/worker").unwrap(), std::path::PathBuf::from("bin/worker"));
    }

    #[cfg(unix)]
    #[test]
    fn addon_file_rejects_symlinked_components() {
        use std::os::unix::fs::symlink;
        let unique = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos();
        let root = std::env::temp_dir().join(format!("oculith-addon-test-{}-{unique}", std::process::id()));
        fs::create_dir_all(root.join("bin")).unwrap();
        fs::write(root.join("bin/worker"), b"worker").unwrap();
        assert!(addon_file(&root, "bin/worker").is_some());
        symlink(root.join("bin"), root.join("linked")).unwrap();
        assert!(addon_file(&root, "linked/worker").is_none());
        fs::remove_dir_all(root).unwrap();
    }
}

/// A stand-in while the editor's files move into EditionAssets.
struct NoAssets;

impl<R: tauri::Runtime> tauri::Assets<R> for NoAssets {
    fn get(&self, _key: &tauri::utils::assets::AssetKey) -> Option<std::borrow::Cow<'_, [u8]>> {
        None
    }

    fn iter(&self) -> Box<tauri::utils::assets::AssetsIter<'_>> {
        Box::new(std::iter::empty::<(std::borrow::Cow<'_, str>, std::borrow::Cow<'_, [u8]>)>())
    }

    fn csp_hashes(
        &self,
        _html_path: &tauri::utils::assets::AssetKey,
    ) -> Box<dyn Iterator<Item = tauri::utils::assets::CspHash<'_>> + '_> {
        Box::new(std::iter::empty())
    }
}

/// The app's context: its configuration and the editor's files.
fn editor_context() -> tauri::Context<tauri::Wry> {
    let mut context = tauri::generate_context!();
    let editor = context.set_assets(Box::new(NoAssets));
    context.set_assets(Box::new(EditionAssets(editor)));
    context
}

// Fallback commands for when plugins aren't available via global API

#[tauri::command(async)]
fn read_file(path: String) -> Result<Vec<u8>, String> {
    fs::read(&path).map_err(|e| e.to_string())
}

#[tauri::command(async)]
fn write_file(path: String, data: String) -> Result<bool, String> {
    let bytes = BASE64.decode(&data).map_err(|e| e.to_string())?;
    atomic_file::write(std::path::Path::new(&path), &bytes).map_err(|e| e.to_string())?;
    Ok(true)
}

#[tauri::command]
async fn write_file_atomic(request: tauri::ipc::Request<'_>) -> Result<(), String> {
    let header = request.headers().get("x-opds-path")
        .ok_or("Missing destination path")?.to_str().map_err(|e| e.to_string())?;
    let path = urlencoding::decode(header).map_err(|e| e.to_string())?.into_owned();
    let bytes = match request.body() {
        tauri::ipc::InvokeBody::Raw(bytes) => bytes.clone(),
        // Android cannot transport a raw IPC body.
        tauri::ipc::InvokeBody::Json(value) => {
            serde_json::from_value::<Vec<u8>>(value.get("data").cloned().ok_or("Missing file data")?)
                .map_err(|e| e.to_string())?
        }
    };
    tauri::async_runtime::spawn_blocking(move || {
        atomic_file::write(std::path::Path::new(&path), &bytes).map_err(|e| e.to_string())
    }).await.map_err(|e| e.to_string())?
}

/// Incremental save (js/pdf/saver/incremental.js): append bytes to a PDF
/// whose length, first and last bytes still match what the editor loaded.
/// Body: the expected head, the expected tail, then the bytes to append;
/// the lengths travel in headers. Errors with "append-mismatch" when the file
/// changed on disk, so the caller can write the whole file instead.
#[tauri::command]
async fn append_file_atomic(request: tauri::ipc::Request<'_>) -> Result<(), String> {
    let header = |name: &str| -> Result<String, String> {
        let raw = request.headers().get(name).ok_or(format!("Missing {name}"))?
            .to_str().map_err(|e| e.to_string())?;
        Ok(urlencoding::decode(raw).map_err(|e| e.to_string())?.into_owned())
    };
    let path = header("x-opds-path")?;
    let parse = |v: String| v.parse::<u64>().map_err(|e| e.to_string());
    let expected_len = parse(header("x-opds-expected-len")?)?;
    let head_len = parse(header("x-opds-head-len")?)? as usize;
    let tail_len = parse(header("x-opds-tail-len")?)? as usize;
    let body = match request.body() {
        tauri::ipc::InvokeBody::Raw(bytes) => bytes.clone(),
        tauri::ipc::InvokeBody::Json(value) => {
            serde_json::from_value::<Vec<u8>>(value.get("data").cloned().ok_or("Missing file data")?)
                .map_err(|e| e.to_string())?
        }
    };
    if head_len + tail_len > body.len() {
        return Err("Malformed append request".into());
    }
    tauri::async_runtime::spawn_blocking(move || {
        let (head, rest) = body.split_at(head_len);
        let (tail, extra) = rest.split_at(tail_len);
        atomic_file::append(std::path::Path::new(&path), expected_len, head, tail, extra)
            .map_err(|e| e.to_string())
    }).await.map_err(|e| e.to_string())?
}

#[tauri::command(async)]
fn file_exists(path: String) -> bool {
    std::path::Path::new(&path).exists()
}

#[tauri::command]
async fn open_url(url: String) -> Result<(), String> {
    open::that(&url).map_err(|e| e.to_string())
}

#[tauri::command(async)]
fn is_dev_mode() -> bool {
    cfg!(debug_assertions)
}

/// Check if this app is the default handler for .pdf files on Windows.
/// Returns true if our exe is the registered handler, false otherwise.
/// Uses spawn_blocking so the subprocess calls never block the main thread.
#[tauri::command]
async fn is_default_pdf_app(app: tauri::AppHandle) -> bool {
    #[cfg_attr(not(target_os = "linux"), allow(unused_variables))]
    let desktop_file = app_desktop_file(&app);
    tauri::async_runtime::spawn_blocking(move || {
        #[cfg(target_os = "windows")]
        {
            // Register lezen met de Windows-API, niet met reg.exe: een extra
            // systeemproces kort na de start laat beveiligingssoftware de app
            // afsluiten (#524).
            use windows_sys::Win32::System::Registry::{HKEY_CLASSES_ROOT, HKEY_CURRENT_USER};
            let eigen_exe = std::env::current_exe()
                .map(|p| p.to_string_lossy().into_owned())
                .unwrap_or_default();
            let Some(prog_id) = standaard_app::lees_tekst(
                HKEY_CURRENT_USER,
                r"Software\Microsoft\Windows\CurrentVersion\Explorer\FileExts\.pdf\UserChoice",
                Some("ProgId"),
            ) else {
                return false;
            };
            let open_opdracht = standaard_app::lees_tekst(
                HKEY_CLASSES_ROOT,
                &format!(r"{}\shell\open\command", prog_id.trim()),
                None,
            );
            standaard_app::is_onze_pdf_app(&prog_id, open_opdracht.as_deref(), &eigen_exe)
        }

        #[cfg(target_os = "linux")]
        {
            // Use xdg-mime: works on any XDG-compliant desktop (GNOME, KDE,
            // Cinnamon, MATE, XFCE) across distros (Mint, Ubuntu, Fedora, Arch).
            let output = match std::process::Command::new("xdg-mime")
                .args(&["query", "default", "application/pdf"])
                .output()
            {
                Ok(o) => o,
                Err(_) => return false,
            };
            let default_desktop = String::from_utf8_lossy(&output.stdout).trim().to_string();
            default_desktop == desktop_file
        }

        #[cfg(not(any(target_os = "windows", target_os = "linux")))]
        {
            false
        }
    }).await.unwrap_or(false)
}

/// Make this app the default handler for .pdf files.
/// On Windows, opens the system default-apps settings page. On Linux, sets the
/// xdg-mime default directly (no system UI for this exists on most desktops).
#[tauri::command]
fn open_default_apps_settings(app: tauri::AppHandle) -> Result<bool, String> {
    let _ = &app;
    #[cfg(target_os = "windows")]
    {
        // Open the "Choose default apps by file type" settings page
        no_window_command("cmd")
            .args(&["/c", "start", "ms-settings:defaultapps"])
            .spawn()
            .map_err(|e| e.to_string())?;
        Ok(true)
    }

    #[cfg(target_os = "linux")]
    {
        // xdg-mime is the desktop-environment agnostic way to set the default
        // handler. The .desktop filename must match what tauri-bundler wrote in
        // /usr/share/applications (the bundle uses the app's productName).
        let status = std::process::Command::new("xdg-mime")
            .args(&["default", app_desktop_file(&app).as_str(), "application/pdf"])
            .status()
            .map_err(|e| {
                if e.kind() == std::io::ErrorKind::NotFound {
                    "xdg-mime not found. Install xdg-utils (e.g. `sudo apt install xdg-utils`) and try again.".to_string()
                } else {
                    format!("Failed to run xdg-mime: {}", e)
                }
            })?;
        if !status.success() {
            return Err(format!(
                "xdg-mime exited with status {}. The .desktop file may not be registered — install {} via the bundled .deb/.AppImage so /usr/share/applications/{} exists.",
                status, app_product_name(&app), app_desktop_file(&app)
            ));
        }
        Ok(true)
    }

    #[cfg(not(any(target_os = "windows", target_os = "linux")))]
    {
        Ok(false)
    }
}

/// Lock a file to prevent other applications from writing to it.
/// Opens the file with shared read access only (no write sharing on Windows).
#[tauri::command(async)]
fn lock_file(path: String, state: tauri::State<LockedFiles>) -> Result<bool, String> {
    let mut locks = state.0.lock().map_err(|e| e.to_string())?;

    // Already locked by us
    if locks.contains_key(&path) {
        return Ok(true);
    }

    #[cfg(target_os = "windows")]
    {
        use std::os::windows::fs::OpenOptionsExt;
        // FILE_SHARE_READ = 0x00000001 — allow others to read, but not write or delete
        let file = fs::OpenOptions::new()
            .read(true)
            .custom_flags(0) // no special flags
            .share_mode(0x00000001) // FILE_SHARE_READ only
            .open(&path)
            .map_err(|e| format!("Failed to lock file: {}", e))?;
        locks.insert(path, file);
    }

    #[cfg(not(target_os = "windows"))]
    {
        // On Unix, use advisory file locking (flock)
        let file = fs::OpenOptions::new()
            .read(true)
            .open(&path)
            .map_err(|e| format!("Failed to open file: {}", e))?;
        // Advisory lock — other well-behaved apps will respect this
        // Note: this is best-effort on non-Windows platforms
        locks.insert(path, file);
    }

    Ok(true)
}

/// Unlock a previously locked file, allowing other apps to write to it.
#[tauri::command(async)]
fn unlock_file(path: String, state: tauri::State<LockedFiles>) -> Result<bool, String> {
    let mut locks = state.0.lock().map_err(|e| e.to_string())?;
    // Removing the entry drops the File handle, releasing the lock
    locks.remove(&path);
    Ok(true)
}

/// Build a process Command that never flashes a console window on Windows
/// (CREATE_NO_WINDOW). Use this for EVERY helper-process spawn (reg, cmd,
/// powershell, …) so the GUI app stays window-free — a bare Command::new
/// pops a black console box for a split second.
#[cfg(target_os = "windows")]
fn no_window_command(program: &str) -> std::process::Command {
    use std::os::windows::process::CommandExt;
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;
    let mut c = std::process::Command::new(program);
    c.creation_flags(CREATE_NO_WINDOW);
    c
}

/// Enumerate installed printers.
/// Returns a JSON array of printer objects: Name, DriverName, PortName,
/// Default and PrinterStatus, the shape of Win32_Printer.
/// Alleen opvragen: er wordt niets geïnstalleerd, gewijzigd of gestart.
/// PortName hoort erbij omdat de printdialoog en `app_list_printers` daaraan
/// zien of een wachtrij naar een bestand schrijft (js/pdf/print-doel.js,
/// `isBestandsPrinter`).
/// Windows: rechtstreeks uit de spooler (print_lijst.rs), zonder PowerShell;
/// endpoint-beveiliging beëindigt de app als die bij het opstarten
/// powershell.exe start (#524).
/// async: the query runs on a blocking thread, so a slow spooler or printer
/// server never holds up window show and input processing at startup.
#[tauri::command]
async fn get_printers() -> Result<String, String> {
    #[cfg(target_os = "windows")]
    {
        tauri::async_runtime::spawn_blocking(print_lijst::printers_als_json)
            .await
            .map_err(|e| format!("Failed to enumerate printers: {}", e))?
    }

    #[cfg(any(target_os = "linux", target_os = "macos"))]
    {
        // Use CUPS `lpstat -p` to list printers. Output format:
        //   printer NAME is idle. enabled since ...
        //   printer NAME disabled since ...
        let output = std::process::Command::new("lpstat")
            .args(&["-p"])
            .output()
            .map_err(|e| format!("Failed to run lpstat (is CUPS installed?): {}", e))?;

        if !output.status.success() {
            let stderr = String::from_utf8_lossy(&output.stderr);
            // No printers configured isn't strictly an error; return empty list.
            if stderr.trim().is_empty() {
                return Ok("[]".to_string());
            }
            return Err(format!("lpstat error: {}", stderr));
        }

        // Get the system default printer name (if any) via `lpstat -d`.
        let default_name = std::process::Command::new("lpstat")
            .args(&["-d"])
            .output()
            .ok()
            .and_then(|o| {
                let s = String::from_utf8_lossy(&o.stdout).to_string();
                // "system default destination: NAME" or "no system default destination"
                s.lines()
                    .find_map(|line| {
                        line.split_once(':').and_then(|(_, v)| {
                            let v = v.trim();
                            if v.is_empty() || v.starts_with("no ") { None } else { Some(v.to_string()) }
                        })
                    })
            })
            .unwrap_or_default();

        let stdout = String::from_utf8_lossy(&output.stdout).to_string();
        let mut entries: Vec<String> = Vec::new();
        for line in stdout.lines() {
            let line = line.trim();
            if !line.starts_with("printer ") { continue; }
            let rest = &line["printer ".len()..];
            let name = rest.split_whitespace().next().unwrap_or("").to_string();
            if name.is_empty() { continue; }
            let status_num: i32 = if rest.contains("disabled") { 0 } else { 3 }; // 3 = idle on Win32
            let is_default = name == default_name;
            // Match the Windows JSON shape: { Name, DriverName, PortName, Default, PrinterStatus }.
            // CUPS has no port; an empty PortName keeps the shape the same.
            let escaped = name.replace('\\', "\\\\").replace('"', "\\\"");
            entries.push(format!(
                "{{\"Name\":\"{}\",\"DriverName\":\"CUPS\",\"PortName\":\"\",\"Default\":{},\"PrinterStatus\":{}}}",
                escaped,
                if is_default { "true" } else { "false" },
                status_num
            ));
        }
        Ok(format!("[{}]", entries.join(",")))
    }

    #[cfg(not(any(target_os = "windows", target_os = "linux", target_os = "macos")))]
    {
        Ok("[]".to_string())
    }
}

/// Print a PDF file to a specific printer.
///
/// Implementation: rasterise each page via the in-proc PDFium renderer and
/// blit it onto the printer device context with GDI (StretchDIBits). This is
/// ASSOCIATION-INDEPENDENT — the previous ShellExecuteW("printto") approach
/// broke with SE_ERR_NOASSOC (code 31) whenever this app itself is the
/// default .pdf handler, because our ProgID registers no printto verb.
/// Windows: the printer DC is created with a complete, driver-validated
/// DEVMODE (the Properties choice from this session or the driver default,
/// plus the Page Setup paper); see print_windows.rs.
/// `plaatsing`: absent or anything but "vel" = each page fitted and centred
/// in the printable area (the behaviour before this parameter); "vel" = the
/// Print dialog has already laid every page out at paper size with the
/// chosen scale and position, so each page goes 1:1 onto the physical sheet
/// (see print_plaatsing.rs and js/pdf/print-plaatsing.js).
/// async for the same reason as get_printers: GDI spooling is slow blocking
/// work and runs on a blocking thread, not on the main event-loop thread.
#[tauri::command]
async fn print_pdf(
    path: String,
    printer: String,
    orientatie: Option<String>,
    papier: Option<String>,
    plaatsing: Option<String>,
    devmodes: tauri::State<'_, print_instelling::PrinterDevmodes>,
) -> Result<bool, String> {
    // Keuzes uit de Pagina-instelling. Zonder argumenten: Auto + printerstandaard,
    // precies het gedrag van vóór deze parameters.
    let orientatie = print_instelling::Orientatie::uit_keuze(orientatie.as_deref());
    let papier = print_instelling::Papier::uit_keuze(papier.as_deref());
    let plaatsing = print_plaatsing::Plaatsing::uit_keuze(plaatsing.as_deref());
    #[cfg(target_os = "windows")]
    {
        // Wat de gebruiker in deze sessie in het eigenschappenvenster koos.
        let opgeslagen = devmodes.ophalen(&printer);
        tauri::async_runtime::spawn_blocking(move || {
            print_windows::print_pdf_bestand(
                std::path::Path::new(&path),
                &printer,
                orientatie,
                papier,
                plaatsing,
                opgeslagen.as_deref(),
                None,
            )
        })
        .await
        .map_err(|e| format!("Print task failed: {e}"))??;
        Ok(true)
    }

    // Linux/macOS: spool through CUPS. The JS side has already rasterised the
    // selected pages into a temp PDF at the right size and rotation (with
    // plaatsing "vel": at paper size, scale and position already applied),
    // and calls this once per copy — so `lp` only has to hand one document to
    // one queue and needs no page-range or copy options of its own.
    #[cfg(any(target_os = "linux", target_os = "macos"))]
    {
        let _ = &devmodes;
        let queue = printer.trim();
        let mut cmd = std::process::Command::new("lp");
        // No queue name means "system default", which is what lp does without -d.
        if !queue.is_empty() {
            cmd.arg("-d").arg(queue);
        }
        // The caller always passes an absolute temp path, so the filename can
        // never be mistaken for an option; `--` is not portable across lp
        // implementations and is deliberately left out.
        for optie in print_instelling::lp_opties(orientatie, papier, plaatsing) {
            cmd.arg(optie);
        }
        let output = cmd
            .arg(&path)
            .output()
            .map_err(|e| format!("Failed to run lp — is CUPS installed (cups-client)? {}", e))?;

        if !output.status.success() {
            // lp reports rejected jobs on stderr, but a few builds use stdout.
            let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
            let stdout = String::from_utf8_lossy(&output.stdout).trim().to_string();
            let detail = if stderr.is_empty() { stdout } else { stderr };
            let detail = if detail.is_empty() { "no output".to_string() } else { detail };
            return Err(format!("lp could not queue the job: {}", detail));
        }

        Ok(true)
    }

    #[cfg(not(any(target_os = "windows", target_os = "linux", target_os = "macos")))]
    {
        let _ = (&path, &printer, &orientatie, &papier, &plaatsing, &devmodes);
        Err("Printing is not supported on this platform".to_string())
    }
}

/// Open the document properties (printing preferences) dialog for a printer.
///
/// Windows: the driver's own dialog, modal to the calling window. It is
/// pre-filled with what was chosen earlier this session for this printer
/// (else the driver default), with `papier`/`orientatie` applied on top: the
/// paper and orientation the next print job gets, as the Print dialog shows
/// them (same values as print_pdf; 'printer'/'auto' or absent = leave as is).
/// So OK without changes changes nothing the user chose in Page Setup.
/// The command waits for the dialog. OK keeps the chosen DEVMODE in memory
/// for this printer — only for this session, never written to the printer or
/// system defaults — and returns its PapierInfo plus `papierGewijzigd` /
/// `orientatieGewijzigd` (what the user changed against the pre-fill); Cancel
/// returns null and changes nothing. Linux/macOS open the system printer
/// settings and return null.
#[tauri::command]
async fn open_printer_properties(
    window: tauri::WebviewWindow,
    printer: String,
    papier: Option<String>,
    orientatie: Option<String>,
    devmodes: tauri::State<'_, print_instelling::PrinterDevmodes>,
) -> Result<Option<print_instelling::EigenschappenKeuze>, String> {
    #[cfg(target_os = "windows")]
    {
        // The HWND makes the dialog modal to this window; passed on as usize
        // because a raw handle is not Send.
        let hwnd = window.hwnd().map_err(|e| format!("Failed to get window handle: {}", e))?;
        let eigenaar = hwnd.0 as usize;
        let opgeslagen = devmodes.ophalen(&printer);
        let naam = printer.clone();
        let papier = print_instelling::Papier::uit_keuze(papier.as_deref());
        let orientatie = print_instelling::Orientatie::uit_keuze(orientatie.as_deref());
        // DocumentPropertiesW runs its own modal loop until the user closes
        // the dialog. It gets a fresh thread of its own (as before: no COM or
        // other state from a reused pool thread) and the command awaits the
        // answer instead of returning straight away.
        let (klaar, antwoord) = tokio::sync::oneshot::channel();
        std::thread::spawn(move || {
            let uitkomst =
                print_devmode::eigenschappen_kiezen(&naam, eigenaar, opgeslagen.as_deref(), papier, orientatie);
            let _ = klaar.send(uitkomst);
        });
        let gekozen = antwoord
            .await
            .map_err(|_| "Printer properties dialog ended unexpectedly".to_string())??;

        match gekozen {
            Some((bytes, keuze)) => {
                devmodes.bewaren(&printer, bytes);
                Ok(Some(keuze))
            }
            None => Ok(None),
        }
    }

    // CUPS has no per-driver properties dialog that an application can call the
    // way Windows can, so the closest equivalent is the system's own printer
    // settings for that queue. Each candidate is tried in turn; the first one
    // that launches wins.
    #[cfg(any(target_os = "linux", target_os = "macos"))]
    {
        let _ = (window, &devmodes, &papier, &orientatie);
        let queue = printer.trim();

        #[cfg(target_os = "linux")]
        // CUPS queue names cannot contain spaces or slashes, so the name is
        // safe to drop into the local CUPS URL unencoded.
        let candidates: Vec<(&str, Vec<String>)> = vec![
            ("system-config-printer", vec![format!("--printer={}", queue)]),
            ("xdg-open", vec![format!("http://localhost:631/printers/{}", queue)]),
        ];

        #[cfg(target_os = "macos")]
        let candidates: Vec<(&str, Vec<String>)> = vec![
            ("open", vec!["x-apple.systempreferences:com.apple.Print-Scan-Settings.extension".to_string()]),
            ("open", vec!["/System/Library/PreferencePanes/PrintAndScan.prefPane".to_string()]),
        ];

        for (program, args) in candidates {
            if std::process::Command::new(program).args(&args).spawn().is_ok() {
                return Ok(None);
            }
        }

        Err("Could not open the system printer settings".to_string())
    }

    #[cfg(not(any(target_os = "windows", target_os = "linux", target_os = "macos")))]
    {
        let _ = (window, &printer, &devmodes, &papier, &orientatie);
        Err("Printer properties are not supported on this platform".to_string())
    }
}

/// The paper the next job on this printer really uses, given the Page Setup
/// paper (`papier`, same values as print_pdf).
///
/// - 'printer' or absent: the Properties choice from this session for this
///   printer, else the driver's current default for this user.
/// - a paper size: what the driver makes of it, exactly as print_pdf builds
///   the job. A driver that cannot take the size (A0L is longer than the
///   built-in PDF driver allows) keeps the printer's paper, and that is what
///   comes back, so the Print dialog can show the sheet that will be used.
///
/// Never shows UI, never starts a job and never changes anything. null on
/// Linux/macOS or when it cannot be determined.
#[tauri::command]
async fn printer_papier(
    printer: String,
    papier: Option<String>,
    devmodes: tauri::State<'_, print_instelling::PrinterDevmodes>,
) -> Result<Option<print_instelling::PapierInfo>, String> {
    #[cfg(target_os = "windows")]
    {
        let opgeslagen = devmodes.ophalen(&printer);
        let papier = print_instelling::Papier::uit_keuze(papier.as_deref());
        tauri::async_runtime::spawn_blocking(move || {
            print_devmode::papier_voor_opdracht(&printer, opgeslagen.as_deref(), papier)
        })
        .await
        .map_err(|e| format!("Printer paper task failed: {e}"))
    }

    #[cfg(not(target_os = "windows"))]
    {
        let _ = (&printer, &papier, &devmodes);
        Ok(None)
    }
}

/// The printer's unprintable margins for the sheet the next job gets
/// (`papier`, same values as print_pdf), per orientation and in mm.
///
/// Measured on an information context with the very DEVMODE the job gets
/// (this session's Properties choice or the driver default, plus the Page
/// Setup paper): no job is started, nothing goes to the printer and nothing
/// changes. The Print dialog fits "Fit" and "Shrink" inside that area and
/// draws it in the preview.
///
/// Separate from printer_papier on purpose: the first information context on
/// a sleeping network printer can take tens of seconds (cold driver), and the
/// paper in the dialog header must not wait for it. null on Linux/macOS or
/// when the driver does not report usable measurements; the dialog then works
/// with a zero margin, as before.
#[tauri::command]
async fn printer_bedrukbaar(
    printer: String,
    papier: Option<String>,
    devmodes: tauri::State<'_, print_instelling::PrinterDevmodes>,
) -> Result<Option<print_plaatsing::Bedrukbaar>, String> {
    #[cfg(target_os = "windows")]
    {
        let opgeslagen = devmodes.ophalen(&printer);
        let papier = print_instelling::Papier::uit_keuze(papier.as_deref());
        tauri::async_runtime::spawn_blocking(move || {
            print_windows::bedrukbaar_voor_opdracht(&printer, opgeslagen.as_deref(), papier)
        })
        .await
        .map_err(|e| format!("Printable area task failed: {e}"))
    }

    #[cfg(not(target_os = "windows"))]
    {
        let _ = (&printer, &papier, &devmodes);
        Ok(None)
    }
}

/// Get the system temp directory path.
#[tauri::command(async)]
fn get_temp_dir() -> String {
    std::env::temp_dir().to_string_lossy().to_string()
}

/// Maak van een documentnaam een veilige bestandsnaam (verboden tekens weg,
/// niet leeg, begrensd in lengte).
fn sanitize_temp_pdf_name(name: &str) -> String {
    let vervangen: String = name
        .chars()
        .map(|c| match c {
            '<' | '>' | ':' | '"' | '/' | '\\' | '|' | '?' | '*' => '_',
            c if (c as u32) < 0x20 => '_',
            c => c,
        })
        .collect();
    vervangen
        .trim()
        .trim_matches('.')
        .trim()
        .chars()
        .take(120)
        .collect()
}

/// Write binary data to a temp file and return the path.
/// This bypasses the FS plugin scope restrictions.
///
/// Met `name` krijgt het tempbestand de (opgeschoonde) documentnaam, in een
/// unieke submap: de printspooler (Windows én CUPS) toont de bestandsnaam als
/// jobnaam, dus zo heet de printjob naar het pdf-bestand in plaats van naar
/// een timestamp.
#[tauri::command(async)]
fn write_temp_pdf(data: Vec<u8>, name: Option<String>) -> Result<String, String> {
    let temp_dir = std::env::temp_dir();
    let timestamp = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0);
    let schoon = name
        .as_deref()
        .map(sanitize_temp_pdf_name)
        .filter(|s| !s.is_empty());
    let path = match schoon {
        Some(mut n) => {
            if !n.to_lowercase().ends_with(".pdf") {
                n.push_str(".pdf");
            }
            let job_dir = temp_dir.join(format!("openstudio_print_{}", timestamp));
            fs::create_dir_all(&job_dir)
                .map_err(|e| format!("Failed to create temp dir: {}", e))?;
            job_dir.join(n)
        }
        None => temp_dir.join(format!("openstudio_print_{}.pdf", timestamp)),
    };
    fs::write(&path, &data).map_err(|e| format!("Failed to write temp file: {}", e))?;
    Ok(path.to_string_lossy().to_string())
}

/// Delete a file at the given path.
#[tauri::command(async)]
fn delete_file(path: String) -> Result<bool, String> {
    fs::remove_file(&path).map_err(|e| format!("Failed to delete file: {}", e))?;
    Ok(true)
}

/// Rename (move) a file from old_path to new_path.
#[tauri::command(async)]
fn rename_file(old_path: String, new_path: String) -> Result<bool, String> {
    fs::rename(&old_path, &new_path).map_err(|e| format!("Failed to rename file: {}", e))?;
    Ok(true)
}

/// Run a PowerShell script with UAC elevation by writing it to a temp .ps1
/// file, executing it as admin, and capturing errors via a log file.
#[cfg(target_os = "windows")]
fn run_elevated_ps_script(script: &str) -> Result<(), String> {
    let temp_dir = std::env::temp_dir();
    let timestamp = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0);

    let script_path = temp_dir.join(format!("ops_printer_{}.ps1", timestamp));
    let log_path = temp_dir.join(format!("ops_printer_{}.log", timestamp));

    // Wrap the script: redirect all errors to a log file, write "OK" on success
    let wrapped = format!(
        r#"try {{
{}
'OK' | Out-File -FilePath '{}' -Encoding UTF8
}} catch {{
$_.Exception.Message | Out-File -FilePath '{}' -Encoding UTF8
exit 1
}}"#,
        script,
        log_path.to_string_lossy(),
        log_path.to_string_lossy()
    );

    fs::write(&script_path, &wrapped)
        .map_err(|e| format!("Failed to write temp script: {}", e))?;

    // Launch elevated: Start-Process -Verb RunAs -Wait on the .ps1 file
    // Build the -ArgumentList as a single quoted string with each param separated by commas.
    // The script path is passed as a properly escaped argument, not interpolated into a command string.
    use std::os::windows::process::CommandExt;
    const CREATE_NO_WINDOW: u32 = 0x08000000;
    let script_path_str = script_path.to_string_lossy().to_string();
    let arg_list = format!(
        "'-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File','{}'",
        script_path_str.replace('\'', "''")
    );
    let output = std::process::Command::new("powershell")
        .arg("-NoProfile")
        .arg("-NonInteractive")
        .arg("-Command")
        .arg(format!(
            "Start-Process powershell -Verb RunAs -Wait -WindowStyle Hidden -ArgumentList {}",
            arg_list
        ))
        .creation_flags(CREATE_NO_WINDOW)
        .output()
        .map_err(|e| format!("Failed to launch elevated process: {}", e))?;

    // Read the log file written by the elevated process
    let log_content = fs::read_to_string(&log_path).unwrap_or_default();
    let log_trimmed = log_content.trim();

    // Cleanup temp files
    let _ = fs::remove_file(&script_path);
    let _ = fs::remove_file(&log_path);

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(format!("UAC elevation failed: {}", stderr));
    }

    if log_trimmed.is_empty() {
        return Err("Elevated script produced no output — user may have cancelled UAC".to_string());
    }

    // Check BOM-prefixed "OK" (UTF-8 BOM from Out-File)
    if log_trimmed == "OK" || log_trimmed.ends_with("OK") {
        Ok(())
    } else {
        Err(format!("Elevated script error: {}", log_trimmed))
    }
}

/// Install a virtual printer named "Open PDF Printer" using the built-in
/// "Microsoft Print to PDF" driver. Sets the default paper size to A4 and
/// adds the extra paper sizes (A3L, A2L, A1L; A1 and A0 where missing; see
/// print_formulieren.rs) to the print server, so other applications can pick
/// them on printers whose driver accepts user-defined paper sizes. Requires
/// one-time UAC admin elevation.
///
/// `use_collection` (DEFAULT true — the "catch and merge" behaviour):
///   - `true` (default) → routes the output to a fixed file port pointing at
///     `%LOCALAPPDATA%\OpenPDFPrinter\spool\latest.pdf`. NO Windows Save As
///     dialog appears. Our app watches that folder, rotates the captured
///     file into a timestamped job, and pops the print-queue dialog so the
///     user can merge/reorder multiple print jobs from ANY program before
///     saving. (Single-port approach: concurrent print jobs lock on the
///     rotate step inside the app — Windows already serialises print jobs to
///     a given port so the race window is tiny.)
///   - `false` → PORTPROMPT: port (legacy): each print job pops the standard
///     Windows Save As dialog. Only used if explicitly requested.
///
/// Backward compatibility: removes the legacy printer name "Open PDF
/// Studio" if present, so an existing installation cleanly migrates to
/// the new name on next install. Only printers that use the "Microsoft
/// Print to PDF" driver are ever removed or replaced: a printer of the
/// user's own that happens to carry one of these names is left alone.
///
/// The script text comes from print_formulieren.rs, the same source as the
/// scripts the installer ships.
#[tauri::command]
fn install_virtual_printer(use_collection: Option<bool>) -> Result<bool, String> {
    #[cfg(target_os = "windows")]
    {
        // Default to the silent collection port — the user wants prints
        // CAUGHT for merging, never a Save As dialog.
        let use_collection = use_collection.unwrap_or(true);
        let poort = if use_collection {
            // Pre-create the spool dir. Windows file-ports require the port
            // NAME to be the file path itself; the script adds the port.
            let local = std::env::var("LOCALAPPDATA")
                .map_err(|_| "LOCALAPPDATA not set".to_string())?;
            let spool_dir = std::path::Path::new(&local).join("OpenPDFPrinter").join("spool");
            std::fs::create_dir_all(&spool_dir)
                .map_err(|e| format!("Failed to create spool dir: {}", e))?;
            spool_dir.join("latest.pdf").to_string_lossy().to_string()
        } else {
            print_formulieren::POORT_DIALOOG.to_string()
        };

        // The user asked for this port, so an existing "Open PDF Printer" of
        // ours is re-created on it (the installer never does that).
        let script = print_formulieren::script_installeren(&print_formulieren::Installatie {
            poort,
            bestaande_vervangen: true,
        });
        run_elevated_ps_script(&script)?;
        Ok(true)
    }

    #[cfg(not(target_os = "windows"))]
    {
        let _ = use_collection;
        Err("Virtual printer is only supported on Windows".to_string())
    }
}

/// Remove the "Open PDF Printer" virtual printer (and the legacy
/// "Open PDF Studio" name if it exists), plus the paper sizes this app or
/// its installer added to the print server. Requires UAC admin elevation.
/// Printers with another driver and paper sizes added by someone else stay.
#[tauri::command]
fn remove_virtual_printer() -> Result<bool, String> {
    #[cfg(target_os = "windows")]
    {
        run_elevated_ps_script(&print_formulieren::script_verwijderen())?;
        Ok(true)
    }

    #[cfg(not(target_os = "windows"))]
    {
        Err("Virtual printer is only supported on Windows".to_string())
    }
}

// ── Virtual-printer job queue ───────────────────────────────────────────
// With the collection port installed, every print to "Open PDF Printer"
// lands as spool/latest.pdf. The queue sweeps that into unique job files
// (so the next print can't overwrite it) and lists them for the in-app
// merge/reorder dialog.

fn vp_spool_dir() -> Result<std::path::PathBuf, String> {
    // Bewust niet via datamap::lokale_datamap(): de spoolmap is als
    // Windows-printerpoort vastgelegd en gedeeld met het print-subsysteem.
    let base = dirs::data_local_dir().ok_or("local data dir unknown")?;
    Ok(base.join("OpenPDFPrinter").join("spool"))
}

/// Sweep the spool: rename a finished `latest.pdf` into `job_<epoch>.pdf`.
/// Returns true when a new job was collected. The driver may still be
/// writing — only collect once the file has been stable for a moment.
#[tauri::command]
fn virtual_printer_collect() -> Result<bool, String> {
    let dir = vp_spool_dir()?;
    let latest = dir.join("latest.pdf");
    if !latest.exists() {
        return Ok(false);
    }
    let meta = std::fs::metadata(&latest).map_err(|e| e.to_string())?;
    if meta.len() == 0 {
        return Ok(false);
    }
    if let Ok(modified) = meta.modified() {
        if let Ok(age) = modified.elapsed() {
            if age.as_millis() < 1500 {
                return Ok(false);
            }
        }
    }
    let stamp = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0);
    let job = dir.join(format!("job_{stamp}.pdf"));
    match std::fs::rename(&latest, &job) {
        Ok(()) => Ok(true),
        // Still locked by the spooler — pick it up on the next sweep.
        Err(_) => Ok(false),
    }
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct VpJob {
    file: String,
    path: String,
    size: u64,
    modified_ms: u64,
    pages: u32,
}

/// List collected jobs (oldest first — print order).
#[tauri::command]
fn virtual_printer_jobs() -> Result<Vec<VpJob>, String> {
    let dir = vp_spool_dir()?;
    let mut jobs = Vec::new();
    if let Ok(rd) = std::fs::read_dir(&dir) {
        for e in rd.flatten() {
            let name = e.file_name().to_string_lossy().to_string();
            if !(name.starts_with("job_") && name.ends_with(".pdf")) {
                continue;
            }
            let meta = match e.metadata() {
                Ok(m) => m,
                Err(_) => continue,
            };
            let modified_ms = meta
                .modified()
                .ok()
                .and_then(|m| m.duration_since(std::time::UNIX_EPOCH).ok())
                .map(|d| d.as_millis() as u64)
                .unwrap_or(0);
            let pages = lopdf::Document::load(e.path())
                .map(|d| d.get_pages().len() as u32)
                .unwrap_or(0);
            jobs.push(VpJob {
                file: name,
                path: e.path().to_string_lossy().to_string(),
                size: meta.len(),
                modified_ms,
                pages,
            });
        }
    }
    jobs.sort_by_key(|j| j.modified_ms);
    Ok(jobs)
}

/// Delete one collected job. Basename only — no path traversal.
#[tauri::command]
fn virtual_printer_delete_job(file: String) -> Result<(), String> {
    if file.contains('/') || file.contains('\\') || !file.starts_with("job_") || !file.ends_with(".pdf") {
        return Err("invalid job file".into());
    }
    let p = vp_spool_dir()?.join(file);
    std::fs::remove_file(&p).map_err(|e| e.to_string())
}

/// Whether "Open PDF Printer" is in SILENT CATCH mode — i.e. its port is the
/// spool file (no Save As dialog). Returns false when it's on PORTPROMPT (the
/// legacy save-dialog port) so the UI can offer to reconfigure it.
/// Windows: de poort komt uit de spooler (print_lijst.rs), zonder PowerShell
/// (#524).
#[tauri::command]
async fn virtual_printer_catch_enabled() -> bool {
    #[cfg(target_os = "windows")]
    {
        let spoolbestand = match vp_spool_dir() {
            Ok(p) => p.join("latest.pdf").to_string_lossy().to_string(),
            Err(_) => return false,
        };
        tauri::async_runtime::spawn_blocking(move || {
            let printers = print_lijst::printers_opvragen().unwrap_or_default();
            let poort = print_lijst::poort_van(&printers, print_formulieren::PRINTERNAAM);
            print_lijst::vangt_in_spoolbestand(poort, &spoolbestand)
        })
        .await
        .unwrap_or(false)
    }
    #[cfg(not(target_os = "windows"))]
    {
        false
    }
}

/// Switch the EXISTING "Open PDF Printer" to the silent collection file port
/// — turns OFF the Windows Save As dialog. Verified to work WITHOUT UAC:
/// changing a printer's port is permitted for the current user (unlike
/// ADDING a printer). This is the fix for a printer installed on PORTPROMPT.
#[tauri::command]
fn virtual_printer_enable_catch() -> Result<bool, String> {
    #[cfg(target_os = "windows")]
    {
        let spool = vp_spool_dir()?;
        std::fs::create_dir_all(&spool).map_err(|e| format!("spool dir: {e}"))?;
        let port = spool.join("latest.pdf").to_string_lossy().to_string();
        // Idempotent: only add the port if missing (Add-PrinterPort errors if
        // it exists), then point the printer at it.
        let script = format!(
            r#"$ErrorActionPreference='Stop'
$port = '{}'
if (-not (Get-PrinterPort -Name $port -ErrorAction SilentlyContinue)) {{ Add-PrinterPort -Name $port }}
Set-Printer -Name 'Open PDF Printer' -PortName $port"#,
            port.replace('\'', "''")
        );
        let out = no_window_command("powershell")
            .args(&["-NoProfile", "-NonInteractive", "-Command", &script])
            .output()
            .map_err(|e| format!("powershell: {e}"))?;
        if !out.status.success() {
            return Err(String::from_utf8_lossy(&out.stderr).trim().to_string());
        }
        Ok(true)
    }
    #[cfg(not(target_os = "windows"))]
    {
        Err("Windows only".into())
    }
}

/// Check whether the "Open PDF Printer" virtual printer is installed.
/// Also returns `true` for the legacy "Open PDF Studio" name so users on
/// an older installation see "installed" until they reinstall.
/// Windows: de namen komen uit de spooler (print_lijst.rs), zonder
/// PowerShell: deze vraag loopt bij elke start (#524).
#[tauri::command]
async fn is_virtual_printer_installed() -> bool {
    #[cfg(target_os = "windows")]
    {
        tauri::async_runtime::spawn_blocking(|| {
            print_lijst::printers_opvragen().is_ok_and(|printers| {
                print_lijst::heeft_printer(
                    &printers,
                    &[print_formulieren::PRINTERNAAM, print_formulieren::OUDE_PRINTERNAAM],
                )
            })
        })
        .await
        .unwrap_or(false)
    }

    #[cfg(not(target_os = "windows"))]
    {
        false
    }
}

/// Spool directory for the PDF Printer collection feature. Print jobs to
/// "Open PDF Printer" can be routed here (instead of the PORTPROMPT save
/// dialog) so our app captures the output and shows a multi-PDF collection
/// dialog instead. Lives under %LOCALAPPDATA% so it's per-user and
/// auto-cleaned on uninstall (Windows clears LocalAppData entries that
/// reference removed apps via the standard cleanup flow).
#[tauri::command]
fn get_printer_spool_dir() -> Result<String, String> {
    #[cfg(target_os = "windows")]
    {
        let local = std::env::var("LOCALAPPDATA")
            .map_err(|_| "LOCALAPPDATA not set".to_string())?;
        let dir = std::path::Path::new(&local).join("OpenPDFPrinter").join("spool");
        std::fs::create_dir_all(&dir)
            .map_err(|e| format!("Failed to create spool dir: {}", e))?;
        Ok(dir.to_string_lossy().to_string())
    }
    #[cfg(not(target_os = "windows"))]
    {
        Err("PDF Printer is Windows-only".to_string())
    }
}

/// List PDFs currently waiting in the printer spool directory. The collection
/// dialog calls this on open and after each `printer:job-arrived` event so
/// the user sees a live list of "PDFs the printer has captured but not yet
/// merged or saved". Returns absolute paths sorted by creation time.
#[tauri::command]
fn list_printer_spool() -> Result<Vec<String>, String> {
    #[cfg(target_os = "windows")]
    {
        let dir = get_printer_spool_dir()?;
        let dir_path = std::path::Path::new(&dir);
        let mut entries: Vec<(std::time::SystemTime, String)> = Vec::new();
        for e in std::fs::read_dir(dir_path)
            .map_err(|e| format!("Failed to read spool: {}", e))? {
            if let Ok(entry) = e {
                let path = entry.path();
                if path.extension().and_then(|x| x.to_str()) == Some("pdf") {
                    let created = entry.metadata().ok()
                        .and_then(|m| m.created().ok())
                        .unwrap_or(std::time::SystemTime::UNIX_EPOCH);
                    entries.push((created, path.to_string_lossy().to_string()));
                }
            }
        }
        entries.sort_by_key(|(t, _)| *t);
        Ok(entries.into_iter().map(|(_, p)| p).collect())
    }
    #[cfg(not(target_os = "windows"))]
    {
        Ok(Vec::new())
    }
}

/// Remove a captured print-job PDF from the spool after the collection
/// dialog has merged it into the saved output (or after the user clicks
/// Discard). The collection dialog calls this for each spool entry it
/// consumed so the next print job starts fresh.
#[tauri::command]
fn discard_spool_pdf(path: String) -> Result<bool, String> {
    let p = std::path::Path::new(&path);
    // Safety: only allow deletion under the spool directory to prevent the
    // dialog from accidentally being tricked into rm-rf'ing arbitrary files.
    let spool = get_printer_spool_dir()?;
    if !p.starts_with(&spool) {
        return Err("Path is not in the printer spool directory".to_string());
    }
    std::fs::remove_file(p)
        .map_err(|e| format!("Failed to remove spool file: {}", e))?;
    Ok(true)
}

/// Open a file in the system's default PDF viewer. Used by the auto-open
/// hook after a successful Save As so the user immediately sees their
/// freshly-saved file in their preferred reader.
///
/// Windows: `cmd /C start "" "<path>"` — the empty title argument prevents
/// `start` from interpreting the path as a window title (a long-standing
/// quoting quirk). The shell `start` verb honours the user's default app
/// association for .pdf, so whichever reader the user prefers opens it.
///
/// macOS: `open "<path>"` honours `LSHandlerContentType` for .pdf.
/// Linux: `xdg-open "<path>"` honours the `application/pdf` MIME default.
#[tauri::command]
fn open_pdf_in_default_viewer(path: String) -> Result<bool, String> {
    if !std::path::Path::new(&path).exists() {
        return Err(format!("File not found: {}", path));
    }
    // Niet-desktop-platforms (mobile): geen externe-viewer-concept — nette
    // fout i.p.v. een cfg-if zonder else (compileerfout E0317 op Android).
    #[cfg(not(any(target_os = "windows", target_os = "macos", target_os = "linux")))]
    {
        let _ = &path;
        return Err("Opening in an external viewer is not supported on this platform".into());
    }
    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x08000000;
        // `cmd /C start "" "<path>"` is the Windows idiom for "open this
        // file with whatever the user has set as the default handler".
        // The double-quoted empty title is required: without it, `start`
        // treats the quoted path as the window title and then has no file
        // argument to open.
        std::process::Command::new("cmd")
            .args(&["/C", "start", "", &path])
            .creation_flags(CREATE_NO_WINDOW)
            .spawn()
            .map_err(|e| format!("Failed to launch default PDF viewer: {}", e))?;
        Ok(true)
    }
    #[cfg(target_os = "macos")]
    {
        std::process::Command::new("open")
            .arg(&path)
            .spawn()
            .map_err(|e| format!("Failed to launch default PDF viewer: {}", e))?;
        Ok(true)
    }
    #[cfg(target_os = "linux")]
    {
        std::process::Command::new("xdg-open")
            .arg(&path)
            .spawn()
            .map_err(|e| format!("Failed to launch default PDF viewer: {}", e))?;
        Ok(true)
    }
}

/// Reveal a file in the OS file manager (Explorer / Finder / Linux file
/// manager), with the file selected where the platform supports it.
#[tauri::command]
fn reveal_in_file_manager(path: String) -> Result<bool, String> {
    if !std::path::Path::new(&path).exists() {
        return Err(format!("File not found: {}", path));
    }
    // Non-desktop platforms (mobile): no file-manager concept — return a
    // clean error instead of a cfg-if without else (compile error E0317).
    #[cfg(not(any(target_os = "windows", target_os = "macos", target_os = "linux")))]
    {
        let _ = &path;
        return Err("Showing in the file manager is not supported on this platform".into());
    }
    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        // `explorer /select,"<path>"` opens Explorer with the file selected.
        // The switch and the path must travel as ONE argument; raw_arg keeps
        // the quoting intact for paths with spaces (normal .arg() quoting
        // would wrap the whole `/select,...` blob and confuse explorer).
        no_window_command("explorer")
            .raw_arg(format!("/select,\"{}\"", path))
            .spawn()
            .map_err(|e| format!("Failed to open Explorer: {}", e))?;
        Ok(true)
    }
    #[cfg(target_os = "macos")]
    {
        // `open -R` reveals (selects) the file in a Finder window.
        std::process::Command::new("open")
            .args(["-R", &path])
            .spawn()
            .map_err(|e| format!("Failed to open Finder: {}", e))?;
        Ok(true)
    }
    #[cfg(target_os = "linux")]
    {
        // No universal "select file" verb across file managers; open the
        // containing directory via xdg-open (works on every desktop).
        let parent = std::path::Path::new(&path)
            .parent()
            .ok_or_else(|| "Bestand heeft geen bovenliggende map".to_string())?;
        std::process::Command::new("xdg-open")
            .arg(parent)
            .spawn()
            .map_err(|e| format!("Failed to open file manager: {}", e))?;
        Ok(true)
    }
}

/// Download a PDF from a URL and save it to a temp file.
/// Returns the temp file path on success.
#[tauri::command]
async fn download_pdf_from_url(url: String) -> Result<String, String> {
    remote_pdf::download_pdf_from_url(&url).await
}

/// List PDF files in a directory.
/// Returns a list of full file paths for .pdf files found.
#[tauri::command(async)]
fn list_pdf_files(dir: String) -> Result<Vec<String>, String> {
    let entries = fs::read_dir(&dir).map_err(|e| format!("Failed to read directory: {}", e))?;
    let mut pdf_files: Vec<String> = Vec::new();

    for entry in entries {
        if let Ok(entry) = entry {
            let path = entry.path();
            if path.is_file() {
                if let Some(ext) = path.extension() {
                    if ext.to_string_lossy().to_lowercase() == "pdf" {
                        pdf_files.push(path.to_string_lossy().to_string());
                    }
                }
            }
        }
    }

    pdf_files.sort();
    Ok(pdf_files)
}

#[tauri::command]
fn play_alert_sound() {
    #[cfg(target_os = "windows")]
    {
        use std::os::raw::c_uint;
        #[link(name = "user32")]
        extern "system" {
            fn MessageBeep(uType: c_uint) -> i32;
        }
        unsafe { MessageBeep(0x00000030); } // MB_ICONEXCLAMATION
    }
    #[cfg(target_os = "macos")]
    {
        std::process::Command::new("afplay")
            .arg("/System/Library/Sounds/Funk.aiff")
            .spawn()
            .ok();
    }
    #[cfg(target_os = "linux")]
    {
        std::process::Command::new("paplay")
            .arg("/usr/share/sounds/freedesktop/stereo/dialog-warning.oga")
            .spawn()
            .ok();
    }
}

// --- Plugin Management ---

const MAX_PLUGIN_MANIFEST_BYTES: u64 = 1024 * 1024;
const MAX_PLUGIN_ARCHIVE_FILES: usize = 512;
const MAX_PLUGIN_EXTRACTED_BYTES: u64 = 128 * 1024 * 1024;
static PLUGIN_INSTALL_LOCK: Mutex<()> = Mutex::new(());

fn valid_plugin_id(id: &str) -> bool {
    id.len() <= 128
        && id.as_bytes().first().is_some_and(u8::is_ascii_alphanumeric)
        && id.bytes().all(|b| b.is_ascii_alphanumeric() || matches!(b, b'.' | b'-' | b'_'))
}

fn plugin_path(plugins_dir: &std::path::Path, id: &str) -> Result<std::path::PathBuf, String> {
    if !valid_plugin_id(id) { return Err("Invalid plugin id".into()); }
    Ok(plugins_dir.join(id))
}

fn recover_plugin_backup(plugin_dir: &std::path::Path, backup: &std::path::Path) -> Result<(), String> {
    match backup.symlink_metadata() {
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Err(error) => return Err(format!("Cannot inspect previous plugin installation: {error}")),
        Ok(meta) => {
            if !meta.is_dir() || meta.file_type().is_symlink() { return Err("Unsafe previous plugin installation".into()); }
            if let Ok(active) = plugin_dir.symlink_metadata() {
                if !active.is_dir() || active.file_type().is_symlink() { return Err("Unsafe existing plugin installation".into()); }
                fs::remove_dir_all(backup).map_err(|e| format!("Cannot clean previous plugin installation: {e}"))?;
            } else {
                fs::rename(backup, plugin_dir).map_err(|e| format!("Cannot restore previous plugin installation: {e}"))?;
            }
        }
    }
    Ok(())
}

// zip 2.x indexes central-directory entries by name and silently replaces
// earlier entries with the same name. Inspect the raw directory before using
// its deduplicated view so an archive cannot hide entries from our checks.
fn validate_plugin_central_directory(file: &mut fs::File, start: u64, parsed_count: usize) -> Result<(), String> {
    use std::io::{Read, Seek};
    let len = file.metadata().map_err(|e| format!("Cannot inspect plugin archive: {e}"))?.len();
    let mut position = start;
    let mut count = 0;
    let mut names = std::collections::HashSet::new();
    loop {
        if position.checked_add(4).is_none_or(|end| end > len) {
            return Err("Invalid plugin central directory".into());
        }
        file.seek(std::io::SeekFrom::Start(position)).map_err(|e| format!("Cannot read plugin central directory: {e}"))?;
        let mut header = [0u8; 46];
        file.read_exact(&mut header[..4]).map_err(|e| format!("Cannot read plugin central directory: {e}"))?;
        if &header[..4] != b"PK\x01\x02" { break; }
        if position.checked_add(header.len() as u64).is_none_or(|end| end > len) {
            return Err("Invalid plugin central directory".into());
        }
        file.read_exact(&mut header[4..]).map_err(|e| format!("Cannot read plugin central directory: {e}"))?;
        let name_len = u16::from_le_bytes([header[28], header[29]]) as u64;
        let extra_len = u16::from_le_bytes([header[30], header[31]]) as u64;
        let comment_len = u16::from_le_bytes([header[32], header[33]]) as u64;
        let next = position.checked_add(header.len() as u64)
            .and_then(|n| n.checked_add(name_len))
            .and_then(|n| n.checked_add(extra_len))
            .and_then(|n| n.checked_add(comment_len))
            .ok_or("Invalid plugin central directory")?;
        if next > len { return Err("Invalid plugin central directory".into()); }
        let mut name = vec![0u8; name_len as usize];
        file.read_exact(&mut name).map_err(|e| format!("Cannot read plugin central directory: {e}"))?;
        if !names.insert(name) { return Err("Duplicate plugin archive path".into()); }
        count += 1;
        if count > MAX_PLUGIN_ARCHIVE_FILES { return Err("Plugin archive has too many files".into()); }
        position = next;
    }
    if count != parsed_count { return Err("Duplicate or hidden plugin archive path".into()); }
    Ok(())
}

fn install_plugin_archive(src_path: &std::path::Path, plugins_dir: &std::path::Path) -> Result<serde_json::Value, String> {
    use std::io::{Read, Seek};
    let file = fs::File::open(src_path).map_err(|e| format!("Failed to open plugin file: {e}"))?;
    let archive = zip::ZipArchive::new(file).map_err(|e| format!("Invalid plugin archive: {e}"))?;
    if archive.len() == 0 || archive.len() > MAX_PLUGIN_ARCHIVE_FILES {
        return Err("Plugin archive has too many files".into());
    }
    let central_start = archive.central_directory_start();
    let parsed_count = archive.len();
    let mut file = archive.into_inner();
    validate_plugin_central_directory(&mut file, central_start, parsed_count)?;
    file.seek(std::io::SeekFrom::Start(0)).map_err(|e| format!("Cannot rewind plugin archive: {e}"))?;
    let mut archive = zip::ZipArchive::new(file).map_err(|e| format!("Invalid plugin archive: {e}"))?;
    let manifest_content = {
        let mut entry = archive.by_name("plugin.json").map_err(|_| "Plugin archive must contain plugin.json")?;
        if entry.size() > MAX_PLUGIN_MANIFEST_BYTES { return Err("Plugin manifest is too large".into()); }
        let mut bytes = Vec::new();
        entry.by_ref().take(MAX_PLUGIN_MANIFEST_BYTES + 1).read_to_end(&mut bytes)
            .map_err(|e| format!("Failed to read plugin.json: {e}"))?;
        if bytes.len() as u64 > MAX_PLUGIN_MANIFEST_BYTES { return Err("Plugin manifest is too large".into()); }
        bytes
    };
    let manifest: serde_json::Value = serde_json::from_slice(&manifest_content)
        .map_err(|e| format!("Invalid plugin.json: {e}"))?;
    let plugin_id = manifest.get("id").and_then(|v| v.as_str()).ok_or("plugin.json must have an 'id' field")?;
    let plugin_dir = plugin_path(plugins_dir, plugin_id)?;
    let backup = plugins_dir.join(format!(".previous-{plugin_id}"));
    recover_plugin_backup(&plugin_dir, &backup)?;

    let stage = (0..16).find_map(|_| {
        let candidate = plugins_dir.join(format!(".plugin-stage-{:016x}", rand::random::<u64>()));
        match fs::create_dir(&candidate) {
            Ok(()) => Some(Ok(candidate)),
            Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => None,
            Err(e) => Some(Err(format!("Cannot stage plugin: {e}"))),
        }
    }).ok_or("Cannot allocate plugin staging directory")??;

    let result = (|| {
        let mut names = std::collections::HashSet::new();
        let mut remaining = MAX_PLUGIN_EXTRACTED_BYTES;
        for i in 0..archive.len() {
            let entry = archive.by_index(i).map_err(|e| format!("Archive error: {e}"))?;
            let name = entry.enclosed_name().ok_or("Unsafe plugin archive path")?;
            if name.components().any(|c| !matches!(c, std::path::Component::Normal(_))) {
                return Err("Unsafe plugin archive path".into());
            }
            if !names.insert(name.clone()) { return Err("Duplicate plugin archive path".into()); }
            if entry.is_symlink() { return Err("Plugin archive contains a symbolic link".into()); }
            let destination = stage.join(&name);
            if entry.is_dir() {
                fs::create_dir_all(&destination).map_err(|e| format!("Cannot stage plugin directory: {e}"))?;
            } else {
                if entry.size() > remaining { return Err("Plugin archive is too large".into()); }
                if let Some(parent) = destination.parent() {
                    fs::create_dir_all(parent).map_err(|e| format!("Cannot stage plugin directory: {e}"))?;
                }
                let mut output = fs::File::create(&destination).map_err(|e| format!("Cannot stage plugin file: {e}"))?;
                let copied = std::io::copy(&mut entry.take(remaining + 1), &mut output)
                    .map_err(|e| format!("Cannot extract plugin file: {e}"))?;
                if copied > remaining { return Err("Plugin archive is too large".into()); }
                remaining -= copied;
            }
        }
        if !stage.join("index.js").is_file() || !stage.join("plugin.json").is_file() {
            return Err("Plugin archive must contain index.js and plugin.json".into());
        }
        if let Ok(meta) = plugin_dir.symlink_metadata() {
            if !meta.is_dir() || meta.file_type().is_symlink() { return Err("Unsafe existing plugin installation".into()); }
            fs::rename(&plugin_dir, &backup).map_err(|e| format!("Cannot save previous plugin: {e}"))?;
        }
        if let Err(error) = fs::rename(&stage, &plugin_dir) {
            if backup.is_dir() {
                fs::rename(&backup, &plugin_dir).map_err(|rollback| format!("Cannot install plugin ({error}) or restore previous plugin ({rollback})"))?;
            }
            return Err(format!("Cannot install plugin: {error}"));
        }
        if backup.is_dir() {
            fs::remove_dir_all(&backup).map_err(|e| format!("Plugin installed, but cannot clean previous version: {e}"))?;
        }
        Ok(manifest)
    })();
    let _ = fs::remove_dir_all(stage);
    result
}

fn get_plugins_dir() -> std::path::PathBuf {
    let data_dir = datamap::lokale_datamap().unwrap_or_else(|| std::path::PathBuf::from("."));
    let plugins_dir = data_dir.join(APP_STORAGE_DIR).join("plugins");
    if !plugins_dir.exists() {
        let _ = fs::create_dir_all(&plugins_dir);
    }
    plugins_dir
}

#[tauri::command(async)]
fn list_plugins() -> Result<Vec<serde_json::Value>, String> {
    let plugins_dir = get_plugins_dir();
    let mut plugins = Vec::new();

    if let Ok(entries) = fs::read_dir(&plugins_dir) {
        for entry in entries.flatten() {
            let name = entry.file_name();
            if !name.to_str().is_some_and(valid_plugin_id) { continue; }
            let path = entry.path();
            if path.symlink_metadata().is_ok_and(|meta| meta.is_dir() && !meta.file_type().is_symlink()) {
                if let Some(manifest_path) = addon_file(&path, "plugin.json") {
                    if let Ok(content) = fs::read_to_string(&manifest_path) {
                        if let Ok(manifest) = serde_json::from_str::<serde_json::Value>(&content) {
                            if manifest.get("id").and_then(|id| id.as_str()) != name.to_str() { continue; }
                            plugins.push(manifest);
                        }
                    }
                }
            }
        }
    }

    Ok(plugins)
}

#[tauri::command]
fn install_plugin(path: String) -> Result<serde_json::Value, String> {
    let _guard = PLUGIN_INSTALL_LOCK.lock().map_err(|e| e.to_string())?;
    let plugins_dir = get_plugins_dir();
    install_plugin_archive(std::path::Path::new(&path), &plugins_dir)
}

#[tauri::command]
fn uninstall_plugin(id: String) -> Result<bool, String> {
    let _guard = PLUGIN_INSTALL_LOCK.lock().map_err(|e| e.to_string())?;
    let plugins_dir = get_plugins_dir();
    let plugin_dir = plugin_path(&plugins_dir, &id)?;
    let backup = plugins_dir.join(format!(".previous-{id}"));
    recover_plugin_backup(&plugin_dir, &backup)?;

    if plugin_dir.symlink_metadata().is_ok() {
        if !plugin_dir.is_dir() || plugin_dir.is_symlink() { return Err("Unsafe plugin installation".into()); }
        fs::remove_dir_all(&plugin_dir).map_err(|e| format!("Failed to remove plugin: {}", e))?;
    }

    Ok(true)
}

#[tauri::command(async)]
fn read_plugin_file(plugin_id: String, file_path: String) -> Result<String, String> {
    let plugins_dir = get_plugins_dir();
    let plugin_dir = plugin_path(&plugins_dir, &plugin_id)?;
    let full_path = addon_file(&plugin_dir, &file_path).ok_or("Invalid plugin file path")?;
    fs::read_to_string(&full_path).map_err(|e| format!("Failed to read file: {}", e))
}

#[cfg(test)]
mod legacy_plugin_install_tests {
    use super::*;
    use std::io::Write;

    fn write_manifest(zip: &mut zip::ZipWriter<fs::File>, id: &str) {
        zip.start_file("plugin.json", zip::write::SimpleFileOptions::default()).unwrap();
        zip.write_all(format!(r#"{{"id":"{id}"}}"#).as_bytes()).unwrap();
    }

    fn archive(path: &std::path::Path, id: &str, script: Option<&str>) {
        let file = fs::File::create(path).unwrap();
        let mut zip = zip::ZipWriter::new(file);
        let options = zip::write::SimpleFileOptions::default();
        write_manifest(&mut zip, id);
        if let Some(script) = script {
            zip.start_file("index.js", options).unwrap();
            zip.write_all(script.as_bytes()).unwrap();
        }
        zip.finish().unwrap();
    }

    #[test]
    fn plugin_ids_cannot_name_the_plugins_root() {
        for id in ["", ".", "..", "../other", "/other", "C:", "a/b", "a\\b", "-bad"] {
            assert!(!valid_plugin_id(id), "accepted {id:?}");
        }
        assert!(valid_plugin_id("com.example.plugin"));
    }

    #[test]
    fn malformed_archive_preserves_existing_plugin() {
        let root = std::env::temp_dir().join(format!("ocudraw-plugin-test-{:016x}", rand::random::<u64>()));
        fs::create_dir(&root).unwrap();
        let plugins = root.join("plugins");
        fs::create_dir(&plugins).unwrap();
        let existing = plugins.join("com.example.plugin");
        fs::create_dir(&existing).unwrap();
        fs::write(existing.join("index.js"), b"old").unwrap();
        let malicious = root.join("bad.oppx");
        archive(&malicious, ".", Some("bad"));
        assert!(install_plugin_archive(&malicious, &plugins).is_err());
        assert_eq!(fs::read(existing.join("index.js")).unwrap(), b"old");
        let incomplete = root.join("incomplete.oppx");
        archive(&incomplete, "com.example.plugin", None);
        assert!(install_plugin_archive(&incomplete, &plugins).is_err());
        assert_eq!(fs::read(existing.join("index.js")).unwrap(), b"old");
        let replacement = root.join("good.oppx");
        archive(&replacement, "com.example.plugin", Some("new"));
        install_plugin_archive(&replacement, &plugins).unwrap();
        assert_eq!(fs::read(existing.join("index.js")).unwrap(), b"new");
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn path_traversal_archive_preserves_existing_plugin() {
        let root = std::env::temp_dir().join(format!("ocudraw-plugin-path-test-{:016x}", rand::random::<u64>()));
        fs::create_dir(&root).unwrap();
        let plugins = root.join("plugins");
        let existing = plugins.join("com.example.plugin");
        fs::create_dir_all(&existing).unwrap();
        fs::write(existing.join("index.js"), b"old").unwrap();

        let file = root.join("traversal.oppx");
        let mut zip = zip::ZipWriter::new(fs::File::create(&file).unwrap());
        let options = zip::write::SimpleFileOptions::default();
        write_manifest(&mut zip, "com.example.plugin");
        zip.start_file("index.js", options).unwrap();
        zip.write_all(b"new").unwrap();
        zip.start_file("../escape.txt", options).unwrap();
        zip.write_all(b"bad").unwrap();
        zip.finish().unwrap();

        let error = install_plugin_archive(&file, &plugins).unwrap_err();
        assert!(error.contains("Unsafe plugin archive path"), "{error}");
        assert_eq!(fs::read(existing.join("index.js")).unwrap(), b"old");
        assert_eq!(fs::read_dir(&plugins).unwrap().count(), 1, "staging residue after traversal entry");
        assert!(!root.join("escape.txt").exists());
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn duplicate_archive_names_preserve_existing_plugin() {
        let root = std::env::temp_dir().join(format!("ocudraw-plugin-duplicate-test-{:016x}", rand::random::<u64>()));
        fs::create_dir(&root).unwrap();
        let plugins = root.join("plugins");
        let existing = plugins.join("com.example.plugin");
        fs::create_dir_all(&existing).unwrap();
        fs::write(existing.join("index.js"), b"old").unwrap();

        let file = root.join("duplicate.oppx");
        let mut zip = zip::ZipWriter::new(fs::File::create(&file).unwrap());
        let options = zip::write::SimpleFileOptions::default();
        write_manifest(&mut zip, "com.example.plugin");
        zip.start_file("index.js", options).unwrap();
        zip.write_all(b"new").unwrap();
        zip.start_file("other.js", options).unwrap();
        zip.write_all(b"bad").unwrap();
        zip.finish().unwrap();
        // ZipWriter refuses duplicate names; replace equal-length names in
        // the local and central headers to exercise the raw-directory check.
        let mut bytes = fs::read(&file).unwrap();
        let mut replacements = 0;
        for index in 0..=bytes.len() - b"other.js".len() {
            if &bytes[index..index + b"other.js".len()] == b"other.js" {
                bytes[index..index + b"index.js".len()].copy_from_slice(b"index.js");
                replacements += 1;
            }
        }
        assert!(replacements >= 2);
        fs::write(&file, bytes).unwrap();

        let error = install_plugin_archive(&file, &plugins).unwrap_err();
        assert!(error.contains("Duplicate plugin archive path"), "{error}");
        assert_eq!(fs::read(existing.join("index.js")).unwrap(), b"old");
        assert_eq!(fs::read_dir(&plugins).unwrap().count(), 1, "staging residue after duplicate entry");
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn oversized_archive_entry_preserves_existing_plugin() {
        let root = std::env::temp_dir().join(format!("ocudraw-plugin-size-test-{:016x}", rand::random::<u64>()));
        fs::create_dir(&root).unwrap();
        let plugins = root.join("plugins");
        let existing = plugins.join("com.example.plugin");
        fs::create_dir_all(&existing).unwrap();
        fs::write(existing.join("index.js"), b"old").unwrap();

        let file = root.join("oversized.oppx");
        let mut zip = zip::ZipWriter::new(fs::File::create(&file).unwrap());
        let options = zip::write::SimpleFileOptions::default();
        write_manifest(&mut zip, "com.example.plugin");
        zip.start_file("index.js", options).unwrap();
        zip.write_all(b"new").unwrap();
        zip.start_file("large.bin", options.compression_method(zip::CompressionMethod::Deflated).compression_level(Some(1))).unwrap();
        let block = [0u8; 1024 * 1024];
        for _ in 0..(MAX_PLUGIN_EXTRACTED_BYTES / block.len() as u64 + 1) {
            zip.write_all(&block).unwrap();
        }
        zip.finish().unwrap();

        let error = install_plugin_archive(&file, &plugins).unwrap_err();
        assert!(error.contains("Plugin archive is too large"), "{error}");
        assert_eq!(fs::read(existing.join("index.js")).unwrap(), b"old");
        assert_eq!(fs::read_dir(&plugins).unwrap().count(), 1, "staging residue after oversized entry");
        fs::remove_dir_all(root).unwrap();
    }
}

// ─── Allow FS access to a path (for testing / programmatic file opens) ────
#[tauri::command(async)]
fn allow_fs_scope(app: tauri::AppHandle, path: String) -> Result<bool, String> {
    app.fs_scope().allow_file(&path)
        .map_err(|e| format!("{}", e))?;
    // Also allow the directory for related files
    if let Some(parent) = std::path::Path::new(&path).parent() {
        let _ = app.fs_scope().allow_directory(parent, false);
    }
    Ok(true)
}

// ─── PDF rendering via open-pdf-render (pure Rust) ────────────────────────
use open_pdf_render::{DocumentHandle, PdfRenderer};

/// Get a cached `Arc<DocumentHandle>` for the given file, or load + cache one.
///
/// First checks the DocHandleCache. On miss, falls back to the bytes cache
/// (or disk), parses the PDF once, and stores the resulting Arc in the
/// handle cache for all future commands. The handle owns its own internal
/// font registry so subsequent extract_draw_commands calls reuse all glyph
/// outlines from previous pages.
fn get_or_load_doc(
    path: &str,
    bytes_cache: &PdfBytesCache,
    handle_cache: &DocHandleCache,
) -> Result<Arc<DocumentHandle>, String> {
    let generation = handle_cache.0.lock()
        .map_err(|e| format!("Handle cache lock: {}", e))?.generation();
    get_or_load_doc_at_generation(path, bytes_cache, handle_cache, generation)
}

fn get_or_load_doc_at_generation(
    path: &str,
    bytes_cache: &PdfBytesCache,
    handle_cache: &DocHandleCache,
    generation: u64,
) -> Result<Arc<DocumentHandle>, String> {
    // Fast path — handle already cached
    {
        let cache_map = handle_cache.0.lock().map_err(|e| format!("Handle cache lock: {}", e))?;
        if let Some(handle) = cache_map.get_if_generation(generation, path) {
            return Ok(handle);
        }
    }

    // Slow path — fetch bytes (from cache or disk), parse, insert
    let bytes = cached_pdf_bytes(&bytes_cache, &path)?;

    let renderer = PdfRenderer::new();
    let handle = renderer.load_document(&bytes).map_err(|e| format!("{}", e))?;
    let arc = Arc::new(handle);

    {
        let mut hm = handle_cache.0.lock().map_err(|e| format!("Handle cache lock: {}", e))?;
        // The parse may have crossed an invalidation. In that case the old
        // command can use its own handle, but must not cache it for new work.
        if let Some(cached) = hm.insert_if_generation(generation, path.to_string(), arc.clone()) {
            return Ok(cached);
        }
    }
    Ok(arc)
}

/// DEBUG / BENCHMARK TOOL. Render a page using our own open-pdf-render Skia
/// kernel instead of PDFium. NOT wired into the live render path — production
/// rendering always goes through `render_pdf_page` (PDFium). Kept callable for
/// explicit head-to-head benchmarks if open-pdf-render's accuracy improves.
///
/// Wire format matches `render_pdf_page` exactly: `[w:u32 LE][h:u32 LE]
/// [rgba…]`. Probes can swap one invoke for the other without unpacking
/// differently.
///
/// IMPORTANT: open-pdf-render is currently below the < 2 % pixel-diff goal
/// vs PDFium (per scripts/render-regression-test.py). Some
/// pages render incorrectly. Speed numbers from this command must always be
/// read with that disclaimer until the regression suite reports green.
#[tauri::command(async)]
fn render_pdf_page_skia(
    path: String,
    page_index: u32,
    scale: f32,
    rotation: Option<i32>,
    ocg_visibility: Option<Vec<ocg_render_copy::LayerVisibility>>,
    bytes_cache: tauri::State<PdfBytesCache>,
    handle_cache: tauri::State<DocHandleCache>,
) -> Result<tauri::ipc::Response, String> {
    let visibility = ocg_render_copy::canonical_visibility(ocg_visibility.as_deref().unwrap_or(&[]))
        .map_err(|e| format!("OCG selection: {e}"))?;
    if !visibility.is_empty() {
        return Err("OCG content requires PDFium renderer".into());
    }
    let extra_rot = rotation.unwrap_or(0);
    let doc = get_or_load_doc(&path, &bytes_cache, &handle_cache)?;
    if doc.has_optional_content() {
        return Err("OCG content requires PDFium renderer".into());
    }
    let rendered = doc.render_page(page_index as usize, scale, extra_rot)
        .map_err(|e| format!("{}", e))?;
    let mut out = Vec::with_capacity(8 + rendered.rgba.len());
    out.extend_from_slice(&rendered.width.to_le_bytes());
    out.extend_from_slice(&rendered.height.to_le_bytes());
    out.extend_from_slice(&rendered.rgba);
    Ok(tauri::ipc::Response::new(out))
}

/// Whether the PDFium worker pool has finished spawning. Lets the frontend
/// skip optional work (e.g. the cold-open pre-render) that would otherwise
/// fall back to an in-process PDFium parse in the main process — on a large
/// document that fallback runs concurrently with the PDF.js parse of the
/// same bytes and can take the whole load down at startup.
#[tauri::command(async)]
fn worker_pool_ready(
    pool: tauri::State<'_, std::sync::Arc<tokio::sync::OnceCell<worker_pool::WorkerPool>>>,
) -> bool {
    pool.get().is_some()
}

/// True when a pool error means the worker process itself went away (EOF or a
/// broken pipe), as opposed to a timeout or a bitmap that did not fit.
fn worker_died(e: &anyhow::Error) -> bool {
    let msg = e.to_string();
    msg.ends_with(" EOF") || msg.starts_with("write to worker") || msg.starts_with("read from worker")
}

/// A render may finish after a save has evicted its source. Wait for every
/// worker's invalidation acknowledgement before retrying: an immediate retry
/// could hit the same worker's old PDF handle while invalidation is queued.
const MAX_RENDER_GENERATION_ATTEMPTS: usize = 3;

async fn accept_render_generation(
    path: &str,
    generation: u64,
    pixmap_cache: &pdfium_renderer::PixmapCacheState,
    pool: &tokio::sync::OnceCell<worker_pool::WorkerPool>,
) -> Result<bool, String> {
    if pixmap_cache.with_generation(path, Some(generation), || ()).is_some() {
        return Ok(true);
    }
    if let Some(pool) = pool.get() {
        pool.invalidate(path).await
            .map_err(|e| format!("PDFium worker cache invalidation: {e}"))?;
    }
    Ok(false)
}

#[cfg(test)]
mod native_render_save_race_tests {
    use super::*;
    use std::fs::{FileTimes, OpenOptions};
    use std::sync::atomic::Ordering;

    #[test]
    fn a_cache_hit_returns_the_rendered_frame_bytes() {
        let pixmaps = pdfium_renderer::PixmapCacheState::default();
        let key = ("drawing.pdf".to_string(), 0, 10_000, 0);
        let frame = pdfium_renderer::frame_rgba(2, 1, &[9, 8, 7, 6, 5, 4, 3, 2]);
        let (cached, generation) = pixmaps.lookup_for_render(&key, &[]);
        assert!(cached.is_none());
        cache_rendered_frame(&pixmaps, generation, &key, 2, 1, &frame);
        assert!(pixmaps.lookup_for_render(&key, &[]).0.is_none(), "a first render is not copied in");
        cache_rendered_frame(&pixmaps, generation, &key, 2, 1, &frame);
        let hit = pixmaps.lookup_for_render(&key, &[]).0.expect("second render of the key is cached");
        assert_eq!(hit.framed(), frame.as_slice());
        assert_eq!((hit.width, hit.height), (2, 1));
        // A save drops it again.
        pixmaps.0.lock().unwrap().as_mut().unwrap().remove_path("drawing.pdf");
        assert!(pixmaps.lookup_for_render(&key, &[]).0.is_none());
        cache_rendered_frame(&pixmaps, generation, &key, 2, 1, &frame);
        cache_rendered_frame(&pixmaps, generation, &key, 2, 1, &frame);
        assert!(pixmaps.lookup_for_render(&key, &[]).0.is_none(), "a render from before the save never enters");
    }

    #[tokio::test]
    async fn in_process_response_is_rejected_after_invalidation() {
        let pixmaps = pdfium_renderer::PixmapCacheState::default();
        let generation = pixmaps.snapshot_generation("drawing.pdf").unwrap();
        pixmaps.0.lock().unwrap().as_mut().unwrap().remove_path("drawing.pdf");
        let empty_pool = tokio::sync::OnceCell::new();
        assert!(!accept_render_generation("drawing.pdf", generation, &pixmaps, &empty_pool)
            .await.unwrap());
    }

    #[tokio::test]
    async fn another_documents_invalidation_does_not_reject_a_render() {
        let pixmaps = pdfium_renderer::PixmapCacheState::default();
        let generation = pixmaps.snapshot_generation("drawing.pdf").unwrap();
        pixmaps.0.lock().unwrap().as_mut().unwrap().remove_path("other.pdf");
        let empty_pool = tokio::sync::OnceCell::new();
        assert!(accept_render_generation("drawing.pdf", generation, &pixmaps, &empty_pool)
            .await.unwrap());
    }

    fn drawing_pdf(color: &str) -> Vec<u8> {
        let content = format!("{color} rg 10 10 80 80 re f\n");
        let objects = [
            "<< /Type /Catalog /Pages 2 0 R >>".to_string(),
            "<< /Type /Pages /Kids [3 0 R] /Count 1 >>".to_string(),
            "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 100 100] /Contents 4 0 R >>".to_string(),
            format!("<< /Length {} >>\nstream\n{}endstream", content.len(), content),
        ];
        let mut pdf = b"%PDF-1.4\n".to_vec();
        let mut offsets = vec![0];
        for (i, object) in objects.iter().enumerate() {
            offsets.push(pdf.len());
            pdf.extend_from_slice(format!("{} 0 obj\n{}\nendobj\n", i + 1, object).as_bytes());
        }
        let xref = pdf.len();
        pdf.extend_from_slice(b"xref\n0 5\n0000000000 65535 f \n");
        for offset in offsets.iter().skip(1) {
            pdf.extend_from_slice(format!("{offset:010} 00000 n \n").as_bytes());
        }
        pdf.extend_from_slice(
            format!("trailer\n<< /Size 5 /Root 1 0 R >>\nstartxref\n{xref}\n%%EOF\n").as_bytes(),
        );
        pdf
    }

    /// Run with OCUDRAW_TEST_PDFIUM_WORKER=target/debug/pdfium-worker after
    /// building that binary. A held worker request makes the old response
    /// deterministic while an equal-size/equal-mtime save invalidates it.
    #[cfg(target_os = "linux")]
    #[tokio::test]
    async fn held_worker_response_retries_after_save_invalidation() {
        let Ok(worker_exe) = std::env::var("OCUDRAW_TEST_PDFIUM_WORKER") else {
            eprintln!("Skipping live worker race (set OCUDRAW_TEST_PDFIUM_WORKER)");
            return;
        };
        let worker_exe = std::fs::canonicalize(worker_exe).unwrap();
        let lib = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("binaries/linux-x64/libpdfium.so");
        if !lib.exists() {
            eprintln!("Skipping live worker race (PDFium runtime unavailable)");
            return;
        }
        let unique = format!("{}-{}", std::process::id(),
            std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos());
        let dir = std::env::temp_dir().join(format!("ocudraw-held-render-{unique}"));
        std::fs::create_dir(&dir).unwrap();
        let staged_worker = dir.join("pdfium-worker");
        std::fs::copy(worker_exe, &staged_worker).unwrap();
        std::fs::copy(lib, dir.join("libpdfium.so")).unwrap();
        let path = dir.join("drawing.pdf");
        let red = drawing_pdf("1 0 0");
        let blue = drawing_pdf("0 0 1");
        assert_eq!(red.len(), blue.len());
        std::fs::write(&path, red).unwrap();
        let old_mtime = std::fs::metadata(&path).unwrap().modified().unwrap();
        let path = path.to_string_lossy().into_owned();

        let worker = Arc::new(worker_pool::WorkerState::new(47));
        worker_pool::spawn::spawn_worker(worker.clone(), &staged_worker).await.unwrap();
        let pool = Arc::new(tokio::sync::OnceCell::new());
        assert!(pool.set(worker_pool::WorkerPool::new(vec![worker.clone()])).is_ok());
        let pixmaps = Arc::new(pdfium_renderer::PixmapCacheState::default());
        let red_pixels = pool.get().unwrap().render(&path, 0, 1.0, 0, &[]).await.unwrap().rgba().to_vec();
        let held = worker.request_lock.lock().await;
        let task_pool = pool.clone();
        let task_pixmaps = pixmaps.clone();
        let task_path = path.clone();
        let render = tokio::spawn(async move {
            let generation = task_pixmaps.snapshot_generation(&task_path).unwrap();
            let old = task_pool.get().unwrap().render(&task_path, 0, 1.0, 0, &[]).await.unwrap().rgba().to_vec();
            assert!(!accept_render_generation(&task_path, generation, &task_pixmaps, &task_pool).await.unwrap());
            let mut fresh = Vec::new();
            let mut accepted = false;
            // The save has a final cache barrier after worker invalidation.
            // It may race with the first retry, as it can in the command.
            for _ in 1..MAX_RENDER_GENERATION_ATTEMPTS {
                let fresh_generation = task_pixmaps.snapshot_generation(&task_path).unwrap();
                fresh = task_pool.get().unwrap().render(&task_path, 0, 1.0, 0, &[]).await.unwrap().rgba().to_vec();
                if accept_render_generation(&task_path, fresh_generation, &task_pixmaps, &task_pool).await.unwrap() {
                    accepted = true;
                    break;
                }
            }
            assert!(accepted, "a post-save render should pass by the final retry");
            (old, fresh)
        });
        tokio::time::timeout(std::time::Duration::from_secs(5), async {
            while worker.queue_depth.load(Ordering::Acquire) == 0 {
                tokio::time::sleep(std::time::Duration::from_millis(1)).await;
            }
        }).await.unwrap();

        std::fs::write(&path, blue).unwrap();
        OpenOptions::new().write(true).open(&path).unwrap()
            .set_times(FileTimes::new().set_modified(old_mtime)).unwrap();
        assert_eq!(std::fs::metadata(&path).unwrap().modified().unwrap(), old_mtime);
        pixmaps.0.lock().unwrap().as_mut().unwrap().remove_path(&path);
        let save_pool = pool.clone();
        let save_pixmaps = pixmaps.clone();
        let save_path = path.clone();
        let invalidate = tokio::spawn(async move {
            save_pool.get().unwrap().invalidate(&save_path).await.unwrap();
            save_pixmaps.0.lock().unwrap().as_mut().unwrap().remove_path(&save_path);
        });
        drop(held);
        let (old, fresh) = tokio::time::timeout(std::time::Duration::from_secs(10), render).await.unwrap().unwrap();
        tokio::time::timeout(std::time::Duration::from_secs(10), invalidate).await.unwrap().unwrap();
        assert_eq!(old, red_pixels, "the held request must have used the old worker handle");
        assert_ne!(fresh, red_pixels, "the post-save response must contain the new pixels");

        let mut child = worker.child.lock().await;
        child.as_mut().unwrap().kill().await.unwrap();
        child.as_mut().unwrap().wait().await.unwrap();
        drop(child);
        std::fs::remove_dir_all(dir).unwrap();
    }
}

/// Keep a copy of a fresh full-page frame in the pixmap cache, but only when
/// the cache will retain it (see `PixmapCache::should_store`): the copy is
/// made outside the cache lock and skipped for one-off and oversized frames.
fn cache_rendered_frame(
    pixmap_cache: &pdfium_renderer::PixmapCacheState,
    generation: Option<u64>,
    key: &pdfium_renderer::PixmapKey,
    width: u32,
    height: u32,
    framed: &[u8],
) {
    let Some(generation) = generation else { return };
    let wanted = pixmap_cache.0.lock().ok()
        .and_then(|mut guard| guard.as_mut().map(|cache| cache.should_store(generation, key, framed.len())))
        .unwrap_or(false);
    if !wanted {
        return;
    }
    let pixmap = Arc::new(pdfium_renderer::CachedPixmap::from_framed(width, height, framed.to_vec()));
    if let Ok(mut guard) = pixmap_cache.0.lock() {
        if let Some(cache) = guard.as_mut() {
            cache.insert_if_generation(generation, key.clone(), pixmap);
        }
    }
}

#[tauri::command]
async fn render_pdf_page(
    path: String,
    page_index: u32,
    scale: f32,
    rotation: Option<i32>,
    worker_only: Option<bool>,
    ocg_visibility: Option<Vec<ocg_render_copy::LayerVisibility>>,
    annot_appearance: Option<Vec<String>>,
    annot_appearance_index: Option<Vec<u32>>,
    bytes_cache: tauri::State<'_, PdfBytesCache>,
    pdfium_cache: tauri::State<'_, pdfium_renderer::PdfiumDocCache>,
    pixmap_cache: tauri::State<'_, pdfium_renderer::PixmapCacheState>,
    pool: tauri::State<'_, std::sync::Arc<tokio::sync::OnceCell<worker_pool::WorkerPool>>>,
) -> Result<tauri::ipc::Response, String> {
    let visibility = ocg_render_copy::canonical_visibility(ocg_visibility.as_deref().unwrap_or(&[]))
        .map_err(|e| format!("OCG selection: {e}"))?;
    // Untouched imported markups (by /NM) rastered from their own /AP
    // (js/pdf/ap-render-state.js). Such a bitmap depends on the list, so it
    // bypasses the path-keyed pixmap cache.
    let annot_show = pdfium_renderer::AnnotShow::from_request(annot_appearance, annot_appearance_index);
    let annot_appearance = annot_show.as_ref();
    let extra_rot = rotation.unwrap_or(0);
    let scale_q = (scale * 10_000.0).round() as u32;
    let cache_key = (path.clone(), page_index, scale_q, extra_rot);

    // A second save can invalidate the retry too; fail closed after three tries.
    for _attempt in 0..MAX_RENDER_GENERATION_ATTEMPTS {
        // Keep a response token even for selected OCG copies, which intentionally
        // cannot enter the default pixmap/document caches.
        let response_generation = pixmap_cache.snapshot_generation(&path)
            .ok_or("Pixmap cache lock unavailable")?;

        // A selected render copy cannot use the path-keyed default pixmap cache.
        let (cached, render_generation) = pixmap_cache.lookup_for_render(&cache_key, &visibility);
        let cached = if annot_appearance.is_some() { None } else { cached };
        let pixmap_generation = if annot_appearance.is_some() { None } else { render_generation };
        if let Some(cached) = cached {
            // One copy: the IPC response owns its bytes.
            let data = cached.framed().to_vec();
            if accept_render_generation(&path, response_generation, &pixmap_cache, &pool).await? {
                return Ok(tauri::ipc::Response::new(data));
            }
            continue;
        }

        // Try the worker pool first
        if let Some(p) = pool.get() {
            let worker_render = if worker_only.unwrap_or(false) {
                p.render_background_with_annotations(&path, page_index, scale, extra_rot, &visibility, annot_appearance).await
            } else {
                p.render_with_annotations(&path, page_index, scale, extra_rot, &visibility, annot_appearance).await
            };
            match worker_render {
                Ok(bitmap) => {
                    // The pool returns the wire format already; the pixmap
                    // cache copies it only when it will keep it.
                    let (width, height) = (bitmap.width, bitmap.height);
                    let data = bitmap.into_framed();
                    cache_rendered_frame(&pixmap_cache, pixmap_generation, &cache_key, width, height, &data);
                    if accept_render_generation(&path, response_generation, &pixmap_cache, &pool).await? {
                        return Ok(tauri::ipc::Response::new(data));
                    }
                    continue;
                }
                Err(e) => {
                    // A worker can die while parsing a malformed PDF. Retrying
                    // that same file inside the GUI process would move the native
                    // PDFium crash into the app itself (observed with Tekst.pdf).
                    // The pool already retries on a second worker; keep the
                    // failure isolated and let the UI show a render error.
                    // Other failures (timeout, bitmap too large for the shared
                    // memory, an older worker) still fall back to in-proc.
                    if worker_died(&e) {
                        return Err(format!("PDFium worker render failed: {e}"));
                    }
                    if worker_only.unwrap_or(false) {
                        return Err(format!("PDFium worker render failed: {e}"));
                    }
                    eprintln!("[render_pdf_page] pool render failed: {} — falling back to in-proc", e);
                }
            }
        }

        if worker_only.unwrap_or(false) {
            return Err("PDFium worker pool is not ready".to_string());
        }

        // Fallback: in-proc PDFium.
        let bytes = cached_pdf_bytes(&bytes_cache, &path)?;

        let render_bytes = if visibility.is_empty() { bytes } else {
            std::sync::Arc::new(ocg_render_copy::render_copy(&bytes, &visibility)
                .map_err(|e| format!("OCG render copy: {e}"))?)
        };
        let handle = pdfium_renderer::get_or_load_pdfium_doc_for_render(
            &path,
            render_bytes,
            &pdfium_cache,
            &pixmap_cache,
            render_generation,
        )?;

        let (width, height, rgba) = pdfium_renderer::render_page_to_rgba_with_annotations(
            handle.document(),
            page_index,
            scale,
            extra_rot,
            annot_appearance,
        )?;

        let data = pdfium_renderer::frame_rgba(width, height, &rgba);
        drop(rgba);
        cache_rendered_frame(&pixmap_cache, pixmap_generation, &cache_key, width, height, &data);
        if accept_render_generation(&path, response_generation, &pixmap_cache, &pool).await? {
            return Ok(tauri::ipc::Response::new(data));
        }
    }
    Err("PDF changed repeatedly while rendering; retry after save completes".to_string())
}

/// Run OCR on one page. `lang` is Tesseract's `+`-joined language spec (e.g.
/// "chi_tra+eng"); defaults to "eng" if omitted. Tessdata is resolved from
/// the bundled `tessdata` resource directory — see scripts/ocr-runtime.mjs
/// and the `resources` map in tauri.conf.json.
#[cfg(not(target_os = "android"))]
#[tauri::command]
async fn ocr_pdf_page(
    app: tauri::AppHandle,
    path: String,
    page_index: u32,
    lang: Option<String>,
    bytes_cache: tauri::State<'_, PdfBytesCache>,
    pdfium_cache: tauri::State<'_, pdfium_renderer::PdfiumDocCache>,
    pixmap_cache: tauri::State<'_, pdfium_renderer::PixmapCacheState>,
) -> Result<Vec<ocr::OcrWord>, String> {
    let render_generation = pixmap_cache.snapshot_generation(&path);
    let bytes = cached_pdf_bytes(&bytes_cache, &path)?;

    let handle = pdfium_renderer::get_or_load_pdfium_doc_for_render(
        &path,
        bytes,
        &pdfium_cache,
        &pixmap_cache,
        render_generation,
    )?;

    let resource_dir = app
        .path()
        .resource_dir()
        .map_err(|e| format!("Cannot resolve resource_dir: {}", e))?;
    // Niet rechtstreeks to_str(): op Windows is resource_dir een \\?\-pad en
    // daar kan Tesseract geen "/<taal>.traineddata" achter plakken.
    let tessdata_dir = ocr::tessdata_path_for_tesseract(&resource_dir.join("tessdata"))?;

    let lang = lang.unwrap_or_else(|| "auto".to_string());

    // Tesseract inference is synchronous/blocking (and re-inits per call) —
    // run it off the async executor so it doesn't stall other IPC.
    tauri::async_runtime::spawn_blocking({
        move || ocr::ocr_page_words(handle.document(), page_index, &tessdata_dir, &lang)
    })
    .await
    .map_err(|e| format!("OCR task panicked: {}", e))?
}

/// Android has no Tesseract build (see Cargo.toml), so OCR is unavailable
/// there. The command stays registered so the invoke handler list is the
/// same on every platform; it only reports that OCR is not available.
#[cfg(target_os = "android")]
#[tauri::command]
async fn ocr_pdf_page() -> Result<(), String> {
    Err("OCR is op dit platform niet beschikbaar".to_string())
}

#[tauri::command]
async fn render_pdf_page_region(
    path: String,
    page_index: u32,
    scale: f32,
    rotation: Option<i32>,
    ocg_visibility: Option<Vec<ocg_render_copy::LayerVisibility>>,
    region_x_pt: f32,
    region_y_pt: f32,
    region_w_pt: f32,
    region_h_pt: f32,
    spread: Option<bool>,
    annot_appearance: Option<Vec<String>>,
    annot_appearance_index: Option<Vec<u32>>,
    render_lane: Option<String>,
    render_generation: Option<u64>,
    bytes_cache: tauri::State<'_, PdfBytesCache>,
    pdfium_cache: tauri::State<'_, pdfium_renderer::PdfiumDocCache>,
    pixmap_cache: tauri::State<'_, pdfium_renderer::PixmapCacheState>,
    pool: tauri::State<'_, std::sync::Arc<tokio::sync::OnceCell<worker_pool::WorkerPool>>>,
) -> Result<tauri::ipc::Response, String> {
    let visibility = ocg_render_copy::canonical_visibility(ocg_visibility.as_deref().unwrap_or(&[]))
        .map_err(|e| format!("OCG selection: {e}"))?;
    let annot_show = pdfium_renderer::AnnotShow::from_request(annot_appearance, annot_appearance_index);
    let extra_rot = rotation.unwrap_or(0);
    // Optional lane + generation from the caller: a queued tile for a view
    // the caller has left is dropped instead of rendered.
    let ticket = worker_pool::RenderTicket::from_request(render_lane, render_generation);

    for _attempt in 0..MAX_RENDER_GENERATION_ATTEMPTS {
        let response_generation = pixmap_cache.snapshot_generation(&path)
            .ok_or("Pixmap cache lock unavailable")?;
        let render_generation = pixmap_cache.generation_for_visibility(&path, &visibility);

        // Try the worker pool first: region tiles are small (fit the 64 MB SHM), so
        // they render in a SEPARATE process — safe for parallel/pre-cache rendering
        // and off the main thread. Falls back to in-proc PDFium on any failure
        // except a dead worker: that crash must not be repeated in the GUI process.
        if let Some(p) = pool.get() {
            match p
                .render_region_with_annotations(&path, page_index, scale, extra_rot, region_x_pt, region_y_pt, region_w_pt, region_h_pt, spread.unwrap_or(false), &visibility, annot_show.as_ref(), ticket.as_ref())
                .await
            {
                Ok(bitmap) => {
                    let data = bitmap.into_framed();
                    if accept_render_generation(&path, response_generation, &pixmap_cache, &pool).await? {
                        return Ok(tauri::ipc::Response::new(data));
                    }
                    continue;
                }
                Err(e) => {
                    // The caller discards this tile; rendering it in-proc
                    // would only cost the time the pool just saved.
                    if worker_pool::render_superseded(&e) {
                        return Err(worker_pool::RENDER_SUPERSEDED.to_string());
                    }
                    if worker_died(&e) {
                        return Err(format!("PDFium worker region render failed: {e}"));
                    }
                    eprintln!("[render_pdf_page_region] pool failed: {} — in-proc fallback", e);
                }
            }
        }

        // In-proc-fallback: gelijktijdige in-proc PDFium-renders crashen het proces
        // (double-free / heap-corruptie — de worker-pool bestaat juist daarom). Alle
        // in-proc PDFium-toegang (laden én renderen, alle drie de render-paden) wordt
        // nu centraal geserialiseerd via PDFIUM_INPROC_LOCK in pdfium_renderer, dus
        // dit pad heeft geen eigen lock meer nodig.
        let bytes = cached_pdf_bytes(&bytes_cache, &path)?;

        let render_bytes = if visibility.is_empty() { bytes } else {
            std::sync::Arc::new(ocg_render_copy::render_copy(&bytes, &visibility)
                .map_err(|e| format!("OCG render copy: {e}"))?)
        };
        let handle = pdfium_renderer::get_or_load_pdfium_doc_for_render(
            &path,
            render_bytes,
            &pdfium_cache,
            &pixmap_cache,
            render_generation,
        )?;

        let (width, height, rgba) = pdfium_renderer::render_page_region_to_rgba_with_annotations(
            handle.document(),
            page_index,
            scale,
            extra_rot,
            region_x_pt,
            region_y_pt,
            region_w_pt,
            region_h_pt,
            annot_show.as_ref(),
        )?;

        let mut data = Vec::with_capacity(8 + rgba.len());
        data.extend_from_slice(&width.to_le_bytes());
        data.extend_from_slice(&height.to_le_bytes());
        data.extend_from_slice(&rgba);
        if accept_render_generation(&path, response_generation, &pixmap_cache, &pool).await? {
            return Ok(tauri::ipc::Response::new(data));
        }
    }
    Err("PDF changed repeatedly while rendering; retry after save completes".to_string())
}

/// Route A: render een tegel-regio via de eigen display-list-engine i.p.v. de
/// PDFium-workers. De eerste aanroep per (pad, pagina, rotatie) bouwt de scene
/// (extract + chunk-index — seconden op een 5M-ops blad, daarna gecachet);
/// elke volgende tegel is puur parallel rasterwerk. Wire-format identiek aan
/// render_pdf_page_region: [w u32 LE][h u32 LE][rgba]. Faalt expliciet (geen
/// stille degradatie) zodat de JS-kant per pagina kan terugvallen op PDFium.
#[tauri::command]
async fn render_tile_scene_region(
    path: String,
    page_index: u32,
    rotation: Option<i32>,
    ocg_visibility: Option<Vec<ocg_render_copy::LayerVisibility>>,
    scale: f32,
    region_x_pt: f32,
    region_y_pt: f32,
    region_w_pt: f32,
    region_h_pt: f32,
    bytes_cache: tauri::State<'_, PdfBytesCache>,
    handle_cache: tauri::State<'_, DocHandleCache>,
    scene_cache: tauri::State<'_, TileSceneCache>,
) -> Result<tauri::ipc::Response, String> {
    let visibility = ocg_render_copy::canonical_visibility(ocg_visibility.as_deref().unwrap_or(&[]))
        .map_err(|e| format!("OCG selection: {e}"))?;
    if !visibility.is_empty() {
        return Err("OCG content requires PDFium renderer".into());
    }
    let extra_rot = rotation.unwrap_or(0);
    let generation = handle_cache.0.lock()
        .map_err(|e| format!("Handle cache lock: {}", e))?.generation();
    // Gate before scene lookup: a path-keyed cached scene does not encode OCG
    // state, and the Rust interpreter currently ignores BDC/EMC visibility.
    let doc = get_or_load_doc_at_generation(&path, &bytes_cache, &handle_cache, generation)?;
    if doc.has_optional_content() {
        return Err("OCG content requires PDFium renderer".into());
    }
    let meta = std::fs::metadata(&path).map_err(|e| format!("stat: {}", e))?;
    let mtime = meta
        .modified()
        .ok()
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_millis())
        .unwrap_or(0);
    let key = format!("{}|{}|{}|p{}|r{}", path, mtime, meta.len(), page_index, extra_rot);

    let lookup = |sc: &TileSceneCache| -> Result<Option<Arc<open_pdf_render::tile_render::TileScene>>, String> {
        let handles = handle_cache.0.lock().map_err(|e| format!("Handle cache lock: {}", e))?;
        handles.with_generation(generation, || {
            let cache = sc.0.lock().map_err(|e| format!("scene-cache lock: {}", e))?;
            Ok(cache.iter().find(|(k, _)| *k == key).map(|(_, s)| s.clone()))
        }).transpose().map(Option::flatten)
    };

    let scene = match lookup(&scene_cache)? {
        Some(s) => s,
        None => {
            // Build serialiseren: gelijktijdige tegel-requests voor een verse
            // pagina zouden anders elk de dure extract+index doen.
            static BUILD_LOCK: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());
            let _b = BUILD_LOCK.lock().await;
            if let Some(s) = lookup(&scene_cache)? {
                s
            } else {
                let built = tauri::async_runtime::spawn_blocking(move || -> Result<open_pdf_render::tile_render::TileScene, String> {
                    // Feature gate: the draw-command interpreter ignores
                    // ExtGState alpha/blend/soft masks, shadings, patterns,
                    // Type3 and special colour spaces. Such a page would
                    // render silently wrong, so it goes to PDFium instead
                    // (the JS side remembers the rejection per page).
                    if let Some(reason) = doc
                        .scene_unsupported_reason(page_index as usize)
                        .map_err(|e| format!("scene gate: {}", e))?
                    {
                        return Err(format!("scene geweigerd: {}", reason));
                    }
                    let buf = doc
                        .extract_draw_commands(page_index as usize, extra_rot)
                        .map_err(|e| format!("extract: {}", e))?;
                    let bytes = buf.into_bytes();
                    // Image-zware bladen horen op het PDFium-pad: een scene vol
                    // ge-embedde beelddata is traag én zwaar — expliciet weigeren.
                    if bytes.len() > 400 * 1024 * 1024 {
                        return Err(format!("scene te groot ({} MB)", bytes.len() / 1_048_576));
                    }
                    let buffer_mb = ((bytes.len() / 1_048_576) as u64).max(1);
                    let scene = open_pdf_render::tile_render::TileScene::build(bytes)
                        .map_err(|e| format!("scene-build: {}", e))?;
                    // Datagedreven engine-gate (corpus-benchmark 2026-07-05,
                    // 136 pagina's; herijkt 2026-07-06 na image- en clip-
                    // ondersteuning in de tegel-rasterizer): de scene is
                    // alleen sneller ÉN accuraat op lijnwerk-bladen.
                    //
                    // Image-drempel 1 MB -> 2 MB (overleg-notitie): de
                    // rasterizer tekent DrawImage-payloads nu daadwerkelijk
                    // (RGBA-raw + JPEG), en de inline-strip-emissie geeft het
                    // maatgevende strip-blad (MV-03: 4.925 strips, 1,44 MB
                    // payload, downsampled diff 7,3% -> 7,1%) net méér dan
                    // 1 MB aan correct renderende beelddata. In het corpus
                    // haalt verder geen enkel blad het JS-voorfilter
                    // (content >= 6 MB), dus deze verruiming raakt alleen de
                    // strip-klasse; de klasse van grote scans (tientallen MB's JPEG,
                    // PDFium wint daar in tijd en beeld) blijft er ruim boven
                    // en wordt nog steeds geweigerd.
                    //
                    // Clip-dichtheid blijft 25/MB: clips worden nu wél
                    // gerepliceerd (tegel-maskers), maar boven deze dichtheid
                    // is het maskerpad nog niet op snelheid gemeten —
                    // versoepelen pas na een corpus-meting die dat draagt.
                    let mb = buffer_mb;
                    if scene.image_bytes > 2_000_000 {
                        return Err(format!("scene geweigerd: {} MB embedded images", scene.image_bytes / 1_048_576));
                    }
                    if scene.clip_ops / mb > 25 {
                        return Err(format!("scene geweigerd: {} clips/MB", scene.clip_ops / mb));
                    }
                    Ok(scene)
                })
                .await
                .map_err(|e| format!("join: {}", e))??;
                let arc = Arc::new(built);
                let handles = handle_cache.0.lock().map_err(|e| format!("Handle cache lock: {}", e))?;
                handles.with_generation(generation, || -> Result<(), String> {
                    let mut cache = scene_cache.0.lock().map_err(|e| format!("scene-cache lock: {}", e))?;
                    if cache.len() >= TILE_SCENE_CACHE_CAP {
                        cache.remove(0);
                    }
                    cache.push((key.clone(), arc.clone()));
                    eprintln!("[tile-scene] gebouwd: {} chunks, cache {}/{}", arc.chunk_count(), cache.len(), TILE_SCENE_CACHE_CAP);
                    Ok(())
                }).transpose()?;
                arc
            }
        }
    };

    let (w, h, rgba) = tauri::async_runtime::spawn_blocking(move || {
        scene.render_region_rgba(scale, region_x_pt, region_y_pt, region_w_pt, region_h_pt)
    })
    .await
    .map_err(|e| format!("join: {}", e))?;

    let mut data = Vec::with_capacity(8 + rgba.len());
    data.extend_from_slice(&w.to_le_bytes());
    data.extend_from_slice(&h.to_le_bytes());
    data.extend_from_slice(&rgba);
    Ok(tauri::ipc::Response::new(data))
}

/// Timings from the page (js/core/perf.js) into the app log, under the
/// `perf` target: operation names and milliseconds only, never content.
#[tauri::command(async)]
fn perf_log(lines: Vec<String>) {
    for line in lines.iter().take(500) {
        let line: String = line.chars().take(400).collect();
        log::info!(target: "perf", "{}", line);
    }
}

/// Whether the app was started with OPDS_PERF=1 (timings logged every minute).
#[tauri::command(async)]
fn perf_enabled() -> bool {
    std::env::var("OPDS_PERF").map(|v| v == "1").unwrap_or(false)
}

/// Goedkope zwaarte-probe: som van de GECOMPRIMEERDE content-stream-lengtes van
/// een pagina (raw stream-bytes, geen decompressie). Groot => zware vector-pagina.
/// Gebruikt door het progressieve render-pad om alleen echt-zware pagina's tegel-
/// voor-tegel te renderen.
/// Elke pagina's som, per bestandsversie (pad, lengte, wijzigtijd) één keer
/// berekend: de probe draait voor elke nieuw bezochte pagina, en las tot nu toe
/// elke keer het hele bestand opnieuw in (op een set van honderden MB seconden
/// per pagina).
type ContentSizes = std::collections::HashMap<String, ((u64, Option<std::time::SystemTime>), std::sync::Arc<Vec<u64>>)>;
static CONTENT_SIZES: std::sync::OnceLock<std::sync::Mutex<ContentSizes>> = std::sync::OnceLock::new();

fn page_content_sizes(path: &str) -> Result<std::sync::Arc<Vec<u64>>, String> {
    use lopdf::{Document, Object};
    let meta = std::fs::metadata(path).map_err(|e| format!("stat: {}", e))?;
    let identity = (meta.len(), meta.modified().ok());
    let cache = CONTENT_SIZES.get_or_init(|| std::sync::Mutex::new(Default::default()));
    if let Ok(c) = cache.lock() {
        if let Some((id, sizes)) = c.get(path) {
            if *id == identity {
                return Ok(sizes.clone());
            }
        }
    }
    let doc = Document::load(path).map_err(|e| format!("load: {}", e))?;
    let sizes: Vec<u64> = doc
        .get_pages() // BTreeMap<u32, ObjectId>, gesorteerd op paginanummer
        .values()
        .map(|&page_id| {
            let Ok(page) = doc.get_dictionary(page_id) else { return 0 };
            // Geen content-stream (bv. lege pagina) => niet zwaar.
            let Ok(contents) = page.get(b"Contents") else { return 0 };
            // Contents = Reference of Array van References.
            let ids: Vec<lopdf::ObjectId> = match contents {
                Object::Reference(id) => vec![*id],
                Object::Array(arr) => arr.iter().filter_map(|o| if let Object::Reference(id) = o { Some(*id) } else { None }).collect(),
                _ => Vec::new(),
            };
            ids.into_iter()
                .filter_map(|id| if let Ok(Object::Stream(s)) = doc.get_object(id) { Some(s.content.len() as u64) } else { None })
                .sum()
        })
        .collect();
    let sizes = std::sync::Arc::new(sizes);
    if let Ok(mut c) = cache.lock() {
        // Alleen de laatste versie per pad, en hooguit een handvol paden.
        if c.len() >= 8 && !c.contains_key(path) {
            c.clear();
        }
        c.insert(path.to_string(), (identity, sizes.clone()));
    }
    Ok(sizes)
}

/// Goedkope zwaarte-probe: som van de GECOMPRIMEERDE content-stream-lengtes van
/// een pagina (raw stream-bytes, geen decompressie). Groot => zware vector-pagina.
/// Gebruikt door het progressieve render-pad om alleen echt-zware pagina's tegel-
/// voor-tegel te renderen. Async en in spawn_blocking: een synchrone command
/// draait op de hoofdthread en bevroor het venster tijdens het inlezen.
#[tauri::command]
async fn page_content_size(path: String, page_index: u32) -> Result<u64, String> {
    let sizes = tauri::async_runtime::spawn_blocking(move || page_content_sizes(&path))
        .await
        .map_err(|e| format!("join: {}", e))??;
    sizes
        .get(page_index as usize)
        .copied()
        .ok_or_else(|| format!("page {} out of range", page_index))
}

#[tauri::command]
async fn render_thumbnail(
    app: tauri::AppHandle,
    path: String,
    page_index: u32,
    max_width: u32,
    rotation: Option<i32>,
    ocg_visibility: Option<Vec<ocg_render_copy::LayerVisibility>>,
    skip_images: Option<bool>,
    pixmap_cache: tauri::State<'_, pdfium_renderer::PixmapCacheState>,
    thumb_cache: tauri::State<'_, ThumbnailCache>,
) -> Result<String, String> {
    let visibility = ocg_render_copy::canonical_visibility(ocg_visibility.as_deref().unwrap_or(&[]))
        .map_err(|e| format!("OCG selection: {e}"))?;
    let extra_rot = rotation.unwrap_or(0);
    // Selected thumbnails must not read or populate the path-keyed default
    // thumbnail/document caches. A generation token exists only for defaults.
    let render_generation = pixmap_cache.generation_for_visibility(&path, &visibility);
    // skip_images: PDFium renders form-data on by default but doesn't
    // expose a "drop image XObjects" knob — accept the option for API
    // compat but ignore it. PDFium is fast enough that the thumbnail
    // doesn't need to drop images.
    let _ = skip_images;

    let cache_key = (path.clone(), page_index, max_width, extra_rot);
    if let Some(Some(cached)) = pixmap_cache.with_generation(&path, render_generation, || {
        thumb_cache.0.lock().ok().and_then(|mut tc| tc.get(&cache_key).cloned())
    }) {
        return Ok(cached);
    }

    // The file read, the in-process PDFium render (under the global PDFium
    // lock) and the JPEG encode are blocking work: run them on the blocking
    // pool, not on an async runtime thread that other commands need.
    let task_app = app.clone();
    let task_path = path.clone();
    let data_url = tauri::async_runtime::spawn_blocking(move || -> Result<String, String> {
        let bytes_cache = task_app.state::<PdfBytesCache>();
        let pdfium_cache = task_app.state::<pdfium_renderer::PdfiumDocCache>();
        let pixmap_cache = task_app.state::<pdfium_renderer::PixmapCacheState>();
        let bytes = cached_pdf_bytes(&bytes_cache, &task_path)?;
        let render_bytes = if visibility.is_empty() { bytes } else {
            std::sync::Arc::new(ocg_render_copy::render_copy(&bytes, &visibility)
                .map_err(|e| format!("OCG thumbnail render copy: {e}"))?)
        };
        let handle = pdfium_renderer::get_or_load_pdfium_doc_for_render(
            &task_path,
            render_bytes,
            &pdfium_cache,
            &pixmap_cache,
            render_generation,
        )?;
        pdfium_renderer::render_thumbnail_to_json(handle.document(), page_index, max_width, extra_rot)
    })
    .await
    .map_err(|e| format!("Thumbnail task: {e}"))??;

    pixmap_cache.with_generation(&path, render_generation, || {
        if let Ok(mut tc) = thumb_cache.0.lock() {
            let size = data_url.len() + path.len();
            tc.insert(cache_key, data_url.clone(), size);
        }
    });
    Ok(data_url)
}

#[tauri::command]
async fn analyze_page_type(
    path: String,
    page_index: u32,
    bytes_cache: tauri::State<'_, PdfBytesCache>,
    handle_cache: tauri::State<'_, DocHandleCache>,
    page_type_cache: tauri::State<'_, PageTypeCache>,
) -> Result<String, String> {
    let key = (path.clone(), page_index);
    let generation = handle_cache.0.lock()
        .map_err(|e| format!("Handle cache lock: {}", e))?.generation();
    {
        let handles = handle_cache.0.lock().map_err(|e| format!("Handle cache lock: {}", e))?;
        if let Some(Some(cached)) = handles.with_generation(generation, || {
            page_type_cache.0.lock().ok().and_then(|cache| cache.get(&key).cloned())
        }) {
            return Ok(cached);
        }
    }
    let doc = get_or_load_doc_at_generation(&path, &bytes_cache, &handle_cache, generation)?;
    let result = match doc.analyze_page_type(page_index as usize).map_err(|e| format!("{}", e))? {
        open_pdf_render::PageType::Vector => "vector".to_string(),
        open_pdf_render::PageType::Tile => "tile".to_string(),
    };
    let handles = handle_cache.0.lock().map_err(|e| format!("Handle cache lock: {}", e))?;
    handles.with_generation(generation, || {
        if let Ok(mut cache) = page_type_cache.0.lock() {
            cache.insert(key, result.clone());
        }
    });
    Ok(result)
}

/// Batch-classify many pages in one Tauri invoke using rayon for parallelism.
/// Used immediately after cold-open to populate `PageTypeCache` for every
/// page in the document so subsequent per-page navigation hits the cache
/// instead of paying any lopdf analyze cost. Safe to call multiple times
/// — already-cached pages are skipped in the parallel loop and the result
/// returns the cached value.
#[tauri::command]
async fn analyze_page_type_batch(
    path: String,
    page_indices: Vec<u32>,
    bytes_cache: tauri::State<'_, PdfBytesCache>,
    handle_cache: tauri::State<'_, DocHandleCache>,
    page_type_cache: tauri::State<'_, PageTypeCache>,
) -> Result<Vec<String>, String> {
    let generation = handle_cache.0.lock()
        .map_err(|e| format!("Handle cache lock: {}", e))?.generation();
    // Pre-fill: copy already-cached results out of the lock; remaining indices
    // get computed in parallel below. Avoids contending on the cache mutex
    // from inside the rayon workers.
    let mut results: Vec<Option<String>> = vec![None; page_indices.len()];
    let mut todo: Vec<(usize, u32)> = Vec::new();
    {
        let handles = handle_cache.0.lock().map_err(|e| format!("Handle cache lock: {}", e))?;
        handles.with_generation(generation, || {
            if let Ok(cache) = page_type_cache.0.lock() {
                for (i, &p) in page_indices.iter().enumerate() {
                    if let Some(v) = cache.get(&(path.clone(), p)) {
                        results[i] = Some(v.clone());
                    }
                }
            }
        });
    }
    for (i, &p) in page_indices.iter().enumerate() {
        if results[i].is_none() {
            todo.push((i, p));
        }
    }
    if todo.is_empty() {
        return Ok(results.into_iter().map(|o| o.unwrap_or_default()).collect());
    }

    let doc = get_or_load_doc_at_generation(&path, &bytes_cache, &handle_cache, generation)?;
    let pages: Vec<usize> = todo.iter().map(|&(_, p)| p as usize).collect();
    let batch_results = doc.analyze_page_types_batch(&pages);

    // Always return this command's results, even if an invalidation prevents
    // them from entering the cache.
    let computed: Vec<String> = batch_results.iter().map(|r| match r {
        Ok(open_pdf_render::PageType::Vector) => "vector".to_string(),
        Ok(open_pdf_render::PageType::Tile) => "tile".to_string(),
        Err(_) => "vector".to_string(), // fall through to vector path on parse error
    }).collect();
    for ((i_in_input, _), value) in todo.iter().zip(computed.iter()) {
        results[*i_in_input] = Some(value.clone());
    }
    let handles = handle_cache.0.lock().map_err(|e| format!("Handle cache lock: {}", e))?;
    handles.with_generation(generation, || {
        if let Ok(mut cache) = page_type_cache.0.lock() {
            for ((_, p_idx), value) in todo.iter().zip(computed.iter()) {
                cache.insert((path.clone(), *p_idx), value.clone());
            }
        }
    });
    Ok(results.into_iter().map(|o| o.unwrap_or_default()).collect())
}

#[tauri::command]
async fn extract_draw_commands(
    path: String,
    page_index: u32,
    rotation: Option<i32>,
    ocg_visibility: Option<Vec<ocg_render_copy::LayerVisibility>>,
    bytes_cache: tauri::State<'_, PdfBytesCache>,
    handle_cache: tauri::State<'_, DocHandleCache>,
) -> Result<tauri::ipc::Response, String> {
    let visibility = ocg_render_copy::canonical_visibility(ocg_visibility.as_deref().unwrap_or(&[]))
        .map_err(|e| format!("OCG selection: {e}"))?;
    if !visibility.is_empty() {
        return Err("OCG content requires PDFium renderer".into());
    }
    let doc = get_or_load_doc(&path, &bytes_cache, &handle_cache)?;
    if doc.has_optional_content() {
        return Err("OCG content requires PDFium renderer".into());
    }
    let extra_rot = rotation.unwrap_or(0);
    let cmds = doc.extract_draw_commands(page_index as usize, extra_rot).map_err(|e| format!("{}", e))?;
    // Raw bytes, not a JSON array of numbers (3-4x the size, parsed in JS).
    Ok(tauri::ipc::Response::new(cmds.into_bytes()))
}

#[tauri::command(async)]
fn extract_page_text(
    path: String,
    page_index: u32,
    bytes_cache: tauri::State<PdfBytesCache>,
    handle_cache: tauri::State<DocHandleCache>,
) -> Result<String, String> {
    let doc = get_or_load_doc(&path, &bytes_cache, &handle_cache)?;
    doc.extract_text_positions(page_index as usize).map_err(|e| format!("{}", e))
}

/// Batch extract draw commands for multiple pages in parallel using rayon.
/// Returns one Vec<u8> per requested page in the same order. Used for
/// adjacent-page prefetch (warm pages 2..N in the background after page 1
/// is on screen so wheel-scrolling forward feels instant).
///
/// `rotations` is a parallel array of extra rotation values (one per page).
/// Pass an empty array to use 0 for all pages.
#[tauri::command]
async fn extract_draw_commands_batch(
    path: String,
    page_indices: Vec<u32>,
    rotations: Option<Vec<i32>>,
    ocg_visibility: Option<Vec<ocg_render_copy::LayerVisibility>>,
    bytes_cache: tauri::State<'_, PdfBytesCache>,
    handle_cache: tauri::State<'_, DocHandleCache>,
) -> Result<Vec<Vec<u8>>, String> {
    let visibility = ocg_render_copy::canonical_visibility(ocg_visibility.as_deref().unwrap_or(&[]))
        .map_err(|e| format!("OCG selection: {e}"))?;
    if !visibility.is_empty() {
        return Err("OCG content requires PDFium renderer".into());
    }
    let doc = get_or_load_doc(&path, &bytes_cache, &handle_cache)?;
    if doc.has_optional_content() {
        return Err("OCG content requires PDFium renderer".into());
    }
    let rots = rotations.unwrap_or_default();
    let pairs: Vec<(usize, i32)> = page_indices.iter().enumerate().map(|(i, &p)| {
        (p as usize, rots.get(i).copied().unwrap_or(0))
    }).collect();
    let results = doc.extract_draw_commands_batch(&pairs);
    let mut out = Vec::with_capacity(results.len());
    for r in results {
        out.push(r.map(|b| b.into_bytes()).map_err(|e| format!("{}", e))?);
    }
    Ok(out)
}

/// Bump the display-list generation while removing every cache derived from
/// the old document. Render insertion takes the same handle-cache lock.
fn evict_display_list_path(
    path: &str,
    handle_cache: &DocHandleCache,
    page_type_cache: &PageTypeCache,
    scene_cache: &TileSceneCache,
) -> Result<(), String> {
    let mut handles = handle_cache.0.lock().map_err(|e| format!("Handle cache lock: {}", e))?;
    let mut pages = page_type_cache.0.lock().map_err(|e| format!("Page type cache lock: {}", e))?;
    let mut scenes = scene_cache.0.lock().map_err(|e| format!("Scene cache lock: {}", e))?;
    let removed = handles.invalidate_path(path, || {
        pages.retain(|(p, _), _| p != path);
        scenes.retain(|(key, _)| !key.starts_with(&format!("{}|", path)));
        Ok(())
    })?;
    drop(scenes);
    drop(pages);
    drop(handles);
    drop(removed);
    Ok(())
}

fn clear_display_list_caches(
    handle_cache: &DocHandleCache,
    page_type_cache: &PageTypeCache,
    scene_cache: &TileSceneCache,
) -> Result<(), String> {
    let mut handles = handle_cache.0.lock().map_err(|e| format!("Handle cache lock: {}", e))?;
    let mut pages = page_type_cache.0.lock().map_err(|e| format!("Page type cache lock: {}", e))?;
    let mut scenes = scene_cache.0.lock().map_err(|e| format!("Scene cache lock: {}", e))?;
    let removed = handles.clear(|| {
        pages.clear();
        scenes.clear();
        Ok(())
    })?;
    drop(scenes);
    drop(pages);
    drop(handles);
    drop(removed);
    Ok(())
}

/// Evict PDFium's local path-keyed caches under one generation lock so an
/// in-flight render cannot restore a stale document, pixmap, or thumbnail.
fn evict_pdfium_render_path(
    path: &str,
    pdfium_cache: &pdfium_renderer::PdfiumDocCache,
    pixmap_cache: &pdfium_renderer::PixmapCacheState,
    thumb_cache: &ThumbnailCache,
) -> Result<Option<Arc<pdfium_renderer::PdfiumDocumentHandle>>, String> {
    pixmap_cache.remove_path_with_doc_cache(path, pdfium_cache, || {
        thumb_cache.0.lock().map_err(|e| format!("Thumbnail cache lock: {}", e))?
            .retain(|(p, _, _, _), _| p != path);
        Ok(())
    })
}

/// Invalidate every path-keyed render cache after writing a PDF. The worker
/// cache must also be evicted explicitly: a rewrite can preserve both mtime
/// and length, which are the worker's normal freshness checks.
#[tauri::command]
async fn invalidate_pdf_cache(
    path: String,
    bytes_cache: tauri::State<'_, PdfBytesCache>,
    handle_cache: tauri::State<'_, DocHandleCache>,
    thumb_cache: tauri::State<'_, ThumbnailCache>,
    page_type_cache: tauri::State<'_, PageTypeCache>,
    pdfium_cache: tauri::State<'_, pdfium_renderer::PdfiumDocCache>,
    pixmap_cache: tauri::State<'_, pdfium_renderer::PixmapCacheState>,
    scene_cache: tauri::State<'_, TileSceneCache>,
    pool: tauri::State<'_, Arc<tokio::sync::OnceCell<worker_pool::WorkerPool>>>,
    background: Option<bool>,
) -> Result<bool, String> {
    bytes_cache.remove(&path)?;
    evict_display_list_path(&path, &handle_cache, &page_type_cache, &scene_cache)?;
    let removed = evict_pdfium_render_path(&path, &pdfium_cache, &pixmap_cache, &thumb_cache)?;
    // Dropping a PDFium document takes the global FFI lock. Keep that work
    // off the async command thread, as release_pdf_document already does.
    if let Some(handle) = removed {
        std::thread::spawn(move || drop(handle));
    }
    // `background` (the saver, after releasing the workers' file handles):
    // the workers' invalidation runs in the background, because a worker
    // answers it only after the render it is busy with, and a save waited
    // seconds for tiles of a heavy sheet (measured). Their next render opens
    // the new file anyway; this only drops what they cached.
    if background.unwrap_or(false) {
        if pool.get().is_some() {
            let cell = Arc::clone(pool.inner());
            let path = path.clone();
            tauri::async_runtime::spawn(async move {
                if let Some(pool) = cell.get() {
                    if let Err(e) = pool.invalidate(&path).await {
                        log::warn!("PDFium worker cache invalidation for a saved file failed: {e}");
                    }
                }
            });
        }
    } else if let Some(pool) = pool.get() {
        let result = pool.invalidate(&path).await;
        // A render can race ahead of the per-worker invalidate request. Clear
        // any result it cached during the await and reject delayed inserts by
        // advancing the generation once more before this command returns.
        let removed = evict_pdfium_render_path(&path, &pdfium_cache, &pixmap_cache, &thumb_cache)?;
        if let Some(handle) = removed {
            std::thread::spawn(move || drop(handle));
        }
        result.map_err(|e| format!("PDFium worker cache invalidation: {e}"))?;
    }
    Ok(true)
}

/// Close the render workers' handles on `path` before the app replaces it.
/// The workers read a document from its file on demand, and a volume without
/// POSIX rename semantics refuses to replace a file that is still open. The
/// next render reopens the file; `invalidate_pdf_cache` after the write
/// still drops anything a render reopened in between.
#[tauri::command]
async fn release_pdf_worker_files(
    path: String,
    pool: tauri::State<'_, Arc<tokio::sync::OnceCell<worker_pool::WorkerPool>>>,
) -> Result<bool, String> {
    if let Some(pool) = pool.get() {
        pool.invalidate(&path).await
            .map_err(|e| format!("PDFium worker file release: {e}"))?;
    }
    Ok(true)
}

/// Alles loslaten wat het proces voor een gesloten document vasthoudt: ruwe
/// bytes, geparsede handles (lopdf én PDFium), thumbnails, paginatypen en
/// pixmaps, including worker-side source bytes. Alleen aanroepen als geen
/// ander open tabblad hetzelfde pad gebruikt — de JS-kant beslist dat
/// (document-release.js).
#[tauri::command]
async fn release_pdf_document(
    path: String,
    bytes_cache: tauri::State<'_, PdfBytesCache>,
    handle_cache: tauri::State<'_, DocHandleCache>,
    thumb_cache: tauri::State<'_, ThumbnailCache>,
    page_type_cache: tauri::State<'_, PageTypeCache>,
    scene_cache: tauri::State<'_, TileSceneCache>,
    pdfium_cache: tauri::State<'_, pdfium_renderer::PdfiumDocCache>,
    pixmap_cache: tauri::State<'_, pdfium_renderer::PixmapCacheState>,
    pool: tauri::State<'_, Arc<tokio::sync::OnceCell<worker_pool::WorkerPool>>>,
) -> Result<bool, String> {
    bytes_cache.remove(&path)?;
    evict_display_list_path(&path, &handle_cache, &page_type_cache, &scene_cache)?;
    let removed = evict_pdfium_render_path(&path, &pdfium_cache, &pixmap_cache, &thumb_cache)?;
    let had_doc = removed.is_some();
    // Closing a PDFium document waits for the global PDFium lock, which a CAD
    // export or print can hold for seconds: close it off the UI thread.
    // PDFium frees with the C library's malloc, which keeps the memory unless
    // asked (return_freed_memory): ask once the handle is gone.
    std::thread::spawn(move || {
        drop(removed);
        return_freed_memory();
    });
    // The render workers let go in the background. Each one answers after
    // the render it is busy with, and on a heavy sheet that is seconds per
    // worker: closing the tab waited for all of them (once over 15 s). Nothing
    // waits on this for correctness; a save that replaces the file uses
    // release_pdf_worker_files, which still waits.
    let pool = pool.inner().clone();
    tauri::async_runtime::spawn(async move {
        if let Some(pool) = pool.get() {
            if let Err(error) = pool.invalidate(&path).await {
                eprintln!("[release] PDFium worker document release: {error}");
            }
        }
    });
    Ok(had_doc)
}

/// Hand memory freed through the C library's malloc (PDFium's parses, the
/// bytes caches) back to the system; glibc otherwise keeps it for reuse.
#[cfg(all(target_os = "linux", target_env = "gnu"))]
fn return_freed_memory() {
    extern "C" {
        fn malloc_trim(pad: usize) -> i32;
    }
    // Safety: malloc_trim only releases free heap memory.
    unsafe {
        malloc_trim(0);
    }
}

#[cfg(not(all(target_os = "linux", target_env = "gnu")))]
fn return_freed_memory() {}

/// Clear the entire PDF bytes cache AND parsed handle cache (call on app
/// cleanup or memory pressure).
#[tauri::command(async)]
fn clear_pdf_cache(
    bytes_cache: tauri::State<PdfBytesCache>,
    handle_cache: tauri::State<DocHandleCache>,
    thumb_cache: tauri::State<ThumbnailCache>,
    page_type_cache: tauri::State<PageTypeCache>,
    scene_cache: tauri::State<TileSceneCache>,
    pdfium_cache: tauri::State<pdfium_renderer::PdfiumDocCache>,
    pixmap_cache: tauri::State<pdfium_renderer::PixmapCacheState>,
) -> Result<bool, String> {
    bytes_cache.clear()?;
    clear_display_list_caches(&handle_cache, &page_type_cache, &scene_cache)?;
    // Close the documents off the UI thread (see release_pdf_document).
    let handles = pixmap_cache.clear_with_doc_cache(&pdfium_cache, || {
        thumb_cache.0.lock().map_err(|e| format!("Thumbnail cache lock: {}", e))?.clear();
        Ok(())
    })?;
    if !handles.is_empty() {
        std::thread::spawn(move || drop(handles));
    }
    Ok(true)
}

#[tauri::command(async)]
fn get_page_dimensions(
    path: String,
    bytes_cache: tauri::State<PdfBytesCache>,
    handle_cache: tauri::State<DocHandleCache>,
) -> Result<Vec<(f32, f32)>, String> {
    let doc = get_or_load_doc(&path, &bytes_cache, &handle_cache)?;
    // Parallelized via rayon inside open-pdf-render — much faster than the
    // old sequential loop on multi-page documents.
    doc.page_dimensions_all()
        .into_iter()
        .map(|r| r.map_err(|e| format!("{}", e)))
        .collect()
}

// ─── Screenshot-annotate feature ────────────────────────────────────────────
// Read the current clipboard bitmap and return it as PNG bytes. Used by the
// "annotate clipboard screenshot" flow: Windows PrtScn (and the Snipping Tool)
// place the capture on the clipboard, and reading it in Rust via the
// clipboard-manager plugin is far more reliable than navigator.clipboard.read()
// inside WebView2. Returns an error when the clipboard holds no image.
#[tauri::command]
fn read_clipboard_image_png(app: tauri::AppHandle) -> Result<tauri::ipc::Response, String> {
    use image::ImageEncoder;
    use tauri_plugin_clipboard_manager::ClipboardExt;

    let img = app
        .clipboard()
        .read_image()
        .map_err(|e| format!("no image on clipboard: {e}"))?;
    let width = img.width();
    let height = img.height();
    let rgba = img.rgba();
    if width == 0 || height == 0 || rgba.is_empty() {
        return Err("clipboard image is empty".into());
    }

    let mut png: Vec<u8> = Vec::new();
    image::codecs::png::PngEncoder::new(&mut png)
        .write_image(rgba, width, height, image::ExtendedColorType::Rgba8)
        .map_err(|e| format!("PNG encode failed: {e}"))?;
    Ok(tauri::ipc::Response::new(png))
}

// Register/unregister the PrtScn global hotkey based on the user preference.
// Called from the frontend when the "intercept PrtScn" preference changes and
// at startup. Idempotent. Desktop only — the global-shortcut plugin has no
// mobile backend, so on Android this is a no-op stub (see below).
#[cfg(not(target_os = "android"))]
#[tauri::command]
fn set_prtscn_hotkey(app: tauri::AppHandle, enabled: bool) -> Result<(), String> {
    use tauri_plugin_global_shortcut::{Code, GlobalShortcutExt, Shortcut};

    let shortcut = Shortcut::new(None, Code::PrintScreen);
    let gs = app.global_shortcut();
    let is_registered = gs.is_registered(shortcut);
    if enabled && !is_registered {
        gs.register(shortcut).map_err(|e| e.to_string())?;
    } else if !enabled && is_registered {
        gs.unregister(shortcut).map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[cfg(target_os = "android")]
#[tauri::command]
fn set_prtscn_hotkey(_app: tauri::AppHandle, _enabled: bool) -> Result<(), String> {
    Ok(())
}

/// Mobile entry point: tauri vereist een argumentloze functie; de desktop-
/// varianten geven StartupOpts (mcp-server/poort) door via main.rs.
#[cfg(mobile)]
#[tauri::mobile_entry_point]
fn run_mobile() {
    run(StartupOpts::default());
}

/// The main window from the `main` entry of the config, which panels may
/// pop out of: `window.open` of a blank page (and only that) opens a window
/// related to this one, so the page shows the panel there while it still
/// runs it.
#[cfg(desktop)]
fn build_main_window(app: &mut tauri::App) -> Result<(), Box<dyn std::error::Error>> {
    use std::sync::atomic::{AtomicU32, Ordering};
    let config = app
        .config()
        .app
        .windows
        .iter()
        .find(|w| w.label == "main")
        .cloned()
        .ok_or("no main window in the config")?;
    let handle = app.handle().clone();
    let opened = AtomicU32::new(0);
    tauri::WebviewWindowBuilder::from_config(app.handle(), &config)?
        .on_new_window(move |url, features| {
            log::info!("[panels] new window asked for: {url}");
            if url.as_str() != "about:blank" {
                return tauri::webview::NewWindowResponse::Deny;
            }
            let label = format!("panel-{}", opened.fetch_add(1, Ordering::Relaxed));
            match tauri::WebviewWindowBuilder::new(&handle, label, tauri::WebviewUrl::External(url))
                .window_features(features)
                .title("Oculith Draw")
                // The panel's name, as the page titles its window.
                .on_document_title_changed(|window, title| {
                    let _ = window.set_title(&title);
                })
                .build()
            {
                Ok(window) => tauri::webview::NewWindowResponse::Create { window },
                Err(error) => {
                    log::warn!("[panels] a panel window could not open: {error}");
                    tauri::webview::NewWindowResponse::Deny
                }
            }
        })
        .build()?;
    // A panel's window may be opened at the end of a drag off the app, after
    // the gesture's moment has passed: the page may open windows itself
    // (only blank pages are let through above).
    #[cfg(target_os = "linux")]
    if let Some(main) = app.get_webview_window("main") {
        let _ = main.with_webview(|webview| {
            use webkit2gtk::{SettingsExt, WebViewExt};
            if let Some(settings) = webview.inner().settings() {
                settings.set_javascript_can_open_windows_automatically(true);
            }
        });
    }
    Ok(())
}

pub fn run(opts: StartupOpts) {
    eprintln!(
        "[startup] mcp_server={}, mcp_port={}",
        opts.mcp_server, opts.mcp_port
    );

    // Capture the MCP options for `setup()` — we now spawn the MCP server
    // *after* Tauri has produced an `AppHandle` so the new `app_*` tools
    // can emit events into the live WebView. Previously the server was
    // started here (before the builder ran) and never had a handle.
    let mcp_enabled = opts.mcp_server;
    let mcp_port = opts.mcp_port;

    let args: Vec<String> = std::env::args().collect();

    // Handle --version / --help before Tauri::Builder::default().run() so these
    // flags print and exit instead of hanging in the event loop. Running the
    // full builder also squats the single-instance DBus name, which blocks
    // subsequent normal launches until the name is released.
    for arg in args.iter().skip(1) {
        match arg.as_str() {
            "--version" | "-V" => {
                println!("{} {}", env!("CARGO_PKG_NAME"), env!("CARGO_PKG_VERSION"));
                std::process::exit(0);
            }
            "--help" | "-h" => {
                println!("Usage: {} [OPTIONS] [FILE...]", env!("CARGO_PKG_NAME"));
                println!();
                println!("Options:");
                println!("  -h, --help       Print this help and exit");
                println!("  -V, --version    Print version and exit");
                println!();
                println!("Files:");
                println!("  One or more .pdf files to open.");
                std::process::exit(0);
            }
            _ => {}
        }
    }

    // Collect any PDF file paths passed on the command line (for file associations)
    let opened_files: Vec<String> = args.iter()
        .skip(1)
        .filter(|arg| arg.to_lowercase().ends_with(".pdf") && !arg.starts_with('-'))
        .cloned()
        .collect();
    let opened_addon_files: Vec<String> = args.iter().skip(1).filter(|arg| is_addon_file_arg(arg)).cloned().collect();

    // Spawn the PDFium worker pool. Failures here are non-fatal — the
    // existing in-proc PDFium path serves as fallback when the pool is
    // unavailable.
    let pool: Arc<tokio::sync::OnceCell<worker_pool::WorkerPool>> = Arc::new(tokio::sync::OnceCell::new());
    let pool_for_init = pool.clone();
    tauri::async_runtime::spawn(async move {
        // De pdfium-worker-sidecar staat na bundling naast de hoofdbinary. De
        // bestandsnaam is platform-afhankelijk (`pdfium-worker.exe` op Windows,
        // `pdfium-worker` zonder extensie op macOS/Linux); worker_exe_path()
        // levert het juiste pad zodat de pool ook op macOS/Linux gevonden wordt.
        let worker_exe = worker_pool::worker_exe_path();

        if !worker_exe.exists() {
            eprintln!("[pool] pdfium-worker sidecar not found at {:?} — pool disabled, using in-proc PDFium", worker_exe);
            return;
        }

        match worker_pool::spawn::spawn_pool(4, &worker_exe).await {
            Ok(workers) => {
                let pool = worker_pool::WorkerPool::new(workers);
                if pool.is_ready() {
                    eprintln!("[pool] initialised with {} workers", pool.workers.len());
                    let _ = pool_for_init.set(pool);
                    // Idle-trim: open pagina-handles in de workers kosten op
                    // zware CAD-pagina's ruim 1 GB per worker. Na 5 min zonder
                    // renders geven de workers die parse-state terug; de
                    // eerstvolgende render betaalt eenmalig de her-parse.
                    // 5 min (niet korter): tijdens actief werken moet de
                    // handle heet blijven, anders voelt elke zoom na een
                    // denkpauze weer traag. Eigen OS-thread (geen
                    // tokio::time-afhankelijkheid).
                    let pool_for_trim = pool_for_init.clone();
                    std::thread::spawn(move || loop {
                        std::thread::sleep(std::time::Duration::from_secs(60));
                        if let Some(p) = pool_for_trim.get() {
                            tauri::async_runtime::block_on(p.trim_if_idle(300_000));
                        }
                    });
                } else {
                    eprintln!("[pool] no workers became ready — pool disabled");
                }
            }
            Err(e) => {
                eprintln!("[pool] spawn_pool failed: {} — pool disabled", e);
            }
        }
    });

    let mut builder = tauri::Builder::default()
        .manage(OpenedFiles(Mutex::new(opened_files)))
        .manage(OpenedAddonFiles(Mutex::new(opened_addon_files)))
        .manage(LockedFiles(Mutex::new(HashMap::new())))
        .manage(file_range::FileRanges::default())
        .manage(print_instelling::PrinterDevmodes::default())
        .manage(PdfBytesCache::default())
        .manage(DocHandleCache(Mutex::new(display_list_cache::GenerationCache::default())))
        .manage(TileSceneCache(Mutex::new(Vec::new())))
        .manage(ThumbnailCache::default())
        .manage(PageTypeCache(Mutex::new(HashMap::new())))
        .manage(pdfium_renderer::PdfiumDocCache::default())
        .manage(pdfium_renderer::PixmapCacheState::default())
        .manage(cad_export::CadExportJobs::default())
        .manage(cad_import::CadImportState::default())
        .manage(pool.clone())
        .manage(mcp_app_bridge::McpAppBridge::new())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_os::init())
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_deep_link::init())
        .plugin(tauri_plugin_clipboard_manager::init())
        .plugin(tauri_plugin_store::Builder::default().build());
    builder = builder.manage(edition_helper::EditionHelper::default());

    // Drag-out window detach is desktop-only (no mobile backend in the crate).
    #[cfg(not(target_os = "android"))]
    {
        builder = builder.plugin(tauri_plugin_drag::init());
    }

    // Single-instance registration is desktop-only.
    //
    // A DETACHED document window is launched as its own app process with the
    // `OPDS_DETACHED=1` env var (see window_mgmt::spawn_window_with_pdf). Such
    // a process must NOT register single-instance — otherwise it would just
    // forward its PDF arg to the original instance and exit, instead of
    // becoming an independent window. So we skip the plugin when detached.
    #[cfg(not(target_os = "android"))]
    {
        let is_detached = std::env::var("OPDS_DETACHED").as_deref() == Ok("1");
        if !is_detached {
            builder = builder
                .plugin(tauri_plugin_single_instance::init(|app: &tauri::AppHandle, argv: Vec<String>, _cwd: String| {
                    if let Some(window) = app.get_webview_window("main") {
                        let _ = window.unminimize();
                        let _ = window.set_focus();
                    }
                    let files: Vec<String> = argv.iter()
                        .filter(|arg: &&String| arg.to_lowercase().ends_with(".pdf") && !arg.starts_with('-'))
                        .cloned()
                        .collect();
                    for path in &files {
                        let _ = app.fs_scope().allow_file(path);
                    }
                    if !files.is_empty() {
                        let _ = app.emit("open-files", &files);
                    }
                    let addon_files: Vec<String> = argv.iter().skip(1).filter(|arg| is_addon_file_arg(arg)).cloned().collect();
                    if !addon_files.is_empty() {
                        let _ = app.emit("open-addon-files", &addon_files);
                    }
                }));
        }
        // This fork has no update endpoint or signing key. The updater plugin
        // stays unregistered until a signed Oculith release channel exists.
    }

    // Global system hotkey (PrtScn) for the opt-in "screenshot annotate"
    // feature. The shortcut is NOT registered here — the plugin only installs
    // the dispatch handler. The frontend calls `set_prtscn_hotkey(true)` when
    // the user enables the preference, which actually registers PrtScn. On
    // press we bring the main window to the foreground and notify the WebView,
    // which reads the clipboard image onto a fresh annotate canvas. Desktop
    // only (the crate has no mobile backend).
    #[cfg(not(target_os = "android"))]
    {
        use tauri_plugin_global_shortcut::ShortcutState;
        builder = builder.plugin(
            tauri_plugin_global_shortcut::Builder::new()
                .with_handler(|app, _shortcut, event| {
                    if event.state() == ShortcutState::Pressed {
                        if let Some(window) = app.get_webview_window("main") {
                            let _ = window.unminimize();
                            let _ = window.show();
                            let _ = window.set_focus();
                        }
                        let _ = app.emit("prtscn-screenshot", ());
                    }
                })
                .build(),
        );
    }

    builder
        .setup(move |app| {
            // The main window, built here from its config so a panel popped
            // out (the page opening a blank window of its own) opens as a
            // window related to this one; any other new window is refused.
            #[cfg(desktop)]
            build_main_window(app)?;
            if let Some(base) = datamap::lokale_datamap() {
                if let Err(error) = identity_migration::migrate_profile(&base) {
                    eprintln!("[startup] settings migration failed: {error}");
                }
            }
            // Als eerste, zodat alles wat hierna met `log::` gemeld wordt ook
            // ergens aankomt. Zonder logger zijn die macro's lege hulzen.
            // Mislukt het opzetten, dan draait de app gewoon door.
            match logboek::registreer(app.handle()) {
                Ok(map) => eprintln!("[startup] logboek in {}", map.display()),
                Err(e) => eprintln!("[startup] geen logboek: {e}"),
            }

            let diagnostics_path = datamap::tauri_map(app.handle(), datamap::TauriMap::Logs)
                .map_err(|e| format!("Cannot resolve app log directory: {e}"))?
                .join("startup-diagnostics.jsonl");
            let diagnostics = startup_diagnostics::StartupDiagnostics::new(diagnostics_path);
            diagnostics.record("native-created", None);
            app.manage(diagnostics);

            // Ondertekende versies (pdf_signed_revision) ouder dan zeven dagen
            // opruimen; vangnet naast het opruimen door de UI. Ruim genoeg, zodat
            // een tabblad dat in een andere, nog draaiende instantie open staat
            // zijn bestand niet kwijtraakt. Fouten negeren.
            if let Ok(cachemap) = datamap::tauri_map(app.handle(), datamap::TauriMap::Cache) {
                std::thread::spawn(move || {
                    handtekening::verifieer::ruim_ondertekende_versies_op(
                        &handtekening::verifieer::map_ondertekende_versies(&cachemap),
                        handtekening::verifieer::OPRUIMEN_NA,
                    );
                });
            }
            // Voorbeeld-PDF's van het importvenster voor DWG en DXF die van een
            // vorige keer zijn blijven staan (#400). De import kiest zijn map
            // zelf, op een plek (cad_import::voorbeeldmap).
            if let Ok(voorbeelden) = cad_import::voorbeeldmap(app.handle()) {
                std::thread::spawn(move || {
                    cad_import::sweep_previews(&voorbeelden, cad_import::PREVIEW_MAX_AGE);
                });
            }

            // Grant FS plugin scope for command-line files (file association)
            for path in app.state::<OpenedFiles>().0.lock().unwrap().iter() {
                let _ = app.fs_scope().allow_file(path);
            }

            // OPDS_DEVTOOLS=1 opens the web inspector at start, for profiling
            // (the app blocks its menu entry and shortcuts otherwise). With
            // WEBKIT_INSPECTOR_HTTP_SERVER=127.0.0.1:<port> set as well, the
            // inspector can be reached from another machine over a tunnel.
            #[cfg(not(target_os = "android"))]
            if std::env::var("OPDS_DEVTOOLS").map(|v| v == "1").unwrap_or(false) {
                if let Some(window) = app.get_webview_window("main") {
                    window.open_devtools();
                }
            }

            // Set the window icon (desktop only — not applicable on Android)
            #[cfg(not(target_os = "android"))]
            if let Some(window) = app.get_webview_window("main") {
                // Keep the editor identity fixed across add-on installations.
                let icon_bytes = include_bytes!("../community-icons/icon.png");
                if let Ok(icon) = tauri::image::Image::from_bytes(icon_bytes) {
                    let _ = window.set_icon(icon);
                }
            }

            // Spawn the in-process MCP server (deferred until here so the
            // `app_*` tools can dispatch events into the live WebView via
            // the AppHandle stored in the server's AppState). Refuses to
            // start in release builds unless OPS_ENABLE_MCP=1 (handled
            // inside `mcp_server::start`).
            if mcp_enabled {
                let app_handle = app.handle().clone();
                let test_pdfs_dir = mcp_server::resolve_test_pdfs_dir(
                    std::env::var_os("OPS_TEST_PDFS_DIR").map(std::path::PathBuf::from),
                );
                tauri::async_runtime::spawn(async move {
                    if let Err(e) = mcp_server::start(mcp_port, test_pdfs_dir, Some(app_handle)).await {
                        eprintln!("[mcp] server failed: {e}");
                    }
                });
            }

            // PDFium initialisation — must run before any Tauri command.
            // resource_dir() returns the directory where Tauri's bundle.resources
            // land. In dev (cargo run) that's target/debug/; in release it's
            // the installer-payload root.
            let resource_dir = app
                .path()
                .resource_dir()
                .map_err(|e| format!("Cannot resolve resource_dir: {}", e))?;

            // Non-fatal: if PDFium can't load (e.g. libpdfium.so missing from a
            // Linux bundle), the app still starts and the UI loads — rendering
            // reports an error instead of aborting at startup.
            match pdfium_renderer::init_pdfium(&resource_dir) {
                Ok(()) => log::info!("PDFium initialised from {:?}", resource_dir),
                Err(e) => log::error!("PDFium initialisation failed (rendering disabled): {}", e),
            }

            // Windows-only: pre-warm shell32.dll + comdlg32.dll + the
            // IFileOpenDialog COM factory in a background thread so the
            // first time the user clicks Bestand → Open → Bladeren the
            // OS dialog pops in ~100–300ms instead of the cold 1–3 s it
            // takes to load shell32 + every shell extension (OneDrive,
            // cloud-sync providers, AV hooks) on demand.
            //
            // We spend ~50 ms on a background thread at app startup to
            // amortise this cost. The dialog plugin (rfd 0.16) calls
            // CoInitializeEx/CoUninitialize around every Show(), so we
            // can't keep the COM apartment alive across calls — but the
            // DLLs and the registered class factory stay loaded for the
            // life of the process, which is what costs the seconds.
            #[cfg(target_os = "windows")]
            {
                std::thread::spawn(|| {
                    use windows_sys::Win32::System::Com::{
                        CoCreateInstance, CoInitializeEx, CoUninitialize,
                        CLSCTX_INPROC_SERVER, COINIT_APARTMENTTHREADED,
                        COINIT_DISABLE_OLE1DDE,
                    };
                    use windows_sys::Win32::UI::Shell::FileOpenDialog;
                    use windows_sys::core::GUID;
                    const FILE_OPEN_DIALOG_IID: GUID =
                        GUID::from_u128(0xd57c7288_d4ad_4768_be02_9d969532d960);

                    let t0 = std::time::Instant::now();
                    unsafe {
                        let res = CoInitializeEx(
                            std::ptr::null(),
                            (COINIT_APARTMENTTHREADED | COINIT_DISABLE_OLE1DDE) as u32,
                        );
                        if res < 0 {
                            eprintln!("[prewarm] CoInitializeEx failed: 0x{:x}", res);
                            return;
                        }
                        let mut iptr: *mut std::ffi::c_void = std::ptr::null_mut();
                        let hr = CoCreateInstance(
                            &FileOpenDialog,
                            std::ptr::null_mut(),
                            CLSCTX_INPROC_SERVER,
                            &FILE_OPEN_DIALOG_IID,
                            &mut iptr as *mut _ as *mut *mut std::ffi::c_void,
                        );
                        if hr >= 0 && !iptr.is_null() {
                            // Release: vtbl()[2] is Release.
                            #[repr(C)]
                            struct IUnknownV {
                                _qi: usize,
                                _add_ref: usize,
                                release: unsafe extern "system" fn(
                                    this: *mut std::ffi::c_void,
                                ) -> u32,
                            }
                            let vtbl = *(iptr as *mut *mut IUnknownV);
                            ((*vtbl).release)(iptr);
                        }
                        CoUninitialize();
                    }
                    log::info!(
                        "[prewarm] shell32 + IFileOpenDialog factory warmed in {} ms",
                        t0.elapsed().as_millis()
                    );
                });
            }

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            geos_net_area,
            geos_group_net_area,
            geos_offset_curve,
            geos_crossings,
            geos_contains,
            geos_covers,
            geos_simplify,
            geos_polygonize,
            geos_intersection_area,
            geos_difference_area,
            get_opened_file,
            save_session,
            load_session,
            get_username,
            read_file,
            edition_plugin,
            edition_plugins,
            addon_management::addon_packages_list,
            addon_management::addon_package_install,
            addon_management::addon_package_set_enabled,
            addon_management::addon_package_remove,
            addon_management::addon_install_folder,
            addon_management::addon_file_install,
            addon_management::addon_edition_info,
            addon_management::addon_edition_remove,
            addon_opened_files_take,
            edition_helper::edition_helper_available,
            edition_helper::edition_helper_call,
            edition_helper::addon_helper_available,
            edition_helper::addon_helper_call,
            edition_helper::addon_helper_share_file,
            edition_helper::edition_helper_share_file,
            edition_helper::edition_allow_drawing,
            write_file,
            write_file_atomic,
            append_file_atomic,
            file_exists,
            open_url,
            is_dev_mode,
            lock_file,
            unlock_file,
            file_range::file_range_open,
            file_range::file_range_read,
            file_range::file_range_close,
            is_default_pdf_app,
            open_default_apps_settings,
            get_printers,
            print_pdf,
            open_printer_properties,
            printer_papier,
            printer_bedrukbaar,
            get_temp_dir,
            write_temp_pdf,
            delete_file,
            rename_file,
            install_virtual_printer,
            remove_virtual_printer,
            is_virtual_printer_installed,
            virtual_printer_collect,
            virtual_printer_jobs,
            virtual_printer_delete_job,
            virtual_printer_catch_enabled,
            virtual_printer_enable_catch,
            open_pdf_in_default_viewer,
            reveal_in_file_manager,
            get_printer_spool_dir,
            list_printer_spool,
            discard_spool_pdf,
            download_pdf_from_url,
            list_pdf_files,
            save_preferences,
            load_preferences,
            save_catalog,
            load_catalog,
            delete_catalog,
            play_alert_sound,
            list_plugins,
            install_plugin,
            uninstall_plugin,
            read_plugin_file,
            render_pdf_page,
            ocr_pdf_page,
            worker_pool_ready,
            render_pdf_page_region,
            render_tile_scene_region,
            page_content_size,
            perf_log,
            perf_enabled,
            get_page_dimensions,
            invalidate_pdf_cache,
            release_pdf_worker_files,
            handtekening::certificaat::pdf_certificate_info,
            handtekening::verifieer::pdf_signature_list,
            handtekening::verifieer::pdf_signed_revision,
            release_pdf_document,
            clear_pdf_cache,
            analyze_page_type,
            analyze_page_type_batch,
            render_pdf_page_skia,
            extract_draw_commands,
            extract_draw_commands_batch,
            extract_page_text,
            render_thumbnail,
            render_to_png::render_page_to_png,
            cad_export::export_page_to_cad,
            cad_export::cancel_cad_export,
            cad_export::scan_page_for_cad,
            cad_import::scan_cad_file,
            cad_import::import_cad_to_pdf,
            cad_import::cancel_cad_import,
            cad_import::release_cad_import,
            cad_import::locate_cad_externals,
            cad_import::check_cad_search_paths,
            cad_import::preview_cad_import,
            cad_import::discard_cad_preview,
            cad_import::cad_import_limits,
            cad_import::cad_import_dir,
            allow_fs_scope,
            ocr_font_scope::allow_ocr_font_scope,
            generated_backing::create_untitled_pdf_backing,
            generated_backing::create_vector_snippet_backing,
            template_scope::allow_template_scope,
            reader_position_scope::allow_reader_position_scope,
            mcp_app_bridge::app_response,
            mcp_addon_tools::mcp_addon_tools_set,
            mcp_app_bridge::mcp_bridge_ready,
            mcp_koppeling::mcp_instellen,
            mcp_koppeling::mcp_status,
            email::email_pdf,
            window_mgmt::spawn_window_with_pdf,
            window_mgmt::try_dock_pdf_at_screen,
            window_mgmt::close_window_by_label,
            window_mgmt::current_window_label,
            window_mgmt::exit_detached_process,
            window_mgmt::drag_icon_path,
            window_mgmt::tab_drag_preflight,
            window_mgmt::detach_diag,
            startup_diagnostics::startup_diagnostic,
            startup_diagnostics::startup_diagnostics_path,
            datamap::app_data_dir_effectief,
            read_clipboard_image_png,
            set_prtscn_hotkey,
        ])
        .build(editor_context())
        .expect("error while building tauri application")
        .run(|_app, _event| {
            // macOS (en iOS) leveren een dubbelklik in Finder NIET als
            // argv-argument aan (zoals Windows/Linux), maar als Apple Event
            // dat Tauri doorgeeft als RunEvent::Opened { urls }. Zonder deze
            // afhandeling opent de app wel, maar het bestand niet (#325).
            //
            // Twee gevallen, beide via het bestaande argv-mechanisme:
            // - Koude start: het event komt binnen vóór de frontend klaar is.
            //   We bufferen de paden in de OpenedFiles-state; de frontend
            //   haalt ze bij init op via `get_opened_file` (zelfde pad als
            //   command-line-bestanden). De emit hieronder gaat dan verloren
            //   of belandt in pendingOpenFiles — main.js gooit die pending-
            //   lijst weg zodra get_opened_file al bestanden opleverde, dus
            //   er ontstaat geen dubbele tab.
            // - App draait al: de frontend-listener op "open-files" (zelfde
            //   event als de single-instance-plugin gebruikt) opent de tab
            //   direct; de state-buffer wordt dan nooit meer gelezen.
            //
            // Custom-scheme-URLs (deep-link-plugin) hebben scheme != "file"
            // en passeren dit filter niet — geen botsing met die plugin.
            #[cfg(any(target_os = "macos", target_os = "ios"))]
            if let tauri::RunEvent::Opened { urls } = &_event {
                let addon_files: Vec<String> = urls
                    .iter()
                    .filter(|url| url.scheme() == "file")
                    .filter_map(|url| url.to_file_path().ok())
                    .map(|p| p.to_string_lossy().to_string())
                    .filter(|p| is_addon_file_arg(p))
                    .collect();
                if !addon_files.is_empty() {
                    // Buffered for a cold start; the running frontend takes the event.
                    _app.state::<OpenedAddonFiles>().0.lock().unwrap().extend(addon_files.iter().cloned());
                    let _ = _app.emit("open-addon-files", &addon_files);
                }
                let files: Vec<String> = urls
                    .iter()
                    .filter(|url| url.scheme() == "file")
                    .filter_map(|url| url.to_file_path().ok())
                    .map(|p| p.to_string_lossy().to_string())
                    .filter(|p| p.to_lowercase().ends_with(".pdf"))
                    .collect();
                if !files.is_empty() {
                    for path in &files {
                        let _ = _app.fs_scope().allow_file(path);
                    }
                    {
                        let state = _app.state::<OpenedFiles>();
                        let mut buffered = state.0.lock().unwrap();
                        buffered.extend(files.iter().cloned());
                    }
                    let _ = _app.emit("open-files", &files);
                    if let Some(window) = _app.get_webview_window("main") {
                        let _ = window.unminimize();
                        let _ = window.set_focus();
                    }
                }
            }
        });
}
