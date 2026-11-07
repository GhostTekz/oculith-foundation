# User guide

This guide describes Oculith Draw Foundation: what each part of the window does, and how to use each tool. For how the app is built, see [Architecture](ARCHITECTURE.md). For what is saved in the PDF, see [File format](FILE-FORMAT.md).

Everything you do is saved in the PDF itself, as standard annotations. Nothing is uploaded, and no account is needed.

## Contents

- [Launch screen](#launch-screen)
- [The window](#the-window)
- [Documents and tabs](#documents-and-tabs)
- [Sheets, sets and revisions](#sheets-sets-and-revisions)
- [Selecting and editing markups](#selecting-and-editing-markups)
- [Markup tools](#markup-tools)
- [Properties bar and Properties panel](#properties-bar-and-properties-panel)
- [Tool Chest](#tool-chest)
- [Symbol library](#symbol-library)
- [Stamps](#stamps)
- [Markups List](#markups-list)
- [Measuring](#measuring)
- [Quantities](#quantities)
- [Spaces](#spaces)
- [Markup layers](#markup-layers)
- [PDF layers](#pdf-layers)
- [Compare and overlay](#compare-and-overlay)
- [Slip sheets](#slip-sheets)
- [Raceways](#raceways)
- [Dynamic Fill](#dynamic-fill)
- [Edit tools](#edit-tools)
- [Sketch to Scale](#sketch-to-scale)
- [Flatten and unflatten](#flatten-and-unflatten)
- [Capture: photos, attachments, snapshots](#capture-photos-attachments-snapshots)
- [Visual Search](#visual-search)
- [Page and document tools](#page-and-document-tools)
- [Batch operations](#batch-operations)
- [OCR](#ocr)
- [CAD import and export](#cad-import-and-export)
- [Other import and export formats](#other-import-and-export-formats)
- [IFC report](#ifc-report)
- [Print](#print)
- [Themes and preferences](#themes-and-preferences)
- [Keyboard shortcuts](#keyboard-shortcuts)

## Launch screen

When the app starts, it shows a launch screen: the Oculith mark, whose eye follows the pointer, the product name and a line that says what is loading. It stays at least 1.8 seconds, then fades out. With reduced motion turned on in your system, the eye stays still and the fade is instant.

When no document is open, the work area says "No PDF Selected". Use **File ▸ Open** (Ctrl+O) to open a PDF.

## The window

From top to bottom, the window has a menu bar, the workflow toolbar, the properties bar, the document tabs, the work area with its panels and toolbars, the navigation bar, the bottom panel and the status bar.

### Title bar and menu bar

The menu bar is merged with the window title row: the Oculith logo, the menus, a drag area and the window controls (minimise, maximise, close). The file name shows in the system window title.

The menus are:

- **Oculith**: About, Preferences (Ctrl+,), Profiles, Keyboard Shortcuts, Exit.
- **File**: New, Open, Open Recent, Combine, Close, Close All, Save, Save As, Import, Export (PDF export, Raster PDF, To CAD, IFC Report), Email, Annotate Screenshot, Print.
- **Edit**: Undo, Redo, Undo History; Cut, Copy, Paste, Paste in Place, Duplicate, Move, Multiply, Offset; Delete, Clear Page Markups, Clear All Markups; Pan, Select, Select Area, Lasso, Select All, Deselect, selection cycling; Snapshot, Screenshot, Vector Snippet, Format Painter, Group and Ungroup; Arrange, Format, Image; PDF Content (Edit Text, Add Text); Redaction; Find.
- **View**: zoom and fit, page modes, Rotate View, Go To, Previous and Next View, split views and Sync, grid and snaps, Dark Mode, Dimmer, Theme, Disable Line Weights, Reader Mode, Show Keystrokes, Workflow (one entry per workflow tab), and the bars.
- **Document**: Document Properties, Page Setup, Rotate Pages, Insert, Extract, Delete and Reorder Pages, Crop, Shift Page, Deskew, Page Labels, Headers & Footers, Watermark, Compare Documents, OCR, Reduce File Size, Flatten, Unflatten.
- **Batch**: Combine and the batch operations (see [Batch operations](#batch-operations)).
- **Tools**: Markup, Stamp, Measure, Raceway, Sketch to Scale, Form, Signature, Hyperlink, File Attachment, Attach Photo, View Photos, File Attachments panel, Visual Search, Toolbars, Reuse, Line Styles.
- **Window**: Panels (each panel, checked when shown), Navigation Panel, Hide Panels, Auto-Hide Panel Access, Full Screen.
- **Help**: Find Tools + Commands, Keyboard Shortcuts, Extensions, File Associations, Startup Diagnostics, About.

Alt plus the first letter opens a menu (Alt+O, F, E, V, D, W, H). F9 shows or hides the menu bar.

**Help ▸ Find Tools + Commands** (Ctrl+K, Cmd+K on macOS, or Ctrl+Shift+P) opens the command palette: one search box over every command, tool, panel and workflow tab (an add-on's commands too), the pages of the open drawing (type a page number or a sheet label such as E-101), the other open documents, recent files and add-on tools. Each row shows where the command lives and its shortcut. With an empty box the commands you used last come first; commands you use often rise in the results. The search forgives a skipped letter and matches initials ("ep" finds Extract Pages). Arrow keys move, Enter runs, Alt+Enter (or the pin button) adds the command to Quick Access, Esc closes.

**Help ▸ Extensions** installs, reloads and removes `.oppx` extension packages, a mechanism inherited from Open PDF Studio.

### Profiles

A profile restores a full workspace: which panels are open and where, their sizes, which toolbars show, which workflow tabs the workflow toolbar shows and which one it opens on. Switch profiles in **Oculith ▸ Profiles** or from the Profile button on the navigation bar. An add-on can bring its own profiles.

| Profile | Layout | Workflow tabs |
|---|---|---|
| Oculith (default) | Tool Chest open on the left, markup and measure toolbars on the right, Markups List at the bottom | All; opens on Markup |
| Basic | Thumbnails on the left, no side toolbars, bottom panel collapsed | Sheets, Review, Markup, Measure, Output, View |
| Reviewer | Thumbnails on the left, Properties panel on the right, Markups List at the bottom | Sheets, Review, Markup, Compare, Output, View |
| Oculith Advanced | Thumbnails on the left, Properties panel on the right, Markups List at the bottom | All; opens on Review |
| Quantity Takeoff | Measurements on the left, Measure toolbar on the right, Markups List and Quantities at the bottom | All; opens on Takeoff |
| Document | Thumbnails on the left, bottom panel collapsed | Sheets, Review, Compare, Output, View (no add-on tabs) |

Panel sizes are remembered per profile.

### Toolbars

- **Properties toolbar**: directly under the menu bar. Its contents follow what is selected; see [Properties bar](#properties-bar-and-properties-panel).
- **Markup, Draw and Measure toolbars**: vertical, on the right edge. Markup has Text Box, Callout, Note, Highlight, Pen, Eraser, Cloud, Stamp, Snapshot, Hyperlink and Count. Draw has Line, Arrow, Polyline, Rectangle, Ellipse, Polygon, Arc, Conduit Run and Cable Tray Run. Measure has Length, Polylength, Area, Perimeter, Angle, Volume and Dynamic Fill. An overflow button holds the tools that do not fit.
- **Workflow toolbar**: directly under the menu bar. See [Workflow toolbar](#workflow-toolbar).

Show or hide each one in **Tools ▸ Toolbars**.

### Workflow toolbar

The workflow toolbar groups the tools by the job at hand. Its top row holds the workflow tabs; the row below holds the tools of the selected tab in named groups, each tool with its icon and label.

| Tab | Groups |
|---|---|
| Sheets | Set (Open, Open Recent, Combine, Import, Go to Sheet), Navigate (Thumbnails, Drawing Set, Bookmarks), Pages, Prepare (Page Labels, Crop, Page Setup, Shift, Deskew, OCR), Links |
| Review | Select, Comment (Note, Text Box, Callout, Highlight, Cloud, Stamp, Flag), Attach, Find |
| Markup | Shapes, Freehand, Text, Style (Format Painter, Line Styles, Reuse, Tool Chest), Sketch to Scale |
| Measure | Scale (Calibrate, Set Scale, Detect Scales, Viewport), Length, Area, Angles, Results (Measurements, Quantities, Quantity Schedule) |
| Takeoff | Count (Count, Parametric Symbol, Visual Search, Tool Chest), Runs (Conduit, Cable Tray, Polylength), Areas (Spaces, Area, Dynamic Fill), Results |
| Compare | Compare (Compare Documents, Slip Sheet, Layers), Split View and Sync |
| Output | File (Save, Save As, Print, Print Set), Export (incl. Markup Summary), Finish (Flatten, Reduce, Watermark, Headers & Footers), Redact |
| View | Zoom, Page Layout, Display (Dark Mode, Dimmer, Thin Lines, Reader Mode), Grid and Snap, Window |

The tabs follow the job from left to right: open the set, review and mark it up, measure and count, then compare revisions and send the result out.

While markups are selected, a **Selection** tab appears in the accent colour with Edit, Style, Arrange and Group; while an image is selected, an **Image** tab. Their properties stay in the properties bar below. When the row is too narrow, the last groups show their icons only, and then the last tools move into **More**. Hover a tool for its name and shortcut. The fold button at the right hides the tool row and keeps the tabs.

**Quick Access**, at the right end of the tab row, holds the commands you pin: right-click any tool on the workflow toolbar or the vertical toolbars and choose **Add to Quick Access**, or press Alt+Enter in the command palette. Right-click a Quick Access button to remove it or move it; the ▾ menu lists them and resets the default set (Open, Save, Undo, Redo, Print). Next to it, the search box opens the command palette.

An add-on can add its own workflow tab (and a matching submenu in **Tools**); it sits after Takeoff. The Document profile leaves add-on tabs out.

### Panel hosts

Panels live in three hosts: left, right and bottom. Each host has an access bar of 20 px icons. Click an icon to open its panel; click the active icon again to collapse the host.

- Right-click a panel tab for **Show** (any panel), **Hide** and **Attach ▸ Left / Right / Bottom**. The layout is kept between sessions.
- Click the outer edge of a host to collapse or expand it. Drag the edge to resize it.
- **Window ▸ Hide Panels** (Shift+F4) hides all hosts. **Auto-Hide Panel Access** hides the access bars while their panels are closed.
- The header of each panel shows its title and a ▾ panel menu with panel-specific items.
- Thumbnails and Tool Chest have a size slider in the footer.
- On desktop, drag the Thumbnails header outside the application window, or use its separate-window button, to float the thumbnails as a small tool window at the drawing's right edge. Drag it by its title bar to a corner or another monitor; it stays above the drawing, reopens where you left it (or beside the drawing when that monitor is gone) and closes with its drawing window. Each page shows its sheet number or page label and the drawing set title. Type in the filter box to narrow by sheet, title or page, use the S/M/L toggle for the thumbnail size, the arrow keys and Enter to open a page, Esc to close, and the dock button to put the thumbnails back in the side panel.

The panels are:

| Panel | Shortcut | What it holds |
|---|---|---|
| Thumbnails | Alt+T | Page thumbnails; right-click to move, rotate, insert, extract, replace or delete pages |
| Drawing Set | Alt+2 | The sheet register; see [Sheets, sets and revisions](#sheets-sets-and-revisions) |
| Bookmarks | Alt+B | The document outline; add, edit, nest and delete bookmarks |
| Layers | Alt+Y | Markup layers and the PDF's own layers |
| Tool Chest | Alt+X | Saved tools, tool sets and the symbol library |
| Links | Alt+N | Named destinations and link annotations; filter by page or type, export to CSV |
| Measurements | Alt+U | Scale, viewports, measurement list, legend, raceway schedule |
| Properties | Alt+P | Properties of the selected markup, or of the file |
| Form Fields | Alt+Q | The PDF's interactive form fields |
| Signatures | Alt+4 | Digital signatures and their verification |
| File Attachments | | Files embedded in the PDF; add, open, save, delete |
| Search | Alt+1 | Text and annotation search, and Visual Search |
| Tags | | The PDF structure tags |
| Spaces | Alt+S | Named regions of a page |
| Quantities | | Quantity schedules |
| Markups List | Alt+L | The list of every markup |
| Element Visibility | | Show, hide, dim or tint markups by type |
| Markup Layers | | Create and manage markup layers |

Element Visibility and Markup Layers start hidden. Open them from **Window ▸ Panels**, or right-click a panel tab ▸ **Show**.

### Navigation bar

The navigation bar (F4) runs along the bottom of the work area.

- **Left**: Unsplit, Split Vertical, Split Horizontal; single page and continuous; Pan, Select, Select Text.
- **Centre**: First, Previous, the page field, Next, Last; Previous View and Next View. Type a page number or a page label in the page field and press Enter.
- **Right**: zoom field, page size, page scale (click to set the scale), Document Properties, Dimmer, Dark Mode and Profile.

### Status bar

The status bar (F8) runs the full width of the window.

- **Left**: a hint for the current tool, or "Ready".
- **Right**: toggles for Show Grid, Snap to Grid, Snap to Content, Snap to Markup, Ortho and Reuse; Sync for split views; the renderer used for the current view; the display units; the page scale; the page size; and the cursor position in page units.
- When the app finds a scale in the title block of an uncalibrated sheet, the scale item reads "Detected 1:48: set scale?". Click it to open Set Scale with that scale filled in.

Drawing aids:

- **Snap to Content** snaps to lines and points of the PDF drawing.
- **Snap to Markup** snaps to end points, vertices and edges of existing markups.
- **Snap to Grid** and **Show Grid** use the grid spacing from Preferences.
- **Ortho** constrains lines to 0°, 45° and 90° while you hold Shift.
- **Reuse** keeps the tool active after you place a markup. Esc returns to Select.

## Documents and tabs

### Opening and saving

- **File ▸ Open** (Ctrl+O) opens a PDF in a new tab. The Open panel also lists **Recent Files** (pin the ones you keep), saved **Sessions** (a named set of open files), **Open from URL** (an https link to a PDF) and **Places** (folders you add).
- **File ▸ New** (Ctrl+N) creates a blank PDF.
- **File ▸ Combine** merges several PDFs into one.
- **File ▸ Save** (Ctrl+S) writes the PDF in place. **Save As** (Ctrl+Shift+S) writes a copy. The file is written atomically: a temporary file first, then a rename.
- **File ▸ Close** (Ctrl+W) and **Close All** close tabs. An unsaved tab asks first.
- With **Restore last session when application starts** on in Preferences, the app reopens your last tabs.
- **File ▸ Email** opens a message with the file name and path, ready to attach.

### Tabs

- Each document has a tab. Ctrl+Tab and Ctrl+Shift+Tab move between tabs.
- The ▾ at the right of the tab bar lists every open document.
- Right-click a tab for Close, Close All, Close Others, Split Vertical, Split Horizontal, Switch, Detach to New Window and Properties. A document must be saved before it moves to another window.

### Page modes and zoom

- **View ▸ Single Page** (Ctrl+4), **Continuous**, **Side-by-Side** (Ctrl+6) and **Continuous Side-by-Side** (Ctrl+7).
- **Fit Width** (Ctrl+1), **Fit Page** (Ctrl+2), **Actual Size** (Ctrl+0), **Zoom In** (Ctrl+=), **Zoom Out** (Ctrl+-).
- **Rotate View** turns the view only. **Document ▸ Rotate Pages** turns the pages in the file.
- **Previous View** and **Next View** (Alt+Left, Alt+Right) step through your page and zoom history.
- Hold the middle mouse button to pan in any tool. The Pan tool is Shift+V.

### Split views (MultiView)

- **View ▸ Split Vertical** (Ctrl+Alt+2) or **Split Horizontal** (Ctrl+H) shows two panes. The active document is duplicated into the second pane.
- Each pane has its own tab row. Drag a tab to the other pane, or use **Switch** in the tab menu.
- Click a pane to make it active. Tools work only in the active pane; the other pane shows the same markups and repaints when they change.
- **Sync** on the status bar or the View menu links the panes. **Synchronize Document** shows the same page number in both. **Synchronize Page** keeps the page offset you had when you turned Sync on, so A-101 and A-102 stay one page apart. Zoom and pan follow in both modes.
- **Unsplit** (Ctrl+Shift+2) returns to one pane.

### Display options

- **Dark Mode** (Ctrl+3) darkens the drawing content, not the app.
- **Dimmer** (Ctrl+F5) fades the drawing from 0 to 100 %, so markups stand out.
- **Disable Line Weights** (Ctrl+5) draws every line at 1 px.
- **Reader Mode** remembers this PDF's page, scroll position and zoom in a small file beside it, so the document reopens where you left it.
- **Show Keystrokes** shows the keys you press, for demonstrations.
- **Full Screen** (Ctrl+L).

### Find

**Edit ▸ Find** (Ctrl+F) opens the find bar. Enter goes to the next match, Shift+Enter to the previous one, F3 repeats. Options: Match case, Whole words, Highlight all. The **Search** panel (Alt+1) lists every hit in the text, in annotations, or both.

## Sheets, sets and revisions

The **Drawing Set** panel (Alt+2) is a register of sheets.

- **Add PDFs** registers every page of the chosen PDFs as a sheet. Each sheet has a Sheet ID, a title and a revision. Edit them in **Sheet details**.
- **Review sheet numbers and titles** reads selectable text from the current registered PDF pages. It proposes values only when a labeled field in the lower or right title block is unambiguous. Review each proposed value and its source text, select the rows to update, then choose **Apply selected details**. The review reports missing or changed PDFs and sources without a recorded fingerprint; those rows cannot be applied. Image-only pages need manual entry. The register changes in one step only after Apply, and the PDFs are never changed.
- **Review titles from selected index sheet** reads one selected registered page after checking its PDF fingerprint. Select a drawing index page with selectable text. Rows with an exact, unique sheet ID match propose titles only; duplicate or unmatched rows are shown for review. Check the source line and target PDF status, select the titles to update, then choose **Apply selected details**. The app checks the index and selected target PDFs again before updating the register. Sheet IDs, source paths, stable IDs and PDFs stay unchanged. Image-only indexes need manual entry.
- **Review index navigation links** uses the selected registered index page to propose links on its sheet-number text. Only distinct, selectable rows with an exact registered target and verified PDFs are eligible. Review blocked rows and select the links to create. **Create Links** writes separate linked copies of the set PDFs after rechecking their fingerprints; the register and original PDFs stay unchanged. Links to another PDF use a relative path within the copied set.
- Search the list, or filter it by revision. **Open sheet** opens the page in a tab. **Previous sheet** and **Next sheet** step through the set.
- **Record revision** records a new revision of a sheet: choose the revised PDF, and the old source moves to **Earlier revisions**. Open an earlier revision to see it with its own markups.
- **Compare** beside an earlier revision reviews that sheet's saved old and current PDF sources, then opens their recorded pages side by side after you confirm. Both files must match their saved fingerprints. Comparing leaves the drawing set unchanged.
- **Check set revision summary** reads the saved PDFs for every current sheet and its latest earlier revision. It shows the recorded page, revision and SHA-256 state for each source, including missing, changed or unverified files. A ready row can enter the same two-step **Compare** review. The summary does not change the register or any PDF.
- The app records a fingerprint of each PDF. **Check files** reports each source as Present, Missing or Unavailable. When a file has moved, **Relink** points the sheet to an identical PDF after checking its fingerprint again at confirmation. Use **Record revision** for changed contents. Older manifests without a recorded fingerprint show a warning because the original PDF cannot be verified.
- **Export current view CSV/PDF** writes only the current sheets shown by the search and revision filter. The PDF includes the filter and count; changing the view or register during Save cancels the export.
- **Export drawing log** writes the full register and earlier revisions as CSV or PDF, regardless of the current search and filter.
- **Check transmittal readiness** reviews every current registered PDF against its recorded SHA-256 and page number. Resolve missing, unreadable, changed, unverified or out-of-range sources before sending drawings. The review is a snapshot, so check again after changing source files or the register.
- **Export issue package ZIP** starts from that readiness review. Select up to 200 ready sheets, optionally enter an issue date, reference and transmittal note, then choose **Preview issue package**. These details identify the local package; export does not send it. Inspect the sheet count, source count, size and manifest before export. **Export issue package ZIP** asks for a new ZIP path and rechecks each selected source before writing. The ZIP contains a PDF of only the selected current pages and a manifest with the issue details, sheet IDs, titles, revisions, source PDF names and SHA-256 values. It excludes original multi-page PDFs and absolute source paths. A new preview is required if the selection, issue details or register changes. Package preparation is limited to 128 MiB of source PDFs, a 96 MiB combined PDF and a 100 MiB ZIP.
- **Publish current sheets PDF** writes one PDF with the current revision of every sheet, in sheet order. The PDF includes sheet-number page labels and a bookmark for each sheet, with its title when present. It refuses a signed PDF, a PDF with form fields, and an overwrite of an existing file.
- **Export set manifest** and **Import set manifest** save and load the register as a file.
- **Slip sheet…** replaces sheets with a new revision and carries their markups. See [Slip sheets](#slip-sheets).

## Selecting and editing markups

- **Select** (V) picks markups. Drag on empty space for a box selection. Shift adds to the selection.
- **Lasso** (Shift+O) selects the markups fully inside a free-form outline. Hold Ctrl to select every markup the outline touches.
- **Select Next Overlapping Markup** (Shift+Space) steps through stacked markups under the last click. With **Markup Selection Cycle** on (the default), a second click on the same spot does the same. The status bar shows "Selection cycle: 2 of 3".
- Drag a markup to move it. Drag its grips to reshape it. Arrow keys nudge the selection.
- **Delete** removes the selection. **Clear Page Markups** and **Clear All Markups** remove markups in bulk.
- **Cut, Copy, Paste** work across tabs. **Paste in Place** (Ctrl+Shift+V) keeps the page position.
- **Duplicate** copies the selection beside itself. **Multiply** makes a number of copies at a fixed offset to the right and down. On an uncalibrated page the offsets are in PDF points.
- **Copy to pages…** in the markup menu copies the selection to a page range such as `1-3, 5`, at the same page position.
- **Group** (Ctrl+G) joins markups into one group; **Ungroup** (Ctrl+Shift+G) removes one level. Groups can nest. Alt+click picks one member. **Remove Selected from Group** and **Remove Group Nesting** are in the Edit menu and the list menu.
- **Lock** (Ctrl+Shift+L) locks a markup so it cannot be moved or edited.
- **Format Painter** (Ctrl+Shift+C) copies one markup's appearance onto others. **Copy Style** and **Paste Style** do the same through the clipboard.
- **Edit ▸ Arrange** aligns, distributes, sizes, rotates, flips and orders the selection.
- **Edit ▸ Format ▸ Styles** applies a named colour style, and **Style Presets** applies one you saved.
- **Undo** (Ctrl+Z), **Redo** (Ctrl+Y or Ctrl+Shift+Z). **Undo History** (Ctrl+Shift+H) lists every step; click a step to go back to it, and click an undone step to redo up to it.

The markup context menu (right-click) holds the commands for that markup: pop-up note, reply, status, layer, subject, arrange, convert (for example a line to a measurement), calibrate from a line, style tools, export as image, Add to Tool Chest, Flatten and Properties.

## Markup tools

Pick a tool from **Tools ▸ Markup**, the right toolbar, or its key. Esc finishes the current shape and returns to Select.

### Text and notes

- **Text Box** (T): drag a box, then type. The text wraps in the box. Font, size, colour, bold, italic, underline and alignment are on the properties bar.
- **Typewriter** (W): click and type. Borderless text that does not wrap.
- **Callout** (Q): a text box with a leader line to the point you click first.
- **Note** (N): a sticky note icon with a pop-up comment.
- **Flag** (Shift+F): a small flag note.
- **Highlight** (H): highlight text on the page.

### Lines and shapes

- **Line** (L) and **Arrow** (A): click the start, click the end. Type a length while drawing to set it exactly. Shift snaps the angle.
- **Curved Arrow** and **Spline**: smooth curves through the points you click.
- **Polyline** (Shift+N): click each vertex; double-click, Enter or right-click finishes.
- **Arc** (Shift+C).
- **Rectangle** (R), **Ellipse** (E), **Circle**: drag to draw. Shift keeps proportions.
- **Polygon** (Shift+P): a closed outline.
- **Cloud** (C): a revision cloud around a rectangle. **Cloud+** (K): a revision cloud along the points you click.
- **L-Shape**: an L-shaped outline.
- **Hatch**: a filled area with arcs and optional holes, solid or hatched.
- **Pen** (P): freehand ink. **Eraser** (Shift+E): drag over freehand strokes to remove them.
- **Dimension** (Shift+L): a dimension line.

### Images and links

- **Image** (I): place an image file.
- **Remove Image**: click an image that is part of the page content to remove it from the page.
- **Hyperlink** (Shift+H): drag a rectangle, then give a URL or a page.
- **File Attachment** (F): see [Capture](#capture-photos-attachments-snapshots).

### Stamps, symbols, forms and signatures

- **Stamp** (S) and **Stamp Editor**: see [Stamps](#stamps).
- **Parametric Symbol**: place a symbol whose dimensions stay editable; see [Symbol library](#symbol-library).
- **Form ▸ Form Fields** opens the Form Fields panel.
- **Signature ▸ Place** places a signature; **Signature ▸ Signatures** opens the panel that lists digital signatures and checks them.

### Line styles

**Tools ▸ Line Styles…** opens the line style manager. A line style draws up to six parallel lines and up to four repeating marks (text such as `GAS` or `FO`, or a symbol) along a line, polyline, arc, spline, perimeter or polylength.

- Built-in styles: Gas, Water, Sanitary sewer, Storm drain, Electric, Telecom / fibre, Fence, Centerline, Hidden and Phantom.
- Create, duplicate, edit with a live preview, and delete your own styles. Import and Export share them as JSON.
- Pick a style in **Properties ▸ Appearance ▸ Line type**.
- **Hatch patterns ▸ Import .PAT…** reads hatch pattern files in the `.pat` format, in millimetres, inches or points. Imported patterns appear under **Imported** in the hatch lists.

## Properties bar and Properties panel

### Properties bar

The properties bar sits directly under the menu bar.

- **No document**: empty.
- **Document open, nothing selected**: a document menu, the file name, the page count and Insert Blank Page.
- **Markup selected**: the type icon and the settings for that type, in order: line colour, opacity, line style, line width, start and end heads, fill colour and hatch, font, size, text colour, text style and alignment. Only the fields that apply to the type show.
- **Several markups selected**: the fields they share. An edit applies to every selected markup that has that property.
- **Measurements selected**: also the total of the selected values.
- **Tool active**: the defaults for the next markup of that tool.

### Properties panel

The Properties panel (Alt+P) shows more detail.

- With no selection: the file properties, attachments and tags.
- With a markup: General (author, subject, label, comment, lock, layer, group), Appearance, and sections for the type, such as Measurement, Raceway or Capture.
- **Set as Default** at the bottom makes the selected markup's appearance the default for new markups of its type.

## Tool Chest

The Tool Chest panel (Alt+X) holds saved tools. A saved tool remembers a markup's appearance, and optionally its size, so you can place it again.

### Sections

- **My Tools**: your own tools. The first ten have hot keys 1-9 and 0, shown as a small number on the tile.
- **Recent Tools**: tools you used this session.
- **Named tool sets**: sets you create or import.
- **Symbol library**: the built-in symbols; see [Symbol library](#symbol-library).

The search box in the header filters tools across all sets. **Expand All** and **Collapse All** are in the header ▾ menu. **Float** detaches the panel into its own window.

### Saving a tool

- Right-click a markup ▸ **Add to Tool Chest ▸** a set, or **Several sets…** to pick more than one with a label, subject and comment.
- In a set's ⚙ menu, **Add Selected Markup…** saves the selected markup in that set.
- A group saves as one tool. Placing it places a fresh copy of the whole group.
- Notes (other than flags), hyperlinks, file attachments and text markups cannot be saved as tools.

### Drawing Mode and Properties Mode

- **Drawing Mode** places an exact copy at the saved size.
- **Properties Mode** draws a new markup at the size you draw, with the saved colour, line and shape settings.
- Double-click a tool to switch modes. The tile shows **D** or **P**.
- Groups and stamps are always Drawing Mode.
- A text box, callout or typewriter saved with **Include text and size** can use Drawing Mode, so its text is placed with it.

### Tool menus

- Right-click a tool: Properties Mode or Drawing Mode, Edit…, Copy to, Move to, Move up, Move down, Layer…, Delete. Drag a tool onto another set to move it; Ctrl+drag copies.
- A set's ⚙ menu: Properties or Drawing Mode for the whole set, Display (Symbol or Detail), Add Selected Markup…, New Symbol Count…, Rename…, Export…, Export Tool Set File…, Scale…, Add to My Tools, Assign all tools to layer, Remove tool layers, Manage Tool Sets…, Remove.
- **Detail** view shows each tool's label, type, mode, subject and comment. **Symbol** view shows icons only.

### Sequences

A saved tool can number its placements. In the tool's **Edit…** panel, set a prefix and suffix (up to 16 characters), a start (0 to 999999), a step (1 to 1000) and 1 to 6 digits.

- With prefix `D-`, start 1, step 1 and two digits, placements read D-01, D-02, D-03.
- The label becomes the markup's subject. Text boxes, callouts and typewriters also show it as their text.
- The next number is stored in the document, so a reopened PDF continues where it stopped. Tools with the same prefix and suffix share one counter in a document.
- Edit… shows the next label for the active document, and lets you set or reset it.

### Hot keys

Keys 1-9 pick My Tools slots 1-9, and 0 picks slot 10. Reorder My Tools with Move up and Move down, or by dragging. While you type a length for a line, digits go to the length field instead.

### Scale-aware tool sets

Choose **Scale…** in a set's ⚙ menu to take the current page's calibrated scale as the set's reference scale, for example "Reference 1:100". A Drawing Mode tool from that set then resizes to the scale where you place it: a door saved at 1:100 placed on a 1:50 sheet is twice as large on paper and the same size in the building. Line width, font size and rotation do not change.

### Tools on layers

Right-click a saved tool ▸ **Layer…** and enter a layer name. Every markup placed with that tool lands on that markup layer, which is created in the document when first needed. Tools with the same layer name share one layer.

### Count presets

- **Add Selected Markup…** on a dot count saves its colour and opacity as a count preset.
- **New Symbol Count…** makes a preset with a count symbol, a size (4 to 480 pt), a colour, whether numbers show, and a count category name.
- Placing a preset counts in that category. Numbering continues after save and reopen.

### Managing and sharing tool sets

**Manage Tool Sets…** (header ▾ menu or a set's ⚙ menu) lists every set with its location and status: Local, Read-only, Checked out or Offline.

- **Add New…** creates a set. With a save location, the set is written to a tool set file there and shared from it.
- **Add Existing…** uses a tool set file in place, for example on a network share. **Relative Path** stores the path relative to the app data folder.
- **Import…** copies a tool set file, a portable JSON set, a `.btx` tool set file or a `.zip` of `.btx` files into new local sets. Items that cannot be converted are listed with a reason.
- **Export…** writes the set as an Oculith Draw tool set file (`.ocudraw-toolset`). The ⚙ menu's **Export…** writes portable JSON.
- **Move Up** and **Move Down** reorder the sets. **Display** hides or shows a set. **Show In All Profiles** off keeps a set in one profile.

A shared set is read-only until you check it out:

- Click the lock on the section header, or ⚙ ▸ **Check Out**. This creates a lock file beside the set file, with your user name and the time. Someone else trying to check it out is told who has it.
- Edit the set, then click the check mark, or ⚙ ▸ **Check In**, to write the file and release the lock. **Cancel Check Out** drops your edits.
- Each app re-reads a shared set when the file changes, on window focus and every 30 seconds.
- A lock older than 8 hours can be broken. A set whose folder cannot be reached works from its offline copy, read-only.

## Symbol library

The Tool Chest includes a symbol library that ships with the app and works offline.

- **NEN 1414 safety symbols**: fire protection, doors, emergency lighting, smoke and heat extraction, ventilation, and water and sprinklers. They place as stamps.
- **Parametric components**: walls, curtain walls, window frames, spaces, steel sections (HEA, HEB, IPE, UNP, box and angle), timber beams, bolts and anchors, reinforcement, grid lines, spot elevations, structural support and load symbols, site items (crane swing radius, truck turning circle, parking bay, site cabin) and sanitary fixtures. They stay editable after placement: change their values and orientation in the Properties panel. **Edit ▸ Format ▸ Edit Symbol Type…** edits the type.
- **Count symbols**: 17 symbols for counts, such as circle, ring, square, triangle, diamond, star, receptacle, light fixture, switch, smoke detector, sprinkler and tag.

**Tools ▸ Stamp ▸ Parametric Symbol…** opens a picker over the parametric components.

## Stamps

**Tools ▸ Stamp ▸ Stamp** (S) opens the stamp picker.

- **Contractor stamps**: Reviewed, Approved, Approved as Noted, Revise & Resubmit, Rejected, Field Verified, As-Built, For Construction, Not for Construction and Void. Each has a date line; most also show the author.
- **My stamps**: stamps you made, with Edit and Delete.
- **Standard stamps**: single-line text stamps, and a custom stamp from an image file.
- **New Stamp…**, **Import…** and **Export…** open the editor or read and write stamps as JSON.

**Tools ▸ Stamp ▸ Stamp Editor…** makes your own stamp:

- A name, and **Start from** to copy any stamp.
- Up to 6 text lines, each with a font size (4 to 72 pt) and Bold.
- A border: none, rectangle, rounded or double. A colour, a date format and a status text.
- An optional PNG or JPEG image, to the left of the text.
- **Insert field…** adds a dynamic field: `{date}`, `{time}`, `{user}`, `{pageLabel}`, `{fileName}` or `{status}`. Fields are filled in once, when the stamp is placed.
- **Add to Tool Chest** also saves the stamp as a My Tools tool.

You can keep up to 100 stamps. A placed stamp's text is fixed; place it again to change it.

## Markups List

The Markups List (Alt+L, F11) is a spreadsheet of every markup in the document. It is linked to the sheet: selecting a row selects the markup, and the other way round.

### Toolbar

- **Hide markups** (eye), **Search**, **Filter List** (column filters), **Columns**, **Export and summary**, **Formulas**, and the panel menu.
- Arrow keys move through the rows. Double-click a cell to edit it, where the column allows.

### Columns

Built-in columns include Subject, Page, Page Label, Page Index, Type, Comments, Author, Date, Status, Color, Lock, Layer, Space, Attachments and the measurement value. Show, hide and reorder them in **Columns**. Click a header to sort.

Custom columns belong to the document and are saved in the PDF:

- **Text**: two columns, each a single line of up to 256 characters per markup.
- **Choice**: two columns, each with 1 to 20 options. Options can carry a number.
- **Number**: two columns, each a plain decimal with up to nine integer and six fractional digits.
- **Checkmark**: one check box per markup. **Check** on the markup menu toggles it.
- **Formula**: one column that computes `source × multiplier + offset`. The source is either Number column, or the numbers on the first Choice column's options.

### Formulas and captions

**Formulas** in the Markups List toolbar opens a dialog for richer formula columns and captions.

- Up to five formula columns. Each has a name, an expression, a unit label, 0 to 6 decimals and a "Measure in" unit (mm, cm, m, in, ft).
- Expressions use `+ - * /` and parentheses, decimal numbers, other columns by name (`{Cost/sf}` or `[Name]`), and the measurement values `Length`, `Area`, `Volume`, `Count`, `Depth` and `{Wall Area}`.
- A missing value, a division by zero or a measurement without a scale gives a blank cell. A bar under the list shows the totals.
- **Export XLSX** writes the listed markups with their values and a totals row.
- **Custom captions**: a caption template per markup type, or per markup, using tokens such as `{Subject}`, `{Comment}`, `{Author}`, `{Page}`, `{Status}`, measurement values and column names. The caption draws under the markup on screen and in print. Other PDF readers do not show it.

### Status

Each markup has a review status. The default set is None, Accepted, Rejected, Completed and Cancelled. Set it from the Status cell or the markup menu. The status history is kept as replies. A document can have its own status set of 1 to 20 names, each with an optional colour.

### Replies

Each markup can have a thread of replies. Show replies under a row, write a reply and post it. A locked markup takes no replies.

### Grouping

**Group By** groups the rows by Subject, Layer, Author, Page, Type, Color, Status, Date, Space or Group.

- Each section header has an eye that hides or shows all its markups.
- Each row has an eye that hides or shows that markup. A hidden markup is saved with the PDF Hidden flag, so other readers hide it too.
- Drag rows onto a Subject, Author or Layer header, or onto a Group row, to move them into that category.
- Group rows show the totals of their members' counts, lengths and areas.
- Shift-click selects a range of rows.

### Filters

- **Search** matches any visible column.
- **Filter List** shows a filter on each column header: tick the values to keep. **Clear all column filters** resets them.
- Filters can be saved.

### Export

- **Export markups (CSV)…** or **Export selected markups (CSV)…**. Values that look like spreadsheet formulas are neutralised.
- **Summary as CSV, PDF or XML**: all or selected markups, optionally with the latest status only. The PDF is a paginated summary.
- When the export holds raceway runs, the CSV adds Tag, Raceway, Fittings and Bends. When the document has spaces, it adds Space.

## Measuring

Measurements are computed from page geometry and the calibrated scale. Display units and precision change only how a value is shown, never the stored value.

### Setting the scale

Without a scale, a measurement stays in page points and its label reads "Scale not set". Totals of uncalibrated values are never shown as physical quantities.

- **Tools ▸ Measure ▸ Set Scale…** opens Set Scale. Choose the pages (all, current or a range such as `1-3,5`), then a preset (Architectural, Engineering, Metric or your own) or a custom ratio such as `1/4 in = 1 ft`. Set the precision. **+ Add Preset** saves a preset. **Clear Scale** removes it.
- **Calibrate** picks two points on the page and asks for their real length. Lengths accept mm, cm, m, in or ft, and feet-inches such as `10'-6"`.
- **Detect from title block** reads the scale written in the title block. The status bar also offers a detected scale on uncalibrated sheets.
- Right-click a line ▸ **Calibrate from this Line…** calibrates from a line you drew.
- **Add Viewport** draws a rectangle with its own scale, for a detail at another scale on the same sheet. Viewports are listed in the Measurements panel, highlighted while a measure tool is active, and saved as PDF viewports with a name.

The page scale is saved in the PDF as a standard viewport measure, so other readers that support it see the same scale.

### Display units

The units button on the status bar sets how values are shown: Scale unit, Feet-inches, Inches, Feet (decimal), Millimetres, Centimetres or Metres. **Metric and imperial** also shows the other system, for example `9'-6" (2896 mm)`.

### Measure tools

| Tool | Key | Use |
|---|---|---|
| Length | Shift+Alt+L | Click start and end |
| Polylength | Shift+Alt+Q | Click each point; shows the total and each segment |
| Area | Shift+Alt+A | Click each corner of a closed outline; Add Hole cuts an opening |
| Perimeter | Shift+Alt+P | Click each corner; the closed length |
| Angle | Shift+Alt+G | Three points |
| Volume | Shift+Alt+V | An area times a depth you enter |
| Arc Length | | Start, a point on the arc, end |
| 3-Point Radius | | Three points on a circle |
| Radius | Shift+Alt+U | A radius dimension |
| Diameter | Shift+Alt+D | A diameter dimension |
| Count | Shift+Alt+C | Click each item; see below |
| Dynamic Fill | J | See [Dynamic Fill](#dynamic-fill) |

- M picks the last measure tool again.
- Double-click or Enter finishes a multi-point measurement. Escape or the right mouse button cancels a measurement in progress. Shift keeps the current leg horizontal or vertical.
- A finished length or perimeter of two or more points, or an area of three or more, stays on the sheet when you leave the tool.
- The measurement properties include name, scale override, unit, precision, label size (6 to 72 pt), show unit, show label, depth, slope (degrees, grade or pitch), segment values, centroid and caption.
- On a desktop build with GEOS, stored areas use exact polygon unions, so overlapping parts and holes count once; see [Architecture](ARCHITECTURE.md#open-pdf-geos).

### Counts

Each click with the Count tool places one numbered marker in a count category. The next number is one above the highest in that category. A count can show a dot or a count symbol with its number beside it. Count presets in the Tool Chest count in a named category.

### Measurements panel

The Measurements panel (Alt+U) shows:

- the page scale and the viewports, with rename, change scale and delete;
- every measurement;
- a **Dynamic Fill** button;
- a **Legend** for this page or the whole document, with colour, subject, count and total, which **Place on page** adds as a table;
- the **Raceway schedule**, when the document has raceway runs.

Mixed or unknown units show "Mixed or unknown units" instead of a total.

## Quantities

**Tools ▸ Measure ▸ Quantities** and the Quantities panel build quantity schedules from the markups.

- **Add schedule** starts from a template: Area, Length, Count, Symbol, Text, Full quantities, or Images & stamps.
- **Properties** sets the schedule: **Fields** (which columns, in order), **Filter** (rules combined with AND), **Sort/Group** (sort keys, grouping, show each instance, grand totals), **Format** (heading, unit, decimals, alignment, totals per column) and **Appearance** (title, headers, gridlines, outline, striped rows).
- Fields include category, type, page, label, colour, count, area, length, count category, content, symbol and a preview image.
- **Place on PDF**, or drag the schedule onto the page, adds it as a table. The table saves and reopens with its rows.
- **Export CSV** writes the rows.
- With GEOS, overlapping polygons and rectangles on the same page and scale count once in the totals.

### Assemblies

An assembly is a parts list with prices that you type in. Open it from the markup menu or the multi-selection menu: **Assemblies…**.

- A recipe has a name and lines. Each line is a part, a quantity, a unit (`each` or `length`) and a unit price.
- Attach a recipe to counts or lengths. Each-lines multiply by the count; length-lines multiply by the calibrated length. Without a scale, length parts are left out and the row is marked scale not set.
- **CSV** writes every part with its quantity, unit price and extended price.
- The recipes are saved in the PDF. There is no built-in price book or labour catalogue.

## Spaces

A space is a named region of a page. Open the Spaces panel with Alt+S.

- Draw a space with **Rectangle** or **Polygon**, or make one **From selection** (an area, polygon, filled area, rectangle or ellipse).
- Spaces nest: a space inside another becomes its sub-space.
- Every markup gets a read-only **Space**: the deepest space that holds it, shown as a path such as `Office ▸ Closet`. It updates when a markup or space moves.
- The Markups List has a Space column, Group By Space and a Space filter. Quantities can filter to a space and its sub-spaces.
- The panel sums each space: counts, lengths, areas, volumes, wall areas and formula-column totals, with sub-spaces included in the parent. Download the result as CSV with a document total. Uncalibrated values are counted as scale not set instead of being added.
- Dynamic Fill can create spaces directly.

## Markup layers

Markup layers group markups so you can show, hide, print or lock them together. They are saved as PDF optional content groups, so other PDF readers can switch them too.

- Use the top section of the Layers panel (Alt+Y), or open the separate **Markup Layers** panel from **Window ▸ Panels**.
- **New layer**, rename, delete, move up and down. When you delete a layer, choose to move its markups to another layer or delete them.
- Per layer: **Current** (new markups land on it), **Visible**, **Print** (printed and exported), **Lock** (visible, but its markups cannot be picked) and a colour.
- **Show all**, **Hide all**, **Lock all**, **Unlock all**.
- Click a layer to select the markups on it. **Move selection here** moves the selected markups to the layer.
- Right-click a markup ▸ **Layer** to move it, or **New layer…**.
- The Markups List can group by layer. The group eye and the Layers panel switch are the same setting.

## PDF layers

The bottom section of the Layers panel lists the PDF's own layers (optional content groups that switch page content, such as CAD layers). A PDF without its own layers says so and points to Markup Layers.

- Click the eye next to a layer to show or hide it, or the eye next to a group heading for every layer in the group.
- **Show only this layer** (the target button on hover) hides every other drawing layer, for example to look at the electrical layers without the architectural background.
- The section toolbar has a name filter, **Show all**, **Hide all** (on the filtered layers when a filter is typed), **Reset to the PDF's default layers** and **Save layer visibility as the PDF default**.
- The layers you show or hide are a view. The app remembers it per document; Save keeps the PDF's own layer settings unless you choose **Save layer visibility as the PDF default**.
- Display, thumbnails, print, image and raster PDF export, screenshots, snapping and measuring follow the view. Extract Pages, PDF/X export and CAD export ask first: reset the layers and continue, or export a raster copy where offered. Text search still finds text on hidden layers.

[PDF layers](PDF-LAYERS.md) lists every output route and the current limits.

**Element Visibility** (Window ▸ Panels) is a separate view filter: per markup type, toggle visibility, halftone (dim) or a tint colour. It changes the view only.

## Compare and overlay

**Document ▸ Compare Documents…** compares two revisions. Open both PDFs in tabs first.

- Choose the **Old** and **New** document and page, then **Overlay** (both on top of each other) or **Side-by-side** (two synchronised views). **Swap** exchanges old and new.
- In Overlay, the **Earlier page** slider controls how strongly the old PDF appears over the new PDF; 0% shows only the new PDF. The change highlights remain separate from the page images.
- **Align** shifts or rotates the earlier page onto the current page. Its position stays fixed to the drawing while zooming.
- **Marking** shows changes as a filled **Box** or a **Contour**. The **Changes** list shows Added, Removed and Modified regions. The **Text** tab lists text differences.
- **Page pairs**: match pages manually, or **Suggest matches** from embedded page labels. Each pair must be confirmed before its report is trusted.
- **Compare confirmed pairs** runs all confirmed pairs in batch. **Export batch CSV** and **Export batch PDF** write the reports. A failed pair is reported apart from a pair with no changes.
- **Export selected region as marked-up PDF** writes a copy of the new PDF with an editable rectangle around the selected change. The source PDFs are not changed.
- **Save plan JSON** and **Load plan JSON** save and restore the page pairs and alignment. **Save session locally** keeps up to eight recent sessions, checked by a fingerprint of each PDF.

**Batch ▸ Compare** and **Batch ▸ Overlay** open the same view.

## Slip sheets

Slip Sheet replaces sheets in the drawing set with a new revision and carries their markups onto it.

1. In the Drawing Set panel, choose **Slip sheet…** and select the revised PDFs.
2. Each revised page is matched to a sheet by its page label, by a file name that contains one sheet ID, or by a sheet ID in the title block. An ambiguous match stays unmatched; page order is never used.
3. The confirmation dialog lists each page with the sheet it replaces and why. Change a match, choose **Add as new sheet**, set the alignment, enter the new revision and choose **Slip sheet**.
4. Each matched page's markups are copied onto the revised page and written to a copy, `<revised name>-slip-sheet.pdf`. The set points to the copy, and the old source moves to Earlier revisions.

Alignment:

- **Auto (page)** maps the old visible page onto the new one, scaling uniformly when the paper size changed.
- **2-point** takes two matching points on each sheet and computes a move, rotate and uniform scale.

Each carried markup gets a "Carried from Rev X" reply and a record of where it came from. Its replies, status history and custom column values come with it. The revised PDF and the old revision are never written to.

## Raceways

**Tools ▸ Raceway** draws as-built conduit and cable tray runs at true size.

### Drawing a run

- **Conduit Run** or **Cable Tray Run**. Click to start, click each corner, and double-click, Enter or right-click to finish. Backspace removes the last corner.
- After the first leg, each corner snaps to a standard elbow: straight on, or 30°, 45°, 60° or 90° either way. Choose the angles under **Elbows**; **Snap bends** turns snapping off; Alt gives a free angle.
- Each corner becomes an elbow at the standard radius for the size, reduced when two corners are too close.
- The label shows the developed length, the size, the fittings (for example `1 × 90°, 2 × 45°`) and, for conduit, the bend total.

### Options bar

- Conduit type (EMT, RMC, IMC, PVC Sch 40, PVC Sch 80, FMC, LFMC), trade size (1/2" to 6"), and True size (two lines at the outside diameter instead of a centre line).
- Tray style (Ladder or Basket), width, side rail height and rung spacing.
- Elbow radius (empty = standard) and colour.
- Without a scale, the bar shows **No scale: Set Scale**. Tray is then drawn schematically at 1/8" = 1'-0" and lengths stay in page points.

### Marks, tags and branches

- **Pull box** marks the last point as a pull point: no elbow, and the bend count restarts. The label shows each section, for example `Bends 270° | 270°`.
- **Up** and **Down** mark a riser or a drop, counted as a 90° vertical bend and drawn with the usual symbols.
- **Tag** gives the run an ID such as a feeder number (`F-3`).
- Start a run on another run of the same kind to branch from it. The app derives a tee, a cross or a reducer from the geometry and adds it to the fittings.
- Over 360° of bends in one pull section, the label shows a red warning.

### Schedule and fill

- The Measurements panel shows a **Raceway schedule** for the page or document: one row per tag and size, with runs, total length, fittings by kind and the worst pull section. **Place on page** adds it as a table.
- **Conduit fill**: in the Properties panel of a conduit run, list the conductors (count, size from 14 AWG to 500 kcmil, insulation THHN/THWN-2, XHHW-2 or RHH/RHW-2). The panel shows the fill against the NEC Chapter 9 Table 1 limit (53 % for one conductor, 31 % for two, 40 % for more). **Size conduit** picks the smallest trade size that fits.

The bend total and the fill percentage are aids. Check both against the project specification and the manufacturer's data.

## Dynamic Fill

**Tools ▸ Measure ▸ Dynamic Fill** (J) is a paint-bucket fill for vector drawings. Click inside a room, and the region bounded by the drawing's linework fills.

| Action | Result |
|---|---|
| Click inside a region | Fills it, replacing any current fill |
| Hold and drag | Adds every region the cursor passes |
| Drag a closed loop | Also adds every closed region inside the loop |
| Shift+click or Ctrl+click | Adds a region, or removes one that is already filled |
| **Boundary** mode | Click points to draw a temporary boundary, for example across a door |
| **Gap** (pt) | Closes openings up to this width between line ends; 0 turns it off |
| **Create** | Space, Area (default), Perimeter, Polylength, Volume or Polygon |
| **Apply**, Enter or right-click | Creates the chosen markups and clears the fill |
| **Clear ▾** | Clear All, Clear Fill or Clear Boundaries |
| Backspace | Undoes the last boundary point or fill |
| Esc | Cancels and returns to Select |

**⚙ Settings**: fill colour, boundary colour, **Ignore lines thinner than** (pt) to skip hatching and dimension lines, and **Hide markups while filling**.

Islands such as columns are cut out of the area. The fill works on vector linework only; a scanned sheet cannot be filled.

## Edit tools

- **Offset** (O): click a line, polyline, polygon, area or similar, enter a distance in the page's calibrated unit, then click the side. Closed shapes offset inside or outside, with mitred corners. The copy keeps the style and re-measures its values.
- **Lasso** (Shift+O): see [Selecting](#selecting-and-editing-markups).
- **Move** moves the selection from a base point.
- **Multiply…** makes copies at a fixed offset.
- **Snapshot**, **Screenshot** and **Vector Snippet**: see [Capture](#capture-photos-attachments-snapshots).
- **Redaction ▸ Mark for Redaction** marks areas; **Apply Redactions** removes the marked content for good.
- **PDF Content ▸ Edit Text** changes text that is part of the page; **Add Text** adds new page text.
- **Image** submenu: Crop Image, Grayscale, Reset Adjustments for a selected image markup.

## Sketch to Scale

**Tools ▸ Sketch to Scale** holds CAD-style edit tools for lines and polylines:

- **Trim**: cut a line or polyline where it crosses another.
- **Extend**: extend a line to meet another.
- **Split**: one click splits a line in two. **Break**: two clicks on the same line remove the span between them.
- **Lengthen**: click a line near the end to move, then click the new position; the line keeps its direction.
- **Array**: copy the selection a number of times from a base point.
- **Join** and **Explode**: join pieces into one polyline, or split a polyline into lines.

The same commands are available as typed two-letter chords; see [Keyboard shortcuts](#keyboard-shortcuts).

## Flatten and unflatten

**Document ▸ Flatten…** (Ctrl+Shift+M) burns markups into the page content.

- **Pages**: all, current, or a range such as `1-3, 5`.
- **Markups**: all, the selected ones, or by type.
- **Allow unflatten** (on by default) keeps a private copy in the PDF so that **Document ▸ Unflatten** (Ctrl+Shift+U) can restore the markups exactly. With it off, nothing private stays in the file.

Flatten is a normal document change: Ctrl+Z undoes it, and Save writes it. The markup menu also has **Flatten** for the selection.

## Capture: photos, attachments, snapshots

### Photos on markups

- Right-click a markup ▸ **Attach Photo…**, or **Tools ▸ Attach Photo…**, or **Properties ▸ Capture**. Pick one or more JPEG or PNG files. A markup holds up to 50 photos.
- Photos are downsized to a longest edge of 2048 px by default. The EXIF capture date is kept.
- **View Photos** opens a viewer with previous and next, thumbnails, file name, date, size, **Save…** and **Remove**.
- The Markups List **Attachments** column shows the count, and a hover shows thumbnails.
- Photos are embedded in the PDF, so any PDF reader lists them as attachments.

### File Attachment

**File Attachment** (F): click on the page and pick a file. A push pin is placed with the file embedded. Double-click opens a document, image or media file with the system program and offers Save for anything else. Executables and scripts are never opened.

### Snapshots and screenshots

- **Snapshot** (G): drag a rectangle to copy a sharp image of that region to the clipboard. Ctrl+V places it as an image.
- **Edit ▸ Screenshot ▸ Full Page** and **Region** copy the page or a region as an image. **Place Last as Overlay** places the last capture on the page.
- **File ▸ Annotate Screenshot** opens the image on the system clipboard as a new document to mark up. With the Preferences option on, PrtScn does this directly.
- **Vector Snippet ▸ Cut Snippet**: click two corners to cut a region of a page as vector content. **Paste Snippet** pastes it into another drawing.

## Visual Search

**Tools ▸ Visual Search** finds copies of a symbol on the sheet by image matching.

1. Drag a rectangle around one symbol.
2. Choose **Current page** or **All pages**. **Rotations** also finds copies turned 90°, 180° or 270°. **Scale ±10 %** finds copies slightly smaller or larger.
3. Click **Search**. Results appear as pages are searched.
4. Set **Similarity** with the slider (92 % by default), and include or exclude rows.
5. **Create count markups** places one count per result in the chosen count category. **Highlight** places a rectangle highlight over each result instead.

Matching runs on the page image in the app; nothing is uploaded. Results are not saved.

## Page and document tools

- **Document Properties** (Ctrl+D): title, author, subject, keywords and file details.
- **Page Setup**: change the page size, with presets.
- **Rotate Pages**: turn pages left or right in the file.
- **Insert Pages**: blank pages or pages from another PDF. **Extract Pages**, **Delete Pages**, **Reorder Pages**.
- **Crop**: crop to the content, or set crop margins.
- **Shift Page**: move the page content by millimetres, on all, even, odd or chosen pages.
- **Deskew**: draw a line along something that should be straight, and the page is straightened.
- **Page Labels**: define page labels such as sheet numbers.
- **Headers & Footers**: six text slots with `{page}`, `{pages}`, `{date}`, `{time}` and `{filename}`.
- **Watermark ▸ Add Watermark** and **Manage Watermarks**.
- **Reduce File Size**: renders each page as a JPEG at 100, 150 or 200 dpi. Text becomes an image.
- **Batch ▸ Link ▸ Generate Bookmarks from Page Labels** replaces the bookmarks with one per page, titled with its label.

## Batch operations

The Batch menu runs single-document operations over many PDFs. No PDF needs to be open.

| Entry | What it does |
|---|---|
| Combine | Merges PDFs into one |
| Crop & Page Setup… | Crops to the content, or sets the page size |
| Rotate… | Turns the chosen pages 90° either way or 180° |
| Split… | Every N pages, or one file per page range |
| Headers & Footers… | Adds header and footer text |
| Apply Stamp… | Places a stamp at one of nine positions; fields are filled per file and page |
| Link | New Batch Link, Remove Batch Links, Set Batch Link, Generate Bookmarks from Page Labels |
| Compare, Overlay | Opens Compare, which runs page pairs in batch |
| Slip Sheet | Starts the Drawing Set slip sheet flow |
| OCR… | Adds a searchable text layer (desktop only) |
| Reduce File Size… | Renders pages as JPEG at 100, 150 or 200 dpi |
| Repair… | Rewrites each file with a fresh cross-reference table |
| Flatten… | Burns markups into the pages, with or without allow unflatten |
| Summary… | One markup summary for all files, as CSV, XLSX or PDF |
| Print… | One print job per file (desktop only) |

Security, Sign & Seal and Script are listed but not available.

The batch dialog:

- **Files**: the current set, **Add files**, or **Add folder** (desktop). Each row shows its status.
- **Options**: what the single-document command asks for, and the pages (all, first, last or a range).
- **Output**: **Save to a folder with suffix** (the default) never overwrites a source; a taken name gets `(2)`, `(3)`. **Save in place** overwrites the sources after a confirmation, and refuses a file that is open in a tab.
- **Run** and **Cancel run**. A failed file is logged and the run continues. Files finished before a cancel keep their output.

### Batch Link

- **New Batch Link…** turns sheet references and detail callouts (such as `5/S-201`) in the text of the open document into links. Options: whole word, match case, skip links to the same page. Save writes the links.
- **Set Batch Link…** does the same over several PDFs. Its default targets are PDF page labels. Select **Review links using current registered sheet IDs** to resolve references through the drawing set's stable sheet IDs, paths, and pages. The review shows ready, unregistered, ambiguous, and unverified references before you create copies; only ready links can be selected. A registered sheet without a recorded PDF fingerprint needs verification in the drawing set first. References to another file become relative links between files. The copies are written into an empty folder you choose, keeping the subfolders, so the links still work when the folder moves.
- **Remove Batch Links** removes only links made by Batch Link.
- A link to another PDF opens that file in a tab. Only plain relative paths to `.pdf` files are followed, and a target outside the current folder asks first.

## OCR

**Document ▸ OCR…** adds an invisible, searchable text layer to scanned pages, using Tesseract. The page looks the same.

- Language: Auto-detect (per page), English, Chinese (Traditional), or Chinese (Traditional) + English.
- Undo removes the layer before you save.
- **Batch ▸ OCR…** does the same over many files.

OCR runs on the desktop only.

## CAD import and export

### Import DWG or DXF

**File ▸ Import ▸ CAD drawing (DWG, DXF)** turns a drawing into a PDF page to scale.

- **Layers**: tick the layers to include, filter by name (with `*` and `?`), leave out non-plotting layers, keep layers as PDF layers, or take excluded layers along hidden.
- **Coordinates**: model space or a layout; drawing units (from the file, or millimetres when the file states none); area (extents, limits or a window); scale (fit to paper or a custom scale); paper size, margin, rotation and placement. Large coordinates are shifted to keep accuracy.
- **Write the measuring scale** sets the page scale so measurements are correct straight away. **Keep the link to the drawing coordinates** lets an export put geometry back at its model coordinates.
- **Appearance**: colours (as in the file, all black or greyscale), line weights, hatches, line types, text, dimensions, block attributes and points.
- **Import into** a new document, or a new page after the current one. Settings can be saved as presets.
- Drawings older than R13 cannot be read.

### Export DXF or DWG

**File ▸ Export ▸ To CAD…** writes the vector content of pages to DXF (text or binary) or DWG.

- **General**: format, version, pages (one file per page when there are several), drawing unit, and scale (paper size 1:1, the page's measuring scale, or a custom scale).
- **Layers**: PDF layers where present, otherwise by colour and line weight; or by colour and line weight only; or one layer. Annotations can be included on `OPS_…` layers.
- **Area**: whole page, a viewport, or a window in millimetres. Origin at the page, the area, or the model coordinates of an imported drawing, plus an offset.
- **Geometry**: flatten curves or keep splines, merge collinear points, join connecting lines, and how to handle fills and text.

Unsaved changes are not included; save first.

## Other import and export formats

**File ▸ Export** also offers:

- **Export as Images**: PNG or JPEG at 72, 150, 300 or 600 dpi, with or without annotations.
- **Raster PDF**: pages and annotations flattened into images in a new PDF.
- **Annotations (XFDF)**: all annotations as XFDF. **File ▸ Import** reads XFDF back.
- **Issues (BCF)**: annotations as BCF 2.1 topics for BIM tools. **Import Issues (BCF)** reads BCF topics as annotations.
- **PDF/X**: a print-ready file with an sRGB output intent, TrimBox and PDF/X metadata.
- **OpenDocument (ODT)** and **Excel (XLSX)**: page text and tables as editable documents, using OCR text where needed.

## IFC report

**File ▸ Export ▸ IFC Report…** saves an `.ifcreport` file: one JSON document that holds the source PDF and every annotation, mapped onto IFC classes. Walls become IfcWall, slab and steel components become IfcSlab and IfcMember, spaces IfcSpace, grids IfcGrid, and measurements and other markups IfcAnnotation. Tools can read the report without the PDF beside it.

## Print

**File ▸ Print** (Ctrl+P) opens the print dialog.

- **Printer**: name, status, Properties and Page Setup.
- **Copies** and **Collate**.
- **Page Range**: all, current, or custom pages such as `1-3, 5, 8-10`; odd or even subset; reverse order.
- **Page Placement and Scaling**: Fit, Actual Size, Shrink to Printable Area, or a custom scale; Auto-Rotate and Auto-Center.
- **Print**: Document and Markups, or Document only. **Print as Image** sends rasters instead of vectors.
- The preview warns when a page will be cut off or falls outside the printable area.
- **Save as PDF** writes the print output as a PDF that keeps the sheet orientation, with text and lines as vectors.

Markups on hidden or non-printing layers are left out.

## Themes and preferences

### Themes

**View ▸ Theme** switches between **Oculith Dark** and **Oculith Light**. The PDF sheet stays white in both. Dark Mode and Dimmer change the drawing, not the app.

### Preferences

**Oculith ▸ Preferences** (Ctrl+,) has these tabs:

- **General**: theme, interface language, author name, restore last session, PrtScn screenshot capture, and the **AI link (MCP)** switch and port.
- **Annotations**: default colour, line width, font size, highlight opacity, and defaults for text boxes, callouts, highlights, notes, shapes, drawing and measurements.
- **Drawing** and **Shapes**: defaults for freehand, lines, arrows, polylines, rectangles, ellipses, polygons and clouds.
- **Markup**: redaction and measurement defaults.
- **Behavior**: angle snap, grid spacing, polar tracking (F10) with its increment and tolerance, object snaps (end points, midpoints, centres, edges, intersections, perpendicular, quadrant, tangent, nearest) and snap radius, auto-select after creation, confirm before deleting, mouse-wheel zoom without Ctrl, and auto-scale markups.
- **Page Display**: thin lines, progressive rendering for heavy drawings, original appearance for imported markups until edited, canvas scrollbars, and which panels show by default.
- **File Association**: make Oculith Draw the default PDF app.
- **Virtual Printer** (Windows): install a printer that sends PDFs printed from any program to this app.

**Reset to Defaults** resets all preferences.

The **AI link (MCP)** lets an AI assistant or a test tool on the same computer operate the app: open, measure, mark up and save documents. It listens only on 127.0.0.1. Turn it off if you do not use it. See [Architecture](ARCHITECTURE.md#automation-mcp-bridge).

### Help tools

- **Help ▸ File Associations** checks and sets the PDF file association.
- **Help ▸ Startup Diagnostics** shows the start-up log file in your file manager, for support.

## Keyboard shortcuts

**F1** opens the full shortcut table. Ctrl also means Cmd on macOS. Single-letter keys work when a PDF is open and the page has focus.

### Tools

| Key | Tool | Key | Tool |
|---|---|---|---|
| V | Select | Shift+V | Pan |
| T | Text Box | W | Typewriter |
| N | Note | Q | Callout |
| H | Highlight | P | Pen |
| Shift+E | Eraser | C | Cloud |
| K | Cloud+ | L | Line |
| A | Arrow | Shift+L | Dimension |
| Shift+N | Polyline | Shift+P | Polygon |
| R | Rectangle | E | Ellipse |
| Shift+C | Arc | S | Stamp |
| I | Image | G | Snapshot |
| F | File Attachment | Shift+F | Flag |
| Shift+H | Hyperlink | O | Offset |
| Shift+O | Lasso | J | Dynamic Fill |
| 1-9, 0 | My Tools slots 1-10 | M | Last measure tool |

### Measure

| Key | Tool |
|---|---|
| Shift+Alt+L | Length |
| Shift+Alt+Q | Polylength |
| Shift+Alt+A | Area |
| Shift+Alt+P | Perimeter |
| Shift+Alt+V | Volume |
| Shift+Alt+G | Angle |
| Shift+Alt+U | Radius |
| Shift+Alt+D | Diameter |
| Shift+Alt+C | Count |

### File and edit

| Key | Command |
|---|---|
| Ctrl+N / Ctrl+O | New / Open |
| Ctrl+S / Ctrl+Shift+S | Save / Save As |
| Ctrl+W | Close |
| Ctrl+P | Print |
| Ctrl+D | Document Properties |
| Ctrl+, | Preferences |
| Ctrl+K or Ctrl+Shift+P | Find Tools + Commands |
| Ctrl+Z / Ctrl+Y or Ctrl+Shift+Z | Undo / Redo |
| Ctrl+Shift+H | Undo History |
| Ctrl+X / Ctrl+C / Ctrl+V | Cut / Copy / Paste |
| Ctrl+Shift+V | Paste in Place |
| Ctrl+A | Select All |
| Delete | Delete markup |
| Arrow keys | Nudge selection |
| Shift+Space | Select next overlapping markup |
| Escape | Finish, or back to Select |
| Ctrl+G / Ctrl+Shift+G | Group / Ungroup |
| Ctrl+Shift+L | Lock or unlock |
| Ctrl+Shift+C | Format Painter |
| Ctrl+Shift+M / Ctrl+Shift+U | Flatten / Unflatten markups |

### View

| Key | Command |
|---|---|
| Ctrl+= / Ctrl+- | Zoom in / out |
| Ctrl+0 / Ctrl+1 / Ctrl+2 | Actual size / Fit width / Fit page |
| Ctrl+4 / Ctrl+6 / Ctrl+7 | Single page / Side-by-side / Continuous side-by-side |
| Ctrl+3 | Dark Mode |
| Ctrl+5 | Thin lines |
| Ctrl+F5 | Dimmer |
| Ctrl+Shift++ / Ctrl+Shift+_ | Rotate page right / left |
| Ctrl+F / F3 | Find / Find next |
| Ctrl+L | Full screen |
| Alt+Left / Alt+Right | Previous / next view |
| Ctrl+Tab / Ctrl+Shift+Tab | Next / previous document |
| Ctrl+Alt+2 / Ctrl+H / Ctrl+Shift+2 | Split vertical / Split horizontal / Unsplit |
| F1 | Keyboard shortcuts |
| F4 / F8 / F9 | Navigation bar / Status bar / Menu bar |
| F7 or Shift+F9 | Show grid |
| Ctrl+Shift+F9 | Snap to grid |
| Ctrl+Shift+F8 | Snap to content |
| Ctrl+Shift+F7 | Snap to markup |
| Shift+F3 | Object snap |
| F10 | Polar tracking |
| F11 / F12 | Markups List / Properties |
| Shift+F4 | Hide or show all panels |

### Panels

| Key | Panel | Key | Panel |
|---|---|---|---|
| Alt+X | Tool Chest | Alt+L | Markups List |
| Alt+T | Thumbnails | Alt+P | Properties |
| Alt+U | Measurements | Alt+Y | Layers |
| Alt+B | Bookmarks | Alt+N | Links |
| Alt+1 | Search | Alt+2 | Drawing Set |
| Alt+Q | Form Fields | Alt+4 | Signatures |
| Alt+S | Spaces | | |

### CAD chords

Type the two letters one after the other, not together.

| Chord | Command |
|---|---|
| T R | Trim |
| E X | Extend |
| T X | Text box |
| T L | Show line weights |
| C S | Create similar |
| M V | Move from base point |
| C O | Copy |
| R O | Rotate |
