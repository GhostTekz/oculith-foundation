// Read a PDF outline (pdf.js getOutline) into the app's flat bookmark list.
//
// The tree is walked first, so ids and order are exactly as a depth-first
// read gives them; the destinations are then resolved with a few lookups in
// flight at once and each named destination and page reference only once.
// Resolving them one after another in the walk cost a pdf.js worker round
// trip per bookmark (hundreds of ms on a set with a large outline).

const RESOLVE_CONCURRENCY = 16;

function rgbArrayToHex(arr) {
  if (!arr || arr.length < 3) return null;
  const r = Math.round(arr[0] * 255);
  const g = Math.round(arr[1] * 255);
  const b = Math.round(arr[2] * 255);
  return '#' + [r, g, b].map(c => c.toString(16).padStart(2, '0')).join('');
}

async function eachLimited(items, limit, fn) {
  let next = 0;
  const run = async () => {
    while (next < items.length) {
      const i = next++;
      await fn(items[i]);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, run));
}

function refKey(ref) {
  if (ref && typeof ref === 'object' && Number.isInteger(ref.num)) return `${ref.num}R${ref.gen ?? 0}`;
  return null;
}

/** The outline of `pdfDoc` as bookmark records ([] without one). */
export async function loadBookmarksFromPdf(pdfDoc) {
  if (!pdfDoc) return [];
  try {
    const outline = await pdfDoc.getOutline();
    if (!outline || outline.length === 0) return [];
    const bookmarks = [];
    const pending = []; // [bookmark, dest]
    let nextId = 1;
    const walk = (items, parentId) => {
      for (let i = 0; i < items.length; i++) {
        const item = items[i];
        const bm = {
          id: 'bm_' + (nextId++),
          title: item.title || 'Untitled',
          page: 1,
          top: null,
          left: null,
          zoom: null,
          parentId,
          expanded: true,
          bold: !!(item.bold),
          italic: !!(item.italic),
          color: item.color ? rgbArrayToHex(item.color) : null,
          sortOrder: i,
          fromPdf: true,
        };
        bookmarks.push(bm);
        if (item.dest) pending.push([bm, item.dest]);
        if (item.items && item.items.length > 0) walk(item.items, bm.id);
      }
    };
    walk(outline, null);

    const named = new Map(); // name -> Promise<dest>
    const pages = new Map(); // ref key -> Promise<pageIndex>
    const destination = (name) => {
      if (!named.has(name)) named.set(name, pdfDoc.getDestination(name));
      return named.get(name);
    };
    const pageIndex = (ref) => {
      const key = refKey(ref);
      if (!key) return pdfDoc.getPageIndex(ref);
      if (!pages.has(key)) pages.set(key, pdfDoc.getPageIndex(ref));
      return pages.get(key);
    };
    await eachLimited(pending, RESOLVE_CONCURRENCY, async ([bm, rawDest]) => {
      try {
        const dest = typeof rawDest === 'string' ? await destination(rawDest) : rawDest;
        if (dest && Array.isArray(dest)) {
          bm.page = (await pageIndex(dest[0])) + 1;
          if (dest.length > 2) bm.left = dest[2];
          if (dest.length > 3) bm.top = dest[3];
        }
      } catch {
        // Failed to resolve dest - use page 1
      }
    });
    return bookmarks;
  } catch (e) {
    console.warn('Failed to load bookmarks:', e);
    return [];
  }
}
