export type IndexStatus = "idle" | "indexing" | "ready" | "stale" | "error";

export interface IndexBlockStats {
  rows: number;
  cols: number;
  totalCells: number;
  nonEmptyCells: number;
  textCells: number;
  numberCells: number;
  booleanCells: number;
  dateLikeCells: number;
  formulaCells: number;
  blankCells: number;
  styleSignals: number;
  density: number;
  objectCount: number;
  freezeProximity: "near" | "far";
  topStyles: string[];
  headerTokens: string[];
}

export interface IndexBlock {
  blockId: string;
  sheetId: number;
  sheetName: string;
  range: string;
  descriptor: string;
  stats: IndexBlockStats;
  vector?: Float32Array;
}

export interface WorkbookIndex {
  workbookId: string;
  modelId: string;
  indexVersion: number;
  createdAt: number;
  updatedAt: number;
  blockCount: number;
  blocks: IndexBlock[];
}

export interface RetrievedIndexBlock {
  score: number;
  block: Pick<
    IndexBlock,
    "sheetId" | "sheetName" | "range" | "descriptor" | "stats"
  >;
}
