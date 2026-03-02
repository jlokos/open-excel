import { describe, expect, it } from "vitest";
import { hasNonDefaultCellFormatting } from "../src/lib/excel/api";

describe("setCellRange format overwrite guard", () => {
  it("detects non-default formatting", () => {
    expect(
      hasNonDefaultCellFormatting({
        bold: true,
        italic: false,
        underline: "None",
        strikethrough: false,
        fontColor: "#000000",
        fillColor: "#FFFFFF",
        numberFormat: "General",
        borderStyles: ["None", "None", "None", "None"],
      }),
    ).toBe(true);
  });

  it("treats default-like formatting as safe", () => {
    expect(
      hasNonDefaultCellFormatting({
        bold: false,
        italic: false,
        underline: "None",
        strikethrough: false,
        fontColor: "#000000",
        fillColor: "#FFFFFF",
        numberFormat: "General",
        borderStyles: ["None", "None", "None", "None"],
      }),
    ).toBe(false);
  });
});
