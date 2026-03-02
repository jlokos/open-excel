import { type DirtyRange, mergeRanges } from "../dirty-tracker";
import {
  deleteWorkbookIndex,
  loadWorkbookIndex,
  type StoredIndexBlock,
  saveWorkbookIndex,
  type WorkbookIndexRecord,
} from "../storage";
import {
  embedTexts,
  getEmbeddingRuntime,
  INDEX_EMBEDDING_MODEL_ID,
} from "./embeddings";
import { extractWorkbookIndexBlocks } from "./extractor";
import type {
  IndexBlock,
  IndexBlockStats,
  RetrievedIndexBlock,
  WorkbookIndex,
} from "./types";

export const INDEX_VERSION = 1;
export const MAX_INDEX_BLOCKS = 500;
export const MAX_DESCRIPTOR_CHARS = 900;
export const DEFAULT_TOP_K = 6;

export function truncateDescriptor(
  text: string,
  maxChars = MAX_DESCRIPTOR_CHARS,
): string {
  if (text.length <= maxChars) return text;
  return `${text.slice(0, maxChars - 3)}...`;
}

export function cosineSimilarity(a: Float32Array, b: Float32Array): number {
  if (a.length === 0 || b.length === 0) return 0;
  const len = Math.min(a.length, b.length);
  let dot = 0;
  let magA = 0;
  let magB = 0;

  for (let i = 0; i < len; i++) {
    const av = a[i] || 0;
    const bv = b[i] || 0;
    dot += av * bv;
    magA += av * av;
    magB += bv * bv;
  }

  if (magA === 0 || magB === 0) return 0;
  return dot / (Math.sqrt(magA) * Math.sqrt(magB));
}

function toBuffer(vector: Float32Array): ArrayBuffer {
  const copy = new Float32Array(vector.length);
  copy.set(vector);
  return copy.buffer;
}

function fromBuffer(buffer: ArrayBuffer): Float32Array {
  return new Float32Array(buffer.slice(0));
}

function capBlocks(blocks: IndexBlock[]): IndexBlock[] {
  return [...blocks]
    .sort((a, b) => {
      const densityDiff = b.stats.density - a.stats.density;
      if (Math.abs(densityDiff) > 1e-6) return densityDiff;
      return b.stats.nonEmptyCells - a.stats.nonEmptyCells;
    })
    .slice(0, MAX_INDEX_BLOCKS);
}

function serializeBlocks(blocks: IndexBlock[]): StoredIndexBlock[] {
  return blocks
    .filter((block) => block.vector && block.vector.length > 0)
    .map((block) => ({
      blockId: block.blockId,
      sheetId: block.sheetId,
      sheetName: block.sheetName,
      range: block.range,
      descriptor: block.descriptor,
      stats: block.stats as unknown as Record<string, unknown>,
      vector: toBuffer(block.vector as Float32Array),
    }));
}

function deserializeRecord(record: WorkbookIndexRecord): WorkbookIndex {
  return {
    workbookId: record.workbookId,
    modelId: record.modelId,
    indexVersion: record.indexVersion,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    blockCount: record.blockCount,
    blocks: record.blocks.map((block) => ({
      blockId: block.blockId,
      sheetId: block.sheetId,
      sheetName: block.sheetName,
      range: block.range,
      descriptor: block.descriptor,
      stats: block.stats as unknown as IndexBlockStats,
      vector: fromBuffer(block.vector),
    })),
  };
}

async function embedBlocks(blocks: IndexBlock[]): Promise<IndexBlock[]> {
  if (blocks.length === 0) return [];
  const descriptors = blocks.map((b) => truncateDescriptor(b.descriptor));
  const vectors = await embedTexts(descriptors);

  return blocks.map((block, idx) => ({
    ...block,
    descriptor: descriptors[idx],
    vector: vectors[idx],
  }));
}

export async function loadWorkbookVectorIndex(
  workbookId: string,
): Promise<WorkbookIndex | null> {
  const stored = await loadWorkbookIndex(workbookId);
  if (!stored) return null;
  return deserializeRecord(stored);
}

export async function buildFullWorkbookIndex(
  workbookId: string,
): Promise<WorkbookIndex> {
  const startedAt = performance.now();
  const extracted = await extractWorkbookIndexBlocks();
  const embedded = await embedBlocks(capBlocks(extracted));

  const now = Date.now();
  const record: WorkbookIndexRecord = {
    workbookId,
    modelId: INDEX_EMBEDDING_MODEL_ID,
    indexVersion: INDEX_VERSION,
    createdAt: now,
    updatedAt: now,
    blockCount: embedded.length,
    blocks: serializeBlocks(embedded),
  };

  await saveWorkbookIndex(record);

  const elapsed = performance.now() - startedAt;
  console.log("[Index] Full build complete", {
    runtime: getEmbeddingRuntime(),
    blockCount: embedded.length,
    durationMs: Math.round(elapsed),
  });

  return deserializeRecord(record);
}

export async function updateIndexForDirtyRanges(
  workbookId: string,
  dirtyRanges: DirtyRange[],
): Promise<WorkbookIndex> {
  const merged = mergeRanges(dirtyRanges);
  if (merged.length === 0) {
    const existing = await loadWorkbookVectorIndex(workbookId);
    if (existing) return existing;
    return buildFullWorkbookIndex(workbookId);
  }

  const startedAt = performance.now();
  const targetSheetIds = new Set(merged.map((r) => r.sheetId));

  const existing = await loadWorkbookVectorIndex(workbookId);
  const replacements = await embedBlocks(
    capBlocks(
      await extractWorkbookIndexBlocks({
        sheetIds: [...targetSheetIds],
      }),
    ),
  );

  const preservedBlocks = (existing?.blocks || []).filter(
    (block) => !targetSheetIds.has(block.sheetId),
  );
  const combined = capBlocks([...preservedBlocks, ...replacements]);

  const now = Date.now();
  const record: WorkbookIndexRecord = {
    workbookId,
    modelId: INDEX_EMBEDDING_MODEL_ID,
    indexVersion: INDEX_VERSION,
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
    blockCount: combined.length,
    blocks: serializeBlocks(combined),
  };

  await saveWorkbookIndex(record);

  const elapsed = performance.now() - startedAt;
  console.log("[Index] Incremental update complete", {
    runtime: getEmbeddingRuntime(),
    dirtyRanges: merged.length,
    changedSheets: [...targetSheetIds],
    blockCount: combined.length,
    durationMs: Math.round(elapsed),
  });

  return deserializeRecord(record);
}

export async function queryIndex(
  workbookId: string,
  queryText: string,
  k = DEFAULT_TOP_K,
): Promise<RetrievedIndexBlock[]> {
  const index = await loadWorkbookVectorIndex(workbookId);
  if (!index || index.blocks.length === 0) return [];

  const [queryVector] = await embedTexts([truncateDescriptor(queryText, 512)]);
  if (!queryVector || queryVector.length === 0) return [];

  return [...index.blocks]
    .map((block) => {
      const score = cosineSimilarity(
        queryVector,
        block.vector || new Float32Array(0),
      );
      return {
        score,
        block: {
          sheetId: block.sheetId,
          sheetName: block.sheetName,
          range: block.range,
          descriptor: block.descriptor,
          stats: block.stats,
        },
      };
    })
    .sort((a, b) => b.score - a.score)
    .slice(0, Math.max(1, k));
}

export function formatIndexContext(results: RetrievedIndexBlock[]): string {
  if (results.length === 0) return "";

  const lines: string[] = ["Retrieved workbook style/template matches:"];

  for (const [idx, item] of results.entries()) {
    const cite = `#cite:${item.block.sheetId}!${item.block.range}`;
    lines.push(
      `${idx + 1}. [${item.block.sheetName}!${item.block.range}](${cite}) similarity=${item.score.toFixed(3)}`,
    );
    lines.push(
      `   ${truncateDescriptor(item.block.descriptor, 280).replace(/\n/g, " | ")}`,
    );
  }

  lines.push(
    "Use these patterns as default style/layout guidance. If writing styles into already formatted cells, ask for confirmation before allow_format_overwrite=true.",
  );

  return lines.join("\n");
}

export async function buildIndexPromptContext(
  workbookId: string,
  prompt: string,
  k = DEFAULT_TOP_K,
): Promise<string | null> {
  const startedAt = performance.now();
  const results = await queryIndex(workbookId, prompt, k);
  if (results.length === 0) return null;
  const durationMs = Math.round(performance.now() - startedAt);
  console.log("[Index] Retrieval complete", {
    results: results.length,
    durationMs,
  });
  return formatIndexContext(results);
}

export async function clearWorkbookIndex(workbookId: string): Promise<void> {
  await deleteWorkbookIndex(workbookId);
}
