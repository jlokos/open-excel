import {
  getAllObjects,
  getCellRanges,
  getWorkbookMetadata,
  type SheetMetadata,
  type WorksheetInfo,
} from "../excel/api";
import type { IndexBlock, IndexBlockStats } from "./types";

export interface IndexingOptions {
  tileRows?: number;
  tileCols?: number;
  densityThreshold?: number;
  maxTilesPerSheet?: number;
  sheetIds?: number[];
}

export interface TileBounds {
  startRow: number;
  endRow: number;
  startCol: number;
  endCol: number;
  gridRow: number;
  gridCol: number;
  range: string;
}

export interface TileAggregate {
  bounds: TileBounds;
  sheet: SheetMetadata;
  stats: Omit<
    IndexBlockStats,
    "objectCount" | "freezeProximity" | "topStyles" | "headerTokens"
  >;
  styleHistogram: Map<string, number>;
  headerTokens: string[];
}

interface TileGroup {
  sheetId: number;
  tiles: TileAggregate[];
}

const DEFAULT_TILE_ROWS = 20;
const DEFAULT_TILE_COLS = 20;
const DEFAULT_DENSITY_THRESHOLD = 0.1;
const DEFAULT_MAX_TILES_PER_SHEET = 400;
const TOP_STYLE_LIMIT = 8;
const HEADER_TOKEN_LIMIT = 10;

function columnIndexToLetter(index: number): string {
  let letter = "";
  let temp = index;
  while (temp >= 0) {
    letter = String.fromCharCode((temp % 26) + 65) + letter;
    temp = Math.floor(temp / 26) - 1;
  }
  return letter;
}

export function rangeFromBounds(bounds: {
  startRow: number;
  endRow: number;
  startCol: number;
  endCol: number;
}): string {
  const start = `${columnIndexToLetter(bounds.startCol)}${bounds.startRow + 1}`;
  const end = `${columnIndexToLetter(bounds.endCol)}${bounds.endRow + 1}`;
  return start === end ? start : `${start}:${end}`;
}

function parseCellAddress(addr: string): { row: number; col: number } | null {
  const match = addr.match(/^([A-Z]+)(\d+)$/i);
  if (!match) return null;

  const letters = match[1].toUpperCase();
  const row = Number.parseInt(match[2], 10) - 1;
  let col = 0;
  for (let i = 0; i < letters.length; i++) {
    col = col * 26 + (letters.charCodeAt(i) - 64);
  }
  return { row, col: col - 1 };
}

function isDateLike(value: unknown): boolean {
  if (value instanceof Date) return true;
  if (typeof value !== "string") return false;
  if (value.length < 6 || value.length > 32) return false;

  const iso = /^\d{4}-\d{1,2}-\d{1,2}/;
  const slash = /^\d{1,2}[/-]\d{1,2}[/-]\d{2,4}$/;
  const monthName = /\b(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)\b/i;
  return iso.test(value) || slash.test(value) || monthName.test(value);
}

function normalizeToken(value: string): string | null {
  const cleaned = value.trim().replace(/\s+/g, " ").slice(0, 32);
  if (!cleaned) return null;
  if (cleaned.length < 2) return null;
  return cleaned;
}

function increment(map: Map<string, number>, key: string) {
  map.set(key, (map.get(key) || 0) + 1);
}

function topKeys(map: Map<string, number>, limit: number): string[] {
  return [...map.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit)
    .map(([key]) => key);
}

export function generateSheetTiles(
  maxRows: number,
  maxColumns: number,
  options: Pick<
    IndexingOptions,
    "tileRows" | "tileCols" | "maxTilesPerSheet"
  > = {},
): TileBounds[] {
  const tileRows = options.tileRows ?? DEFAULT_TILE_ROWS;
  const tileCols = options.tileCols ?? DEFAULT_TILE_COLS;
  const maxTiles = options.maxTilesPerSheet ?? DEFAULT_MAX_TILES_PER_SHEET;

  const tiles: TileBounds[] = [];
  if (maxRows <= 0 || maxColumns <= 0) return tiles;

  let gridRow = 0;
  for (let row = 0; row < maxRows; row += tileRows) {
    let gridCol = 0;
    for (let col = 0; col < maxColumns; col += tileCols) {
      if (tiles.length >= maxTiles) return tiles;
      const endRow = Math.min(maxRows - 1, row + tileRows - 1);
      const endCol = Math.min(maxColumns - 1, col + tileCols - 1);
      const bounds: TileBounds = {
        startRow: row,
        endRow,
        startCol: col,
        endCol,
        gridRow,
        gridCol,
        range: rangeFromBounds({
          startRow: row,
          endRow,
          startCol: col,
          endCol,
        }),
      };
      tiles.push(bounds);
      gridCol++;
    }
    gridRow++;
  }

  return tiles;
}

function analyzeTile(
  worksheet: WorksheetInfo,
  bounds: TileBounds,
  sheet: SheetMetadata,
): TileAggregate {
  const totalCells =
    (bounds.endRow - bounds.startRow + 1) *
    (bounds.endCol - bounds.startCol + 1);

  let textCells = 0;
  let numberCells = 0;
  let booleanCells = 0;
  let dateLikeCells = 0;

  const cells = worksheet.cells || {};
  const formulas = worksheet.formulas || {};
  const styles = worksheet.styles || {};
  const nonEmptyCells = Object.keys(cells).length;
  const formulaCells = Object.keys(formulas).length;
  const blankCells = Math.max(0, totalCells - nonEmptyCells);

  const styleHistogram = new Map<string, number>();
  for (const style of Object.values(styles)) {
    if (style.family) increment(styleHistogram, `font:${style.family}`);
    if (style.sz) increment(styleHistogram, `size:${style.sz}`);
    if (style.bold) increment(styleHistogram, "bold");
    if (style.italic) increment(styleHistogram, "italic");
    if (style.color) increment(styleHistogram, `fontColor:${style.color}`);
    if (style.fgColor) increment(styleHistogram, `fill:${style.fgColor}`);
  }

  const headerTokenSet = new Set<string>();
  const styleSignals = Object.keys(styles).length;

  for (const [addr, value] of Object.entries(cells)) {
    if (typeof value === "string") {
      textCells++;
      if (isDateLike(value)) dateLikeCells++;

      const parsed = parseCellAddress(addr);
      if (parsed && parsed.row <= bounds.startRow + 1) {
        const token = normalizeToken(value);
        if (token) headerTokenSet.add(token);
      }
    } else if (typeof value === "number") {
      numberCells++;
    } else if (typeof value === "boolean") {
      booleanCells++;
    }
  }

  const density = totalCells > 0 ? nonEmptyCells / totalCells : 0;

  return {
    bounds,
    sheet,
    stats: {
      rows: bounds.endRow - bounds.startRow + 1,
      cols: bounds.endCol - bounds.startCol + 1,
      totalCells,
      nonEmptyCells,
      textCells,
      numberCells,
      booleanCells,
      dateLikeCells,
      formulaCells,
      blankCells,
      styleSignals,
      density,
    },
    styleHistogram,
    headerTokens: [...headerTokenSet].slice(0, HEADER_TOKEN_LIMIT),
  };
}

function tileKey(tile: TileAggregate): string {
  return `${tile.sheet.id}:${tile.bounds.gridRow}:${tile.bounds.gridCol}`;
}

function areAdjacent(a: TileAggregate, b: TileAggregate): boolean {
  if (a.sheet.id !== b.sheet.id) return false;
  const dr = Math.abs(a.bounds.gridRow - b.bounds.gridRow);
  const dc = Math.abs(a.bounds.gridCol - b.bounds.gridCol);
  return dr + dc === 1;
}

function mergeGroup(group: TileGroup): TileAggregate {
  const sorted = [...group.tiles].sort(
    (a, b) =>
      a.bounds.gridRow - b.bounds.gridRow ||
      a.bounds.gridCol - b.bounds.gridCol,
  );

  const first = sorted[0];
  let startRow = first.bounds.startRow;
  let endRow = first.bounds.endRow;
  let startCol = first.bounds.startCol;
  let endCol = first.bounds.endCol;

  const styleHistogram = new Map<string, number>();
  const headerTokens = new Set<string>();

  const stats = {
    rows: 0,
    cols: 0,
    totalCells: 0,
    nonEmptyCells: 0,
    textCells: 0,
    numberCells: 0,
    booleanCells: 0,
    dateLikeCells: 0,
    formulaCells: 0,
    blankCells: 0,
    styleSignals: 0,
    density: 0,
  };

  for (const tile of sorted) {
    startRow = Math.min(startRow, tile.bounds.startRow);
    endRow = Math.max(endRow, tile.bounds.endRow);
    startCol = Math.min(startCol, tile.bounds.startCol);
    endCol = Math.max(endCol, tile.bounds.endCol);

    stats.totalCells += tile.stats.totalCells;
    stats.nonEmptyCells += tile.stats.nonEmptyCells;
    stats.textCells += tile.stats.textCells;
    stats.numberCells += tile.stats.numberCells;
    stats.booleanCells += tile.stats.booleanCells;
    stats.dateLikeCells += tile.stats.dateLikeCells;
    stats.formulaCells += tile.stats.formulaCells;
    stats.blankCells += tile.stats.blankCells;
    stats.styleSignals += tile.stats.styleSignals;

    for (const token of tile.headerTokens) headerTokens.add(token);
    for (const [key, count] of tile.styleHistogram.entries()) {
      styleHistogram.set(key, (styleHistogram.get(key) || 0) + count);
    }
  }

  stats.rows = endRow - startRow + 1;
  stats.cols = endCol - startCol + 1;
  stats.density =
    stats.totalCells > 0 ? stats.nonEmptyCells / stats.totalCells : 0;

  return {
    bounds: {
      startRow,
      endRow,
      startCol,
      endCol,
      gridRow: sorted[0].bounds.gridRow,
      gridCol: sorted[0].bounds.gridCol,
      range: rangeFromBounds({ startRow, endRow, startCol, endCol }),
    },
    sheet: sorted[0].sheet,
    stats,
    styleHistogram,
    headerTokens: [...headerTokens].slice(0, HEADER_TOKEN_LIMIT),
  };
}

export function mergeDenseTiles(tiles: TileAggregate[]): TileAggregate[] {
  const remaining = new Map<string, TileAggregate>();
  for (const tile of tiles) remaining.set(tileKey(tile), tile);

  const merged: TileAggregate[] = [];

  while (remaining.size > 0) {
    const [startKey, startTile] = remaining.entries().next().value as [
      string,
      TileAggregate,
    ];
    remaining.delete(startKey);

    const group: TileAggregate[] = [startTile];
    const queue: TileAggregate[] = [startTile];

    while (queue.length > 0) {
      const current = queue.shift();
      if (!current) continue;

      for (const [candidateKey, candidate] of [...remaining.entries()]) {
        if (!areAdjacent(current, candidate)) continue;
        group.push(candidate);
        queue.push(candidate);
        remaining.delete(candidateKey);
      }
    }

    merged.push(mergeGroup({ sheetId: startTile.sheet.id, tiles: group }));
  }

  return merged;
}

function buildDescriptor(block: TileAggregate, objectCount: number): string {
  const stats = block.stats;

  const valueTotal = Math.max(1, stats.nonEmptyCells);
  const ratios = {
    text: ((stats.textCells / valueTotal) * 100).toFixed(1),
    number: ((stats.numberCells / valueTotal) * 100).toFixed(1),
    boolean: ((stats.booleanCells / valueTotal) * 100).toFixed(1),
    dateLike: ((stats.dateLikeCells / valueTotal) * 100).toFixed(1),
    formula: ((stats.formulaCells / valueTotal) * 100).toFixed(1),
  };

  const styleHints = topKeys(block.styleHistogram, TOP_STYLE_LIMIT);
  const headerHints =
    block.headerTokens.length > 0 ? block.headerTokens.join(" | ") : "(none)";
  const freezeProximity =
    block.bounds.startRow <= block.sheet.frozenRows + 5 ||
    block.bounds.startCol <= block.sheet.frozenColumns + 2
      ? "near"
      : "far";

  const lines = [
    `Sheet ${block.sheet.name} (#${block.sheet.id}) block ${block.bounds.range}`,
    `Shape: ${stats.rows}x${stats.cols}, density ${(stats.density * 100).toFixed(1)}%`,
    `Header-like tokens: ${headerHints}`,
    `Value profile: text ${ratios.text}%, number ${ratios.number}%, date-like ${ratios.dateLike}%, boolean ${ratios.boolean}%, formula ${ratios.formula}%`,
    `Style profile: ${styleHints.length > 0 ? styleHints.join(", ") : "default-like"}`,
    `Structure cues: freeze=${freezeProximity}, objectsOnSheet=${objectCount}`,
  ];

  return lines.join("\n");
}

export function isLowInformationBlock(stats: IndexBlockStats): boolean {
  if (stats.totalCells === 0) return true;
  if (stats.nonEmptyCells === 0 && stats.styleSignals === 0) return true;
  return false;
}

export async function extractWorkbookIndexBlocks(
  options: IndexingOptions = {},
): Promise<IndexBlock[]> {
  const tileRows = options.tileRows ?? DEFAULT_TILE_ROWS;
  const tileCols = options.tileCols ?? DEFAULT_TILE_COLS;
  const densityThreshold =
    options.densityThreshold ?? DEFAULT_DENSITY_THRESHOLD;
  const maxTilesPerSheet =
    options.maxTilesPerSheet ?? DEFAULT_MAX_TILES_PER_SHEET;
  const allowedSheetIds = options.sheetIds ? new Set(options.sheetIds) : null;

  const [metadata, allObjects] = await Promise.all([
    getWorkbookMetadata(),
    getAllObjects(),
  ]);

  const objectCountBySheet = new Map<number, number>();
  for (const obj of allObjects.objects) {
    objectCountBySheet.set(
      obj.sheetId,
      (objectCountBySheet.get(obj.sheetId) || 0) + 1,
    );
  }

  const blocks: IndexBlock[] = [];

  for (const sheet of metadata.sheetsMetadata) {
    if (allowedSheetIds && !allowedSheetIds.has(sheet.id)) continue;
    if (sheet.maxRows <= 0 || sheet.maxColumns <= 0) continue;

    const tiles = generateSheetTiles(sheet.maxRows, sheet.maxColumns, {
      tileRows,
      tileCols,
      maxTilesPerSheet,
    });

    const denseTiles: TileAggregate[] = [];
    for (const tile of tiles) {
      const result = await getCellRanges(sheet.id, [tile.range], {
        includeStyles: true,
        cellLimit: tileRows * tileCols,
      });
      const aggregate = analyzeTile(result.worksheet, tile, sheet);

      const shouldKeep =
        aggregate.stats.density >= densityThreshold ||
        aggregate.stats.formulaCells > 0 ||
        aggregate.stats.styleSignals > 0;
      if (shouldKeep) {
        denseTiles.push(aggregate);
      }
    }

    const mergedBlocks = mergeDenseTiles(denseTiles);
    const objectCount = objectCountBySheet.get(sheet.id) || 0;

    for (const merged of mergedBlocks) {
      const topStyles = topKeys(merged.styleHistogram, TOP_STYLE_LIMIT);
      const freezeProximity =
        merged.bounds.startRow <= merged.sheet.frozenRows + 5 ||
        merged.bounds.startCol <= merged.sheet.frozenColumns + 2
          ? "near"
          : "far";

      const stats: IndexBlockStats = {
        ...merged.stats,
        objectCount,
        freezeProximity,
        topStyles,
        headerTokens: merged.headerTokens,
      };

      if (isLowInformationBlock(stats)) continue;

      const descriptor = buildDescriptor(merged, objectCount);
      blocks.push({
        blockId: `${sheet.id}:${merged.bounds.range}`,
        sheetId: sheet.id,
        sheetName: sheet.name,
        range: merged.bounds.range,
        descriptor,
        stats,
      });
    }
  }

  return blocks;
}
