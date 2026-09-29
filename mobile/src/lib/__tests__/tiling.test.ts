import { MAX_EDGE, MAX_PARTS, planPages, TILE_WIDTH } from "../tiling";

const coverage = (plan: ReturnType<typeof planPages>[number]) => {
  // Every row of the scaled page must be inside at least one tile.
  let covered = 0;
  for (const t of plan.tiles) {
    expect(t.originY).toBeLessThanOrEqual(covered); // no gaps
    covered = Math.max(covered, t.originY + t.height);
  }
  return covered;
};

describe("planPages", () => {
  it("keeps a normal photo as one image within Claude's size limit", () => {
    const [plan] = planPages([{ width: 3024, height: 4032 }]);
    expect(plan!.tiles).toHaveLength(1);
    expect(Math.max(plan!.scaled.width, plan!.scaled.height)).toBeLessThanOrEqual(MAX_EDGE);
  });

  it("does not upscale small images", () => {
    const [plan] = planPages([{ width: 800, height: 600 }]);
    expect(plan!.scaled).toEqual({ width: 800, height: 600 });
  });

  it("slices a very long receipt photo into overlapping, readable tiles", () => {
    // e.g. a scanned supermarket receipt, 1:8
    const [plan] = planPages([{ width: 1200, height: 9600 }]);
    expect(plan!.tiles.length).toBeGreaterThan(3);
    expect(plan!.scaled.width).toBe(1200); // full width kept, so text stays sharp
    expect(coverage(plan!)).toBe(plan!.scaled.height);
    for (const [i, t] of plan!.tiles.entries()) {
      expect(t.height).toBeLessThanOrEqual(MAX_EDGE);
      if (i > 0) expect(t.originY).toBeLessThan(plan!.tiles[i - 1]!.originY + plan!.tiles[i - 1]!.height); // overlaps
    }
  });

  it("scales wide-but-tall photos down to the tile width before slicing", () => {
    const [plan] = planPages([{ width: 3000, height: 15000 }]);
    expect(plan!.scaled.width).toBe(TILE_WIDTH);
    expect(coverage(plan!)).toBe(plan!.scaled.height);
  });

  it("never exceeds the server's part limit", () => {
    const plans = planPages([
      { width: 1500, height: 12000 },
      { width: 1500, height: 12000 },
    ]);
    expect(plans.reduce((n, p) => n + p.tiles.length, 0)).toBeLessThanOrEqual(MAX_PARTS);
    plans.forEach((p) => expect(coverage(p)).toBe(p.scaled.height));
  });

  it("rejects receipts that cannot fit in the part limit", () => {
    expect(() => planPages(Array.from({ length: 13 }, () => ({ width: 1000, height: 1000 })))).toThrow();
  });
});
