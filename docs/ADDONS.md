# Add-ons

Oculith Draw Foundation works on its own. It also exposes versioned interfaces for optional, locally installed add-ons. The host selects at most one full edition package per user, then loads zero or more [independent add-on packages](ADDON-PACKAGES.md) in a defined order when the app starts.

## Host contract

A full edition package supplies `plugin.js` and a `manifest.json`; it may also supply `plugin.css` and a native helper. The script exports the edition composition and uses the published host modules in `open-pdf-studio/js/plugin/host.js`. The editor provides empty defaults when no full edition package is selected. A sample add-on and browser smoke test are in `open-pdf-studio/scripts/fixtures/recombination-addon/` and `open-pdf-studio/scripts/addon-recombination-smoke.mjs`.

The full edition manifest uses schema version 1. Its `editorVersion` must **exactly** match the installed editor version, and `hostApiVersion` must match the host API version (currently 1). Its `files` map lists each package file with its SHA-256 digest; the loader verifies those digests before loading the script. A full edition script may be split into module files that `plugin.js` imports (statically, or with `import()` for a feature it loads on first use). Each one is named `chunks/<name>.js` (letters, digits, `.`, `-` and `_`), listed in the manifest's `modules` array and, like every file, in `files` with its digest; at most 48, each and all together at most 64 MiB. The editor serves the verified module files beside `plugin.js`, so relative imports between them work; when it hands the program over as text instead (a development build), it links the files in memory. The static imports between the files must not form a cycle. A package without `modules` is a single-file script, as before. A `target` names an operating system (`linux`, `windows`, or `macos`) and architecture (`x64`, `arm64`, or `universal` on macOS). If a target is present, it must match the running app. A package with a native helper or other `bin/` files must specify a target. A script-only package may omit it.

These checks catch mismatched or changed files. They do not establish who created a package. Add-on code runs with the editor's privileges and the interface is not a security sandbox. Install add-ons only from a source you trust.

An add-on may request `js/sets/register-context.js` from the host when that module is available. Its `drawingSetSnapshot()` function returns a frozen copy of the local drawing-set name, stable sheet IDs, labels, titles, current sources, earlier sources, and recorded PDF fingerprints. It exposes no register write method. Check `host.provides('js/sets/register-context.js')` before adding the module to `requires` when supporting older compatible editor builds. A recorded fingerprint describes the saved PDF bytes at the time of registration; add-ons must check the current file before treating a source as verified.

For incoming drawing revisions, an add-on may read a PDF that is not open with `js/pdf/pdf-inspect.js` (`withPdfDocument(bytes, read)` hands `read` a PDF.js document and destroys it afterwards), read title blocks and match sheet IDs with `js/sets/sheet-title-suggest.js` and `js/sets/slip-sheet-match.js`, and read an .xlsx with `js/pdf/xlsx-read.js`. To record new revisions in the drawing set it opens the Slip Sheet confirmation with its rows through `js/solid/stores/dialogStore.js` (`openDialog('slipSheet', { files, rows, revision, onDone, onCancel })`); the set changes only when the user confirms there.

An add-on can also add tools to the AI link (MCP) through `js/mcp/addon-tools.js`; see [Add-on tools for the AI link](ADDON-TOOLS.md).

## Install, update, and remove

The full edition package belongs under `addons/active/` in the app's effective per-user data directory, with `manifest.json` and all files named by its `files` map inside that directory.

The editor installs it for you. Open **Extensions → Local add-ons** and choose **Install add-on file…** for an add-on file (see below), or **Install package folder…** for an unpacked package folder; the editor recognises schema version 1 and installs it as the edition package. It checks the package with the same rules the loader uses at startup, copies the manifest and every listed file (including subfolders such as `bin/`, and keeping executable permissions on Unix) into a staging folder inside `addons/`, checks the copy again, and then swaps it into `addons/active/`. The previous package is kept as `addons/.previous-active/` until the new one is in place and is restored if the swap is interrupted. The panel shows the installed edition package with its ID and version and a **Remove** action. Removal returns the editor to its built-in defaults and any enabled independent packages. Installation, replacement, and removal take effect after restarting the app because selection is fixed for each process; the panel offers **Restart now** after a change.

You can still remove `addons/active/` by hand while the app is closed. See [Independent add-on packages](ADDON-PACKAGES.md) for their builder and installer.

## Add-on files

An add-on file (`.ocaddon`; `.zip` is accepted too) is a zip archive that carries one or more verified packages, so a distributor can ship an add-on as a single download. It holds either one package at its root (a `manifest.json` next to the package files) or one folder per package at the top level, each with its own `manifest.json`. A schema version 1 package is installed as the edition package; schema versions 2–4 are installed as independent packages. An add-on file can carry at most one edition package and 16 packages.

Opening an add-on file with the desktop app (for example by double-clicking it once the app is associated with `.ocaddon`) asks for confirmation, installs it, and offers a restart. The editor extracts the whole file into a staging folder and verifies every package before it installs any of them. It rejects absolute paths, `..` components, drive names, links and other special files, encrypted or repeated entries (including names that differ only in case), more than 512 entries, files a manifest does not list, a manifest over 1 MiB, `plugin.js` over 64 MiB, `plugin.css` over 16 MiB, any other file over 128 MiB, and more than 512 MiB in total. If writing to disk fails after verification, the error names the packages that were already installed.

To build an add-on file from package folders, run from `open-pdf-studio/`:

```sh
node scripts/pack-addon-file.mjs --package ./my-edition-package --package ./my-addon-package --output ./my-addon.ocaddon
```

The builder verifies each folder first, refuses unlisted files and duplicate IDs, and writes a deterministic archive: sorted entries, a fixed timestamp, and Unix permissions that keep native files executable. One package goes at the archive root; several go into one folder per package ID.

The native helper, when supplied, is part of the same selected package and is hash checked before use. Foundation itself ships no add-on implementation or helper.

## A package included with an installation

A distributor may build the unchanged Foundation source into its own installer with one full edition package already inside. The package goes in the installer's resources as `edition-package/` (the same files as `addons/active/`), for example with a Tauri configuration overlay that adds the resource and sets the distributor's product name, identifier and icons. At start-up the editor checks that package exactly like an installed one (versions, target, and the SHA-256 of every file) and loads it in place; its native helper runs from the same verified directory. Nothing is copied into the user's profile.

A package the user installs in `addons/active/` takes precedence over the included one. **Local add-ons** lists the included package as *Included with this installation*; it is removed by uninstalling that installer, not from the app. The public Foundation installers include no package.

## Documents and licence

Foundation keeps extension data in a PDF when a full edition package is unavailable, so opening and saving the document does not require that package. If the editor cannot safely preserve unknown annotation data, it refuses the save instead of silently discarding it. Features supplied by the package are available again when a compatible package is installed.

Foundation remains licensed under the LGPL-3.0 when an add-on is installed. You may obtain, modify, rebuild, and redistribute the Foundation source under that licence. An add-on may have its own licence; installing or removing one does not change your rights in Foundation. See [Building from source](BUILDING.md) and the repository's `LICENSE.md` for the editor's source and licence.
