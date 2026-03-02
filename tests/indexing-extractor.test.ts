import { describe, expect, it } from "vitest";
import {
  generateSheetTiles,
  isLowInformationBlock,
  mergeDenseTiles,
  rangeFromBounds,
  type TileAggregate,
} from "../src/lib/indexing/extractor";
import type { IndexBlockStats } from "../src/lib/indexing/types";

function makeTile(args: {
  gridRow: number;
  gridCol: number;
  startRow: number;
  endRow: number;
  startCol: number;
  endCol: number;
  nonEmptyCells: number;
}): TileAggregate {
  return {
    bounds: {
      ...args,
      range: rangeFromBounds(args),
    },
    sheet: {
      id: 1,
      name: "Sheet1",
      maxRows: 40,
      maxColumns: 40,
      frozenRows: 1,
      frozenColumns: 0,
    },
    stats: {
      rows: args.endRow - args.startRow + 1,
      cols: args.endCol - args.startCol + 1,
      totalCells: (args.endRow - args.startRow + 1) * (args.endCol - args.startCol + 1),
      nonEmptyCells: args.nonEmptyCells,
      textCells: args.nonEmptyCells,
      numberCells: 0,
      booleanCells: 0,
      dateLikeCells: 0,
      formulaCells: 0,
      blankCells:
        (args.endRow - args.startRow + 1) * (args.endCol - args.startCol + 1) - args.nonEmptyCells,
      styleSignals: 0,
      density:
        args.nonEmptyCells /
        ((args.endRow - args.startRow + 1) * (args.endCol - args.startCol + 1)),
    },
    styleHistogram: new Map(),
    headerTokens: [],
  };
}

describe("indexing extractor", () => {
  it("tiles sheet ranges with fixed windows", () => {
    const tiles = generateSheetTiles(45, 30, {
      tileRows: 20,
      tileCols: 15,
      maxTilesPerSheet: 100,
    });

    expect(tiles).toHaveLength(6);
    expect(tiles[0].range).toBe("A1:O20");
    expect(tiles[tiles.length - 1].range).toBe("P41:AD45");
  });

  it("merges adjacent dense tiles into one block", () => {
    const merged = mergeDenseTiles([
      makeTile({
        gridRow: 0,
        gridCol: 0,
        startRow: 0,
        endRow: 19,
        startCol: 0,
        endCol: 19,
        nonEmptyCells: 100,
      }),
      makeTile({
        gridRow: 0,
        gridCol: 1,
        startRow: 0,
        endRow: 19,
        startCol: 20,
        endCol: 39,
        nonEmptyCells: 120,
      }),
    ]);

    expect(merged).toHaveLength(1);
    expect(merged[0].bounds.range).toBe("A1:AN20");
    expect(merged[0].stats.nonEmptyCells).toBe(220);
  });

  it("flags low-information blocks", () => {
    const lowInfo: IndexBlockStats = {
      rows: 20,
      cols: 20,
      totalCells: 400,
      nonEmptyCells: 0,
      textCells: 0,
      numberCells: 0,
      booleanCells: 0,
      dateLikeCells: 0,
      formulaCells: 0,
      blankCells: 400,
      styleSignals: 0,
      density: 0,
      objectCount: 0,
      freezeProximity: "far",
      topStyles: [],
      headerTokens: [],
    };

    expect(isLowInformationBlock(lowInfo)).toBe(true);
  });
});
