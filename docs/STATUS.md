# Status

Checked 15 November 2026. This page describes the prepared editor source
synchronization. It does not claim that a new installer has been published.

## Current editor

The workspace includes markup, calibrated measurement, the Pages window,
comparison, drawing sets, native PDF layers and the documented output routes.
It starts as a complete local drawing tool without an installed add-on.
The guide, architecture and build instructions remain the references for
supported workflows and limitations.

The earlier assessed public main was `9d1df24`.
[Foundation CI 42589229364](https://github.com/GhostTekz/oculith-foundation/actions/runs/42589229364)
passed. Public main subsequently advanced to `2cefe8b`; this synchronization
starts from that newer editor and retains its signed-release updater. The old October failure
about an empty edition symbol list no longer describes current public main.

## Stabilization evidence

- The current editor source baseline passed 4,563 unit tests with eight
  skips. Type checking and production frontend compilation passed.
- Edition-dependent interface modules now load serially. An older Linux
  WebKit exposed an uninitialized namespace when concurrent imports reached
  a shared cyclic output chunk; the serial production bundle starts there.
  The independent early runtime modules still load in parallel.
- Web PDFium rendering now applies page UserUnit to raw coordinates while
  keeping viewport translations in their effective units. Missing or invalid
  metadata retains the PDF.js rendering route before worker I/O.
- `scripts/pdfium-userunit-smoke.mjs` compares actual PDFium WASM and PDF.js
  pixels on synthetic pages: 128 full-page/region renders cover UserUnit 1/2,
  a nonzero CropBox, every page/view rotation and DPR 1/2. The original matrix
  fails this test; the corrected matrix passes. Edge differences may be one
  pixel because the two renderers antialias differently.
- A modified exported editor rebuild loaded a separately installed add-on
  through the published interface and also started without it in Chromium.
  A Linux native development trial checked blank PDF creation, markup,
  undo/redo, calibrated measurement, two saves with reopen, and PDFium pixels.

## Remaining acceptance

Source and controlled browser/native trials do not qualify every installer.
Build the platform packages from the selected published source commit, check
their notices and source route, and repeat native acceptance with each
package's own runtime. Windows and macOS native behavior remains unverified
by this Linux trial. The existing geometry, layer-output and file-fidelity
limits in the guide remain in force.

The [development baseline](DEVELOPMENT-BASELINE.md) is the historical
30 October record. Its installer results are not evidence for this snapshot.
