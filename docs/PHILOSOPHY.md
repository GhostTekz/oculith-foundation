# Development philosophy

How Oculith Draw Foundation should grow. Foundation is the drawing tool. It
is also the base: a complete editor that optional add-ons can extend, and
that still reviews a drawing when no add-on is installed.

_Verified against `main` `910d443`, 31 October 2026._

## The file is the product

A person opens a PDF on their own machine, marks it, measures it, and saves.
The saved file is the record. Markups are standard PDF annotations. The app
does not need a network connection, and it does not require an add-on, to do
that job.

An add-on may add commands, panels, and a native helper. Removing it and
restarting leaves this editor. Foundation’s licence stays LGPL-3.0-or-later
either way. An add-on’s own licence does not change the editor’s licence.
The public installers include no add-on.

## The open-source bases stay here

This program is built on Open PDF Studio and on PDFium, PDF.js, pdf-lib, and,
when the build enables it, GEOS. Those components keep their licences. GEOS
stays a separate shared library so it can be replaced. Page rendering stays
on the stack named in [Credits](CREDITS.md). The editor is published so a
recipient can rebuild it.

Optional packages talk to the editor through the published host in
[Add-ons](ADDONS.md). They are separate programs. Their source is not part of
this repository. The host checks versions and file hashes. Those checks catch
a damaged package. They do not decide who published it.

## Dependable review, then more tools

The next change should make this path more trustworthy before it adds a tool:

1. Find the sheet.
2. Mark a location.
3. Measure it against a scale that is on the drawing.
4. See that markup in the Markups List.
5. Compare a revision.
6. Save a file another PDF reader can open.

An uncalibrated measurement stays in page points and says the scale is not
set. A feature that cannot preserve unknown annotation data refuses the save
instead of dropping it. Native PDF layer toggles stay unavailable until the
selected state is honoured on every render path.

## How a change is judged

- The user guide describes the window that ships. Architecture describes how
  it is built. This page describes why a change belongs.
- A continuous-integration job is evidence only for the commit it ran on, and
  only when it ran. [Status](STATUS.md) records the latest result.
- One topic has one page. The guide is not a second architecture document,
  and this page is not a command list.
- Chrome uses the Oculith tokens: small radii, compact controls, a neutral
  white sheet. Another product’s names and artwork are not part of this app.

The documentation set follows the [Diátaxis](https://diataxis.fr/) split:
the guide is the task reference, architecture and this page are explanation,
and [Status](STATUS.md) is the lookup for where the project stands.
