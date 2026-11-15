//! Page-space polygon operations through the GEOS 3.14.1 C API.
//!
//! Coordinates are PDF user space: origin at the bottom left, y upward,
//! before display rotation. The GEOS context is created on the calling
//! thread and is never shared. See `docs/developer/geos.md`.

use std::error::Error;
use std::ffi::c_void;
use std::fmt;
use std::marker::PhantomData;
use std::os::raw::{c_char, c_int, c_uint};
use std::rc::Rc;

type GeosHandle = *mut c_void;
type GeosGeom = *mut c_void;
type GeosSeq = *mut c_void;

const CAP_FLAT: c_int = 2;
const JOIN_ROUND: c_int = 1;
const JOIN_MITRE: c_int = 2;
const MITRE_LIMIT: f64 = 10.0;
const GEOM_POINT: c_int = 0;
const GEOM_LINESTRING: c_int = 1;
const GEOM_LINEARRING: c_int = 2;
const GEOM_POLYGON: c_int = 3;
const GEOM_MULTIPOINT: c_int = 4;
const GEOM_MULTILINESTRING: c_int = 5;
const GEOM_MULTIPOLYGON: c_int = 6;
const GEOM_COLLECTION: c_int = 7;

extern "C" {
    fn GEOS_init_r() -> GeosHandle;
    fn GEOS_finish_r(handle: GeosHandle);
    fn GEOSCoordSeq_create_r(handle: GeosHandle, size: c_uint, dims: c_uint) -> GeosSeq;
    fn GEOSCoordSeq_destroy_r(handle: GeosHandle, sequence: GeosSeq);
    fn GEOSCoordSeq_setXY_r(
        handle: GeosHandle,
        sequence: GeosSeq,
        index: c_uint,
        x: f64,
        y: f64,
    ) -> c_int;
    fn GEOSGeom_createLinearRing_r(handle: GeosHandle, sequence: GeosSeq) -> GeosGeom;
    fn GEOSGeom_createLineString_r(handle: GeosHandle, sequence: GeosSeq) -> GeosGeom;
    fn GEOSGeom_createPolygon_r(
        handle: GeosHandle,
        shell: GeosGeom,
        holes: *mut GeosGeom,
        nholes: c_uint,
    ) -> GeosGeom;
    fn GEOSGeom_destroy_r(handle: GeosHandle, geometry: GeosGeom);
    fn GEOSGeom_createCollection_r(
        handle: GeosHandle,
        type_id: c_int,
        geoms: *mut GeosGeom,
        ngeoms: c_uint,
    ) -> GeosGeom;
    fn GEOSArea_r(handle: GeosHandle, geometry: *const c_void, area: *mut f64) -> c_int;
    fn GEOSUnion_r(handle: GeosHandle, a: *const c_void, b: *const c_void) -> GeosGeom;
    fn GEOSUnaryUnion_r(handle: GeosHandle, geometry: *const c_void) -> GeosGeom;
    fn GEOSDifference_r(handle: GeosHandle, a: *const c_void, b: *const c_void) -> GeosGeom;
    fn GEOSMakeValid_r(handle: GeosHandle, geometry: *const c_void) -> GeosGeom;
    fn GEOSIntersection_r(handle: GeosHandle, a: *const c_void, b: *const c_void) -> GeosGeom;
    fn GEOSGeomGetX_r(handle: GeosHandle, geometry: *const c_void, x: *mut f64) -> c_int;
    fn GEOSGeomGetY_r(handle: GeosHandle, geometry: *const c_void, y: *mut f64) -> c_int;
    fn GEOSBufferWithStyle_r(
        handle: GeosHandle,
        geometry: *const c_void,
        width: f64,
        quadsegs: c_int,
        end_cap_style: c_int,
        join_style: c_int,
        mitre_limit: f64,
    ) -> GeosGeom;
    fn GEOSOffsetCurve_r(
        handle: GeosHandle,
        geometry: *const c_void,
        width: f64,
        quadsegs: c_int,
        join_style: c_int,
        mitre_limit: f64,
    ) -> GeosGeom;
    fn GEOSGeomTypeId_r(handle: GeosHandle, geometry: *const c_void) -> c_int;
    fn GEOSGetExteriorRing_r(handle: GeosHandle, geometry: *const c_void) -> *const c_void;
    fn GEOSGetNumGeometries_r(handle: GeosHandle, geometry: *const c_void) -> c_int;
    fn GEOSGetGeometryN_r(
        handle: GeosHandle,
        geometry: *const c_void,
        index: c_int,
    ) -> *const c_void;
    fn GEOSGeom_getCoordSeq_r(handle: GeosHandle, geometry: *const c_void) -> GeosSeq;
    fn GEOSCoordSeq_getSize_r(handle: GeosHandle, sequence: GeosSeq, size: *mut c_uint) -> c_int;
    fn GEOSCoordSeq_getXY_r(
        handle: GeosHandle,
        sequence: GeosSeq,
        index: c_uint,
        x: *mut f64,
        y: *mut f64,
    ) -> c_int;
    fn GEOSGeom_createPointFromXY_r(handle: GeosHandle, x: f64, y: f64) -> GeosGeom;
    fn GEOSPolygonize_r(
        handle: GeosHandle,
        geoms: *const *const c_void,
        ngeoms: c_uint,
    ) -> GeosGeom;
    fn GEOSSimplify_r(handle: GeosHandle, geom: *const c_void, tolerance: f64) -> GeosGeom;
    fn GEOSContains_r(handle: GeosHandle, a: *const c_void, b: *const c_void) -> c_char;
    fn GEOSCovers_r(handle: GeosHandle, a: *const c_void, b: *const c_void) -> c_char;
    fn GEOSPrepare_r(handle: GeosHandle, geom: *const c_void) -> *const c_void;
    fn GEOSPreparedGeom_destroy_r(handle: GeosHandle, prepared: *const c_void);
    fn GEOSPreparedContains_r(
        handle: GeosHandle,
        prepared: *const c_void,
        geom: *const c_void,
    ) -> c_char;
    fn GEOSGetNumInteriorRings_r(handle: GeosHandle, geometry: *const c_void) -> c_int;
    fn GEOSGetInteriorRingN_r(
        handle: GeosHandle,
        geometry: *const c_void,
        index: c_int,
    ) -> *const c_void;
}

/// A GEOS call failed. The text is a static reason, with no geometry data.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct GeosError(&'static str);

impl fmt::Display for GeosError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(self.0)
    }
}

impl Error for GeosError {}

struct Context {
    handle: GeosHandle,
    _thread: PhantomData<Rc<()>>,
}

impl Drop for Context {
    fn drop(&mut self) {
        unsafe { GEOS_finish_r(self.handle) };
    }
}

struct Geom {
    handle: GeosHandle,
    geometry: GeosGeom,
}

impl Drop for Geom {
    fn drop(&mut self) {
        unsafe { GEOSGeom_destroy_r(self.handle, self.geometry) };
    }
}

/// Prepared geometry for one `with_geos` call. Not `Send`. Destroyed before
/// the source polygon it borrows.
struct Prepared<'a> {
    handle: GeosHandle,
    prepared: *const c_void,
    _source: &'a Geom,
    _thread: PhantomData<Rc<()>>,
}

impl Drop for Prepared<'_> {
    fn drop(&mut self) {
        let _source = self._source;
        unsafe { GEOSPreparedGeom_destroy_r(self.handle, self.prepared) };
    }
}

thread_local! {
    static CONTEXT: std::cell::RefCell<Option<Context>> = const { std::cell::RefCell::new(None) };
}

fn with_geos<T>(body: impl FnOnce(GeosHandle) -> Result<T, GeosError>) -> Result<T, GeosError> {
    CONTEXT.with(|slot| {
        let mut ctx = slot.borrow_mut();
        if ctx.is_none() {
            let handle = unsafe { GEOS_init_r() };
            if handle.is_null() {
                return Err(GeosError("GEOS_init_r failed"));
            }
            *ctx = Some(Context {
                handle,
                _thread: PhantomData,
            });
        }
        let handle = ctx.as_ref().expect("context was just stored").handle;
        body(handle)
    })
}

/// Area of one simple ring, in page points squared.
pub fn ring_area(ring: &[(f64, f64)]) -> Result<f64, GeosError> {
    with_geos(|handle| {
        let polygon = polygon(handle, ring, None)?;
        area_of(handle, polygon.geometry)
    })
}

/// Area of the union of two simple rings, in page points squared.
pub fn union_area(first: &[(f64, f64)], second: &[(f64, f64)]) -> Result<f64, GeosError> {
    with_geos(|handle| {
        let a = polygon(handle, first, None)?;
        let b = polygon(handle, second, None)?;
        let combined = unsafe { GEOSUnion_r(handle, a.geometry, b.geometry) };
        if combined.is_null() {
            return Err(GeosError("GEOSUnion_r failed"));
        }
        let combined = Geom {
            handle,
            geometry: combined,
        };
        area_of(handle, combined.geometry)
    })
}

/// One polygonal shape: additive rings, then rings already classified as holes.
pub struct AreaShape {
    pub parts: Vec<Vec<(f64, f64)>>,
    pub holes: Vec<Vec<(f64, f64)>>,
}

/// Area of the union of `parts`, minus the union of `holes`, in page points squared.
///
/// Parts that overlap are counted once. A hole that misses the parts removes
/// nothing. A self-crossing ring is repaired before the area is read, so both
/// lobes count and a cancelling shoelace of zero does not. This is the figure
/// an area measurement asks for after the rings have been split into parts
/// and holes.
pub fn net_area(parts: &[Vec<(f64, f64)>], holes: &[Vec<(f64, f64)>]) -> Result<f64, GeosError> {
    with_geos(|handle| {
        let combined = net_geometry(handle, parts, holes)?;
        area_of(handle, combined.geometry)
    })
}

/// Area of the union of several shapes, in page points squared.
///
/// Each shape is repaired, its parts are unioned, and its holes are
/// subtracted. The shapes are then unioned, so an overlap between two
/// takeoffs counts once. A hole stays open unless another shape covers it.
pub fn group_net_area(shapes: &[AreaShape]) -> Result<f64, GeosError> {
    if shapes.is_empty() {
        return Err(GeosError("a group net needs one shape"));
    }
    with_geos(|handle| {
        let mut geoms = Vec::with_capacity(shapes.len());
        for shape in shapes {
            geoms.push(net_geometry(handle, &shape.parts, &shape.holes)?);
        }
        let combined = if geoms.len() == 1 {
            geoms.pop().expect("one shape")
        } else {
            unary_union(handle, geoms)?
        };
        area_of(handle, combined.geometry)
    })
}

fn net_geometry(
    handle: GeosHandle,
    parts: &[Vec<(f64, f64)>],
    holes: &[Vec<(f64, f64)>],
) -> Result<Geom, GeosError> {
    if parts.is_empty() {
        return Err(GeosError("a net area needs one part"));
    }
    let mut combined = repaired_polygon(handle, &parts[0])?;
    for part in &parts[1..] {
        combined = overlay(
            handle,
            combined,
            repaired_polygon(handle, part)?,
            GEOSUnion_r,
            "GEOSUnion_r failed",
        )?;
    }
    for hole in holes {
        combined = overlay(
            handle,
            combined,
            repaired_polygon(handle, hole)?,
            GEOSDifference_r,
            "GEOSDifference_r failed",
        )?;
    }
    Ok(combined)
}

fn repaired_polygon(handle: GeosHandle, ring: &[(f64, f64)]) -> Result<Geom, GeosError> {
    let raw = polygon(handle, ring, None)?;
    let fixed = unsafe { GEOSMakeValid_r(handle, raw.geometry) };
    if fixed.is_null() {
        return Err(GeosError("GEOSMakeValid_r failed"));
    }
    Ok(Geom {
        handle,
        geometry: fixed,
    })
}

fn unary_union(handle: GeosHandle, geoms: Vec<Geom>) -> Result<Geom, GeosError> {
    let mut ptrs = Vec::with_capacity(geoms.len());
    for geom in geoms {
        ptrs.push(geom.geometry);
        // createCollection takes the geometries, including when it fails.
        std::mem::forget(geom);
    }
    let collection = unsafe {
        GEOSGeom_createCollection_r(
            handle,
            GEOM_COLLECTION,
            ptrs.as_mut_ptr(),
            ptrs.len() as c_uint,
        )
    };
    if collection.is_null() {
        return Err(GeosError("GEOSGeom_createCollection_r failed"));
    }
    let collection = Geom {
        handle,
        geometry: collection,
    };
    let unioned = unsafe { GEOSUnaryUnion_r(handle, collection.geometry) };
    if unioned.is_null() {
        return Err(GeosError("GEOSUnaryUnion_r failed"));
    }
    Ok(Geom {
        handle,
        geometry: unioned,
    })
}

fn overlay(
    handle: GeosHandle,
    left: Geom,
    right: Geom,
    op: unsafe extern "C" fn(GeosHandle, *const c_void, *const c_void) -> GeosGeom,
    failure: &'static str,
) -> Result<Geom, GeosError> {
    let geometry = unsafe { op(handle, left.geometry, right.geometry) };
    if geometry.is_null() {
        return Err(GeosError(failure));
    }
    Ok(Geom { handle, geometry })
}

/// Area of an outer ring minus one hole, in page points squared.
pub fn area_with_hole(outer: &[(f64, f64)], hole: &[(f64, f64)]) -> Result<f64, GeosError> {
    with_geos(|handle| {
        let polygon = polygon(handle, outer, Some(hole))?;
        area_of(handle, polygon.geometry)
    })
}

/// Area of a flat-capped corridor around a straight segment.
///
/// `width` is the full corridor width in page points. The buffer radius is
/// half of that. End caps are flat, so a straight corridor's area is the
/// length times the width, within the tolerance recorded in `docs/developer/geos.md`.
pub fn flat_buffer_area(start: (f64, f64), end: (f64, f64), width: f64) -> Result<f64, GeosError> {
    if !width.is_finite() || width <= 0.0 {
        return Err(GeosError("corridor width must be positive"));
    }
    with_geos(|handle| {
        let line = line_string(handle, &[start, end])?;
        let buffered = unsafe {
            GEOSBufferWithStyle_r(
                handle,
                line.geometry,
                width / 2.0,
                8,
                CAP_FLAT,
                JOIN_ROUND,
                5.0,
            )
        };
        if buffered.is_null() {
            return Err(GeosError("GEOSBufferWithStyle_r failed"));
        }
        let buffered = Geom {
            handle,
            geometry: buffered,
        };
        area_of(handle, buffered.geometry)
    })
}

/// Points where two open paths actually cross, in page space.
///
/// A collinear overlap is not a crossing, so it contributes no points. An
/// empty list means the paths do not cross. The caller still owns both paths.
pub fn crossing_points(
    left: &[(f64, f64)],
    right: &[(f64, f64)],
) -> Result<Vec<(f64, f64)>, GeosError> {
    with_geos(|handle| {
        let left_line = open_line(handle, &offset_line(left, false)?)?;
        let right_line = open_line(handle, &offset_line(right, false)?)?;
        let hit = unsafe { GEOSIntersection_r(handle, left_line.geometry, right_line.geometry) };
        if hit.is_null() {
            return Err(GeosError("GEOSIntersection_r failed"));
        }
        let hit = Geom {
            handle,
            geometry: hit,
        };
        let mut points = Vec::new();
        collect_points(handle, hit.geometry, &mut points)?;
        Ok(points)
    })
}

fn collect_points(
    handle: GeosHandle,
    geometry: *const c_void,
    points: &mut Vec<(f64, f64)>,
) -> Result<(), GeosError> {
    if geometry.is_null() {
        return Ok(());
    }
    let kind = unsafe { GEOSGeomTypeId_r(handle, geometry) };
    if kind == GEOM_POINT {
        let mut x = 0.0;
        let mut y = 0.0;
        let ok = unsafe { GEOSGeomGetX_r(handle, geometry, &mut x) } == 1
            && unsafe { GEOSGeomGetY_r(handle, geometry, &mut y) } == 1;
        if !ok || !x.is_finite() || !y.is_finite() {
            return Err(GeosError("GEOSGeomGetX_r failed"));
        }
        if points
            .iter()
            .all(|point| (point.0 - x).abs() > 1e-8 || (point.1 - y).abs() > 1e-8)
        {
            points.push((x, y));
        }
        return Ok(());
    }
    if kind == GEOM_MULTIPOINT || kind == GEOM_COLLECTION {
        let count = unsafe { GEOSGetNumGeometries_r(handle, geometry) };
        if count < 0 {
            return Err(GeosError("GEOSGetNumGeometries_r failed"));
        }
        for index in 0..count {
            let child = unsafe { GEOSGetGeometryN_r(handle, geometry, index) };
            collect_points(handle, child, points)?;
        }
    }
    Ok(())
}

/// One-sided parallel of a polyline, in page points.
///
/// `side` follows the offset tool: +1 is the left of travel for the normal
/// `(dy, -dx)`. A segment `(0,0)-(10,0)` with side +1 and distance 2 therefore
/// lands on `(0,-2)-(10,-2)`. GEOS treats a positive width as left while y
/// grows upward, which is the opposite direction, so an open curve is passed
/// `-distance` for side +1.
///
/// A closed ring does not use that curve. The curve drops the join between
/// the last segment and the first. The ring is buffered instead, and a
/// positive buffer grows it. Side +1 grows the ring when its page shoelace
/// is positive, which is the same side the offset tool calls outward. Joins
/// are mitred with limit 10. A curve or buffer that comes back as more than
/// one piece is an error, and the caller keeps its own polyline. The
/// returned list does not repeat the first point.
pub fn offset_curve(
    points: &[(f64, f64)],
    distance: f64,
    side: f64,
    closed: bool,
) -> Result<Vec<(f64, f64)>, GeosError> {
    if !distance.is_finite() || distance <= 0.0 {
        return Err(GeosError("offset distance must be positive"));
    }
    if !side.is_finite() {
        return Err(GeosError("offset side must be finite"));
    }
    with_geos(|handle| {
        let mut result = if closed {
            buffered_ring(handle, points, distance, side)?
        } else {
            parallel_line(handle, points, distance, side)?
        };
        if result.len() > 3 {
            let first = result[0];
            let last = *result.last().expect("curve has a point");
            if (first.0 - last.0).abs() <= 1e-8 && (first.1 - last.1).abs() <= 1e-8 {
                result.pop();
            }
        }
        if result.len() < 2 {
            return Err(GeosError("offset curve is too short"));
        }
        Ok(result)
    })
}

/// True when `(x, y)` is strictly inside `ring`.
///
/// A point on the boundary is false. `GEOSContains_r` returns a C `char`:
/// 1, 0, or 2 for an exception. The ring is the container.
pub fn contains_point(ring: &[(f64, f64)], x: f64, y: f64) -> Result<bool, GeosError> {
    relate_point(ring, x, y, GEOSContains_r, "GEOSContains_r failed")
}

/// True when `(x, y)` is inside `ring` or on its boundary.
///
/// A corner of the ring is true.
pub fn covers_point(ring: &[(f64, f64)], x: f64, y: f64) -> Result<bool, GeosError> {
    relate_point(ring, x, y, GEOSCovers_r, "GEOSCovers_r failed")
}

/// Prepared contains for each point, in order. A boundary point is false.
///
/// The polygon is prepared once. That prepared geometry is destroyed before
/// the polygon drops, is not stored past this call, and is not `Send`.
pub fn contains_points(ring: &[(f64, f64)], points: &[(f64, f64)]) -> Result<Vec<bool>, GeosError> {
    if points
        .iter()
        .any(|point| !point.0.is_finite() || !point.1.is_finite())
    {
        return Err(GeosError("a point needs finite coordinates"));
    }
    with_geos(|handle| {
        let polygon = polygon(handle, ring, None)?;
        let prepared_ptr = unsafe { GEOSPrepare_r(handle, polygon.geometry) };
        if prepared_ptr.is_null() {
            return Err(GeosError("GEOSPrepare_r failed"));
        }
        let prepared = Prepared {
            handle,
            prepared: prepared_ptr,
            _source: &polygon,
            _thread: PhantomData,
        };
        let mut answers = Vec::with_capacity(points.len());
        for point in points {
            let geometry = unsafe { GEOSGeom_createPointFromXY_r(handle, point.0, point.1) };
            if geometry.is_null() {
                return Err(GeosError("GEOSGeom_createPointFromXY_r failed"));
            }
            let geometry = Geom { handle, geometry };
            let flag =
                unsafe { GEOSPreparedContains_r(handle, prepared.prepared, geometry.geometry) };
            answers.push(flag_bool(flag, "GEOSPreparedContains_r failed")?);
        }
        drop(prepared);
        Ok(answers)
    })
}

fn relate_point(
    ring: &[(f64, f64)],
    x: f64,
    y: f64,
    pred: unsafe extern "C" fn(GeosHandle, *const c_void, *const c_void) -> c_char,
    failure: &'static str,
) -> Result<bool, GeosError> {
    if !x.is_finite() || !y.is_finite() {
        return Err(GeosError("a point needs finite coordinates"));
    }
    with_geos(|handle| {
        let polygon = polygon(handle, ring, None)?;
        let geometry = unsafe { GEOSGeom_createPointFromXY_r(handle, x, y) };
        if geometry.is_null() {
            return Err(GeosError("GEOSGeom_createPointFromXY_r failed"));
        }
        let point = Geom { handle, geometry };
        let flag = unsafe { pred(handle, polygon.geometry, point.geometry) };
        flag_bool(flag, failure)
    })
}

fn flag_bool(flag: c_char, failure: &'static str) -> Result<bool, GeosError> {
    match flag as c_int {
        1 => Ok(true),
        0 => Ok(false),
        _ => Err(GeosError(failure)),
    }
}

/// Douglas-Peucker reduction. `tolerance` is page points, finite and `>= 0`.
///
/// An open path is a linestring. A closed ring is a polygon, and the result
/// is its exterior ring without the repeated first point. Fewer than two
/// open points, or fewer than three closed points, is an error.
pub fn simplify_line(
    points: &[(f64, f64)],
    tolerance: f64,
    closed: bool,
) -> Result<Vec<(f64, f64)>, GeosError> {
    if !tolerance.is_finite() || tolerance < 0.0 {
        return Err(GeosError(
            "simplify tolerance must be finite and non-negative",
        ));
    }
    if points
        .iter()
        .any(|point| !point.0.is_finite() || !point.1.is_finite())
    {
        return Err(GeosError("simplify needs finite points"));
    }
    if closed {
        if points.len() < 3 {
            return Err(GeosError("a closed simplify needs three points"));
        }
    } else if points.len() < 2 {
        return Err(GeosError("an open simplify needs two points"));
    }
    with_geos(|handle| {
        let source = if closed {
            polygon(handle, points, None)?
        } else {
            open_line(handle, points)?
        };
        let simplified = unsafe { GEOSSimplify_r(handle, source.geometry, tolerance) };
        if simplified.is_null() {
            return Err(GeosError("GEOSSimplify_r failed"));
        }
        let simplified = Geom {
            handle,
            geometry: simplified,
        };
        if closed {
            let shell = unsafe { GEOSGetExteriorRing_r(handle, simplified.geometry) };
            if shell.is_null() {
                return Err(GeosError("GEOSGetExteriorRing_r failed"));
            }
            open_ring(handle, shell)?.ok_or(GeosError("simplified ring is too short"))
        } else {
            let line = coord_list(handle, simplified.geometry)?;
            if line.len() < 2 {
                return Err(GeosError("simplified line is too short"));
            }
            Ok(line)
        }
    })
}

/// One closed face from polygonized linework.
///
/// `shell` and each hole omit the repeated first point.
#[derive(Debug)]
pub struct PolygonFace {
    pub shell: Vec<(f64, f64)>,
    pub holes: Vec<Vec<(f64, f64)>>,
    pub area: f64,
}

/// Closed faces formed by `lines`. The caller still owns every input line.
///
/// Each line needs at least two finite points. `GEOSPolygonize_r` only
/// borrows them. A linestring that does not close contributes no face.
/// Empty results are skipped.
pub fn polygonize(lines: &[Vec<(f64, f64)>]) -> Result<Vec<PolygonFace>, GeosError> {
    if lines.is_empty() {
        return Ok(Vec::new());
    }
    for line in lines {
        if line.len() < 2
            || line
                .iter()
                .any(|point| !point.0.is_finite() || !point.1.is_finite())
        {
            return Err(GeosError("a polygonize line needs two finite points"));
        }
    }
    with_geos(|handle| {
        let mut owned = Vec::with_capacity(lines.len());
        for line in lines {
            owned.push(open_line(handle, line)?);
        }
        // The array does not take ownership of these linestrings.
        let ptrs: Vec<*const c_void> = owned
            .iter()
            .map(|geom| geom.geometry as *const c_void)
            .collect();
        let result = unsafe { GEOSPolygonize_r(handle, ptrs.as_ptr(), ptrs.len() as c_uint) };
        if result.is_null() {
            return Err(GeosError("GEOSPolygonize_r failed"));
        }
        let result = Geom {
            handle,
            geometry: result,
        };
        let mut faces = Vec::new();
        collect_faces(handle, result.geometry, &mut faces)?;
        Ok(faces)
    })
}

fn collect_faces(
    handle: GeosHandle,
    geometry: *const c_void,
    faces: &mut Vec<PolygonFace>,
) -> Result<(), GeosError> {
    if geometry.is_null() {
        return Ok(());
    }
    let kind = unsafe { GEOSGeomTypeId_r(handle, geometry) };
    if kind == GEOM_POLYGON {
        if let Some(face) = polygon_face(handle, geometry)? {
            faces.push(face);
        }
        return Ok(());
    }
    if kind == GEOM_MULTIPOLYGON || kind == GEOM_COLLECTION {
        let count = unsafe { GEOSGetNumGeometries_r(handle, geometry) };
        if count < 0 {
            return Err(GeosError("GEOSGetNumGeometries_r failed"));
        }
        for index in 0..count {
            let child = unsafe { GEOSGetGeometryN_r(handle, geometry, index) };
            collect_faces(handle, child, faces)?;
        }
    }
    Ok(())
}

fn polygon_face(
    handle: GeosHandle,
    geometry: *const c_void,
) -> Result<Option<PolygonFace>, GeosError> {
    let shell = unsafe { GEOSGetExteriorRing_r(handle, geometry) };
    if shell.is_null() {
        return Ok(None);
    }
    let Some(shell) = open_ring(handle, shell)? else {
        return Ok(None);
    };
    let nholes = unsafe { GEOSGetNumInteriorRings_r(handle, geometry) };
    if nholes < 0 {
        return Err(GeosError("GEOSGetNumInteriorRings_r failed"));
    }
    let mut holes = Vec::with_capacity(nholes as usize);
    for index in 0..nholes {
        let hole = unsafe { GEOSGetInteriorRingN_r(handle, geometry, index) };
        if hole.is_null() {
            return Err(GeosError("GEOSGetInteriorRingN_r failed"));
        }
        if let Some(ring) = open_ring(handle, hole)? {
            holes.push(ring);
        }
    }
    let area = area_of(handle, geometry)?;
    Ok(Some(PolygonFace { shell, holes, area }))
}

/// Area of the intersection of two simple rings, in page points squared.
///
/// Both rings stay owned by the caller.
pub fn intersection_area(first: &[(f64, f64)], second: &[(f64, f64)]) -> Result<f64, GeosError> {
    overlay_area(
        first,
        second,
        GEOSIntersection_r,
        "GEOSIntersection_r failed",
    )
}

/// Area of `first` minus `second`, in page points squared.
///
/// Both rings stay owned by the caller.
pub fn difference_area(first: &[(f64, f64)], second: &[(f64, f64)]) -> Result<f64, GeosError> {
    overlay_area(first, second, GEOSDifference_r, "GEOSDifference_r failed")
}

fn overlay_area(
    first: &[(f64, f64)],
    second: &[(f64, f64)],
    op: unsafe extern "C" fn(GeosHandle, *const c_void, *const c_void) -> GeosGeom,
    failure: &'static str,
) -> Result<f64, GeosError> {
    with_geos(|handle| {
        let left = polygon(handle, first, None)?;
        let right = polygon(handle, second, None)?;
        let hit = overlay(handle, left, right, op, failure)?;
        area_of(handle, hit.geometry)
    })
}

fn parallel_line(
    handle: GeosHandle,
    points: &[(f64, f64)],
    distance: f64,
    side: f64,
) -> Result<Vec<(f64, f64)>, GeosError> {
    let line = offset_line(points, false)?;
    let width = if side < 0.0 { distance } else { -distance };
    let source = open_line(handle, &line)?;
    let curved =
        unsafe { GEOSOffsetCurve_r(handle, source.geometry, width, 8, JOIN_MITRE, MITRE_LIMIT) };
    if curved.is_null() {
        return Err(GeosError("GEOSOffsetCurve_r failed"));
    }
    let curved = Geom {
        handle,
        geometry: curved,
    };
    line_points(handle, curved.geometry)
}

fn buffered_ring(
    handle: GeosHandle,
    points: &[(f64, f64)],
    distance: f64,
    side: f64,
) -> Result<Vec<(f64, f64)>, GeosError> {
    let mut ring = offset_line(points, true)?;
    ring.pop();
    let grows = page_shoelace(&ring) > 0.0;
    let grow = if side < 0.0 { !grows } else { grows };
    let width = if grow { distance } else { -distance };
    let source = polygon(handle, &ring, None)?;
    let buffered = unsafe {
        GEOSBufferWithStyle_r(
            handle,
            source.geometry,
            width,
            8,
            CAP_FLAT,
            JOIN_MITRE,
            MITRE_LIMIT,
        )
    };
    if buffered.is_null() {
        return Err(GeosError("GEOSBufferWithStyle_r failed"));
    }
    let buffered = Geom {
        handle,
        geometry: buffered,
    };
    let kind = unsafe { GEOSGeomTypeId_r(handle, buffered.geometry) };
    if kind != GEOM_POLYGON {
        return Err(GeosError("offset curve split"));
    }
    let shell = unsafe { GEOSGetExteriorRing_r(handle, buffered.geometry) };
    if shell.is_null() {
        return Err(GeosError("offset curve is empty"));
    }
    line_points(handle, shell)
}

fn page_shoelace(points: &[(f64, f64)]) -> f64 {
    let mut area = 0.0;
    let count = points.len();
    for index in 0..count {
        let start = points[index];
        let end = points[(index + 1) % count];
        area += start.0 * end.1 - end.0 * start.1;
    }
    area
}

fn offset_line(points: &[(f64, f64)], closed: bool) -> Result<Vec<(f64, f64)>, GeosError> {
    if points
        .iter()
        .any(|point| !point.0.is_finite() || !point.1.is_finite())
    {
        return Err(GeosError("an offset needs finite points"));
    }
    let mut line = Vec::with_capacity(points.len() + 1);
    for point in points {
        if line.last() == Some(point) {
            continue;
        }
        line.push(*point);
    }
    if closed {
        if line.len() >= 2 && line.first() == line.last() {
            line.pop();
        }
        if line.len() < 3 {
            return Err(GeosError("a closed offset needs three points"));
        }
        let first = line[0];
        line.push(first);
    } else if line.len() < 2 {
        return Err(GeosError("an offset needs two points"));
    }
    Ok(line)
}

fn open_line(handle: GeosHandle, points: &[(f64, f64)]) -> Result<Geom, GeosError> {
    let sequence = coord_seq(handle, points)?;
    let geometry = unsafe { GEOSGeom_createLineString_r(handle, sequence) };
    if geometry.is_null() {
        return Err(GeosError("GEOSGeom_createLineString_r failed"));
    }
    Ok(Geom { handle, geometry })
}

fn line_points(handle: GeosHandle, geometry: *const c_void) -> Result<Vec<(f64, f64)>, GeosError> {
    let kind = unsafe { GEOSGeomTypeId_r(handle, geometry) };
    let curve = if kind == GEOM_MULTILINESTRING {
        let count = unsafe { GEOSGetNumGeometries_r(handle, geometry) };
        if count != 1 {
            return Err(GeosError("offset curve split"));
        }
        unsafe { GEOSGetGeometryN_r(handle, geometry, 0) }
    } else if kind == GEOM_LINESTRING || kind == GEOM_LINEARRING {
        geometry
    } else {
        return Err(GeosError("offset curve is not a line"));
    };
    if curve.is_null() {
        return Err(GeosError("offset curve is empty"));
    }
    let sequence = unsafe { GEOSGeom_getCoordSeq_r(handle, curve) };
    if sequence.is_null() {
        return Err(GeosError("offset curve has no coordinates"));
    }
    let mut size: c_uint = 0;
    if unsafe { GEOSCoordSeq_getSize_r(handle, sequence, &mut size) } != 1 || size < 2 {
        return Err(GeosError("offset curve is too short"));
    }
    let mut points = Vec::with_capacity(size as usize);
    for index in 0..size {
        let mut x = 0.0;
        let mut y = 0.0;
        let ok = unsafe { GEOSCoordSeq_getXY_r(handle, sequence, index, &mut x, &mut y) };
        if ok != 1 || !x.is_finite() || !y.is_finite() {
            return Err(GeosError("offset curve coordinate failed"));
        }
        points.push((x, y));
    }
    Ok(points)
}

fn area_of(handle: GeosHandle, geometry: *const c_void) -> Result<f64, GeosError> {
    let mut area = 0.0;
    let ok = unsafe { GEOSArea_r(handle, geometry, &mut area) };
    if ok != 1 || !area.is_finite() {
        return Err(GeosError("GEOSArea_r failed"));
    }
    Ok(area)
}

fn polygon(
    handle: GeosHandle,
    outer: &[(f64, f64)],
    hole: Option<&[(f64, f64)]>,
) -> Result<Geom, GeosError> {
    let shell = linear_ring(handle, outer)?;
    let shell_ptr = shell.geometry;
    // createPolygon frees the rings, including when it fails.
    std::mem::forget(shell);

    let geometry = if let Some(points) = hole {
        let hole_ring = match linear_ring(handle, points) {
            Ok(ring) => ring,
            Err(error) => {
                unsafe { GEOSGeom_destroy_r(handle, shell_ptr) };
                return Err(error);
            }
        };
        let hole_ptr = hole_ring.geometry;
        std::mem::forget(hole_ring);
        let mut holes = [hole_ptr];
        unsafe { GEOSGeom_createPolygon_r(handle, shell_ptr, holes.as_mut_ptr(), 1) }
    } else {
        unsafe { GEOSGeom_createPolygon_r(handle, shell_ptr, std::ptr::null_mut(), 0) }
    };
    if geometry.is_null() {
        return Err(GeosError("GEOSGeom_createPolygon_r failed"));
    }
    Ok(Geom { handle, geometry })
}

fn linear_ring(handle: GeosHandle, points: &[(f64, f64)]) -> Result<Geom, GeosError> {
    let closed = close_ring(points)?;
    let sequence = coord_seq(handle, &closed)?;
    let geometry = unsafe { GEOSGeom_createLinearRing_r(handle, sequence) };
    // On failure GEOS has already freed the sequence.
    if geometry.is_null() {
        return Err(GeosError("GEOSGeom_createLinearRing_r failed"));
    }
    Ok(Geom { handle, geometry })
}

fn line_string(handle: GeosHandle, points: &[(f64, f64)]) -> Result<Geom, GeosError> {
    if points.len() < 2
        || points
            .iter()
            .any(|point| !point.0.is_finite() || !point.1.is_finite())
    {
        return Err(GeosError("a line needs two finite points"));
    }
    if points[0] == points[1] {
        return Err(GeosError("a corridor needs a segment with length"));
    }
    let sequence = coord_seq(handle, points)?;
    let geometry = unsafe { GEOSGeom_createLineString_r(handle, sequence) };
    if geometry.is_null() {
        return Err(GeosError("GEOSGeom_createLineString_r failed"));
    }
    Ok(Geom { handle, geometry })
}

fn coord_list(handle: GeosHandle, geometry: *const c_void) -> Result<Vec<(f64, f64)>, GeosError> {
    if geometry.is_null() {
        return Err(GeosError("geometry has no coordinates"));
    }
    let sequence = unsafe { GEOSGeom_getCoordSeq_r(handle, geometry) };
    if sequence.is_null() {
        return Err(GeosError("GEOSGeom_getCoordSeq_r failed"));
    }
    let mut size: c_uint = 0;
    if unsafe { GEOSCoordSeq_getSize_r(handle, sequence, &mut size) } != 1 {
        return Err(GeosError("GEOSCoordSeq_getSize_r failed"));
    }
    let mut points = Vec::with_capacity(size as usize);
    for index in 0..size {
        let mut x = 0.0;
        let mut y = 0.0;
        let ok = unsafe { GEOSCoordSeq_getXY_r(handle, sequence, index, &mut x, &mut y) };
        if ok != 1 || !x.is_finite() || !y.is_finite() {
            return Err(GeosError("GEOSCoordSeq_getXY_r failed"));
        }
        points.push((x, y));
    }
    Ok(points)
}

fn without_repeated_close(points: &mut Vec<(f64, f64)>) {
    if points.len() > 1 && points.first() == points.last() {
        points.pop();
    }
}

fn open_ring(
    handle: GeosHandle,
    geometry: *const c_void,
) -> Result<Option<Vec<(f64, f64)>>, GeosError> {
    let mut points = coord_list(handle, geometry)?;
    without_repeated_close(&mut points);
    if points.len() < 3 {
        Ok(None)
    } else {
        Ok(Some(points))
    }
}

fn coord_seq(handle: GeosHandle, points: &[(f64, f64)]) -> Result<GeosSeq, GeosError> {
    let sequence = unsafe { GEOSCoordSeq_create_r(handle, points.len() as c_uint, 2) };
    if sequence.is_null() {
        return Err(GeosError("GEOSCoordSeq_create_r failed"));
    }
    for (index, point) in points.iter().enumerate() {
        let ok =
            unsafe { GEOSCoordSeq_setXY_r(handle, sequence, index as c_uint, point.0, point.1) };
        if ok != 1 {
            unsafe { GEOSCoordSeq_destroy_r(handle, sequence) };
            return Err(GeosError("GEOSCoordSeq_setXY_r failed"));
        }
    }
    Ok(sequence)
}

fn close_ring(points: &[(f64, f64)]) -> Result<Vec<(f64, f64)>, GeosError> {
    if points.len() < 3
        || points
            .iter()
            .any(|point| !point.0.is_finite() || !point.1.is_finite())
    {
        return Err(GeosError("a ring needs three finite points"));
    }
    let mut closed = points.to_vec();
    let first = closed[0];
    let last = *closed.last().expect("ring has a point");
    if first != last {
        closed.push(first);
    }
    if closed.len() < 4 {
        return Err(GeosError("a ring needs three distinct corners"));
    }
    Ok(closed)
}
