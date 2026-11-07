# Oculith Draw Foundation documentation

Oculith Draw Foundation is a free, open-source desktop app for reviewing construction drawings. Open PDF sheets, mark them up, measure them and compare revisions, on your own machine. It is licensed under the LGPL-3.0 and needs no account and no network connection.

Oculith Draw Foundation is made by [Oculith](https://oculith.io). The source is at [github.com/GhostTekz/oculith-foundation](https://github.com/GhostTekz/oculith-foundation).

## Start here

1. Read the first sections of the [user guide](GUIDE.md): the window, opening documents, and the markup tools.
2. Set a scale and measure a sheet: [Measuring](GUIDE.md#measuring).
3. Save reusable tools in the [Tool Chest](GUIDE.md#tool-chest), and review your work in the [Markups List](GUIDE.md#markups-list).
4. To build the app yourself, follow [Building from source](BUILDING.md).
5. To work on the code, read the [architecture](ARCHITECTURE.md), [add-on interface](ADDONS.md), and [file format](FILE-FORMAT.md).
6. For where this commit stands, read [Status](STATUS.md). The [development baseline](DEVELOPMENT-BASELINE.md) is the 30 October check record.

## Documents

### [User guide](GUIDE.md)

The full guide to the app. It covers the window (menus, toolbars, panels, status bar), documents, tabs, sheets, sets and revisions, every markup and measure tool, the Tool Chest, stamps, the Markups List, layers, compare, slip sheets, raceways, Dynamic Fill, batch operations, OCR, CAD import and export, printing, preferences and keyboard shortcuts. Each section says what a feature does and how to use it.

### [Architecture](ARCHITECTURE.md)

How the app is built. It describes the Tauri 2 shell, the SolidJS interface, and the PDF stack: PDFium in a separate worker process, PDF.js for text and structure, and pdf-lib for saving. It also covers the Rust crates for rendering, geometry and CAD, OCR, the MCP automation bridge, the page-coordinate model and the save/reopen contract, with a map of the repository.

### [File format](FILE-FORMAT.md)

What Oculith Draw writes into a PDF. Markups are standard PDF annotations with appearance streams, plus private `OPS_*` keys that let the app restore its own data. The page lists those keys on annotations, pages and the document catalog (custom columns, status sets, spaces, assemblies, layers), and explains what other PDF readers see.

### [Add-ons](ADDONS.md)

How optional local add-ons connect to the editor, what the host validates, and how to install or remove full edition and [independent packages](ADDON-PACKAGES.md).

### [Add-on tools for the AI link](ADDON-TOOLS.md)

How an installed add-on adds tools to the AI link (MCP): the versioned registration hook, the namespaced names, the schema subset, and what the editor does on every call (argument checks, the user's approval for changes, one undo step per change, document text marked as data, the session log).

### [PDF layers](PDF-LAYERS.md)

Showing and hiding the drawing's own layers (optional content groups) from the Layers panel, what each output route (display, print, export, save, snapping, CAD export) does with that view, and the current limits.

### [Status](STATUS.md)

Where `main` stands: the latest continuous-integration result, the last installer run, and a readiness scorecard. Scores are a self-assessment with a written basis.

### [Development philosophy](PHILOSOPHY.md)

Why Foundation stays a complete local drawing tool, how add-ons stay separate, and why the review path comes before new tools.

### [Workspace](UI.md)

The map of the window: menu bar, toolbars, panel hosts, profiles, and the Pages tool window. Command steps stay in the user guide.

### [Building from source](BUILDING.md)

How to build the app on Linux, Windows and macOS. It lists the tools and system libraries you need, the npm commands for a native build and a frontend-only build, the checks to run, the optional GEOS geometry feature, and where the build outputs go.

### [Credits](CREDITS.md)

The open-source projects Oculith Draw is built on. First among them is Open PDF Studio by the OpenAEC Foundation, the upstream editor. The page names each project, what it is used for and its licence, and points to the full notices that ship with the app.

## Licence

Oculith Draw Foundation is licensed under the GNU Lesser General Public License v3.0. Third-party components keep their own licences; see [Credits](CREDITS.md). Oculith and the Oculith logo are trademarks of Oculith.
