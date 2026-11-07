# Foundation development baseline

**Historical snapshot, 30 October 2026.** Current posture is in [Status](STATUS.md).
On 31 October, Foundation CI on `910d443` failed the add-on recombination smoke,
and the installer workflow’s last success was commit `41b61c5` (run 41089255250),
which is older than that head.

The merged public code baseline at this snapshot is commit `390955c` (Git tree
`6287555`). This is a development baseline, not a published release.

Foundation is a local PDF drawing editor. It starts with no add-on. The public
source includes a neutral interface for optional packages and local controls
to install, enable, disable, and remove them. No optional package or companion
executable is included in the Foundation source or installer. See
[Add-ons](ADDONS.md) for the host contract and [Architecture](ARCHITECTURE.md)
for the editor structure.

## Source and package checks

From `open-pdf-studio/` in a clean checkout, run
`node scripts/community-export-verify.mjs --published` to check the source
boundary and dependency inventory. The always-running Foundation CI checks
the editor and offline PDF save/reopen path; it compiles native code for
relevant changes and on `main`. The [build guide](BUILDING.md) has the exact
commands and platform dependencies.

The separate installer workflow runs on a schedule, manual dispatch, or a
review label. It builds Linux DEB and AppImage, Windows NSIS, and macOS app
artifacts and audits packaged notices, source route, and Foundation-only
contents. At the time of this snapshot the last three-platform installer proof
was on an earlier #83 source head. A later run, recorded in [Status](STATUS.md),
succeeded for `41b61c5` and still does not cover current `main`. A release
needs an installer run on its exact commit.

Each reviewed installer receipt records the public source commit and Git
tree, the source archive URL, version, notice count, and artifact digest. The
offline release-preparation command in [Building from source](BUILDING.md)
checks those bytes and prepares a local source/installers/receipts bundle.
It does not publish a release or deliver source to recipients.
