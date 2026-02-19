import type { AgentMessage } from "@mariozechner/pi-agent-core";
import type {
  AssistantMessage,
  TextContent,
  ToolResultMessage,
  UserMessage,
} from "@mariozechner/pi-ai";

export type ToolCallStatus = "pending" | "running" | "complete" | "error";

export type MessagePart =
  | { type: "text"; text: string }
  | { type: "thinking"; thinking: string }
  | {
      type: "toolCall";
      id: string;
      name: string;
      args: Record<string, unknown>;
      status: ToolCallStatus;
      result?: string;
    };

export interface ChatMessage {
  id: string;
  role: "user" | "assistant";
  parts: MessagePart[];
  timestamp: number;
}

export interface SessionStats {
  inputTokens: number;
  outputTokens: number;
  cacheRead: number;
  cacheWrite: number;
  totalCost: number;
  contextWindow: number;
  lastInputTokens: number;
}

export function stripEnrichment(
  content: string | { type: string; text?: string }[],
): string {
  let text: string;
  if (typeof content === "string") {
    text = content;
  } else {
    text = content
      .filter((c) => c.type === "text")
      .map((c) => c.text ?? "")
      .join("\n");
  }
  text = text.replace(/^<attachments>\n[\s\S]*?\n<\/attachments>\n\n/, "");
  text = text.replace(/^<wb_context>\n[\s\S]*?\n<\/wb_context>\n\n/, "");
  return text;
}

export function generateId(): string {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
}

export function extractPartsFromAssistantMessage(
  message: AgentMessage,
  existingParts: MessagePart[] = [],
): MessagePart[] {
  if (message.role !== "assistant") return existingParts;

  const assistantMsg = message as AssistantMessage;
  const existingToolCalls = new Map<string, MessagePart>();
  for (const part of existingParts) {
    if (part.type === "toolCall") {
      existingToolCalls.set(part.id, part);
    }
  }

  const parts = assistantMsg.content.map((block): MessagePart => {
    if (block.type === "text") {
      return { type: "text", text: block.text };
    }
    if (block.type === "thinking") {
      return { type: "thinking", thinking: block.thinking };
    }
    const existing = existingToolCalls.get(block.id);
    return {
      type: "toolCall",
      id: block.id,
      name: block.name,
      args: block.arguments as Record<string, unknown>,
      status: existing?.type === "toolCall" ? existing.status : "pending",
      result: existing?.type === "toolCall" ? existing.result : undefined,
    };
  });

  const hasRenderableContent = parts.some((part) => {
    if (part.type === "toolCall") return true;
    if (part.type === "text") return part.text.trim().length > 0;
    return part.thinking.trim().length > 0;
  });

  if (
    !hasRenderableContent &&
    (assistantMsg.stopReason === "error" ||
      assistantMsg.stopReason === "aborted")
  ) {
    const errorMessage = assistantMsg.errorMessage || "Request failed";
    return [{ type: "text", text: `Error: ${errorMessage}` }];
  }

  return parts;
}

export function agentMessagesToChatMessages(
  agentMessages: AgentMessage[],
  previousMessages: ChatMessage[] = [],
): ChatMessage[] {
  const reusableIds = new Map<string, string[]>();
  for (const msg of previousMessages) {
    const key = `${msg.role}:${msg.timestamp}`;
    const ids = reusableIds.get(key);
    if (ids) {
      ids.push(msg.id);
    } else {
      reusableIds.set(key, [msg.id]);
    }
  }

  const takeReusableId = (
    role: ChatMessage["role"],
    timestamp: number,
  ): string => {
    const key = `${role}:${timestamp}`;
    const ids = reusableIds.get(key);
    if (ids && ids.length > 0) {
      const reused = ids.shift();
      if (reused) return reused;
    }
    return generateId();
  };

  const result: ChatMessage[] = [];
  for (const msg of agentMessages) {
    if (msg.role === "user") {
      const text = stripEnrichment((msg as UserMessage).content);
      result.push({
        id: takeReusableId("user", msg.timestamp),
        role: "user",
        parts: [{ type: "text", text }],
        timestamp: msg.timestamp,
      });
    } else if (msg.role === "assistant") {
      const parts = extractPartsFromAssistantMessage(msg);
      result.push({
        id: takeReusableId("assistant", msg.timestamp),
        role: "assistant",
        parts,
        timestamp: msg.timestamp,
      });
    } else if (msg.role === "toolResult") {
      const toolResult = msg as ToolResultMessage;
      for (let i = result.length - 1; i >= 0; i--) {
        const chatMsg = result[i];
        if (chatMsg.role !== "assistant") continue;
        const partIdx = chatMsg.parts.findIndex(
          (p) => p.type === "toolCall" && p.id === toolResult.toolCallId,
        );
        if (partIdx !== -1) {
          const part = chatMsg.parts[partIdx];
          if (part.type === "toolCall") {
            const resultText = toolResult.content
              .filter((c): c is TextContent => c.type === "text")
              .map((c) => c.text)
              .join("\n");
            chatMsg.parts[partIdx] = {
              ...part,
              status: toolResult.isError ? "error" : "complete",
              result: resultText,
            };
          }
          break;
        }
      }
    }
  }
  return result;
}

export function deriveStats(
  agentMessages: AgentMessage[],
): Omit<SessionStats, "contextWindow"> {
  let inputTokens = 0;
  let outputTokens = 0;
  let cacheRead = 0;
  let cacheWrite = 0;
  let totalCost = 0;
  let lastInputTokens = 0;
  for (const msg of agentMessages) {
    if (msg.role === "assistant") {
      const u = (msg as AssistantMessage).usage;
      if (u) {
        inputTokens += u.input;
        outputTokens += u.output;
        cacheRead += u.cacheRead;
        cacheWrite += u.cacheWrite;
        totalCost += u.cost.total;
        lastInputTokens = u.input + u.cacheRead + u.cacheWrite;
      }
    }
  }
  return {
    inputTokens,
    outputTokens,
    cacheRead,
    cacheWrite,
    totalCost,
    lastInputTokens,
  };
}
