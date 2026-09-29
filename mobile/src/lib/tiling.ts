/**
 * Tiling plan for long receipts. Claude reads images up to 2576 px on the long edge, so one photo of a
 * long receipt would be shrunk until the print is unreadable. Instead each tall page is cut into
 * overlapping portrait tiles that each keep enough pixels for small receipt text.
 */

/** Claude's maximum long edge; larger images are downscaled by the API anyway. */
export const MAX_EDGE = 2576;
/** Plenty for receipt print; keeps tiles at a readable, portrait-ish 1:1.6 shape. */
export const TILE_WIDTH = 1600;
export const TILE_ASPECT = 1.6;
/** Overlap between tiles so no line is cut in half (the server prompt removes the duplicates). */
export const TILE_OVERLAP = 0.12;
/** Must match MAX_IMAGES on the server. */
export const MAX_PARTS = 12;
/** Below this width receipt text gets hard to read even in a tile. */
const MIN_TILE_WIDTH = 900;

export type Size = { width: number; height: number };
export type PagePlan = {
  /** Size to scale the page to before cutting. */
  scaled: Size;
  /** Crop rectangles in scaled coordinates, top to bottom. */
  tiles: { originY: number; height: number }[];
};

function planPage(page: Size, tileWidth: number): PagePlan {
  // Landscape or near-square photo: one image, capped at MAX_EDGE on the long side.
  if (page.width >= page.height / TILE_ASPECT) {
    const scale = Math.min(1, MAX_EDGE / Math.max(page.width, page.height));
    const scaled = { width: Math.round(page.width * scale), height: Math.round(page.height * scale) };
    return { scaled, tiles: [{ originY: 0, height: scaled.height }] };
  }
  const width = Math.min(page.width, tileWidth);
  const scaled = { width, height: Math.round((page.height * width) / page.width) };
  const tileHeight = Math.min(Math.round(width * TILE_ASPECT), MAX_EDGE);
  // A little taller than one tile still fits in one image if it stays within MAX_EDGE.
  if (scaled.height <= MAX_EDGE) return { scaled, tiles: [{ originY: 0, height: scaled.height }] };

  const step = Math.round(tileHeight * (1 - TILE_OVERLAP));
  const tiles: PagePlan["tiles"] = [];
  for (let y = 0; ; y += step) {
    if (y + tileHeight >= scaled.height) {
      // Last tile is aligned to the bottom edge so nothing is lost.
      tiles.push({ originY: Math.max(0, scaled.height - tileHeight), height: Math.min(tileHeight, scaled.height) });
      break;
    }
    tiles.push({ originY: y, height: tileHeight });
  }
  return { scaled, tiles };
}

/** Plans all pages, shrinking tile width if needed so the total stays within MAX_PARTS. */
export function planPages(pages: Size[]): PagePlan[] {
  if (pages.length > MAX_PARTS) throw new Error(`At most ${MAX_PARTS} photos per receipt`);
  let tileWidth = TILE_WIDTH;
  for (;;) {
    const plans = pages.map((p) => planPage(p, tileWidth));
    const count = plans.reduce((n, p) => n + p.tiles.length, 0);
    if (count <= MAX_PARTS || tileWidth <= MIN_TILE_WIDTH) {
      if (count > MAX_PARTS) throw new Error("This receipt is too long to read in one go. Try fewer photos.");
      return plans;
    }
    tileWidth = Math.max(MIN_TILE_WIDTH, Math.round(tileWidth * 0.85));
  }
}
