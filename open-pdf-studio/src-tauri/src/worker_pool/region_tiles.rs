//! Splitting a page region that is too large for a worker's shared-memory
//! slot into transfer tiles, and placing each tile back into the region.
//!
//! The worker renders every tile on the original region's pixel grid (see the
//! `pixel_clip` request field), so the split only has to be pixel-exact: each
//! pixel of the region belongs to exactly one tile, and no tile's RGBA exceeds
//! the slot's payload.
//!
//! PDFium's antialiasing depends slightly on the bitmap's bounds, so stitched
//! strips can differ from a whole-region render by one or two levels per
//! channel along edges (the worker's `region_pixel_clip` test holds them to
//! that). A column edge through text differs by far more (a visible seam),
//! so the planner only makes full-width strips: a region whose single row is
//! wider than the slot is refused and rendered in process instead.

use std::fmt;

/// Upper bound on transfer tiles for one region. The worker walks the whole
/// page for every tile, so the cost grows with the count; a region that needs
/// more goes to the in-process fallback instead. With the 64 MiB slot this
/// allows a region of roughly 1 GiB RGBA (about 268 megapixels), far beyond
/// what a viewer tile at the highest zoom asks for.
pub const MAX_REGION_TILES: usize = 16;

/// One transfer tile, in pixels of the full region.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct RegionTile {
    pub x: u32,
    pub y: u32,
    pub w: u32,
    pub h: u32,
}

#[derive(Debug, PartialEq, Eq)]
pub enum TileError {
    /// The region has no pixels.
    Empty,
    /// The slot cannot hold a single RGBA pixel.
    PayloadTooSmall,
    /// The region needs more tiles than [`MAX_REGION_TILES`] allows.
    TooManyTiles { needed: u64, cap: usize },
    /// One row of the region is wider than the slot holds: it would need
    /// column tiles, whose edges show through text.
    RowTooWide { width: u32, max: u64 },
    /// A tile or its pixels do not match the region being stitched.
    Mismatch,
}

impl fmt::Display for TileError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            TileError::Empty => write!(f, "region has no pixels"),
            TileError::PayloadTooSmall => write!(f, "shared memory slot holds no pixel"),
            TileError::TooManyTiles { needed, cap } => {
                write!(f, "region needs {needed} transfer tiles (cap {cap})")
            }
            TileError::RowTooWide { width, max } => {
                write!(f, "region row of {width} px is wider than a transfer tile ({max} px)")
            }
            TileError::Mismatch => write!(f, "region tile does not match the region"),
        }
    }
}

impl std::error::Error for TileError {}

/// RGBA byte count of a `width` x `height` bitmap, computed without overflow.
pub fn rgba_bytes(width: u32, height: u32) -> u128 {
    u128::from(width) * u128::from(height) * 4
}

/// Length of the framed wire bitmap (`[w u32][h u32][RGBA]`), if it fits.
pub fn framed_len(width: u32, height: u32) -> Option<usize> {
    usize::try_from(rgba_bytes(width, height)).ok()?.checked_add(8)
}

/// Split a `width` x `height` region into full-width strips whose RGBA fits
/// `payload` bytes: every tile costs a page walk in the worker, strips give
/// the fewest tiles, and no tile edge then cuts text vertically. A row wider
/// than the whole slot is refused ([`TileError::RowTooWide`]). Strips are
/// returned top to bottom.
pub fn plan_region_tiles(
    width: u32,
    height: u32,
    payload: usize,
    max_tiles: usize,
) -> Result<Vec<RegionTile>, TileError> {
    if width == 0 || height == 0 {
        return Err(TileError::Empty);
    }
    let max_pixels = (payload / 4) as u64;
    if max_pixels == 0 {
        return Err(TileError::PayloadTooSmall);
    }
    if u64::from(width) > max_pixels {
        return Err(TileError::RowTooWide { width, max: max_pixels });
    }
    let (width, height) = (u64::from(width), u64::from(height));
    // Both are at least 1: tile_w <= max_pixels, so max_pixels / tile_w >= 1.
    let tile_w = width.min(max_pixels);
    let tile_h = height.min(max_pixels / tile_w);
    let cols = width.div_ceil(tile_w);
    let rows = height.div_ceil(tile_h);
    // cols and rows are each at most u32::MAX, so the product fits u64.
    let needed = cols * rows;
    if needed > max_tiles as u64 {
        return Err(TileError::TooManyTiles { needed, cap: max_tiles });
    }
    let mut tiles = Vec::with_capacity(needed as usize);
    for row in 0..rows {
        let y = row * tile_h;
        let h = tile_h.min(height - y);
        for col in 0..cols {
            let x = col * tile_w;
            let w = tile_w.min(width - x);
            // Every value is bounded by the u32 width or height.
            tiles.push(RegionTile { x: x as u32, y: y as u32, w: w as u32, h: h as u32 });
        }
    }
    Ok(tiles)
}

/// Copy a tile's tightly packed RGBA into the framed region bitmap `framed`
/// of `width` x `height` pixels. Everything is validated first, so a bad tile
/// leaves `framed` untouched.
pub fn stitch_tile(
    framed: &mut [u8],
    width: u32,
    height: u32,
    tile: RegionTile,
    rgba: &[u8],
) -> Result<(), TileError> {
    if framed_len(width, height) != Some(framed.len()) {
        return Err(TileError::Mismatch);
    }
    if tile.w == 0
        || tile.h == 0
        || u64::from(tile.x) + u64::from(tile.w) > u64::from(width)
        || u64::from(tile.y) + u64::from(tile.h) > u64::from(height)
        || rgba_bytes(tile.w, tile.h) != rgba.len() as u128
    {
        return Err(TileError::Mismatch);
    }
    // All offsets below lie inside `framed`, whose length fits usize.
    let pixels = &mut framed[8..];
    let region_row = width as usize * 4;
    let tile_row = tile.w as usize * 4;
    let start = tile.y as usize * region_row + tile.x as usize * 4;
    if tile.w == width {
        pixels[start..start + rgba.len()].copy_from_slice(rgba);
        return Ok(());
    }
    for (row, src) in rgba.chunks_exact(tile_row).enumerate() {
        let dest = start + row * region_row;
        pixels[dest..dest + tile_row].copy_from_slice(src);
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    const SLOT_PAYLOAD: usize = 64 * 1024 * 1024 - 32;

    /// Every tile fits the payload, and the tiles cover each pixel once.
    fn assert_exact_cover(width: u32, height: u32, payload: usize, tiles: &[RegionTile]) {
        let mut seen = vec![0u8; width as usize * height as usize];
        for tile in tiles {
            assert!(tile.w > 0 && tile.h > 0, "empty tile {tile:?}");
            assert!(rgba_bytes(tile.w, tile.h) <= payload as u128, "tile {tile:?} exceeds payload {payload}");
            assert!(tile.x + tile.w <= width && tile.y + tile.h <= height, "tile {tile:?} outside region");
            for y in tile.y..tile.y + tile.h {
                for x in tile.x..tile.x + tile.w {
                    seen[y as usize * width as usize + x as usize] += 1;
                }
            }
        }
        assert!(seen.iter().all(|&n| n == 1), "{width}x{height} at {payload}: not covered exactly once");
    }

    /// Stitch tiles whose pixels encode their own region coordinates, and
    /// check every pixel of the result lands where it belongs.
    fn assert_stitches(width: u32, height: u32, payload: usize) {
        let tiles = plan_region_tiles(width, height, payload, usize::MAX).unwrap();
        assert_exact_cover(width, height, payload, &tiles);
        let mut framed = vec![0u8; framed_len(width, height).unwrap()];
        for tile in &tiles {
            let mut rgba = Vec::with_capacity(tile.w as usize * tile.h as usize * 4);
            for y in tile.y..tile.y + tile.h {
                for x in tile.x..tile.x + tile.w {
                    rgba.extend_from_slice(&[x as u8, (x >> 8) as u8, y as u8, (y >> 8) as u8]);
                }
            }
            stitch_tile(&mut framed, width, height, *tile, &rgba).unwrap();
        }
        for (i, px) in framed[8..].chunks_exact(4).enumerate() {
            let (x, y) = (i % width as usize, i / width as usize);
            assert_eq!(px, [x as u8, (x >> 8) as u8, y as u8, (y >> 8) as u8], "pixel ({x},{y})");
        }
    }

    #[test]
    fn a_region_that_fills_the_slot_exactly_is_one_tile() {
        let tiles = plan_region_tiles(16, 8, 16 * 8 * 4, 16).unwrap();
        assert_eq!(tiles, vec![RegionTile { x: 0, y: 0, w: 16, h: 8 }]);
    }

    #[test]
    fn exact_multiples_split_into_equal_full_width_strips() {
        let tiles = plan_region_tiles(100, 100, 100 * 25 * 4, 16).unwrap();
        assert_eq!(tiles.len(), 4);
        assert!(tiles.iter().enumerate().all(|(i, t)| *t == RegionTile { x: 0, y: 25 * i as u32, w: 100, h: 25 }));
        assert_stitches(100, 100, 100 * 25 * 4);
    }

    #[test]
    fn a_row_remainder_ends_in_a_shorter_strip() {
        // 10 px wide, 40 px slot: strips of 4 rows, last one 3 rows.
        let tiles = plan_region_tiles(10, 23, 40 * 4, 16).unwrap();
        assert_eq!(tiles.len(), 6);
        assert_eq!(*tiles.last().unwrap(), RegionTile { x: 0, y: 20, w: 10, h: 3 });
        assert_stitches(10, 23, 40 * 4);
    }

    #[test]
    fn a_row_wider_than_the_slot_is_refused_rather_than_cut_into_columns() {
        // 10 px slot, 23 px row: columns would cut text; render in process.
        assert_eq!(plan_region_tiles(23, 7, 10 * 4, 64), Err(TileError::RowTooWide { width: 23, max: 10 }));
        // A payload that is not a whole number of pixels rounds down.
        assert_eq!(plan_region_tiles(11, 7, 10 * 4 + 3, 64), Err(TileError::RowTooWide { width: 11, max: 10 }));
        assert_stitches(10, 7, 10 * 4 + 3);
    }

    #[test]
    fn one_pixel_edges_are_kept() {
        assert_stitches(1, 1, 4);
        assert_stitches(1, 50, 4 * 7);
        assert_stitches(7, 1, 4 * 7);
        // 1-row remainders.
        assert_stitches(12, 9, 12 * 4 * 4);
        assert_stitches(4, 5, 4 * 4);
        let tiles = plan_region_tiles(12, 9, 12 * 4 * 4, 16).unwrap();
        assert_eq!(*tiles.last().unwrap(), RegionTile { x: 0, y: 8, w: 12, h: 1 });
    }

    #[test]
    fn regions_wider_than_4096_px_use_full_width_strips_within_the_slot() {
        // The reviewed case: about 10k x 14k px at high zoom.
        let tiles = plan_region_tiles(10_000, 14_000, SLOT_PAYLOAD, MAX_REGION_TILES).unwrap();
        assert_eq!(tiles.len(), 9);
        assert!(tiles.iter().all(|t| t.x == 0 && t.w == 10_000));
        assert!(tiles.iter().all(|t| rgba_bytes(t.w, t.h) <= SLOT_PAYLOAD as u128));
        assert_eq!(tiles.iter().map(|t| u64::from(t.h)).sum::<u64>(), 14_000);
        assert_stitches(5_000, 30, 5_000 * 7 * 4);
    }

    #[test]
    fn every_split_respects_the_payload_and_covers_each_pixel_once() {
        for width in [1, 2, 3, 7, 16, 33] {
            for height in [1, 2, 5, 17, 31] {
                for pixels in [1usize, 2, 3, 5, 16, 40, 1000] {
                    let payload = pixels * 4;
                    if width as usize > pixels {
                        assert!(matches!(plan_region_tiles(width, height, payload, usize::MAX), Err(TileError::RowTooWide { .. })));
                        continue;
                    }
                    let tiles = plan_region_tiles(width, height, payload, usize::MAX).unwrap();
                    assert_exact_cover(width, height, payload, &tiles);
                }
            }
        }
        assert_stitches(33, 31, 33 * 5 * 4);
    }

    #[test]
    fn the_tile_cap_refuses_before_any_work() {
        assert_eq!(
            plan_region_tiles(10_000, 14_000, SLOT_PAYLOAD, 8),
            Err(TileError::TooManyTiles { needed: 9, cap: 8 })
        );
        assert!(matches!(
            plan_region_tiles(u32::MAX, u32::MAX, SLOT_PAYLOAD, MAX_REGION_TILES),
            Err(TileError::RowTooWide { .. })
        ));
        // Full-width strips of a tall region still count without overflow.
        assert!(matches!(
            plan_region_tiles(1, u32::MAX, 4, MAX_REGION_TILES),
            Err(TileError::TooManyTiles { needed, .. }) if needed == u64::from(u32::MAX)
        ));
    }

    #[test]
    fn overflow_and_degenerate_input_is_refused() {
        assert_eq!(plan_region_tiles(0, 10, SLOT_PAYLOAD, 16), Err(TileError::Empty));
        assert_eq!(plan_region_tiles(10, 0, SLOT_PAYLOAD, 16), Err(TileError::Empty));
        assert_eq!(plan_region_tiles(10, 10, 3, 16), Err(TileError::PayloadTooSmall));
        assert_eq!(rgba_bytes(u32::MAX, u32::MAX), u128::from(u32::MAX) * u128::from(u32::MAX) * 4);
        if usize::BITS <= 64 {
            assert_eq!(framed_len(u32::MAX, u32::MAX), None);
        }
        assert_eq!(framed_len(3, 2), Some(8 + 24));
    }

    #[test]
    fn a_mismatched_tile_leaves_the_region_untouched() {
        let mut framed = vec![7u8; framed_len(4, 4).unwrap()];
        let before = framed.clone();
        let rgba = vec![0u8; 2 * 2 * 4];
        // Outside the region, on each axis and by u32 wrap-around.
        for tile in [
            RegionTile { x: 3, y: 0, w: 2, h: 2 },
            RegionTile { x: 0, y: 3, w: 2, h: 2 },
            RegionTile { x: u32::MAX, y: 0, w: 2, h: 2 },
            RegionTile { x: 0, y: 0, w: 0, h: 2 },
        ] {
            assert_eq!(stitch_tile(&mut framed, 4, 4, tile, &rgba), Err(TileError::Mismatch));
        }
        // Pixel count disagrees with the tile, or the buffer with the region.
        let tile = RegionTile { x: 0, y: 0, w: 2, h: 2 };
        assert_eq!(stitch_tile(&mut framed, 4, 4, tile, &rgba[..12]), Err(TileError::Mismatch));
        assert_eq!(stitch_tile(&mut framed[..40], 4, 4, tile, &rgba), Err(TileError::Mismatch));
        assert_eq!(framed, before);
        stitch_tile(&mut framed, 4, 4, tile, &rgba).unwrap();
        assert_ne!(framed, before);
    }
}
