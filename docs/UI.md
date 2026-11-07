# Workspace

How the Foundation window is organised. Steps for each command are in the
[user guide](GUIDE.md). This page is the map of that window.

_Verified against the user guide on `main` `910d443`, 31 October 2026._

## The stack

From top to bottom:

1. **Menu bar**, on the same row as the window controls. The menus are
   Oculith, File, Edit, View, Document, Batch, Tools, Window, and Help.
2. **Properties toolbar**, directly under the menus. Its contents follow the
   selection.
3. **Document tabs.**
4. **Work area.** Left, right, and bottom panel hosts, each with an access
   bar. Markup, draw, and measure toolbars stand on the right edge.
5. **Navigation bar** (F4). Split and page mode, selection tools, the page
   field, zoom, page size, page scale, dimmer, theme, and profile.
6. **Bottom panel.** The Markups List is the usual tab.
7. **Status bar** (F8). The command hint, snap toggles, scale, size, and
   cursor position.

The sheet in the centre stays white. Application colours do not tint it.

## Profiles and panels

A profile stores which panels are open, which host they sit in, their widths,
and which toolbars show. **Oculith ▸ Profiles**, or the profile control on
the navigation bar, switches them. The default Oculith profile opens the Tool
Chest on the left, the markup and measure toolbars on the right, and the
Markups List below the sheet.

A panel tab can move to the left, right, or bottom host. On the desktop app,
dragging the Thumbnails header out of the window floats it as a small Pages
tool window beside the drawing. It filters by sheet, title, or page, remembers
where it was put, and docks back into the side panel. It closes when its
drawing window closes.

## Launch

Startup shows the Oculith mark and the product name, then the work area. With
no document open, the work area reads “No PDF Selected”. **File ▸ Open**
loads a local PDF. No add-on is required for that path.

## Where to read next

| Question | Page |
|---|---|
| What does this command do? | [User guide](GUIDE.md) |
| How is the window built? | [Architecture](ARCHITECTURE.md) |
| How does an add-on add a panel? | [Add-ons](ADDONS.md) |
| Is this commit in good shape? | [Status](STATUS.md) |
