import { describe, expect, it } from "vitest";
import {
  cosineSimilarity,
  formatIndexContext,
  truncateDescriptor,
} from "../src/lib/indexing/index-store";

describe("indexing retrieval helpers", () => {
  it("computes cosine similarity deterministically", () => {
    const a = new Float32Array([1, 0, 0]);
    const b = new Float32Array([1, 0, 0]);
    const c = new Float32Array([0, 1, 0]);

    expect(cosineSimilarity(a, b)).toBeCloseTo(1, 6);
    expect(cosineSimilarity(a, c)).toBeCloseTo(0, 6);
  });

  it("truncates descriptor by max chars", () => {
    const text = "x".repeat(100);
    expect(truncateDescriptor(text, 10)).toBe("xxxxxxx...");
    expect(truncateDescriptor("short", 10)).toBe("short");
  });

  it("formats retrieved blocks into prompt context", () => {
    const formatted = formatIndexContext([
      {
        score: 0.91,
        block: {
          sheetId: 1,
          sheetName: "Dashboard",
          range: "A1:D20",
          descriptor: "Sheet Dashboard block A1:D20\nStyle profile: bold, fill:#EFEFEF",
          stats: {
            rows: 20,
            cols: 4,
            totalCells: 80,
            nonEmptyCells: 60,
            textCells: 40,
            numberCells: 20,
            booleanCells: 0,
            dateLikeCells: 0,
            formulaCells: 10,
            blankCells: 20,
            styleSignals: 10,
            density: 0.75,
            objectCount: 1,
            freezeProximity: "near",
            topStyles: ["bold"],
            headerTokens: ["Region", "Revenue"],
          },
        },
      },
    ]);

    expect(formatted).toContain("Retrieved workbook style/template matches");
    expect(formatted).toContain("#cite:1!A1:D20");
    expect(formatted).toContain("similarity=0.910");
  });
});
