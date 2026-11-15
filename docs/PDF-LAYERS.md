# PDF layers: viewing and output routes

Many CAD-exported PDFs carry their drawing layers as optional content groups
(OCGs): architectural background, electrical, mechanical, text, and so on. The
**PDF layers** section of the Layers panel (Alt+Y) switches them on and off,
so you can, for example, hide the architectural background and look at the
electrical layers on their own.

PDF layers are separate from [markup layers](GUIDE.md#markup-layers) (your own
markups) and from drawing-set history.

## What you can do

- **Eye** next to a layer: show or hide it. An eye next to a group heading
  switches every layer in the group.
- **Show only this layer** (the target button that appears on hover): hide
  every other drawing layer.
- **Show all** and **Hide all** in the section toolbar. With a name filter,
  they act on the matching layers only.
- **Filter layers**: type part of a layer name to narrow the list.
- **Reset to the PDF's default layers**: back to the visibility the PDF itself
  sets.
- **Save layer visibility as the PDF default**: writes the current view into
  the PDF (its default optional-content configuration, `/OCProperties /D` with
  `/ON` and `/OFF`) and saves the document, after you confirm. Other PDF
  readers then open the drawing with these layers. Locked layers and layers in
  choice (radio-button) groups are not changed; the save stops with a message
  instead.

The layers you show or hide are a **view**, not a change to the drawing. The
app remembers the view per document (by file path) and restores it when you
open the document again, as long as each layer still has the same reference
and name. An ordinary Save or Save As keeps the PDF's own layer configuration
and all layer content unchanged.

While the view differs from the PDF default, a note under the list says so.

## Output routes

Every route below either uses the view, refuses with a choice, or does not
depend on it by design.

| Route | With a changed view | Notes |
| --- | --- | --- |
| Display: single page, continuous, zoomed detail tiles | Uses the view | PDFium renders a temporary in-memory copy with the selected layers; PDF.js receives the same optional-content configuration. The source file is never rewritten. |
| Thumbnails, including the detached Pages window | Uses the view | Thumbnails are invalidated on every change; the detached window shows the same images. |
| Print | Uses the view | Pages print as images while the view differs; with the default view, vector printing is used as before. |
| Print to PDF | Uses the view | Raster, as print. |
| Export as images | Uses the view | |
| Export as raster PDF | Uses the view | |
| Screenshot / snapshot | Uses the view | |
| Snapping, measuring and Dynamic Fill (PDF vector geometry) | Uses the view | Hidden layers give no snap points or edges. Marked content inside a hidden layer (also nested, and optional-content membership dictionaries) is skipped. |
| Visual search | Uses the view | Searches the page as it is shown. |
| Save, Save As | Not affected | Saves the PDF with its own default layer configuration and all layer content. The view is kept by the app. |
| Save layer visibility as the PDF default | Writes the view | Only on that explicit command. |
| Flatten markups | Not affected | Burns markups into the page; the drawing's layers stay as they are. |
| Text search, text selection, copy text | Not affected | Text on hidden layers is still found and selectable. |
| Vector snippet, region Cut/Copy | Not affected | The page's vector content is copied as it is in the file, whatever layers the view shows. |
| Compare and overlay | Not affected | Compares both revisions with the PDF's default layer visibility. |
| Office export (ODT, XLSX) | Not affected | Uses all text on the page. |
| Batch split and other batch operations | Not affected | They read files from disk, not the open view. |
| Extract Pages | Refuses | The copy is vector PDF with every layer at its default visibility. Choose **Reset layers and continue**, **Export as raster** (a raster PDF of those pages as shown; not offered when the pages are also deleted from the source), or Cancel. |
| PDF/X export | Refuses | Vector output with the default visibility. Choose **Reset layers and continue**, **Export as raster**, or Cancel. |
| CAD export (DXF/DWG) | Refuses | The converter reads the vector content with the default visibility. Choose **Reset layers and continue** or Cancel. The automation command returns an error. |

## Limitations

- Text search and selection still include text on hidden layers.
- Compare uses the PDF's default visibility for both revisions.
- Vector output that leaves hidden layers out (vector Save As a filtered copy,
  vector PDF/X, CAD export of selected layers) is not available yet.
- PDFium applies the view through a temporary in-memory copy that supports
  ordinary catalog layers with a direct `/OCProperties` and a direct default
  configuration. For an encrypted PDF, or one with an indirect
  `/OCProperties` or default configuration, alternate configurations,
  auto-state rules, choice groups or locked layers, PDFium cannot build that
  copy. The panel detects such files when it lists the layers: their layer
  toggles are disabled and a note under the section heading says why; the
  drawing keeps the PDF's own layer visibility.
- The PDFium layer view is verified on Linux; bundled Windows and macOS
  runtimes still need the same check.
