// Dynamic Fill region finder: which closed area of a page's linework holds a
// click? Pure geometry, no app imports, so the node tests drive it directly.
//
// Input: line segments {x1, y1, x2, y2} in annotation space (page points at
// scale 1, y down; pdf-snap-extractor.js already applies the CropBox, /Rotate
// and the app page rotation), plus the seed point in the same space.
//
// Method (docs/reference/editor/measuring.md has the reasoning):
//   1. Gap bridges: every segment endpoint is joined to the endpoints of
//      OTHER linework within the gap tolerance, and a free line end is
//      extended onto the segment it points at, so a door opening or a sloppy
//      CAD corner narrower than the tolerance closes.
//   2. The segments (page lines, bridges, temporary boundary lines) are drawn
//      into an occupancy grid around the seed (a window that grows only when
//      the fill reaches its edge, so a large sheet is not rasterised whole).
//   3. A 4-connected flood fill from the seed cell. Reaching the edge of all
//      linework means the click is not inside a closed region.
//   4. Barrier cells with fill on both sides (a stray line or dangling stub
//      inside the room) join the fill, so they do not become slit holes.
//   5. The fill's cell boundary is traced into loops (outer ring, islands),
//      simplified (Douglas-Peucker) and each vertex is snapped back onto the
//      vector geometry (segment intersections and endpoints, else the nearest
//      segment), so a room drawn with straight lines yields its exact corners.

/**
 * What Apply can make (one or more), in the external editor's order: Space (a named room
 * with its tag), Area (default), Perimeter, Polylength, Volume, Polygon.
 */
export const DYNAMIC_FILL_OUTPUTS = Object.freeze(['space', 'area', 'perimeter', 'polylength', 'volume', 'polygon']);

const DEFAULTS = Object.freeze({
  gap: 0,               // close openings up to this width (page points)
  minCell: 0.35,        // finest grid cell (page points)
  maxCells: 1_000_000,  // grid budget per attempt (snapping restores exact corners)
  initialHalf: 240,     // half size of the first window around the seed
  growth: 2.5,          // window growth when the fill reaches its edge
});

const DIRS = [[1, 0], [0, 1], [-1, 0], [0, -1]]; // E S W N (y down)

/** Bounding box of segments, or null. */
export function segmentBounds(segments) {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const s of segments) {
    if (s.x1 < minX) minX = s.x1; if (s.x2 < minX) minX = s.x2;
    if (s.y1 < minY) minY = s.y1; if (s.y2 < minY) minY = s.y2;
    if (s.x1 > maxX) maxX = s.x1; if (s.x2 > maxX) maxX = s.x2;
    if (s.y1 > maxY) maxY = s.y1; if (s.y2 > maxY) maxY = s.y2;
  }
  return minX <= maxX ? { minX, minY, maxX, maxY } : null;
}

/** Polyline points [{x,y}, ...] → segments. */
export function polylineSegments(points) {
  const out = [];
  for (let i = 0; i + 1 < (points?.length || 0); i++) {
    const a = points[i], b = points[i + 1];
    if (Math.hypot(b.x - a.x, b.y - a.y) > 1e-9) out.push({ x1: a.x, y1: a.y, x2: b.x, y2: b.y });
  }
  return out;
}

// ─── 1. Gap bridges ─────────────────────────────────────────────────────

/**
 * Short segments that close openings up to `gap` wide: endpoint → endpoint of
 * another segment, and a free end (used by one segment only) continued along
 * its own direction onto a segment it points at. Linework that already
 * touches (closer than 1e-6) needs no bridge. An end is bridged only to its
 * nearest other end(s), and not to ends that the linework already joins
 * within 3x their distance (the corners of a
 * column or a short wall return): a bridge there would cut a closed shape
 * into pieces. A door opening is bridged: its way round is the building.
 */
const MAX_GAP_CANDIDATES = 8;

export function gapBridges(segments, gap) {
  if (!(gap > 0) || !segments?.length) return [];
  // Nodes: distinct segment ends (to 0.01 pt), with their degree, the
  // segments that use them and the line graph between them.
  const ids = new Map();
  const nx = [], ny = [], deg = [], adj = [], segsAt = [];
  const nodeId = (x, y) => {
    const k = (Math.round(x * 100) + 1e7) * 2e7 + (Math.round(y * 100) + 1e7);
    let id = ids.get(k);
    if (id === undefined) {
      id = nx.length;
      ids.set(k, id);
      nx.push(x); ny.push(y); deg.push(0); adj.push([]); segsAt.push([]);
    }
    return id;
  };
  const ends = new Int32Array(segments.length * 2);
  for (let i = 0; i < segments.length; i++) {
    const s = segments[i];
    const a = nodeId(s.x1, s.y1), b = nodeId(s.x2, s.y2);
    ends[2 * i] = a; ends[2 * i + 1] = b;
    const len = Math.hypot(s.x2 - s.x1, s.y2 - s.y1);
    deg[a]++; deg[b]++;
    adj[a].push(b, len); adj[b].push(a, len);
    segsAt[a].push(i); segsAt[b].push(i);
  }
  const n = nx.length;
  // Endpoint grid (cell = gap): candidates within the gap are in the 3 x 3 cells.
  const cellKey = (cx, cy) => (cx + 1e6) * 2e6 + (cy + 1e6);
  const pts = new Map();
  for (let id = 0; id < n; id++) {
    const k = cellKey(Math.floor(nx[id] / gap), Math.floor(ny[id] / gap));
    const b = pts.get(k);
    if (b) b.push(id); else pts.set(k, [id]);
  }
  // Is there a path along the linework from a to b no longer than `limit`?
  // Bounded Dijkstra with a binary heap; it stops after a few hundred nodes.
  const linkedWithin = (a, b, limit) => {
    const dist = new Map([[a, 0]]);
    const heap = new MinHeap();
    heap.push(0, a);
    let steps = 0;
    while (heap.size && steps++ < 400) {
      const [d, node] = heap.pop();
      if (node === b) return true;
      if (d > (dist.get(node) ?? Infinity)) continue;
      const list = adj[node];
      for (let k = 0; k < list.length; k += 2) {
        const nd = d + list[k + 1];
        if (nd <= limit && nd < (dist.get(list[k]) ?? Infinity)) {
          dist.set(list[k], nd);
          heap.push(nd, list[k]);
        }
      }
    }
    return false;
  };
  const bridges = [];
  const seen = new Set();
  const pushBridge = (a, b) => {
    const k = a < b ? a * n + b : b * n + a;
    if (seen.has(k)) return;
    seen.add(k);
    bridges.push({ x1: nx[a], y1: ny[a], x2: nx[b], y2: ny[b], bridge: true });
  };
  // Does any segment at node q pass through p (the two already touch)?
  const touchesAt = (p, q) => segsAt[q].some((si) => {
    const s = segments[si];
    const x = nx[p], y = ny[p];
    if (x < Math.min(s.x1, s.x2) - 1e-6 || x > Math.max(s.x1, s.x2) + 1e-6
      || y < Math.min(s.y1, s.y2) - 1e-6 || y > Math.max(s.y1, s.y2) + 1e-6) return false;
    return distToSegment(x, y, s.x1, s.y1, s.x2, s.y2) <= 1e-6;
  });
  for (let p = 0; p < n; p++) {
    const cx = Math.floor(nx[p] / gap), cy = Math.floor(ny[p] / gap);
    // The few nearest ends within the gap (a gap is between neighbours; in
    // dense hatching or text this bounds the work per end).
    const candidates = [];
    let worst = gap;
    for (let dx = -1; dx <= 1; dx++) {
      for (let dy = -1; dy <= 1; dy++) {
        const b = pts.get(cellKey(cx + dx, cy + dy));
        if (!b) continue;
        for (const q of b) {
          if (q === p) continue;
          const ddx = nx[q] - nx[p], ddy = ny[q] - ny[p];
          if (Math.abs(ddx) > worst || Math.abs(ddy) > worst) continue;
          const d = Math.hypot(ddx, ddy);
          if (d <= 1e-6 || d > worst) continue;
          let at = candidates.length;
          while (at > 0 && candidates[at - 1][0] > d) at--;
          candidates.splice(at, 0, [d, q]);
          if (candidates.length > MAX_GAP_CANDIDATES) { candidates.pop(); worst = candidates[candidates.length - 1][0]; }
        }
      }
    }
    if (!candidates.length) continue;
    // Only the nearest end(s) the linework does not already join, so a door
    // gets one bridge across, not a cross.
    let best = Infinity;
    for (const [d, q] of candidates) {
      if (d > best * 1.01 + 1e-9) break;
      if (touchesAt(p, q) || touchesAt(q, p) || linkedWithin(p, q, d * 3)) continue;
      best = Math.min(best, d);
      pushBridge(p, q);
    }
  }
  // A free end (one segment) that points at another segment and stops short
  // of it (a T or corner drawn short): continue it onto that segment.
  const free = [];
  for (let p = 0; p < n; p++) if (deg[p] === 1) free.push(p);
  if (free.length) {
    // Small cells (half a gap); a ray's box covers only a few of them.
    const size = gap / 2;
    const segGrid = new Map();
    for (let i = 0; i < segments.length; i++) {
      const s = segments[i];
      const len = Math.hypot(s.x2 - s.x1, s.y2 - s.y1);
      const steps = Math.max(1, Math.ceil(len / (size / 2)));
      let last = null;
      for (let k = 0; k <= steps; k++) {
        const key = cellKey(Math.floor((s.x1 + (s.x2 - s.x1) * k / steps) / size), Math.floor((s.y1 + (s.y2 - s.y1) * k / steps) / size));
        if (key === last) continue;
        last = key;
        const b = segGrid.get(key);
        if (b) b.push(i); else segGrid.set(key, [i]);
      }
    }
    for (const p of free) {
      const own = segsAt[p][0];
      const o = ends[2 * own] === p ? ends[2 * own + 1] : ends[2 * own];
      const len = Math.hypot(nx[p] - nx[o], ny[p] - ny[o]) || 1;
      const ux = (nx[p] - nx[o]) / len, uy = (ny[p] - ny[o]) / len;
      // The ray's box (the end and `gap` along it): segments outside it can
      // neither touch the end nor be hit, so most are rejected cheaply.
      const ex = nx[p] + ux * gap, ey = ny[p] + uy * gap;
      const rx0 = Math.min(nx[p], ex) - 1e-6, rx1 = Math.max(nx[p], ex) + 1e-6;
      const ry0 = Math.min(ny[p], ey) - 1e-6, ry1 = Math.max(ny[p], ey) + 1e-6;
      let bestHit = Infinity;
      const seenSeg = new Set();
      for (let gx = Math.floor(rx0 / size); gx <= Math.floor(rx1 / size); gx++) {
        for (let gy = Math.floor(ry0 / size); gy <= Math.floor(ry1 / size); gy++) {
          const b = segGrid.get(cellKey(gx, gy));
          if (!b) continue;
          for (const j of b) {
            if (j === own) continue;
            const t = segments[j];
            if ((t.x1 < rx0 && t.x2 < rx0) || (t.x1 > rx1 && t.x2 > rx1)
              || (t.y1 < ry0 && t.y2 < ry0) || (t.y1 > ry1 && t.y2 > ry1)) continue;
            if (seenSeg.has(j)) continue;
            seenSeg.add(j);
            if (distToSegment(nx[p], ny[p], t.x1, t.y1, t.x2, t.y2) <= 1e-6) { bestHit = -1; break; }
            const hit = rayHit(nx[p], ny[p], ux, uy, t);
            if (hit != null && hit > 1e-6 && hit <= gap && hit < bestHit) bestHit = hit;
          }
          if (bestHit < 0) break;
        }
        if (bestHit < 0) break;
      }
      if (bestHit > 0 && bestHit !== Infinity) {
        bridges.push({ x1: nx[p], y1: ny[p], x2: nx[p] + ux * bestHit, y2: ny[p] + uy * bestHit, bridge: true });
      }
    }
  }
  return bridges;
}

/** A small binary min-heap of [priority, value] pairs. */
class MinHeap {
  constructor() { this.a = []; }
  get size() { return this.a.length; }
  push(p, v) {
    const a = this.a;
    a.push([p, v]);
    let i = a.length - 1;
    while (i > 0) {
      const j = (i - 1) >> 1;
      if (a[j][0] <= a[i][0]) break;
      [a[i], a[j]] = [a[j], a[i]];
      i = j;
    }
  }
  pop() {
    const a = this.a;
    const top = a[0];
    const last = a.pop();
    if (a.length) {
      a[0] = last;
      let i = 0;
      for (;;) {
        const l = 2 * i + 1, r = l + 1;
        let m = i;
        if (l < a.length && a[l][0] < a[m][0]) m = l;
        if (r < a.length && a[r][0] < a[m][0]) m = r;
        if (m === i) break;
        [a[i], a[m]] = [a[m], a[i]];
        i = m;
      }
    }
    return top;
  }
}

// Distance along the ray (px,py)+t(ux,uy) to segment s, or null.
function rayHit(px, py, ux, uy, s) {
  const qx = s.x2 - s.x1, qy = s.y2 - s.y1;
  const den = ux * qy - uy * qx;
  if (Math.abs(den) < 1e-9) return null;
  const t = ((s.x1 - px) * qy - (s.y1 - py) * qx) / den;
  const v = ((s.x1 - px) * uy - (s.y1 - py) * ux) / den;
  return v >= 0 && v <= 1 && t > 0 ? t : null;
}

export function distToSegment(px, py, x1, y1, x2, y2) {
  const dx = x2 - x1, dy = y2 - y1;
  const len2 = dx * dx + dy * dy;
  let t = len2 > 0 ? ((px - x1) * dx + (py - y1) * dy) / len2 : 0;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(px - (x1 + t * dx), py - (y1 + t * dy));
}

// Bridges for a page's linework, per gap (and boundary lines): built once,
// then each fill takes the ones in its window.
const bridgeCache = new WeakMap();
function cachedBridges(segments, extra, gap) {
  if (!(gap > 0)) return [];
  const sig = `${gap}|${extra.length}|${extra.map((e) => `${e.x1},${e.y1},${e.x2},${e.y2}`).join(';')}`;
  let perPage = bridgeCache.get(segments);
  if (!perPage) bridgeCache.set(segments, perPage = new Map());
  let b = perPage.get(sig);
  if (!b) {
    if (perPage.size > 8) perPage.clear();
    b = gapBridges(extra.length ? segments.concat(extra) : segments, gap);
    perPage.set(sig, b);
  }
  return b;
}

// ─── 2-4. Grid, flood and stray-line absorption ─────────────────────────

/** Clip segment to the box (Liang-Barsky); null when it misses. */
function clipSegment(s, box) {
  let t0 = 0, t1 = 1;
  const dx = s.x2 - s.x1, dy = s.y2 - s.y1;
  const p = [-dx, dx, -dy, dy];
  const q = [s.x1 - box.minX, box.maxX - s.x1, s.y1 - box.minY, box.maxY - s.y1];
  for (let i = 0; i < 4; i++) {
    if (p[i] === 0) {
      if (q[i] < 0) return null;
    } else {
      const r = q[i] / p[i];
      if (p[i] < 0) { if (r > t1) return null; if (r > t0) t0 = r; }
      else { if (r < t0) return null; if (r < t1) t1 = r; }
    }
  }
  return { x1: s.x1 + t0 * dx, y1: s.y1 + t0 * dy, x2: s.x1 + t1 * dx, y2: s.y1 + t1 * dy };
}

/**
 * Occupancy grid of the segments inside `win`: 1 = linework. Samples every
 * half cell, so consecutive marked cells are 8-neighbours and a 4-connected
 * flood cannot slip through a drawn line.
 */
export function rasterizeSegments(segments, win, cell, W, H) {
  const grid = new Uint8Array(W * H);
  const box = { minX: win.minX - cell, minY: win.minY - cell, maxX: win.maxX + cell, maxY: win.maxY + cell };
  const step = cell * 0.5;
  for (const seg of segments) {
    const s = clipSegment(seg, box);
    if (!s) continue;
    const len = Math.hypot(s.x2 - s.x1, s.y2 - s.y1);
    const n = Math.max(1, Math.ceil(len / step));
    for (let k = 0; k <= n; k++) {
      const x = s.x1 + (s.x2 - s.x1) * k / n;
      const y = s.y1 + (s.y2 - s.y1) * k / n;
      const ix = Math.floor((x - win.minX) / cell);
      const iy = Math.floor((y - win.minY) / cell);
      if (ix >= 0 && iy >= 0 && ix < W && iy < H) grid[iy * W + ix] = 1;
    }
  }
  return grid;
}

const FILLED = 2;

/** 4-connected flood from (sx, sy) over free cells; returns touched sides. */
function flood(grid, W, H, sx, sy) {
  const queue = new Int32Array(W * H);
  let head = 0, tail = 0;
  const start = sy * W + sx;
  grid[start] = FILLED;
  queue[tail++] = start;
  const touched = { left: false, right: false, top: false, bottom: false };
  let count = 0;
  while (head < tail) {
    const c = queue[head++];
    count++;
    const x = c % W, y = (c - x) / W;
    if (x === 0) touched.left = true;
    if (x === W - 1) touched.right = true;
    if (y === 0) touched.top = true;
    if (y === H - 1) touched.bottom = true;
    if (x > 0 && grid[c - 1] === 0) { grid[c - 1] = FILLED; queue[tail++] = c - 1; }
    if (x < W - 1 && grid[c + 1] === 0) { grid[c + 1] = FILLED; queue[tail++] = c + 1; }
    if (y > 0 && grid[c - W] === 0) { grid[c - W] = FILLED; queue[tail++] = c - W; }
    if (y < H - 1 && grid[c + W] === 0) { grid[c + W] = FILLED; queue[tail++] = c + W; }
  }
  return { touched, count };
}

/**
 * Linework cells with fill on both sides within `reach` cells (left and
 * right, or above and below) join the fill: a dimension line or a dangling
 * stub inside the room is not a boundary. Walls (fill on one side) stay.
 */
function absorbThinLines(grid, W, H, reach = 3, passes = 2) {
  for (let pass = 0; pass < passes; pass++) {
    const join = [];
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        const c = y * W + x;
        if (grid[c] !== 1) continue;
        if ((filledWithin(grid, W, H, x, y, -1, 0, reach) && filledWithin(grid, W, H, x, y, 1, 0, reach))
          || (filledWithin(grid, W, H, x, y, 0, -1, reach) && filledWithin(grid, W, H, x, y, 0, 1, reach))) {
          join.push(c);
        }
      }
    }
    if (!join.length) break;
    for (const c of join) grid[c] = FILLED;
  }
}

function filledWithin(grid, W, H, x, y, dx, dy, reach) {
  for (let k = 1; k <= reach; k++) {
    const nx = x + dx * k, ny = y + dy * k;
    if (nx < 0 || ny < 0 || nx >= W || ny >= H) return false;
    const v = grid[ny * W + nx];
    if (v === FILLED) return true;
    if (v !== 1) return false; // an unfilled free cell: the other side is not this fill
  }
  return false;
}

// ─── 5. Contours ────────────────────────────────────────────────────────

/**
 * Boundary loops of the cells equal to `value` (FILLED by default), in grid
 * vertex coordinates. The filled side is on the right of travel (y down), so
 * an outer ring runs clockwise on screen and an island the other way. Only
 * direction changes are kept as vertices.
 */
export function traceContours(grid, W, H, value = FILLED) {
  const VW = W + 1;
  const out = new Uint8Array(VW * (H + 1)); // bit d: an outgoing edge in direction d
  const at = (x, y) => (x >= 0 && y >= 0 && x < W && y < H && grid[y * W + x] === value);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      if (grid[y * W + x] !== value) continue;
      if (!at(x, y - 1)) out[y * VW + x] |= 1 << 0;            // top: (x,y) → E
      if (!at(x + 1, y)) out[y * VW + x + 1] |= 1 << 1;        // right: (x+1,y) → S
      if (!at(x, y + 1)) out[(y + 1) * VW + x + 1] |= 1 << 2;  // bottom: (x+1,y+1) → W
      if (!at(x - 1, y)) out[(y + 1) * VW + x] |= 1 << 3;      // left: (x,y+1) → N
    }
  }
  const loops = [];
  for (let v = 0; v < out.length; v++) {
    while (out[v]) {
      let d = 0;
      while (!(out[v] & (1 << d))) d++;
      const loop = [];
      let vx = v % VW, vy = (v - vx) / VW;
      let cur = v, dir = d, prevDir = -1;
      for (let guard = 0; guard < out.length * 4; guard++) {
        out[cur] &= ~(1 << dir);
        if (dir !== prevDir) loop.push({ x: vx, y: vy });
        prevDir = dir;
        vx += DIRS[dir][0]; vy += DIRS[dir][1];
        cur = vy * VW + vx;
        // Right turn first (keeps diagonal-touching cells apart), then
        // straight, then left. Back at the start, the start edge (already
        // cleared) still counts, so a saddle start closes this loop.
        const bits = cur === v ? (out[cur] | (1 << d)) : out[cur];
        const options = [(dir + 1) % 4, dir, (dir + 3) % 4];
        let next = -1;
        for (const o of options) if (bits & (1 << o)) { next = o; break; }
        if (next < 0 || (cur === v && next === d)) break;
        dir = next;
      }
      // The start vertex is a direction change only if the closing edge turns.
      if (loop.length > 1 && prevDir === d) loop.shift();
      if (loop.length >= 3) loops.push(loop);
    }
  }
  return loops;
}

/** Signed shoelace area (y down: clockwise on screen is positive). */
export function signedArea(ring) {
  let s = 0;
  for (let i = 0, n = ring.length; i < n; i++) {
    const a = ring[i], b = ring[(i + 1) % n];
    s += a.x * b.y - b.x * a.y;
  }
  return s / 2;
}

// ─── Simplification ─────────────────────────────────────────────────────

function dpOpen(pts, tol) {
  if (pts.length <= 2) return pts.slice();
  const keep = new Uint8Array(pts.length);
  keep[0] = keep[pts.length - 1] = 1;
  const stack = [[0, pts.length - 1]];
  while (stack.length) {
    const [a, b] = stack.pop();
    let best = -1, bestD = tol;
    for (let i = a + 1; i < b; i++) {
      const d = distToSegment(pts[i].x, pts[i].y, pts[a].x, pts[a].y, pts[b].x, pts[b].y);
      if (d > bestD) { bestD = d; best = i; }
    }
    if (best >= 0) {
      keep[best] = 1;
      stack.push([a, best], [best, b]);
    }
  }
  return pts.filter((_, i) => keep[i]);
}

/**
 * Douglas-Peucker for a closed ring (no repeated closing point). The ring is
 * split at the vertex farthest from the centroid (a true corner) and the
 * vertex farthest from that one.
 */
export function simplifyClosed(ring, tol) {
  const n = ring.length;
  if (n <= 3) return ring.slice();
  let cx = 0, cy = 0;
  for (const p of ring) { cx += p.x; cy += p.y; }
  cx /= n; cy /= n;
  let a = 0, best = -1;
  for (let i = 0; i < n; i++) {
    const d = Math.hypot(ring[i].x - cx, ring[i].y - cy);
    if (d > best) { best = d; a = i; }
  }
  const rot = ring.slice(a).concat(ring.slice(0, a));
  let b = 1;
  best = -1;
  for (let i = 1; i < n; i++) {
    const d = Math.hypot(rot[i].x - rot[0].x, rot[i].y - rot[0].y);
    if (d > best) { best = d; b = i; }
  }
  const first = dpOpen(rot.slice(0, b + 1), tol);
  const second = dpOpen(rot.slice(b).concat([rot[0]]), tol);
  return first.concat(second.slice(1, -1));
}

/**
 * Drop repeated vertices, spikes (a → b → a) and collinear vertices. `eps`
 * is a distance in page points.
 */
export function cleanRing(ring, eps = 1e-6) {
  let pts = ring.slice();
  let changed = true;
  while (changed && pts.length >= 3) {
    changed = false;
    const next = [];
    for (let i = 0; i < pts.length; i++) {
      const p = pts[i];
      const q = next.length ? next[next.length - 1] : pts[pts.length - 1];
      if (Math.hypot(p.x - q.x, p.y - q.y) <= eps) { changed = true; continue; }
      next.push(p);
    }
    pts = next;
    if (pts.length < 3) break;
    const kept = [];
    for (let i = 0; i < pts.length; i++) {
      const a = pts[(i + pts.length - 1) % pts.length], p = pts[i], b = pts[(i + 1) % pts.length];
      // Distance of p from the line a-b; a spike (a == b) is also dropped.
      const ab = Math.hypot(b.x - a.x, b.y - a.y);
      const dev = ab > eps
        ? Math.abs((b.x - a.x) * (a.y - p.y) - (a.x - p.x) * (b.y - a.y)) / ab
        : 0;
      const ap = (p.x - a.x) * (b.x - a.x) + (p.y - a.y) * (b.y - a.y);
      const between = ab > eps && ap >= -eps && ap <= ab * ab + eps;
      if (dev <= eps && (between || ab <= eps)) { changed = true; continue; }
      kept.push(p);
    }
    pts = kept;
  }
  return pts.length >= 3 ? pts : [];
}

// ─── Snapping back onto the linework ────────────────────────────────────

/**
 * A uniform grid over the segments for "which segments are near (x, y)":
 * returns a lookup giving the indices in the 3 x 3 cells around a point (a
 * segment within `size` of it may sit in a neighbouring cell). Build it once
 * per fill and share it between rings: on a dense sheet this is the costly
 * part, not the lookups.
 */
export function segmentIndex(segments, size) {
  const grid = new Map();
  const key = (cx, cy) => cx * 1048576 + cy;
  const put = (cx, cy, i) => {
    const k = key(cx, cy);
    const b = grid.get(k);
    if (b) { if (b[b.length - 1] !== i) b.push(i); } else grid.set(k, [i]);
  };
  for (let i = 0; i < segments.length; i++) {
    const s = segments[i];
    const x0 = Math.floor(Math.min(s.x1, s.x2) / size), x1 = Math.floor(Math.max(s.x1, s.x2) / size);
    const y0 = Math.floor(Math.min(s.y1, s.y2) / size), y1 = Math.floor(Math.max(s.y1, s.y2) / size);
    if ((x1 - x0 + 1) * (y1 - y0 + 1) > 64) {
      // Long diagonal: walk it instead of filling its whole box.
      const len = Math.hypot(s.x2 - s.x1, s.y2 - s.y1);
      const n = Math.max(1, Math.ceil(len / (size * 0.5)));
      for (let k = 0; k <= n; k++) {
        put(Math.floor((s.x1 + (s.x2 - s.x1) * k / n) / size), Math.floor((s.y1 + (s.y2 - s.y1) * k / n) / size), i);
      }
      continue;
    }
    for (let cx = x0; cx <= x1; cx++) for (let cy = y0; cy <= y1; cy++) put(cx, cy, i);
  }
  return (x, y) => {
    const cx = Math.floor(x / size), cy = Math.floor(y / size);
    const out = new Set();
    for (let dx = -1; dx <= 1; dx++) {
      for (let dy = -1; dy <= 1; dy++) {
        const b = grid.get(key(cx + dx, cy + dy));
        if (b) for (const i of b) out.add(i);
      }
    }
    return [...out];
  };
}

function lineIntersection(s, t) {
  const rx = s.x2 - s.x1, ry = s.y2 - s.y1;
  const qx = t.x2 - t.x1, qy = t.y2 - t.y1;
  const den = rx * qy - ry * qx;
  const lr = Math.hypot(rx, ry), lq = Math.hypot(qx, qy);
  if (Math.abs(den) <= 1e-9 * lr * lq) return null; // parallel
  const u = ((t.x1 - s.x1) * qy - (t.y1 - s.y1) * qx) / den;
  const v = ((t.x1 - s.x1) * ry - (t.y1 - s.y1) * rx) / den;
  return { x: s.x1 + u * rx, y: s.y1 + u * ry, u, v, lr, lq };
}

/**
 * Move each vertex onto the linework within `radius`: the nearest segment
 * intersection or endpoint, else the foot on the nearest segment.
 */
export function snapRing(ring, segments, radius, index = null) {
  if (!segments.length) return ring.slice();
  const near = index || segmentIndex(segments, Math.max(radius, 1));
  return ring.map((p) => {
    // Drawn lines first: a gap bridge only gives a corner when no drawn
    // corner is near (bridges cross each other near columns and jambs).
    const ids = near(p.x, p.y).filter((i) => {
      const s = segments[i];
      return distToSegment(p.x, p.y, s.x1, s.y1, s.x2, s.y2) <= radius;
    }).sort((a, b) => (segments[a].bridge ? 1 : 0) - (segments[b].bridge ? 1 : 0)).slice(0, 48);
    if (!ids.length) return p;
    // Tier 0: corners of drawn lines; tier 1: corners that use a bridge.
    const best = [null, null], bestD = [radius, radius];
    const consider = (x, y, tier) => {
      const d = Math.hypot(x - p.x, y - p.y);
      if (d <= bestD[tier]) { bestD[tier] = d; best[tier] = { x, y }; }
    };
    for (let a = 0; a < ids.length; a++) {
      const s = segments[ids[a]];
      const ts = s.bridge ? 1 : 0;
      consider(s.x1, s.y1, ts);
      consider(s.x2, s.y2, ts);
      for (let b = a + 1; b < ids.length; b++) {
        const t = segments[ids[b]];
        const hit = lineIntersection(s, t);
        if (!hit) continue;
        // Within each segment, extended by the snap radius (lines that stop
        // just short of the corner still meet there).
        const slackS = radius / hit.lr, slackT = radius / hit.lq;
        if (hit.u < -slackS || hit.u > 1 + slackS || hit.v < -slackT || hit.v > 1 + slackT) continue;
        consider(hit.x, hit.y, ts || (t.bridge ? 1 : 0));
      }
    }
    if (best[0]) return best[0];
    if (best[1]) return best[1];
    // No corner nearby: the foot on the nearest segment.
    let foot = p, footD = Infinity;
    for (const i of ids) {
      const s = segments[i];
      const dx = s.x2 - s.x1, dy = s.y2 - s.y1;
      const len2 = dx * dx + dy * dy;
      if (len2 < 1e-12) continue;
      const t = Math.max(0, Math.min(1, ((p.x - s.x1) * dx + (p.y - s.y1) * dy) / len2));
      const x = s.x1 + t * dx, y = s.y1 + t * dy;
      const d = Math.hypot(x - p.x, y - p.y);
      if (d < footD) { footD = d; foot = { x, y }; }
    }
    return foot;
  });
}

// ─── Region lookup ──────────────────────────────────────────────────────

/** Is (x, y) inside the region (even-odd over its outer ring and holes)? */
export function regionContains(region, x, y) {
  if (!region?.outer) return false;
  let inside = false;
  for (const ring of [region.outer, ...(region.holes || [])]) {
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const a = ring[i], b = ring[j];
      if ((a.y > y) !== (b.y > y) && x < ((b.x - a.x) * (y - a.y)) / (b.y - a.y) + a.x) inside = !inside;
    }
  }
  return inside;
}

/** Net area of a region in square page points. */
export function regionArea(region) {
  if (!region?.outer) return 0;
  let a = Math.abs(signedArea(region.outer));
  for (const h of region.holes || []) a -= Math.abs(signedArea(h));
  return a;
}

/**
 * The closed region of `segments` that contains `seed`.
 *
 * options: gap (page points), boundaries (extra segments, e.g. temporary
 * boundary lines), minCell, maxCells, initialHalf.
 *
 * Only the linework near the click is drawn into the grid: each attempt
 * takes the segments (and gap bridges) overlapping its window, so the cost
 * follows the room, not the sheet. Gap bridges are made once per page and
 * gap (cached on the segments array) and reused by the next clicks.
 *
 * Returns { status: 'ok', outer, holes, area, cell } with outer clockwise on
 * screen (y down) and holes the other way; or { status } with
 * 'empty' (no linework), 'boundary' (the click is on a line) or 'open' (the
 * fill escapes all linework: no closed region holds the click; `escape(x, y)`
 * then tells whether another point is in that same open fill).
 */
export function findFillRegion(segments, seed, options = {}) {
  const opts = { ...DEFAULTS, ...options };
  const extra = opts.boundaries || [];
  const base = extra.length ? segments.concat(extra) : segments;
  if (!base.length) return { status: 'empty' };
  const bounds = segmentBounds(base);
  const pageBridges = cachedBridges(segments, extra, opts.gap);
  if (!bounds || seed.x <= bounds.minX || seed.x >= bounds.maxX || seed.y <= bounds.minY || seed.y >= bounds.maxY) {
    return { status: 'open' };
  }

  let half = opts.initialHalf;
  for (let attempt = 0; attempt < 12; attempt++) {
    const win = {
      minX: Math.max(bounds.minX, seed.x - half), maxX: Math.min(bounds.maxX, seed.x + half),
      minY: Math.max(bounds.minY, seed.y - half), maxY: Math.min(bounds.maxY, seed.y + half),
    };
    const atBound = {
      left: win.minX <= bounds.minX, right: win.maxX >= bounds.maxX,
      top: win.minY <= bounds.minY, bottom: win.maxY >= bounds.maxY,
    };
    // A ring of free cells outside the linework so "reached the edge of all
    // linework" is visible as touching the grid border.
    const w0 = win.maxX - win.minX, h0 = win.maxY - win.minY;
    const cell = Math.max(opts.minCell, Math.sqrt((w0 * h0) / opts.maxCells));
    const pad = cell * 2;
    const grid0 = { minX: win.minX - pad, minY: win.minY - pad, maxX: win.maxX + pad, maxY: win.maxY + pad };
    const W = Math.max(3, Math.ceil((grid0.maxX - grid0.minX) / cell));
    const H = Math.max(3, Math.ceil((grid0.maxY - grid0.minY) / cell));
    // The linework of this window (and a gap's width around it), bridged.
    const reach = (opts.gap > 0 ? opts.gap : 0) + pad * 2;
    const inWin = (sg) => Math.max(sg.x1, sg.x2) >= grid0.minX - reach && Math.min(sg.x1, sg.x2) <= grid0.maxX + reach
      && Math.max(sg.y1, sg.y2) >= grid0.minY - reach && Math.min(sg.y1, sg.y2) <= grid0.maxY + reach;
    const local = base.filter(inWin);
    const bridges = pageBridges.length ? pageBridges.filter(inWin) : [];
    const all = bridges.length ? local.concat(bridges) : local;
    const grid = rasterizeSegments(all, grid0, cell, W, H);
    const sx = Math.floor((seed.x - grid0.minX) / cell);
    const sy = Math.floor((seed.y - grid0.minY) / cell);
    if (grid[sy * W + sx] === 1) return { status: 'boundary' };
    const { touched } = flood(grid, W, H, sx, sy);
    const escaped = Object.keys(touched).filter((side) => touched[side]);
    if (escaped.length) {
      if (escaped.some((side) => atBound[side])) return { status: 'open', escape: escapeTest(grid, W, H, grid0, cell) };
      half *= opts.growth;
      continue;
    }
    absorbThinLines(grid, W, H);
    return ringsFromGrid(grid, W, H, grid0, cell, all, opts);
  }
  return { status: 'open' };
}

// For an 'open' result: is (x, y) in the same escaped fill? Then filling
// there is open too (drag-to-paint skips it without another flood).
function escapeTest(grid, W, H, origin, cell) {
  return (x, y) => {
    const ix = Math.floor((x - origin.minX) / cell), iy = Math.floor((y - origin.minY) / cell);
    return ix >= 0 && iy >= 0 && ix < W && iy < H && grid[iy * W + ix] === FILLED;
  };
}

function ringsFromGrid(grid, W, H, origin, cell, segments, opts) {
  const loops = traceContours(grid, W, H).map((loop) => loop.map((p) => ({
    x: origin.minX + p.x * cell, y: origin.minY + p.y * cell,
  })));
  if (!loops.length) return { status: 'open' };
  const areas = loops.map(signedArea);
  let outerIdx = 0;
  for (let i = 1; i < loops.length; i++) if (Math.abs(areas[i]) > Math.abs(areas[outerIdx])) outerIdx = i;
  const minRing = opts.minHoleArea ?? Math.max(9 * cell * cell, 2);
  const snapR = cell * 4;
  // One index for every ring of this fill (coarse cells: few per segment).
  const index = segmentIndex(segments, Math.max(snapR * 8, 4));
  const finish = (loop) => {
    const simple = simplifyClosed(loop, cell * 0.9);
    return cleanRing(snapRing(simple, segments, snapR, index), Math.max(1e-6, cell * 1e-3));
  };
  const outer = finish(loops[outerIdx]);
  if (outer.length < 3) return { status: 'open' };
  const holes = [];
  for (let i = 0; i < loops.length; i++) {
    if (i === outerIdx || Math.abs(areas[i]) < minRing) continue;
    const ring = finish(loops[i]);
    if (ring.length >= 3 && Math.abs(signedArea(ring)) >= minRing) holes.push(ring);
  }
  const region = { status: 'ok', outer, holes, cell };
  region.area = regionArea(region);
  return region;
}

/**
 * The output rings for one or more regions in the measureArea/filledArea
 * model: the first region's outer ring as `points`, every other ring in
 * `holes` (vlak-ringen.js classifies them by nesting: islands subtract,
 * separate regions add).
 */
export function regionsToRings(regions) {
  const ok = (regions || []).filter((r) => r?.outer?.length >= 3);
  if (!ok.length) return null;
  const [first, ...rest] = ok;
  const holes = [...first.holes];
  for (const r of rest) holes.push(r.outer, ...r.holes);
  return { points: first.outer, holes };
}

/** A closed polyline for Perimeter/Polylength: the ring plus its first point. */
export function closedPath(ring) {
  return ring.length ? [...ring, { ...ring[0] }] : [];
}

// ─── Encircling ─────────────────────────────────────────────────────────

/** Is (x, y) inside the closed polygon `ring` (even-odd)? */
export function pointInRing(ring, x, y) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const a = ring[i], b = ring[j];
    if ((a.y > y) !== (b.y > y) && x < ((b.x - a.x) * (y - a.y)) / (b.y - a.y) + a.x) inside = !inside;
  }
  return inside;
}

/**
 * Is a drag path a closed loop (the external editor: encircling)? Its end must come back
 * within `closeTol` of its start, and it must enclose more than a sliver.
 * Returns the loop (without the closing point) or null.
 */
export function encirclingLoop(path, closeTol) {
  if (!path || path.length < 8) return null;
  const a = path[0], b = path[path.length - 1];
  if (Math.hypot(b.x - a.x, b.y - a.y) > closeTol) return null;
  let length = 0;
  for (let i = 1; i < path.length; i++) length += Math.hypot(path[i].x - path[i - 1].x, path[i].y - path[i - 1].y);
  if (length < closeTol * 6) return null;
  const area = Math.abs(signedArea(path));
  if (area < (closeTol * 2) ** 2) return null;
  return path.slice();
}

/**
 * Seed points on a grid inside `loop` for encircling: about `perSide` per
 * bounding-box side, no closer than `minStep`, at most `max`, and none
 * within `clearance` of a segment (those would land on a line).
 */
export function seedsInLoop(loop, segments, { perSide = 64, minStep = 2, max = 6000, clearance = 0.75 } = {}) {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const p of loop) {
    if (p.x < minX) minX = p.x; if (p.x > maxX) maxX = p.x;
    if (p.y < minY) minY = p.y; if (p.y > maxY) maxY = p.y;
  }
  let step = Math.max(minStep, Math.max(maxX - minX, maxY - minY) / perSide);
  while (((maxX - minX) / step) * ((maxY - minY) / step) > max) step *= 1.25;
  const near = segments.length ? segmentIndex(segments, Math.max(clearance * 4, 1)) : () => [];
  const seeds = [];
  for (let y = minY + step / 2; y < maxY; y += step) {
    for (let x = minX + step / 2; x < maxX; x += step) {
      if (!pointInRing(loop, x, y)) continue;
      const onLine = near(x, y).some((i) => {
        const s = segments[i];
        return distToSegment(x, y, s.x1, s.y1, s.x2, s.y2) <= clearance;
      });
      if (!onLine) seeds.push({ x, y });
    }
  }
  return seeds;
}

/** Does `region` lie inside `loop` (every vertex of its outer ring)? */
export function regionInsideLoop(region, loop) {
  return region.outer.every((p) => pointInRing(loop, p.x, p.y));
}

// ─── Line weight (the external editor: Edge Sensitivity) ───────────────────────────────

/**
 * The segments that bound a fill. Unpainted paths (paint 'n': clip paths and
 * other invisible geometry) never do. With `minWeight` > 0, stroked-only
 * lines thinner than that (page points; hatching, dimension and detail lines)
 * are ignored too. Filled shapes, and segments without paint information
 * (older caches, boundary lines), always bound.
 */
export function boundarySegments(segments, minWeight = 0) {
  const min = Number(minWeight) > 0 ? Number(minWeight) : 0;
  return segments.filter((s) => {
    if (s.paint === 'n') return false;
    if (min > 0 && s.paint === 's' && Number.isFinite(s.w) && s.w < min) return false;
    return true;
  });
}

/**
 * Encircling: the closed regions lying wholly inside `loop` that are not
 * already in `existing` (points of those are skipped). Seeds come from
 * seedsInLoop; a region the loop cuts and an open flood are each flooded
 * once. `opts` as for findFillRegion.
 */
export function regionsInsideLoop(segments, loop, existing = [], opts = {}) {
  const extra = opts.boundaries || [];
  const all = extra.length ? segments.concat(extra) : segments;
  const skip = [];
  const escapes = [];
  const added = [];
  for (const seed of seedsInLoop(loop, all)) {
    if (existing.some((r) => regionContains(r, seed.x, seed.y))) continue;
    if (added.some((r) => regionContains(r, seed.x, seed.y))) continue;
    if (skip.some((r) => regionContains(r, seed.x, seed.y))) continue;
    if (escapes.some((test) => test(seed.x, seed.y))) continue;
    const r = findFillRegion(segments, seed, opts);
    if (r.status === 'open') { if (r.escape) escapes.push(r.escape); continue; }
    if (r.status !== 'ok') continue;
    if (regionInsideLoop(r, loop)) added.push(r); else skip.push(r);
  }
  return added;
}
