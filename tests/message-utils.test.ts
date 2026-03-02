import { describe, expect, it } from "vitest";
import {
  agentMessagesToChatMessages,
  extractPartsFromAssistantMessage,
  stripEnrichment,
  type ChatMessage,
} from "../src/lib/message-utils";

describe("message utils", () => {
  it("reuses ids when rebuilding canonical chat messages", () => {
    const previous: ChatMessage[] = [
      {
        id: "user-1",
        role: "user",
        parts: [{ type: "text", text: "hi" }],
        timestamp: 1000,
      },
      {
        id: "assistant-1",
        role: "assistant",
        parts: [{ type: "text", text: "hello" }],
        timestamp: 2000,
      },
    ];

    const rebuilt = agentMessagesToChatMessages(
      [
        { role: "user", content: "hi", timestamp: 1000 } as any,
        {
          role: "assistant",
          content: [{ type: "text", text: "hello" }],
          stopReason: "stop",
          timestamp: 2000,
        } as any,
      ],
      previous,
    );

    expect(rebuilt).toHaveLength(2);
    expect(rebuilt[0].id).toBe("user-1");
    expect(rebuilt[1].id).toBe("assistant-1");
  });

  it("generates an assistant error part when content is empty", () => {
    const errorAssistant = {
      role: "assistant",
      content: [],
      stopReason: "error",
      errorMessage: "Load failed",
      timestamp: 3000,
    } as any;

    expect(extractPartsFromAssistantMessage(errorAssistant)).toEqual([
      { type: "text", text: "Error: Load failed" },
    ]);

    const rebuilt = agentMessagesToChatMessages(
      [
        { role: "user", content: "hi", timestamp: 1000 } as any,
        errorAssistant,
      ],
      [],
    );

    expect(rebuilt).toHaveLength(2);
    expect(rebuilt[1].role).toBe("assistant");
    expect(rebuilt[1].parts).toEqual([
      { type: "text", text: "Error: Load failed" },
    ]);
  });

  it("generates an assistant error part when content is blank text", () => {
    const errorAssistant = {
      role: "assistant",
      content: [{ type: "text", text: "" }],
      stopReason: "error",
      errorMessage: "Load failed",
      timestamp: 4000,
    } as any;

    expect(extractPartsFromAssistantMessage(errorAssistant)).toEqual([
      { type: "text", text: "Error: Load failed" },
    ]);

    const rebuilt = agentMessagesToChatMessages(
      [
        { role: "user", content: "hi", timestamp: 1000 } as any,
        errorAssistant,
      ],
      [],
    );

    expect(rebuilt).toHaveLength(2);
    expect(rebuilt[1].role).toBe("assistant");
    expect(rebuilt[1].parts).toEqual([
      { type: "text", text: "Error: Load failed" },
    ]);
  });

  it("strips wb_index_context and wb_context enrichments", () => {
    const enriched = `<attachments>\n/home/user/uploads/data.csv\n</attachments>\n\n<wb_index_context>\nretrieved style hints\n</wb_index_context>\n\n<wb_context>\n{\"activeSheetId\":1}\n</wb_context>\n\nSummarize this sheet`;
    expect(stripEnrichment(enriched)).toBe("Summarize this sheet");
  });
});
