import "fake-indexeddb/auto";
import { describe, expect, it } from "vitest";
import {
  deleteWorkbookIndex,
  loadWorkbookIndex,
  saveWorkbookIndex,
  type WorkbookIndexRecord,
} from "../src/lib/storage";

describe("db workbook index store", () => {
  it("persists and loads workbook index records", async () => {
    const record: WorkbookIndexRecord = {
      workbookId: "wb-test",
      modelId: "sentence-transformers/all-MiniLM-L6-v2",
      indexVersion: 1,
      createdAt: 1,
      updatedAt: 2,
      blockCount: 1,
      blocks: [
        {
          blockId: "1:A1:B2",
          sheetId: 1,
          sheetName: "Sheet1",
          range: "A1:B2",
          descriptor: "descriptor",
          stats: { density: 0.5 },
          vector: new Float32Array([0.1, 0.2]).buffer,
        },
      ],
    };

    await saveWorkbookIndex(record);
    const loaded = await loadWorkbookIndex(record.workbookId);

    expect(loaded).toBeDefined();
    expect(loaded?.workbookId).toBe(record.workbookId);
    expect(loaded?.blockCount).toBe(1);
    expect(loaded?.blocks[0].range).toBe("A1:B2");

    await deleteWorkbookIndex(record.workbookId);
    const afterDelete = await loadWorkbookIndex(record.workbookId);
    expect(afterDelete).toBeUndefined();
  });
});
