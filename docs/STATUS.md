# Status

Where Oculith Draw Foundation stands. Foundation is the drawing tool: review,
markup, and measurement of local PDF drawings, with no add-on and no network
connection required. This is the status page. The guide, the architecture,
and the build instructions stay the references they are.

_Verified against `main` `910d443`, 31 October 2026. Scores are a self-assessment, not an audit._

## Snapshot

`main` includes the Pages tool window for detached thumbnails, add-on file
install, edition install from a package included with an installer, and
drawing-sheet search by source file name and by several words. The editor
still starts as Foundation when no add-on is selected.

The [development baseline](DEVELOPMENT-BASELINE.md) is the 30 October record
of source and installer checks. Read this page for the current head.

## Checks on this commit

Foundation CI on `910d443` (run 41163102699) ran and failed.

- Source verification passed: 2,921 files, and the packaged notices contained
  no add-on files.
- The offline smoke passed: edit, undo, redo, save, reopen.
- The add-on recombination smoke failed on an edition contract check in
  `js/editions/contract.js`.

The installer workflow last succeeded on 30 October 2026 for commit `41b61c5`
(run 41089255250), building Linux DEB and AppImage, Windows NSIS, and macOS
app artifacts. That commit is older than `910d443`. It does not cover the
Pages tool window or the current `main`.

## Scorecard

Scale: **1** absent, **5** usable with gaps, **8** solid, **10** best in
class. Each score is judgement with a written basis.

| Category | Score | Basis |
|---|:---:|---|
| Drawing workspace | **7** | Menu bar, toolbars, profiles, Markups List, measurements, compare, sets, batch work, and the Pages tool window are on `main` and described in the user guide. |
| File fidelity | **7** | Saves go through pdf-lib, keep untouched objects, and use private keys only for data a standard annotation cannot hold. Native layer switching is still disabled. Some calibration paths still report page points until a scale is set. |
| Add-on boundary | **6** | The host validates one edition package and optional independent packages, and the public source ships none of them. The recombination smoke on this commit fails the edition contract. |
| Packaging | **5** | Installer, notice, and source-route checks exist and last passed on `41b61c5`. Current `main` has no green installer run, and its editor CI is red. |
| Documentation | **7** | Guide, architecture, file format, add-ons, and building pages match the editor. This page is the status record for the current head. |

**Unweighted mean: 6.4.** The drawing tool is broad. This commit is not a
release candidate while the recombination smoke fails and the installer matrix
has not been repeated on it.

## Next checks

1. Make the edition contract accept the editor’s own empty symbol list, and
   re-run Foundation CI on that commit.
2. Dispatch the installer workflow on the commit chosen for a release.
3. Repeat the manual acceptance path in the build guide on those artifacts:
   open a drawing, mark it, measure it, save, reopen, with no add-on installed.
